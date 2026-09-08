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
const sentSubscribeMessages = [];

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-test-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` }),
    wechatSubscribeSend: async (message) => {
      sentSubscribeMessages.push(message);
      return { errcode: 0, errmsg: 'ok' };
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

test('merchant overview exposes product sales and restock hints', async () => {
  const session = await loginWeChat('sales_metrics_buyer');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const product = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '销量口径演示品', category: 'DIGITAL', description: '用于核对商家销量', priceInCents: 1200, stock: 2 })
  });
  assert.equal(product.response.status, 201);

  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ userId: session.userId, items: [{ productId: product.body.data.id, quantity: 2 }] })
  });
  assert.equal(created.response.status, 201);
  const payment = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(payment.response.status, 200);

  const [merchantOverview, publicProducts] = await Promise.all([
    api('/api/merchant/overview', { headers: merchantAuth }),
    api('/api/products?campusId=campus_demo')
  ]);
  assert.equal(merchantOverview.response.status, 200);
  assert.ok(merchantOverview.body.data.products.every((item) => Number.isInteger(item.salesCount)));

  const merchantProduct = merchantOverview.body.data.products.find((item) => item.id === product.body.data.id);
  const publicProduct = publicProducts.body.data.find((item) => item.id === product.body.data.id);
  assert.equal(merchantProduct.salesCount, publicProduct.salesCount);
  assert.equal(merchantProduct.salesCount, 2);
  assert.equal(merchantProduct.restockHint, '热销·需补货');
  assert.ok('restockHint' in merchantProduct);
  assert.equal(typeof merchantProduct.restockHint, 'string');
});

test('merchant product campaigns use enforced sale pricing', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };
  const now = Date.now();
  const created = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({
      name: '商家限时特价品', category: 'DIGITAL', description: '商家自配促销', priceInCents: 1800, stock: 3,
      salePriceInCents: 1200,
      saleStartsAt: new Date(now - 3600 * 1000).toISOString(),
      saleEndsAt: new Date(now + 3600 * 1000).toISOString()
    })
  });
  assert.equal(created.response.status, 201);
  const productId = created.body.data.id;

  const overview = await api('/api/merchant/overview', { headers: merchantAuth });
  const merchantProduct = overview.body.data.products.find((item) => item.id === productId);
  assert.equal(merchantProduct.effectivePriceInCents, 1200);
  assert.equal(merchantProduct.promotion.originalPriceInCents, 1800);
  assert.equal(merchantProduct.promotion.statusText, '限时直降');

  const invalidSale = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ salePriceInCents: 1800, saleStartsAt: new Date(now - 3600 * 1000).toISOString(), saleEndsAt: new Date(now + 3600 * 1000).toISOString() })
  });
  assert.equal(invalidSale.response.status, 400);
  assert.equal(invalidSale.body.error.code, 'VALIDATION_ERROR');

  const updated = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({
      salePriceInCents: 1500,
      saleStartsAt: new Date(now + 24 * 3600 * 1000).toISOString(),
      saleEndsAt: new Date(now + 48 * 3600 * 1000).toISOString()
    })
  });
  assert.equal(updated.response.status, 200);
  const refreshed = await api('/api/merchant/overview', { headers: merchantAuth });
  const scheduledProduct = refreshed.body.data.products.find((item) => item.id === productId);
  assert.equal(scheduledProduct.effectivePriceInCents, 1800);
  assert.equal(scheduledProduct.promotion, null);
});

test('product list supports commerce sorting and sales metrics', async () => {
  const rating = await api('/api/products?campusId=campus_demo&sort=rating');
  assert.equal(rating.response.status, 200);
  assert.ok(rating.body.data.every((item) => Number.isInteger(item.salesCount)));
  assert.equal(rating.body.data[0].id, 'prod_ebike_001');
  assert.ok(rating.body.data[0].ratingSummary.average >= 4);

  const price = await api('/api/products?campusId=campus_demo&sort=price_asc');
  assert.equal(price.response.status, 200);
  const prices = price.body.data.map((item) => item.priceInCents);
  assert.deepEqual(prices, [...prices].sort((a, b) => a - b));

  const invalid = await api('/api/products?campusId=campus_demo&sort=bad_sort');
  assert.equal(invalid.response.status, 400);
  assert.equal(invalid.body.error.code, 'VALIDATION_ERROR');
});

test('stock movements record inventory truth across lifecycle', async () => {
  const session = await loginWeChat('stock_ledger_user');
  const admin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(admin.response.status, 200);
  const adminAuth = { 'content-type': 'application/json', authorization: `Bearer ${admin.body.data.token}` };

  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const created = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({
      name: '台账测试车', category: 'E_BIKE_NEW', description: '库存流水验证',
      priceInCents: 199900, stock: 5, active: true
    })
  });
  assert.equal(created.response.status, 201);
  const productId = created.body.data.id;

  const initialOverview = await api('/api/admin/overview', { headers: adminAuth });
  assert.equal(initialOverview.response.status, 200);
  assert.ok(Array.isArray(initialOverview.body.data.stockMovements));
  const initial = initialOverview.body.data.stockMovements[0];
  assert.equal(initial.productId, productId);
  assert.equal(initial.movementType, 'INITIAL');
  assert.equal(initial.stockBefore, 0);
  assert.equal(initial.stockAfter, 5);

  const restocked = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ stock: 8 })
  });
  assert.equal(restocked.response.status, 200);
  const restockOverview = await api('/api/admin/overview', { headers: adminAuth });
  const restock = restockOverview.body.data.stockMovements[0];
  assert.equal(restock.movementType, 'ADJUST_IN');
  assert.equal(restock.quantity, 3);
  assert.equal(restock.stockBefore, 5);
  assert.equal(restock.stockAfter, 8);

  const productBefore = await api(`/api/products/${productId}`);
  const stockBefore = productBefore.body.data.stock;
  const reservedBefore = productBefore.body.data.reservedStock;

  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 2 }] })
  });
  assert.equal(order.response.status, 201);
  const reserveOverview = await api('/api/admin/overview', { headers: adminAuth });
  const reserve = reserveOverview.body.data.stockMovements[0];
  assert.equal(reserve.movementType, 'RESERVE');
  assert.equal(reserve.quantity, 2);
  assert.equal(reserve.stockBefore, stockBefore);
  assert.equal(reserve.stockAfter, stockBefore);
  assert.equal(reserve.reservedBefore, reservedBefore);
  assert.equal(reserve.reservedAfter, reservedBefore + 2);
  assert.equal(reserve.referenceNo, order.body.data.orderNo);

  const paid = await confirmPayment(order.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);
  const consumeOverview = await api('/api/admin/overview', { headers: adminAuth });
  const consume = consumeOverview.body.data.stockMovements[0];
  assert.equal(consume.movementType, 'CONSUME');
  assert.equal(consume.quantity, 2);
  assert.equal(consume.stockBefore, stockBefore);
  assert.equal(consume.stockAfter, stockBefore - 2);
  assert.equal(consume.reservedAfter, reservedBefore);

  const refund = await api(`/api/admin/payment-orders/${order.body.paymentOrder.id}/refund`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ note: '库存流水退款验证' })
  });
  assert.equal(refund.response.status, 200);
  const restoreOverview = await api('/api/admin/overview', { headers: adminAuth });
  const restore = restoreOverview.body.data.stockMovements[0];
  assert.equal(restore.movementType, 'RESTORE');
  assert.equal(restore.quantity, 2);
  assert.equal(restore.stockBefore, stockBefore - 2);
  assert.equal(restore.stockAfter, stockBefore);

  const merchantLedger = await api(`/api/merchant/stock-movements?productId=${productId}`, { headers: merchantAuth });
  assert.equal(merchantLedger.response.status, 200);
  assert.equal(merchantLedger.body.total, 5);
  assert.ok(merchantLedger.body.data.every((item) => item.merchantId === 'merchant_001'));
  assert.equal(merchantLedger.body.data[0].movementType, 'RESTORE');
  assert.ok(merchantLedger.body.data.some((item) => item.movementType === 'INITIAL'));

  const consumedLedger = await api(`/api/merchant/stock-movements?productId=${productId}&type=CONSUME`, { headers: merchantAuth });
  assert.equal(consumedLedger.response.status, 200);
  assert.equal(consumedLedger.body.total, 1);
  assert.equal(consumedLedger.body.data[0].referenceNo, order.body.data.orderNo);

  const invalidType = await api(`/api/merchant/stock-movements?productId=${productId}&type=BAD`, { headers: merchantAuth });
  assert.equal(invalidType.response.status, 400);
  assert.equal(invalidType.body.error.code, 'VALIDATION_ERROR');
});

test('active product detail exposes merchant and stock', async () => {
  const result = await api('/api/products/prod_ebike_001');
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.id, 'prod_ebike_001');
  assert.equal(result.body.data.merchantName, '狮山校园车行');
  assert.equal(typeof result.body.data.stock, 'number');
  assert.equal(result.body.data.ratingSummary.average, 4.5);
  assert.equal(result.body.data.ratingSummary.purchaseVerifiedCount, 2);
  assert.equal(result.body.data.ratingSummary.positiveCount, 2);
  assert.equal(result.body.data.ratingSummary.mediumNegativeCount, 0);
  assert.equal(result.body.data.ratingSummary.lowReplyRate, 1);
  assert.equal(result.body.data.reviews.length, 2);
  assert.ok(result.body.data.reviews.every((review) => review.purchaseVerified));
  assert.equal(result.body.data.settings.deliveryResponseHours, 24);
  assert.equal(result.body.data.storeProfile.name, '狮山校园车行');
  assert.equal(result.body.data.storeProfile.serviceArea, '华中农业大学狮山校区');
  assert.equal(typeof result.body.data.storeProfile.score, 'number');
  assert.equal(typeof result.body.data.storeProfile.soldCount, 'number');

  const missing = await api('/api/products/not_exists');
  assert.equal(missing.response.status, 404);
  assert.equal(missing.body.error.code, 'PRODUCT_NOT_FOUND');
});

test('public product surfaces always include the latest merchant service score', async () => {
  store.update((data) => {
    for (const merchant of data.merchants || []) delete merchant.serviceScore;
  });
  const freshDetail = await api('/api/products/prod_ebike_001');
  assert.equal(freshDetail.response.status, 200);
  assert.ok(freshDetail.body.data.merchantServiceScore, '直接打开详情也应即时计算店铺服务分');

  const list = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(list.response.status, 200);
  assert.ok(list.body.data.every((item) => item.merchantScore), '商品列表应展示店铺服务分');
  assert.ok(list.body.data.every((item) => Number.isInteger(item.merchantScore.score)));

  const detail = await api('/api/products/prod_ebike_001');
  assert.equal(detail.response.status, 200);
  assert.ok(detail.body.data.merchantServiceScore, '商品详情应展示店铺服务分');
  assert.equal(typeof detail.body.data.merchantServiceScore.score, 'number');
  assert.equal(detail.body.data.merchantServiceScore.stage, 'NORMAL');
});

test('admin can adjust service score and review a limited merchant product', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ phoneCardActivationHours: 31, afterSaleResponseHours: 25 })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };

  const scoreList = await api('/api/admin/merchant-scores', { headers: adminHeaders });
  assert.equal(scoreList.response.status, 200);
  const seeded = scoreList.body.data.find((item) => item.merchantId === 'merchant_001');
  assert.ok(seeded);
  assert.equal(seeded.stage, 'NORMAL');
  assert.equal(seeded.breakdown.length, 5);
  assert.ok(seeded.breakdown.some((item) => item.key === 'NEGATIVE_REVIEW'));

  const beforeReply = seeded.breakdown.find((item) => item.key === 'NEGATIVE_REVIEW');
  store.update((data) => {
    data.productReviews.unshift({
      id: 'review_service_score_negative', productId: 'prod_ebike_001', rating: 1,
      content: '服务分测试差评', customerName: '测试同学', purchaseVerified: true,
      visibility: 'PUBLISHED', reply: null, createdAt: new Date().toISOString()
    });
  });
  const afterNegative = await api('/api/admin/merchant-scores', { headers: adminHeaders });
  const negativeScore = afterNegative.body.data.find((item) => item.merchantId === 'merchant_001');
  assert.equal(negativeScore.breakdown.find((item) => item.key === 'NEGATIVE_REVIEW').score, 0);

  const merchantSessionForReply = await loginWeChat('merchant_demo');
  const merchantLoginForReply = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSessionForReply.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const reply = await api('/api/merchant/product-reviews/review_service_score_negative/reply', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLoginForReply.body.data.token}` },
    body: JSON.stringify({ content: '已联系并完成整改' })
  });
  assert.equal(reply.response.status, 200);
  const persistedAfterReply = store.read().merchants.find((item) => item.id === 'merchant_001');
  assert.equal(persistedAfterReply.serviceScore.breakdown.find((item) => item.key === 'NEGATIVE_REVIEW').score, 100);
  const afterReply = await api('/api/admin/merchant-scores', { headers: adminHeaders });
  const repliedScore = afterReply.body.data.find((item) => item.merchantId === 'merchant_001');
  assert.equal(repliedScore.breakdown.find((item) => item.key === 'NEGATIVE_REVIEW').score, 100);
  assert.equal(beforeReply.score, 100);

  const adjusted = await api('/api/admin/merchant-scores/merchant_001/adjust', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ adjustment: -20, reason: '模拟履约问题整改' })
  });
  assert.equal(adjusted.response.status, 200);
  assert.equal(adjusted.body.data.serviceScore.manualAdjustment, -20);
  assert.equal(adjusted.body.data.serviceScore.stage, 'LIMITED');

  // 把限流阈值临时提高到 100，验证商家上新会进入平台复核队列。
  const limitedSettings = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ serviceScoreLimitedThreshold: 100, serviceScoreRestrictedThreshold: 60 })
  });
  assert.equal(limitedSettings.response.status, 200);
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };
  await api('/api/merchant/overview', { headers: merchantHeaders });
  const pending = await api('/api/merchant/products', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ name: '服务分复核测试商品', category: 'LIFE_SERVICE', description: '平台复核流程测试', priceInCents: 1999, stock: 3 })
  });
  assert.equal(pending.response.status, 201);
  assert.equal(pending.body.data.publishReviewStatus, 'PENDING_REVIEW');
  assert.equal(pending.body.data.active, false);

  const reviewed = await api(`/api/admin/products/${pending.body.data.id}/publish-review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVED' })
  });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.data.publishReviewStatus, 'APPROVED');
  assert.equal(reviewed.body.data.active, true);

  const restored = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ serviceScoreLimitedThreshold: 80, serviceScoreRestrictedThreshold: 60 })
  });
  assert.equal(restored.response.status, 200);
  const resetAdjustment = await api('/api/admin/merchant-scores/merchant_001/adjust', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ adjustment: 0, reason: '测试数据恢复' })
  });
  assert.equal(resetAdjustment.response.status, 200);

  // 低分评价只服务本用例；不移除会触发后续自动下架风控，影响订单链路测试。
  store.update((data) => {
    data.productReviews = data.productReviews.filter((item) => item.id !== 'review_service_score_negative');
    const product = data.products.find((item) => item.id === 'prod_ebike_001');
    if (product) {
      product.active = true;
      delete product.autoDelistRule;
      delete product.autoDelistReason;
      delete product.autoDelistEvidence;
      delete product.autoDelistAt;
      delete product.autoDelistRestoredAt;
    }
  });
});

test('business rules configure public commitments and delivery fees', async () => {
  const config = await api('/api/business-config');
  assert.equal(config.response.status, 200);
  assert.equal(config.body.data.deliveryFeeInCents, 0);
  assert.equal(config.body.data.deliveryResponseHours, 24);
  assert.equal(config.body.data.externalPlateFeeInCents, 4900);
  assert.equal(config.body.data.leadResponseHours, 24);
  assert.equal(config.body.data.afterSaleResolutionHours, 72);
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
  const consultSession = await loginWeChat('consult_user');
  const leadCreated = await api('/api/leads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${consultSession.token}` },
    body: JSON.stringify({ name: '咨询同学', phone: '15527111003', businessType: 'E_BIKE', interest: '校园牌照辅助' })
  });
  assert.equal(leadCreated.response.status, 201);
  assert.equal(leadCreated.body.data.userId, 'wx_consult_user');
  const plateSession = await loginWeChat('plate_fee_user');
  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ externalPlateFeeInCents: 5900 })
  });
  const plateCreated = await api('/api/plate-applications', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${plateSession.token}` },
    body: JSON.stringify({ customerName: '牌照费同学', customerPhone: '15527111002', studentNo: '2026101234568', vehicleModel: '自带测试车' })
  });
  assert.equal(plateCreated.response.status, 201);
  assert.equal(plateCreated.body.data.feeInCents, 5900);
  assert.equal(plateCreated.body.paymentOrder.amountInCents, 5900);
  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({ externalPlateFeeInCents: 4900 })
  });
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      items: [{ productId: 'prod_ebike_001', quantity: 1 }],
      fulfillment: { type: 'DELIVERY', contactName: '费同学', contactPhone: '15527111001', address: '荟园1栋', date: new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10), timeSlot: '今天 12:00-14:00' }
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

test('admin settings changes are versioned with field differences', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = {
    'content-type': 'application/json',
    authorization: `Bearer ${adminLogin.body.data.token}`
  };

  const logsBefore = store.read().settingChangeLogs || [];
  const changed = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ commissionRatePercent: 3, payoutMinimumInCents: 20000 })
  });
  assert.equal(changed.response.status, 200);

  const unchanged = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ commissionRatePercent: 3, payoutMinimumInCents: 20000 })
  });
  assert.equal(unchanged.response.status, 200);

  const logs = store.read().settingChangeLogs || [];
  assert.equal(logs.length, logsBefore.length + 1);
  const log = logs[0];
  assert.equal(log.operator.username, process.env.ADMIN_USERNAME);
  assert.equal(log.changes.length, 2);
  assert.ok(log.changes.find((item) => item.field === 'commissionRatePercent' && item.before === 2 && item.after === 3));
  assert.ok(log.changes.find((item) => item.field === 'payoutMinimumInCents' && item.before === 10000 && item.after === 20000));
  assert.equal(log.snapshot.commissionRatePercent, 3);
  assert.equal(log.snapshot.payoutMinimumInCents, 20000);

  const overview = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(overview.response.status, 200);
  assert.equal(overview.body.data.settingChangeLogs.length, Math.min(logs.length, 20));
  assert.equal(overview.body.data.settingChangeLogs[0].id, log.id);
  assert.ok(overview.body.data.settingChangeLogs[0].snapshot);
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
  const afterSaleNotifications = await api('/api/my/notifications', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(afterSaleNotifications.body.data.some((item) => item.type === 'AFTER_SALE' && item.title === '售后已受理' && item.content.includes('25 小时内')));

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

  // 商家要能确认“这个月到底收了多少、平台扣了多少、已经打了多少”，不然运营容易扯皮。
  const statement = await api('/api/merchant/settlement-statement', { headers: merchantAuth });
  assert.equal(statement.response.status, 200);
  assert.equal(statement.body.data.settlements.length, 1);
  assert.equal(statement.body.data.settlements[0].status, 'SETTLED');
  assert.equal(statement.body.data.settlements[0].payableInCents, 2300);
  assert.equal(statement.body.data.totals.businessGrossInCents, 2500);
  assert.equal(statement.body.data.totals.commissionInCents, 200);
  assert.equal(statement.body.data.totals.payoutPaidInCents, 2300);
  assert.equal(statement.body.data.totals.netInCents, 0);

  const statementExport = await fetch(`${baseUrl}/api/merchant/settlement-statement/export`, {
    headers: merchantAuth
  });
  assert.equal(statementExport.status, 200);
  assert.equal(statementExport.headers.get('content-type'), 'text/csv; charset=utf-8');
  const statementBytes = new Uint8Array(await statementExport.arrayBuffer());
  assert.deepEqual([...statementBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const statementCsv = new TextDecoder('utf-8').decode(statementBytes);
  assert.ok(statementCsv.includes('收入分账'));
  assert.ok(statementCsv.includes('提现出账'));
  assert.ok(statementCsv.includes('TEST-PAYOUT-001'));
  assert.ok(statementCsv.includes('本月汇总'));

  const statementUnauthorized = await fetch(`${baseUrl}/api/merchant/settlement-statement`);
  assert.equal(statementUnauthorized.status, 401);
  const invalidStatementMonth = await api('/api/merchant/settlement-statement?month=202501', {
    headers: merchantAuth
  });
  assert.equal(invalidStatementMonth.response.status, 400);
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

test('rejected merchant can resubmit evidence for platform review', async () => {
  const session = await loginWeChat('merchant_resubmit');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 2)]);
  const upload = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ dataBase64: png.toString('base64'), mimeType: 'image/png' })
  });
  assert.equal(upload.response.status, 201);

  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      merchantType: 'INDIVIDUAL', name: '复审测试商铺', ownerName: '复审店主',
      phone: '15527110010', licenseNo: '92420111MAKMT4534R', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '资质驳回后复审闭环测试',
      licenseUrl: '/api/uploads/stale-license.jpg',
      settlementAccountName: '复审店主', settlementBank: '校园演示银行', settlementAccount: '6222000000001010',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  const merchantId = applied.body.data.id;

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const rejected = await api(`/api/admin/merchants/${merchantId}/status`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ status: 'REJECTED', reviewNote: '营业执照图片不清晰，请补充新执照' })
  });
  assert.equal(rejected.response.status, 200);

  const missingEvidence = await api(`/api/merchants/${merchantId}/resubmit`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ settlementAccountName: '复审店主' })
  });
  assert.equal(missingEvidence.response.status, 400);

  const resubmitted = await api(`/api/merchants/${merchantId}/resubmit`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      licenseNo: '92420111MAKMT4534R',
      licenseUrl: upload.body.data.url,
      settlementAccountName: '复审店主',
      settlementBank: '校园演示银行',
      settlementAccount: '6222000000001010',
      note: '已上传新营业执照'
    })
  });
  assert.equal(resubmitted.response.status, 200);
  assert.equal(resubmitted.body.data.status, 'REVIEWING');
  assert.equal(resubmitted.body.data.licenseUrl, upload.body.data.url);
  assert.equal(resubmitted.body.data.reviewNote, '商家已补充资质，等待平台复审');
  assert.equal(resubmitted.body.data.timeline.at(-1).status, 'REVIEWING');
  assert.ok(resubmitted.body.data.timeline.at(-1).note.includes('复审'));

  const repeatedResubmit = await api(`/api/merchants/${merchantId}/resubmit`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ licenseNo: '92420111MAKMT4534R', licenseUrl: upload.body.data.url })
  });
  assert.equal(repeatedResubmit.response.status, 409);
  assert.equal(repeatedResubmit.body.error.code, 'MERCHANT_NOT_REJECTED');

  const approved = await api(`/api/admin/merchants/${merchantId}/status`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ status: 'APPROVED', reviewNote: '新执照已复核' })
  });
  assert.equal(approved.response.status, 200);
  const owned = await api('/api/merchants', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(owned.response.status, 200);
  assert.equal(owned.body.data[0].status, 'APPROVED');
  assert.equal(owned.body.data[0].licenseUrl, upload.body.data.url);
  assert.equal(owned.body.data[0].timeline.at(-1).status, 'APPROVED');
});

test('approved merchants can renew qualifications for platform review', async () => {
  const session = await loginWeChat('merchant_renewal');
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(2048, 3)]);
  const upload = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ dataBase64: png.toString('base64'), mimeType: 'image/png' })
  });
  assert.equal(upload.response.status, 201);

  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      merchantType: 'INDIVIDUAL', name: '资质到期测试店', ownerName: '到期店主',
      phone: '15527110011', licenseNo: '92420111MAKMT4535S', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '资质到期复审测试',
      licenseUrl: '/api/uploads/current-license.jpg', licenseExpireDate: '2027-12-31',
      settlementAccountName: '到期店主', settlementBank: '校园演示银行', settlementAccount: '6222000000001111',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  assert.equal(applied.body.data.licenseExpireDate, '2027-12-31');

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const approved = await api(`/api/admin/merchants/${applied.body.data.id}/status`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ status: 'APPROVED', reviewNote: '资质有效期已核对' })
  });
  assert.equal(approved.response.status, 200);

  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ merchantId: applied.body.data.id })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const missingDate = await api('/api/merchant/qualification-renewals', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ licenseNo: '92420111MAKMT4535S', licenseUrl: upload.body.data.url })
  });
  assert.equal(missingDate.response.status, 400);

  const invalidDate = await api('/api/merchant/qualification-renewals', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ licenseNo: '92420111MAKMT4535S', licenseUrl: upload.body.data.url, licenseExpireDate: '2027-13-01' })
  });
  assert.equal(invalidDate.response.status, 400);

  const externalImage = await api('/api/merchant/qualification-renewals', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ licenseNo: '92420111MAKMT4535S', licenseUrl: 'https://example.com/license.png', licenseExpireDate: '2027-12-31' })
  });
  assert.equal(externalImage.response.status, 400);

  const renewal = await api('/api/merchant/qualification-renewals', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({
      licenseNo: '92420111MAKMT4535S', licenseUrl: upload.body.data.url,
      licenseExpireDate: '2028-12-31', note: '新执照已上传'
    })
  });
  assert.equal(renewal.response.status, 201);
  assert.equal(renewal.body.data.status, 'PENDING_REVIEW');
  assert.equal(renewal.body.data.licenseExpireDate, '2028-12-31');

  const overview = await api('/api/merchant/overview', { headers: merchantHeaders });
  assert.equal(overview.body.data.qualificationRenewals.length, 1);
  assert.equal(overview.body.data.qualificationRenewals[0].status, 'PENDING_REVIEW');

  const adminOverview = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(adminOverview.body.data.qualificationRenewals.length, 1);
  assert.equal(adminOverview.body.data.qualificationRenewals[0].id, renewal.body.data.id);

  const duplicate = await api('/api/merchant/qualification-renewals', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ licenseNo: '92420111MAKMT4535S', licenseUrl: upload.body.data.url, licenseExpireDate: '2028-12-31' })
  });
  assert.equal(duplicate.response.status, 409);
  assert.equal(duplicate.body.error.code, 'QUALIFICATION_RENEWAL_EXISTS');

  const adminList = await api('/api/admin/qualification-renewals', { headers: adminHeaders });
  assert.equal(adminList.response.status, 200);
  const pendingRenewal = adminList.body.data.find((item) => item.id === renewal.body.data.id);
  assert.ok(pendingRenewal);

  const reviewed = await api(`/api/admin/qualification-renewals/${renewal.body.data.id}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', reviewNote: '新执照有效期已核对' })
  });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.data.status, 'APPROVED');
  const refreshed = await api('/api/merchant/overview', { headers: merchantHeaders });
  assert.equal(refreshed.body.data.merchant.licenseExpireDate, '2028-12-31');
  assert.equal(refreshed.body.data.qualificationRenewals[0].status, 'APPROVED');
});

