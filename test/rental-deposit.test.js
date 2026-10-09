const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');
const {
  assertDepositBalance,
  RENTAL_DEPOSIT_FINAL_STATUSES,
  RENTAL_DEPOSIT_STATUSES,
  DEPOSIT_DEDUCTION_ATTRIBUTION_NOTE
} = require('../src/domain/rental');

process.env.ADMIN_USERNAME = 'rental-dep-admin';
process.env.ADMIN_PASSWORD = 'rental-dep-admin-password-123';

/**
 * 押金结算（平台审核 + RBAC + 恒等式）—— T36。
 *
 * 这是租赁链路的**最后一道资金关口**：钱在 `HELD → REFUND_PENDING` 之后，
 * 由平台财务核定车损扣款，决定「退多少、扣多少」。本文件守护三件事：
 *
 * 1. **金额恒等式**：`refundedInCents + deductionInCents === amountInCents` 必须对
 *    **每一条**终态押金成立。押金只有两个出口（退给用户 / 平台扣下），二者之和
 *    必须精确等于原始押金 —— 少了是钱不知去向，多了是凭空退款。
 *
 * 2. **押金永不进分账**：押金既不进 `order.items[].subtotalInCents`，
 *    结算扣款也**不得**写进 `settlements`。车是商家的、损失也是商家的，
 *    把扣款记为平台收入会引发商家抗议，且下一轮真实分账时要回头洗这批历史数据。
 *    本轮口径：扣款所得**暂挂平台待分配**，只留一条带说明的 `financeEvents`。
 *
 * 3. **只有钱能碰到钱**：结算端点必须 `FINANCE_MANAGE`，
 *    `SUPPORT` / `OPERATOR` 一律 403；重复结算必须 409，杜绝重复退款/重复扣款。
 *
 * ## 用例编号与 T36 需求清单的对应关系
 *
 * | 本文件 | 需求清单 | 内容 |
 * |---|---|---|
 * | ①~⑩ | ①~⑩ | 逐条对应 |
 * | — | ⑪ | 「既有 204 / 337 仍全绿」不是本文件的用例，由 `node --test` 全量跑核对 |
 * | ⑫ | ⑫ | 扣款所得不进商家余额 |
 * | ⑬ | ⑬ | 重复结算 → 409 |
 * | ⑭ | — | 额外：管理端押金台账（列表 / 过滤 / 权限），覆盖新端点的 GET 面 |
 * | ⑮ | — | 额外：押金结算流水的**资金口径**（负向出账 + `netInCents` 现金守恒，两个消费方） |
 */

const RENTAL_PRODUCT_ID = 'prod_ebike_rent_002';
const MERCHANT_ID = 'merchant_001';
const RENTAL_UNITS = 3;
const RENTAL_RENT_IN_CENTS = 4500; // 1500 分/天 × 3 天
const DEPOSIT_IN_CENTS = 29900;

let server;
let baseUrl;
let tempDirectory;
let store;
let merchantToken = '';
/** @type {Record<string, string>} 角色 → 管理端 token */
const adminTokens = {};

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-rental-dep-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` })
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  // 商家 token：用于验证「非管理员不得动资金」。
  // merchant_001 的归属用户是 wx_merchant_demo（见 store.js 种子）。
  const merchantUser = await loginWeChat('merchant_demo');
  const merchantLogin = await api('/api/merchant/login', {
    method: 'POST',
    headers: jsonHeaders(merchantUser.token),
    body: JSON.stringify({ merchantId: MERCHANT_ID })
  });
  assert.equal(merchantLogin.response.status, 200);
  merchantToken = merchantLogin.body.data.token;

  // 引导超管（process.env.ADMIN_USERNAME / ADMIN_PASSWORD）→ 再由它派生受限角色，
  // 全程走真实接口，顺带证明角色映射没有被 T36 改动。
  const superAdmin = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(superAdmin.response.status, 200);
  adminTokens.SUPER_ADMIN = superAdmin.body.data.token;

  const roleSeeds = [
    { role: 'FINANCE', username: 't36-finance', displayName: '财务管理员' },
    { role: 'OPERATOR', username: 't36-operator', displayName: '运营管理员' },
    { role: 'SUPPORT', username: 't36-support', displayName: '客服管理员' }
  ];
  for (const seed of roleSeeds) {
    const password = `${seed.username}-password-2026`;
    const created = await api('/api/admin/admins', {
      method: 'POST',
      headers: jsonHeaders(adminTokens.SUPER_ADMIN),
      body: JSON.stringify({ username: seed.username, displayName: seed.displayName, password, role: seed.role })
    });
    assert.equal(created.response.status, 201, `${seed.role} 管理员必须创建成功`);
    assert.equal(created.body.data.role, seed.role);
    const login = await api('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: seed.username, password })
    });
    assert.equal(login.response.status, 200, `${seed.role} 必须能登录`);
    adminTokens[seed.role] = login.body.data.token;
  }
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

/** 管理端结算押金。 */
async function settle(depositId, body, token) {
  return api(`/api/admin/rental-deposits/${depositId}/settle`, {
    method: 'POST',
    headers: jsonHeaders(token ?? adminTokens.FINANCE),
    body: JSON.stringify(body)
  });
}

/** 管理端押金列表。 */
async function listDeposits(query = '', token) {
  return api(`/api/admin/rental-deposits${query}`, {
    headers: { authorization: `Bearer ${token ?? adminTokens.FINANCE}` }
  });
}

/**
 * 一次请求同时读**两个** `netInCents` 消费方。
 *
 * `netInCents` 是「全部资金流水金额之和」，平台上有**两处**各自独立地算它：
 * - 消费方② `financeSummary.netInCents`（`app.js:6537`，管理端总览，无过滤求和）
 * - 消费方① `operationsReport.totals.netInCents`（`app.js:2994`，日报，无过滤累加）
 *
 * 两处都是无过滤累加，所以同一条流水的符号会**同时**影响它们 ——
 * 只断言其中一个，就会漏掉另一个。
 *
 * @returns {Promise<{summary: object, dailyTotals: object}>} 两个口径的读数。
 */
async function readNetInCents() {
  const result = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${adminTokens.FINANCE}` }
  });
  assert.equal(result.response.status, 200, 'FINANCE 持有 REPORT_VIEW，必须能读总览');
  assert.ok(result.body.data.operationsReport?.totals, '日报 totals 必须存在，否则消费方①无法被断言');
  return {
    summary: result.body.data.financeSummary,
    dailyTotals: result.body.data.operationsReport.totals
  };
}

