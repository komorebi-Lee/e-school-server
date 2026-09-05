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
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-test-'));
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

async function loginWeChat(code) {
  const result = await api('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

async function confirmPayment(paymentId, token) {
  return api(`/api/payment-orders/${paymentId}/confirm`, {
    method: 'POST', headers: { authorization: `Bearer ${token}` }
  });
}

function makeImage(mimeType = 'image/png') {
  if (mimeType === 'image/png') {
    const bytes = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(1200, 1)]);
    return { dataBase64: bytes.toString('base64'), mimeType };
  }
  const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1200, 1)]);
  return { dataBase64: bytes.toString('base64'), mimeType };
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
  assert.equal(products.body.total, 5);
  assert.ok(products.body.data.every((item) => Number.isInteger(item.priceInCents)));
  assert.equal(products.body.data.filter((item) => item.category === 'PHONE_PLAN').length, 3);
});

test('active product detail exposes merchant and stock', async () => {
  const result = await api('/api/products/prod_ebike_001');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.id, 'prod_ebike_001');
  assert.equal(result.body.data.merchantName, '狮山校园车行');
  assert.equal(typeof result.body.data.stock, 'number');
  assert.equal(result.body.data.ratingSummary.average, 4.5);
  assert.equal(result.body.data.ratingSummary.purchaseVerifiedCount, 2);
  assert.equal(result.body.data.reviews.length, 2);
  assert.ok(result.body.data.reviews.every((review) => review.purchaseVerified));
  assert.equal(result.body.data.settings.deliveryResponseHours, 24);

  const missing = await api('/api/products/not_exists');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'PRODUCT_NOT_FOUND');
});

test('business rules configure public commitments and delivery fees', async () => {
  const config = await api('/api/business-config');
  assert.equal(config.response.status, 200);
  assert.equal(config.body.data.deliveryFeeInCents, 0);
  assert.equal(config.body.data.deliveryResponseHours, 24);
  assert.ok(config.body.data.deliveryTimeSlots.length > 0);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ deliveryFeeInCents: 500 })
  });
  const session = await loginWeChat('fee_user');
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      items: [{ productId: 'prod_ebike_001', quantity: 1 }],
      fulfillment: { type: 'DELIVERY', contactName: '费同学', contactPhone: '15527111001', address: '荟园1栋', date: '2026-09-06', timeSlot: '今天 12:00-14:00' }
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.feeSummary.itemsInCents, 239900);
  assert.equal(created.body.data.feeSummary.deliveryFeeInCents, 500);
  assert.equal(created.body.data.totalInCents, 240400);
  assert.equal(created.body.data.fulfillment.timeSlot, '今天 12:00-14:00');

  const invalidSlots = await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ deliveryTimeSlots: [] })
  });
  assert.equal(invalidSlots.response.status, 400);

  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ deliveryFeeInCents: 0 })
  });
  const restored = await api('/api/business-config');
  assert.equal(restored.body.data.deliveryFeeInCents, 0);
});

test('phone plans and recharge promos are centrally configurable', async () => {
  const products = await api('/api/products?category=PHONE_PLAN');
  assert.equal(products.response.status, 200);
  assert.ok(products.body.data.some((product) => product.name === '校园畅享卡'));

  const promos = await api('/api/recharge-promos');
  assert.equal(promos.response.status, 200);
  assert.ok(promos.body.data.some((promo) => promo.pay === 100 && promo.receive === 150));
  assert.ok(promos.body.data.some((promo) => promo.pay === 150 && promo.receive === 200));
  assert.ok(promos.body.data.some((promo) => promo.pay === 200 && promo.receive === 250));

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const created = await api('/api/admin/recharge-promos', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ payInCents: 30000, receiveInCents: 38000, badge: '多得80元', active: true })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.pay, 300);
  assert.equal(created.body.data.receive, 380);

  const invalid = await api('/api/admin/recharge-promos', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ payInCents: 30000, receiveInCents: 10000, badge: '无效活动', active: true })
  });
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
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
  assert.equal(created.body.data.status, 'PENDING_PAYMENT');
  assert.equal(created.body.data.paymentStatus, 'UNPAID');
  assert.ok(created.body.paymentOrder);

  const repeated = await api('/api/orders', request);
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.data.id, created.body.data.id);
  assert.equal(repeated.body.idempotencyReused, true);

  const list = await api('/api/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(list.body.total, 1);

  const linked = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(linked.response.status, 200);
  assert.equal(linked.body.data.ebikeOrders.length, 1);
  assert.equal(linked.body.data.ebikeOrders[0].plateApplicationId, '');

  const confirmed = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.order.status, 'PAID');
  assert.equal(confirmed.body.data.paymentOrder.status, 'PAID');
  const confirmedLinked = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(confirmedLinked.body.data.ebikeOrders[0].plateApplicationId);
  assert.ok(confirmedLinked.body.data.serviceRecords.some((item) => item.type === 'PLATE' && item.amountInCents === 0));
});

test('after-sale request checks order ownership and prevents duplicates', async () => {
  const session = await loginWeChat('u1');
  const orders = await api('/api/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const orderId = orders.body.data[0].id;
  const orderDetail = await api(`/api/orders/${orderId}`, { headers: { authorization: `Bearer ${session.token}` } });
  await confirmPayment(orderDetail.body.data.paymentOrderId, session.token);
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
  assert.equal(created.body.data.typeLabel, '申请退款');
  assert.ok(created.body.data.responseDueAt);
  assert.ok(created.body.data.resolutionDueAt);

  const duplicate = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ orderId, type: 'REFUND', reason: '重复申请' })
  });
  assert.equal(duplicate.response.status, 409);
});