test('qualification expiry enters operations patrol before the license lapses', async () => {
  const session = await loginWeChat('merchant_expiry');
  const applied = await api('/api/merchants', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      merchantType: 'INDIVIDUAL', name: '快到期商家', ownerName: '快到期店主',
      phone: '15527110012', licenseNo: '92420111MAKMT4536T', category: 'LIFE_SERVICE',
      serviceArea: '狮山校区', description: '资质到期巡检测试',
      licenseUrl: '/api/uploads/expiring-license.jpg', licenseExpireDate: '2027-01-01',
      settlementAccountName: '快到期店主', settlementBank: '校园演示银行', settlementAccount: '6222000000001212',
      agreeAgreement: true, agreePrivacy: true
    })
  });
  assert.equal(applied.response.status, 201);
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  await api(`/api/admin/merchants/${applied.body.data.id}/status`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ status: 'APPROVED', reviewNote: '资质已核对' })
  });

  const expiredDate = new Date(Date.now() + 25 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  store.update((data) => {
    const merchant = data.merchants.find((item) => item.id === applied.body.data.id);
    merchant.licenseExpireDate = expiredDate;
  });

  const patrol = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(patrol.response.status, 200);
  const alerts = await api('/api/admin/sla-alerts', { headers: adminHeaders });
  const alert = alerts.body.data.find((item) => item.ruleKey === 'MERCHANT_QUALIFICATION' && item.businessId === applied.body.data.id);
  assert.ok(alert, '快到期资质应生成商家提醒');
  assert.equal(alert.ownerRole, 'MERCHANT');
  assert.equal(alert.merchantId, applied.body.data.id);
  assert.ok(alert.detail.includes(expiredDate));
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

  const consult = await api('/api/order-collab', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ role: 'USER', orderId: recordId, action: 'NOTE', note: '实名审核需要多久？' })
  });
  assert.equal(consult.response.status, 200);
  assert.equal(consult.body.data.collaboration.messages[0].role, 'USER');
  assert.equal(consult.body.data.collaboration.messages[0].text, '实名审核需要多久？');

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

  const spoofed = await api('/api/order-collab', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${companionSession.token}` },
    body: JSON.stringify({ role: 'USER', orderId: recordId, action: 'NOTE', note: '尝试操作别人的服务单' })
  });
  assert.equal(spoofed.response.status, 403);
  const adminActivate = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminActivate.response.status, 200);
  const adminOverview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminActivate.body.data.token}` }
  });
  const adminServiceRecord = adminOverview.body.data.phoneCardOrders.find((item) => item.id === recordId);
  assert.equal(adminServiceRecord.collaboration.messages[0].text, '实名审核需要多久？');
  await api(`/api/admin/phone-card-orders/${created.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminActivate.body.data.token}` },
    body: JSON.stringify({ status: 'ACTIVATED' })
  });
  await api(`/api/admin/phone-card-orders/${companionCard.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminActivate.body.data.token}` },
    body: JSON.stringify({ status: 'ACTIVATED' })
  });
  const platformReply = await api('/api/order-collab', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminActivate.body.data.token}` },
    body: JSON.stringify({ role: 'PLATFORM', orderId: recordId, action: 'NOTE', note: '实名审核一般 24 小时内完成。' })
  });
  assert.equal(platformReply.response.status, 200);
  assert.equal(platformReply.body.data.collaboration.messages[0].role, 'PLATFORM');

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
    body:JSON.stringify({ role:'USER', action:'APPEAL', orderId, note:'配送时间需要改成明天上午。' })
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

  const userNotifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(userNotifications.response.status, 200);
  const replyNotice = userNotifications.body.data.find((item) => item.title === '你的评价收到了商家回复');
  assert.ok(replyNotice, '商家回复后应通知评价作者');
  assert.ok(replyNotice.content.includes('评价测试车'));
  assert.ok(replyNotice.content.includes('感谢反馈，我们会持续检查车辆与配送服务。'));

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

test('admin order control preserves delivery verification and stock truth', async () => {
  const session = await loginWeChat('admin_order_control');
  const product = await api('/api/products/prod_ebike_001');
  assert.equal(product.response.status, 200);
  const stockBefore = product.body.data.availableStock;

  const order = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(order.response.status, 201);

  const admin = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(admin.response.status, 200);
  const adminAuth = { 'content-type': 'application/json', authorization: `Bearer ${admin.body.data.token}` };

  const cancelled = await api(`/api/admin/orders/${order.body.data.id}/status`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ status: 'CANCELLED' })
  });
  assert.equal(cancelled.response.status, 200);
  assert.equal(cancelled.body.data.status, 'CANCELLED');
  assert.equal(cancelled.body.data.paymentStatus, 'UNPAID');
  assert.equal(cancelled.body.data.stockReservation, 'RELEASED');
  assert.equal(cancelled.body.data.collaboration.handoffs[0].role, 'PLATFORM');

  const afterCancel = await api('/api/products/prod_ebike_001');
  assert.equal(afterCancel.response.status, 200);
  assert.equal(afterCancel.body.data.availableStock, stockBefore);

  const replay = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(replay.response.status, 201);
  await confirmPayment(replay.body.paymentOrder.id, session.token);

  const manualPaid = await api(`/api/admin/orders/${replay.body.data.id}/status`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ status: 'PAID' })
  });
  assert.equal(manualPaid.response.status, 409);

  const insufficientNote = await api(`/api/admin/orders/${replay.body.data.id}/status`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ status: 'COMPLETED', completionNote: '太短' })
  });
  assert.equal(insufficientNote.response.status, 400);

  const proxyCompleted = await api(`/api/admin/orders/${replay.body.data.id}/status`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({ status: 'COMPLETED', completionNote: '平台线下核验，已确认学生收车并核对车辆编号' })
  });
  assert.equal(proxyCompleted.response.status, 200);
  assert.equal(proxyCompleted.body.data.status, 'COMPLETED');
  assert.equal(proxyCompleted.body.data.collaboration.handoffs[0].role, 'PLATFORM');
  assert.ok(proxyCompleted.body.data.collaboration.handoffs[0].note.includes('平台代履约完成'));
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
  const cardNotifications = await api('/api/my/notifications', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(cardNotifications.body.data.some((item) => item.type === 'PHONE_PLAN' && item.title === '电话卡支付成功' && item.content.includes('31 小时内')));
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

test('limited recharge promos enforce availability windows and expose linked orders', async () => {
  const now = Date.now();
  store.update((data) => {
    data.rechargePromos ||= [];
    data.rechargePromos.unshift({
      id: 'promo_recharge_windowed',
      pay: 100,
      receive: 150,
      badge: '开学期限定',
      active: true,
      startsAt: new Date(now - 24 * 3600 * 1000).toISOString(),
      endsAt: new Date(now + 24 * 3600 * 1000).toISOString()
    });
  });

  const activeList = await api('/api/recharge-promos');
  const activePromo = activeList.body.data.find((item) => item.id === 'promo_recharge_windowed');
  assert.equal(activePromo.status, 'ACTIVE');
  assert.equal(activePromo.statusLabel, '进行中');
  assert.equal(activePromo.linkedOrderCount, 0);

  const session = await loginWeChat('promo_window_buyer');
  const created = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527111444', promoId: 'promo_recharge_windowed' })
  });
  assert.equal(created.response.status, 201);
  const confirmed = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(confirmed.response.status, 200);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const overview = await api('/api/admin/overview', { headers: { authorization: `Bearer ${adminLogin.body.data.token}` } });
  const promo = overview.body.data.rechargePromos.find((item) => item.id === 'promo_recharge_windowed');
  assert.equal(promo.status, 'ACTIVE');
  assert.equal(promo.linkedOrderCount, 1);
  assert.ok(promo.linkedPaidOrderCount >= 1);

  store.update((data) => {
    const item = data.rechargePromos.find((entry) => entry.id === 'promo_recharge_windowed');
    item.startsAt = new Date(now + 2 * 24 * 3600 * 1000).toISOString();
    item.endsAt = new Date(now + 3 * 24 * 3600 * 1000).toISOString();
  });
  const scheduledList = await api('/api/recharge-promos');
  assert.equal(scheduledList.body.data.some((item) => item.id === 'promo_recharge_windowed'), false);

  const scheduledOrder = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527111444', promoId: 'promo_recharge_windowed' })
  });
  assert.equal(scheduledOrder.response.status, 404);

  store.update((data) => {
    const item = data.rechargePromos.find((entry) => entry.id === 'promo_recharge_windowed');
    item.startsAt = new Date(now - 72 * 3600 * 1000).toISOString();
    item.endsAt = new Date(now - 48 * 3600 * 1000).toISOString();
  });
  const endedOrder = await api('/api/recharge-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ phone: '15527111444', promoId: 'promo_recharge_windowed' })
  });
  assert.equal(endedOrder.response.status, 404);

  const adminUpdated = await api('/api/admin/recharge-promos', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` },
    body: JSON.stringify({
      id: 'promo_recharge_windowed',
      payInCents: 10000,
      receiveInCents: 15000,
      badge: '开学期限定',
      active: true,
      startsAt: new Date(now + 72 * 3600 * 1000).toISOString(),
      endsAt: new Date(now + 96 * 3600 * 1000).toISOString()
    })
  });
  assert.equal(adminUpdated.response.status, 201);
  assert.equal(new Date(adminUpdated.body.data.startsAt).getTime(), now + 72 * 3600 * 1000);
  assert.equal(new Date(adminUpdated.body.data.endsAt).getTime(), now + 96 * 3600 * 1000);
});

