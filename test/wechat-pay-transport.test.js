const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createPaymentProvider } = require('../src/payment-provider');

const apiV3Key = '0123456789abcdef0123456789abcdef';
const fixedTimeMs = 1760000000000;
let tempDirectory;
let merchantKeys;
let platformKeys;
let privateKeyPath;
let platformPublicKeyPath;

before(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-wechat-pay-'));
  merchantKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  platformKeys = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  privateKeyPath = path.join(tempDirectory, 'merchant-private.pem');
  platformPublicKeyPath = path.join(tempDirectory, 'platform-public.pem');
  fs.writeFileSync(privateKeyPath, merchantKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(platformPublicKeyPath, platformKeys.publicKey.export({ type: 'spki', format: 'pem' }));
});

after(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function createProvider(fetch) {
  return createPaymentProvider({
    provider: 'wechat',
    appid: 'wx-test-appid',
    mchid: '1900000001',
    serialNo: 'MERCHANT-SERIAL',
    privateKeyPath,
    apiV3Key,
    notifyUrl: 'https://example.com/api/payment-callbacks/wechat',
    platformPublicKeyPath,
    platformCertificateSerial: 'PLATFORM-SERIAL',
    httpClient: { fetch },
    now: () => fixedTimeMs,
  });
}

function providerOptions() {
  return {
    appid: 'wx-test-appid',
    mchid: '1900000001',
    serialNo: 'MERCHANT-SERIAL',
    privateKeyPath,
    apiV3Key,
    notifyUrl: 'https://example.com/api/payment-callbacks/wechat',
    platformPublicKeyPath,
    platformCertificateSerial: 'PLATFORM-SERIAL'
  };
}

function payment() {
  return {
    paymentNo: 'PAY1760000000001',
    amountInCents: 129900,
    currency: 'CNY',
    openid: 'openid-for-jsapi',
    description: '狮山智生活订单'
  };
}

function textResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(payload)
  };
}

