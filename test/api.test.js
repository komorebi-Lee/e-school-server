const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'test-admin';
process.env.ADMIN_PASSWORD = 'test-admin-password-123';

let server;
let baseUrl;
let tempDirectory;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-test-'));
  const store = new JsonStore(path.join(tempDirectory, 'db.json'));
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

async function loginWeChat(code) {
  const result = await api('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

test('lead follow-up result rejects unsupported status', async () => {
  const session = await loginWeChat('lead_user');
  const created = await api('/api/leads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      name: '测试同学', phone: '15527111396',
      businessType: 'E_BIKE', interest: '轻风通勤版'
    })
  });
  assert.equal(created.response.status, 201);

  const login = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(login.response.status, 200);

  const rejected = await api(`/api/admin/leads/${created.body.data.id}/follow-ups`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.body.data.token}` },
    body: JSON.stringify({ content: '错误的旧状态', status: 'MATERIAL_PENDING' })
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

test('active product detail exposes merchant and stock', async () => {
  const result = await api('/api/products/prod_ebike_001');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.id, 'prod_ebike_001');
  assert.equal(result.body.data.merchantName, '狮山校园车行');
  assert.equal(typeof result.body.data.stock, 'number');

  const missing = await api('/api/products/not_exists');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'PRODUCT_NOT_FOUND');
});

test('campus card application requires consent and masks private fields', async () => {
  const session = await loginWeChat('card_user');
  const invalid = await api('/api/campus-card-applications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: 'u1' })
  });
  assert.equal(invalid.response.status, 400);

  const created = await api('/api/campus-card-applications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
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
  const session = await loginWeChat('u1');
  const request = {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': 'checkout-001', authorization: `Bearer ${session.token}` },
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

  const list = await api('/api/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(list.body.total, 1);

  const linked = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(linked.response.status, 200);
  assert.equal(linked.body.data.ebikeOrders.length, 1);
  assert.ok(linked.body.data.ebikeOrders[0].plateApplicationId);
  assert.ok(linked.body.data.serviceRecords.some((item) => item.type === 'PLATE' && item.amountInCents === 0));
});

test('after-sale request checks order ownership and prevents duplicates', async () => {
  const session = await loginWeChat('u1');
  const orders = await api('/api/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const orderId = orders.body.data[0].id;
  const other = await loginWeChat('other_user');
  const forbidden = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
    body: JSON.stringify({ userId: 'u2', orderId, type: 'REFUND', reason: '测试退款' })
  });
  assert.equal(forbidden.response.status, 404);

  const created = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ orderId, type: 'REFUND', reason: '测试退款' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'SUBMITTED');

  const duplicate = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ orderId, type: 'REFUND', reason: '重复申请' })
  });
  assert.equal(duplicate.response.status, 409);
});

test('delivery orders require valid campus fulfillment details', async () => {
  const session = await loginWeChat('delivery_user');
  const invalid = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      items: [{ productId: 'prod_ebike_001', quantity: 1 }],
      fulfillment: { type: 'DELIVERY', contactName: '李同学', contactPhone: '123', address: '' }
    })
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');

  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      items: [{ productId: 'prod_ebike_001', quantity: 1 }],
      fulfillment: {
        type: 'DELIVERY', contactName: '李同学', contactPhone: '15527111396',
        address: '荟园学生社区', date: '2026-09-06'
      }
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.fulfillment.address, '荟园学生社区');

  const orderId = created.body.data.id;
  const cannotSwitch = await api(`/api/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ fulfillment: { type: 'PICKUP' } })
  });
  assert.equal(cannotSwitch.response.status, 400);

  const updated = await api(`/api/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ fulfillment: { address: '荟园学生社区 7 栋', date: '2026-09-07' } })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.fulfillment.address, '荟园学生社区 7 栋');
  assert.equal(updated.body.data.fulfillment.contactName, '李同学');
});

test('stock validation rejects excessive quantities', async () => {
  const session = await loginWeChat('u3');
  const result = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: 'u3', items: [{ productId: 'prod_ebike_001', quantity: 99 }] })
  });
  assert.equal(result.response.status, 409);
  assert.equal(result.body.error.code, 'INSUFFICIENT_STOCK');
});

test('merchant can be approved and manage its own products and orders', async () => {
  const merchantSession = await loginWeChat('merchant_user_test');
  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({
      userId: 'merchant_user_test', merchantType: 'INDIVIDUAL', name: '测试校园超市', ownerName: '店主',
      phone: '15527110001', licenseNo: '92420111MAKMT4534R', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '校内日常用品配送', licenseUrl: '/api/uploads/test-license.jpg',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.data.status, 'REVIEWING');
  assert.ok(applied.body.data.applicationNo.startsWith('MC'));

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const approved = await api(`/api/admin/merchants/${applied.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ status: 'APPROVED', reviewNote: '营业执照已核对' })
  });
  assert.equal(approved.body.data.timeline.at(-1).note, '营业执照已核对');
  assert.equal(approved.body.data.timeline.at(-1).status, 'APPROVED');

  const login = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: applied.body.data.id })
  });
  assert.equal(login.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${login.body.data.token}` };

  const product = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '测试文具包', category: 'SERVICE', description: '校内配送', priceInCents: 2500, stock: 20 })
  });
  assert.equal(product.response.status, 201);

  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ userId: 'buyer_test', items: [{ productId: product.body.data.id, quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);

  const overview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.data.orders.length, 1);
  assert.equal(overview.body.data.orders[0].items[0].merchantId, product.body.data.merchantId);

  const fulfilled = await api(`/api/merchant/orders/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'COMPLETED' })
  });
  assert.equal(fulfilled.response.status, 200);
  assert.equal(fulfilled.body.data.status, 'COMPLETED');
});

