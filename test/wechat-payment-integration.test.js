const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'wechat-payment-admin';
process.env.ADMIN_PASSWORD = 'wechat-payment-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;
let lastIntentOpenid = '';

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-wechat-integration-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'wechat',
      channel: 'WECHAT',
      createIntent(payment) {
        lastIntentOpenid = payment.openid || '';
        return {
          providerTradeNo: payment.paymentNo,
          payload: { mode: 'wechat-jsapi' }
        };
      },
      confirm: () => ({ status: 'PAID' }),
      refund: () => ({ status: 'REFUNDED' }),
      verifyCallback(request, body) {
        if (request.rawBody !== JSON.stringify(body)) {
          throw new Error('raw callback body was not preserved');
        }
        return {
          providerTradeNo: body.providerTradeNo,
          status: body.status,
          paidAt: body.paidAt
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

test('payment intent receives the logged-in wechat openid', async () => {
  const session = await login('order_user');
  const created = await createOrder(session.token);
  assert.equal(created.response, undefined);
  assert.equal(created.paymentOrder.provider, 'wechat');
  assert.equal(created.paymentOrder.providerPayload.mode, 'wechat-jsapi');
  assert.equal(lastIntentOpenid, 'openid_order_user');
});

test('payment callback preserves the raw body for signature verification', async () => {
  const session = await login('callback_user');
  const created = await createOrder(session.token);
  const callbackBody = {
    providerTradeNo: created.paymentOrder.providerTradeNo,
    status: 'PAID',
    paidAt: '2026-09-09T10:00:00.000Z'
  };
  const callback = await api('/api/payment-callbacks/wechat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(callbackBody)
  });
  assert.equal(callback.response.status, 200);
  assert.equal(callback.body.data.paymentOrder.status, 'PAID');
});

test('user can reload an owned pending payment order with provider parameters', async () => {
  const session = await login('reload_user');
  const created = await createOrder(session.token);
  const paymentId = created.paymentOrder.id;

  const own = await api(`/api/payment-orders/${encodeURIComponent(paymentId)}`, {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(own.response.status, 200);
  assert.equal(own.body.data.id, paymentId);
  assert.equal(own.body.data.providerPayload.mode, 'wechat-jsapi');

  const other = await login('other_reload_user');
  const rejected = await api(`/api/payment-orders/${encodeURIComponent(paymentId)}`, {
    headers: { authorization: `Bearer ${other.token}` }
  });
  assert.equal(rejected.response.status, 404);
  assert.equal(rejected.body.error.code, 'PAYMENT_NOT_FOUND');
});
