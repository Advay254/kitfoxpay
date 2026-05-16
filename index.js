const express = require('express');
const fs      = require('fs');
const path    = require('path');
const cors    = require('cors');
const axios   = require('axios');
const session    = require('express-session');
// PostgreSQL session store（有 DATABASE_URL 时使用，避免 MemoryStore 内存泄漏）
// PostgreSQL session store (used when DATABASE_URL is set, avoids MemoryStore memory leak)
const PgSession = require('connect-pg-simple')(session);

// 数据库存储单例（必须最先初始化，启动时用于恢复配置）
// DB store singleton (must init first — used to restore config on startup)
const db = require('./db');

const { adminRouter, configRouter } = require('./admin');

// Express 应用（在 main() 之前创建，路由在 main() 内注册）
// Express app (created before main(); routes are registered inside main())
const app = express();

// ─────────────────────────────────────────────────────────────
// 异步启动函数 / Async startup function
//
// 启动顺序 / Startup order:
//   1. 从数据库恢复 config.js（若数据库中有配置）
//      Restore config.js from database (if config exists in DB)
//   2. 若 config.js 不存在（首次部署），从示例文件复制
//      If config.js missing (first deploy), copy from example
//   3. 加载配置，初始化所有客户端和路由
//      Load config, initialize all clients and routes
//   4. 启动 HTTP 服务器
//      Start HTTP server
// ─────────────────────────────────────────────────────────────
async function main() {
  const configPath        = path.join(__dirname, 'config.js');
  const configExamplePath = path.join(__dirname, 'config.example.js');

  // ── 第一步：从数据库恢复配置 / Step 1: Restore config from database ──
  // 等待数据库初始化完成（最多 3 秒）/ Wait for DB init (up to 3s)
  if (db.isConnected !== undefined) {
    // 给异步 _init() 一点时间完成 / Give async _init() a moment to complete
    await new Promise(resolve => setTimeout(resolve, db._pool ? 1500 : 0));
  }

  const dbConfigContent = await db.getConfig();

  if (dbConfigContent) {
    // 数据库中有配置 → 写入文件（覆盖或新建）
    // DB has config → write to file (overwrite or create)
    fs.writeFileSync(configPath, dbConfigContent, 'utf8');
    console.log('[KitfoxPay] ✅ 从数据库恢复配置 / Config restored from database');
  } else if (!fs.existsSync(configPath)) {
    // 首次部署且数据库无配置 → 从示例文件复制
    // First deploy and no DB config → copy from example
    if (fs.existsSync(configExamplePath)) {
      fs.copyFileSync(configExamplePath, configPath);
      console.log('[KitfoxPay] 📝 首次运行，已从示例文件创建配置 / First run: config created from example');
      console.log('[KitfoxPay]    请访问管理界面完成配置后保存，配置将持久化到数据库');
      console.log('[KitfoxPay]    Visit admin UI to complete config and save — it will then persist to DB');
    } else {
      console.error('[KitfoxPay] ❌ config.js 和 config.example.js 均不存在，请手动创建 config.js');
      console.error('[KitfoxPay]    Neither config.js nor config.example.js found. Create config.js manually.');
      process.exit(1);
    }
  } else {
    // config.js 文件已存在（本地开发场景）/ config.js exists (local dev scenario)
    console.log('[KitfoxPay] 📄 使用本地 config.js 文件 / Using local config.js file');
    if (!db.isConnected || !db.isConnected()) {
      console.log('[KitfoxPay]    ⚠ 无数据库连接，此配置重部署后将丢失');
      console.log('[KitfoxPay]       No DB connection — this config will be lost on redeploy');
    }
  }

  // ── 第二步：加载配置 / Step 2: Load config ──
  delete require.cache[require.resolve('./config')];
  const config = require('./config');

  // ── 第三步：初始化中间件 / Step 3: Initialize middleware ──

  // 信任反向代理（nginx 等）/ Trust reverse proxy
  app.set('trust proxy', true);

  app.use(cors({ origin: true, credentials: true }));

  // !! 重要：Paystack Webhook 路由必须在 express.json() 之前注册
  // !! CRITICAL: Paystack webhook route MUST be registered BEFORE express.json()
  //    使用 express.raw() 保留原始 Buffer（用于 HMAC 签名验证）
  //    Uses express.raw() to preserve raw Buffer for HMAC signature verification
  const paystackWebhookPath = config.paystack?.webhookPath || '/webhook/paystack';

  app.use(paystackWebhookPath, express.raw({ type: 'application/json' }));

  // 普通 JSON 和 URL-encoded 解析（排除 Webhook 路由）
  // Normal body parsing (excluding webhook route)
  app.use((req, res, next) => {
    if (req.path === paystackWebhookPath) return next();
    express.json()(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path === paystackWebhookPath) return next();
    express.urlencoded({ extended: true })(req, res, next);
  });

  // Session 配置 / Session config
  // secret 使用稳定值（不用 Date.now()，否则重启后所有 session 失效）
  // Use a stable secret (not Date.now(), which invalidates all sessions on restart)
  const sessionSecret = 'kitfoxpay-' + (config.admin?.password || 'default-secret');

  app.use(session({
    // 有 DATABASE_URL → 用 PostgreSQL 存储 session，重启后管理员登录状态保持
    // DATABASE_URL set → use PostgreSQL session store, admin stays logged in across restarts
    // 无 DATABASE_URL → 用内存存储（会有 MemoryStore 警告，重启后需重新登录）
    // No DATABASE_URL → use memory store (MemoryStore warning expected, login lost on restart)
    store: process.env.DATABASE_URL
      ? new PgSession({
          conString:            process.env.DATABASE_URL,
          createTableIfMissing: true,            // 自动建 session 表 / auto-create session table
          ssl:                  { rejectUnauthorized: false }
        })
      : undefined,  // undefined = express-session 默认 MemoryStore / default MemoryStore
    secret:            sessionSecret,
    resave:            false,
    saveUninitialized: false,
    cookie:            { secure: false, httpOnly: true, maxAge: 24 * 60 * 60 * 1000 }
  }));

  // 静态文件 / Static files
  app.use(express.static(path.join(__dirname, 'public')));

  // ── 第四步：初始化支付客户端 / Step 4: Initialize payment clients ──

  const JeepayClient = require('./jeepay/jeepay');
  const EpayAdapter  = require('./epay');
  const { router: jeepayRouter, initJeepayClient } = require('./jeepay');
  const testRouter = require('./test');

  const jeepay = new JeepayClient({
    baseUrl:    config.jeepay.baseUrl,
    mchNo:      config.jeepay.mchNo,
    appId:      config.jeepay.appId,
    privateKey: config.jeepay.privateKey
  });
  initJeepayClient(jeepay);

  const serverHost = config.server.siteDomain;

  // ── Paystack 客户端（可选）/ Paystack client (optional) ──
  let PaystackClient;
  try {
    PaystackClient = require('./paystack/paystack');
  } catch (_) {
    console.warn('[KitfoxPay] paystack/paystack.js 未找到，Paystack 功能不可用 / Paystack module not found, Paystack disabled');
  }

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
      paystackClient = null;
    }
  } else if (paystackCfg.enabled && !PaystackClient) {
    console.error('[KitfoxPay] ❌ Paystack 已在配置中启用，但 paystack/paystack.js 模块不存在 / Paystack enabled in config but module missing');
  }

  // ── 易支付适配器 / e-pay adapter ──
  const epayAdapter = new EpayAdapter({
    jeepayClient:   jeepay,
    key:            config.epay.key,
    serverHost,
    pid:            config.epay.pid,
    paystackClient,
    paystackConfig: {
      enabled:       paystackCfg.enabled       || false,
      currency:      paystackCfg.currency      || 'NGN',
      customerEmail: paystackCfg.customerEmail || 'customer@kitfoxpay.local',
      channels:      paystackCfg.channels      || ['card', 'bank', 'ussd', 'mobile_money', 'bank_transfer']
    }
  });

  // ── 第五步：注册路由 / Step 5: Register routes ──

  // 基础路由 / Base routes
  app.get('/', (req, res) => {
    if (req.headers.accept && req.headers.accept.includes('application/json')) {
      res.json({
        message:   'Jeepay 支付平台 API 服务运行中',
        status:    'success',
        version:   '1.0.0',
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
      db:        db.isConnected() ? 'connected' : 'memory-mode',
      config: {
        baseUrl:  config.jeepay.baseUrl,
        mchNo:    config.jeepay.mchNo,
        appId:    config.jeepay.appId,
        paystack: {
          enabled:  paystackCfg.enabled || false,
          currency: paystackCfg.currency || 'NGN'
        }
      }
    });
  });

  // 管理和测试路由 / Admin and test routes
  app.use('/api/admin',  adminRouter);
  app.use('/api/config', configRouter);
  app.use('/api/test',   testRouter);
  app.use('/api/jeepay', jeepayRouter);

  // ─────────────────────────────────────────────────────────────
  // 请求参数工具 / Request param utilities
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
  // 易支付适配接口 / e-pay Interface endpoints
  // 接口标准：https://pay.myzfw.com/doc_old.html#pay3
  // ─────────────────────────────────────────────────────────────

  // 后端API支付接口（mapi.php）/ Backend payment API
  app.all('/mapi.php', async (req, res) => {
    try {
      const params = getRequestParams(req);
      const result = await epayAdapter.createOrder(params);
      res.json(result);
    } catch (error) {
      handleErrorResponse(error, epayAdapter, res);
    }
  });

  // 前台支付提交（submit.php）/ Frontend payment submit
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

  // 统一API接口（api.php）/ Unified API
  app.all('/api.php', async (req, res) => {
    try {
      const params = getRequestParams(req);
      const act    = params.act;
      if (!act) {
        return res.json({ code: -1, msg: '缺少参数: act / Missing param: act', data: null });
      }
      switch (act) {
        case 'order':  return res.json(await epayAdapter.queryOrder(params));
        case 'orders': return res.json(await epayAdapter.queryOrders(params));
        case 'refund': return res.json(await epayAdapter.refundOrder(params));
        case 'query':  return res.json(await epayAdapter.queryMerchant(params));
        case 'settle': return res.json(await epayAdapter.querySettle(params));
        default:
          return res.json({ code: -1, msg: `不支持的 act 参数 / Unsupported act: ${act}`, data: null });
      }
    } catch (error) {
      handleErrorResponse(error, epayAdapter, res);
    }
  });

  // ─────────────────────────────────────────────────────────────
  // Paystack Webhook 接收接口 / Paystack Webhook endpoint
  //
  // 安全措施 / Security:
  //   1. express.raw() 保留原始 Buffer / Preserves raw Buffer for HMAC
  //   2. HMAC-SHA512 签名验证 / HMAC-SHA512 signature verification
  //   3. IP 白名单（纵深防御）/ IP whitelist (defense in depth)
  //   4. 幂等性去重（数据库持久化）/ Idempotency (DB-persisted)
  //   5. 始终返回 200 防止 Paystack 重试 / Always return 200 to prevent retries
  // ─────────────────────────────────────────────────────────────

  app.post(paystackWebhookPath, async (req, res) => {
    // 立即返回 200（防止 Paystack 重试超时）/ Return 200 immediately (prevent timeout)
    res.sendStatus(200);

    if (!paystackClient) {
      console.warn('[Paystack Webhook] 收到 Webhook 但 Paystack 客户端未初始化 / Client not initialized');
      return;
    }

    try {
      const rawPayload = req.body;
      const signature  = req.headers['x-paystack-signature'];
      const clientIp   = req.ip || req.connection.remoteAddress || '';

      // ── 1. 签名验证 / Signature verification ──
      let event;
      try {
        event = paystackClient.handleWebhook(rawPayload, signature, clientIp);
      } catch (sigError) {
        console.error('[Paystack Webhook] ❌ 签名验证失败 / Signature failed:', sigError.message, { clientIp });
        return;
      }

      const eventType = event.event || '';
      const data      = event.data  || {};

      console.log('[Paystack Webhook] 收到事件 / Event received:', {
        event: eventType, reference: data.reference, id: data.id, amount: data.amount, status: data.status
      });

      // ── 2. 幂等性检查 / Idempotency check ──
      const idempotencyKey = `${data.id || ''}_${data.reference || ''}`;
      if (await db.has(idempotencyKey)) {
        console.warn('[Paystack Webhook] ⚠ 重复事件，跳过处理 / Duplicate event, skipping:', idempotencyKey);
        return;
      }

      // ── 3. 事件路由 / Event routing ──
      if (eventType === 'charge.success') {
        await _handleChargeSuccess(data, paystackClient, epayAdapter);
      } else if (eventType === 'charge.failed') {
        await _handleChargeFailed(data, epayAdapter);
      } else {
        console.log(`[Paystack Webhook] 未处理的事件类型 / Unhandled event type: ${eventType}`);
      }

      // ── 4. 标记已处理 / Mark as processed ──
      await db.mark(idempotencyKey);

    } catch (error) {
      console.error('[Paystack Webhook] 处理失败 / Processing error:', error.message);
    }
  });

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
        payOrderId: jeepayNotify.payOrderId, mchOrderNo: jeepayNotify.mchOrderNo,
        amount: jeepayNotify.amount, state: jeepayNotify.state
      });
      const epayNotify = epayAdapter.handleNotify(jeepayNotify);
      let notifyUrl = null;
      if (jeepayNotify.extParam) {
        try { notifyUrl = JSON.parse(jeepayNotify.extParam).epay_notify_url || null; } catch (_) {}
      }
      if (notifyUrl) {
        try {
          const r = await axios.get(notifyUrl, { params: epayNotify, timeout: 10000 });
          console.log('[KitfoxPay] 支付通知转发成功 / Notify forwarded:', { notifyUrl, status: r.status });
        } catch (e) {
          console.error('[KitfoxPay] 支付通知转发失败 / Notify forward failed:', { notifyUrl, error: e.message });
        }
      } else {
        console.log('[KitfoxPay] 未找到商户 notify_url / No merchant notify_url found');
      }
      res.send('success');
    } catch (error) {
      console.error('[KitfoxPay] 处理支付通知失败 / Payment notify failed:', error);
      res.send('fail');
    }
  });

  app.post('/api/refund/notify', async (req, res) => {
    try {
      const n = req.body;
      if (!jeepay.verifyNotify(n)) {
        console.error('[KitfoxPay] Jeepay 退款通知签名验证失败 / Jeepay refund notify signature failed:', n);
        return res.send('fail');
      }
      console.log('[KitfoxPay] 收到 Jeepay 退款通知 / Jeepay refund notify:', {
        refundOrderId: n.refundOrderId, payOrderId: n.payOrderId, refundAmount: n.refundAmount, state: n.state
      });
      const epayNotify = epayAdapter.handleRefundNotify(n);
      let notifyUrl = null;
      if (n.extParam) {
        try { notifyUrl = JSON.parse(n.extParam).epay_notify_url || null; } catch (_) {}
      }
      if (notifyUrl) {
        try {
          const r = await axios.get(notifyUrl, { params: epayNotify, timeout: 10000 });
          console.log('[KitfoxPay] 退款通知转发成功 / Refund notify forwarded:', { notifyUrl, status: r.status });
        } catch (e) {
          console.error('[KitfoxPay] 退款通知转发失败 / Refund notify forward failed:', { notifyUrl, error: e.message });
        }
      }
      res.send('success');
    } catch (error) {
      console.error('[KitfoxPay] 处理退款通知失败 / Refund notify failed:', error);
      res.send('fail');
    }
  });

  // ── 第六步：启动服务器 / Step 6: Start server ──
  const PORT = parseInt(process.env.SERVER_PORT || config.server.port || '9219', 10);

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
    console.log('  数据库 / Database:');
    console.log(`    ${db.isConnected() ? '✅ PostgreSQL（配置和幂等性已持久化 / config + idempotency persisted）' : '⚠ 内存模式（设置 DATABASE_URL 启用持久化 / set DATABASE_URL to persist）'}`);
    console.log('=================================');
  });
}

