const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'refund-admin';
process.env.ADMIN_PASSWORD = 'refund-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-payment-refund-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'refund-provider',
      channel: 'REFUND',
      createIntent: (payment) => ({ providerTradeNo: `REFUND_${payment.paymentNo}` }),
      confirm: () => ({ status: 'PAID' }),
      refund: () => ({ status: 'PENDING' })
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

test('provider refund result other than REFUNDED does not reverse payment', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'pending_refund_user' })
  });
  const token = login.body.data.token;

  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  const confirmed = await api(`/api/payment-orders/${created.body.paymentOrder.id}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(confirmed.response.status, 200);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const refund = await api(`/api/admin/payment-orders/${created.body.paymentOrder.id}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ note: 'provider is still processing' })
  });
  assert.equal(refund.response.status, 502);
  assert.equal(refund.body.error.code, 'PAYMENT_PROVIDER_FAILED');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
  const order = data.orders.find((item) => item.id === created.body.data.id);
  assert.equal(payment.status, 'PAID');
  assert.equal(order.status, 'PAID');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `REFUND_${payment.id}`).length, 0);
  assert.equal(data.settlements.filter((item) => item.paymentId === payment.id && item.settlementStatus === 'REFUNDED').length, 0);
});
