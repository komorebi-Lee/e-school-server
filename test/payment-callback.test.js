const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'callback-admin';
process.env.ADMIN_PASSWORD = 'callback-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-callback-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'callback-provider',
      channel: 'CALLBACK',
      createIntent: (payment) => ({ providerTradeNo: `CB_${payment.paymentNo}` }),
      confirm: () => {
        throw new Error('callback provider should not use direct confirm');
      },
      refund: () => {
        throw new Error('callback provider should not use direct refund');
      },
      verifyCallback: (request, body) => {
        if (request.headers['x-signature'] !== 'valid') {
          throw new Error('invalid callback signature');
        }
        return {
          providerTradeNo: body.providerTradeNo,
          status: body.status,
          paidAt: body.paidAt,
          payload: body.payload || null
        };
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

async function login(code) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

async function createOrder(token) {
  const result = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(result.response.status, 201);
  return result.body;
}

test('payment callback settles order once and ignores duplicate callbacks', async () => {
  const session = await login('callback_user');
  const created = await createOrder(session.token);
  const paymentOrder = created.paymentOrder;

  const callback = await api('/api/payment-callbacks/callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
    body: JSON.stringify({
      providerTradeNo: paymentOrder.providerTradeNo,
      status: 'PAID',
      paidAt: '2026-09-07T10:00:00.000Z'
    })
  });
  assert.equal(callback.response.status, 200);
  assert.equal(callback.body.data.paymentOrder.status, 'PAID');
  assert.equal(callback.body.data.order.status, 'PAID');

  const duplicate = await api('/api/payment-callbacks/callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
    body: JSON.stringify({
      providerTradeNo: paymentOrder.providerTradeNo,
      status: 'PAID',
      paidAt: '2026-09-07T10:00:00.000Z'
    })
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.data.paymentOrder.status, 'PAID');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === paymentOrder.id);
  assert.equal(payment.status, 'PAID');
  assert.equal(payment.providerTradeNo, paymentOrder.providerTradeNo);
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `PAYMENT_${payment.id}`).length, 1);
  assert.equal(data.settlements.filter((item) => item.paymentId === payment.id).length, 1);
});

test('invalid payment callback signature is rejected without changing order', async () => {
  const session = await login('invalid_callback_user');
  const created = await createOrder(session.token);
  const paymentOrder = created.paymentOrder;

  const rejected = await api('/api/payment-callbacks/callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'bad' },
    body: JSON.stringify({
      providerTradeNo: paymentOrder.providerTradeNo,
      status: 'PAID'
    })
  });
  assert.equal(rejected.response.status, 401);
  assert.equal(rejected.body.error.code, 'PAYMENT_CALLBACK_INVALID');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === paymentOrder.id);
  const order = data.orders.find((item) => item.id === created.data.id);
  assert.equal(payment.status, 'PENDING');
  assert.equal(order.status, 'PENDING_PAYMENT');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `PAYMENT_${payment.id}`).length, 0);
});