test('product sale campaigns use server-calculated promotion prices', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };
  const product = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '开学季特价车', category: 'E_BIKE_NEW', description: '校园限时直降', priceInCents: 239900, stock: 2 })
  });
  assert.equal(product.response.status, 201);
  const productId = product.body.data.id;

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.response.status, 200);
  const adminAuth = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const now = Date.now();
  const updated = await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      salePriceInCents: 189900,
      saleStartsAt: new Date(now - 3600 * 1000).toISOString(),
      saleEndsAt: new Date(now + 24 * 3600 * 1000).toISOString()
    })
  });
  assert.equal(updated.response.status, 200);

  const [list, detail] = await Promise.all([
    api('/api/products?campusId=campus_demo'),
    api(`/api/products/${productId}`)
  ]);
  const listedProduct = list.body.data.find((item) => item.id === productId);
  assert.equal(listedProduct.effectivePriceInCents, 189900);
  assert.equal(listedProduct.promotion.originalPriceInCents, 239900);
  assert.equal(listedProduct.promotion.statusText, '限时直降');
  assert.equal(detail.body.data.effectivePriceInCents, 189900);
  assert.equal(detail.body.data.promotion.originalPriceInCents, 239900);

  const session = await loginWeChat('sale_campaign_buyer');
  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 1 }] })
  });
  assert.equal(order.response.status, 201);
  assert.equal(order.body.data.totalInCents, 189900);
  const payment = await confirmPayment(order.body.paymentOrder.id, session.token);
  assert.equal(payment.response.status, 200);

  const orderDetail = await api(`/api/orders/${order.body.data.id}`, { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(orderDetail.body.data.totalInCents, 189900);
  assert.equal(orderDetail.body.data.items[0].priceInCents, 189900);
  assert.equal(orderDetail.body.data.items[0].originalPriceInCents, 239900);

  const merchantOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  const settlement = merchantOverview.body.data.settlements.find((item) => item.orderId === order.body.data.id);
  assert.equal(settlement.amountInCents, 189900);

  await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      salePriceInCents: 189900,
      saleStartsAt: new Date(now + 24 * 3600 * 1000).toISOString(),
      saleEndsAt: new Date(now + 48 * 3600 * 1000).toISOString()
    })
  });
  const scheduled = await api(`/api/products/${productId}`);
  assert.equal(scheduled.body.data.effectivePriceInCents, 239900);
  assert.equal(scheduled.body.data.promotion, null);

  await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: adminAuth,
    body: JSON.stringify({
      salePriceInCents: 189900,
      saleStartsAt: new Date(now - 48 * 3600 * 1000).toISOString(),
      saleEndsAt: new Date(now - 24 * 3600 * 1000).toISOString()
    })
  });
  const ended = await api(`/api/products/${productId}`);
  assert.equal(ended.body.data.effectivePriceInCents, 239900);
  assert.equal(ended.body.data.promotion, null);
});