function snapshot() {
  return store.read();
}

function orderOf(orderId) {
  return snapshot().orders.find((item) => item.id === orderId);
}

function depositsOf(orderId) {
  return (snapshot().rentalDeposits || []).filter((item) => item.orderId === orderId);
}

function depositById(depositId) {
  return (snapshot().rentalDeposits || []).find((item) => item.id === depositId);
}

/** 某条押金产生的结算审计日志（按目标串匹配，不依赖日志总数）。 */
function auditsAbout(depositId) {
  return (snapshot().auditLogs || []).filter((item) => String(item.target || '').includes(depositId));
}

/** 某条押金产生的结算资金流水。 */
function financeEventsAbout(depositId) {
  return (snapshot().financeEvents || []).filter((item) => item.referenceId === `DEPOSIT_SETTLE_${depositId}`);
}

/** 某商家的分账记录快照（用于断言「结算前后商家侧完全不变」）。 */
function merchantSettlementSnapshot(merchantId = MERCHANT_ID) {
  const rows = (snapshot().settlements || []).filter((item) => item.merchantId === merchantId);
  return {
    count: rows.length,
    amountInCents: rows.reduce((sum, item) => sum + Number(item.amountInCents || 0), 0),
    payableAmountInCents: rows.reduce((sum, item) => sum + Number(item.payableAmountInCents || 0), 0),
    rows: JSON.parse(JSON.stringify(rows))
  };
}

/**
 * 下一张已支付的租赁单（单台、租 3 天）。
 *
 * @param {string} userCode 微信登录 code。
 * @returns {Promise<{token: string, userId: string, orderId: string, orderNo: string}>} 订单上下文。
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

/**
 * 把一张租赁单一路推到「押金待退」——T36 的入口状态。
 *
 * @param {object} order 订单上下文。
 * @returns {Promise<string>} 押金记录 id。
 */
async function driveToRefundPending(order) {
  const accepted = await collab(merchantToken, { role: 'MERCHANT', action: 'ACCEPT', orderId: order.orderId, note: '已确认库存。' });
  assert.equal(accepted.response.status, 200);
  const requested = await collab(order.token, { role: 'USER', action: 'RETURN_REQUEST', orderId: order.orderId, note: '车已还到店内。' });
  assert.equal(requested.response.status, 200);
  const verified = await collab(merchantToken, { role: 'MERCHANT', action: 'RETURN_VERIFY', orderId: order.orderId, note: '车辆核验无损。' });
  assert.equal(verified.response.status, 200);

  const deposits = depositsOf(order.orderId);
  assert.equal(deposits.length, 1, '一张租赁单必须恰好有一条押金记录');
  return deposits[0].id;
}

