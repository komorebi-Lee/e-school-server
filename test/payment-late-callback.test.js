const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

let server;
let baseUrl;
let tempDirectory;
let store;
const refundCalls = [];

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-late-callback-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'late-callback-provider',
      channel: 'LATE_CALLBACK',
      createIntent: (payment) => ({ providerTradeNo: `LATE_${payment.paymentNo}` }),
      confirm: () => ({ status: 'PAID' }),
      refund: (payment) => {
        refundCalls.push(payment.id);
        return {
          status: 'REFUNDED',
          refundNo: `RF_${payment.paymentNo}`,
          providerTradeNo: payment.providerTradeNo || `LATE_${payment.paymentNo}`,
          payload: { lateRefund: true }
        };
      },
      verifyCallback(request, body) {
        if (request.headers['x-signature'] !== 'valid') {
          throw new Error('invalid callback signature');
        }
        return {
          type: 'PAYMENT',
          status: body.status,
          providerTradeNo: body.providerTradeNo,
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

test('late payment callback refunds captured payment without restocking released reservation', async () => {
  const session = await login('late_callback_user');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const paymentOrder = created.body.paymentOrder;
  const expiredAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  store.update((data) => {
    const order = data.orders.find((item) => item.id === created.body.data.id);
    order.createdAt = expiredAt;
    order.paymentExpiresAt = expiredAt;
    const payment = data.paymentOrders.find((item) => item.id === paymentOrder.id);
    payment.createdAt = expiredAt;
  });
  const expiredList = await api('/api/products');
  assert.equal(expiredList.response.status, 200);

  let data = store.read();
  const expiredOrder = data.orders.find((item) => item.id === created.body.data.id);
  const expiredPayment = data.paymentOrders.find((item) => item.id === paymentOrder.id);
  const product = data.products.find((item) => item.id === 'prod_ebike_001');
  assert.equal(expiredOrder.status, 'CANCELLED');
  assert.equal(expiredPayment.status, 'CANCELLED');
  assert.equal(expiredOrder.stockReservation, 'RELEASED');
  assert.equal(product.reservedStock, 0);
  const stockAfterExpiry = product.stock;

  const callback = await api('/api/payment-callbacks/late-callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
    body: JSON.stringify({
      providerTradeNo: paymentOrder.providerTradeNo,
      status: 'PAID',
      paidAt: '2026-09-07T10:00:00.000Z'
    })
  });
  assert.equal(callback.response.status, 200);
  assert.equal(callback.body.data.paymentOrder.status, 'REFUNDED');
  assert.equal(callback.body.data.paymentOrder.refund.status, 'REFUNDED');
  assert.equal(callback.body.data.order.status, 'CANCELLED');
  assert.equal(refundCalls.length, 1);

  const duplicate = await api('/api/payment-callbacks/late-callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
    body: JSON.stringify({
      providerTradeNo: paymentOrder.providerTradeNo,
      status: 'PAID',
      paidAt: '2026-09-07T10:00:00.000Z'
    })
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(refundCalls.length, 1);

  data = store.read();
  const storedPayment = data.paymentOrders.find((item) => item.id === paymentOrder.id);
  const storedOrder = data.orders.find((item) => item.id === created.body.data.id);
  const storedProduct = data.products.find((item) => item.id === 'prod_ebike_001');
  assert.equal(storedPayment.status, 'REFUNDED');
  assert.equal(storedOrder.status, 'CANCELLED');
  assert.equal(storedOrder.stockReservation, 'RELEASED');
  assert.equal(storedProduct.stock, stockAfterExpiry);
  assert.equal(storedProduct.reservedStock, 0);
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `PAYMENT_${storedPayment.id}`).length, 1);
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `REFUND_${storedPayment.id}`).length, 1);
});
