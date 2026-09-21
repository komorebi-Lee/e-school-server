const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'rental-rs-admin';
process.env.ADMIN_PASSWORD = 'rental-rs-admin-password-123';

/**
 * 归还核验后的库存归位 + `RETURN_RESTORE` 流水 + 押金转入待退（T35）。
 *
 * 本文件守护两件事：
 *
 * 1. **库存必须归位，且只能归位一次。** 租赁车在支付时被 `consumeOrderStock` 扣掉，
 *    归还核验后必须回到可租池 —— 否则每租一次就永久少一辆车。同时「只能一次」是
 *    资损级的：重复回补会让库存虚增，等于凭空多出可租车辆。
 *
 * 2. **两种「回补」必须严格区分。** 售后回补（`RESTORE`）的语义是「交易取消，
 *    钱退回去、货回到池子」；归还回补（`RETURN_RESTORE`）是「租赁周期正常结束」。
 *    混用会让库存流水无法复盘 —— 台账再也答不出「这个月有多少车是卖出去的、
 *    多少是租出去又还回来的」。
 *
 * 幂等由两层独立保证，断言 ② 同时验证这两层：
 * - 状态机层：重复 `RETURN_VERIFY` 在迁移前抛 `409 RENTAL_ALREADY_RETURNED`，
 *   库存回补函数根本不会被调用到；
 * - 函数层：`restoreRentalStock` 只处理 `stockReservation === 'CONSUMED'`，
 *   回补后置为 `'RESTORED'`，即使被重复调用也不会二次加库存。
 */
const RENTAL_PRODUCT_ID = 'prod_ebike_rent_002';
const SALE_PRODUCT_ID = 'prod_ebike_001';
const MERCHANT_ID = 'merchant_001';
const RENTAL_UNITS = 3;
const RENTAL_SEED_STOCK = 5;

let server;
let baseUrl;
let tempDirectory;
let store;
let merchantToken = '';

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-rental-rs-'));
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
    headers: jsonHeaders(merchantUser.token),
    body: JSON.stringify({ merchantId: MERCHANT_ID })
  });
  assert.equal(merchantLogin.response.status, 200);
  merchantToken = merchantLogin.body.data.token;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