test('wechat provider creates signed jsapi payment and maps confirmed transaction', async () => {
  const requests = [];
  const provider = createProvider(async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url).endsWith('/v3/pay/transactions/jsapi')) {
      return textResponse({ prepay_id: 'prepay_id_123' });
    }
    if (String(url).includes('/v3/pay/transactions/out-trade-no/PAY1760000000001')) {
      return textResponse({
        out_trade_no: 'PAY1760000000001',
        transaction_id: '4200001234567890',
        trade_state: 'SUCCESS',
        success_time: '2026-09-09T10:00:00.000Z'
      });
    }
    throw new Error(`unexpected request ${url}`);
  });

  const intent = await provider.createIntent(payment());
  assert.equal(intent.providerTradeNo, 'PAY1760000000001');
  assert.equal(intent.payload.package, 'prepay_id=prepay_id_123');
  assert.equal(intent.payload.signType, 'RSA');

  const createRequest = requests[0];
  assert.equal(createRequest.options.method, 'POST');
  assert.deepEqual(JSON.parse(createRequest.options.body), {
    appid: 'wx-test-appid',
    mchid: '1900000001',
    description: '狮山智生活订单',
    out_trade_no: 'PAY1760000000001',
    notify_url: 'https://example.com/api/payment-callbacks/wechat',
    amount: { total: 129900, currency: 'CNY' },
    payer: { openid: 'openid-for-jsapi' }
  });

  const authorization = String(createRequest.options.headers.Authorization);
  assert.match(authorization, /^WECHATPAY2-SHA256-RSA2048 /);
  const authValues = Object.fromEntries(authorization
    .slice('WECHATPAY2-SHA256-RSA2048 '.length)
    .split(',')
    .map((part) => part.split('=', 2).map((value) => value.replace(/"/g, ''))));
  const authMessage = [
    'POST',
    '/v3/pay/transactions/jsapi',
    authValues.timestamp,
    authValues.nonce_str,
    createRequest.options.body,
    ''
  ].join('\n');
  assert.ok(crypto.verify('sha256', Buffer.from(authMessage), merchantKeys.publicKey, Buffer.from(authValues.signature, 'base64')));
  assert.equal(authValues.mchid, '1900000001');
  assert.equal(authValues.serial_no, 'MERCHANT-SERIAL');

  const paySignMessage = [
    'wx-test-appid',
    intent.payload.timeStamp,
    intent.payload.nonceStr,
    intent.payload.package,
    ''
  ].join('\n');
  assert.ok(crypto.verify('sha256', Buffer.from(paySignMessage), merchantKeys.publicKey, Buffer.from(intent.payload.paySign, 'base64')));

  const confirmed = await provider.confirm(payment());
  assert.equal(confirmed.status, 'PAID');
  assert.equal(confirmed.providerTradeNo, '4200001234567890');
  assert.equal(confirmed.paidAt, '2026-09-09T10:00:00.000Z');
  assert.equal(confirmed.payload.transaction_id, '4200001234567890');
});

test('wechat provider maps refund success and pending states', async () => {
  let refundRequest;
  const provider = createProvider(async (url, options) => {
    refundRequest = options;
    return textResponse({
      out_refund_no: 'RF_PAY1760000000001',
      refund_id: '5000001234567890',
      status: 'SUCCESS'
    });
  });
  const refunded = await provider.refund(payment());
  assert.equal(refunded.status, 'REFUNDED');
  assert.equal(refunded.providerTradeNo, 'PAY1760000000001');
  assert.deepEqual(JSON.parse(refundRequest.body), {
    out_trade_no: 'PAY1760000000001',
    out_refund_no: 'RF_PAY1760000000001',
    amount: {
      refund: 129900,
      total: 129900,
      currency: 'CNY'
    }
  });

  const pendingProvider = createProvider(async () => textResponse({
    out_refund_no: 'RF_PAY1760000000001',
    refund_id: '5000001234567890',
    status: 'PROCESSING'
  }));
  const pending = await pendingProvider.refund(payment());
  assert.equal(pending.status, 'PENDING');
});

test('wechat provider queries refund state by out refund no', async () => {
  const requests = [];
  const provider = createProvider(async (url, options) => {
    requests.push({ url: String(url), options });
    return textResponse({
      out_refund_no: 'RF_PAY1760000000001',
      refund_id: '5000001234567890',
      out_trade_no: 'PAY1760000000001',
      status: 'PROCESSING'
    });
  });

  const result = await provider.queryRefund({
    ...payment(),
    refund: { refundNo: 'RF_PAY1760000000001' }
  });
  assert.equal(result.status, 'PENDING');
  assert.equal(result.providerTradeNo, 'PAY1760000000001');
  assert.equal(result.refundNo, 'RF_PAY1760000000001');
  assert.equal(requests[0].options.method, 'GET');
  assert.ok(requests[0].url.includes('/v3/refund/domestic/refunds/RF_PAY1760000000001'));
  assert.ok(requests[0].url.includes('mchid=1900000001'));
});

test('wechat callback verifies platform signature and decrypts payment result', async () => {
  const provider = createProvider(async () => textResponse({}));
  const callbackBody = encryptedCallbackBody({
    out_trade_no: 'PAY1760000000001',
    transaction_id: '4200001234567890',
    trade_state: 'SUCCESS',
    success_time: '2026-09-09T10:00:00.000Z'
  });
  const rawBody = JSON.stringify(callbackBody);
  const timestamp = String(Math.floor(fixedTimeMs / 1000));
  const nonce = 'callback-nonce';
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`),
    platformKeys.privateKey
  ).toString('base64');

  const result = await provider.verifyCallback({
    rawBody,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': 'PLATFORM-SERIAL'
    }
  }, callbackBody);
  assert.equal(result.status, 'PAID');
  assert.equal(result.providerTradeNo, 'PAY1760000000001');
  assert.equal(result.paidAt, '2026-09-09T10:00:00.000Z');
  assert.equal(result.payload.transaction_id, '4200001234567890');
});

test('wechat callback decrypts refund result and maps provider status', async () => {
  const provider = createProvider(async () => textResponse({}));
  const callbackBody = encryptedCallbackBody({
    out_refund_no: 'RF_PAY1760000000001',
    out_trade_no: 'PAY1760000000001',
    refund_id: '5000001234567890',
    refund_status: 'SUCCESS',
    success_time: '2026-09-09T10:10:00.000Z'
  }, 'REFUND.SUCCESS', 'refund');
  const rawBody = JSON.stringify(callbackBody);
  const timestamp = String(Math.floor(fixedTimeMs / 1000));
  const nonce = 'refund-callback-nonce';
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`),
    platformKeys.privateKey
  ).toString('base64');

  const result = await provider.verifyCallback({
    rawBody,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': 'PLATFORM-SERIAL'
    }
  }, callbackBody);
  assert.equal(result.type, 'REFUND');
  assert.equal(result.status, 'REFUNDED');
  assert.equal(result.refundNo, 'RF_PAY1760000000001');
  assert.equal(result.providerTradeNo, 'PAY1760000000001');
  assert.equal(result.payload.refund_id, '5000001234567890');
});