test('① ★ 入口状态回归：归还核验后押金为 REFUND_PENDING，金额尚未分配', async () => {
  const order = await createPaidRentalOrder('rental_dep_entry');
  const depositId = await driveToRefundPending(order);

  const deposit = depositById(depositId);
  assert.equal(deposit.status, 'REFUND_PENDING', '归还核验后押金必须停在待退（T35 已就位）');
  assert.ok(deposit.refundPendingAt, 'refundPendingAt 必须非空');
  assert.equal(deposit.amountInCents, DEPOSIT_IN_CENTS);
  // 只改状态、不动金额：退多少要等车况核验，那是 T36 的职责。
  assert.equal(deposit.refundedInCents, 0);
  assert.equal(deposit.deductionInCents, 0);
  assert.equal(deposit.settledAt, undefined, '未结算不得有 settledAt');

  // 订单侧：归还核验后订单已完成，资金侧入口守卫随之放行。
  const stored = orderOf(order.orderId);
  assert.equal(stored.rental.status, 'RETURNED');
  assert.equal(stored.status, 'COMPLETED');
});

test('② ★ 全额退回：deductionInCents=0 → REFUNDED，退回 29900 分', async () => {
  const order = await createPaidRentalOrder('rental_dep_full');
  const depositId = await driveToRefundPending(order);

  const settled = await settle(depositId, { deductionInCents: 0, note: '车辆无损，全额退还。' });
  assert.equal(settled.response.status, 200);
  assert.equal(settled.body.data.deposit.status, 'REFUNDED');
  assert.equal(settled.body.data.deposit.refundedInCents, DEPOSIT_IN_CENTS);
  assert.equal(settled.body.data.deposit.deductionInCents, 0);
  assert.equal(settled.body.data.orderNo, order.orderNo);

  const deposit = depositById(depositId);
  assert.equal(deposit.status, 'REFUNDED');
  assert.equal(deposit.refundedInCents, 29900);
  assert.equal(deposit.deductionInCents, 0);
  assert.ok(deposit.settledAt, 'settledAt 必须非空');
  assert.equal(deposit.settledBy, '财务管理员');
  assert.equal(deposit.deductionNote, '车辆无损，全额退还。');
  assert.equal(assertDepositBalance(deposit), true, '全额退回也必须满足恒等式');
});

test('③ ★ 部分扣款：扣 5000 → PARTIALLY_REFUNDED，退回 24900 分', async () => {
  const order = await createPaidRentalOrder('rental_dep_partial');
  const depositId = await driveToRefundPending(order);

  const settled = await settle(depositId, { deductionInCents: 5000, note: '车筐损坏，扣维修费。' });
  assert.equal(settled.response.status, 200);
  assert.equal(settled.body.data.deposit.status, 'PARTIALLY_REFUNDED');
  assert.equal(settled.body.data.deposit.deductionInCents, 5000);
  assert.equal(settled.body.data.deposit.refundedInCents, 24900);

  const deposit = depositById(depositId);
  assert.equal(deposit.status, 'PARTIALLY_REFUNDED');
  assert.equal(deposit.deductionInCents, 5000);
  assert.equal(deposit.refundedInCents, 24900);
  assert.equal(deposit.deductionNote, '车筐损坏，扣维修费。');
  assert.equal(assertDepositBalance(deposit), true);
});

test('④ ★★ 恒等式全局扫描：每一条终态押金都满足 退回 + 扣款 === 押金总额', () => {
  const all = snapshot().rentalDeposits || [];
  const finalDeposits = all.filter((item) => RENTAL_DEPOSIT_FINAL_STATUSES.includes(item.status));

  // ★ 防空转：扫描必须真的扫到了东西，否则这条断言等于没写。
  assert.ok(finalDeposits.length >= 2,
    `终态押金至少应有 2 条（② 全额退回 + ③ 部分扣款），实际 ${finalDeposits.length} —— 扫描若为空则该断言无意义`);
  assert.ok(finalDeposits.some((item) => item.status === 'REFUNDED'), '扫描集必须覆盖 REFUNDED');
  assert.ok(finalDeposits.some((item) => item.status === 'PARTIALLY_REFUNDED'), '扫描集必须覆盖 PARTIALLY_REFUNDED');

  // 逐条用**生产代码里的**恒等式校验函数扫描，而不是在测试里重写一遍算术 ——
  // 重写一遍只能证明「测试自己的算术自洽」，证明不了服务端写出的数据是平的。
  for (const deposit of finalDeposits) {
    assert.equal(assertDepositBalance(deposit), true, `押金 ${deposit.id} 破坏了终态恒等式`);
  }

  // 再用显式算术交叉验证一遍，便于失败时直接看到 expected/actual。
  for (const deposit of finalDeposits) {
    assert.equal(
      deposit.refundedInCents + deposit.deductionInCents,
      deposit.amountInCents,
      `押金 ${deposit.id}（${deposit.status}）：${deposit.refundedInCents} + ${deposit.deductionInCents} 必须等于 ${deposit.amountInCents}`
    );
  }

  // 非终态（在途）押金不参与恒等式校验：钱还没分配，此时退回/扣款本就都是 0。
  for (const deposit of all.filter((item) => !RENTAL_DEPOSIT_FINAL_STATUSES.includes(item.status))) {
    assert.equal(RENTAL_DEPOSIT_STATUSES.includes(deposit.status), true, `押金 ${deposit.id} 状态越界：${deposit.status}`);
    assert.equal(deposit.refundedInCents, 0);
    assert.equal(deposit.deductionInCents, 0);
  }

  // ★ 恒等式校验函数本身必须真的会「炸」，否则上面的全绿只是因为它永远返回 true。
  assert.throws(
    () => assertDepositBalance({
      id: 'dep_broken', status: 'PARTIALLY_REFUNDED', amountInCents: 29900, refundedInCents: 29900, deductionInCents: 5000
    }),
    (error) => error.statusCode === 500 && error.code === 'DEPOSIT_BALANCE_BROKEN',
    '恒等式被破坏必须抛 500 DEPOSIT_BALANCE_BROKEN（服务端不变量，不是用户输入错误）'
  );
  assert.throws(
    () => assertDepositBalance({
      id: 'dep_broken2', status: 'REFUNDED', amountInCents: 29900, refundedInCents: 28900, deductionInCents: 0
    }),
    (error) => error.statusCode === 500 && error.code === 'DEPOSIT_BALANCE_BROKEN'
  );
});

