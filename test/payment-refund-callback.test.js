const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'refund-callback-admin';
process.env.ADMIN_PASSWORD = 'refund-callback-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;
let providerRefundStatus = 'PENDING';

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-refund-callback-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'refund-callback-provider',
      channel: 'REFUND_CALLBACK',
      createIntent: (payment) => ({ providerTradeNo: `RC_${payment.paymentNo}` }),
      confirm: () => ({ status: 'PAID' }),
      refund: (payment) => ({
        status: providerRefundStatus,
        refundNo: `RF_${payment.paymentNo}`,
        providerTradeNo: `RC_${payment.paymentNo}`
      }),
      queryRefund: () => ({ status: 'REFUNDED' }),
      verifyCallback(request, body) {
        if (request.headers['x-signature'] !== 'valid') {
          throw new Error('invalid callback signature');
        }
        if (body.eventType === 'REFUND.SUCCESS') {
          return {
            type: 'REFUND',
            status: 'REFUNDED',
            refundNo: body.refundNo,
            providerTradeNo: body.providerTradeNo,
            payload: body
          };
        }
        return {
          type: 'PAYMENT',
          status: body.status,
          providerTradeNo: body.providerTradeNo,
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

async function createPaidOrderWithPendingRefund(code) {
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

  const admin = await adminLogin();
  const refund = await api(`/api/admin/payment-orders/${created.body.paymentOrder.id}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ note: 'provider is processing' })
  });
  assert.equal(refund.response.status, 202);
  return { created: created.body, session, admin };
}

test('refund callback confirms pending refund once and ignores duplicates', async () => {
  providerRefundStatus = 'PENDING';
  const { created } = await createPaidOrderWithPendingRefund('refund_callback_user');
  const payment = created.paymentOrder;
  const callbackBody = {
    eventType: 'REFUND.SUCCESS',
    refundNo: payment.refund?.refundNo || `RF_${payment.paymentNo}`,
    providerTradeNo: payment.providerTradeNo
  };

  const callback = await api('/api/payment-callbacks/refund-callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
    body: JSON.stringify(callbackBody)
  });
  assert.equal(callback.response.status, 200);
  assert.equal(callback.body.data.paymentOrder.status, 'REFUNDED');
  assert.equal(callback.body.data.paymentOrder.refund.status, 'REFUNDED');
  assert.equal(callback.body.data.order.status, 'CANCELLED');

  const duplicate = await api('/api/payment-callbacks/refund-callback-provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-signature': 'valid' },
    body: JSON.stringify(callbackBody)
  });
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.body.data.paymentOrder.status, 'REFUNDED');

  const data = store.read();
  const storedPayment = data.paymentOrders.find((item) => item.id === payment.id);
  const storedOrder = data.orders.find((item) => item.id === created.data.id);
  assert.equal(storedPayment.status, 'REFUNDED');
  assert.equal(storedOrder.status, 'CANCELLED');
  assert.equal(data.financeEvents.filter((item) => item.referenceId === `REFUND_${payment.id}`).length, 1);
  assert.ok(data.settlements.some((item) => item.paymentId === payment.id && item.settlementStatus === 'REFUNDED'));
});
