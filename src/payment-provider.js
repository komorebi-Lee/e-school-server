const { WeChatPayTransport } = require('./wechat-pay-transport');

class MockPaymentProvider {
  constructor() {
    this.name = 'mock';
    this.channel = 'MOCK';
  }

  createIntent(payment) {
    return {
      providerTradeNo: `MOCK_${payment.paymentNo}`,
      payload: { mode: 'mock' }
    };
  }

  confirm(payment) {
    return {
      status: 'PAID',
      providerTradeNo: payment.providerTradeNo || `MOCK_${payment.paymentNo}`
    };
  }

  refund(payment) {
    return {
      status: 'REFUNDED',
      providerTradeNo: payment.providerTradeNo || `MOCK_${payment.paymentNo}`
    };
  }

  verifyCallback(request, body) {
    return {
      providerTradeNo: body.providerTradeNo,
      status: body.status,
      paidAt: body.paidAt,
      payload: body.payload || null
    };
  }
}

class WeChatPaymentProvider {
  constructor({ appid, mchid, serialNo, privateKeyPath, apiV3Key, notifyUrl, platformPublicKeyPath, platformCertificateSerial, transport, httpClient, now }) {
    const missingFields = Object.entries({
      appid,
      mchid,
      serialNo,
      privateKeyPath,
      apiV3Key,
      notifyUrl,
      platformPublicKeyPath,
      platformCertificateSerial
    })
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missingFields.length) {
      throw new Error(`WECHAT_PAYMENT_CONFIG_MISSING: ${missingFields.join(', ')}`);
    }
    this.name = 'wechat';
    this.channel = 'WECHAT';
    this.appid = appid;
    this.mchid = mchid;
    this.serialNo = serialNo;
    this.privateKeyPath = privateKeyPath;
    this.apiV3Key = apiV3Key;
    this.transport = transport || new WeChatPayTransport({
      appid,
      mchid,
      serialNo,
      privateKeyPath,
      apiV3Key,
      notifyUrl,
      platformPublicKeyPath,
      platformCertificateSerial,
      httpClient,
      now
    });
  }

  createIntent(payment) {
    return this.transport.createIntent(payment);
  }

  confirm(payment) {
    return this.transport.confirm(payment);
  }

  refund(payment) {
    return this.transport.refund(payment);
  }

  verifyCallback(request, body) {
    return this.transport.verifyCallback(request, body);
  }
}

function createPaymentProvider(options = {}) {
  const providerName = String(options.provider || process.env.PAYMENT_PROVIDER || 'mock').toLowerCase();
  if (providerName === 'mock') return new MockPaymentProvider();
  if (providerName === 'wechat') {
    return new WeChatPaymentProvider({
      appid: options.appid || process.env.WECHAT_APPID,
      mchid: options.mchid || process.env.WECHAT_PAY_MCHID,
      serialNo: options.serialNo || process.env.WECHAT_PAY_SERIAL_NO,
      privateKeyPath: options.privateKeyPath || process.env.WECHAT_PAY_PRIVATE_KEY_PATH,
      apiV3Key: options.apiV3Key || process.env.WECHAT_PAY_APIV3_KEY,
      notifyUrl: options.notifyUrl || process.env.WECHAT_PAY_NOTIFY_URL,
      platformPublicKeyPath: options.platformPublicKeyPath || process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_PATH,
      platformCertificateSerial: options.platformCertificateSerial || process.env.WECHAT_PAY_PLATFORM_CERT_SERIAL,
      transport: options.transport,
      httpClient: options.httpClient,
      now: options.now
    });
  }
  throw new Error(`PAYMENT_PROVIDER_UNSUPPORTED: ${providerName}`);
}

module.exports = { createPaymentProvider, MockPaymentProvider, WeChatPaymentProvider };