test('⑤ ★ 非法扣款一律 400，且押金分毫不动（fail-closed）', async () => {
  const order = await createPaidRentalOrder('rental_dep_invalid');
  const depositId = await driveToRefundPending(order);

  const cases = [
    { body: { deductionInCents: DEPOSIT_IN_CENTS + 100 }, label: '扣款超过押金总额' },
    { body: { deductionInCents: -1 }, label: '负数扣款' },
    { body: { deductionInCents: 1.5 }, label: '非整数扣款' },
    { body: { deductionInCents: '5000' }, label: '字符串扣款' },
    { body: { deductionInCents: null }, label: 'null 扣款' },
    { body: { deductionInCents: undefined }, label: '缺失扣款' }
  ];
  for (const item of cases) {
    const failed = await settle(depositId, item.body);
    assert.equal(failed.response.status, 400, `${item.label} 必须被拒绝（400）`);
    assert.equal(failed.body.error.code, 'VALIDATION_ERROR');
  }

  // ★ fail-closed：全部失败请求之后，押金必须仍停在待退、金额仍为 0/0。
  const deposit = depositById(depositId);
  assert.equal(deposit.status, 'REFUND_PENDING', '非法请求不得改变押金状态');
  assert.equal(deposit.refundedInCents, 0);
  assert.equal(deposit.deductionInCents, 0);
  assert.equal(deposit.settledAt, undefined);

  // 边界值恰好等于押金总额是**合法**的（全部扣光 → 部分退回，退回 0）。
  const boundary = await settle(depositId, { deductionInCents: DEPOSIT_IN_CENTS, note: '车损全额赔付。' });
  assert.equal(boundary.response.status, 200);
  assert.equal(boundary.body.data.deposit.status, 'PARTIALLY_REFUNDED');
  assert.equal(boundary.body.data.deposit.refundedInCents, 0);
  assert.equal(boundary.body.data.deposit.deductionInCents, DEPOSIT_IN_CENTS);
});

test('⑥ ★ RBAC：SUPPORT / OPERATOR → 403；FINANCE / SUPER_ADMIN → 200', async () => {
  // 同一笔押金：先用越权角色反复尝试（必须全部被挡），再交给 FINANCE 成功结算 ——
  // 这同时证明了「403 是真的没执行」，而不是「执行了但恰好没改状态」。
  const order = await createPaidRentalOrder('rental_dep_rbac');
  const depositId = await driveToRefundPending(order);

  for (const role of ['SUPPORT', 'OPERATOR']) {
    const denied = await settle(depositId, { deductionInCents: 0, note: `${role} 越权尝试。` }, adminTokens[role]);
    assert.equal(denied.response.status, 403, `${role} 不得结算押金`);
    assert.equal(denied.body.error.code, 'ADMIN_FORBIDDEN');
    assert.equal(depositById(depositId).status, 'REFUND_PENDING', `${role} 被拒后押金不得被动过`);
  }

  const financeOk = await settle(depositId, { deductionInCents: 1000, note: '财务核定扣款。' }, adminTokens.FINANCE);
  assert.equal(financeOk.response.status, 200, 'FINANCE 必须可结算');
  assert.equal(depositById(depositId).status, 'PARTIALLY_REFUNDED');

  // SUPER_ADMIN（权限 `*`）同样可结算。
  const second = await createPaidRentalOrder('rental_dep_rbac_super');
  const secondDepositId = await driveToRefundPending(second);
  const superOk = await settle(secondDepositId, { deductionInCents: 0 }, adminTokens.SUPER_ADMIN);
  assert.equal(superOk.response.status, 200, 'SUPER_ADMIN 必须可结算');
  assert.equal(depositById(secondDepositId).status, 'REFUNDED');
});

