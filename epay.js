/**
 * 易支付 支付接口适配器 / e-pay Interface Adapter
 *
 * 接收 易支付 格式的请求，根据配置路由到 Jeepay 或 Paystack，
 * 然后转换响应为 易支付 格式返回。
 *
 * Receives e-pay formatted requests, routes to Jeepay or Paystack
 * based on config, and converts responses back to e-pay format.
 *
 * 接口标准 / Interface standard: https://pay.myzfw.com/doc_old.html#pay3
 */

const { generateSign, verifySign } = require('./newpay');

class EpayAdapter {
  /**
   * 构造函数 / Constructor
   *
   * @param {Object} config
   * @param {Object}  config.jeepayClient   - Jeepay 客户端实例 / Jeepay client instance
   * @param {string}  config.key            - 商户密钥（MD5 签名）/ MD5 signing key
   * @param {string}  config.serverHost     - 服务器地址（用于生成通知URL）/ Server host
   * @param {string}  [config.pid]          - 商户ID / Merchant ID
   * @param {Object}  [config.paystackClient] - Paystack 客户端实例（可选）/ Paystack client (optional)
   * @param {Object}  [config.paystackConfig] - Paystack 配置（currency, customerEmail…）
   */
  constructor(config) {
    this.jeepay          = config.jeepayClient;
    this.key             = config.key;
    this.serverHost      = config.serverHost;
    this.pid             = config.pid || null;
    this.signType        = 'MD5';

    // Paystack 网关（可选）/ Paystack gateway (optional)
    this.paystack        = config.paystackClient || null;
    this.paystackConfig  = config.paystackConfig || {};
  }

  // ─────────────────────────────────────────────────────────────
  // 网关选择助手 / Gateway selector
  // ─────────────────────────────────────────────────────────────

  /** 判断当前是否使用 Paystack 网关 / Whether Paystack gateway is active */
  _usePaystack() {
    return !!(this.paystack && this.paystackConfig.enabled);
  }

  // ─────────────────────────────────────────────────────────────
  // 公开接口方法 / Public adapter methods
  // ─────────────────────────────────────────────────────────────

  /**
   * 创建支付订单（mapi.php）/ Create payment order
   *
   * e-pay 参数 → Jeepay 或 Paystack
   *
   * @param {Object} epayParams - 易支付 格式请求参数
   * @returns {Promise<Object>} 易支付 格式响应
   */
  async createOrder(epayParams) {
    if (!this._verifyRequestSign(epayParams)) {
      return this._signedError('签名验证失败 / Signature verification failed');
    }

    try {
      if (this._usePaystack()) {
        return await this._createPaystackOrder(epayParams);
      }
      return await this._createJeepayOrder(epayParams);
    } catch (error) {
      console.error('[EpayAdapter] 创建订单失败 / createOrder failed:', error.message);
      return this._signedError(error.message || '创建订单失败 / Order creation failed');
    }
  }

  /**
   * 前台支付提交（submit.php）/ Frontend payment submit
   *
   * @param {Object} epayParams
   * @returns {Promise<Object>} 含 form HTML 或跳转URL
   */
  async submitOrder(epayParams) {
    if (!this._verifyRequestSign(epayParams)) {
      return this._signedError('签名验证失败 / Signature verification failed');
    }

    try {
      if (this._usePaystack()) {
        return await this._submitPaystackOrder(epayParams);
      }

      // ── Jeepay 路径（原逻辑）/ Jeepay path (original logic) ──
      const createResult = await this.createOrder(epayParams);
      if (createResult.code !== 1) return createResult;

      const payUrl = createResult.data.payurl || '';
      if (!payUrl) {
        return this._signedError('获取支付URL失败 / Failed to get payment URL');
      }

      const formHtml = this._generatePayForm(payUrl, epayParams);
      const epayResponse = {
        code: 1,
        msg:  'success',
        data: {
          trade_no:     createResult.data.trade_no,
          out_trade_no: epayParams.out_trade_no,
          payurl:       payUrl,
          qrcode:       createResult.data.qrcode    || '',
          urlscheme:    createResult.data.urlscheme || '',
          form:         formHtml
        }
      };
      const signSrc = {
        code: epayResponse.code, msg: epayResponse.msg,
        trade_no: epayResponse.data.trade_no,
        out_trade_no: epayResponse.data.out_trade_no,
        payurl: epayResponse.data.payurl
      };
      epayResponse.sign      = this._generateResponseSign(signSrc);
      epayResponse.sign_type = this.signType;
      return epayResponse;

    } catch (error) {
      console.error('[EpayAdapter] 提交订单失败 / submitOrder failed:', error.message);
      return this._signedError(error.message || '提交订单失败 / Order submit failed');
    }
  }

