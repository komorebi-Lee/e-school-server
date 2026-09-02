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

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-test-'));
  const store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({ store }));
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

test('lead follow-up result rejects unsupported status', async () => {
  const created = await api('/api/leads', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '测试同学', phone: '15527111396',
      businessType: 'E_BIKE', interest: '轻风通勤版'
    })
  });
  assert.equal(created.response.status, 201);

  const login = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Shishan@2026' })
  });
  assert.equal(login.response.status, 200);

  const rejected = await api(`/api/admin/leads/${created.body.data.id}/follow-ups`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.body.data.token}` },
    body: JSON.stringify({ content: '误提交的历史状态', status: 'MATERIAL_PENDING' })
  });
  assert.equal(rejected.response.status, 400);
  assert.equal(rejected.body.error.code, 'VALIDATION_ERROR');
});

test('health and product list are available', async () => {
  const health = await api('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.body.ok, true);

  const products = await api('/api/products?campusId=campus_demo');
  assert.equal(products.response.status, 200);
  assert.equal(products.body.total, 3);
  assert.ok(products.body.data.every((item) => Number.isInteger(item.priceInCents)));
});

test('campus card application requires consent and masks private fields', async () => {
  const invalid = await api('/api/campus-card-applications', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u1' })
  });
  assert.equal(invalid.response.status, 400);

  const created = await api('/api/campus-card-applications', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'u1', schoolId: 'school_demo', campusId: 'campus_demo',
      serviceType: 'REPLACEMENT', applicantName: '张同学', studentNo: '20260001', consent: true
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'SUBMITTED');
  assert.equal(created.body.data.applicantName, undefined);
  assert.match(created.body.data.studentNoMasked, /^20\*+01$/);
});

test('order total is server-calculated and idempotency prevents duplicate orders', async () => {
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'checkout-001' },
    body: JSON.stringify({
      userId: 'u1', items: [{ productId: 'prod_ebike_rent_001', quantity: 2, priceInCents: 1 }]
    })
  };
  const created = await api('/api/orders', request);
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.totalInCents, 639800);

  const repeated = await api('/api/orders', request);
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.data.id, created.body.data.id);
  assert.equal(repeated.body.idempotencyReused, true);

  const list = await api('/api/orders?userId=u1');
  assert.equal(list.body.total, 1);

  const linked = await api('/api/my/orders?userId=u1');
  assert.equal(linked.response.status, 200);
  assert.equal(linked.body.data.ebikeOrders.length, 1);
  assert.ok(linked.body.data.ebikeOrders[0].plateApplicationId);
  assert.ok(linked.body.data.serviceRecords.some((item) => item.type === 'PLATE' && item.amountInCents === 0));
});

test('after-sale request checks order ownership and prevents duplicates', async () => {
  const orders = await api('/api/orders?userId=u1');
  const orderId = orders.body.data[0].id;
  const forbidden = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u2', orderId, type: 'REFUND', reason: '测试退款' })
  });
  assert.equal(forbidden.response.status, 404);

  const created = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u1', orderId, type: 'REFUND', reason: '测试退款' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'SUBMITTED');

  const duplicate = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u1', orderId, type: 'REFUND', reason: '重复申请' })
  });
  assert.equal(duplicate.response.status, 409);
});

test('stock validation rejects excessive quantities', async () => {
  const result = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'u3', items: [{ productId: 'prod_ebike_001', quantity: 99 }] })
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, 'INSUFFICIENT_STOCK');
});

test('phone card service record can apply for broadband once', async () => {
  const created = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'linked_user', customerName: '联同学', phone: '15527111396',
      planName: '校园畅享卡', amountInCents: 2900
    })
  });
  assert.equal(created.response.status, 201);
  const recordId = created.body.data.id;

  const first = await api(`/api/service-records/${recordId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'linked_user', action: 'APPLY_BROADBAND' })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.status, 'PENDING_VERIFY');

  const repeated = await api(`/api/service-records/${recordId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'linked_user', action: 'APPLY_BROADBAND' })
  });
  assert.equal(repeated.response.status, 409);
});