test('product campaigns expose operational promotion metrics', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };
  const now = Date.now();
  const activeWindow = {
    saleStartsAt: new Date(now - 3600 * 1000).toISOString(),
    saleEndsAt: new Date(now + 24 * 3600 * 1000).toISOString()
  };
  const campaignProduct = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '复盘演示商品', category: 'DIGITAL', description: '促销成效核对', priceInCents: 2000, stock: 10, salePriceInCents: 1600, ...activeWindow })
  });
  assert.equal(campaignProduct.response.status, 201);
  const productId = campaignProduct.body.data.id;

  const buyer = await loginWeChat('campaign_metrics_buyer');
  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId, quantity: 2 }] })
  });
  assert.equal(order.response.status, 201);
  assert.equal((await confirmPayment(order.body.paymentOrder.id, buyer.token)).response.status, 200);

  const phoneProduct = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '复盘演示套餐', category: 'PHONE_PLAN', description: '促销套餐成效核对', priceInCents: 3000, stock: 10, salePriceInCents: 2400, ...activeWindow })
  });
  assert.equal(phoneProduct.response.status, 201);
  const phoneOrder = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ productId: phoneProduct.body.data.id, customerName: '测试同学', phone: '13800001234' })
  });
  assert.equal(phoneOrder.response.status, 201);
  assert.equal(phoneOrder.body.data.amountInCents, 2400);
  assert.equal((await confirmPayment(phoneOrder.body.paymentOrder.id, buyer.token)).response.status, 200);

  const [merchantOverview, adminOverview] = await Promise.all([
    api('/api/merchant/overview', { headers: merchantAuth }),
    api('/api/admin/overview', { headers: { authorization: `Bearer ${(await api('/api/admin/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
    })).body.data.token}` } })
  ]);
  assert.equal(merchantOverview.response.status, 200);
  assert.equal(adminOverview.response.status, 200);
  const merchantProduct = merchantOverview.body.data.products.find((item) => item.id === productId);
  const adminProduct = adminOverview.body.data.products.find((item) => item.id === productId);
  assert.equal(merchantProduct.promotionSummary, undefined);
  assert.equal(adminProduct.promotionSummary, undefined);
  assert.equal(merchantProduct.campaignOrderCount, 1);
  assert.equal(adminProduct.campaignOrderCount, 1);
  assert.equal(adminProduct.campaignSalesQuantity, 2);
  assert.equal(adminProduct.campaignAmountInCents, 3200);
  assert.equal(adminProduct.campaignDiscountInCents, 800);
  assert.equal(adminProduct.campaignStatus, 'ACTIVE');
  const adminPhone = adminOverview.body.data.products.find((item) => item.id === phoneProduct.body.data.id);
  assert.equal(adminPhone.campaignOrderCount, 1);
  assert.equal(adminPhone.campaignAmountInCents, 2400);
  assert.ok(adminOverview.body.data.promotionSummary.some((item) => item.id === productId));
  assert.ok(merchantOverview.body.data.promotionSummary.some((item) => item.id === productId));
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

test('admin overview includes a seven day operations report', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const overview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  assert.equal(overview.response.status, 200);
  const report = overview.body.data.operationsReport;
  assert.equal(report.reports.length, 7);
  assert.equal(report.reports[0].date, new Date().toISOString().slice(0, 10));
  assert.ok(report.totals.ebikeOrders >= 1);
  assert.ok(report.totals.paymentInCents > 0);
  assert.equal(typeof report.totals.autoDelists, 'number');
  assert.equal(typeof report.totals.complianceRestores, 'number');
});

test('operations report provides trends and csv export', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.response.status, 200);
  const overview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  const insights = overview.body.data.operationsInsights;
  assert.equal(insights.reports.length, 14);
  assert.equal(insights.current.reports.length, 7);
  assert.equal(insights.previous.reports.length, 7);
  assert.ok(insights.comparisons.some((item) => item.key === 'paymentInCents'));
  assert.ok(insights.comparisons.some((item) => item.key === 'autoDelists'));
  assert.ok(insights.comparisons.some((item) => item.key === 'scoreStageChanges'));
  assert.ok(insights.comparisons.some((item) => item.key === 'rectifyCasesCreated'));
  const autoDelistComparison = insights.comparisons.find((item) => item.key === 'autoDelists');
  const stageComparison = insights.comparisons.find((item) => item.key === 'scoreStageChanges');
  const rectifyComparison = insights.comparisons.find((item) => item.key === 'rectifyCasesCreated');
  assert.equal(autoDelistComparison.current, insights.current.totals.autoDelists);
  assert.equal(stageComparison.current, insights.current.totals.scoreStageChanges);
  assert.equal(rectifyComparison.current, insights.current.totals.rectifyCasesCreated);
  const totalOrdersComparison = insights.comparisons.find((item) => item.key === 'totalOrders');
  assert.equal(totalOrdersComparison.current, insights.current.totals.ebikeOrders
    + insights.current.totals.phoneCardOrders
    + insights.current.totals.rechargeOrders
    + insights.current.totals.plateApplications);
  assert.ok(Array.isArray(insights.alerts));

  const riskLogIds = [];
  const riskCaseIds = [];
  store.update((data) => {
    data.merchantScoreLogs = data.merchantScoreLogs || [];
    data.serviceScoreCases = data.serviceScoreCases || [];
    for (let index = 0; index < 3; index += 1) {
      const id = `log_operations_alert_${index}`;
      riskLogIds.push(id);
      data.merchantScoreLogs.unshift({ id, type: 'AUTO_DELIST', createdAt: new Date().toISOString() });
    }
    const stageLogId = 'log_operations_stage_change';
    riskLogIds.push(stageLogId);
    data.merchantScoreLogs.unshift({ id: stageLogId, type: 'STAGE_CHANGE', createdAt: new Date().toISOString() });
    const caseId = 'case_operations_alert_open';
    riskCaseIds.push(caseId);
    data.serviceScoreCases.unshift({ id: caseId, type: 'RECTIFY', status: 'OPEN', createdAt: new Date().toISOString() });
  });
  const riskOverview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  const riskAlerts = riskOverview.body.data.operationsInsights.alerts || [];
  assert.ok(riskAlerts.some((item) => item.level === 'HIGH' && item.message.includes('自动下架')));
  assert.ok(riskAlerts.some((item) => item.message.includes('整改工单')));
  assert.ok(riskAlerts.some((item) => item.message.includes('分档变化')));
  assert.ok(riskOverview.body.data.operationsReport.totals.scoreStageChanges >= 1);
  store.update((data) => {
    data.merchantScoreLogs = (data.merchantScoreLogs || []).filter((item) => !riskLogIds.includes(item.id));
    data.serviceScoreCases = (data.serviceScoreCases || []).filter((item) => !riskCaseIds.includes(item.id));
  });

  const exportResponse = await fetch(`${baseUrl}/api/admin/operations-report/export`, {
    headers: { authorization: `Bearer ${adminLogin.body.data.token}` }
  });
  assert.equal(exportResponse.status, 200);
  assert.equal(exportResponse.headers.get('content-type'), 'text/csv; charset=utf-8');
  const exportBytes = new Uint8Array(await exportResponse.arrayBuffer());
  assert.deepEqual([...exportBytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const csv = new TextDecoder('utf-8').decode(exportBytes);
  assert.ok(csv.includes('日期,电瓶车订单,电话卡订单,话费权益,牌照申请'));
  assert.ok(csv.includes('自动下架,恢复上架,服务分分档变化,整改工单,整改通过'));
  assert.ok(csv.includes('近14天合计'));

  const unauthorized = await fetch(`${baseUrl}/api/admin/operations-report/export`);
  assert.equal(unauthorized.status, 401);
});

test('merchant workspace receives operational notifications and metrics', async () => {
  const userSession = await loginWeChat('merchant_notify_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const complianceConfig = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      productComplianceLowReviewThreshold: 2,
      productComplianceReviewSampleThreshold: 2,
      productComplianceAverageRatingThreshold: 4
    })
  });
  assert.equal(complianceConfig.response.status, 200);
  assert.equal(complianceConfig.body.data.productComplianceLowReviewThreshold, 2);
  assert.equal(complianceConfig.body.data.productComplianceAverageRatingThreshold, 4);

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

test('after-sale progress is returned with order history', async () => {
  const session = await loginWeChat('after_sale_progress_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(order.response.status, 201);
  const paid = await confirmPayment(order.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);

  const before = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const beforeOrder = before.body.data.ebikeOrders.find((item) => item.id === order.body.data.id);
  assert.equal(beforeOrder.afterSales.length, 0);
  assert.equal(before.body.data.afterSalesSummary.activeCount, 0);

  const created = await api('/api/after-sales', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ orderId: order.body.data.id, type: 'REPAIR', reason: '刹车有异响需要检修' })
  });
  assert.equal(created.response.status, 201);

  const active = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const activeOrder = active.body.data.ebikeOrders.find((item) => item.id === order.body.data.id);
  assert.equal(activeOrder.status, 'AFTER_SALE');
  assert.equal(activeOrder.afterSales.length, 1);
  assert.equal(activeOrder.afterSales[0].typeLabel, '维修');
  assert.equal(activeOrder.afterSales[0].statusLabel, '待处理');
  assert.equal(activeOrder.afterSales[0].responseDueAt, created.body.data.responseDueAt);
  assert.equal(active.body.data.afterSalesSummary.activeCount, 1);

  const reviewing = await api(`/api/merchant/after-sales/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'REVIEWING' })
  });
  assert.equal(reviewing.response.status, 200);

  const progressing = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const progressingOrder = progressing.body.data.ebikeOrders.find((item) => item.id === order.body.data.id);
  assert.equal(progressingOrder.afterSales[0].statusLabel, '处理中');

  const closed = await api(`/api/merchant/after-sales/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '已调整刹车并完成试车' })
  });
  assert.equal(closed.response.status, 200);

  const completed = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  const completedOrder = completed.body.data.ebikeOrders.find((item) => item.id === order.body.data.id);
  assert.equal(completedOrder.status, 'COMPLETED');
  assert.equal(completedOrder.afterSales[0].statusLabel, '已完成');
  assert.equal(completedOrder.afterSales[0].resolutionNote, '已调整刹车并完成试车');
  assert.equal(completed.body.data.afterSalesSummary.activeCount, 0);
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

test('pending service payments expire and block confirmation', async () => {
  const session = await loginWeChat('service_timeout_user');
  const card = await api('/api/phone-card-orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ productId: 'prod_card_service_001', customerName: '超时同学', phone: '13800001111' })
  });
  assert.equal(card.response.status, 201);
  assert.ok(card.body.data.paymentExpiresAt);

  const recharge = await api('/api/recharge-orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ promoId: 'promo_recharge_100', phone: '13800001111' })
  });
  assert.equal(recharge.response.status, 201);
  assert.ok(recharge.body.data.paymentExpiresAt);

  const plate = await api('/api/plate-applications', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      customerName: '超时同学', customerPhone: '13800001111',
      studentNo: '202600001', vehicleModel: '自带车辆'
    })
  });
  assert.equal(plate.response.status, 201);
  assert.ok(plate.body.data.paymentExpiresAt);

  const expiredAt = new Date(Date.now() - 60 * 1000).toISOString();
  store.update((data) => {
    const records = [
      ...(data.phoneCardOrders || []),
      ...(data.rechargeOrders || []),
      ...(data.plateApplications || [])
    ].filter((item) => item.userId === session.userId && item.status === 'PENDING_PAYMENT');
    records.forEach((item) => { item.paymentExpiresAt = expiredAt; });
  });

  const blockedCard = await confirmPayment(card.body.paymentOrder.id, session.token);
  assert.equal(blockedCard.response.status, 409);

  const orders = await api('/api/my/orders', { headers: { authorization: `Bearer ${session.token}` } });
  assert.equal(orders.response.status, 200);
  for (const record of orders.body.data.serviceRecords) {
    if (!['PHONE_PLAN', 'RECHARGE', 'PLATE'].includes(record.type)) continue;
    assert.equal(record.status, 'CANCELLED');
    assert.equal(record.paymentStatus, 'EXPIRED');
    assert.equal(record.cancelReason, 'PAYMENT_TIMEOUT');
  }

  const notifications = await api('/api/my/notifications', { headers: { authorization: `Bearer ${session.token}` } });
  assert.ok(notifications.body.data.some((item) => item.title === '电话卡订单已超时关闭'));
  assert.ok(notifications.body.data.some((item) => item.title === '话费权益订单已超时关闭'));
  assert.ok(notifications.body.data.some((item) => item.title === '校园牌照申请已超时关闭'));

  const adminOverview = await api('/api/admin/overview', { headers: await loginAdmin() });
  assert.equal(adminOverview.response.status, 200);
  assert.ok(adminOverview.body.data.metrics.paymentTimeouts >= 3);
  assert.ok(adminOverview.body.data.operationsReport.totals.paymentTimeouts >= 3);
  assert.ok(adminOverview.body.data.operationsInsights.comparisons.some((item) => item.key === 'paymentTimeouts'));
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

  const missingReceipt = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', reference: 'TEST-PAYOUT-REVIEW' })
  });
  assert.equal(missingReceipt.response.status, 400);
  assert.equal(missingReceipt.body.error.code, 'PAYOUT_RECEIPT_REQUIRED');

  const receiptImageBase64 = Buffer.concat([
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAoAAAAKCAYAAAC6MsUuAAAAFklEQVR42mNk+M9QDwADhgGAWjR9awAAAAD//2Nk+M9QDwADhgGAWjR9aw==', 'base64'),
    Buffer.alloc(2048)
  ]).toString('base64');

  const upload = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerSession.token}` },
    body: JSON.stringify({
      dataBase64: receiptImageBase64,
      mimeType: 'image/png'
    })
  });
  assert.equal(upload.response.status, 201);

  const financeLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(financeLogin.response.status, 200);
  const financeHeaders = { 'content-type': 'application/json', authorization: `Bearer ${financeLogin.body.data.token}` };
  const adminUpload = await api('/api/admin/uploads', {
    method: 'POST', headers: financeHeaders,
    body: JSON.stringify({
      dataBase64: receiptImageBase64,
      mimeType: 'image/png'
    })
  });
  assert.equal(adminUpload.response.status, 201);
  assert.match(adminUpload.body.data.url, /^\/api\/admin\/uploads\/[\w-]+\.png$/);

  const invalidReceipt = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      decision: 'APPROVE', reference: 'TEST-PAYOUT-REVIEW',
      receiptUrl: upload.body.data.url
    })
  });
  assert.equal(invalidReceipt.response.status, 400);
  assert.equal(invalidReceipt.body.error.code, 'PAYOUT_RECEIPT_INVALID');

  const missingFileReceipt = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      decision: 'APPROVE', reference: 'TEST-PAYOUT-REVIEW',
      receiptUrl: '/api/admin/uploads/not-exist.png'
    })
  });
  assert.equal(missingFileReceipt.response.status, 400);
  assert.equal(missingFileReceipt.body.error.code, 'PAYOUT_RECEIPT_INVALID');

  const approved = await api(`/api/admin/payout-requests/${reopenedId}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', reference: 'TEST-PAYOUT-REVIEW', receiptUrl: adminUpload.body.data.url })
  });
  assert.equal(approved.response.status, 200);
  assert.equal(approved.body.data.status, 'SETTLED');
  assert.equal(approved.body.data.paidAmountInCents, 78400);
  assert.equal(approved.body.data.receiptUrl, adminUpload.body.data.url);

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
  assert.equal(payoutEvent.settlementReference, 'TEST-PAYOUT-REVIEW');
  assert.equal(payoutEvent.receiptUrl, adminUpload.body.data.url);
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

