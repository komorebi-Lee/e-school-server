const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'rental-order-admin';
process.env.ADMIN_PASSWORD = 'rental-order-admin-password-123';

/**
 * 租赁下单 + 押金隔离三层防线的端到端回归。
 *
 * 本文件的核心不是「租赁单能下单」，而是**押金绝不污染交易对价**：
 * 分账与售后退款都用 `item.subtotalInCents || item.priceInCents * item.quantity`
 * 取值（注意是 `||`，0 或空会回退）。租赁商品售价 319900、日租 1500，
 * 一旦回退取到售价，商家分账会膨胀两个数量级且打款不可逆。
 *
 * - L1：押金不写入 `order.items[].subtotalInCents`（断言 ②）
 * - L2：`priceInCents` 承载租金而非售价（断言 ③）
 * - L3：断言 ③⑨⑩ 构成回归护栏
 *
 * 注：`prod_ebike_rent_001` 是历史命名遗留的售卖车（价格 319900 是既有测试的金额锚点），
 * 真正的租赁种子商品是 `prod_ebike_rent_002`。
 */
const RENTAL_PRODUCT_ID = 'prod_ebike_rent_002';
const SALE_PRODUCT_ID = 'prod_ebike_001';

const UNIT_RENT_IN_CENTS = 1500;
const DEPOSIT_IN_CENTS = 29900;
const RENTAL_UNITS = 3;
const RENT_TOTAL_IN_CENTS = UNIT_RENT_IN_CENTS * RENTAL_UNITS; // 4500
const COMMISSION_RATE_PERCENT = 2;
const SALE_PRICE_IN_CENTS = 239900;
const RENTAL_REFERENCE_PRICE_IN_CENTS = 319900;

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-rental-order-'));
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
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

/**
 * 下一张租赁单：默认租 3 天、1 台、免配送。
 *
 * @param {string} token 用户令牌。
 * @param {{rentalUnits?: number, idempotencyKey?: string}} [options] 可选覆盖项。
 * @returns {Promise<{response: object, body: object}>} 接口响应。
 */
async function createRentalOrder(token, options = {}) {
  const { rentalUnits = RENTAL_UNITS, idempotencyKey = '' } = options;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
  return api('/api/orders', {
    method: 'POST',
    headers,
    body: JSON.stringify({ items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits }] })
  });
}

