/**
 * Paystack 支付客户端 / Paystack Payment Client
 *
 * 实现 Paystack API 的核心支付功能，包括：
 * - 初始化交易 / Initialize transaction
 * - 验证交易 / Verify transaction
 * - Webhook 签名验证 + IP 白名单 / Webhook signature verification + IP whitelist
 *
 * Paystack API 文档 / Paystack API docs: https://paystack.com/docs/api/
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// Paystack 已知 IP 白名单 / Known Paystack IP whitelist
const PAYSTACK_IPS = ['52.31.139.75', '52.49.173.169', '52.214.14.220'];

class PaystackClient {
  /**
   * 构造函数 / Constructor
   * @param {Object} config - 配置对象 / Config object
   * @param {string} config.secretKey - Paystack 密钥，格式 sk_test_... 或 sk_live_... / Secret key
   * @param {string} [config.baseUrl] - API 基础地址 / API base URL (default: https://api.paystack.co)
   * @param {string} [config.currency] - 默认货币代码 / Default currency code (default: NGN)
   * @param {string[]} [config.channels] - 支持的支付渠道 / Supported payment channels
   */
  constructor(config) {
    if (!config || !config.secretKey) {
      throw new Error(
        '[Paystack] 缺少 secretKey 配置 / Missing secretKey config'
      );
    }

    // 验证密钥格式 / Validate key format
    if (!/^sk_(test|live)_[A-Za-z0-9]+$/.test(config.secretKey)) {
      throw new Error(
        '[Paystack] secretKey 格式无效 / Invalid secretKey format. ' +
        'Expected: sk_test_... or sk_live_...'
      );
    }

    this.secretKey = config.secretKey;
    this.baseUrl   = (config.baseUrl || 'https://api.paystack.co').replace(/\/$/, '');
    this.currency  = config.currency || 'NGN';
    this.channels  = config.channels || ['card', 'bank', 'ussd', 'mobile_money', 'bank_transfer'];

    // 解析 baseUrl 主机名和端口 / Parse baseUrl host and port
    const parsed = new URL(this.baseUrl);
    this._host     = parsed.hostname;
    this._port     = parseInt(parsed.port, 10) || (parsed.protocol === 'https:' ? 443 : 80);
    this._useHttps = parsed.protocol === 'https:';
  }

  // ─────────────────────────────────────────────
  // 公开方法 / Public methods
  // ─────────────────────────────────────────────

  /**
   * 初始化交易 / Initialize a transaction
   * POST /transaction/initialize
   *
   * @param {Object} params - 交易参数 / Transaction parameters
   * @param {string} params.email        - 客户邮箱（必填）/ Customer email (required)
   * @param {number} params.amount       - 金额（已换算为最小货币单位，如 kobo）/ Amount in subunit (kobo, pesewas…)
   * @param {string} [params.reference]  - 唯一参考号 / Unique reference (mapped from e-pay out_trade_no)
   * @param {string} [params.callback_url] - 支付后回调地址 / Redirect URL after payment (return_url)
   * @param {Object} [params.metadata]   - 自定义元数据 / Custom metadata (store epay fields here)
   * @param {string} [params.currency]   - 货币代码 / Currency code override
   * @param {string[]} [params.channels] - 支付渠道 / Payment channels override
   * @returns {Promise<{authorization_url: string, access_code: string, reference: string}>}
   */
  async initializeTransaction(params) {
    // ── 输入验证 / Input validation ──
    if (!params.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(params.email)) {
      throw new Error('[Paystack] 无效的电子邮件地址 / Invalid email address');
    }

    const amount = Number(params.amount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error('[Paystack] 金额必须是正整数（最小货币单位）/ Amount must be a positive integer in subunit');
    }

    if (params.reference && !/^[A-Za-z0-9\-\.=]{1,255}$/.test(params.reference)) {
      throw new Error(
        '[Paystack] 参考号格式无效 / Invalid reference format. ' +
        'Only alphanumeric, -, ., = up to 255 chars allowed'
      );
    }

    const body = {
      email:    params.email,
      amount:   Math.round(amount),
      currency: params.currency || this.currency,
      channels: params.channels || this.channels
    };

    if (params.reference)    body.reference    = params.reference;
    if (params.callback_url) body.callback_url = params.callback_url;
    if (params.metadata)     body.metadata     = params.metadata;

    const data = await this._requestWithRetry('POST', '/transaction/initialize', body);

    if (!data.status) {
      throw new Error(`[Paystack] 初始化失败 / Initialize failed: ${data.message}`);
    }

    return data.data; // { authorization_url, access_code, reference }
  }

  /**
   * 验证交易 / Verify a transaction
   * GET /transaction/verify/{reference}
   *
   * @param {string} reference - 交易参考号 / Transaction reference
   * @returns {Promise<Object>} Paystack transaction data object
   */
  async verifyTransaction(reference) {
    if (!reference || typeof reference !== 'string') {
      throw new Error('[Paystack] 参考号是必需的 / Reference is required');
    }

    const data = await this._requestWithRetry(
      'GET',
      `/transaction/verify/${encodeURIComponent(reference)}`
    );

    if (!data.status) {
      throw new Error(`[Paystack] 验证失败 / Verify failed: ${data.message}`);
    }

    return data.data;
  }

  /**
   * 验证 Webhook 签名并解析事件 / Verify webhook signature and parse event
   *
   * 安全机制 / Security:
   * 1. HMAC-SHA512 签名验证（使用 secretKey）/ HMAC-SHA512 signature (using secretKey)
   * 2. IP 白名单（防深度伪造）/ IP whitelist (defense in depth)
   *
   * @param {Buffer} rawPayload  - 原始请求体 Buffer / Raw request body buffer
   * @param {string} signature   - x-paystack-signature header 值 / header value
   * @param {string} [clientIp]  - 请求方 IP / Requester IP (for whitelist check)
   * @returns {Object} 解析后的事件对象 / Parsed webhook event object
   * @throws {Error} 签名验证失败 / If signature is invalid
   */
  handleWebhook(rawPayload, signature, clientIp) {
    // ── 1. IP 白名单检查（纵深防御）/ IP whitelist check (defense in depth) ──
    if (clientIp && !PAYSTACK_IPS.includes(clientIp)) {
      console.warn(
        `[Paystack Webhook] ⚠ IP 不在白名单中 / IP not in whitelist: ${clientIp}. ` +
        '继续签名验证 / Continuing with signature check.'
      );
      // 注意：不硬拒绝，以防 Paystack 更换 IP，主要验证机制为签名
      // Note: Not hard-rejecting in case Paystack rotates IPs; signature is primary
    }

    // ── 2. HMAC-SHA512 签名验证 / HMAC-SHA512 signature verification ──
    if (!signature || typeof signature !== 'string') {
      throw new Error('[Paystack Webhook] 缺少签名头 / Missing x-paystack-signature header');
    }

    const expectedHash = crypto
      .createHmac('sha512', this.secretKey)
      .update(rawPayload)
      .digest('hex');

    // 恒定时间比较防时序攻击 / Constant-time comparison to prevent timing attacks
    let signatureValid = false;
    try {
      signatureValid = crypto.timingSafeEqual(
        Buffer.from(expectedHash, 'hex'),
        Buffer.from(signature.toLowerCase(), 'hex')
      );
    } catch (_) {
      signatureValid = false;
    }

    if (!signatureValid) {
      throw new Error('[Paystack Webhook] 签名验证失败 / Webhook signature verification failed');
    }

    // ── 3. 解析事件 / Parse event ──
    let event;
    try {
      event = JSON.parse(rawPayload.toString('utf8'));
    } catch (e) {
      throw new Error('[Paystack Webhook] 无效的 JSON 载荷 / Invalid JSON payload');
    }

    return event;
  }

  // ─────────────────────────────────────────────
  // 内部方法 / Internal methods
  // ─────────────────────────────────────────────

  /**
   * 发送 HTTP 请求（带指数退避重试）/ Send HTTP request with exponential backoff retry
   * 使用 Node.js 内置 https/http 模块，无需额外依赖 / Uses built-in https/http, no extra deps
   *
   * @param {string} method   - HTTP 方法 / HTTP method (GET | POST)
   * @param {string} path     - API 路径 / API path
   * @param {Object} [body]   - 请求体 / Request body (for POST)
   * @param {number} [retry]  - 当前重试次数 / Current retry count
   * @returns {Promise<Object>} 解析后的 JSON 响应 / Parsed JSON response
   */
  async _requestWithRetry(method, path, body = null, retry = 0) {
    const MAX_RETRIES = 3;

    try {
      return await this._request(method, path, body);
    } catch (error) {
      // 仅对 5xx 服务端错误重试 / Only retry on 5xx server errors
      const isServerError = error.statusCode && error.statusCode >= 500;
      const isNetworkError = !error.statusCode; // 网络超时等

      if ((isServerError || isNetworkError) && retry < MAX_RETRIES - 1) {
        const delay = Math.pow(2, retry + 1) * 500; // 1000ms, 2000ms, 4000ms
        console.warn(
          `[Paystack] 请求失败，${delay}ms 后重试 (${retry + 1}/${MAX_RETRIES - 1}) / ` +
          `Request failed, retrying in ${delay}ms: ${error.message}`
        );
        await new Promise(r => setTimeout(r, delay));
        return this._requestWithRetry(method, path, body, retry + 1);
      }

      throw error;
    }
  }

  /**
   * 执行单次 HTTP 请求 / Execute a single HTTP request
   *
   * @param {string} method  - HTTP 方法 / method
   * @param {string} apiPath - API 路径 / path
   * @param {Object} body    - 请求体 / body
   * @returns {Promise<Object>}
   */
  _request(method, apiPath, body) {
    return new Promise((resolve, reject) => {
      const postData = body ? JSON.stringify(body) : null;

      const options = {
        hostname: this._host,
        port:     this._port,
        path:     apiPath,
        method:   method,
        headers: {
          'Authorization':  `Bearer ${this.secretKey}`,
          'Content-Type':   'application/json',
          'Accept':         'application/json',
          'User-Agent':     'KitfoxPay/1.0 Paystack-Adapter'
        }
      };

      if (postData) {
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }

      const transport = this._useHttps ? https : http;
      const req = transport.request(options, (res) => {
        let rawData = '';
        res.setEncoding('utf8');

        res.on('data', chunk => { rawData += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(rawData);
            if (res.statusCode >= 400) {
              const err = new Error(parsed.message || `HTTP ${res.statusCode}`);
              err.statusCode = res.statusCode;
              err.response   = parsed;
              return reject(err);
            }
            resolve(parsed);
          } catch (e) {
            const err = new Error(`JSON 解析失败 / JSON parse error: ${rawData.substring(0, 200)}`);
            err.statusCode = res.statusCode;
            reject(err);
          }
        });
      });

      req.setTimeout(30000, () => {
        req.destroy();
        const err = new Error('[Paystack] 请求超时 / Request timed out after 30s');
        err.statusCode = null;
        reject(err);
      });

      req.on('error', (e) => {
        const err = new Error(`[Paystack] 网络错误 / Network error: ${e.message}`);
        err.statusCode = null;
        reject(err);
      });

      if (postData) req.write(postData);
      req.end();
    });
  }
}

module.exports = PaystackClient;
