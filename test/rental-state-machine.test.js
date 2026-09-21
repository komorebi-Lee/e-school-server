const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'rental-sm-admin';
process.env.ADMIN_PASSWORD = 'rental-sm-admin-password-123';

/**
 * 租赁状态机 + 资金侧单点守卫 + 状态侧收口的端到端回归（T34）。
 *
 * 本文件守护的是**资损级**约束：租赁单「交付取车」不等于「订单完成」。
 * 车还在用户手上时，商家在任何一个入口点「完成」，都不得把分账推进账期 ——
 * 一旦进账期就可打款，而打款不可逆。
 *
 * 三层防线：
 *
 * - **资金侧**：`activateOrderSettlements` 入口单点守卫（`orderKind === 'RENTAL'
 *   且 rental.status !== 'RETURNED'` 直接返回 `[]`）。守卫在入口而非 6 个调用方，
 *   所以断言 ⑦ 必须**逐条枚举 4 条路径**，验证的是「同一个守卫覆盖全部入口」。
 * - **状态侧**：`resolveOrderCompletion` 收口所有「置 COMPLETED」的入口。
 * - **状态机**：`RENTING → RETURN_REQUESTED → RETURNED`，非法迁移一律 409。
 *
 * 断言 ③⑨ 是**零改动复用**的证明：`createSettlements` 的账期激活由
 * `order.status === 'COMPLETED'` 触发、`POST /api/product-reviews` 的拒绝条件也是
 * `order.status !== 'COMPLETED'` —— 这两条既有语义在租赁链路上自动成立，
 * 本轮没有为它们改过一行代码。
 */
const RENTAL_PRODUCT_ID = 'prod_ebike_rent_002';
const SALE_PRODUCT_ID = 'prod_ebike_001';
const MERCHANT_ID = 'merchant_001';
const RENTAL_UNITS = 3;

/** 分账处于「已进入账期」的两种合法终态（账期为 0 天时立刻可结算）。 */
const ACTIVATED_SETTLEMENT_STATUSES = ['IN_ACCOUNT_PERIOD', 'PENDING_SETTLE'];

let server;
let baseUrl;
let tempDirectory;
let store;

let merchantToken = '';
let adminToken = '';

/** 断言 ①② 共用的主租赁单（交付取车 → 归还申请 → 归还核验）。 */
let mainOrder = null;
/** 断言 ⑥⑦ 共用的租赁单（保持 FULFILLING + RENTING，用于枚举 4 条完成路径）。 */
let guardOrderId = '';
let guardDeliveryCode = '';
let guardUserToken = '';

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-rental-sm-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` })
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // merchant_001 的归属用户是 wx_merchant_demo（见 store.js 种子）。
  const merchantUser = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${merchantUser.token}` },
    body: JSON.stringify({ merchantId: MERCHANT_ID })
  });
  assert.equal(merchantLogin.response.status, 200);
  merchantToken = merchantLogin.body.data.token;

  const adminLogin = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(adminLogin.response.status, 200);
  adminToken = adminLogin.body.data.token;
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
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

function jsonHeaders(token) {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
}

/** 提交订单协同动作（用户 / 商家 / 平台共用入口）。 */
async function collab(token, body) {
  return api('/api/order-collab', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body)
  });
}

/** 商家端订单状态接口 —— 商家「完成」主按钮直连的那条路径。 */
async function merchantStatus(orderId, body) {
  return api(`/api/merchant/orders/${orderId}/status`, {
    method: 'POST',
    headers: jsonHeaders(merchantToken),
    body: JSON.stringify(body)
  });
}