test('⑦ ★ 商家 token 不得结算押金，且押金分毫不动', async () => {
  const order = await createPaidRentalOrder('rental_dep_merchant');
  const depositId = await driveToRefundPending(order);

  const attempted = await settle(depositId, { deductionInCents: 0 }, merchantToken);
  // ★ 与 brief 的偏差（已上报）：平台 `requireAdmin` 对「根本不是管理员会话」的 token
  // 统一返回 401 ADMIN_UNAUTHORIZED —— 403 ADMIN_FORBIDDEN 只留给「是管理员但角色权限不足」。
  // 把 401 改成 403 会动到全部管理端端点共用的鉴权原语，且与 api.test.js:166 的既有断言冲突，
  // 因此这里按平台真实契约断言 401，并额外断言「钱一分未动」——那才是本条真正要守的性质。
  assert.equal(attempted.response.status, 401, '商家 token 不得结算押金');
  assert.equal(attempted.body.error.code, 'ADMIN_UNAUTHORIZED');

  const listed = await listDeposits('', merchantToken);
  assert.equal(listed.response.status, 401, '商家 token 不得查看押金台账');

  const deposit = depositById(depositId);
  assert.equal(deposit.status, 'REFUND_PENDING', '被拒后押金不得被动过');
  assert.equal(deposit.refundedInCents, 0);
  assert.equal(deposit.deductionInCents, 0);
  assert.equal(financeEventsAbout(depositId).length, 0, '被拒的请求不得留下资金流水');
});

test('⑧ ★ 每次结算恰好产生 1 条 auditLogs + 1 条 financeEvents', async () => {
  const order = await createPaidRentalOrder('rental_dep_ledger');
  const depositId = await driveToRefundPending(order);

  assert.equal(auditsAbout(depositId).length, 0);
  assert.equal(financeEventsAbout(depositId).length, 0);

  const settled = await settle(depositId, { deductionInCents: 5000, note: '超时 2 天，按日租扣款。' });
  assert.equal(settled.response.status, 200);

  const audits = auditsAbout(depositId);
  assert.equal(audits.length, 1, '必须恰好 1 条审计日志');
  assert.equal(audits[0].action, '平台结算租赁押金');
  assert.equal(audits[0].operator, '财务管理员');
  assert.ok(String(audits[0].target).includes(order.orderNo), '审计日志必须能追到订单号');

  const events = financeEventsAbout(depositId);
  assert.equal(events.length, 1, '必须恰好 1 条资金流水');
  assert.equal(events[0].eventType, 'DEPOSIT_SETTLEMENT');
  // ★ 金额是**负向出账**：结算时真正离开平台的是退给用户的 24900（29900 − 扣款 5000），
  // 不是扣款额。原断言写 `5000`（正数）等于把实现自己的写法当成了事实，见用例⑮。
  assert.equal(events[0].amountInCents, -24900, '流水金额必须是负向出账：等于实际退给用户的 24900');
  assert.equal(events[0].orderNo, order.orderNo);
  assert.equal(events[0].merchantId, MERCHANT_ID);
  assert.equal(events[0].businessType, 'RENTAL_DEPOSIT');
  assert.equal(events[0].settlementReference, depositId);
  assert.equal(settled.body.data.financeEventId, events[0].id);

  // ★ 资金归属口径必须写进流水，否则下一轮真实分账时无人知道这 5000 分该怎么算。
  assert.equal(events[0].note, DEPOSIT_DEDUCTION_ATTRIBUTION_NOTE);
  assert.ok(events[0].note.includes('暂挂'), '口径说明必须点明「暂挂待分配」');
});

test('⑨ ★★ 全局扫描：押金金额绝不进入任何 settlements', async () => {
  // 再补一张走到待退的租赁单，确保扫描集里既有「已结算」也有「在途」的押金。
  const order = await createPaidRentalOrder('rental_dep_isolation');
  await driveToRefundPending(order);

  const data = snapshot();
  const settlements = data.settlements || [];
  const orders = data.orders || [];
  const deposits = data.rentalDeposits || [];
  assert.ok(settlements.length >= 1, '必须有分账记录，否则本断言无意义');

  let scannedRentalSettlements = 0;
  for (const settlement of settlements) {
    const relatedOrder = orders.find((item) => item.id === settlement.orderId);
    if (!relatedOrder) continue;
    const rentTotal = (relatedOrder.items || [])
      .reduce((sum, item) => sum + Number(item.subtotalInCents || 0), 0);
    const depositTotal = deposits
      .filter((item) => item.orderId === relatedOrder.id)
      .reduce((sum, item) => sum + Number(item.amountInCents || 0), 0);
    if (depositTotal <= 0) continue;
    scannedRentalSettlements += 1;

    // 押金必须既不进分账金额、也不被「顺便」折进来。
    assert.equal(settlement.amountInCents, rentTotal,
      `订单 ${relatedOrder.orderNo} 的分账金额必须精确等于租金合计（${rentTotal}）`);
    assert.notEqual(settlement.amountInCents, rentTotal + depositTotal,
      `订单 ${relatedOrder.orderNo} 的分账金额不得包含押金 ${depositTotal}`);
    assert.notEqual(settlement.amountInCents, depositTotal,
      `押金 ${depositTotal} 不得成为任何分账金额`);
  }
  assert.ok(scannedRentalSettlements >= 1, '必须至少扫到 1 条带押金的租赁分账，否则本断言无意义');

  // 押金自身只活在 rentalDeposits 里：金额为 0 的伪分账也不允许存在。
  for (const settlement of settlements) {
    assert.ok(Number(settlement.amountInCents) > 0, '分账金额必须为正（押金若被折入会出现异常值）');
  }
});

