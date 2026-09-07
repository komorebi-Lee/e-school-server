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
}

class WeChatPaymentProvider {
  constructor({ appid, mchid, serialNo, privateKeyPath, apiV3Key, transport }) {
    const missingFields = Object.entries({ appid, mchid, serialNo, privateKeyPath, apiV3Key })
      .filter(([, value]) => !value)
      .map(([key]) => key);
    if (missingFields.length) {
      throw new Error(`WECHAT_PAYMENT_CONFIG_MISSING: ${missingFields.join(', ')}`);
    }
    if (!transport) {
      throw new Error('WECHAT_PAYMENT_TRANSPORT_MISSING');
    }

    this.name = 'wechat';
    this.channel = 'WECHAT';
    this.appid = appid;
    this.mchid = mchid;
    this.serialNo = serialNo;
    this.privateKeyPath = privateKeyPath;
    this.apiV3Key = apiV3Key;
    this.transport = transport;
  }

  createIntent(payment) {
    return this.transport.createIntent({
      payment,
      appid: this.appid,
      mchid: this.mchid,
      serialNo: this.serialNo,
      privateKeyPath: this.privateKeyPath,
      apiV3Key: this.apiV3Key
    });
  }

  confirm(payment) {
    return this.transport.confirm({
      payment,
      appid: this.appid,
      mchid: this.mchid,
      serialNo: this.serialNo,
      privateKeyPath: this.privateKeyPath,
      apiV3Key: this.apiV3Key
    });
  }

  refund(payment) {
    return this.transport.refund({
      payment,
      appid: this.appid,
      mchid: this.mchid,
      serialNo: this.serialNo,
      privateKeyPath: this.privateKeyPath,
      apiV3Key: this.apiV3Key
    });
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
      transport: options.transport
    });
  }
  throw new Error(`PAYMENT_PROVIDER_UNSUPPORTED: ${providerName}`);
}

module.exports = { createPaymentProvider, MockPaymentProvider, WeChatPaymentProvider };
