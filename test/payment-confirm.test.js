const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'payment-confirm-admin';
process.env.ADMIN_PASSWORD = 'payment-confirm-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-payment-confirm-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` })
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

test('order confirmation route settles payment through the shared business flow', async () => {
  const login = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'order_confirm_user' })
  });
  const token = login.body.data.token;

  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);

  const confirmed = await api(`/api/my/payment-orders/by-order/${created.body.data.id}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.order.status, 'PAID');
  assert.equal(confirmed.body.data.paymentOrder.status, 'PAID');

  const data = store.read();
  const payment = data.paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
  assert.equal(payment.status, 'PAID');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `PAYMENT_${payment.id}`).length, 1);
  assert.equal(data.settlements.filter((item) => item.paymentId === payment.id).length, 1);
});