async function api(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

function jsonHeaders(token) {
  return { 'content-type': 'application/json', authorization: `Bearer ${token}` };
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

async function collab(token, body) {
  return api('/api/order-collab', {
    method: 'POST',
    headers: jsonHeaders(token),
    body: JSON.stringify(body)
  });
}

async function confirmPayment(paymentId, token) {
  return api(`/api/payment-orders/${paymentId}/confirm`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` }
  });
}

function stockOf(productId) {
  const product = store.read().products.find((item) => item.id === productId);
  assert.ok(product, `商品 ${productId} 必须存在`);
  return Number(product.stock || 0);
}

function orderOf(orderId) {
  return store.read().orders.find((item) => item.id === orderId);
}

function depositsOf(orderId) {
  return store.read().rentalDeposits.filter((item) => item.orderId === orderId);
}

/**
 * 某订单产生的库存流水。
 *
 * @param {string} orderId 订单 id。
 * @param {string} [movementType] 可选：只取某个类型。
 * @returns {object[]} 流水记录。
 */
function movementsOf(orderId, movementType) {
  return store.read().stockMovements
    .filter((item) => item.referenceId === orderId)
    .filter((item) => !movementType || item.movementType === movementType);
}

/** 商家确认履约 = 用户到店取车（交付取车，此时不归还库存）。 */
async function pickUp(orderId) {
  const accepted = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'ACCEPT',
    orderId,
    note: '已确认库存，用户到店取车。'
  });
  assert.equal(accepted.response.status, 200);
  return accepted;
}

/**
 * 下一张已支付的租赁单（单台、租 3 天）。
 *
 * @param {string} userCode 微信登录 code。
 * @returns {Promise<{token: string, orderId: string, orderNo: string, userId: string}>} 订单上下文。
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
  return {
    token: session.token,
    userId: session.userId,
    orderId: created.body.data.id,
    orderNo: created.body.data.orderNo
  };
}

/** 把一张租赁单一路推到「归还核验完成」。 */
async function driveToReturned(order) {
  await pickUp(order.orderId);
  const requested = await collab(order.token, {
    role: 'USER',
    action: 'RETURN_REQUEST',
    orderId: order.orderId,
    note: '车已还到店内。'
  });
  assert.equal(requested.response.status, 200);
  const verified = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId: order.orderId,
    note: '车辆核验无损。'
  });
  assert.equal(verified.response.status, 200);
  return verified;
}

test('① ★ 归还核验后库存归位：5 → 4（支付扣减）→ 5（归还回补），且恰好 1 条 RETURN_RESTORE', async () => {
  assert.equal(stockOf(RENTAL_PRODUCT_ID), RENTAL_SEED_STOCK,
    '前置条件：租赁商品种子库存为 5（本文件是第一个动这张单的用例）');

  const session = await loginWeChat('rental_rs_main');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: RENTAL_PRODUCT_ID, quantity: 1, rentalUnits: RENTAL_UNITS }] })
  });
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;

  // 建单只是预占：总库存不变（reservedStock 才是被占用的那一份）。
  assert.equal(stockOf(RENTAL_PRODUCT_ID), RENTAL_SEED_STOCK);

  await confirmPayment(created.body.paymentOrder.id, session.token);
  assert.equal(stockOf(RENTAL_PRODUCT_ID), 4, '支付确认后必须扣减库存（车交到用户手上）');

  await pickUp(orderId);
  assert.equal(stockOf(RENTAL_PRODUCT_ID), 4, '交付取车不得归还库存');

  await collab(session.token, { role: 'USER', action: 'RETURN_REQUEST', orderId, note: '已还车。' });
  assert.equal(stockOf(RENTAL_PRODUCT_ID), 4, '归还「申请」不得归还库存，只有核验通过才算');

  const verified = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId,
    note: '车辆核验无损。'
  });
  assert.equal(verified.response.status, 200);
  assert.equal(stockOf(RENTAL_PRODUCT_ID), RENTAL_SEED_STOCK, '归还核验后库存必须归位');

  const restoreMovements = movementsOf(orderId, 'RETURN_RESTORE');
  assert.equal(restoreMovements.length, 1, '必须恰好新增 1 条 RETURN_RESTORE 流水');
  const movement = restoreMovements[0];
  assert.equal(movement.quantity, 1);
  assert.equal(movement.stockBefore, 4);
  assert.equal(movement.stockAfter, RENTAL_SEED_STOCK);
  assert.equal(movement.operator, 'RENTAL_FLOW');
  assert.equal(movement.productId, RENTAL_PRODUCT_ID);
  assert.equal(movement.referenceId, orderId);
  assert.equal(movement.referenceNo, created.body.data.orderNo);

  // ★ 两种回补严格区分：归还链路里绝不能出现售后的 RESTORE。
  assert.equal(movementsOf(orderId, 'RESTORE').length, 0,
    '租赁归还不得写入 RESTORE（那是售后回补的类型）');
  assert.equal(orderOf(orderId).stockReservation, 'RESTORED');
});

test('② ★ 幂等：重复 RETURN_VERIFY → 409 RENTAL_ALREADY_RETURNED，库存与流水都不变', async () => {
  const order = await createPaidRentalOrder('rental_rs_idempotent');
  await driveToReturned(order);

  const stockAfterReturn = stockOf(RENTAL_PRODUCT_ID);
  const movementsAfterReturn = movementsOf(order.orderId).length;
  assert.equal(movementsOf(order.orderId, 'RETURN_RESTORE').length, 1);

  // 商家双击 / 客户端重试：必须拿到一个可识别的「已经归还」信号，而不是通用非法动作。
  const repeated = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId: order.orderId,
    note: '重复核验。'
  });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, 'RENTAL_ALREADY_RETURNED');

  // ★ 最关键的一条：重复提交绝不能二次回补库存（否则库存虚增 = 凭空多出可租车辆）。
  assert.equal(stockOf(RENTAL_PRODUCT_ID), stockAfterReturn, '重复核验不得改动库存');
  assert.equal(movementsOf(order.orderId).length, movementsAfterReturn, '重复核验不得新增任何库存流水');
  assert.equal(movementsOf(order.orderId, 'RETURN_RESTORE').length, 1);

  // 状态机与订单状态都保持终态。
  assert.equal(orderOf(order.orderId).rental.status, 'RETURNED');
  assert.equal(orderOf(order.orderId).status, 'COMPLETED');

  // ★ 函数层幂等（单元级，绕开状态机）：即使有人直接重复调用回补函数，也不得二次加库存。
  // 这一层是独立于状态机的第二道防线 —— 将来若有新的调用方忘记前置校验，它仍然兜住。
  const { restoreRentalStock } = require('../src/domain/inventory');
  const synthetic = {
    products: [{ id: 'p_synth', name: '合成车', merchantId: MERCHANT_ID, stock: 4 }],
    stockMovements: []
  };
  const syntheticOrder = {
    id: 'ord_synth',
    orderNo: 'SYNTH001',
    orderKind: 'RENTAL',
    items: [{ productId: 'p_synth', quantity: 1 }],
    stockReservation: 'CONSUMED'
  };
  assert.equal(restoreRentalStock(synthetic, syntheticOrder), true, '首次回补应生效');
  assert.equal(synthetic.products[0].stock, 5);
  assert.equal(synthetic.stockMovements.length, 1);
  assert.equal(restoreRentalStock(synthetic, syntheticOrder), false, '第二次回补必须被拒绝');
  assert.equal(synthetic.products[0].stock, 5, '第二次回补不得再加库存');
  assert.equal(synthetic.stockMovements.length, 1, '第二次回补不得新增流水');
  assert.equal(syntheticOrder.stockReservation, 'RESTORED');
  // 非租赁单不得走这条回补（售卖单的回补语义是「退款」，由 restoreOrderStock 负责）。
  assert.equal(
    restoreRentalStock(synthetic, { ...syntheticOrder, orderKind: 'SALE', stockReservation: 'CONSUMED' }),
    false
  );
  assert.equal(synthetic.products[0].stock, 5);
});

test('③ ★ 两个映射表都含 RETURN_RESTORE，键集完全一致，且管理端渲染出中文标签', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const labelBody = source.match(/const movementTypeLabels=\{([^}]*)\};/);
  const badgeBody = source.match(/const movementBadges=\{([^}]*)\};/);
  assert.ok(labelBody, 'admin.js 必须仍有 movementTypeLabels 表');
  assert.ok(badgeBody, 'admin.js 必须仍有 movementBadges 表');

  const keysOf = (body) => body.split(',').map((pair) => pair.split(':')[0].trim()).sort();
  const labelKeys = keysOf(labelBody[1]);
  const badgeKeys = keysOf(badgeBody[1]);

  // 键集必须完全一致：只补一个表会导致「有中文没徽章」或「有徽章显示原始英文码」。
  assert.deepEqual(labelKeys, badgeKeys, '两个映射表的键集必须完全一致');
  assert.ok(labelKeys.includes('RETURN_RESTORE'), 'movementTypeLabels 必须含 RETURN_RESTORE');
  assert.ok(badgeKeys.includes('RETURN_RESTORE'), 'movementBadges 必须含 RETURN_RESTORE');
  assert.equal(labelKeys.length, 8, '补完后应为 8 个键（原 7 + RETURN_RESTORE）');

  // 端到端渲染：真的走一遍管理端台账视图，确认没有把原始英文码漏到界面上。
  const runnable = source.replace('const state={data:null,', 'const state={data:{settings:{}},');
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        selector,
        textContent: '',
        innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {},
        querySelector: (childSelector) => element(`${selector} ${childSelector}`)
      });
    }
    return elements.get(selector);
  };
  const app = vm.runInNewContext(`${runnable}; ({ state, render })`, {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }),
    alert() {},
    prompt: () => null
  }, { timeout: 5000 });

  app.state.view = 'stock';
  app.state.data = {
    settings: {},
    merchants: [{ id: MERCHANT_ID, name: '狮山校园车行' }],
    stockMovements: [
      {
        id: 'mov_return_001',
        productId: RENTAL_PRODUCT_ID,
        productName: '远行 租赁版',
        merchantId: MERCHANT_ID,
        movementType: 'RETURN_RESTORE',
        quantity: 1,
        stockBefore: 4,
        stockAfter: 5,
        reservedBefore: 0,
        reservedAfter: 0,
        referenceId: 'order_return_001',
        referenceNo: 'CG20260909001',
        operator: 'RENTAL_FLOW',
        createdAt: '2026-09-09T08:00:00.000Z'
      }
    ]
  };

  app.render();
  const html = elements.get('#content').innerHTML;
  assert.ok(html.includes('租赁归还回补'), '管理端必须把 RETURN_RESTORE 渲染成中文标签');
  assert.equal(html.includes('RETURN_RESTORE'), false,
    '管理端不得把原始英文码漏到界面上（说明映射表没命中）');
  assert.ok(html.includes('4 → 5'), '台账必须展示回补前后的库存变化');
  assert.ok(html.includes('RENTAL_FLOW'), '台账必须展示操作来源');
});

test('④ ★ 租赁单走售后退款时回补类型是 RESTORE，不是 RETURN_RESTORE', async () => {
  const order = await createPaidRentalOrder('rental_rs_refund');
  assert.equal(stockOf(RENTAL_PRODUCT_ID), 4, '支付后库存已扣减');

  // 未走归还核验，直接申请售后退款：这是「交易取消」而不是「租赁周期结束」。
  const afterSale = await api('/api/after-sales', {
    method: 'POST',
    headers: jsonHeaders(order.token),
    body: JSON.stringify({ orderId: order.orderId, type: 'REFUND', reason: '租赁单退款回补类型回归' })
  });
  assert.equal(afterSale.response.status, 201);

  const closed = await api(`/api/merchant/after-sales/${afterSale.body.data.id}/status`, {
    method: 'POST',
    headers: jsonHeaders(merchantToken),
    body: JSON.stringify({ status: 'CLOSED', resolutionNote: '同意退款，车未租出。' })
  });
  assert.equal(closed.response.status, 200);

  // 退款回补：类型必须是 RESTORE。
  const restores = movementsOf(order.orderId, 'RESTORE');
  assert.equal(restores.length, 1, '售后退款必须写入 1 条 RESTORE 流水');
  assert.equal(restores[0].quantity, 1);
  assert.equal(restores[0].operator, 'ORDER_FLOW');

  // ★ 严格区分：这条链路绝不能产出 RETURN_RESTORE。
  assert.equal(movementsOf(order.orderId, 'RETURN_RESTORE').length, 0,
    '售后退款不得写入 RETURN_RESTORE（那是归还回补的类型）');
  assert.equal(stockOf(RENTAL_PRODUCT_ID), RENTAL_SEED_STOCK, '退款后库存回到 5');

  // 状态机未被触碰：订单走的是 CANCELLED，租赁状态仍是 RENTING。
  assert.equal(orderOf(order.orderId).status, 'CANCELLED');
  assert.equal(orderOf(order.orderId).rental.status, 'RENTING');
});

test('⑤ ★ 归还核验后押金从 HELD 转入 REFUND_PENDING 并打上 refundPendingAt', async () => {
  const order = await createPaidRentalOrder('rental_rs_deposit');

  const heldDeposits = depositsOf(order.orderId);
  assert.equal(heldDeposits.length, 1);
  assert.equal(heldDeposits[0].status, 'HELD');
  assert.equal(heldDeposits[0].refundPendingAt, undefined);

  await driveToReturned(order);

  const deposits = depositsOf(order.orderId);
  assert.equal(deposits.length, 1);
  const deposit = deposits[0];
  assert.equal(deposit.status, 'REFUND_PENDING', '归还核验后押金必须转入待退');
  assert.ok(deposit.refundPendingAt, 'refundPendingAt 必须非空');
  assert.equal(Number.isNaN(new Date(deposit.refundPendingAt).getTime()), false,
    'refundPendingAt 必须是可解析的时间戳');

  // 只改状态、不动金额：实际退款额要等车况核验（是否有损坏扣款），那是 T36 的职责。
  assert.equal(deposit.amountInCents, 29900);
  assert.equal(deposit.refundedInCents, 0);
  assert.equal(deposit.deductionInCents, 0);

  // 幂等：重复调用不得刷新 refundPendingAt（否则「待退时长」指标会失真）。
  const repeated = await collab(merchantToken, {
    role: 'MERCHANT',
    action: 'RETURN_VERIFY',
    orderId: order.orderId,
    note: '重复核验。'
  });
  assert.equal(repeated.response.status, 409);
  assert.equal(depositsOf(order.orderId)[0].refundPendingAt, deposit.refundPendingAt,
    '重复核验不得刷新 refundPendingAt');
});

test('⑥ ★ 流水类型白名单必须与真正写入的 movementType 同步', async () => {
  // 归还核验产生的 RETURN_RESTORE 必须能被商家台账按类型过滤到。
  const order = await createPaidRentalOrder('rental_rs_whitelist');
  await driveToReturned(order);

  const ledger = await api(`/api/merchant/stock-movements?type=RETURN_RESTORE`, {
    headers: { authorization: `Bearer ${merchantToken}` }
  });
  assert.equal(ledger.response.status, 200,
    'RETURN_RESTORE 必须在白名单里，否则商家过滤会拿到 400');
  // 台账按商家维度聚合，本文件前面几个用例也产生了 RETURN_RESTORE，所以断言「包含本条」
  // 而不是断言总数（总数会随用例顺序漂移，是脆弱的耦合断言）。
  assert.ok(ledger.body.total >= 1, '按 RETURN_RESTORE 过滤必须能查到数据');
  assert.ok(ledger.body.data.every((item) => item.movementType === 'RETURN_RESTORE'),
    '过滤结果必须只含 RETURN_RESTORE');
  const mine = ledger.body.data.find((item) => item.referenceId === order.orderId);
  assert.ok(mine, '必须能按类型查到自己这张租赁单的归还回补流水');
  assert.equal(mine.quantity, 1);

  // 对照：不存在的类型仍必须被拒绝（白名单没有被放宽成「什么都收」）。
  const bogus = await api('/api/merchant/stock-movements?type=NOT_A_TYPE', {
    headers: { authorization: `Bearer ${merchantToken}` }
  });
  assert.equal(bogus.response.status, 400);
  assert.equal(bogus.body.error.code, 'VALIDATION_ERROR');
});

test('⑦ 回归：SALE 链路不产生任何 RETURN_RESTORE 流水', async () => {
  const session = await loginWeChat('rental_rs_sale');
  const created = await api('/api/orders', {
    method: 'POST',
    headers: jsonHeaders(session.token),
    body: JSON.stringify({ items: [{ productId: SALE_PRODUCT_ID, quantity: 1 }] })
  });
  assert.equal(created.response.status, 201);
  const orderId = created.body.data.id;
  await confirmPayment(created.body.paymentOrder.id, session.token);
  await pickUp(orderId);

  const code = (await api(`/api/orders/${orderId}`, {
    headers: { authorization: `Bearer ${session.token}` }
  })).body.data.deliveryCode;

  const completed = await api(`/api/merchant/orders/${orderId}/status`, {
    method: 'POST',
    headers: jsonHeaders(merchantToken),
    body: JSON.stringify({ status: 'COMPLETED', deliveryCode: code })
  });
  assert.equal(completed.response.status, 200);
  assert.equal(orderOf(orderId).status, 'COMPLETED');

  // 售卖单交付核验不归还库存（车卖出去了），也不得产生租赁专属流水。
  assert.equal(movementsOf(orderId, 'RETURN_RESTORE').length, 0);
  assert.equal(orderOf(orderId).stockReservation, 'CONSUMED');
});