async function confirmPayment(paymentId, token) {
  return api(`/api/payment-orders/${paymentId}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
}

// 断言 ①~⑥ 共用同一张租赁单，避免重复建单干扰分账聚合。
let rentalToken = '';
let rentalOrder = null;
let rentalPaymentOrder = null;

test('① 租 3 天 + 押金、免配送时 totalInCents 恰好是 34400', async () => {
  const session = await loginWeChat('rental_order_buyer');
  rentalToken = session.token;

  const created = await createRentalOrder(rentalToken);
  assert.equal(created.response.status, 201);
  rentalOrder = created.body.data;
  rentalPaymentOrder = created.body.paymentOrder;

  // 4500（租金）+ 29900（押金）= 34400
  assert.equal(RENT_TOTAL_IN_CENTS + DEPOSIT_IN_CENTS, 34400);
  assert.equal(rentalOrder.totalInCents, 34400);
  assert.equal(rentalOrder.feeSummary.deliveryFeeInCents, 0);
  assert.equal(rentalOrder.status, 'PENDING_PAYMENT');
  assert.equal(rentalOrder.paymentStatus, 'UNPAID');

  // 支付单必须收足「租金 + 押金」，否则押金根本没被收上来。
  assert.equal(rentalPaymentOrder.amountInCents, 34400);
  // 同时把「这笔收款里多少是租金、多少是押金」暴露出来，供后续报表任务使用。
  assert.equal(rentalPaymentOrder.rentAmountInCents, RENT_TOTAL_IN_CENTS);
  assert.equal(rentalPaymentOrder.depositInCents, DEPOSIT_IN_CENTS);
});

test('② L1：押金绝不写入 order.items[].subtotalInCents', () => {
  assert.equal(rentalOrder.items.length, 1);
  const item = rentalOrder.items[0];

  assert.equal(item.subtotalInCents, 4500);

  // 订单项金额求和恰好是租金，而不是「租金 + 押金」。
  const itemsSum = rentalOrder.items.reduce((sum, row) => sum + Number(row.subtotalInCents || 0), 0);
  assert.equal(itemsSum, RENT_TOTAL_IN_CENTS);
  assert.notEqual(itemsSum, rentalOrder.totalInCents);
  // 押金只存在于订单层与 rentalDeposits，不存在于任何订单项字段里。
  assert.equal(JSON.stringify(rentalOrder.items).includes(String(DEPOSIT_IN_CENTS)), false);
});

test('③ ★ L2：order.items[0].priceInCents 承载租金而非售价，堵住 || 回退膨胀', () => {
  const item = rentalOrder.items[0];

  assert.equal(item.priceInCents, 4500);
  assert.equal(item.quantity, 1);
  // 售卖路径的不变量（subtotalInCents === priceInCents × quantity）在租赁路径同样成立，
  // 这样 `||` 回退取到的就是正确的整项租金。
  assert.equal(item.subtotalInCents, item.priceInCents * item.quantity);
  assert.equal(item.rentalUnits, RENTAL_UNITS);
  assert.equal(item.rentalUnit, 'DAY');
  // 售价只作展示，不参与任何金额计算。
  assert.equal(item.originalPriceInCents, RENTAL_REFERENCE_PRICE_IN_CENTS);
  // 日租单价可由「整项租金 / 租期」还原，不需要额外字段。
  assert.equal(item.priceInCents / item.rentalUnits, UNIT_RENT_IN_CENTS);

  // 直接复现分账的取值表达式（含 `||` 回退），回退结果必须也是租金。
  const gross = Number(item.subtotalInCents || (Number(item.priceInCents || 0) * Number(item.quantity || 0)));
  assert.equal(gross, RENT_TOTAL_IN_CENTS);

  // 把 subtotalInCents 强制置空后走回退分支：结果仍是 4500，而不是 319900（膨胀）
  // 也不是 1500（按日租单价少算 2/3）。
  const fallbackGross = Number(0 || (Number(item.priceInCents || 0) * Number(item.quantity || 0)));
  assert.equal(fallbackGross, RENT_TOTAL_IN_CENTS);
  assert.notEqual(fallbackGross, item.originalPriceInCents);
  assert.notEqual(fallbackGross, UNIT_RENT_IN_CENTS);
});

test('④ 支付成功后分账基数只有租金，平台抽佣按租金计算', async () => {
  const paid = await confirmPayment(rentalPaymentOrder.id, rentalToken);
  assert.equal(paid.response.status, 200);
  assert.equal(paid.body.data.order.status, 'PAID');

  const data = store.read();
  const settlements = data.settlements.filter((item) => item.orderId === rentalOrder.id);
  assert.equal(settlements.length, 1);

  const settlement = settlements[0];
  assert.equal(settlement.amountInCents, 4500);
  assert.equal(settlement.commissionRatePercent, COMMISSION_RATE_PERCENT);
  assert.equal(settlement.platformFeeInCents, Math.round(4500 * 2 / 100));
  assert.equal(settlement.payableAmountInCents, 4500 - settlement.platformFeeInCents);
  assert.equal(settlement.merchantId, 'merchant_001');
});

test('⑤ rentalDeposits 有且仅有 1 条：金额 29900、状态 HELD', () => {
  const data = store.read();
  const deposits = data.rentalDeposits.filter((item) => item.orderId === rentalOrder.id);

  assert.equal(deposits.length, 1);
  const deposit = deposits[0];
  assert.ok(deposit.id.startsWith('dep_'));
  assert.equal(deposit.amountInCents, 29900);
  assert.equal(deposit.status, 'HELD');
  assert.equal(deposit.refundedInCents, 0);
  assert.equal(deposit.deductionInCents, 0);
  assert.equal(deposit.userId, rentalOrder.userId);
  assert.equal(deposit.merchantId, 'merchant_001');
  assert.equal(deposit.createdAt, rentalOrder.createdAt);
});

test('⑥ 订单形态与租赁摘要字段', () => {
  assert.equal(rentalOrder.orderKind, 'RENTAL');
  assert.equal(rentalOrder.rental.status, 'RENTING');
  assert.equal(rentalOrder.rental.units, RENTAL_UNITS);
  assert.equal(rentalOrder.rental.unit, 'DAY');
  assert.equal(rentalOrder.rental.rentAmountInCents, 4500);
  assert.equal(rentalOrder.rental.depositInCents, 29900);

  // dueAt = 下单时间 + 3 个 DAY
  const expectedDueAt = new Date(rentalOrder.createdAt).getTime() + RENTAL_UNITS * 24 * 60 * 60 * 1000;
  assert.equal(new Date(rentalOrder.rental.dueAt).getTime(), expectedDueAt);
});

test('⑦ 入参校验：越界 / 缺失 / 错配 / 混单一律 400 且零副作用', async () => {
  const session = await loginWeChat('rental_order_validation');
  const token = session.token;
  const before = store.read();
  const orderCountBefore = before.orders.length;
  const depositCountBefore = before.rentalDeposits.length;

  const cases = [
    ['售卖商品传 rentalUnits', { items: [{ productId: SALE_PRODUCT_ID, quantity: 1, rentalUnits: 3 }] }],
    ['租赁商品缺 rentalUnits', { items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1 }] }],
    ['租期低于 minUnits（0）', { items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: 0 }] }],
    ['租期高于 maxUnits（31）', { items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: 31 }] }],
    ['租期非整数', { items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: 1.5 }] }],
    ['租赁商品数量不为 1', { items: [{ productId: RENTAL_PRODUCT_ID, quantity: 2, rentalUnits: 3 }] }],
    ['售卖与租赁混装', {
      items: [
        { productId: SALE_PRODUCT_ID, quantity: 1 },
        { productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: 3 }
      ]
    }]
  ];

  for (const [label, body] of cases) {
    const result = await api('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    });
    assert.equal(result.response.status, 400, `${label} 必须返回 400`);
    assert.equal(result.body.error.code, 'VALIDATION_ERROR', `${label} 错误码必须是 VALIDATION_ERROR`);
  }

  // 失败请求不得留下任何副作用：订单与押金都不能被创建。
  const after = store.read();
  assert.equal(after.orders.length, orderCountBefore);
  assert.equal(after.rentalDeposits.length, depositCountBefore);
});

test('⑧ 同一 Idempotency-Key 重复提交只产生 1 个订单 + 1 条押金', async () => {
  const session = await loginWeChat('rental_order_idempotent');
  const idempotencyKey = 'rental-order-idempotency-001';

  const first = await createRentalOrder(session.token, { idempotencyKey });
  assert.equal(first.response.status, 201);

  const repeated = await createRentalOrder(session.token, { idempotencyKey });
  assert.equal(repeated.response.status, 200);
  assert.equal(repeated.body.idempotencyReused, true);
  assert.equal(repeated.body.data.id, first.body.data.id);

  const data = store.read();
  const orderId = first.body.data.id;
  assert.equal(data.orders.filter((order) => order.id === orderId).length, 1);
  assert.equal(data.orders.filter((order) => order.userId === session.userId).length, 1);
  // 幂等重放不得重复写入押金（押金写入必须在幂等短路之后）。
  assert.equal(data.rentalDeposits.filter((item) => item.orderId === orderId).length, 1);
});

test('⑨ ★ 全局扫描：押金金额不出现在任何 settlements 记录中', () => {
  const data = store.read();
  assert.ok(data.settlements.length > 0, '前置条件：应已产生分账记录');

  // 逐个数值字段扫描：押金若被当作交易对价汇总，会以 amountInCents /
  // payableAmountInCents / platformFeeInCents 等任意数值字段的形式出现。
  const offenders = [];
  for (const settlement of data.settlements) {
    for (const [key, value] of Object.entries(settlement)) {
      if (typeof value !== 'number') continue;
      if (value === DEPOSIT_IN_CENTS) offenders.push(`${settlement.id}.${key}`);
    }
  }
  assert.deepEqual(offenders, [], `押金金额不得出现在 settlements 的任何数值字段中：${offenders.join(', ')}`);

  // 更强的一条：租赁单的分账金额必须**恰好等于租金**（既不是押金，也不是租金 + 押金）。
  const rentalOrderIds = new Set(
    data.orders.filter((order) => order.orderKind === 'RENTAL').map((order) => order.id)
  );
  const rentalSettlements = data.settlements.filter((item) => rentalOrderIds.has(item.orderId));
  assert.ok(rentalSettlements.length > 0, '租赁单支付成功后必须生成分账记录');
  for (const settlement of rentalSettlements) {
    const order = data.orders.find((item) => item.id === settlement.orderId);
    assert.equal(settlement.amountInCents, order.rental.rentAmountInCents);
    assert.ok(settlement.amountInCents < DEPOSIT_IN_CENTS,
      `分账金额 ${settlement.amountInCents} 不得包含押金 ${DEPOSIT_IN_CENTS}`);
  }
});

test('⑩ ★ 回归护栏：SALE 订单 orderKind 为 SALE 且不含 rental 字段', async () => {
  const session = await loginWeChat('rental_order_sale_regression');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: SALE_PRODUCT_ID, quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);

  const order = created.body.data;
  assert.equal(order.orderKind, 'SALE');
  // 售卖单不输出 rental 字段（而不是输出 null），避免前端误判形态。
  assert.equal(Object.prototype.hasOwnProperty.call(order, 'rental'), false);
  assert.equal(order.items[0].priceInCents, SALE_PRICE_IN_CENTS);
  assert.equal(order.items[0].subtotalInCents, SALE_PRICE_IN_CENTS);
  assert.equal(order.totalInCents, SALE_PRICE_IN_CENTS);
  // 售卖单不产生押金。
  assert.equal(store.read().rentalDeposits.filter((item) => item.orderId === order.id).length, 0);
  // 支付单上的押金字段为 0，让消费方无需判空。
  assert.equal(created.body.paymentOrder.rentAmountInCents, 0);
  assert.equal(created.body.paymentOrder.depositInCents, 0);
});

test('⑪ T36 基线：租赁单全额售后退款只退租金，押金仍为 HELD', async () => {
  const session = await loginWeChat('rental_order_aftersale');
  const created = await createRentalOrder(session.token);
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;

  const paid = await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(paid.response.status, 200);

  const afterSale = await api('/api/after-sales', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ orderId, type: 'REFUND', reason: '租赁订单退款回归基线' })
  });
  assert.equal(afterSale.response.status, 201);

  const data = store.read();
  const record = data.afterSales.find((item) => item.orderId === orderId);
  assert.ok(record);
  // 售后退款按订单项金额反推，而订单项只含租金 ⇒ 退款额恰好是租金，不含押金。
  assert.equal(record.refundAmountInCents, RENT_TOTAL_IN_CENTS);
  assert.equal(record.refundItems[0].unitPriceInCents, RENT_TOTAL_IN_CENTS);
  assert.ok(record.refundAmountInCents < DEPOSIT_IN_CENTS);

  const deposits = data.rentalDeposits.filter((item) => item.orderId === orderId);
  assert.equal(deposits.length, 1);
  // 已知限制（归 T36「押金结算」）：售后退款不会自动退还押金，押金仍处于 HELD。
  assert.equal(deposits[0].status, 'HELD');
  assert.equal(deposits[0].refundedInCents, 0);
});