  /**
   * 查询单个订单（api.php?act=order）/ Query single order
   *
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async queryOrder(params) {
    if (params.key !== this.key) {
      return { code: -1, msg: '商户密钥验证失败 / Merchant key verification failed', data: null };
    }

    try {
      if (this._usePaystack()) {
        return await this._queryPaystackOrder(params);
      }

      // ── Jeepay 路径（原逻辑）/ Jeepay path ──
      const jeepayResult = await this.jeepay.queryOrder({
        payOrderId: params.trade_no     || '',
        mchOrderNo: params.out_trade_no || ''
      });

      const epayResponse = {
        code: 1,
        msg:  'success',
        data: {
          trade_no:     jeepayResult.payOrderId || '',
          out_trade_no: jeepayResult.mchOrderNo || '',
          money:        (jeepayResult.amount / 100).toFixed(2),
          status:       this._convertStatusToEpay(jeepayResult.state),
          type:         jeepayResult.wayCode   || '',
          endtime:      jeepayResult.successTime || ''
        }
      };
      const signSrc = { code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data };
      epayResponse.sign      = this._generateResponseSign(signSrc);
      epayResponse.sign_type = this.signType;
      return epayResponse;

    } catch (error) {
      console.error('[EpayAdapter] 查询订单失败 / queryOrder failed:', error.message);
      return this._signedError(error.message || '查询订单失败 / Order query failed');
    }
  }

  /**
   * 批量查询订单（api.php?act=orders）/ Batch query orders
   * @param {Object} params
   */
  async queryOrders(params) {
    if (params.key !== this.key) {
      return { code: -1, msg: '商户密钥验证失败 / Merchant key verification failed', data: null };
    }

    try {
      const limit = Math.min(parseInt(params.limit) || 10, 50);
      const page  = parseInt(params.page) || 1;

      const epayResponse = {
        code: 1,
        msg:  'success',
        data: { list: [], total: 0, page, limit }
      };
      epayResponse.sign      = this._generateResponseSign({ code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data });
      epayResponse.sign_type = this.signType;
      return epayResponse;
    } catch (error) {
      console.error('[EpayAdapter] 批量查询失败 / queryOrders failed:', error.message);
      return this._signedError(error.message || '批量查询失败 / Batch query failed');
    }
  }