test('operations patrol raises overdue alerts and closes them when work moves on', async () => {
  const adminHeaders = await loginAdmin();
  const configured = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ deliveryResponseHours: 2, phoneCardActivationHours: 2, patrolIntervalMinutes: 1, slaWarningTemplateId: 'wx_test_sla_warning' })
  });
  assert.equal(configured.response.status, 200);

  const buyer = await loginWeChat('patrol_buyer');
  const order = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(order.response.status, 201);
  await confirmPayment(order.body.paymentOrder.id, buyer.token);

  const card = await api('/api/phone-card-orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ productId: 'prod_card_service_001', customerName: '巡检同学', phone: '15527112233' })
  });
  assert.equal(card.response.status, 201);
  await confirmPayment(card.body.paymentOrder.id, buyer.token);

  // 把两笔业务的时间往前拨，模拟真实世界里已经拖过承诺时限的单子。
  const staleAt = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  store.update((data) => {
    const paidOrder = data.orders.find((item) => item.id === order.body.data.id);
    paidOrder.paidAt = staleAt;
    paidOrder.updatedAt = staleAt;
    const phoneCard = data.phoneCardOrders.find((item) => item.id === card.body.data.id);
    phoneCard.updatedAt = staleAt;
    data.patrolState = { lastRunAt: '', runCount: 0, lastCreated: 0, lastResolved: 0, lastOpen: 0 };
  });

  const firstRun = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(firstRun.response.status, 200);
  assert.ok(firstRun.body.data.created >= 2);
  assert.ok(firstRun.body.data.patrolState.lastRunAt);

  const alerts = await api('/api/admin/sla-alerts', { headers: adminHeaders });
  assert.equal(alerts.response.status, 200);
  const deliveryAlert = alerts.body.data.find((item) => item.ruleKey === 'ORDER_DELIVERY' && item.businessId === order.body.data.id);
  assert.ok(deliveryAlert, '应生成电瓶车履约超时预警');
  assert.equal(deliveryAlert.level, 'OVERDUE');
  assert.equal(deliveryAlert.ownerRole, 'MERCHANT');
  assert.equal(deliveryAlert.merchantId, 'merchant_001');
  assert.ok(deliveryAlert.overdueMinutes >= 60);
  const cardAlert = alerts.body.data.find((item) => item.ruleKey === 'PHONE_ACTIVATION' && item.businessId === card.body.data.id);
  assert.ok(cardAlert, '应生成电话卡激活超时预警');
  assert.equal(cardAlert.ownerRole, 'PLATFORM');
  assert.ok(alerts.body.summary.overdueCount >= 2);

  // 责任商家应在自己的工作台看到属于自己的预警，且看不到平台内部事项。
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const merchantSubscription = await api('/api/merchant/message-subscriptions', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ accepted: true })
  });
  assert.equal(merchantSubscription.response.status, 200);
  assert.equal(merchantSubscription.body.data.subscribed, true);

  // 商家开启订阅后，新产生的履约预警应进入微信订阅消息队列，而不只留在站内通知。
  const subscribeBuyer = await loginWeChat('patrol_subscribe_buyer');
  const subscribeOrder = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${subscribeBuyer.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_rent_001', quantity: 1 }] })
  });
  assert.equal(subscribeOrder.response.status, 201);
  await confirmPayment(subscribeOrder.body.paymentOrder.id, subscribeBuyer.token);
  const subscribeStaleAt = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
  store.update((data) => {
    const paidOrder = data.orders.find((item) => item.id === subscribeOrder.body.data.id);
    paidOrder.paidAt = subscribeStaleAt;
    paidOrder.updatedAt = subscribeStaleAt;
  });
  const subscribeRun = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(subscribeRun.response.status, 200);
  const slaQueued = (store.read().subscribeMessages || [])
    .find((item) => item.templateId === 'sla_warning' && item.status === 'QUEUED'
      && item.title === '履约已超时');
  assert.ok(slaQueued);
  const subscribeDetail = await api(`/api/orders/${subscribeOrder.body.data.id}`, { headers: { authorization: `Bearer ${subscribeBuyer.token}` } });
  await api(`/api/merchant/orders/${subscribeOrder.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...merchantHeaders },
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: subscribeDetail.body.data.deliveryCode })
  });

  const complianceConfig = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      productComplianceLowReviewThreshold: 2,
      productComplianceReviewSampleThreshold: 2,
      productComplianceAverageRatingThreshold: 4
    })
  });
  assert.equal(complianceConfig.response.status, 200);
  assert.equal(complianceConfig.body.data.productComplianceLowReviewThreshold, 2);
  assert.equal(complianceConfig.body.data.productComplianceAverageRatingThreshold, 4);

  const templateConfig = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      productAutoDelistTemplateId: 'wx_test_product_delist',
      productComplianceRestoredTemplateId: 'wx_test_product_restore',
      slaWarningTemplateId: 'wx_test_sla_warning'
    })
  });
  assert.equal(templateConfig.response.status, 200);
  assert.equal(templateConfig.body.data.productAutoDelistTemplateId, 'wx_test_product_delist');
  assert.equal(templateConfig.body.data.productComplianceRestoredTemplateId, 'wx_test_product_restore');
  const merchantOverview = await api('/api/merchant/overview', { headers: merchantHeaders });
  assert.ok(merchantOverview.body.data.slaAlerts.some((item) => item.businessId === order.body.data.id));
  assert.ok(merchantOverview.body.data.slaAlerts.every((item) => item.ownerRole === 'MERCHANT'));
  assert.ok(merchantOverview.body.data.metrics.slaOverdueCount >= 1);
  const merchantNotifications = await api('/api/merchant/notifications', { headers: merchantHeaders });
  assert.ok(merchantNotifications.body.data.some((item) => item.type === 'SLA' && item.title === '履约已超时'));

  // 重复巡检不应重复开单。
  const secondRun = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(secondRun.body.data.created, 0);

  const acknowledged = await api(`/api/admin/sla-alerts/${deliveryAlert.id}/acknowledge`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ note: '已电话联系商家，今晚完成配送' })
  });
  assert.equal(acknowledged.response.status, 200);
  assert.equal(acknowledged.body.data.status, 'ACKNOWLEDGED');
  assert.equal(acknowledged.body.data.acknowledgeNote, '已电话联系商家，今晚完成配送');

  const emptyNote = await api(`/api/admin/sla-alerts/${cardAlert.id}/acknowledge`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ note: '' })
  });
  assert.equal(emptyNote.response.status, 400);

  // 业务推进到下一环节后，预警应自动关闭。
  const detail = await api(`/api/orders/${order.body.data.id}`, { headers: { authorization: `Bearer ${buyer.token}` } });
  await api(`/api/merchant/orders/${order.body.data.id}/status`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...merchantHeaders },
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: detail.body.data.deliveryCode })
  });
  await api(`/api/admin/phone-card-orders/${card.body.data.id}/status`, {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ status: 'ACTIVATED' })
  });
  const thirdRun = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.ok(thirdRun.body.data.resolved >= 2);

  const afterResolve = await api('/api/admin/sla-alerts', { headers: adminHeaders });
  const closedDelivery = afterResolve.body.data.find((item) => item.id === deliveryAlert.id);
  assert.equal(closedDelivery.status, 'RESOLVED');
  assert.ok(closedDelivery.resolvedAt);
  assert.ok(closedDelivery.resolvedReason.length > 0);

  const resolvedOnly = await api('/api/admin/sla-alerts?status=RESOLVED', { headers: adminHeaders });
  assert.ok(resolvedOnly.body.data.every((item) => item.status === 'RESOLVED'));

  const overview = await api('/api/admin/overview', { headers: adminHeaders });
  assert.equal(typeof overview.body.data.slaSummary.openCount, 'number');
  assert.ok(overview.body.data.patrolState.runCount >= 3);

  const invalidInterval = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ patrolIntervalMinutes: 0 })
  });
  assert.equal(invalidInterval.response.status, 400);

  const restored = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ deliveryResponseHours: 24, phoneCardActivationHours: 24, patrolIntervalMinutes: 10 })
  });
  assert.equal(restored.response.status, 200);
});

test('patrol closes expired pending payments without user traffic', async () => {
  const adminHeaders = await loginAdmin();
  const buyer = await loginWeChat('patrol_timeout_buyer');
  // 先把历史测试留下的待支付单统一置为过期，便于验证巡检能清空全部库存预占。
  store.update((data) => {
    const expiredAt = new Date(Date.now() - 60 * 1000).toISOString();
    for (const order of data.orders || []) {
      if (order.status === 'PENDING_PAYMENT') order.paymentExpiresAt = expiredAt;
    }
  });
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const productBefore = store.read().products.find((item) => item.id === 'prod_ebike_001');
  assert.equal(productBefore.reservedStock, 1);

  store.update((data) => {
    const order = data.orders.find((item) => item.id === created.body.data.id);
    order.paymentExpiresAt = new Date(Date.now() - 60 * 1000).toISOString();
  });

  const patrol = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(patrol.response.status, 200);
  assert.ok(patrol.body.data.expiredOrders.includes(created.body.data.orderNo));
  assert.ok(patrol.body.data.patrolState.lastExpiredOrders >= 1);

  const state = store.read();
  const order = state.orders.find((item) => item.id === created.body.data.id);
  assert.equal(order.status, 'CANCELLED');
  assert.equal(order.paymentStatus, 'EXPIRED');
  assert.equal(order.cancelReason, 'PAYMENT_TIMEOUT');
  assert.equal(state.products.find((item) => item.id === 'prod_ebike_001').reservedStock, 0);
  assert.equal(state.paymentOrders.find((item) => item.id === created.body.data.paymentOrderId).status, 'CANCELLED');
});

test('patrol releases matured settlements without dashboard traffic', async () => {
  const adminHeaders = await loginAdmin();
  const buyer = await loginWeChat('patrol_settlement_buyer');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_rent_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  await confirmPayment(created.body.paymentOrder.id, buyer.token);
  const detail = await api(`/api/orders/${created.body.data.id}`, { headers: { authorization: `Bearer ${buyer.token}` } });
  const fulfilled = await api(`/api/merchant/orders/${created.body.data.id}/status`, {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: detail.body.data.deliveryCode })
  });
  assert.equal(fulfilled.response.status, 200);

  const maturedIds = store.update((data) => {
    const expiredAt = new Date(Date.now() - 60 * 1000).toISOString();
    for (const settlement of data.settlements || []) {
      if (settlement.orderId === created.body.data.id) settlement.availableAt = expiredAt;
    }
    return (data.settlements || [])
      .filter((item) => item.orderId === created.body.data.id)
      .map((item) => item.id);
  });
  assert.ok(maturedIds.length >= 1);

  const patrol = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(patrol.response.status, 200);
  assert.equal(patrol.body.data.maturedSettlements.length, maturedIds.length);
  assert.equal(patrol.body.data.patrolState.lastMaturedSettlements, maturedIds.length);

  const state = store.read();
  for (const id of maturedIds) {
    const settlement = state.settlements.find((item) => item.id === id);
    assert.equal(settlement.settlementStatus, 'PENDING_SETTLE');
  }
});

test('service score cases support appeal review, rectification and subscription queue', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const resetSubscription = await api('/api/merchant/message-subscriptions', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ accepted: false })
  });
  assert.equal(resetSubscription.response.status, 200);

  const subscriptionBefore = await api('/api/merchant/message-subscriptions', { headers: merchantHeaders });
  assert.equal(subscriptionBefore.response.status, 200);
  assert.equal(subscriptionBefore.body.data.subscribed, false);

  const subscribeNotice = await api('/api/merchant/message-subscriptions', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ accepted: true })
  });
  assert.equal(subscribeNotice.response.status, 200);
  assert.equal(subscribeNotice.body.data.subscribed, true);

  const appeal = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({
      type: 'APPEAL',
      reasonType: 'REMOVED_NEGATIVE_REVIEW',
      reason: '这条差评来自未完成交易的账号，已有平台沟通记录。',
      requestedAdjustment: 3
    })
  });
  assert.equal(appeal.response.status, 201);
  assert.equal(appeal.body.data.status, 'SUBMITTED');
  assert.equal(appeal.body.data.reasonTypeLabel, '差评记录有误');

  const duplicate = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'APPEAL', reasonType: 'DELAYED_DELIVERY', reason: '重复提交应被拒绝。' })
  });
  assert.equal(duplicate.response.status, 409);

  const merchantCases = await api('/api/merchant/score-cases', { headers: merchantHeaders });
  assert.ok(merchantCases.body.data.some((item) => item.id === appeal.body.data.id));

  const evidenceUpload = await api('/api/uploads', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify(makeImage())
  });
  assert.equal(evidenceUpload.response.status, 201);
  const badEvidence = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'APPEAL', reasonType: 'DELAYED_DELIVERY', reason: '外部图片链接必须被拒绝。', evidence: ['https://example.com/fake.png'] })
  });
  assert.equal(badEvidence.response.status, 400);
  const duplicateCase = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'APPEAL', reasonType: 'DELAYED_DELIVERY', reason: '当前已有工单，仅验证携带凭证提交被拦截。', evidence: [evidenceUpload.body.data.url] })
  });
  assert.equal(duplicateCase.response.status, 409);
  assert.equal(merchantCases.body.data.find((item) => item.id === appeal.body.data.id).evidence.length, 0);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  store.update((data) => {
    const overdueCase = (data.serviceScoreCases || []).find((item) => item.id === appeal.body.data.id);
    overdueCase.createdAt = new Date(Date.now() - 49 * 3600 * 1000).toISOString();
    overdueCase.dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  });
  const patrolBeforeReview = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(patrolBeforeReview.response.status, 200);
  const overdueScoreAlert = (store.read().slaAlerts || []).find((alert) => alert.ruleKey === 'SCORE_APPEAL_REVIEW' && alert.businessId === appeal.body.data.id);
  assert.ok(overdueScoreAlert);
  assert.equal(overdueScoreAlert.status, 'OPEN');

  const adminOverview = await api('/api/admin/overview', { headers: adminHeaders });
  assert.ok(adminOverview.body.data.serviceScoreCases.some((item) => item.id === appeal.body.data.id));

  const invalidAdjustment = await api(`/api/admin/score-cases/${appeal.body.data.id}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', note: '证据核实通过', adjustment: 25 })
  });
  assert.equal(invalidAdjustment.response.status, 400);

  const reviewed = await api(`/api/admin/score-cases/${appeal.body.data.id}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', note: '证据核实通过', adjustment: 3 })
  });
  assert.equal(reviewed.response.status, 200);
  assert.equal(reviewed.body.data.status, 'COMPLETED');
  assert.equal(reviewed.body.data.appliedAdjustment, 3);

  const patrolAfterReview = await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  assert.equal(patrolAfterReview.response.status, 200);
  const resolvedScoreAlert = (store.read().slaAlerts || []).find((alert) => alert.ruleKey === 'SCORE_APPEAL_REVIEW' && alert.businessId === appeal.body.data.id);
  assert.equal(resolvedScoreAlert.status, 'RESOLVED');

  const merchantAfterAppeal = await api('/api/merchant/overview', { headers: merchantHeaders });
  assert.equal(merchantAfterAppeal.body.data.serviceScore.appealAdjustment, 3);

  store.update((data) => {
    const product = data.products.find((item) => item.id === 'prod_ebike_001');
    product.active = false;
    product.autoDelistRule = 'LOW_QUALITY';
  });

  const rectify = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({
      type: 'RECTIFY',
      reason: '48 小时内清空超时工单，并完成售后回访。',
      plan: '指定值班人员，每日检查履约预警。',
      productId: 'prod_ebike_001',
      evidence: [evidenceUpload.body.data.url]
    })
  });
  assert.equal(rectify.response.status, 201);
  assert.equal(rectify.body.data.productId, 'prod_ebike_001');
  assert.equal(rectify.body.data.productName, store.read().products.find((item) => item.id === 'prod_ebike_001').name);
  assert.deepEqual(rectify.body.data.evidence, [evidenceUpload.body.data.url]);
  const productAfterSubmission = store.read().products.find((item) => item.id === 'prod_ebike_001');
  assert.equal(productAfterSubmission.autoDelistStatus, 'REVIEW_PENDING');
  assert.equal(productAfterSubmission.autoDelistCaseId, rectify.body.data.id);

  const rectifyReviewed = await api(`/api/admin/score-cases/${rectify.body.data.id}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', note: '整改计划可执行', adjustment: 0 })
  });
  assert.equal(rectifyReviewed.response.status, 200);
  assert.deepEqual(rectifyReviewed.body.data.restoredProductIds, ['prod_ebike_001']);
  assert.equal(store.read().products.find((item) => item.id === 'prod_ebike_001').active, true);
  const productAfterReview = store.read().products.find((item) => item.id === 'prod_ebike_001');
  assert.equal(productAfterReview.autoDelistStatus, 'SCORE_CASE_RESTORED');
  assert.equal(productAfterReview.autoDelistRestoredCaseId, rectify.body.data.id);
  assert.ok(productAfterReview.autoDelistReviewNote.includes(rectify.body.data.caseNo));

  const overviewAfterReview = await api('/api/merchant/overview', { headers: merchantHeaders });
  const complianceCase = overviewAfterReview.body.data.products.find((item) => item.id === 'prod_ebike_001').complianceCase;
  assert.equal(complianceCase.dueAt, rectify.body.data.dueAt);

  const saveTemplate = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ scoreAppealResultTemplateId: 'wx_test_appeal_template' })
  });
  assert.equal(saveTemplate.response.status, 200);
  const configuredTemplates = await api('/api/admin/subscribe-templates', { headers: adminHeaders });
  assert.equal(configuredTemplates.response.status, 200);
  assert.ok(configuredTemplates.body.data.some((item) => item.id === 'score_appeal_result' && item.configuredId === 'wx_test_appeal_template'));

  const subscribeMessages = store.read().subscribeMessages || [];
  assert.ok(subscribeMessages.some((item) => item.templateId === 'score_appeal_result' && item.status === 'QUEUED'));
  assert.ok(subscribeMessages.some((item) => item.templateId === 'score_rectify_result' && item.status === 'QUEUED'));

  const dispatch = await api('/api/admin/subscribe-messages/dispatch', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ limit: 20 })
  });
  assert.equal(dispatch.response.status, 200);
  assert.ok(dispatch.body.data.sent >= 1);
  const sentAppealMessage = (store.read().subscribeMessages || [])
    .find((item) => item.templateId === 'score_appeal_result' && item.status === 'SENT');
  assert.ok(sentAppealMessage.sentAt);
  assert.ok(sentSubscribeMessages.some((message) => message.template_id === 'wx_test_appeal_template' && message.touser === 'openid_merchant_demo'));
});

