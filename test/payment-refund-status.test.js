const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'refund-status-admin';
process.env.ADMIN_PASSWORD = 'refund-status-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;
let providerRefundStatus = 'PENDING';
let providerQueryStatus = 'PENDING';

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-refund-status-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'refund-status-provider',
      channel: 'REFUND_STATUS',
      createIntent: (payment) => ({ providerTradeNo: `RS_${payment.paymentNo}` }),
      confirm: () => ({ status: 'PAID' }),
      refund: (payment) => ({
        status: providerRefundStatus,
        refundNo: `RF_${payment.paymentNo}`,
        providerTradeNo: `RS_${payment.paymentNo}`
      }),
      queryRefund: (payment) => ({
        status: providerQueryStatus,
        refundNo: payment.refund?.refundNo || `RF_${payment.paymentNo}`,
        providerTradeNo: payment.providerTradeNo
      })
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

async function createPaidOrder(code) {
  const session = await login(code);
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const confirmed = await api(`/api/payment-orders/${created.body.paymentOrder.id}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(confirmed.response.status, 200);
  return { session, created: created.body };
}

test('pending provider refund is persisted without reversing payment', async () => {
  providerRefundStatus = 'PENDING';
  const admin = await adminLogin();
  const { created } = await createPaidOrder('pending_refund_user');
  const paymentId = created.paymentOrder.id;

  const refund = await api(`/api/admin/payment-orders/${paymentId}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ note: 'provider is processing' })
  });
  assert.equal(refund.response.status, 202);
  assert.equal(refund.body.data.paymentOrder.status, 'PAID');
  assert.equal(refund.body.data.paymentOrder.refund.status, 'PENDING');
  assert.equal(refund.body.data.paymentOrder.refund.refundNo, `RF_${created.paymentOrder.paymentNo}`);
  assert.equal(refund.body.data.paymentOrder.refund.note, 'provider is processing');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === paymentId);
  const order = data.orders.find((item) => item.id === created.data.id);
  assert.equal(payment.status, 'PAID');
  assert.equal(payment.refund.status, 'PENDING');
  assert.equal(order.status, 'PAID');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `REFUND_${payment.id}`).length, 0);
  assert.equal(data.settlements.filter((item) => item.paymentId === payment.id && item.settlementStatus === 'REFUNDED').length, 0);
});

test('refund query confirmation reverses payment through shared settlement flow', async () => {
  providerRefundStatus = 'PENDING';
  providerQueryStatus = 'REFUNDED';
  const admin = await adminLogin();
  const { created } = await createPaidOrder('confirmed_refund_user');
  const paymentId = created.paymentOrder.id;

  const refund = await api(`/api/admin/payment-orders/${paymentId}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ note: 'provider is processing' })
  });
  assert.equal(refund.response.status, 202);

  const refreshed = await api(`/api/admin/payment-orders/${paymentId}/refund/refresh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({})
  });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.data.paymentOrder.status, 'REFUNDED');
  assert.equal(refreshed.body.data.paymentOrder.refund.status, 'REFUNDED');
  assert.equal(refreshed.body.data.order.status, 'CANCELLED');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === paymentId);
  assert.equal(payment.status, 'REFUNDED');
  assert.equal(payment.refund.status, 'REFUNDED');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `REFUND_${payment.id}`).length, 1);
  assert.ok(data.settlements.some((item) => item.paymentId === payment.id && item.settlementStatus === 'REFUNDED'));
});