test('delivery orders require valid campus fulfillment details', async () => {
  const session = await loginWeChat('delivery_user');
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dayAfterTomorrow = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const pastDate = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      items: [{ productId: 'prod_ebike_001', quantity: 1 }],
      fulfillment: { type: 'DELIVERY', contactName: '李同学', contactPhone: '15527111396', address: '荟园学生社区', date: '2000-01-01', timeSlot: '今天 12:00-14:00' }
    })
  });
  assert.equal(pastDate.response.status, 400);

  const invalidSlot = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      items: [{ productId: 'prod_ebike_001', quantity: 1 }],
      fulfillment: { type: 'DELIVERY', contactName: '李同学', contactPhone: '15527111396', address: '荟园学生社区', date: tomorrow, timeSlot: '凌晨三点' }
    })
  });
  assert.equal(invalidSlot.response.status, 400);

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
        address: '荟园学生社区', date: tomorrow, timeSlot: '今天 12:00-14:00'
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
      body: JSON.stringify({ fulfillment: { address: '荟园学生社区 7 栋', date: dayAfterTomorrow, timeSlot: '今天 16:00-18:00' } })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.fulfillment.address, '荟园学生社区 7 栋');
  assert.equal(updated.body.data.fulfillment.contactName, '李同学');
  assert.ok(updated.body.data.collaboration.handoffs.some((event) => event.action === 'RESCHEDULE' && event.note.includes('用户已改约')));
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
      settlementAccountName: '店主', settlementBank: '校园演示银行', settlementAccount: '6222 0000 0000 0000',
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
  const invalidRate = await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ commissionRatePercent: 51 })
  });
  assert.equal(invalidRate.response.status, 400);
  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ commissionRatePercent: 8 })
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
  await confirmPayment(created.body.paymentOrder.id, merchantSession.token);

  const overview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.data.orders.length, 1);
  assert.equal(overview.body.data.orders[0].items[0].merchantId, product.body.data.merchantId);
  assert.equal(overview.body.data.settlements.length, 1);
  assert.equal(overview.body.data.settlements[0].amountInCents, 2500);
  assert.equal(overview.body.data.settlements[0].commissionRatePercent, 8);
  assert.equal(overview.body.data.settlements[0].platformFeeInCents, 200);
  assert.equal(overview.body.data.settlements[0].payableAmountInCents, 2300);
  assert.equal(overview.body.data.settlements[0].settlementStatus, 'PENDING_DELIVERY');
  assert.equal(overview.body.data.metrics.settlementMetrics.commissionRatePercent, 8);
  assert.equal(overview.body.data.metrics.settlementMetrics.pendingDeliveryInCents, 2300);
  assert.equal(overview.body.data.metrics.settlementMetrics.payableInCents, 0);
  assert.equal(overview.body.data.merchant.settlementAccountReady, true);
  assert.equal(overview.body.data.merchant.settlementAccountMasked, '6222 **** 0000');
  assert.ok(!('deliveryCode' in overview.body.data.orders[0]));

  // 交付未核验前不允许打款，避免钱先出后货没到。
  const earlySettle = await api(`/api/admin/merchants/${applied.body.data.id}/settle`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ reference: 'TEST-PAYOUT-EARLY' })
  });
  assert.equal(earlySettle.response.status, 409);
  assert.equal(earlySettle.body.error.code, 'SETTLEMENT_NOT_RELEASED');
  assert.ok(earlySettle.body.error.message.includes('交付核验'));

  const paidOrder = await api(`/api/orders/${created.body.data.id}`, {
    headers: { authorization: `Bearer ${merchantSession.token}` }
  });
  assert.equal(paidOrder.response.status, 200);
  const deliveryCode = paidOrder.body.data.deliveryCode;
  assert.match(deliveryCode, /^\d{6}$/);

  const missingCode = await api(`/api/merchant/orders/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'COMPLETED' })
  });
  assert.equal(missingCode.response.status, 409);
  assert.equal(missingCode.body.error.code, 'DELIVERY_CODE_INVALID');

  const wrongCode = await api(`/api/merchant/orders/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: '000000' })
  });
  assert.equal(wrongCode.response.status, 409);
  assert.equal(wrongCode.body.error.code, 'DELIVERY_CODE_INVALID');

  const fulfilled = await api(`/api/merchant/orders/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode })
  });
  assert.equal(fulfilled.response.status, 200);
  assert.equal(fulfilled.body.data.status, 'COMPLETED');

  // 交付核验通过后进入账期，账期未到期仍然不能打款。
  const inPeriod = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(inPeriod.body.data.settlements[0].settlementStatus, 'IN_ACCOUNT_PERIOD');
  assert.equal(inPeriod.body.data.settlements[0].settlementPeriodDays, 7);
  assert.ok(inPeriod.body.data.settlements[0].deliveredAt);
  assert.equal(inPeriod.body.data.metrics.settlementMetrics.inAccountPeriodInCents, 2300);
  assert.equal(inPeriod.body.data.metrics.settlementMetrics.payableInCents, 0);
  assert.equal(inPeriod.body.data.metrics.settlementMetrics.settlementPeriodDays, 7);

  const periodSettle = await api(`/api/admin/merchants/${applied.body.data.id}/settle`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ reference: 'TEST-PAYOUT-PERIOD' })
  });
  assert.equal(periodSettle.response.status, 409);
  assert.ok(periodSettle.body.error.message.includes('账期'));

  store.update((data) => {
    for (const settlement of data.settlements) {
      if (settlement.merchantId === applied.body.data.id) settlement.availableAt = new Date(Date.now() - 60 * 1000).toISOString();
    }
  });

  const matured = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(matured.body.data.settlements[0].settlementStatus, 'PENDING_SETTLE');
  assert.equal(matured.body.data.metrics.settlementMetrics.payableInCents, 2300);

  const settled = await api(`/api/admin/merchants/${applied.body.data.id}/settle`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ reference: 'TEST-PAYOUT-001' })
  });
  assert.equal(settled.response.status, 200);
  assert.equal(settled.body.data.totalInCents, 2300);
  assert.equal(settled.body.data.settlementCount, 1);
  assert.equal(settled.body.data.settlementReference, 'TEST-PAYOUT-001');
  const settledOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(settledOverview.body.data.metrics.settlementMetrics.payableInCents, 0);
  assert.equal(settledOverview.body.data.metrics.settlementMetrics.settledInCents, 2300);
  const payoutOverview = await api('/api/admin/overview', { headers: { authorization: `Bearer ${adminLogin.body.data.token}` } });
  const payoutFinanceEvent = payoutOverview.body.data.financeEvents.find((event) => event.eventType === 'PAYOUT' && event.settlementReference === 'TEST-PAYOUT-001');
  assert.ok(payoutFinanceEvent);
  assert.equal(payoutFinanceEvent.amountInCents, -2300);
  assert.equal(payoutFinanceEvent.merchantId, applied.body.data.id);
  const resetRate = await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ commissionRatePercent: 2 })
  });
  assert.equal(resetRate.body.data.commissionRatePercent, 2);
  const repeatSettle = await api(`/api/admin/merchants/${applied.body.data.id}/settle`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ reference: 'TEST-PAYOUT-002' })
  });
  assert.equal(repeatSettle.response.status, 404);

  const afterSale = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ orderId: created.body.data.id, type: 'REPAIR', reason: '商品需要维修检测' })
  });
  assert.equal(afterSale.response.status, 201);

  const handled = await api(`/api/merchant/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'REVIEWING' })
  });
  assert.equal(handled.response.status, 200);
  assert.equal(handled.body.data.status, 'REVIEWING');

  const closed = await api(`/api/merchant/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '已联系售后网点，检测结果正常并恢复交付。' })
  });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.body.data.status, 'CLOSED');
  assert.equal(closed.body.data.resolutionNote, '已联系售后网点，检测结果正常并恢复交付。');

  const refreshed = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(refreshed.response.status, 200);
  assert.equal(refreshed.body.data.afterSales.length, 1);
  assert.equal(refreshed.body.data.orders[0].status, 'COMPLETED');
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
      serviceArea: '狮山校区', description: '校内服务', settlementAccountName: '审核员', settlementBank: '校园演示银行', settlementAccount: '6222000000000000', agreeAgreement: true, agreePrivacy: true
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
      , settlementAccountName: '李同学', settlementBank: '校园演示银行', settlementAccount: '6222000000001234', identityVerificationToken: verify.body.data.token
    })
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.data.licenseNo, '');
  assert.equal(applied.body.data.licenseUrl, '');
  assert.equal(applied.body.data.settlementAccountReady, true);
  assert.equal(applied.body.data.settlementAccountMasked, '6222 **** 1234');
});

test('merchant settlement account is required and masked', async () => {
  const session = await loginWeChat('settlement_account_user');
  const missingAccount = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      merchantType: 'PERSONAL', name: '收款资料测试', ownerName: '王同学', phone: '15527110009',
      category: 'LIFE_SERVICE', serviceArea: '狮山校区', description: '收款资料校验',
      identityVerificationToken: 'missing', agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(missingAccount.response.status, 400);
  assert.equal(missingAccount.body.error.code, 'VALIDATION_ERROR');
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
      productId: 'prod_card_service_001'
    })
  });
  assert.equal(created.response.status, 201);
  await confirmPayment(created.body.paymentOrder.id, session.token);
  const recordId = created.body.data.id;

  const notEligible = await api('/api/broadband-applications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ ownerPhone: '15527111396', companionPhone: '15527111496' })
  });
  assert.equal(notEligible.response.status, 409);
  assert.equal(notEligible.body.error.code, 'BROADBAND_ELIGIBILITY_NOT_MET');

  const missingCompanion = await api(`/api/service-records/${recordId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: 'linked_user', action: 'APPLY_BROADBAND' })
  });
  assert.equal(missingCompanion.response.status, 400);

  const companionSession = await loginWeChat('broadband_companion');
  const companionCard = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${companionSession.token}` },
    body: JSON.stringify({ customerName: '网同学', phone: '15527111496', productId: 'prod_card_service_001' })
  });
  assert.equal(companionCard.response.status, 201);
  await confirmPayment(companionCard.body.paymentOrder.id, companionSession.token);
  const adminActivate = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminActivate.response.status, 200);
  await api(`/api/admin/phone-card-orders/${created.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminActivate.body.data.token}` },
    body: JSON.stringify({ status: 'ACTIVATED' })
  });
  await api(`/api/admin/phone-card-orders/${companionCard.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminActivate.body.data.token}` },
    body: JSON.stringify({ status: 'ACTIVATED' })
  });

  const first = await api(`/api/service-records/${recordId}/actions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: 'linked_user', action: 'APPLY_BROADBAND', companionPhone: '15527111496' })
  });
  assert.equal(first.response.status, 200);
  assert.equal(first.body.data.status, 'PENDING_VERIFY');

  const duplicateApplication = await api('/api/broadband-applications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ ownerPhone: '15527111396', companionPhone: '15527111496' })
  });
  assert.equal(duplicateApplication.response.status, 409);
  assert.equal(duplicateApplication.body.error.code, 'BROADBAND_APPLICATION_EXISTS');

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
  await confirmPayment(created.body.paymentOrder.id, userSession.token);

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

  const paidOrder = await api(`/api/orders/${orderId}`, {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(paidOrder.response.status, 200);
  const deliveryCode = paidOrder.body.data.deliveryCode;
  assert.match(deliveryCode, /^\d{6}$/);

  const rejectedComplete = await api('/api/order-collab', {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${merchantLogin.body.data.token}` },
    body:JSON.stringify({ role:'MERCHANT', action:'COMPLETE', orderId, note:'尝试无码完成', deliveryCode:'000000' })
  });
  assert.equal(rejectedComplete.response.status, 409);
  assert.equal(rejectedComplete.body.error.code, 'DELIVERY_CODE_INVALID');

  const completed = await api('/api/order-collab', {
    method:'POST', headers:{ 'content-type':'application/json', authorization:`Bearer ${merchantLogin.body.data.token}` },
    body:JSON.stringify({ role:'MERCHANT', action:'COMPLETE', orderId, note:'交付码已核对', deliveryCode })
  });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.data.status, 'COMPLETED');
  assert.ok(completed.body.data.collaboration.handoffs.some((event)=>event.note === '商家已核验交付码，订单已完成'));
});

test('merchant products use platform-uploaded images', async () => {
  const session = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);

  const upload = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify(makeImage())
  });
  assert.equal(upload.response.status, 201);

  const created = await api('/api/merchant/products', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({
      name: '带图测试车', category: 'E_BIKE_NEW', description: '商品图完整闭环',
      priceInCents: 120000, stock: 4, imageUrl: upload.body.data.url
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.imageUrl, upload.body.data.url);

  const rejected = await api(`/api/merchant/products/${created.body.data.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ imageUrl: 'https://example.com/bike.jpg' })
  });
  assert.equal(rejected.response.status, 400);

  const removed = await api(`/api/merchant/products/${created.body.data.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ imageUrl: '' })
  });
  assert.equal(removed.response.status, 200);
  assert.equal(removed.body.data.imageUrl, '');
});

test('completed order owner can submit one verified product review', async () => {
  const userSession = await loginWeChat('review_owner');
  const merchantSession = await loginWeChat('review_merchant');
  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({
      userId: 'review_merchant', merchantType: 'INDIVIDUAL', name: '评价测试车行', ownerName: '店长',
      phone: '15527110003', licenseNo: '92420111MAKMT4534R', category: 'E_BIKE',
      serviceArea: '狮山校区', description: '校内配送', licenseUrl: '/api/uploads/test-license.jpg',
      settlementAccountName: '店长', settlementBank: '校园演示银行', settlementAccount: '6222000000005678',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  await api(`/api/admin/merchants/${applied.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ status: 'APPROVED' })
  });
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: applied.body.data.id })
  });
  const product = await api('/api/merchant/products', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ name: '评价测试车', category: 'E_BIKE_NEW', description: '适合校园通勤', priceInCents: 100000, stock: 3 })
  });
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ items: [{ productId: product.body.data.id, quantity: 1 }] })
  });
  const orderId = created.body.data.id;
  await confirmPayment(created.body.paymentOrder.id, userSession.token);

  const pendingReview = await api('/api/product-reviews', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ orderId, productId: product.body.data.id, rating: 5, content: '配送很快' })
  });
  assert.equal(pendingReview.response.status, 409);

  await api(`/api/merchant/orders/${orderId}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ status: 'FULFILLING' })
  });
  const paidOrder = await api(`/api/orders/${orderId}`, {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(paidOrder.response.status, 200);
  const deliveryCode = paidOrder.body.data.deliveryCode;
  assert.match(deliveryCode, /^\d{6}$/);

  await api(`/api/merchant/orders/${orderId}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode })
  });

  const unsafeImages = await api('/api/product-reviews', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({
      orderId, productId: product.body.data.id, rating: 5, content: '带外链图的评价',
      images: ['https://example.com/track.png']
    })
  });
  assert.equal(unsafeImages.response.status, 400);
  assert.equal(unsafeImages.body.error.code, 'VALIDATION_ERROR');

  const review = await api('/api/product-reviews', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({
      orderId, productId: product.body.data.id, rating: 5, content: '配送很快，上牌指引也很清楚。',
      images: ['/api/uploads/review-photo.jpg']
    })
  });
  assert.equal(review.response.status, 201);
  assert.equal(review.body.data.purchaseVerified, true);

  const repeated = await api('/api/product-reviews', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ orderId, productId: product.body.data.id, rating: 4, content: '重复评价' })
  });
  assert.equal(repeated.response.status, 409);

  const detail = await api(`/api/products/${product.body.data.id}`);
  assert.equal(detail.body.data.ratingSummary.purchaseVerifiedCount, 1);
  assert.equal(detail.body.data.reviews[0].id, review.body.data.id);
  assert.equal(detail.body.data.reviews[0].content, '配送很快，上牌指引也很清楚。');
  assert.deepEqual(detail.body.data.reviews[0].images, ['/api/uploads/review-photo.jpg']);

  const invalidVisibility = await api(`/api/admin/product-reviews/${review.body.data.id}/visibility`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ visibility: 'DELETED' })
  });
  assert.equal(invalidVisibility.response.status, 400);
  assert.equal(invalidVisibility.body.error.code, 'VALIDATION_ERROR');

  const hidden = await api(`/api/admin/product-reviews/${review.body.data.id}/visibility`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ visibility: 'HIDDEN' })
  });
  assert.equal(hidden.response.status, 200);
  assert.equal(hidden.body.data.visibility, 'HIDDEN');

  const hiddenDetail = await api(`/api/products/${product.body.data.id}`);
  assert.equal(hiddenDetail.body.data.ratingSummary.purchaseVerifiedCount, 0);
  assert.equal(hiddenDetail.body.data.reviews.length, 0);

  const restored = await api(`/api/admin/product-reviews/${review.body.data.id}/visibility`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ visibility: 'PUBLISHED' })
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.data.visibility, 'PUBLISHED');

  const restoredDetail = await api(`/api/products/${product.body.data.id}`);
  assert.equal(restoredDetail.body.data.ratingSummary.purchaseVerifiedCount, 1);
  assert.equal(restoredDetail.body.data.reviews[0].id, review.body.data.id);

  const merchantOverview = await api('/api/merchant/overview', { headers: merchantLogin.body.data.token ? { authorization: `Bearer ${merchantLogin.body.data.token}` } : {} });
  assert.equal(merchantOverview.response.status, 200);
  const merchantReview = merchantOverview.body.data.reviews.find((item) => item.id === review.body.data.id);
  assert.ok(merchantReview);
  assert.equal(merchantOverview.body.data.metrics.pendingReplyCount, 1);

  const otherMerchantReply = await api(`/api/merchant/product-reviews/${review.body.data.id}/reply`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ content: '' })
  });
  assert.equal(otherMerchantReply.response.status, 400);

  const merchantReply = await api(`/api/merchant/product-reviews/${review.body.data.id}/reply`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ content: '感谢反馈，我们会持续检查车辆与配送服务。' })
  });
  assert.equal(merchantReply.response.status, 200);
  assert.equal(merchantReply.body.data.reply.merchantName, '评价测试车行');
  assert.equal(merchantReply.body.data.reply.content, '感谢反馈，我们会持续检查车辆与配送服务。');

  const repliedOverview = await api('/api/merchant/overview', { headers: { authorization: `Bearer ${merchantLogin.body.data.token}` } });
  assert.equal(repliedOverview.body.data.metrics.pendingReplyCount, 0);
  const repliedDetail = await api(`/api/products/${product.body.data.id}`);
  assert.equal(repliedDetail.body.data.reviews[0].reply.content, '感谢反馈，我们会持续检查车辆与配送服务。');
});