async function confirmPayment(paymentId, token) {
  return api(`/api/payment-orders/${paymentId}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
}

/**
 * 建单并支付一张租赁单（单台、租 3 天）。
 *
 * @param {string} userCode 微信登录 code。
 * @returns {Promise<{token: string, userId: string, orderId: string}>} 已支付的租赁单上下文。
 */
async function createPaidRentalOrder(userCode) {
  const session = await loginWeChat(userCode);
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: RENTAL_UNITS }] })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.orderKind, 'RENTAL');

  const paid = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);
  return { token: session.token, userId: session.userId, orderId: created.body.data.id };
}

/** 商家确认履约 = 用户到店取车（交付取车，不是订单完成）。 */
async function pickUpOrder(orderId) {
  const accepted = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'ACCEPT',
    orderId,
    note: '已确认库存，用户到店取车。'
  });
  assert.equal(accepted.response.status, 200);
  assert.equal(accepted.body.data.status, 'FULFILLING');
  return accepted;
}

function orderOf(orderId) {
  return store.read().orders.find((item) => item.id === orderId);
}

function settlementsOf(orderId) {
  return store.read().settlements.filter((item) => item.orderId === orderId);
}

/**
 * 读取某订单分账的当前状态。
 *
 * @param {string} orderId 订单 id。
 * @returns {string} `settlementStatus`。
 */
function settlementStatusOf(orderId) {
  const rows = settlementsOf(orderId);
  assert.equal(rows.length, 1, `订单 ${orderId} 应恰好有 1 条分账记录`);
  return rows[0].settlementStatus;
}

async function deliveryCodeOf(orderId, token) {
  const result = await api(`/api/orders/${orderId}`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(result.response.status, 200);
  return result.body.data.deliveryCode;
}

test('① 交付取车后：订单仍 FULFILLING、rental 仍 RENTING、分账仍未激活', async () => {
  const session = await loginWeChat('rental_sm_main');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: RENTAL_UNITS }] })
  });
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;
  const paid = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);

  // 支付成功只生成分账（资金在途），交付核验前必须停在 PENDING_DELIVERY。
  assert.equal(settlementStatusOf(orderId), 'PENDING_DELIVERY');

  const accepted = await pickUpOrder(orderId);
  assert.equal(accepted.body.data.rental.status, 'RENTING');
  assert.equal(settlementStatusOf(orderId), 'PENDING_DELIVERY');

  mainOrder = { token: session.token, userId: session.userId, orderId };
});

test('② 归还核验后：order COMPLETED、rental RETURNED、分账进入账期', async () => {
  assert.ok(mainOrder, '前置条件：断言 ① 必须先建好主租赁单');
  const orderId = mainOrder.orderId;

  const requested = await collab(mainOrder.token, {
    role: 'USER',
    action: 'RETURN_REQUEST',
    orderId,
    note: '车已还到店内，请核验。'
  });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.body.data.rental.status, 'RETURN_REQUESTED');
  // 归还「申请」不是归还「核验」：订单不得完成、分账不得激活。
  assert.equal(orderOf(orderId).status, 'FULFILLING');
  assert.equal(settlementStatusOf(orderId), 'PENDING_DELIVERY');

  const verified = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId,
    note: '车辆核验无损，押金待结算。'
  });
  assert.equal(verified.response.status, 200);
  assert.equal(verified.body.data.rental.status, 'RETURNED');
  assert.equal(verified.body.data.status, 'COMPLETED');

  const order = orderOf(orderId);
  assert.equal(order.status, 'COMPLETED');
  assert.equal(order.rental.status, 'RETURNED');
  assert.ok(
    ACTIVATED_SETTLEMENT_STATUSES.includes(settlementStatusOf(orderId)),
    `归还核验后分账应进入账期，实际 ${settlementStatusOf(orderId)}`
  );

  // 状态机没有 RETURNED 的出边：归还核验不可回退（下游押金/分账已发生）。
  const repeated = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId,
    note: '重复核验。'
  });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, 'ACTION_NOT_ALLOWED');
});

test('③ ★ 归还前无法评价（409 ORDER_NOT_COMPLETED），归还核验后同一请求成功', async () => {
  const session = await loginWeChat('rental_sm_review');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: RENTAL_UNITS }] })
  });
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;
  await confirmPayment(created.body.paymentOrder.id, session.token);
  await pickUpOrder(orderId);

  // 与评价接口完全相同的请求体，前后各发一次。
  const reviewBody = { orderId, productId: RENTAL_PRODUCT_ID, rating: 5, content: '车况不错，取还都方便。' };

  // 车未归还 → 订单不是 COMPLETED → 评价被既有的 `order.status !== 'COMPLETED'` 关卡拒绝。
  const blocked = await api('/api/product-reviews', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify(reviewBody)
  });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.body.error.code, 'ORDER_NOT_COMPLETED');

  await collab(session.token, { role: 'USER', action: 'RETURN_REQUEST', orderId, note: '已还车。' });
  const verified = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId,
    note: '车辆核验无损。'
  });
  assert.equal(verified.response.status, 200);
  assert.equal(orderOf(orderId).status, 'COMPLETED');

  const accepted = await api('/api/product-reviews', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify(reviewBody)
  });
  assert.equal(accepted.response.status, 201);
  assert.equal(accepted.body.data.orderId, orderId);
});

test('④ RETURN_REQUEST 后 rental.status 为 RETURN_REQUESTED，且不完成订单', async () => {
  const session = await createPaidRentalOrder('rental_sm_return_request');
  const orderId = session.orderId;
  await pickUpOrder(orderId);

  const requested = await collab(session.token, {
    role: 'USER',
    action: 'RETURN_REQUEST',
    orderId,
    note: '已到店还车。'
  });
  assert.equal(requested.response.status, 200);
  assert.equal(requested.body.data.rental.status, 'RETURN_REQUESTED');
  assert.equal(orderOf(orderId).status, 'FULFILLING');
  assert.equal(settlementStatusOf(orderId), 'PENDING_DELIVERY');

  // 重复申请是非法迁移：状态机里 RETURN_REQUESTED 没有 RETURN_REQUEST 出边。
  const repeated = await collab(session.token, {
    role: 'USER',
    action: 'RETURN_REQUEST',
    orderId,
    note: '重复申请。'
  });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, 'ACTION_NOT_ALLOWED');
});

test('⑤ SALE 订单调租赁动作一律 409 ACTION_NOT_ALLOWED', async () => {
  const session = await loginWeChat('rental_sm_sale_actions');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: SALE_PRODUCT_ID, quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;
  assert.equal(created.body.data.orderKind, 'SALE');

  const request = await collab(session.token, {
    role: 'USER',
    action: 'RETURN_REQUEST',
    orderId,
    note: '售卖单不该支持归还申请。'
  });
  assert.equal(request.response.status, 409);
  assert.equal(request.body.error.code, 'ACTION_NOT_ALLOWED');

  const verify = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId,
    note: '售卖单不该支持归还核验。'
  });
  assert.equal(verify.response.status, 409);
  assert.equal(verify.body.error.code, 'ACTION_NOT_ALLOWED');

  // 失败请求零副作用：订单状态未被改动。
  assert.equal(orderOf(orderId).status, 'PENDING_PAYMENT');
});

test('⑥ 回归：交付码错误仍返回 409 DELIVERY_CODE_INVALID（租赁单同样受码保护）', async () => {
  const session = await createPaidRentalOrder('rental_sm_guard');
  guardOrderId = session.orderId;
  guardUserToken = session.token;
  await pickUpOrder(guardOrderId);
  guardDeliveryCode = await deliveryCodeOf(guardOrderId, guardUserToken);
  assert.match(guardDeliveryCode, /^\d{6}$/);

  const wrongCode = guardDeliveryCode === '000000' ? '111111' : '000000';
  const rejected = await merchantStatus(guardOrderId, { status: 'COMPLETED', deliveryCode: wrongCode });
  assert.equal(rejected.response.status, 409);
  assert.equal(rejected.body.error.code, 'DELIVERY_CODE_INVALID');

  // 被拒的完成请求不得留下任何痕迹。
  assert.equal(orderOf(guardOrderId).status, 'FULFILLING');
  assert.equal(orderOf(guardOrderId).rental.status, 'RENTING');
  assert.equal(settlementStatusOf(guardOrderId), 'PENDING_DELIVERY');
});

test('⑦ ★ 单点守卫：枚举 4 条「完成」路径，全部不得激活未归还租赁单的分账', async () => {
  assert.ok(guardOrderId, '前置条件：断言 ⑥ 必须先建好守卫用租赁单');

  // 前置：租赁单停在「已交付取车、车未归还」—— 这正是资损风险最大的时刻。
  assert.equal(orderOf(guardOrderId).status, 'FULFILLING');
  assert.equal(orderOf(guardOrderId).rental.status, 'RENTING');
  assert.equal(settlementStatusOf(guardOrderId), 'PENDING_DELIVERY');

  const assertStillSafe = (label) => {
    assert.equal(orderOf(guardOrderId).status, 'FULFILLING',
      `${label}：租赁单未归还，订单不得进入 COMPLETED`);
    assert.equal(orderOf(guardOrderId).rental.status, 'RENTING',
      `${label}：租赁单状态不得被改动`);
    assert.equal(settlementStatusOf(guardOrderId), 'PENDING_DELIVERY',
      `${label}：分账必须仍停在 PENDING_DELIVERY（未被激活）`);
  };

  // ── 路径 1：/api/order-collab（商家协同 COMPLETE，交付码正确） ──────────────
  const collabComplete = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'COMPLETE',
    orderId: guardOrderId,
    note: '尝试完成订单。',
    deliveryCode: guardDeliveryCode
  });
  assert.equal(collabComplete.response.status, 200, '路径1 /api/order-collab 应正常返回');
  assert.equal(collabComplete.body.data.status, 'FULFILLING');
  assertStillSafe('路径1 /api/order-collab');

  // ── 路径 2：/api/merchant/orders/:id/status（商家端「完成」主按钮） ────────
  const merchantComplete = await merchantStatus(guardOrderId, {
    status: 'COMPLETED',
    deliveryCode: guardDeliveryCode
  });
  assert.equal(merchantComplete.response.status, 200, '路径2 /api/merchant/orders/:id/status 应正常返回');
  assert.equal(merchantComplete.body.data.status, 'FULFILLING');
  assertStillSafe('路径2 /api/merchant/orders/:id/status');

  // ── 路径 3：管理端 /api/admin/orders/:id/status（平台代履约完成） ──────────
  const adminComplete = await api(`/api/admin/orders/${guardOrderId}/status`, {
    method: 'POST',
    headers: jsonHeaders(adminToken),
    body: JSON.stringify({ status: 'COMPLETED', completionNote: '平台线下核验车辆已归还但系统状态未同步' })
  });
  assert.equal(adminComplete.response.status, 200, '路径3 管理端订单状态应正常返回');
  assertStillSafe('路径3 /api/admin/orders/:id/status');

  // ── 路径 4：商家售后 /api/merchant/after-sales/:id/status 的 CLOSED 分支 ───
  // 非退款类售后关闭也会把订单标记完成，且会先解冻再激活分账 —— 必须同样被守卫拦住。
  const afterSale = await api('/api/after-sales', {
    method: 'POST',
    headers: jsonHeaders(guardUserToken),
    body: JSON.stringify({ orderId: guardOrderId, type: 'RETURN', reason: '车辆已归还，售后登记核验' })
  });
  assert.equal(afterSale.response.status, 201);
  // 售后提交会冻结在途分账（既有行为），记下冻结前的状态用于证明解冻路径也被守住。
  assert.equal(settlementStatusOf(guardOrderId), 'FROZEN');

  const closed = await api(`/api/merchant/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST',
    headers: jsonHeaders(merchantToken),
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '车辆已归还，系统状态待同步，先关闭售后。' })
  });
  assert.equal(closed.response.status, 200, '路径4 商家售后 CLOSED 应正常返回');
  assertStillSafe('路径4 商家售后 CLOSED');

  // 收尾：守卫从入口覆盖全部 4 条路径，分账仍一分未动。
  assert.equal(settlementsOf(guardOrderId)[0].deliveredAt, '');
  assert.equal(settlementsOf(guardOrderId)[0].availableAt, '');
});

