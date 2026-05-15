const express      = require('express');
const cors         = require('cors');
const axios        = require('axios');
const querystring  = require('querystring');
const path         = require('path');
const session      = require('express-session');
const JeepayClient = require('./jeepay/jeepay');
const EpayAdapter  = require('./epay');
const config       = require('./config');
const { router: jeepayRouter, initJeepayClient } = require('./jeepay');
const { adminRouter, configRouter } = require('./admin');
const testRouter   = require('./test');

// ── 可选：Paystack 客户端 / Optional: Paystack client ──
let PaystackClient;
try {
  PaystackClient = require('./paystack/paystack');
} catch (_) {
  console.warn('[KitfoxPay] paystack/paystack.js 未找到，Paystack 功能不可用 / Paystack module not found, Paystack disabled');
}

// ─────────────────────────────────────────────────────────────
// 幂等性去重集合（防止重复处理 Webhook）/ Idempotency set (prevent duplicate webhook processing)
// 生产环境建议替换为 Redis 或数据库 / Replace with Redis/DB in production for persistence across restarts
// ─────────────────────────────────────────────────────────────
const processedWebhookIds = new Set();
const MAX_IDEMPOTENCY_CACHE = 10000; // 防止内存无限增长 / Prevent unbounded memory growth

function markWebhookProcessed(id) {
  if (processedWebhookIds.size >= MAX_IDEMPOTENCY_CACHE) {
    // 清除最旧的条目（Set 保持插入顺序）/ Clear oldest entries
    const firstKey = processedWebhookIds.values().next().value;
    processedWebhookIds.delete(firstKey);
  }
  processedWebhookIds.add(String(id));
}

function isWebhookAlreadyProcessed(id) {
  return processedWebhookIds.has(String(id));
}

// ─────────────────────────────────────────────────────────────
// Express 应用初始化 / Express app initialization
// ─────────────────────────────────────────────────────────────
const app  = express();
const PORT = config.server.port;

// 信任反向代理（nginx等）/ Trust reverse proxy
app.set('trust proxy', true);

app.use(cors({ origin: true, credentials: true }));

// !! 重要：Paystack Webhook 路由必须在 express.json() 之前注册，
//    并使用 express.raw() 保留原始 Buffer（用于 HMAC 签名验证）
// !! CRITICAL: Paystack webhook route MUST be registered BEFORE express.json()
//    and MUST use express.raw() to preserve raw Buffer for HMAC verification
const paystackWebhookPath = config.paystack?.webhookPath || '/webhook/paystack';

app.use(
  paystackWebhookPath,
  express.raw({ type: 'application/json' })
);

// 普通 JSON 和 URL-encoded 解析（排除 Webhook 路由）/ Normal body parsing
app.use((req, res, next) => {
  if (req.path === paystackWebhookPath) return next(); // already parsed as raw
  express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === paystackWebhookPath) return next();
  express.urlencoded({ extended: true })(req, res, next);
});

