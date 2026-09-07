const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'reconciliation-task-admin';
process.env.ADMIN_PASSWORD = 'reconciliation-task-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;
let providerBills;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-reconciliation-task-'));
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
      fetchBills: async () => providerBills
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

async function createPaidPayment(session) {
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
  return store.read().paymentOrders.find((item) => item.id === created.body.paymentOrder.id);
}

test('reconciliation differences create one persistent finance task', async () => {
  const session = await login('task_user');
  const payment = await createPaidPayment(session);
  store.update((data) => {
    const row = data.paymentOrders.find((item) => item.id === payment.id);
    row.paymentNo = 'TASK_PAID';
    row.providerTradeNo = 'RC_TASK_PAID';
    row.paidAt = '2026-09-07T10:00:00.000Z';
  });
  providerBills = { tradeBill: [], fundBill: [] };
  const admin = await adminLogin();

  const first = await api('/api/admin/payment-reconciliations/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ billDate: '2026-09-07' })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.financeTask.type, 'PAYMENT_RECONCILIATION');
  assert.equal(first.body.data.financeTask.status, 'PENDING');
  assert.equal(first.body.data.financeTask.differenceCount, 1);

  const repeat = await api('/api/admin/payment-reconciliations/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ billDate: '2026-09-07' })
  });
  assert.equal(repeat.response.status, 200);
  assert.equal(repeat.body.data.financeTask.id, first.body.data.financeTask.id);
  const tasks = store.read().financeTasks || [];
  assert.equal(tasks.length, 1);
});

test('finance task can be acknowledged and auto-resolves when a rerun matches', async () => {
  const admin = await adminLogin();
  const taskId = store.read().financeTasks[0].id;
  const acknowledged = await api(`/api/admin/finance-tasks/${taskId}/acknowledge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ note: '已联系财务核对渠道流水' })
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.body.data.status, 'ACKNOWLEDGED');
  assert.equal(acknowledged.body.data.acknowledgeNote, '已联系财务核对渠道流水');

  providerBills = {
    tradeBill: [
      { paymentNo: 'TASK_PAID', providerTradeNo: 'RC_TASK_PAID', status: 'SUCCESS', amountInCents: 239900, paidAt: '2026-09-07T10:00:00.000Z' }
    ],
    fundBill: []
  };
  const rerun = await api('/api/admin/payment-reconciliations/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.token}` },
    body: JSON.stringify({ billDate: '2026-09-07' })
  });
  assert.equal(rerun.response.status, 200);
  assert.equal(rerun.body.data.status, 'MATCHED');
  assert.equal(rerun.body.data.financeTask.status, 'RESOLVED');
  assert.equal(rerun.body.data.financeTask.resolvedReason, '重新对账后账实相符，待办自动关闭');

  const storeTask = store.read().financeTasks.find((item) => item.id === taskId);
  assert.equal(storeTask.status, 'RESOLVED');
  assert.ok(storeTask.resolvedAt);
});