test('⑧ ★ 结构断言：资金侧守卫与状态侧收口必须留在源码里', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'app.js'), 'utf8');

  // 守卫字符串本身（两个关键条件缺一不可）。
  assert.ok(source.includes("orderKind === 'RENTAL'"), 'app.js 必须保留 orderKind === \'RENTAL\' 判断');
  assert.ok(source.includes("rental?.status !== 'RETURNED'"), 'app.js 必须保留 rental?.status !== \'RETURNED\' 判断');
  assert.ok(
    source.includes("if (order.orderKind === 'RENTAL' && order.rental?.status !== 'RETURNED') return [];"),
    'app.js 必须保留完整的资金侧入口守卫语句'
  );

  // 守卫必须落在 activateOrderSettlements 函数体开头，而不是别处。
  const activationIndex = source.indexOf('function activateOrderSettlements(data, order, now)');
  assert.notEqual(activationIndex, -1, 'app.js 必须仍有 activateOrderSettlements 定义');
  const guardIndex = source.indexOf("if (order.orderKind === 'RENTAL' && order.rental?.status !== 'RETURNED') return [];");
  const guardOffset = guardIndex - activationIndex;
  assert.ok(guardOffset > 0 && guardOffset < 400,
    `守卫必须紧邻 activateOrderSettlements 定义处（偏移 ${guardOffset}），防止被挪到某个调用点后面漏掉其余入口`);

  // 状态侧收口：不再存在任何「直接赋 COMPLETED」的旁路（全部经 resolveOrderCompletion）。
  assert.equal(/\.status\s*=\s*'COMPLETED'/.test(source), false,
    'app.js 不得再出现 `.status = \'COMPLETED\'` 直赋值，必须走 resolveOrderCompletion 收口');

  // createSettlements 一行未改：它仍只按订单项金额建账，不含任何租赁分支。
  const createIndex = source.indexOf('function createSettlements(data, order, now)');
  assert.notEqual(createIndex, -1, 'app.js 必须仍有 createSettlements 定义');
  const createBody = source.slice(createIndex, createIndex + 2200);
  assert.equal(createBody.includes('orderKind'), false,
    'createSettlements 不得为租赁新增分支（押金隔离靠 L1 数据形态，不靠函数内特判）');
});

test('⑨ ★ SALE 订单回归：交付核验后仍置 COMPLETED 并激活分账', async () => {
  const session = await loginWeChat('rental_sm_sale_regression');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: SALE_PRODUCT_ID, quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;
  assert.equal(created.body.data.orderKind, 'SALE');
  await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(settlementStatusOf(orderId), 'PENDING_DELIVERY');

  await pickUpOrder(orderId);
  const deliveryCode = await deliveryCodeOf(orderId, session.token);

  const completed = await merchantStatus(orderId, { status: 'COMPLETED', deliveryCode });
  assert.equal(completed.response.status, 200);
  assert.equal(completed.body.data.status, 'COMPLETED');

  const order = orderOf(orderId);
  assert.equal(order.status, 'COMPLETED');
  assert.equal(Object.prototype.hasOwnProperty.call(order, 'rental'), false);
  assert.ok(
    ACTIVATED_SETTLEMENT_STATUSES.includes(settlementStatusOf(orderId)),
    `售卖单交付核验后分账必须进入账期，实际 ${settlementStatusOf(orderId)}`
  );
});