test('admin order status update rejects unsupported status', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const response = await api('/api/admin/phone-card-orders/not-exists/status', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ status: 'BOGUS' })
  });
  assert.equal(response.response.status, 400);
  assert.equal(response.body.error.code, 'VALIDATION_ERROR');
});

test('payment lifecycle creates notifications and supports cancel or refund', async () => {
  const session = await loginWeChat('payment_lifecycle');

  const cancelledOrder = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(cancelledOrder.response.status, 201);
  const cancel = await api(`/api/orders/${cancelledOrder.body.data.id}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(cancel.response.status, 200);
  assert.equal(cancel.body.data.status, 'CANCELLED');
  assert.equal(cancel.body.data.paymentStatus, 'CANCELLED');

  const paidOrder = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_rent_001', quantity: 1 }] })
  });
  assert.equal(paidOrder.response.status, 201);
  const confirmed = await confirmPayment(paidOrder.body.paymentOrder.id, session.token);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.order.status, 'PAID');

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const payments = await api('/api/admin/payment-orders', {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  assert.equal(payments.response.status, 200);
  assert.ok(payments.body.data.some((item) => item.id === paidOrder.body.paymentOrder.id));
  const adminOverviewBeforeRefund = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  const linkedSettlement = adminOverviewBeforeRefund.body.data.settlements.find((item) => item.paymentId === paidOrder.body.paymentOrder.id);
  assert.ok(linkedSettlement);
  assert.equal(linkedSettlement.settlementStatus, 'PENDING_DELIVERY');
  assert.equal(linkedSettlement.commissionRatePercent, 2);
  assert.equal(linkedSettlement.payableAmountInCents, linkedSettlement.amountInCents - linkedSettlement.platformFeeInCents);
  const paidFinanceEvent = adminOverviewBeforeRefund.body.data.financeEvents.find((event) => event.referenceId === `PAYMENT_${paidOrder.body.paymentOrder.id}`);
  assert.ok(paidFinanceEvent);
  assert.equal(paidFinanceEvent.amountInCents, paidOrder.body.paymentOrder.amountInCents);
  assert.equal(linkedSettlement.payableAmountInCents, linkedSettlement.amountInCents - linkedSettlement.platformFeeInCents);

  const refund = await api(`/api/admin/payment-orders/${paidOrder.body.paymentOrder.id}/refund`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ note: 'test refund' })
  });
  assert.equal(refund.response.status, 200);
  assert.equal(refund.body.data.paymentOrder.status, 'REFUNDED');
  assert.equal(refund.body.data.order.status, 'CANCELLED');
  const adminOverviewAfterRefund = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  const refundedSettlement = adminOverviewAfterRefund.body.data.settlements.find((item) => item.paymentId === paidOrder.body.paymentOrder.id);
  assert.equal(refundedSettlement.settlementStatus, 'REFUNDED');
  assert.ok(refundedSettlement.refundedAt);
  const refundFinanceEvent = adminOverviewAfterRefund.body.data.financeEvents.find((event) => event.referenceId === `REFUND_${paidOrder.body.paymentOrder.id}`);
  assert.ok(refundFinanceEvent);
  assert.equal(refundFinanceEvent.amountInCents, -paidOrder.body.paymentOrder.amountInCents);
  assert.ok(adminOverviewAfterRefund.body.data.financeSummary.paymentInCents > 0);
  assert.ok(adminOverviewAfterRefund.body.data.financeSummary.refundOutCents < 0);

  const notifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(notifications.response.status, 200);
  assert.ok(notifications.body.data.some((item) => item.type === 'ORDER' && item.title.includes('取消')));
  assert.ok(notifications.body.data.some((item) => item.type === 'ORDER' && item.title.includes('退款')));

  const marked = await api('/api/my/notifications/read', {
    method: 'POST', headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(marked.response.status, 200);
  assert.ok(marked.body.data.updated > 0);
});

test('recharge payments create pending credit orders and notifications', async () => {
  const session = await loginWeChat('recharge_payment');
  const created = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'recharge-payment-001', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527110099', promoId: 'promo_recharge_200' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'PENDING_PAYMENT');
  assert.equal(created.body.data.paymentStatus, 'UNPAID');
  assert.ok(created.body.paymentOrder);
  assert.equal(created.body.paymentOrder.amountInCents, 20000);

  const tamperedPromo = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527110099', promoId: 'promo_recharge_200', paidInCents: 1, receiveInCents: 999999999 })
  });
  assert.equal(tamperedPromo.response.status, 201);
  assert.equal(tamperedPromo.body.data.paidInCents, 20000);
  assert.equal(tamperedPromo.body.data.receiveInCents, 25000);

  const unknownPromo = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527110099', promoId: 'not_exists' })
  });
  assert.equal(unknownPromo.response.status, 404);
  assert.equal(unknownPromo.body.error.code, 'RECHARGE_PROMO_NOT_FOUND');

  const repeated = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'recharge-payment-001', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527110099', promoId: 'promo_recharge_200' })
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.data.id, created.body.data.id);

  const confirmed = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.rechargeOrder.status, 'PENDING_CREDIT');
  assert.equal(confirmed.body.data.rechargeOrder.paymentStatus, 'PAID');
  assert.equal(confirmed.body.data.paymentOrder.status, 'PAID');

  const records = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(records.body.data.serviceRecords.some((item) => item.type === 'RECHARGE' && item.status === 'PENDING_CREDIT'));

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const refunded = await api(`/api/admin/payment-orders/${created.body.paymentOrder.id}/refund`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ note: 'recharge refund test' })
  });
  assert.equal(refunded.response.status, 200);
  assert.equal(refunded.body.data.rechargeOrder.status, 'CANCELLED');
  assert.equal(refunded.body.data.rechargeOrder.paymentStatus, 'REFUNDED');

  const notifications = await api('/api/my/notifications', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(notifications.body.data.some((item) => item.type === 'RECHARGE' && item.title.includes('支付成功')));
});

test('phone card payments enter real-name activation and support refunds', async () => {
  const session = await loginWeChat('card_payment');
  const created = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'card-payment-001', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '卡同学', phone: '15527110088', productId: 'prod_card_service_002' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'PENDING_PAYMENT');
  assert.equal(created.body.data.paymentStatus, 'UNPAID');
  assert.ok(created.body.paymentOrder);
  assert.equal(created.body.data.amountInCents, 3900);

  const repeated = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'card-payment-001', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '卡同学', phone: '15527110088', productId: 'prod_card_service_002' })
  });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.data.id, created.body.data.id);

  const confirmed = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.body.data.phoneCardOrder.status, 'PENDING_REALNAME');
  assert.equal(confirmed.body.data.phoneCardOrder.paymentStatus, 'PAID');
  assert.equal(confirmed.body.data.paymentOrder.status, 'PAID');

  const tamperedPlan = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '卡同学', phone: '15527110088', productId: 'prod_card_service_002', amountInCents: 1 })
  });
  assert.equal(tamperedPlan.response.status, 201);
  assert.equal(tamperedPlan.body.data.amountInCents, 3900);

  const unknownPlan = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '卡同学', phone: '15527110088', productId: 'not_exists' })
  });
  assert.equal(unknownPlan.response.status, 404);
  assert.equal(unknownPlan.body.error.code, 'PHONE_PLAN_NOT_FOUND');

  const records = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(records.body.data.serviceRecords.some((item) => item.type === 'PHONE_PLAN' && item.status === 'PENDING_REALNAME'));

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const refunded = await api(`/api/admin/payment-orders/${created.body.paymentOrder.id}/refund`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ note: 'card refund test' })
  });
  assert.equal(refunded.response.status, 200);
  assert.equal(refunded.body.data.phoneCardOrder.status, 'CANCELLED');
  assert.equal(refunded.body.data.phoneCardOrder.paymentStatus, 'REFUNDED');

  const notifications = await api('/api/my/notifications', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(notifications.body.data.some((item) => item.type === 'PHONE_PLAN' && item.title.includes('支付成功')));
  assert.ok(notifications.body.data.some((item) => item.type === 'PHONE_PLAN' && item.title.includes('退款')));

  const cancelled = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '卡同学', phone: '15527110088', productId: 'prod_card_service_003' })
  });
  assert.equal(cancelled.response.status, 201);
  const cancel = await api(`/api/payment-orders/${cancelled.body.paymentOrder.id}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(cancel.response.status, 200);
  assert.equal(cancel.body.data.phoneCardOrder.status, 'CANCELLED');
  assert.equal(cancel.body.data.paymentOrder.status, 'CANCELLED');
});

test('admin metrics exclude unpaid and refunded service records', async () => {
  const admin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(admin.response.status, 200);
  const adminHeaders = { authorization: `Bearer ${admin.body.data.token}` };
  const before = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(before.response.status, 200);

  const session = await loginWeChat('metric_phone_user');
  const created = await api('/api/phone-card-orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '指标同学', phone: '15527111789', productId: 'prod_card_service_001' })
  });
  assert.equal(created.response.status, 201);
  const pending = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(pending.body.data.metrics.paidOrders, before.body.data.metrics.paidOrders);
  assert.equal(pending.body.data.metrics.pending, before.body.data.metrics.pending);

  await confirmPayment(created.body.paymentOrder.id, session.token);
  const paid = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(paid.body.data.metrics.paidOrders, before.body.data.metrics.paidOrders + 1);
  assert.equal(paid.body.data.metrics.pending, before.body.data.metrics.pending + 1);

  const refunded = await api(`/api/admin/payment-orders/${created.body.paymentOrder.id}/refund`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...adminHeaders },
    body: JSON.stringify({ note: 'metric refund' })
  });
  assert.equal(refunded.response.status, 200);
  const after = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(after.body.data.metrics.paidOrders, before.body.data.metrics.paidOrders);
  assert.equal(after.body.data.metrics.pending, before.body.data.metrics.pending);
});