// ─────────────────────────────────────────────────────────────
// Paystack 事件处理函数 / Paystack event handlers
// ─────────────────────────────────────────────────────────────

/**
 * 处理 charge.success 事件 / Handle charge.success event
 * 安全要点：必须二次验证金额，防止参数篡改
 * Security: MUST re-verify amount to prevent tampering
 */
async function _handleChargeSuccess(webhookData, paystackClient, epayAdapter) {
  const reference = webhookData.reference;
  if (!reference) {
    console.error('[Paystack Webhook] charge.success 缺少 reference / Missing reference');
    return;
  }
  try {
    // 二次验证：通过 API 确认交易状态和金额 / Double-verify via API
    const txData = await paystackClient.verifyTransaction(reference);

    if (txData.status !== 'success') {
      console.warn(`[Paystack Webhook] 二次验证失败：状态不是 success / Verify status mismatch: ${txData.status}`);
      return;
    }
    if (webhookData.amount && txData.amount !== webhookData.amount) {
      console.error('[Paystack Webhook] ❌ 金额不匹配！可能存在篡改 / Amount mismatch! Possible tampering.',
        { webhook: webhookData.amount, api: txData.amount });
      return;
    }

    console.log('[Paystack Webhook] ✅ 交易验证成功 / Transaction verified:',
      { reference, amount: txData.amount, currency: txData.currency, id: txData.id });

    const metadata       = txData.metadata      || {};
    const notifyUrl      = metadata.notify_url   || '';
    const epayOutTradeNo = metadata.epay_out_trade_no || txData.reference || reference;
    const epayPid        = metadata.epay_pid     || '';

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
      epayNotify.sign      = epayAdapter._generateResponseSign(epayNotify);
      epayNotify.sign_type = 'MD5';
      try {
        const r = await require('axios').get(notifyUrl, { params: epayNotify, timeout: 10000 });
        console.log('[Paystack Webhook] 通知转发成功 / Notify forwarded:',
          { notifyUrl, status: r.status, response: String(r.data).substring(0, 200) });
      } catch (e) {
        console.error('[Paystack Webhook] 通知转发失败 / Notify forward failed:', { notifyUrl, error: e.message });
      }
    } else {
      console.log('[Paystack Webhook] 未找到 notify_url，跳过转发 / No notify_url in metadata');
    }
  } catch (err) {
    console.error('[Paystack Webhook] 二次验证 API 调用失败 / Verify API failed:', err.message);
  }
}

/**
 * 处理 charge.failed 事件 / Handle charge.failed event
 */
async function _handleChargeFailed(webhookData, epayAdapter) {
  console.warn('[Paystack Webhook] ⚠ 支付失败 / Payment failed:',
    { reference: webhookData.reference, amount: webhookData.amount, gateway_response: webhookData.gateway_response });

  const metadata       = webhookData.metadata || {};
  const notifyUrl      = metadata.notify_url  || '';
  const epayOutTradeNo = metadata.epay_out_trade_no || webhookData.reference || '';
  const epayPid        = metadata.epay_pid    || '';

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
      await require('axios').get(notifyUrl, { params: epayNotify, timeout: 10000 });
    } catch (e) {
      console.error('[Paystack Webhook] charge.failed 通知转发失败 / Failed notify forward:', e.message);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 启动 / Launch
// ─────────────────────────────────────────────────────────────
main().catch(err => {
  console.error('[KitfoxPay] ❌ 启动失败 / Startup failed:', err.message);
  process.exit(1);
});