test('⑩ ★★ 恒等式：settlements 金额之和 === order.items[].subtotalInCents 之和', async () => {
  const order = await createPaidRentalOrder('rental_dep_identity');
  await driveToRefundPending(order);

  const data = snapshot();
  const settlements = data.settlements || [];
  const ordersWithSettlements = (data.orders || []).filter((item) => (
    settlements.some((settlement) => settlement.orderId === item.id)
  ));
  assert.ok(ordersWithSettlements.length >= 1, '必须有已分账订单，否则本断言无意义');

  const settlementTotal = settlements.reduce((sum, item) => sum + Number(item.amountInCents || 0), 0);
  const subtotalTotal = ordersWithSettlements.reduce((sum, item) => (
    sum + (item.items || []).reduce((inner, line) => inner + Number(line.subtotalInCents || 0), 0)
  ), 0);

  // ★ 这条恒等式是「分账从未被押金污染」的直接证据：
  // 只要押金曾溜进 subtotalInCents 或 createSettlements，右侧就会膨胀 29900 × 单数。
  assert.equal(settlementTotal, subtotalTotal,
    `分账总额 ${settlementTotal} 必须精确等于订单项小计总额 ${subtotalTotal}`);

  // 反向证据：租赁单的 subtotalInCents 只含租金，押金另计。
  const rentalOrders = ordersWithSettlements.filter((item) => item.orderKind === 'RENTAL');
  assert.ok(rentalOrders.length >= 1);
  for (const rentalOrder of rentalOrders) {
    const subtotal = (rentalOrder.items || []).reduce((sum, line) => sum + Number(line.subtotalInCents || 0), 0);
    assert.equal(subtotal, RENTAL_RENT_IN_CENTS, `租赁单 ${rentalOrder.orderNo} 的订单项小计必须等于租金 ${RENTAL_RENT_IN_CENTS}`);
    assert.ok(rentalOrder.totalInCents >= subtotal + DEPOSIT_IN_CENTS,
      '押金必须体现在订单总额里（用户确实付了），只是不进分账口径');
  }
});

test('⑫ ★★ 扣款所得不进商家余额：结算前后该商家 settlements 与可结算金额完全不变', async () => {
  const order = await createPaidRentalOrder('rental_dep_attribution');
  const depositId = await driveToRefundPending(order);

  const before = merchantSettlementSnapshot(MERCHANT_ID);
  assert.ok(before.count >= 1, '前置：该商家已有分账记录');
  assert.ok(before.payableAmountInCents > 0, '前置：该商家已有可结算金额');

  const settled = await settle(depositId, { deductionInCents: 5000, note: '车损扣款，归属待定。' });
  assert.equal(settled.response.status, 200);
  assert.equal(depositById(depositId).deductionInCents, 5000);

  const after = merchantSettlementSnapshot(MERCHANT_ID);

  // ★ 扣款所得本轮不分配：商家余额必须逐字节不变（连 updatedAt 都不许被碰）。
  assert.deepEqual(after.rows, before.rows, '结算押金不得修改该商家的任何分账记录');
  assert.equal(after.count, before.count, '分账记录条数不得变化');
  assert.equal(after.amountInCents, before.amountInCents, '分账总额不得因扣款增加');
  assert.equal(after.payableAmountInCents, before.payableAmountInCents, '可结算金额不得因扣款增加');

  // 扣款只体现在 financeEvents（且带口径说明），这是「记了钱但没分钱」的唯一凭证。
  const events = financeEventsAbout(depositId);
  assert.equal(events.length, 1);
  assert.equal(events[0].amountInCents, -24900);
  assert.equal(events[0].note, DEPOSIT_DEDUCTION_ATTRIBUTION_NOTE);
  // 对照：该商家在结算前后都没有任何 DEPOSIT_SETTLEMENT 之外的新增分账。
  const settlementTouched = (snapshot().settlements || [])
    .filter((item) => item.orderId === order.orderId)
    .some((item) => item.amountInCents !== RENTAL_RENT_IN_CENTS);
  assert.equal(settlementTouched, false, '租赁单的分账金额必须始终等于租金，不因扣款变化');
});