  /**
   * 退款（api.php?act=refund）/ Refund
   *
   * Paystack 不支持自动退款，需在 Dashboard 手动操作。
   * Paystack does not support programmatic refunds here; use Dashboard.
   *
   * @param {Object} params
   */
  async refundOrder(params) {
    if (params.key !== this.key) {
      return { code: -1, msg: '商户密钥验证失败 / Merchant key verification failed', data: null };
    }

    // Paystack 退款：返回不支持错误 / Paystack refund: return not-supported error
    if (this._usePaystack()) {
      console.warn(
        '[EpayAdapter] Paystack 退款须通过 Dashboard 手动处理 / ' +
        'Paystack refunds must be processed manually via Paystack Dashboard'
      );
      return this._signedError(
        'Paystack 不支持自动退款，请登录 Paystack Dashboard 手动处理退款 / ' +
        'Paystack auto-refund is not supported. Please refund manually via Paystack Dashboard.'
      );
    }

    // ── Jeepay 退款路径（原逻辑）/ Jeepay refund path ──
    try {
      const refundAmount = Math.round(parseFloat(params.money) * 100);

      let extParamObj = {};
      if (params.param) {
        try { extParamObj = JSON.parse(params.param); } catch (e) { extParamObj = { original_param: params.param }; }
      }
      if (params.notify_url) extParamObj.epay_notify_url = params.notify_url;
      const extParam = Object.keys(extParamObj).length > 0 ? JSON.stringify(extParamObj) : '';

      const jeepayResult = await this.jeepay.refundOrder({
        payOrderId:  params.trade_no     || '',
        mchOrderNo:  params.out_trade_no || '',
        mchRefundNo: `REFUND_${params.out_trade_no || params.trade_no}_${Date.now()}`,
        refundAmount,
        refundReason: '用户申请退款 / User refund request',
        notifyUrl:    `${this.serverHost}/api/refund/notify`,
        extParam
      });

      const epayResponse = {
        code: 1,
        msg:  'success',
        data: {
          refund_trade_no: jeepayResult.refundOrderId || '',
          trade_no:        jeepayResult.payOrderId    || '',
          out_trade_no:    params.out_trade_no        || '',
          money:           params.money,
          status:          this._convertRefundStatusToEpay(jeepayResult.state)
        }
      };
      epayResponse.sign      = this._generateResponseSign({ code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data });
      epayResponse.sign_type = this.signType;
      return epayResponse;
    } catch (error) {
      console.error('[EpayAdapter] 退款失败 / refundOrder failed:', error.message);
      return this._signedError(error.message || '退款失败 / Refund failed');
    }
  }

  /**
   * 查询商户信息（api.php?act=query）/ Query merchant info
   * @param {Object} params
   */
  async queryMerchant(params) {
    if (params.key !== this.key) {
      return { code: -1, msg: '商户密钥验证失败 / Merchant key verification failed', data: null };
    }

    try {
      const gateway = this._usePaystack() ? 'paystack' : 'jeepay';
      const epayResponse = {
        code: 1,
        msg:  'success',
        data: {
          pid:     params.pid,
          status:  'normal',
          balance: '0.00',
          gateway  // 额外信息，显示当前网关 / Extra: shows active gateway
        }
      };
      epayResponse.sign      = this._generateResponseSign({ code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data });
      epayResponse.sign_type = this.signType;
      return epayResponse;
    } catch (error) {
      console.error('[EpayAdapter] 查询商户信息失败 / queryMerchant failed:', error.message);
      return this._signedError(error.message || '查询商户信息失败 / Merchant query failed');
    }
  }

  /**
   * 查询结算记录（api.php?act=settle）/ Query settlement records
   * @param {Object} params
   */
  async querySettle(params) {
    if (params.key !== this.key) {
      return { code: -1, msg: '商户密钥验证失败 / Merchant key verification failed', data: null };
    }

    try {
      const epayResponse = {
        code: 1,
        msg:  'success',
        data: { list: [], total: 0 }
      };
      epayResponse.sign      = this._generateResponseSign({ code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data });
      epayResponse.sign_type = this.signType;
      return epayResponse;
    } catch (error) {
      console.error('[EpayAdapter] 查询结算记录失败 / querySettle failed:', error.message);
      return this._signedError(error.message || '查询结算记录失败 / Settle query failed');
    }
  }

  // ─────────────────────────────────────────────────────────────
  // 通知处理 / Notification handlers (Jeepay flow unchanged)
  // ─────────────────────────────────────────────────────────────