test('low quality products are auto delisted and can be restored after compliance review', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };

  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantHeaders = { authorization: `Bearer ${merchantLogin.body.data.token}` };

  const invalidRectifyLink = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'RECTIFY', reason: '提交错误商品不应创建整改工单。', plan: '该商品不在自动下架清单中。', productId: 'prod_card_service_001' })
  });
  assert.equal(invalidRectifyLink.response.status, 404);

  store.update((data) => {
    const product = data.products.find((item) => item.id === 'prod_ebike_001');
    product.active = true;
    delete product.autoDelistRule;
    delete product.autoDelistRestoredBy;
    delete product.autoDelistRestoredCaseId;
    for (let index = 0; index < 2; index += 1) {
      data.productReviews.unshift({
        id: `review_auto_delist_${index}`, productId: 'prod_ebike_001', rating: 1,
        content: `自动下架风控测试差评 ${index}`, customerName: '风控同学', purchaseVerified: true,
        visibility: 'PUBLISHED', reply: null, createdAt: new Date().toISOString()
      });
    }
  });

  const products = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(products.response.status, 200);
  const merchantOverview = await api('/api/merchant/overview', { headers: merchantHeaders });
  const scoreAfterDelist = merchantOverview.body.data.serviceScore;
  assert.equal(scoreAfterDelist.metrics.activeAutoDelistCount, 1);
  assert.equal(scoreAfterDelist.metrics.compliancePenalty, 3);
  const delisted = merchantOverview.body.data.products.find((item) => item.id === 'prod_ebike_001');
  assert.equal(delisted.active, false);
  assert.equal(delisted.autoDelistRule, 'LOW_QUALITY');
  assert.equal(delisted.autoDelistEvidence.lowRatingCount, 2);
  assert.equal(delisted.autoDelistEvidence.thresholds.lowReviewLimit, 2);
  assert.ok((store.read().subscribeMessages || []).some((item) => item.templateId === 'product_auto_delist' && item.status === 'QUEUED'));

  // 清理测试注入的低分评价，避免恢复后再次触发同一条风控规则。
  store.update((data) => {
    data.productReviews = data.productReviews.filter((item) => !item.id.startsWith('review_auto_delist_'));
  });
  store.update((data) => {
    const product = data.products.find((item) => item.id === 'prod_ebike_001');
    product.active = false;
    product.autoDelistRestoredAt = '';
    data.productReviews.unshift({
      id: 'review_auto_delist_hold', productId: 'prod_ebike_001', rating: 1,
      content: '自动下架复核保留评价', customerName: '风控同学', purchaseVerified: true,
      visibility: 'PUBLISHED', reply: null, createdAt: new Date().toISOString()
    });
  });

  const adminOverview = await api('/api/admin/overview', { headers: adminHeaders });
  assert.ok(adminOverview.body.data.autoDelistedProducts.some((item) => item.id === 'prod_ebike_001'));
  assert.equal(adminOverview.body.data.autoDelistedProducts.find((item) => item.id === 'prod_ebike_001').status, 'DELISTED');
  assert.ok((store.read().subscribeMessages || []).some((item) => item.templateId === 'product_auto_delist' && item.status === 'QUEUED'));

  const restored = await api('/api/admin/products/prod_ebike_001/compliance-restore', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ note: '整改完成，平台复核通过' })
  });
  assert.equal(restored.response.status, 200);
  assert.equal(restored.body.data.active, true);
  assert.equal(restored.body.data.autoDelistStatus, 'MANUAL_RESTORED');
  assert.ok((store.read().subscribeMessages || []).some((item) => item.templateId === 'product_compliance_restored' && item.status === 'QUEUED'));

  const riskOverview = await api('/api/admin/overview', { headers: adminHeaders });
  assert.ok(riskOverview.body.data.operationsReport.totals.autoDelists >= 1);
  assert.ok(riskOverview.body.data.operationsReport.totals.complianceRestores >= 1);
  assert.ok(riskOverview.body.data.operationsReport.totals.rectifyCasesCreated >= 1);
  assert.ok(riskOverview.body.data.operationsReport.totals.rectifyCasesApproved >= 1);
  assert.ok((store.read().subscribeMessages || []).some((item) => item.templateId === 'product_compliance_restored' && item.status === 'QUEUED'));

  store.update((data) => {
    data.productReviews = data.productReviews.filter((item) => item.id !== 'review_auto_delist_hold');
  });

  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({
      productComplianceLowReviewThreshold: 3,
      productComplianceReviewSampleThreshold: 3,
      productComplianceAverageRatingThreshold: 3.5
    })
  });

  store.update((data) => {
    const product = data.products.find((item) => item.id === 'prod_ebike_001');
    product.active = true;
    product.stock = 8;
    product.reservedStock = 0;
  });

  const refreshed = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(refreshed.response.status, 200);
  assert.ok(refreshed.body.data.some((item) => item.id === 'prod_ebike_001'));
});

test('order notifications queue and dispatch to subscribed users', async () => {
  const session = await loginWeChat('message_user');
  const subscription = await api('/api/order-message-subscriptions', {
    method: 'POST', headers: { authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ accepted: true })
  });
  assert.equal(subscription.response.status, 200);
  assert.equal(subscription.body.data.subscribed, true);

  const state = await api('/api/order-message-subscriptions', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(state.body.data.subscribed, true);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const settings = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ orderStatusTemplateId: 'wx_test_order_status' })
  });
  assert.equal(settings.response.status, 200);

  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const paid = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);

  const queuedMessage = (store.read().subscribeMessages || [])
    .find((item) => item.templateId === 'order_status' && item.status === 'QUEUED');
  assert.ok(queuedMessage);

  const dispatch = await api('/api/admin/subscribe-messages/dispatch', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ limit: 100 })
  });
  assert.equal(dispatch.response.status, 200);
  assert.ok(dispatch.body.data.sent >= 1);
  assert.ok(sentSubscribeMessages.some((message) => message.template_id === 'wx_test_order_status'
    && message.touser === 'openid_message_user'
    && message.page === 'pages/orders/orders'));
});

