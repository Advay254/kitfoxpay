/**
 * 配置示例模板 / Configuration example template
 *
 * 复制本文件为 config.js 并通过管理界面填入真实配置。
 * Copy this file to config.js, then fill in real values via the admin UI.
 *
 * 首次部署时会自动从本文件创建 config.js。
 * On first deploy, config.js is created automatically from this file.
 */

module.exports = {
  // ========== Jeepay 支付平台配置 / Jeepay Payment Platform Config ==========
  jeepay: {
    baseUrl:    'https://pay.jeepay.vip', // Jeepay API 基础地址 / API base URL
    mchNo:      '',                        // 商户号 / Merchant number
    appId:      '',                        // 应用ID / App ID
    privateKey: ''                         // 商户私钥（用于签名/验签）/ Merchant private key
  },

  // ========== Paystack 支付平台配置 / Paystack Payment Platform Config ==========
  // 当 enabled=true 时，支付请求将通过 Paystack 处理而非 Jeepay
  // When enabled=true, payment requests are routed through Paystack instead of Jeepay
  paystack: {
    enabled:       false,                       // 是否启用 Paystack / Enable Paystack gateway
    secretKey:     '',                          // Paystack 密钥 / Secret key (sk_test_... or sk_live_...)
    baseUrl:       'https://api.paystack.co',   // API 基础地址（通常无需修改）/ API base URL
    currency:      'NGN',                       // 货币代码 / Currency code (NGN, GHS, ZAR, KES…)
    channels:      ['card', 'bank', 'ussd', 'mobile_money', 'bank_transfer'], // 支持渠道 / Payment channels
    webhookPath:   '/webhook/paystack',         // Webhook 接收路径 / Webhook endpoint path
    customerEmail: ''                           // 默认客户邮箱（当请求未提供时）/ Default customer email
  },

  // ========== 易支付接口配置（适配器）/ e-pay Interface Config (adapter) ==========
  epay: {
    pid: '', // 商户ID / Merchant ID
    key: ''  // MD5 签名密钥 / MD5 signing key
  },

  // ========== 服务器配置 / Server Config ==========
  server: {
    host:       '0.0.0.0',         // 绑定 IP / Bind IP (0.0.0.0 = all interfaces)
    port:       9219,               // 监听端口 / Listen port
    siteDomain: 'http://localhost:9219' // 对外访问域名（用于回调/跳转）/ Public domain for callbacks
  },

  // ========== 管理后台配置 / Admin Panel Config ==========
  admin: {
    // 初始密码为 admin，首次登录后请立即修改
    // Initial password is "admin" — change it immediately after first login
    password: 'admin'
  }
};