test('admin after-sale closure refunds paid orders and notifies users', async () => {
  const session = await loginWeChat('refund_after_sale');
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  await confirmPayment(created.body.paymentOrder.id, session.token);
  const beforeStock = await api('/api/products/prod_ebike_001');

  const afterSale = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ orderId: created.body.data.id, type: 'REFUND', reason: '不想要了' })
  });
  assert.equal(afterSale.response.status, 201);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const closed = await api(`/api/admin/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '已核实订单问题并完成退款' })
  });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.body.data.status, 'CLOSED');

  const order = await api(`/api/orders/${created.body.data.id}`, {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(order.body.data.status, 'CANCELLED');
  assert.equal(order.body.data.paymentStatus, 'REFUNDED');

  const afterStock = await api('/api/products/prod_ebike_001');
  assert.equal(afterStock.body.data.stock, beforeStock.body.data.stock + 1);

  const notifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.ok(notifications.body.data.some((item) => item.type === 'ORDER' && item.title === '订单已退款'));
});

test('merchant workspace receives operational notifications and metrics', async () => {
  const userSession = await loginWeChat('merchant_notify_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantHeaders = { authorization: `Bearer ${merchantLogin.body.data.token}` };

  const before = await api('/api/merchant/notifications', { headers: merchantHeaders });
  assert.equal(before.response.status, 200);

  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  await confirmPayment(created.body.paymentOrder.id, userSession.token);

  const afterSale = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ orderId: created.body.data.id, type: 'REPAIR', reason: '刹车需要调试' })
  });
  assert.equal(afterSale.response.status, 201);

  const userMessage = await api('/api/order-collab', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ role: 'USER', orderId: created.body.data.id, action: 'NOTE', note: '请尽量晚上七点后配送' })
  });
  assert.equal(userMessage.response.status, 200);

  const notifications = await api('/api/merchant/notifications', { headers: merchantHeaders });
  assert.ok(notifications.body.data.some((item) => item.title === '新订单已支付'));
  assert.ok(notifications.body.data.some((item) => item.title === '收到新的售后申请'));
  assert.ok(notifications.body.data.some((item) => item.content === '请尽量晚上七点后配送'));
  assert.ok(notifications.body.unreadCount > before.body.unreadCount);

  const overview = await api('/api/merchant/overview', { headers: merchantHeaders });
  assert.equal(overview.body.data.metrics.afterSaleCount > 0, true);
  assert.ok(overview.body.data.orders.some((order) => order.id === created.body.data.id && order.status === 'AFTER_SALE'));

  await api('/api/merchant/notifications/read', { method: 'POST', headers: merchantHeaders });
  const readNotifications = await api('/api/merchant/notifications', { headers: merchantHeaders });
  assert.equal(readNotifications.body.unreadCount, 0);
});

test('after-sale evidence and merchant resolution note are persisted', async () => {
  const session = await loginWeChat('after_sale_evidence_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { authorization: `Bearer ${merchantLogin.body.data.token}` };

  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(order.response.status, 201);
  const paid = await confirmPayment(order.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);

  const upload = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify(makeImage())
  });
  assert.equal(upload.response.status, 201);
  const evidenceUrl = upload.body.data.url;

  const created = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      orderId: order.body.data.id,
      type: 'REPAIR',
      reason: '车辆交付后无法正常启动',
      images: [evidenceUrl]
    })
  });
  assert.equal(created.response.status, 201);
  assert.deepEqual(created.body.data.images, [evidenceUrl]);

  const foreign = await api(`/api/after-sales/${created.body.data.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ images: ['https://example.com/fake.jpg'] })
  });
  assert.equal(foreign.response.status, 400);
  assert.equal(foreign.body.error.code, 'VALIDATION_ERROR');

  const materials = await api(`/api/after-sales/${created.body.data.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ images: [evidenceUrl] })
  });
  assert.equal(materials.response.status, 200);
  assert.equal(materials.body.data.images.length, 2);

  const missingNote = await api(`/api/merchant/after-sales/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'CLOSED' })
  });
  assert.equal(missingNote.response.status, 400);
  assert.equal(missingNote.body.error.code, 'VALIDATION_ERROR');

  const closed = await api(`/api/merchant/after-sales/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '已上门检修并完成试车' })
  });
  assert.equal(closed.response.status, 200);
  assert.equal(closed.body.data.status, 'CLOSED');
  assert.equal(closed.body.data.resolutionNote, '已上门检修并完成试车');

  const forbiddenMaterials = await api(`/api/after-sales/${created.body.data.id}/materials`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ images: [evidenceUrl] })
  });
  assert.equal(forbiddenMaterials.response.status, 409);

  const notifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.ok(notifications.body.data.some((item) => item.type === 'AFTER_SALE' && item.title === '售后处理完成' && item.content === '已上门检修并完成试车'));
});

test('external plate applications require paid service fee and support refunds', async () => {
  const session = await loginWeChat('external_plate_user');
  const created = await api('/api/plate-applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ customerName: '外部车上牌同学', customerPhone: '15527111396', studentNo: '2026101234567', vehicleModel: '自有通勤车' })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.status, 'PENDING_PAYMENT');
  assert.equal(created.body.data.paymentStatus, 'UNPAID');
  assert.equal(created.body.data.studentNo, '2026101234567');
  assert.equal(created.body.paymentOrder.businessType, 'PLATE');
  assert.equal(created.body.paymentOrder.status, 'PENDING');

  const payment = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(payment.response.status, 200);
  assert.equal(payment.body.data.plateApplication.status, 'MATERIAL_PENDING');
  assert.equal(payment.body.data.plateApplication.paymentStatus, 'PAID');

  const upload = await api('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify(makeImage())
  });
  assert.equal(upload.response.status, 201);
  const materials = await api(`/api/plate-applications/${created.body.data.id}/materials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ images: [upload.body.data.url] })
  });
  assert.equal(materials.response.status, 200);
  assert.equal(materials.body.data.materials.length, 1);
  assert.equal(materials.body.data.materials[0].url, upload.body.data.url);

  const foreignMaterials = await api(`/api/plate-applications/${created.body.data.id}/materials`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ images: ['/api/uploads/not-existing.png'] })
  });
  assert.equal(foreignMaterials.response.status, 200);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.response.status, 200);
  const overviewBeforeRefund = await api('/api/admin/overview', {
    method: 'GET', headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  assert.ok(overviewBeforeRefund.body.data.financeEvents.find((event) => event.referenceId === `PAYMENT_${created.body.paymentOrder.id}`));

  const refunded = await api(`/api/admin/payment-orders/${created.body.paymentOrder.id}/refund`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ note: 'plate refund test' })
  });
  assert.equal(refunded.response.status, 200);
  assert.equal(refunded.body.data.plateApplication.status, 'REJECTED');
  assert.equal(refunded.body.data.plateApplication.paymentStatus, 'REFUNDED');
  const overviewAfterRefund = await api('/api/admin/overview', {
    method: 'GET', headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  assert.ok(overviewAfterRefund.body.data.financeEvents.find((event) => event.referenceId === `REFUND_${created.body.paymentOrder.id}`));
});