test('failed subscribe messages can be retried after template configuration', async () => {
  const adminHeaders = await loginAdmin();
  const session = await loginWeChat('retry_user');
  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ orderStatusTemplateId: '' })
  });

  const card = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_rent_001', quantity: 1 }] })
  });
  assert.equal(card.response.status, 201);
  await confirmPayment(card.body.paymentOrder.id, session.token);
  const queued = (store.read().subscribeMessages || [])
    .find((item) => item.templateId === 'order_status' && item.userId === 'wx_retry_user' && ['QUEUED', 'FAILED'].includes(item.status));
  assert.ok(queued);

  const firstDispatch = await api('/api/admin/subscribe-messages/dispatch', {
    method: 'POST', headers: adminHeaders, body: JSON.stringify({ limit: 100 })
  });
  assert.equal(firstDispatch.response.status, 200);
  const failed = (store.read().subscribeMessages || [])
    .find((item) => item.id === queued.id && item.status === 'FAILED');
  assert.ok(failed);
  assert.ok(failed.error.includes('SUBSCRIBE_TEMPLATE_NOT_CONFIGURED'));

  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ orderStatusTemplateId: 'wx_test_order_status' })
  });
  const retried = await api(`/api/admin/subscribe-messages/${queued.id}/retry`, { method: 'POST', headers: adminHeaders });
  assert.equal(retried.response.status, 200);
  assert.equal(retried.body.data.status, 'QUEUED');

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await api('/api/admin/subscribe-messages/dispatch', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ limit: 100 })
    });
    assert.equal(result.response.status, 200);
    const sent = (store.read().subscribeMessages || [])
      .find((item) => item.id === queued.id && item.status === 'SENT');
    if (sent) break;
  }
  const sent = (store.read().subscribeMessages || [])
    .find((item) => item.id === queued.id && item.status === 'SENT');
  assert.ok(sent);
  assert.ok(sentSubscribeMessages.some((message) => message.template_id === 'wx_test_order_status'
    && message.touser === 'openid_retry_user'));
});

test('low stock reaches merchants exactly once and clears after restocking', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const configured = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ lowStockThreshold: 25, stockLowStockTemplateId: 'wx_test_low_stock' })
  });
  assert.equal(configured.response.status, 200);
  assert.equal(configured.body.data.lowStockThreshold, 25);
  assert.equal(configured.body.data.stockLowStockTemplateId, 'wx_test_low_stock');

  const subscribe = await api('/api/merchant/message-subscriptions', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ accepted: true })
  });
  assert.equal(subscribe.response.status, 200);
  assert.equal(subscribe.body.data.subscribed, true);

  const preRestock = await api('/api/merchant/products/prod_ebike_001', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ stock: 80 })
  });
  assert.equal(preRestock.response.status, 200);
  const notificationsBeforeTrigger = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${merchantSession.token}` }
  });
  const stockCountBefore = notificationsBeforeTrigger.body.data.filter((item) => item.type === 'STOCK').length;

  const trigger = await api('/api/merchant/products/prod_ebike_001', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ stock: 25 })
  });
  assert.equal(trigger.response.status, 200);

  const templateList = await api('/api/admin/subscribe-templates', { headers: adminHeaders });
  assert.ok(templateList.body.data.some((item) => item.id === 'stock_low_stock'
    && item.configuredId === 'wx_test_low_stock' && item.audience === 'MERCHANT'));

  const firstOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(firstOverview.response.status, 200);
  assert.equal(firstOverview.body.data.lowStockThreshold, 25);
  assert.ok(firstOverview.body.data.metrics.lowStockCount > 0);
  assert.ok(firstOverview.body.data.lowStockProducts.some((item) => item.id === 'prod_ebike_001'));
  assert.equal(firstOverview.body.data.lowStockProducts.find((item) => item.id === 'prod_ebike_001').status, 'OPEN');

  const notificationsAfterFirst = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${merchantSession.token}` }
  });
  const firstAlertCount = notificationsAfterFirst.body.data.filter((item) => item.type === 'STOCK').length;
  assert.equal(firstAlertCount, stockCountBefore + 1);

  const queuedLowStock = (store.read().subscribeMessages || [])
    .filter((item) => item.templateId === 'stock_low_stock' && item.status === 'QUEUED');
  assert.equal(queuedLowStock.length, 1);

  await api('/api/merchant/overview', { headers: merchantAuth });
  const notificationsAfterRepeat = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${merchantSession.token}` }
  });
  assert.equal(notificationsAfterRepeat.body.data.filter((item) => item.type === 'STOCK').length, firstAlertCount);

  const restocked = await api('/api/merchant/products/prod_ebike_001', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ stock: 80 })
  });
  assert.equal(restocked.response.status, 200);

  const restoredOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  const restoredProduct = restoredOverview.body.data.lowStockProducts.find((item) => item.id === 'prod_ebike_001');
  assert.equal(restoredProduct, undefined);
  assert.equal(restoredOverview.body.data.products.find((item) => item.id === 'prod_ebike_001').stock, 80);

  const reset = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ lowStockThreshold: 10 })
  });
  assert.equal(reset.response.status, 200);
  assert.equal(reset.body.data.lowStockThreshold, 10);

  store.update((data) => {
    for (const item of data.products || []) {
      if (item.id === 'prod_ebike_rent_001') {
        item.stock = 5;
        item.lowStockAlertedAt = '';
        item.lowStockAlertStatus = '';
      }
    }
  });
  const refreshed = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.ok(refreshed.body.data.lowStockProducts.some((item) => item.id === 'prod_ebike_rent_001'));
  const queuedForDispatch = (store.read().subscribeMessages || [])
    .find((item) => item.templateId === 'stock_low_stock' && item.status === 'QUEUED');
  assert.ok(queuedForDispatch);

  const dispatch = await api('/api/admin/subscribe-messages/dispatch', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ limit: 100 })
  });
  assert.equal(dispatch.response.status, 200);
  const sentLowStock = (store.read().subscribeMessages || [])
    .find((item) => item.templateId === 'stock_low_stock' && item.status === 'SENT');
  assert.ok(sentLowStock);
  assert.ok(sentSubscribeMessages.some((message) => message.template_id === 'wx_test_low_stock'
    && message.touser === 'openid_merchant_demo'
    && message.page === 'pages/merchant/index'));
});

test('merchant score notifications require a persisted subscription', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const unsubscribe = await api('/api/merchant/message-subscriptions', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ accepted: false })
  });
  assert.equal(unsubscribe.response.status, 200);
  assert.equal(unsubscribe.body.data.subscribed, false);

  store.update((data) => {
    data.subscribeMessages = (data.subscribeMessages || []).filter((item) => !(
      item.userId === 'openid_merchant_demo' && item.templateId === 'score_rectify_apply'
    ));
  });

  const caseBeforeGate = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'RECTIFY', reason: '先关闭提醒验证消息授权门槛，再恢复整改流程。', plan: '按承诺完成逾期事项处理。' })
  });
  assert.equal(caseBeforeGate.response.status, 201);
  assert.ok(!(store.read().subscribeMessages || [])
    .some((item) => item.userId === 'openid_merchant_demo' && item.templateId === 'score_rectify_apply'));

  const subscribe = await api('/api/merchant/message-subscriptions', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ accepted: true })
  });
  assert.equal(subscribe.response.status, 200);
  assert.equal(subscribe.body.data.subscribed, true);

  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  const settings = await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ scoreRectifyApplyTemplateId: 'wx_test_rectify_gate' })
  });
  assert.equal(settings.response.status, 200);

  await api(`/api/admin/score-cases/${caseBeforeGate.body.data.id}/review`, {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ decision: 'APPROVE', note: '测试流程通过，用于验证订阅后的整改通知。', adjustment: 0 })
  });

  const caseAfterGate = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'RECTIFY', reason: '已开启商家提醒，验证整改申请会进入消息队列。', plan: '完成剩余超时事项并回访用户。' })
  });
  assert.equal(caseAfterGate.response.status, 201);

  const queuedMessage = (store.read().subscribeMessages || [])
    .find((item) => item.userId === 'wx_merchant_demo' && item.templateId === 'score_rectify_apply');
  assert.ok(queuedMessage && queuedMessage.status === 'QUEUED');

  const dispatch = await api('/api/admin/subscribe-messages/dispatch', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ limit: 100 })
  });
  assert.equal(dispatch.response.status, 200);
  const sentMessage = (store.read().subscribeMessages || [])
    .find((item) => item.userId === 'wx_merchant_demo' && item.templateId === 'score_rectify_apply');
  assert.equal(sentMessage.status, 'SENT');
  assert.ok(sentSubscribeMessages.some((message) => message.template_id === 'wx_test_rectify_gate'
    && message.touser === 'openid_merchant_demo'
    && message.page === 'pages/merchant/index'));
});

test('saved delivery addresses are scoped to the logged-in user', async () => {
  const userSession = await loginWeChat('address_user');
  const otherSession = await loginWeChat('address_stranger');

  const created = await api('/api/my/addresses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({
      contactName: '陈同学', contactPhone: '15527110006', address: '荟园 12 栋',
      campusName: '华中农业大学狮山校区', isDefault: true
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.contactName, '陈同学');
  assert.equal(created.body.data.isDefault, true);

  const duplicate = await api('/api/my/addresses', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ contactName: '陈同学', contactPhone: '15527110006', address: '荟园 12 栋', isDefault: false })
  });
  assert.equal(duplicate.response.status, 201);
  assert.equal(duplicate.body.data.isDefault, false);

  const list = await api('/api/my/addresses', { headers: { authorization: `Bearer ${userSession.token}` } });
  assert.equal(list.response.status, 200);
  assert.equal(list.body.data.length, 2);
  assert.equal(list.body.data[0].id, created.body.data.id);
  assert.equal(list.body.data[1].isDefault, false);

  const updated = await api(`/api/my/addresses/${duplicate.body.data.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ address: '桃园 8 栋', isDefault: true })
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.body.data.address, '桃园 8 栋');
  assert.equal(updated.body.data.isDefault, true);

  const refreshed = await api('/api/my/addresses', { headers: { authorization: `Bearer ${userSession.token}` } });
  assert.equal(refreshed.body.data.find((item) => item.id === created.body.data.id).isDefault, false);

  const foreign = await api(`/api/my/addresses/${duplicate.body.data.id}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${otherSession.token}` },
    body: JSON.stringify({ address: '伪造地址' })
  });
  assert.equal(foreign.response.status, 404);

  const removed = await api(`/api/my/addresses/${duplicate.body.data.id}`, {
    method: 'DELETE', headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(removed.response.status, 200);

  const missing = await api('/api/my/addresses', { headers: { authorization: `Bearer ${userSession.token}` } });
  assert.equal(missing.body.data.length, 1);
});

test('restock alerts notify waiting users after merchant restocking', async () => {
  const userSession = await loginWeChat('restock_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);

  store.update((data) => {
    const product = data.products.find((item) => item.id === 'prod_ebike_001');
    product.stock = 0;
    product.reservedStock = 0;
    data.productRestockAlerts = [];
  });

  const subscribed = await api('/api/products/prod_ebike_001/restock-alert', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ subscribed: true })
  });
  assert.equal(subscribed.response.status, 201);
  assert.equal(subscribed.body.data.subscribed, true);

  const state = await api('/api/products/prod_ebike_001/restock-alert', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(state.body.data.subscribed, true);

  const restock = await api('/api/merchant/products/prod_ebike_001', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ stock: 2 })
  });
  assert.equal(restock.response.status, 200);

  const notifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  const notice = notifications.body.data.find((item) => item.title === '你登记的商品已到货');
  assert.ok(notice);
  assert.ok(notice.content.includes('轻风 通勤版'));
  assert.equal((store.read().productRestockAlerts || []).find((item) => item.userId === 'wx_restock_user').status, 'NOTIFIED');

  const noticeCount = notifications.body.data.filter((item) => item.title === '你登记的商品已到货').length;
  await api('/api/merchant/products/prod_ebike_001', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ stock: 3 })
  });
  const repeated = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(repeated.body.data.filter((item) => item.title === '你登记的商品已到货').length, noticeCount);
});