  /**
   * 处理 Jeepay 支付通知 / Handle Jeepay payment notification
   * @param {Object} jeepayNotify
   * @returns {Object} 易支付 格式的通知数据
   */
  handleNotify(jeepayNotify) {
    let productName = '';
    if (jeepayNotify.extParam) {
      try {
        const ext = JSON.parse(jeepayNotify.extParam);
        productName = ext.epay_name || ext.name || '';
      } catch (_) {}
    }
    if (!productName) productName = '商品';

    const stateStr = String(jeepayNotify.state);
    let tradeStatus = 'WAIT_BUYER_PAY';
    if (stateStr === '2') tradeStatus = 'TRADE_SUCCESS';
    else if (stateStr === '3' || stateStr === '4' || stateStr === '6') tradeStatus = 'TRADE_CLOSED';

    let param = '';
    if (jeepayNotify.extParam) {
      try {
        const ext = JSON.parse(jeepayNotify.extParam);
        param = ext.original_param || ext.param || '';
      } catch (_) { param = jeepayNotify.extParam; }
    }

    const epayNotify = {
      pid:          this.pid || '',
      trade_no:     jeepayNotify.payOrderId  || '',
      out_trade_no: jeepayNotify.mchOrderNo  || '',
      type:         this._mapWayCodeToEpayType(jeepayNotify.wayCode) || 'alipay',
      name:         productName,
      money:        (jeepayNotify.amount / 100).toFixed(2),
      trade_status: tradeStatus,
      param
    };
    epayNotify.sign      = this._generateResponseSign(epayNotify);
    epayNotify.sign_type = this.signType;
    return epayNotify;
  }

  /**
   * 处理 Jeepay 退款通知 / Handle Jeepay refund notification
   * @param {Object} jeepayRefundNotify
   * @returns {Object}
   */
  handleRefundNotify(jeepayRefundNotify) {
    const epayNotify = {
      refund_trade_no: jeepayRefundNotify.refundOrderId || '',
      trade_no:        jeepayRefundNotify.payOrderId    || '',
      out_trade_no:    jeepayRefundNotify.mchRefundNo   || '',
      money:           (jeepayRefundNotify.refundAmount / 100).toFixed(2),
      status:          this._convertRefundStatusToEpay(jeepayRefundNotify.state),
      endtime:         jeepayRefundNotify.successTime   || '',
      param:           jeepayRefundNotify.extParam       || ''
    };
    epayNotify.sign      = this._generateResponseSign(epayNotify);
    epayNotify.sign_type = this.signType;
    return epayNotify;
  }

  // ─────────────────────────────────────────────────────────────
  // Paystack 私有方法 / Paystack private methods
  // ─────────────────────────────────────────────────────────────

  /**
   * Paystack 创建订单（mapi.php 路径）
   * e-pay params → Paystack initialize → e-pay response (JSON with payurl)
   *
   * 参数映射 / Parameter mapping:
   *   out_trade_no → reference
   *   money        → amount (×100 for subunit)
   *   return_url   → callback_url
   *   notify_url   → metadata.notify_url
   *   pid          → metadata.epay_pid
   *   name         → metadata.custom_fields[0].value
   *
   * @param {Object} epayParams
   */
  async _createPaystackOrder(epayParams) {
    const reference = this._sanitizeReference(epayParams.out_trade_no);
    const amountSubunit = Math.round(parseFloat(epayParams.money) * 100);
    const customerEmail = epayParams.email ||
                          this.paystackConfig.customerEmail ||
                          'customer@kitfoxpay.local';

    // 构建元数据 / Build metadata
    const metadata = {
      custom_fields: [
        {
          display_name:  'Product Name / 商品名称',
          variable_name: 'product_name',
          value:         epayParams.name || 'Payment'
        },
        {
          display_name:  'Order Reference / 订单号',
          variable_name: 'out_trade_no',
          value:         epayParams.out_trade_no || ''
        }
      ],
      epay_pid:       epayParams.pid        || '',
      epay_out_trade_no: epayParams.out_trade_no || '',
      notify_url:     epayParams.notify_url || '',
      cancel_action:  epayParams.return_url || ''
    };

    const initData = await this.paystack.initializeTransaction({
      email:        customerEmail,
      amount:       amountSubunit,
      currency:     this.paystackConfig.currency,
      reference,
      callback_url: epayParams.return_url || undefined,
      metadata
    });

    // authorization_url is the Paystack hosted page
    const payUrl = initData.authorization_url || '';

    const epayResponse = {
      code: 1,
      msg:  'success',
      data: {
        trade_no:     initData.reference  || reference,
        out_trade_no: epayParams.out_trade_no,
        payurl:       payUrl,
        qrcode:       '',
        urlscheme:    '',
        // 额外返回 access_code / Also return access_code
        access_code:  initData.access_code || ''
      }
    };

    const signSrc = {
      code:         epayResponse.code,
      msg:          epayResponse.msg,
      trade_no:     epayResponse.data.trade_no,
      out_trade_no: epayResponse.data.out_trade_no,
      payurl:       epayResponse.data.payurl
    };
    epayResponse.sign      = this._generateResponseSign(signSrc);
    epayResponse.sign_type = this.signType;

    return epayResponse;
  }