test('⑬ ★ 重复结算 → 409 DEPOSIT_NOT_SETTLEABLE，且不产生第二条流水', async () => {
  const order = await createPaidRentalOrder('rental_dep_idempotent');
  const depositId = await driveToRefundPending(order);

  const first = await settle(depositId, { deductionInCents: 5000, note: '首次结算。' });
  assert.equal(first.response.status, 200);
  const afterFirst = depositById(depositId);
  const auditsAfterFirst = auditsAbout(depositId).length;
  const eventsAfterFirst = financeEventsAbout(depositId).length;
  assert.equal(auditsAfterFirst, 1);
  assert.equal(eventsAfterFirst, 1);

  // 财务双击 / 客户端重试：必须拿到可识别的「不可结算」信号，而不是静默二次扣款。
  const repeated = await settle(depositId, { deductionInCents: 5000, note: '重复结算。' });
  assert.equal(repeated.response.status, 409);
  assert.equal(repeated.body.error.code, 'DEPOSIT_NOT_SETTLEABLE');

  // ★ 最关键：重复提交绝不能二次扣款/二次退款。
  const afterRepeat = depositById(depositId);
  assert.deepEqual(afterRepeat, afterFirst, '重复结算不得改动押金记录的任何字段');
  assert.equal(afterRepeat.status, 'PARTIALLY_REFUNDED');
  assert.equal(afterRepeat.refundedInCents, 24900);
  assert.equal(afterRepeat.deductionInCents, 5000);
  assert.equal(auditsAbout(depositId).length, auditsAfterFirst, '重复结算不得新增审计日志');
  assert.equal(financeEventsAbout(depositId).length, eventsAfterFirst, '重复结算不得新增资金流水');

  // 换一个金额再试也必须被挡（不能靠「金额不同」绕过终态）。
  const retryWithOtherAmount = await settle(depositId, { deductionInCents: 0 });
  assert.equal(retryWithOtherAmount.response.status, 409);
  assert.equal(retryWithOtherAmount.body.error.code, 'DEPOSIT_NOT_SETTLEABLE');
  assert.deepEqual(depositById(depositId), afterFirst);

  // 未归还（HELD）的押金同样不可结算 —— 车还在用户手上，车况未知。
  const heldOrder = await createPaidRentalOrder('rental_dep_held');
  const heldDepositId = depositsOf(heldOrder.orderId)[0].id;
  assert.equal(depositById(heldDepositId).status, 'HELD');
  const tooEarly = await settle(heldDepositId, { deductionInCents: 0 });
  assert.equal(tooEarly.response.status, 409, '车未归还不得结算押金');
  assert.equal(tooEarly.body.error.code, 'DEPOSIT_NOT_SETTLEABLE');
  assert.equal(depositById(heldDepositId).status, 'HELD');
});

test('⑭ ★ 管理端押金台账：列表 + status 过滤 + 关联订单号/用户名', async () => {
  const order = await createPaidRentalOrder('rental_dep_list');
  const depositId = await driveToRefundPending(order);

  const all = await listDeposits();
  assert.equal(all.response.status, 200);
  assert.ok(all.body.total >= 1);
  const mine = all.body.data.find((item) => item.id === depositId);
  assert.ok(mine, '台账必须能查到本单押金');
  assert.equal(mine.orderNo, order.orderNo, '必须带关联订单号，便于管理端核对');
  assert.ok(mine.userName, '必须带用户名（本系统无昵称体系，回退到 userId）');
  assert.equal(mine.userId, order.userId);
  assert.equal(mine.merchantName, '狮山校园车行');
  assert.equal(mine.amountInCents, DEPOSIT_IN_CENTS);
  assert.equal(mine.orderKind, 'RENTAL');

  const pending = await listDeposits('?status=REFUND_PENDING');
  assert.equal(pending.response.status, 200);
  assert.ok(pending.body.data.every((item) => item.status === 'REFUND_PENDING'), '过滤结果必须只含待退押金');
  assert.ok(pending.body.data.some((item) => item.id === depositId), '本单待退押金必须被过滤到');

  const refunded = await listDeposits('?status=REFUNDED');
  assert.equal(refunded.response.status, 200);
  assert.ok(refunded.body.data.every((item) => item.status === 'REFUNDED'));
  assert.equal(refunded.body.data.some((item) => item.id === depositId), false, '待退押金不得出现在已退结果里');

  // 白名单收口：未知状态必须 400，而不是静默返回空列表（否则前端拼错参数会以为「没有数据」）。
  const bogus = await listDeposits('?status=NOT_A_STATUS');
  assert.equal(bogus.response.status, 400);
  assert.equal(bogus.body.error.code, 'VALIDATION_ERROR');

  // 权限：越权角色连台账都看不到。
  for (const role of ['SUPPORT', 'OPERATOR']) {
    const denied = await listDeposits('', adminTokens[role]);
    assert.equal(denied.response.status, 403, `${role} 不得查看押金台账`);
  }
  const financeList = await listDeposits('', adminTokens.FINANCE);
  assert.equal(financeList.response.status, 200);
});