test('merchant application requires agreements and complete business qualification', async () => {
  const session = await loginWeChat('merchant_rule_test');
  const missingAgreement = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      userId: 'merchant_rule_test', merchantType: 'INDIVIDUAL', name: '测试资质', ownerName: '审核员',
      phone: '15527110002', licenseNo: '92420111MAKMT4534R', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '校内服务', agreeAgreement: false, agreePrivacy: true
    })
  });
  assert.equal(missingAgreement.response.status, 400);
  assert.equal(missingAgreement.body.error.code, 'VALIDATION_ERROR');

  const invalidLicense = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      userId: 'merchant_rule_test', merchantType: 'INDIVIDUAL', name: '测试资质', ownerName: '审核员',
      phone: '15527110002', licenseNo: 'invalid', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '校内服务', agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(invalidLicense.response.status, 400);
});

test('personal merchant application does not require a business license', async () => {
  const session = await loginWeChat('merchant_personal_test');
  const verify = await api('/api/identity/verify', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ ownerName: '李同学', idNumber: '42010619900101001X' })
  });
  assert.equal(verify.response.status, 200);
  assert.equal(verify.body.data.status, 'VERIFIED');

  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      userId: 'merchant_personal_test', merchantType: 'PERSONAL', name: '个人代购服务', ownerName: '李同学',
      phone: '15527110003', category: 'LIFE_SERVICE', serviceArea: '狮山校区',
      description: '个人跑腿与代购服务', agreeAgreement: true, agreePrivacy: true
      , identityVerificationToken: verify.body.data.token
    })
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.data.licenseNo, '');
  assert.equal(applied.body.data.licenseUrl, '');
});

test('merchant qualification upload validates image content and size', async () => {
  const session = await loginWeChat('upload_user');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 1)]);
  const uploaded = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ dataBase64: png.toString('base64'), mimeType: 'image/png' })
  });
  assert.equal(uploaded.response.status, 201);
  assert.match(uploaded.body.data.url, /^\/api\/uploads\/[\w-]+\.png$/);

  const invalidImage = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ dataBase64: Buffer.alloc(2048).toString('base64'), mimeType: 'image/png' })
  });
  assert.equal(invalidImage.response.status, 400);
});

test('phone card service record can apply for broadband once', async () => {
  const session = await loginWeChat('linked_user');
  const created = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      userId: 'linked_user', customerName: '联同学', phone: '15527111396',
      planName: '校园畅享卡', amountInCents: 2900
    })
  });
  assert.equal(created.response.status, 201);
  const recordId = created.body.data.id;

  const first = await api(`/api/service-records/${recordId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: 'linked_user', action: 'APPLY_BROADBAND' })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.status, 'PENDING_VERIFY');

  const repeated = await api(`/api/service-records/${recordId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: 'linked_user', action: 'APPLY_BROADBAND' })
  });
  assert.equal(repeated.response.status, 409);
});

test('order collaboration is shared by user merchant and platform', async () => {
  const userSession = await loginWeChat('collab_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'collab-001', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ userId:'collab_user', items:[{ productId:'prod_ebike_001', quantity:1 }] })
  });
  const orderId = created.body.data.id;
  assert.ok(created.body.data.collaboration);

  const merchantLogin = await api('/api/merchant/login', {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${merchantSession.token}` },
    body:JSON.stringify({ merchantId:'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);

  const accepted = await api('/api/order-collab', {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${merchantLogin.body.data.token}` },
    body:JSON.stringify({ role:'MERCHANT', action:'ACCEPT', orderId, note:'已确认库存，今天安排校内配送。' })
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.data.status, 'FULFILLING');

  const appealed = await api('/api/order-collab', {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${userSession.token}` },
    body:JSON.stringify({ role:'USER', action:'APPEAL', orderId, userId:'collab_user', note:'配送时间需要改成明天上午。' })
  });
  assert.equal(appealed.response.status, 200);
  assert.equal(appealed.body.data.collaboration.intervention.status, 'REQUESTED');
  assert.ok(appealed.body.data.collaboration.messages.some((message)=>message.role==='USER'));
});