async function loginAdmin() {
  const result = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(result.response.status, 200);
  return { authorization: `Bearer ${result.body.data.token}`, 'content-type': 'application/json' };
}

async function createStockProduct(adminHeaders, name, stock) {
  const created = await api('/api/admin/products', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ name, category: 'E_BIKE_NEW', description: '库存占用回归测试专用车型', priceInCents: 100000, stock })
  });
  assert.equal(created.response.status, 201);
  return created.body.data.id;
}

test('pending orders reserve stock and release it on cancel or payment', async () => {
  const adminHeaders = await loginAdmin();
  const productId = await createStockProduct(adminHeaders, '库存占用测试车', 3);

  const initial = await api(`/api/products/${productId}`);
  assert.equal(initial.response.status, 200);
  assert.equal(initial.body.data.stock, 3);
  assert.equal(initial.body.data.availableStock, 3);
  assert.equal(initial.body.data.reservedStock, 0);

  const session = await loginWeChat('stock_hold_user');
  const held = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 2 }] })
  });
  assert.equal(held.response.status, 201);
  assert.ok(held.body.data.paymentExpiresAt);
  assert.equal(held.body.data.stockReservation, 'HELD');

  const reserved = await api(`/api/products/${productId}`);
  assert.equal(reserved.body.data.stock, 3);
  assert.equal(reserved.body.data.reservedStock, 2);
  assert.equal(reserved.body.data.availableStock, 1);

  const other = await loginWeChat('stock_rival_user');
  const blocked = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${other.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 2 }] })
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, 'INSUFFICIENT_STOCK');
  assert.ok(blocked.body.error.message.includes('可售库存不足'));

  const cancelled = await api(`/api/orders/${held.body.data.id}/cancel`, {
    method: 'POST', headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.data.stockReservation, 'RELEASED');

  const released = await api(`/api/products/${productId}`);
  assert.equal(released.body.data.stock, 3);
  assert.equal(released.body.data.reservedStock, 0);
  assert.equal(released.body.data.availableStock, 3);

  const paidOrder = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 2 }] })
  });
  assert.equal(paidOrder.response.status, 201);
  const paid = await confirmPayment(paidOrder.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);

  const consumed = await api(`/api/products/${productId}`);
  assert.equal(consumed.body.data.stock, 1);
  assert.equal(consumed.body.data.reservedStock, 0);
  assert.equal(consumed.body.data.availableStock, 1);
});

