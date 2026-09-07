const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');
const { createPaymentProvider } = require('../src/payment-provider');

process.env.ADMIN_USERNAME = 'payment-admin';
process.env.ADMIN_PASSWORD = 'payment-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-payment-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'rejecting-provider',
      channel: 'TEST',
      createIntent: (payment) => ({ providerTradeNo: `TEST_${payment.paymentNo}` }),
      confirm: () => {
        throw new Error('provider rejected payment');
      },
      refund: () => {
        throw new Error('provider rejected refund');
      }
    }
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

async function api(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

test('wechat payment provider requires complete merchant configuration', () => {
  assert.throws(
    () => createPaymentProvider({ provider: 'wechat' }),
    /WECHAT_PAYMENT_CONFIG_MISSING/
  );
});

test('payment confirmation failure leaves order unpaid and unsettled', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'provider_failure_user' })
  });
  const token = login.body.data.token;

  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.paymentOrder.provider, 'rejecting-provider');
  assert.equal(created.body.paymentOrder.providerTradeNo, `TEST_${created.body.paymentOrder.paymentNo}`);

  const confirmed = await api(`/api/payment-orders/${created.body.paymentOrder.id}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(confirmed.response.status, 502);
  assert.equal(confirmed.body.error.code, 'PAYMENT_PROVIDER_FAILED');

  const order = await api(`/api/orders/${created.body.data.id}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(order.body.data.status, 'PENDING_PAYMENT');
  assert.equal(order.body.data.paymentStatus, 'UNPAID');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
  assert.equal(payment.status, 'PENDING');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `PAYMENT_${payment.id}`).length, 0);
  assert.equal(data.settlements.filter((item) => item.paymentId === payment.id).length, 0);
});
