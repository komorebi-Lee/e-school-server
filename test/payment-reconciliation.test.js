const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'reconciliation-admin';
process.env.ADMIN_PASSWORD = 'reconciliation-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-reconciliation-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    paymentProvider: {
      name: 'reconciliation-provider',
      channel: 'RECONCILIATION',
      createIntent: (payment) => ({ providerTradeNo: `RC_${payment.paymentNo}` }),
      confirm: () => ({ status: 'PAID', paidAt: '2026-09-07T10:00:00.000Z' }),
      refund: () => ({ status: 'REFUNDED' }),
      close: () => ({ status: 'CLOSED' }),
      fetchBills: async () => ({
        tradeBill: [
          { paymentNo: 'KNOWN_PAID', providerTradeNo: 'RC_KNOWN_PAID', status: 'SUCCESS', amountInCents: 239900, paidAt: '2026-09-07T10:00:00.000Z' },
          { paymentNo: 'PROVIDER_ONLY', providerTradeNo: 'RC_PROVIDER_ONLY', status: 'SUCCESS', amountInCents: 129900, paidAt: '2026-09-07T10:30:00.000Z' }
        ],
        fundBill: []
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

test('payment reconciliation compares provider bills with local payment and refund records', async () => {
  const session = await login('reconciliation_user');
  for (const productId of ['prod_ebike_001', 'prod_ebike_rent_001']) {
    const created = await api('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
      body: JSON.stringify({ items: [{ productId, quantity: 1 }] })
    });
    assert.equal(created.response.status, 201);
    const confirmed = await api(`/api/payment-orders/${created.body.paymentOrder.id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${session.token}` }
    });
    assert.equal(confirmed.response.status, 200);
  }

  store.update((data) => {
    const payments = data.paymentOrders.filter((item) => item.status === 'PAID');
    const knownPayment = payments.find((item) => item.amountInCents === 239900);
    const localOnlyPayment = payments.find((item) => item.amountInCents === 319900);
    knownPayment.paymentNo = 'KNOWN_PAID';
    knownPayment.providerTradeNo = 'RC_KNOWN_PAID';
    knownPayment.paidAt = '2026-09-07T10:00:00.000Z';
    localOnlyPayment.paymentNo = 'LOCAL_ONLY';
    localOnlyPayment.providerTradeNo = 'RC_LOCAL_ONLY';
    localOnlyPayment.paidAt = '2026-09-07T10:20:00.000Z';
  });
  const data = store.read();

  const admin = await adminLogin();
  const reconciled = await api('/api/admin/payment-reconciliations/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ billDate: '2026-09-07' })
  });
  assert.equal(reconciled.response.status, 200);
  assert.equal(reconciled.body.data.status, 'DIFFERENCES');
  assert.equal(reconciled.body.data.summary.matchedPaymentCount, 1);
  assert.equal(reconciled.body.data.summary.missingLocalPaymentCount, 1);
  assert.equal(reconciled.body.data.summary.missingProviderPaymentCount, 1);
  assert.equal(reconciled.body.data.differences.length, 2);
  assert.ok(reconciled.body.data.differences.some((item) => item.type === 'PROVIDER_PAYMENT_MISSING_LOCAL' && item.paymentNo === 'PROVIDER_ONLY'));
  assert.ok(reconciled.body.data.differences.some((item) => item.type === 'LOCAL_PAYMENT_MISSING_PROVIDER' && item.paymentNo === 'LOCAL_ONLY'));

  const reportId = reconciled.body.data.id;
  const repeat = await api('/api/admin/payment-reconciliations/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ billDate: '2026-09-07' })
  });
  assert.equal(repeat.response.status, 200);
  assert.equal(repeat.body.data.id, reportId);

  const after = store.read();
  const persisted = after.paymentReconciliations || [];
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].billDate, '2026-09-07');
  assert.ok(after.auditLogs.some((item) => item.action === '执行支付对账'));

  const overview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${admin.token}` }
  });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.data.paymentReconciliations.length, 1);
  assert.equal(overview.body.data.paymentReconciliations[0].id, reportId);
  assert.equal(overview.body.data.paymentReconciliations[0].status, 'DIFFERENCES');
});