  /**
   * Paystack 前台提交（submit.php 路径）
   * 直接重定向到 Paystack 托管支付页面
   *
   * @param {Object} epayParams
   */
  async _submitPaystackOrder(epayParams) {
    const orderResult = await this._createPaystackOrder(epayParams);
    if (orderResult.code !== 1) return orderResult;

    const payUrl = orderResult.data.payurl || '';
    if (!payUrl) {
      return this._signedError('获取 Paystack 支付页面地址失败 / Failed to get Paystack payment URL');
    }

    const formHtml = this._generatePayForm(payUrl, epayParams);

    const epayResponse = {
      code: 1,
      msg:  'success',
      data: {
        trade_no:     orderResult.data.trade_no,
        out_trade_no: epayParams.out_trade_no,
        payurl:       payUrl,
        qrcode:       '',
        urlscheme:    '',
        form:         formHtml
      }
    };

    const signSrc = {
      code:         epayResponse.code,
      msg:          epayResponse.msg,
      trade_no:     epayResponse.data.trade_no,
      out_trade_no: epayResponse.data.out_trade_no,
      payurl:       epayResponse.data.payurl
    };
    epayResponse.sign      = this._generateResponseSign(signSrc);
    epayResponse.sign_type = this.signType;

    return epayResponse;
  }

  /**
   * Paystack 查询订单（api.php?act=order 路径）
   * 使用 GET /transaction/verify/{reference}
   *
   * @param {Object} params
   */
  async _queryPaystackOrder(params) {
    const reference = params.out_trade_no || params.trade_no;
    if (!reference) {
      return this._signedError('缺少订单号 / Missing out_trade_no or trade_no');
    }

    const txData = await this.paystack.verifyTransaction(reference);

    // 转换 Paystack 状态 → 易支付状态 / Map Paystack status → e-pay status
    let epayStatus = '0'; // pending / 待支付
    if (txData.status === 'success')   epayStatus = '1';  // paid / 支付成功
    if (txData.status === 'failed')    epayStatus = '-1'; // failed / 支付失败
    if (txData.status === 'abandoned') epayStatus = '-1'; // abandoned / 已放弃

    const epayResponse = {
      code: 1,
      msg:  'success',
      data: {
        trade_no:     String(txData.id || ''),
        out_trade_no: txData.reference || reference,
        money:        ((txData.amount || 0) / 100).toFixed(2),
        status:       epayStatus,
        type:         'paystack',
        endtime:      txData.paid_at || txData.transaction_date || ''
      }
    };
    epayResponse.sign      = this._generateResponseSign({ code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data });
    epayResponse.sign_type = this.signType;
    return epayResponse;
  }

  // ─────────────────────────────────────────────────────────────
  // Jeepay 私有方法（原逻辑保持不变）/ Jeepay private methods (original logic)
  // ─────────────────────────────────────────────────────────────

  /** Jeepay 创建订单 / Jeepay create order */
  async _createJeepayOrder(epayParams) {
    const wayCode = this._mapPayType(epayParams.type);
    const amount  = Math.round(parseFloat(epayParams.money) * 100);

    let extParamObj = {};
    if (epayParams.param) {
      try { extParamObj = JSON.parse(epayParams.param); } catch (_) { extParamObj = { original_param: epayParams.param }; }
    }
    if (epayParams.notify_url) extParamObj.epay_notify_url = epayParams.notify_url;
    const extParam = Object.keys(extParamObj).length > 0 ? JSON.stringify(extParamObj) : '';

    const jeepayResult = await this.jeepay.unifiedOrder({
      mchOrderNo: epayParams.out_trade_no,
      wayCode,
      amount,
      subject:    epayParams.name,
      body:       epayParams.name,
      notifyUrl:  `${this.serverHost}/api/payment/notify`,
      returnUrl:  epayParams.return_url || '',
      clientIp:   epayParams.clientip  || '',
      extParam
    });

    const payUrl  = jeepayResult.payUrl  || jeepayResult.payData    || '';
    const qrCode  = jeepayResult.qrCode  || jeepayResult.qrCodeUrl  || '';

    const epayResponse = {
      code: 1,
      msg:  'success',
      data: {
        trade_no:     jeepayResult.payOrderId || '',
        out_trade_no: epayParams.out_trade_no,
        payurl:       payUrl,
        qrcode:       qrCode,
        urlscheme:    jeepayResult.urlScheme  || ''
      }
    };

    const signSrc = { code: epayResponse.code, msg: epayResponse.msg, ...epayResponse.data };
    epayResponse.sign      = this._generateResponseSign(signSrc);
    epayResponse.sign_type = this.signType;
    return epayResponse;
  }