test('unpaid orders expire on the configured payment timeout and free the stock', async () => {
  const adminHeaders = await loginAdmin();

  const tooShort = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ paymentTimeoutMinutes: 4 })
  });
  assert.equal(tooShort.response.status, 400);
  const tooLongResolution = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ afterSaleResolutionHours: 200 })
  });
  assert.equal(tooLongResolution.response.status, 400);

  const configured = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ paymentTimeoutMinutes: 15, afterSaleResolutionHours: 48 })
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.data.paymentTimeoutMinutes, 15);
  assert.equal(configured.body.data.afterSaleResolutionHours, 48);

  const productId = await createStockProduct(adminHeaders, '超时释放测试车', 2);
  const session = await loginWeChat('stock_timeout_user');
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const expectedTimeout = new Date(created.body.data.paymentExpiresAt).getTime() - new Date(created.body.data.createdAt).getTime();
  assert.equal(expectedTimeout, 15 * 60 * 1000);

  const beforeSweep = await api(`/api/products/${productId}`);
  assert.equal(beforeSweep.body.data.availableStock, 1);

  store.update((data) => {
    const order = data.orders.find((item) => item.id === created.body.data.id);
    order.paymentExpiresAt = new Date(Date.now() - 60 * 1000).toISOString();
  });

  const afterSweep = await api(`/api/products/${productId}`);
  assert.equal(afterSweep.body.data.stock, 2);
  assert.equal(afterSweep.body.data.reservedStock, 0);
  assert.equal(afterSweep.body.data.availableStock, 2);

  const orders = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const expiredOrder = orders.body.data.ebikeOrders.find((item) => item.id === created.body.data.id);
  assert.equal(expiredOrder.status, 'CANCELLED');
  assert.equal(expiredOrder.paymentStatus, 'EXPIRED');
  assert.equal(expiredOrder.cancelReason, 'PAYMENT_TIMEOUT');
  assert.equal(expiredOrder.stockReservation, 'RELEASED');

  const notifications = await api('/api/my/notifications', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(notifications.body.data.some((item) => item.title === '订单已超时关闭'));

  const restored = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ paymentTimeoutMinutes: 30, afterSaleResolutionHours: 72 })
  });
  assert.equal(restored.response.status, 200);
});