test('wechat callback rejects stale or invalid platform signature', async () => {
  const provider = createProvider(async () => textResponse({}));
  const callbackBody = encryptedCallbackBody({
    out_trade_no: 'PAY1760000000001',
    transaction_id: '4200001234567890',
    trade_state: 'SUCCESS'
  });
  const rawBody = JSON.stringify(callbackBody);
  const timestamp = String(Math.floor(fixedTimeMs / 1000) - 301);
  const nonce = 'callback-nonce';
  const signature = crypto.sign(
    'sha256',
    Buffer.from(`${timestamp}\n${nonce}\n${rawBody}\n`),
    platformKeys.privateKey
  ).toString('base64');

  await assert.rejects(async () => provider.verifyCallback({
    rawBody,
    headers: {
      'wechatpay-timestamp': timestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': signature,
      'wechatpay-serial': 'PLATFORM-SERIAL'
    }
  }, callbackBody), (error) => {
    assert.equal(error.code, 'CALLBACK_TIMESTAMP_EXPIRED');
    return true;
  });

  const validTimestamp = String(Math.floor(fixedTimeMs / 1000));
  await assert.rejects(async () => provider.verifyCallback({
    rawBody,
    headers: {
      'wechatpay-timestamp': validTimestamp,
      'wechatpay-nonce': nonce,
      'wechatpay-signature': Buffer.from('bad-signature').toString('base64'),
      'wechatpay-serial': 'PLATFORM-SERIAL'
    }
  }, callbackBody), (error) => {
    assert.equal(error.code, 'CALLBACK_SIGNATURE_INVALID');
    return true;
  });
});

function encryptedCallbackBody(resource, eventType = 'TRANSACTION.SUCCESS', associatedData = 'transaction') {
  const nonce = crypto.randomBytes(12);
  const callbackAssociatedData = associatedData;
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), nonce);
  cipher.setAAD(Buffer.from(callbackAssociatedData));
  const encrypted = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(resource))),
    cipher.final(),
    cipher.getAuthTag()
  ]);
  return {
    event_type: eventType,
    resource: {
      original_type: 'transaction',
      algorithm: 'AEAD_AES_256_GCM',
      associated_data: callbackAssociatedData,
      nonce: nonce.toString('base64'),
      ciphertext: encrypted.toString('base64')
    }
  };
}

test('wechat provider requires callback and platform verification configuration', () => {
  assert.throws(() => createPaymentProvider({
    provider: 'wechat',
    ...providerOptions(),
    notifyUrl: '',
    platformPublicKeyPath: '',
    platformCertificateSerial: ''
  }), /WECHAT_PAYMENT_CONFIG_MISSING: notifyUrl, platformPublicKeyPath, platformCertificateSerial/);
});