test('favorite users are notified once when a sold-out product is restocked', async () => {
  const userSession = await loginWeChat('favorite_restock_user');
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(merchantLogin.response.status, 200);

  const created = await api('/api/merchant/products', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ name: '收藏补货测试车', category: 'E_BIKE_NEW', description: '验证收藏用户补货召回', priceInCents: 220000, stock: 1 })
  });
  assert.equal(created.response.status, 201);
  const productId = created.body.data.id;

  await api(`/api/products/${productId}/favorite`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ favorited: true })
  });
  store.update((data) => {
    const product = data.products.find((item) => item.id === productId);
    product.stock = 0;
    product.reservedStock = 0;
    product.lastFavoriteRestockNoticeAt = '';
  });

  const restock = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ stock: 2 })
  });
  assert.equal(restock.response.status, 200);

  const notifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  const notice = notifications.body.data.find((item) => item.title === '收藏商品已补货');
  assert.ok(notice);
  assert.ok(notice.content.includes('收藏补货测试车'));
  assert.equal(notice.metadata.productId, productId);
  const queued = (store.read().subscribeMessages || []).find((item) => (
    item.userId === userSession.userId && item.templateId === 'restock_notice' && item.page === 'pages/detail/detail'
  ));
  assert.ok(queued);

  await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` },
    body: JSON.stringify({ stock: 3 })
  });
  const repeated = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(repeated.body.data.filter((item) => item.title === '收藏商品已补货').length, 1);
});

test('approved merchants expose a public storefront without private data', async () => {
  const storefront = await api('/api/merchants/merchant_001/storefront');
  assert.equal(storefront.response.status, 200);
  assert.equal(storefront.body.data.merchant.id, 'merchant_001');
  assert.equal(storefront.body.data.merchant.name, '狮山校园车行');
  assert.equal(storefront.body.data.merchant.licenseNo, undefined);
  assert.equal(storefront.body.data.merchant.phone, undefined);
  assert.equal(storefront.body.data.merchant.settlementAccount, undefined);
  assert.ok(storefront.body.data.merchant.serviceScore.score);
  assert.ok(storefront.body.data.products.some((item) => item.id === 'prod_ebike_001'));
  assert.ok(storefront.body.data.products.every((item) => item.active && item.availableStock !== undefined));
  assert.ok(storefront.body.data.reviewSummary.count >= 1);
  assert.ok(storefront.body.data.reviewSummary.averageRating > 0);
  assert.ok(Array.isArray(storefront.body.data.reviews));
  assert.ok(storefront.body.data.reviews.length >= 1);
  const storefrontReview = storefront.body.data.reviews[0];
  assert.equal('ownerName' in storefrontReview, false);
  assert.equal('phone' in storefrontReview, false);
  assert.equal('settlementAccount' in storefrontReview, false);
  assert.ok(storefrontReview.productName);
  assert.ok(storefrontReview.rating);
  assert.ok(storefrontReview.content);

  const hidden = await api('/api/merchants/merchant_002/storefront');
  assert.equal(hidden.response.status, 404);
});

test('users can favorite products and revisit them from profile', async () => {
  const session = await loginWeChat('favorite_user');
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${session.token}` };

  const missing = await api('/api/products/not_a_product/favorite', {
    method: 'POST', headers: auth, body: JSON.stringify({ favorited: true })
  });
  assert.equal(missing.response.status, 404);

  const add = await api('/api/products/prod_ebike_001/favorite', {
    method: 'POST', headers: auth, body: JSON.stringify({ favorited: true })
  });
  assert.equal(add.response.status, 200);
  assert.equal(add.body.data.favorited, true);

  const state = await api('/api/products/prod_ebike_001/favorite', { headers: auth });
  assert.equal(state.body.data.favorited, true);

  const list = await api('/api/my/favorites', { headers: auth });
  assert.equal(list.response.status, 200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].id, 'prod_ebike_001');
  assert.equal(list.body.data[0].merchantName, '狮山校园车行');
  assert.ok('availableStock' in list.body.data[0]);
  assert.ok('ratingSummary' in list.body.data[0]);

  const remove = await api('/api/products/prod_ebike_001/favorite', {
    method: 'POST', headers: auth, body: JSON.stringify({ favorited: false })
  });
  assert.equal(remove.body.data.favorited, false);
  const removedList = await api('/api/my/favorites', { headers: auth });
  assert.equal(removedList.body.data.length, 0);
});

test('merchant and admin surfaces turn favorites into demand signals', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  const shoppers = [];
  for (let index = 0; index < 2; index += 1) {
    const session = await loginWeChat(`demand_user_${index}`);
    shoppers.push(session.token);
  }
  for (const token of shoppers) {
    const add = await api('/api/products/prod_ebike_001/favorite', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ favorited: true })
    });
    assert.equal(add.response.status, 200);
  }

  const merchantOverview = await api('/api/merchant/overview', { headers: merchantAuth });
  assert.equal(merchantOverview.response.status, 200);
  const merchantProduct = merchantOverview.body.data.products.find((item) => item.id === 'prod_ebike_001');
  assert.ok(merchantProduct.favoriteCount >= 2);
  assert.ok(merchantProduct.favoriteDemandText.includes('2 人收藏'));

  const admin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminOverview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${admin.body.data.token}` }
  });
  const adminProduct = adminOverview.body.data.products.find((item) => item.id === 'prod_ebike_001');
  assert.ok(adminProduct.favoriteCount >= 2);
  assert.ok(adminOverview.body.data.favoriteDemandProducts.some((item) => (
    item.id === 'prod_ebike_001' && item.favoriteCount >= 2
  )));
});

test('favorite users receive a conversion notice when a product goes on sale', async () => {
  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantAuth = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };
  const created = await api('/api/merchant/products', {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({ name: '收藏转化测试车', category: 'DIGITAL', description: '降价转化链路验证', priceInCents: 100000, stock: 3 })
  });
  const productId = created.body.data.id;

  const userSession = await loginWeChat('favorite_price_user');
  await api(`/api/products/${productId}/favorite`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({ favorited: true })
  });

  const now = Date.now();
  const sale = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: merchantAuth,
    body: JSON.stringify({
      salePriceInCents: 80000,
      saleStartsAt: new Date(now - 60 * 1000).toISOString(),
      saleEndsAt: new Date(now + 24 * 3600 * 1000).toISOString()
    })
  });
  assert.equal(sale.response.status, 200);

  const notifications = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  const notice = notifications.body.data.find((item) => item.title === '收藏商品降价');
  assert.ok(notice);
  assert.ok(notice.content.includes('收藏转化测试车'));
  assert.ok(notice.content.includes('¥800'));
  assert.ok(notice.content.includes('节省 ¥200'));

  const queued = (store.read().subscribeMessages || []).find((item) => (
    item.userId === userSession.userId && item.templateId === 'favorite_price_notice'
  ));
  assert.ok(queued);
  assert.equal(queued.page, 'pages/detail/detail');
  assert.equal(notice.metadata.productId, productId);

  const noticeAction = await api(`/api/my/notifications/${notice.id}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${userSession.token}` },
    body: JSON.stringify({})
  });
  assert.equal(noticeAction.response.status, 200);
  assert.equal(noticeAction.body.data.productId, productId);
  const notificationsAfterAction = await api('/api/my/notifications', {
    headers: { authorization: `Bearer ${userSession.token}` }
  });
  assert.equal(notificationsAfterAction.body.data.find((item) => item.id === notice.id).read, true);

  const admin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  await api('/api/admin/settings', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${admin.body.data.token}` },
    body: JSON.stringify({ favoritePriceNoticeTemplateId: 'wx_favorite_price_notice' })
  });
  const templates = await api('/api/admin/subscribe-templates', {
    headers: { authorization: `Bearer ${admin.body.data.token}` }
  });
  assert.ok(templates.body.data.some((item) => (
    item.id === 'favorite_price_notice' && item.configuredId === 'wx_favorite_price_notice'
  )));
});

test('service score stage changes reach merchants, platform and patrol audit', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ patrolIntervalMinutes: 1 })
  });

  store.update((data) => {
    data.afterSales = (data.afterSales || []).map((item) => ({ ...item, status: 'CLOSED' }));
    data.slaAlerts = (data.slaAlerts || []).map((item) => ({ ...item, status: 'RESOLVED' }));
    const merchant = data.merchants.find((item) => item.id === 'merchant_001');
    merchant.serviceScore = null;
    data.serviceMessageSubscribers = [...new Set([...(data.serviceMessageSubscribers || []), merchant.userId])];
    data.patrolState = { lastRunAt: '', runCount: 0, lastCreated: 0, lastResolved: 0, lastOpen: 0, lastScoreChanges: 0 };
  });

  const baseline = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(baseline.response.status, 200);
  const merchant = store.read().merchants.find((item) => item.id === 'merchant_001');
  const scoreBefore = merchant.serviceScore;
  assert.equal(scoreBefore.stage, 'NORMAL');

  const buyer = await loginWeChat('score_stage_buyer');
  const created = await api('/api/orders', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${buyer.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_ebike_001', quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const paid = await confirmPayment(created.body.paymentOrder.id, buyer.token);
  assert.equal(paid.response.status, 200);

  store.update((data) => {
    const order = data.orders.find((item) => item.id === created.body.data.id);
    data.afterSales.unshift({
      id: 'after_sale_stage_test', orderId: order.id, userId: buyer.userId,
      type: 'REFUND', typeLabel: '退款/退货', reason: '服务分巡检测试', status: 'REVIEWING',
      images: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      responseDueAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString()
    });
    data.patrolState = { ...data.patrolState, lastRunAt: '' };
  });

  const afterAlert = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(afterAlert.response.status, 200);
  const state = store.read();
  const merchantAfter = state.merchants.find((item) => item.id === 'merchant_001').serviceScore;
  assert.equal(merchantAfter.stage, 'LIMITED');
  assert.ok(merchantAfter.score < scoreBefore.score);
  const stageLog = (state.merchantScoreLogs || []).find((log) => log.merchantId === 'merchant_001' && log.type === 'STAGE_CHANGE');
  assert.equal(stageLog.fromStage, 'NORMAL');
  assert.equal(stageLog.toStage, 'LIMITED');
  const platformNotice = (state.notifications || []).find((item) => item.userId === 'PLATFORM'
    && item.title === '服务分下降' && item.content.includes(merchant.name));
  assert.ok(platformNotice);
  assert.ok((state.subscribeMessages || []).some((item) => (
    item.templateId === 'score_stage_warning' && item.status === 'QUEUED' && item.userId === merchant.userId
  )));
  assert.ok(state.patrolState.lastScoreChanges >= 1);
  const audit = (state.auditLogs || []).find((item) => item.action === '运营巡检执行');
  assert.equal(audit.action, '运营巡检执行');
  assert.ok(audit.target.includes('服务分'));

  store.update((data) => {
    data.afterSales = data.afterSales.filter((item) => item.id !== 'after_sale_stage_test');
    data.patrolState = { ...data.patrolState, lastRunAt: '' };
  });
  const recovery = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(recovery.response.status, 200);
  const stateAfter = store.read();
  assert.equal(stateAfter.merchants.find((item) => item.id === 'merchant_001').serviceScore.stage, 'NORMAL');
  assert.ok((stateAfter.notifications || []).some((item) => (
    item.userId === 'PLATFORM' && item.title === '服务分已恢复' && item.content.includes(merchant.name)
  )));

  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ patrolIntervalMinutes: 10 })
  });
});

test('rectification cases warn merchants before the review deadline', async () => {
  const adminLogin = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  const adminHeaders = { 'content-type': 'application/json', authorization: `Bearer ${adminLogin.body.data.token}` };
  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ patrolIntervalMinutes: 1 })
  });

  const merchantSession = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantSession.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  const merchantHeaders = { 'content-type': 'application/json', authorization: `Bearer ${merchantLogin.body.data.token}` };

  store.update((data) => {
    data.afterSales = (data.afterSales || []).map((item) => ({ ...item, status: 'CLOSED' }));
    data.slaAlerts = (data.slaAlerts || []).map((item) => ({ ...item, status: 'RESOLVED' }));
    data.serviceScoreCases = [];
    const merchant = data.merchants.find((item) => item.id === 'merchant_001');
    merchant.serviceScore = null;
    data.serviceMessageSubscribers = [...new Set([...(data.serviceMessageSubscribers || []), merchant.userId])];
    data.patrolState = { lastRunAt: '', runCount: 0, lastCreated: 0, lastResolved: 0, lastOpen: 0, lastScoreChanges: 0 };
  });

  const created = await api('/api/merchant/score-cases', {
    method: 'POST', headers: merchantHeaders,
    body: JSON.stringify({ type: 'RECTIFY', reason: '48 小时内完成整改', plan: '清理逾期工单并回访用户' })
  });
  assert.equal(created.response.status, 201);

  await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  const earlyState = store.read();
  assert.ok(!(earlyState.slaAlerts || []).some((alert) => (
    alert.ruleKey === 'SCORE_RECTIFY_MERCHANT' && alert.businessId === created.body.data.id && alert.status !== 'RESOLVED'
  )));

  store.update((data) => {
    const record = data.serviceScoreCases.find((item) => item.id === created.body.data.id);
    record.dueAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
    data.patrolState = { ...data.patrolState, lastRunAt: '' };
  });
  await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  let state = store.read();
  let warning = state.slaAlerts.find((alert) => (
    alert.ruleKey === 'SCORE_RECTIFY_MERCHANT' && alert.businessId === created.body.data.id
  ));
  assert.ok(warning);
  assert.equal(warning.ownerRole, 'MERCHANT');
  assert.equal(warning.level, 'WARNING');
  assert.ok((state.notifications || []).some((item) => (
    item.userId === 'wx_merchant_demo' && item.title === '履约即将超时' && item.content.includes('商家整改临期')
  )));
  assert.ok((state.subscribeMessages || []).some((item) => (
    item.templateId === 'sla_warning' && item.status === 'QUEUED' && item.userId === 'wx_merchant_demo'
  )));

  store.update((data) => {
    const record = data.serviceScoreCases.find((item) => item.id === created.body.data.id);
    record.dueAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    data.patrolState = { ...data.patrolState, lastRunAt: '' };
  });
  await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  state = store.read();
  const overdue = state.slaAlerts.find((alert) => (
    alert.ruleKey === 'SCORE_RECTIFY_MERCHANT' && alert.businessId === created.body.data.id
  ));
  assert.equal(overdue.level, 'OVERDUE');
  assert.ok((state.notifications || []).some((item) => (
    item.userId === 'wx_merchant_demo' && item.title === '履约已超时' && item.content.includes('商家整改临期')
  )));

  store.update((data) => {
    data.serviceScoreCases = data.serviceScoreCases.filter((item) => item.id !== created.body.data.id);
    data.patrolState = { ...data.patrolState, lastRunAt: '' };
  });
  await api('/api/admin/patrol/run', { method: 'POST', headers: adminHeaders });
  const finalState = store.read();
  assert.equal(finalState.slaAlerts.find((alert) => (
    alert.ruleKey === 'SCORE_RECTIFY_MERCHANT' && alert.businessId === created.body.data.id
  )).status, 'RESOLVED');

  await api('/api/admin/settings', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ patrolIntervalMinutes: 10 })
  });
});
