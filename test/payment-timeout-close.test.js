const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'payment-close-admin';
process.env.ADMIN_PASSWORD = 'payment-close-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;
const closeCalls = [];
let closeError = null;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-payment-close-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'payment-close-provider',
      channel: 'PAYMENT_CLOSE',
      createIntent: (payment) => ({ providerTradeNo: `PC_${payment.paymentNo}` }),
      confirm: () => ({ status: 'PAID' }),
      refund: () => ({ status: 'REFUNDED' }),
      close: async (payment) => {
        closeCalls.push(payment.id);
        if (closeError) throw closeError;
        return { status: 'CLOSED', providerTradeNo: payment.providerTradeNo };
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

async function adminLogin() {
  const result = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      username: process.env.ADMIN_USERNAME,
      password: process.env.ADMIN_PASSWORD
    })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

async function createExpiredOrder(code) {
  const session = await login(code);
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const expiredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  store.update((data) => {
    const order = data.orders.find((item) => item.id === created.body.data.id);
    order.createdAt = expiredAt;
    order.paymentExpiresAt = expiredAt;
    const payment = data.paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
    payment.createdAt = expiredAt;
  });
  return created.body;
}

test('payment timeout patrol closes the provider transaction and records the result', async () => {
  const admin = await adminLogin();
  const created = await createExpiredOrder('payment_close_user');
  const patrol = await api('/api/admin/patrol/run', {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.token}` }
  });
  assert.equal(patrol.response.status, 200);
  assert.equal(patrol.body.data.expiredOrders.length, 1);

  assert.deepEqual(closeCalls, [created.paymentOrder.id]);
  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.paymentOrder.id);
  assert.equal(payment.status, 'CANCELLED');
  assert.equal(payment.providerCloseStatus, 'CLOSED');
  assert.ok(payment.providerCloseRequestedAt);
  assert.ok(payment.providerClosedAt);
  assert.ok(data.auditLogs.some((item) => item.action === '支付渠道订单已关闭' && item.target === payment.paymentNo));
});

test('provider close failure is recorded without blocking local timeout cancellation', async () => {
  closeError = new Error('provider temporarily unavailable');
  const admin = await adminLogin();
  const created = await createExpiredOrder('payment_close_failed_user');
  const patrol = await api('/api/admin/patrol/run', {
    method: 'POST',
    headers: { authorization: `Bearer ${admin.token}` }
  });
  assert.equal(patrol.response.status, 200);
  assert.equal(patrol.body.data.expiredOrders.length, 1);
  closeError = null;

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.paymentOrder.id);
  const order = data.orders.find((item) => item.id === created.data.id);
  assert.equal(payment.status, 'CANCELLED');
  assert.equal(payment.providerCloseStatus, 'FAILED');
  assert.equal(payment.providerCloseError, 'provider temporarily unavailable');
  assert.equal(order.status, 'CANCELLED');
  assert.ok(data.auditLogs.some((item) => item.action === '支付渠道关单失败' && item.target === payment.paymentNo));
});

test('read route timeout sweep closes provider transactions', async () => {
  closeCalls.length = 0;
  const created = await createExpiredOrder('payment_close_sweep_user');
  const products = await api('/api/products');
  assert.equal(products.response.status, 200);

  assert.deepEqual(closeCalls, [created.paymentOrder.id]);
  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.paymentOrder.id);
  assert.equal(payment.providerCloseStatus, 'CLOSED');
});

test('user cancellation closes the provider transaction', async () => {
  closeCalls.length = 0;
  const session = await login('payment_close_cancel_user');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);

  const cancelled = await api(`/api/payment-orders/${created.body.paymentOrder.id}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(cancelled.response.status, 200);
  assert.deepEqual(closeCalls, [created.body.paymentOrder.id]);

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
  assert.equal(payment.status, 'CANCELLED');
  assert.equal(payment.providerCloseStatus, 'CLOSED');
});

test('order cancellation fallback closes the provider transaction', async () => {
  closeCalls.length = 0;
  const session = await login('payment_close_order_cancel_user');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);

  const cancelled = await api(`/api/orders/${created.body.data.id}/cancel`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(cancelled.response.status, 200);
  assert.deepEqual(closeCalls, [created.body.paymentOrder.id]);

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
  assert.equal(payment.status, 'CANCELLED');
  assert.equal(payment.providerCloseStatus, 'CLOSED');
});