test('after-sale freezes merchant settlement until the case is closed', async () => {
  const adminHeaders = await loginAdmin();

  const invalidPeriod = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ settlementPeriodDays: 61 })
  });
  assert.equal(invalidPeriod.response.status, 400);
  const zeroPeriod = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ settlementPeriodDays: 0 })
  });
  assert.equal(zeroPeriod.response.status, 200);
  assert.equal(zeroPeriod.body.data.settlementPeriodDays, 0);

  const ownerSession = await loginWeChat('freeze_merchant_owner');
  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({
      merchantType: 'INDIVIDUAL', name: '冻结测试车行', ownerName: '冻店主',
      phone: '15527110009', licenseNo: '92420111MAKMT4599R', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '售后冻结回归测试', licenseUrl: '/api/uploads/test-license.jpg',
      settlementAccountName: '冻店主', settlementBank: '校园演示银行', settlementAccount: '6222000000009999',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  const approved = await api(`/api/admin/merchants/${applied.body.data.id}/status`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'APPROVED', reviewNote: '资料齐全' })
  });
  assert.equal(approved.response.status, 200);

  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({ merchantId: applied.body.data.id })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const product = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '冻结测试通勤车', category: 'E_BIKE_NEW', description: '售后冻结回归', priceInCents: 100000, stock: 5 })
  });
  assert.equal(product.response.status, 201);

  const buyer = await loginWeChat('freeze_buyer');
  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId: product.body.data.id, quantity: 1 }] })
  });
  assert.equal(order.response.status, 201);
  await confirmPayment(order.body.paymentOrder.id, buyer.token);

  const detail = await api(`/api/orders/${order.body.data.id}`, { headers: { authorization: `Bearer ${buyer.token}` } });
  const completed = await api(`/api/merchant/orders/${order.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: detail.body.data.deliveryCode })
  });
  assert.equal(completed.response.status, 200);

  // 账期设为 0 天，交付核验通过后应直接可结算。
  const releasable = await api('/api/merchant/overview', { headers: merchantAuth });
  const settlementId = releasable.body.data.settlements[0].id;
  assert.equal(releasable.body.data.settlements[0].settlementStatus, 'PENDING_SETTLE');
  assert.equal(releasable.body.data.settlements[0].settlementPeriodDays, 0);
  assert.equal(releasable.body.data.metrics.settlementMetrics.payableInCents, 98000);

  const afterSale = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ orderId: order.body.data.id, type: 'REPAIR', reason: '刹车异响需要检修' })
  });
  assert.equal(afterSale.response.status, 201);

  const frozen = await api('/api/merchant/overview', { headers: merchantAuth });
  const frozenSettlement = frozen.body.data.settlements.find((item) => item.id === settlementId);
  assert.equal(frozenSettlement.settlementStatus, 'FROZEN');
  assert.ok(frozenSettlement.frozenReason.includes('刹车异响'));
  assert.equal(frozen.body.data.metrics.settlementMetrics.frozenInCents, 98000);
  assert.equal(frozen.body.data.metrics.settlementMetrics.payableInCents, 0);

  const blockedSettle = await api(`/api/admin/merchants/${applied.body.data.id}/settle`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ reference: 'TEST-FROZEN' })
  });
  assert.equal(blockedSettle.response.status, 409);
  assert.equal(blockedSettle.body.error.code, 'SETTLEMENT_NOT_RELEASED');
  assert.ok(blockedSettle.body.error.message.includes('售后冻结'));

  const closed = await api(`/api/merchant/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '已更换刹车片并复检通过' })
  });
  assert.equal(closed.response.status, 200);

  const unfrozen = await api('/api/merchant/overview', { headers: merchantAuth });
  const releasedSettlement = unfrozen.body.data.settlements.find((item) => item.id === settlementId);
  assert.equal(releasedSettlement.settlementStatus, 'PENDING_SETTLE');
  assert.equal(releasedSettlement.frozenReason, '');
  assert.equal(unfrozen.body.data.metrics.settlementMetrics.payableInCents, 98000);

  const payout = await api(`/api/admin/merchants/${applied.body.data.id}/settle`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ reference: 'TEST-UNFROZEN' })
  });
  assert.equal(payout.response.status, 200);
  assert.equal(payout.body.data.totalInCents, 98000);

  const restoredPeriod = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ settlementPeriodDays: 7 })
  });
  assert.equal(restoredPeriod.body.data.settlementPeriodDays, 7);
});