  // ─────────────────────────────────────────────────────────────
  // 签名工具 / Signing utilities
  // ─────────────────────────────────────────────────────────────

  _generateResponseSign(params) {
    return generateSign(params, this.key, this.signType);
  }

  _verifyRequestSign(params) {
    if (!this.key) {
      console.warn('[EpayAdapter] 警告：未配置商户密钥，跳过签名验证 / Warning: no key set, skipping sign check');
      return true;
    }
    return verifySign(params, this.key, this.signType);
  }

  /** 统一错误响应（带签名）/ Unified signed error response */
  _signedError(msg) {
    const resp = { code: -1, msg, data: null };
    resp.sign      = this._generateResponseSign({ code: resp.code, msg: resp.msg });
    resp.sign_type = this.signType;
    return resp;
  }

  // ─────────────────────────────────────────────────────────────
  // 状态转换 / Status conversion
  // ─────────────────────────────────────────────────────────────

  _convertStatusToEpay(state) {
    const s = String(state);
    if (s === '2') return '1';
    if (s === '3') return '-1';
    return '0';
  }

  _convertRefundStatusToEpay(state) {
    const s = String(state);
    if (s === '2') return '1';
    if (s === '3') return '-1';
    return '0';
  }

  _mapPayType(epayType)      { return epayType; }
  _mapWayCodeToEpayType(way) { return way || ''; }

  // ─────────────────────────────────────────────────────────────
  // 工具方法 / Utility methods
  // ─────────────────────────────────────────────────────────────

  /**
   * 净化参考号：只保留 Paystack 允许的字符 [-_.= alnum]
   * Sanitize reference: keep only Paystack-allowed chars
   */
  _sanitizeReference(raw) {
    if (!raw) return `kfp_${Date.now()}`;
    // Replace disallowed chars with underscore, then trim to 255 chars
    return String(raw).replace(/[^A-Za-z0-9\-\.=]/g, '_').substring(0, 255);
  }

  /**
   * 生成支付表单HTML / Generate payment form HTML (auto-redirect page)
   * @param {string} payUrl
   * @param {Object} params
   * @returns {string}
   */
  _generatePayForm(payUrl, params) {
    if (!payUrl) return '';

    return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="0;url=${payUrl}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>正在跳转到支付页面... / Redirecting to payment...</title>
  <style>
    body { font-family: Arial, sans-serif; text-align: center; padding: 50px; background: #f5f5f5; }
    .container { background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); max-width: 500px; margin: 0 auto; }
    .loading { font-size: 18px; color: #666; margin: 20px 0; }
    .link { display: inline-block; margin-top: 20px; padding: 10px 20px; background: #2196F3; color: white; text-decoration: none; border-radius: 4px; }
    .link:hover { background: #1976D2; }
  </style>
</head>
<body>
  <div class="container">
    <h2>正在跳转到支付页面... / Redirecting...</h2>
    <div class="loading">⏳ 请稍候 / Please wait</div>
    <p>如果页面没有自动跳转，请<a href="${payUrl}" class="link">点击这里 / Click here</a></p>
  </div>
  <script>window.location.href = ${JSON.stringify(payUrl)};</script>
</body>
</html>`;
  }
}

module.exports = EpayAdapter;