// Session 配置 / Session config
app.use(session({
  secret:            'kitfoxpay-admin-secret-key-' + Date.now(),
  resave:            false,
  saveUninitialized: false,
  cookie:            { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
}));

// 静态文件 / Static files
app.use(express.static(path.join(__dirname, 'public')));

// ─────────────────────────────────────────────────────────────
// 初始化 Jeepay 客户端 / Initialize Jeepay client
// ─────────────────────────────────────────────────────────────
const jeepay = new JeepayClient({
  baseUrl:    config.jeepay.baseUrl,
  mchNo:      config.jeepay.mchNo,
  appId:      config.jeepay.appId,
  privateKey: config.jeepay.privateKey
});
initJeepayClient(jeepay);

const serverHost = config.server.siteDomain;

// ─────────────────────────────────────────────────────────────
// 初始化 Paystack 客户端（如果启用）/ Initialize Paystack client (if enabled)
// ─────────────────────────────────────────────────────────────
let paystackClient = null;
const paystackCfg  = config.paystack || {};

if (paystackCfg.enabled && PaystackClient) {
  try {
    paystackClient = new PaystackClient({
      secretKey: paystackCfg.secretKey,
      baseUrl:   paystackCfg.baseUrl,
      currency:  paystackCfg.currency,
      channels:  paystackCfg.channels
    });
    console.log('[KitfoxPay] ✅ Paystack 网关已启用 / Paystack gateway enabled');
    console.log(`[KitfoxPay]    货币 / Currency: ${paystackCfg.currency || 'NGN'}`);
    console.log(`[KitfoxPay]    Webhook 路径 / Webhook path: ${paystackWebhookPath}`);
  } catch (err) {
    console.error('[KitfoxPay] ❌ Paystack 初始化失败 / Paystack init failed:', err.message);
    console.error('[KitfoxPay]    请检查 config.js 中的 paystack.secretKey 配置 / Check paystack.secretKey in config.js');
    paystackClient = null;
  }
} else if (paystackCfg.enabled && !PaystackClient) {
  console.error('[KitfoxPay] ❌ Paystack 已在配置中启用，但 paystack/paystack.js 模块不存在 / Paystack enabled in config but module missing');
}

// ─────────────────────────────────────────────────────────────
// 初始化 易支付 适配器 / Initialize e-pay adapter
// ─────────────────────────────────────────────────────────────
const epayAdapter = new EpayAdapter({
  jeepayClient:   jeepay,
  key:            config.epay.key,
  serverHost,
  pid:            config.epay.pid,
  // Paystack 注入 / Paystack injection
  paystackClient,
  paystackConfig: {
    enabled:       paystackCfg.enabled       || false,
    currency:      paystackCfg.currency      || 'NGN',
    customerEmail: paystackCfg.customerEmail || 'customer@kitfoxpay.local',
    channels:      paystackCfg.channels      || ['card', 'bank', 'ussd', 'mobile_money', 'bank_transfer']
  }
});

// ─────────────────────────────────────────────────────────────
// 基础路由 / Base routes
// ─────────────────────────────────────────────────────────────

app.get('/', (req, res) => {
  if (req.headers.accept && req.headers.accept.includes('application/json')) {
    res.json({
      message: 'Jeepay 支付平台 API 服务运行中',
      status:  'success',
      version: '1.0.0',
      configUrl: '/index.html'
    });
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

app.get('/api/health', (req, res) => {
  res.json({
    status:    'healthy',
    timestamp: new Date().toISOString(),
    gateway:   paystackClient ? 'paystack' : 'jeepay',
    config: {
      baseUrl: config.jeepay.baseUrl,
      mchNo:   config.jeepay.mchNo,
      appId:   config.jeepay.appId,
      paystack: {
        enabled:  paystackCfg.enabled || false,
        currency: paystackCfg.currency || 'NGN'
      }
    }
  });
});

// ─────────────────────────────────────────────────────────────
// 管理和测试路由 / Admin and test routes
// ─────────────────────────────────────────────────────────────
app.use('/api/admin',   adminRouter);
app.use('/api/config',  configRouter);
app.use('/api/test',    testRouter);
app.use('/api/jeepay',  jeepayRouter);

// ─────────────────────────────────────────────────────────────
// 请求参数工具 / Request param utility
// ─────────────────────────────────────────────────────────────
function getRequestParams(req) {
  return { ...req.query, ...req.body };
}

function handleErrorResponse(error, adapter, res) {
  console.error('[KitfoxPay] 易支付接口处理失败 / e-pay interface error:', error);
  const errorResponse = {
    code: -1,
    msg:  error.message || '接口处理失败 / Interface failed',
    data: null
  };
  if (adapter && adapter._generateResponseSign) {
    errorResponse.sign      = adapter._generateResponseSign({ code: errorResponse.code, msg: errorResponse.msg });
    errorResponse.sign_type = 'MD5';
  }
  res.json(errorResponse);
}

// ─────────────────────────────────────────────────────────────
// 易支付 适配接口 / e-pay Interface endpoints
// ─────────────────────────────────────────────────────────────

/**
 * 后端API支付接口（mapi.php）
 * 接口标准：https://pay.myzfw.com/doc_old.html#pay3
 */
app.all('/mapi.php', async (req, res) => {
  try {
    const params = getRequestParams(req);
    const result = await epayAdapter.createOrder(params);
    res.json(result);
  } catch (error) {
    handleErrorResponse(error, epayAdapter, res);
  }
});

/**
 * 前台支付提交（submit.php）
 * 接口标准：https://pay.myzfw.com/doc_old.html#pay3
 */
app.all('/submit.php', async (req, res) => {
  try {
    const params = getRequestParams(req);
    const result = await epayAdapter.submitOrder(params);

    if (result.code === 1 && result.data && result.data.form) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(result.data.form);
    } else {
      res.json(result);
    }
  } catch (error) {
    handleErrorResponse(error, epayAdapter, res);
  }
});

/**
 * 统一API接口（api.php）
 * 接口标准：https://pay.myzfw.com/doc_old.html#pay3
 */
app.all('/api.php', async (req, res) => {
  try {
    const params = getRequestParams(req);
    const act    = params.act;

    if (!act) {
      return res.json({ code: -1, msg: '缺少参数: act / Missing param: act', data: null });
    }

    switch (act) {
      case 'order':   return res.json(await epayAdapter.queryOrder(params));
      case 'orders':  return res.json(await epayAdapter.queryOrders(params));
      case 'refund':  return res.json(await epayAdapter.refundOrder(params));
      case 'query':   return res.json(await epayAdapter.queryMerchant(params));
      case 'settle':  return res.json(await epayAdapter.querySettle(params));
      default:
        return res.json({ code: -1, msg: `不支持的 act 参数 / Unsupported act: ${act}`, data: null });
    }
  } catch (error) {
    handleErrorResponse(error, epayAdapter, res);
  }
});

// ─────────────────────────────────────────────────────────────
// Paystack Webhook 接收接口 / Paystack Webhook endpoint
// ─────────────────────────────────────────────────────────────

/**
 * POST /webhook/paystack（路径可在 config 中自定义）
 *
 * 安全措施 / Security:
 * 1. express.raw() 保留原始 Buffer / Preserves raw Buffer for HMAC
 * 2. HMAC-SHA512 签名验证（使用 secretKey）/ HMAC-SHA512 signature verification
 * 3. IP 白名单（纵深防御）/ IP whitelist (defense in depth)
 * 4. 幂等性去重（基于 data.id + reference）/ Idempotency (data.id + reference)
 * 5. 始终返回 200 防止 Paystack 重试 / Always return 200 to prevent Paystack retries
 */
app.post(paystackWebhookPath, async (req, res) => {
  // 立即返回 200（防止 Paystack 重试超时）/ Return 200 immediately (prevent Paystack retry timeout)
  res.sendStatus(200);

  // ── 安全检查仅在 Paystack 启用时执行 / Security checks only when Paystack is enabled ──
  if (!paystackClient) {
    console.warn('[Paystack Webhook] 收到 Webhook 但 Paystack 客户端未初始化 / Received webhook but Paystack client not initialized');
    return;
  }

  try {
    const rawPayload = req.body; // Buffer（由 express.raw() 保留）/ Buffer from express.raw()
    const signature  = req.headers['x-paystack-signature'];
    const clientIp   = req.ip || req.connection.remoteAddress || '';

    // ── 1. 签名验证 / Signature verification ──
    let event;
    try {
      event = paystackClient.handleWebhook(rawPayload, signature, clientIp);
    } catch (sigError) {
      console.error('[Paystack Webhook] ❌ 签名验证失败 / Signature failed:', sigError.message, { clientIp });
      return; // 已发送 200，静默丢弃 / Already sent 200, silently discard
    }

    const eventType = event.event || '';
    const data      = event.data  || {};

    console.log('[Paystack Webhook] 收到事件 / Event received:', {
      event:     eventType,
      reference: data.reference,
      id:        data.id,
      amount:    data.amount,
      status:    data.status
    });

    // ── 2. 幂等性检查 / Idempotency check ──
    const idempotencyKey = `${data.id || ''}_${data.reference || ''}`;
    if (isWebhookAlreadyProcessed(idempotencyKey)) {
      console.warn('[Paystack Webhook] ⚠ 重复事件，跳过处理 / Duplicate event, skipping:', idempotencyKey);
      return;
    }

    // ── 3. 事件路由 / Event routing ──
    if (eventType === 'charge.success') {
      await _handlePaystackChargeSuccess(data);
    } else if (eventType === 'charge.failed') {
      await _handlePaystackChargeFailed(data);
    } else {
      console.log(`[Paystack Webhook] 未处理的事件类型 / Unhandled event type: ${eventType}`);
    }

    // ── 4. 标记已处理 / Mark as processed ──
    markWebhookProcessed(idempotencyKey);

  } catch (error) {
    console.error('[Paystack Webhook] 处理失败 / Processing error:', error.message);
    // 不重新抛出，200 已发出 / Don't rethrow, 200 already sent
  }
});

/**
 * 处理 Paystack charge.success 事件 / Handle Paystack charge.success event
 *
 * 安全要点：必须二次验证金额，防止参数篡改
 * Security: MUST re-verify amount to prevent tampering
 *
 * @param {Object} webhookData - Webhook data.data object
 */
async function _handlePaystackChargeSuccess(webhookData) {
  const reference = webhookData.reference;
  if (!reference) {
    console.error('[Paystack Webhook] charge.success 缺少 reference / Missing reference');
    return;
  }

  try {
    // ── 二次验证：通过 API 确认交易状态和金额 / Double-verify via API ──
    const txData = await paystackClient.verifyTransaction(reference);

    // 验证状态 / Verify status
    if (txData.status !== 'success') {
      console.warn(`[Paystack Webhook] 二次验证失败：状态不是 success / Verify status mismatch: ${txData.status}`);
      return;
    }

    // 验证金额一致 / Verify amount matches
    if (webhookData.amount && txData.amount !== webhookData.amount) {
      console.error(
        '[Paystack Webhook] ❌ 金额不匹配！可能存在篡改 / Amount mismatch! Possible tampering.',
        { webhook: webhookData.amount, api: txData.amount }
      );
      return;
    }

    console.log('[Paystack Webhook] ✅ 交易验证成功 / Transaction verified:', {
      reference,
      amount:   txData.amount,
      currency: txData.currency,
      id:       txData.id
    });

    // ── 从 metadata 中提取 notify_url / Extract notify_url from metadata ──
    const metadata  = txData.metadata      || {};
    const notifyUrl = metadata.notify_url  || '';
    const epayOutTradeNo = metadata.epay_out_trade_no || txData.reference || reference;
    const epayPid        = metadata.epay_pid || '';

    // ── 转换为 易支付 通知格式并转发给商户 / Convert to e-pay notify format and forward ──
    if (notifyUrl) {
      const epayNotify = {
        pid:          epayPid,
        trade_no:     String(txData.id || ''),
        out_trade_no: epayOutTradeNo,
        type:         'paystack',
        name:         (metadata.custom_fields || []).find(f => f.variable_name === 'product_name')?.value || 'Payment',
        money:        (txData.amount / 100).toFixed(2),
        trade_status: 'TRADE_SUCCESS',
        param:        ''
      };
      // 生成签名 / Generate signature
      epayNotify.sign      = epayAdapter._generateResponseSign(epayNotify);
      epayNotify.sign_type = 'MD5';

      try {
        const fwdResp = await axios.get(notifyUrl, { params: epayNotify, timeout: 10000 });
        console.log('[Paystack Webhook] 通知转发成功 / Notify forwarded:', {
          notifyUrl,
          status:   fwdResp.status,
          response: String(fwdResp.data).substring(0, 200)
        });
      } catch (fwdErr) {
        console.error('[Paystack Webhook] 通知转发失败 / Notify forward failed:', {
          notifyUrl,
          error: fwdErr.message
        });
        // 转发失败不阻止幂等标记 / Forward failure doesn't block idempotency marking
      }
    } else {
      console.log('[Paystack Webhook] 未找到 notify_url，跳过转发 / No notify_url found in metadata, skipping forward');
    }

  } catch (verifyError) {
    console.error('[Paystack Webhook] 二次验证 API 调用失败 / Verify API call failed:', verifyError.message);
  }
}

/**
 * 处理 Paystack charge.failed 事件 / Handle Paystack charge.failed event
 * @param {Object} webhookData
 */
async function _handlePaystackChargeFailed(webhookData) {
  console.warn('[Paystack Webhook] ⚠ 支付失败 / Payment failed:', {
    reference: webhookData.reference,
    amount:    webhookData.amount,
    gateway_response: webhookData.gateway_response
  });

  const metadata  = webhookData.metadata || {};
  const notifyUrl = metadata.notify_url  || '';
  const epayOutTradeNo = metadata.epay_out_trade_no || webhookData.reference || '';
  const epayPid        = metadata.epay_pid || '';

  if (notifyUrl) {
    const epayNotify = {
      pid:          epayPid,
      trade_no:     String(webhookData.id || ''),
      out_trade_no: epayOutTradeNo,
      type:         'paystack',
      name:         (metadata.custom_fields || []).find(f => f.variable_name === 'product_name')?.value || 'Payment',
      money:        (webhookData.amount / 100).toFixed(2),
      trade_status: 'TRADE_CLOSED',
      param:        ''
    };
    epayNotify.sign      = epayAdapter._generateResponseSign(epayNotify);
    epayNotify.sign_type = 'MD5';

    try {
      await axios.get(notifyUrl, { params: epayNotify, timeout: 10000 });
    } catch (e) {
      console.error('[Paystack Webhook] charge.failed 通知转发失败 / Failed notify forward:', e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// Jeepay 通知接口（原逻辑不变）/ Jeepay notify endpoints (unchanged)
// ─────────────────────────────────────────────────────────────

app.post('/api/payment/notify', async (req, res) => {
  try {
    const jeepayNotify = req.body;

    if (!jeepay.verifyNotify(jeepayNotify)) {
      console.error('[KitfoxPay] Jeepay 支付通知签名验证失败 / Jeepay notify signature failed:', jeepayNotify);
      return res.send('fail');
    }

    console.log('[KitfoxPay] 收到 Jeepay 支付通知 / Jeepay payment notify:', {
      payOrderId: jeepayNotify.payOrderId,
      mchOrderNo: jeepayNotify.mchOrderNo,
      amount:     jeepayNotify.amount,
      state:      jeepayNotify.state
    });

    const epayNotify = epayAdapter.handleNotify(jeepayNotify);

    let notifyUrl = null;
    if (jeepayNotify.extParam) {
      try {
        const ext = JSON.parse(jeepayNotify.extParam);
        notifyUrl = ext.epay_notify_url || null;
      } catch (e) {
        console.warn('[KitfoxPay] extParam 解析失败 / extParam parse failed:', e.message);
      }
    }

    if (notifyUrl) {
      try {
        const fwdResp = await axios.get(notifyUrl, { params: epayNotify, timeout: 10000 });
        console.log('[KitfoxPay] 支付通知转发成功 / Notify forwarded:', { notifyUrl, status: fwdResp.status });
      } catch (fwdErr) {
        console.error('[KitfoxPay] 支付通知转发失败 / Notify forward failed:', { notifyUrl, error: fwdErr.message });
      }
    } else {
      console.log('[KitfoxPay] 未找到商户 notify_url，跳过通知转发 / No merchant notify_url found');
    }

    res.send('success');
  } catch (error) {
    console.error('[KitfoxPay] 处理支付通知失败 / Payment notify failed:', error);
    res.send('fail');
  }
});

app.post('/api/refund/notify', async (req, res) => {
  try {
    const jeepayRefundNotify = req.body;

    if (!jeepay.verifyNotify(jeepayRefundNotify)) {
      console.error('[KitfoxPay] Jeepay 退款通知签名验证失败 / Jeepay refund notify signature failed:', jeepayRefundNotify);
      return res.send('fail');
    }

    console.log('[KitfoxPay] 收到 Jeepay 退款通知 / Jeepay refund notify:', {
      refundOrderId: jeepayRefundNotify.refundOrderId,
      payOrderId:    jeepayRefundNotify.payOrderId,
      refundAmount:  jeepayRefundNotify.refundAmount,
      state:         jeepayRefundNotify.state
    });

    const epayNotify = epayAdapter.handleRefundNotify(jeepayRefundNotify);

    let notifyUrl = null;
    if (jeepayRefundNotify.extParam) {
      try {
        const ext = JSON.parse(jeepayRefundNotify.extParam);
        notifyUrl = ext.epay_notify_url || null;
      } catch (e) {
        console.warn('[KitfoxPay] extParam 解析失败 / extParam parse failed:', e.message);
      }
    }

    if (notifyUrl) {
      try {
        const fwdResp = await axios.get(notifyUrl, { params: epayNotify, timeout: 10000 });
        console.log('[KitfoxPay] 退款通知转发成功 / Refund notify forwarded:', { notifyUrl, status: fwdResp.status });
      } catch (fwdErr) {
        console.error('[KitfoxPay] 退款通知转发失败 / Refund notify forward failed:', { notifyUrl, error: fwdErr.message });
      }
    }

    res.send('success');
  } catch (error) {
    console.error('[KitfoxPay] 处理退款通知失败 / Refund notify failed:', error);
    res.send('fail');
  }
});

// ─────────────────────────────────────────────────────────────
// 启动服务器 / Start server
// ─────────────────────────────────────────────────────────────
app.listen(PORT, config.server.host, () => {
  console.log('=================================');
  console.log('支付平台 API 服务已启动 / Payment Platform API Service Started');
  console.log(`绑定地址 / Bind: ${config.server.host}:${PORT}`);
  console.log(`服务地址 / Service: ${serverHost}`);
  console.log('配置信息 / Config:');
  console.log('  Jeepay:');
  console.log(`    Base URL: ${config.jeepay.baseUrl}`);
  console.log(`    商户号 / Merchant: ${config.jeepay.mchNo}`);
  console.log(`    应用ID / AppID: ${config.jeepay.appId}`);
  console.log('  Paystack:');
  console.log(`    启用 / Enabled: ${!!(paystackCfg.enabled && paystackClient)}`);
  if (paystackCfg.enabled && paystackClient) {
    console.log(`    货币 / Currency: ${paystackCfg.currency || 'NGN'}`);
    console.log(`    Webhook: ${serverHost}${paystackWebhookPath}`);
  }
  console.log('  易支付 / e-pay:');
  console.log(`    商户ID / PID: ${config.epay.pid}`);
  console.log(`    网站域名 / Domain: ${serverHost}`);
  console.log('=================================');
});