test('merchant payouts require a request that the platform reviews', async () => {
  const adminHeaders = await loginAdmin();

  const invalidMinimum = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ payoutMinimumInCents: 1000001 })
  });
  assert.equal(invalidMinimum.response.status, 400);
  const configured = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ settlementPeriodDays: 0, payoutMinimumInCents: 50000, commissionRatePercent: 2 })
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.data.payoutMinimumInCents, 50000);
  assert.equal(configured.body.data.commissionRatePercent, 2);

  const ownerSession = await loginWeChat('payout_merchant_owner');
  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({
      merchantType: 'INDIVIDUAL', name: '提现测试车行', ownerName: '提店主',
      phone: '15527110011', licenseNo: '92420111MAKMT4600R', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '提现流程回归测试', licenseUrl: '/api/uploads/test-license.jpg',
      settlementAccountName: '提店主', settlementBank: '校园演示银行', settlementAccount: '6222000000008888',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  const merchantId = applied.body.data.id;
  await api(`/api/admin/merchants/${merchantId}/status`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'APPROVED', reviewNote: '资料齐全' })
  });
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({ merchantId })
  });
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  // 分账还没到可结算阶段时申请提现应被拒绝并说明原因。
  const tooEarly = await api('/api/merchant/payout-requests', { method: 'POST', headers: merchantAuth, body: JSON.stringify({}) });
  assert.equal(tooEarly.response.status, 409);
  assert.equal(tooEarly.body.error.code, 'SETTLEMENT_NOT_RELEASED');

  const product = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '提现测试通勤车', category: 'E_BIKE_NEW', description: '提现流程回归', priceInCents: 40000, stock: 5 })
  });
  assert.equal(product.response.status, 201);

  const buyer = await loginWeChat('payout_buyer');
  async function payAndDeliver(quantity) {
    const order = await api('/api/orders', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
      body: JSON.stringify({ items: [{ productId: product.body.data.id, quantity }] })
    });
    assert.equal(order.response.status, 201);
    await confirmPayment(order.body.paymentOrder.id, buyer.token);
    const detail = await api(`/api/orders/${order.body.data.id}`, { headers: { authorization: `Bearer ${buyer.token}` } });
    const completed = await api(`/api/merchant/orders/${order.body.data.id}/status`, {
      method: 'POST', headers: merchantAuth,
      body: JSON.stringify({ status: 'COMPLETED', deliveryCode: detail.body.data.deliveryCode })
    });
    assert.equal(completed.response.status, 200);
    return order.body.data.id;
  }

  // 单笔 ¥400 扣 2% 服务费后是 ¥392，低于 ¥500 起提金额。
  const firstOrderId = await payAndDeliver(1);
  const belowMinimum = await api('/api/merchant/payout-requests', { method: 'POST', headers: merchantAuth, body: JSON.stringify({}) });
  assert.equal(belowMinimum.response.status, 409);
  assert.equal(belowMinimum.body.error.code, 'PAYOUT_BELOW_MINIMUM');

  await payAndDeliver(1);
  const beforeRequest = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(beforeRequest.body.data.metrics.settlementMetrics.payableInCents, 78400);
  assert.equal(beforeRequest.body.data.metrics.settlementMetrics.payoutMinimumInCents, 50000);
  assert.equal(beforeRequest.body.data.metrics.settlementMetrics.pendingPayoutRequest, null);

  const requested = await api('/api/merchant/payout-requests', {
    method: 'POST', headers: merchantAuth, body: JSON.stringify({ remark: '本周结算' })
  });
  assert.equal(requested.response.status, 201);
  assert.equal(requested.body.data.status, 'PENDING_REVIEW');
  assert.equal(requested.body.data.amountInCents, 78400);
  assert.equal(requested.body.data.settlementCount, 2);
  assert.equal(requested.body.data.accountMasked, '6222 **** 8888');
  const payoutRequestId = requested.body.data.id;

  const duplicated = await api('/api/merchant/payout-requests', { method: 'POST', headers: merchantAuth, body: JSON.stringify({}) });
  assert.equal(duplicated.response.status, 409);
  assert.equal(duplicated.body.error.code, 'PAYOUT_REQUEST_EXISTS');

  // 提现待审核期间平台不能绕过申请直接打款。
  const bypass = await api(`/api/admin/merchants/${merchantId}/settle`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ reference: 'TEST-BYPASS' })
  });
  assert.equal(bypass.response.status, 409);
  assert.equal(bypass.body.error.code, 'PAYOUT_REQUEST_PENDING');

  const requestedOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(requestedOverview.body.data.metrics.settlementMetrics.payableInCents, 0);
  assert.equal(requestedOverview.body.data.metrics.settlementMetrics.payoutRequestedInCents, 78400);
  assert.equal(requestedOverview.body.data.metrics.settlementMetrics.pendingPayoutRequest.id, payoutRequestId);
  assert.equal(requestedOverview.body.data.payoutRequests[0].requestNo, requested.body.data.requestNo);

  const rejected = await api(`/api/admin/payout-requests/${payoutRequestId}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'REJECT', reviewNote: '收款账户需要核对' })
  });
  assert.equal(rejected.response.status, 200);
  assert.equal(rejected.body.data.status, 'REJECTED');
  assert.equal(rejected.body.data.restoredSettlementCount, 2);

  const afterReject = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(afterReject.body.data.metrics.settlementMetrics.payableInCents, 78400);
  assert.equal(afterReject.body.data.metrics.settlementMetrics.payoutRequestedInCents, 0);
  assert.equal(afterReject.body.data.metrics.settlementMetrics.pendingPayoutRequest, null);

  const reopened = await api('/api/merchant/payout-requests', { method: 'POST', headers: merchantAuth, body: JSON.stringify({}) });
  assert.equal(reopened.response.status, 201);
  const reopenedId = reopened.body.data.id;

  const missingReference = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'APPROVE' })
  });
  assert.equal(missingReference.response.status, 400);

  const approved = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'APPROVE', reference: 'TEST-PAYOUT-REVIEW' })
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.status, 'SETTLED');
  assert.equal(approved.body.data.paidAmountInCents, 78400);

  const settledOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(settledOverview.body.data.metrics.settlementMetrics.settledInCents, 78400);
  assert.equal(settledOverview.body.data.metrics.settlementMetrics.payableInCents, 0);

  const closedAgain = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'APPROVE', reference: 'TEST-DOUBLE' })
  });
  assert.equal(closedAgain.response.status, 409);
  assert.equal(closedAgain.body.error.code, 'PAYOUT_REQUEST_CLOSED');

  const adminOverview = await api('/api/admin/overview', { headers: adminHeaders });
  const payoutEvent = adminOverview.body.data.financeEvents.find((event) => event.settlementReference === 'TEST-PAYOUT-REVIEW');
  assert.ok(payoutEvent);
  assert.equal(payoutEvent.amountInCents, -78400);
  assert.equal(payoutEvent.merchantId, merchantId);
  assert.ok((adminOverview.body.data.payoutRequests || []).some((item) => item.id === reopenedId));

  const restored = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ settlementPeriodDays: 7, payoutMinimumInCents: 10000 })
  });
  assert.equal(restored.body.data.payoutMinimumInCents, 10000);
  assert.ok(firstOrderId);
});

test('after-sale closes a pending payout request and returns the money to the balance', async () => {
  const adminHeaders = await loginAdmin();
  const configured = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ settlementPeriodDays: 0, payoutMinimumInCents: 0, commissionRatePercent: 2 })
  });
  assert.equal(configured.response.status, 200);

  const ownerSession = await loginWeChat('payout_freeze_owner');
  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({
      merchantType: 'INDIVIDUAL', name: '提现冻结车行', ownerName: '冻提店主',
      phone: '15527110012', licenseNo: '92420111MAKMT4601R', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '提现冻结回归测试', licenseUrl: '/api/uploads/test-license.jpg',
      settlementAccountName: '冻提店主', settlementBank: '校园演示银行', settlementAccount: '6222000000007777',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  const merchantId = applied.body.data.id;
  await api(`/api/admin/merchants/${merchantId}/status`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'APPROVED', reviewNote: '资料齐全' })
  });
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({ merchantId })
  });
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const product = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '提现冻结测试车', category: 'E_BIKE_NEW', description: '提现冻结回归', priceInCents: 60000, stock: 3 })
  });
  const buyer = await loginWeChat('payout_freeze_buyer');
  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId: product.body.data.id, quantity: 1 }] })
  });
  await confirmPayment(order.body.paymentOrder.id, buyer.token);
  const detail = await api(`/api/orders/${order.body.data.id}`, { headers: { authorization: `Bearer ${buyer.token}` } });
  await api(`/api/merchant/orders/${order.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: detail.body.data.deliveryCode })
  });

  const requested = await api('/api/merchant/payout-requests', { method: 'POST', headers: merchantAuth, body: JSON.stringify({}) });
  assert.equal(requested.response.status, 201);
  const payoutRequestId = requested.body.data.id;

  const afterSale = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ orderId: order.body.data.id, type: 'REPAIR', reason: '提车后发现仪表异常' })
  });
  assert.equal(afterSale.response.status, 201);

  const frozen = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(frozen.body.data.metrics.settlementMetrics.payoutRequestedInCents, 0);
  assert.equal(frozen.body.data.metrics.settlementMetrics.frozenInCents, 58800);
  assert.equal(frozen.body.data.metrics.settlementMetrics.pendingPayoutRequest, null);
  const cancelledRequest = frozen.body.data.payoutRequests.find((item) => item.id === payoutRequestId);
  assert.equal(cancelledRequest.status, 'CANCELLED');
  assert.ok(cancelledRequest.reviewNote.includes('售后'));

  const reviewClosed = await api(`/api/admin/payout-requests/${payoutRequestId}/review`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ decision: 'APPROVE', reference: 'TEST-CANCELLED' })
  });
  assert.equal(reviewClosed.response.status, 409);

  const closed = await api(`/api/merchant/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '已更换仪表并复检通过' })
  });
  assert.equal(closed.response.status, 200);

  const recovered = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(recovered.body.data.metrics.settlementMetrics.payableInCents, 58800);
  assert.equal(recovered.body.data.metrics.settlementMetrics.frozenInCents, 0);

  const reRequested = await api('/api/merchant/payout-requests', { method: 'POST', headers: merchantAuth, body: JSON.stringify({}) });
  assert.equal(reRequested.response.status, 201);
  assert.equal(reRequested.body.data.amountInCents, 58800);

  const restored = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ settlementPeriodDays: 7, payoutMinimumInCents: 10000 })
  });
  assert.equal(restored.response.status, 200);
});