test('⑮ ★★ 押金结算流水的资金口径：负向出账，且 netInCents 现金守恒（两个消费方）', async () => {
  const order = await createPaidRentalOrder('rental_dep_netincents');
  const depositId = await driveToRefundPending(order);

  const before = await readNetInCents();
  const settled = await settle(depositId, { deductionInCents: 5000, note: '车损扣款 5000，其余退回。' });
  assert.equal(settled.response.status, 200);
  const after = await readNetInCents();

  const deposit = depositById(depositId);
  assert.equal(deposit.deductionInCents, 5000);
  assert.equal(deposit.refundedInCents, 24900);

  const events = financeEventsAbout(depositId);
  assert.equal(events.length, 1);

  // ① 口径：结算时**真正离开平台**的钱是「退给用户的 refundedInCents」，不是「平台留下的
  //    deductionInCents」（后者按 R11 口径暂挂待分配，是平台留着的钱，不该表现为出账）。
  //    流水必须记成**负向出账** —— 与全平台符号约定一致（`app.js:1430` 记 PAYOUT 写的是
  //    `-totalInCents`）。记成正数会把「资金净额」抬高，即账实不符。
  assert.equal(
    events[0].amountInCents,
    -deposit.refundedInCents,
    `押金结算流水必须等于负的实际出账额（expected ${-deposit.refundedInCents}，actual ${events[0].amountInCents}）`
  );
  assert.equal(events[0].amountInCents, -24900, '扣 5000 退 24900，流水应为 -24900');

  // ② 聚合守恒（消费方② `app.js:6537`）：`netInCents` 的增量必须等于真实现金变动。
  //    这里**直接钉住聚合本身** —— 押金的每个字段都有断言，不等于「聚合是对的」。
  const summaryDelta = after.summary.netInCents - before.summary.netInCents;
  assert.equal(
    summaryDelta,
    -deposit.refundedInCents,
    `总览 netInCents 增量必须等于 -${deposit.refundedInCents}（expected ${-deposit.refundedInCents}，actual ${summaryDelta}）`
  );

  // ③ 同一个聚合的**第二个消费方**（`app.js:2994` 日报）必须同步 —— 只断言一个会漏掉另一个。
  const dailyDelta = after.dailyTotals.netInCents - before.dailyTotals.netInCents;
  assert.equal(
    dailyDelta,
    -deposit.refundedInCents,
    `日报 netInCents 增量必须等于 -${deposit.refundedInCents}（expected ${-deposit.refundedInCents}，actual ${dailyDelta}）`
  );

  // ④ 口径恒等式 + 文案守卫：`netInCents` 是**全部**事件之和，而 `refundOutCents` 只过滤
  //    `eventType === 'REFUND'`，所以押金退款**不进**退款列。于是
  //    `netInCents === paymentInCents + refundOutCents + payoutOutCents + Σ(押金结算流水)`。
  //    这正是 `public/admin.js` 里「支付 - 退款 - 打款」这个公式文案必须改的原因。
  const depositSettlementSum = (snapshot().financeEvents || [])
    .filter((item) => item.eventType === 'DEPOSIT_SETTLEMENT')
    .reduce((sum, item) => sum + Number(item.amountInCents || 0), 0);
  // ★ 防空转：本轮必须已产生非零押金结算流水，否则下面的恒等式退化为「0 === 0」。
  assert.notEqual(depositSettlementSum, 0, '必须已有非零押金结算流水，否则本条断言无意义');
  const bucketSum = after.summary.paymentInCents + after.summary.refundOutCents + after.summary.payoutOutCents;
  assert.equal(
    after.summary.netInCents,
    bucketSum + depositSettlementSum,
    'netInCents 必须等于三个展示分项之和再加上押金结算流水之和'
  );
  assert.notEqual(
    bucketSum,
    after.summary.netInCents,
    '三个展示分项之和不得等于 netInCents —— 押金退款不在 refundOutCents 里，文案不能写成「支付 - 退款 - 打款」'
  );
  //    ★ 增量式（不用全局 `=== 0`）：将来任何人往本文件加一条**产生退款**的用例，
  //    「全仓 REFUND 流水之和为 0」都会无故变红。本条真正要守的性质是
  //    「押金结算**不得改变** refundOutCents」，所以只看增量。
  assert.equal(
    after.summary.refundOutCents - before.summary.refundOutCents,
    0,
    '押金结算不得改变 refundOutCents（押金退款不记为 REFUND 事件）'
  );
});
