const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const ADMIN_JS_PATH = path.join(__dirname, '..', 'public', 'admin.js');
const ADMIN_HTML_PATH = path.join(__dirname, '..', 'public', 'admin.html');

/**
 * 读出 `admin.js` 源码 —— **原始文件，不做任何字符串替换**。
 *
 * 这里曾有一段 `.replace('const state={data:null,', …)` 补丁，用来绕开文件第 3 行
 * `lowStockThreshold` 在模块求值时读 `state.data.settings` 的空指针。
 * 该补丁掩盖了真实缺陷：线上管理端加载即抛
 * `TypeError: Cannot read properties of null (reading 'settings')`，登录按钮完全无响应。
 * 现已把 `lowStockThreshold` 改为惰性取值（函数），补丁随之删除。
 *
 * ★ 纪律：**测试必须跑交付给用户的那个文件**，不得改写被测源码来换取可测性 ——
 *   否则测的是一个不存在的文件，全绿也没有意义。
 */
function readAdminSource() {
  return fs.readFileSync(ADMIN_JS_PATH, 'utf8');
}

/** 造一个足够所有视图渲染的 overview 形状（键名取自 `admin.js` 的实际引用）。 */
function overviewShape() {
  return {
    settings: {},
    metrics: {},
    merchants: [],
    qualificationRenewals: [],
    leads: [],
    products: [],
    stockMovements: [],
    rechargePromos: [],
    productReviews: [],
    orders: [],
    paymentOrders: [],
    phoneCardOrders: [],
    rechargeOrders: [],
    financeEvents: [],
    financeSummary: {},
    financeTasks: [],
    settlements: [],
    settlementSummary: {},
    payoutRequests: [],
    serviceScoreCases: [],
    serviceRiskSummary: {},
    slaAlerts: [],
    slaSummary: {},
    slaOwnerTasks: [],
    patrolState: {},
    merchantScores: [],
    merchantScoreLogs: [],
    merchantScoreSummary: {},
    broadbandApplications: [],
    plateApplications: [],
    afterSales: [],
    notifications: [],
    auditLogs: [],
    adminUsers: [],
    marketItems: [],
    forumPosts: [],
    operationsReport: { reports: [], totals: {} },
    operationsInsights: {},
    paymentReconciliations: [],
    settingChangeLogs: [],
    orderMessageSubscribers: [],
    serviceMessageSubscribers: [],
    subscribeMessages: [],
    subscribeStats: {},
    negativeReviewOperations: {},
    autoDelistedProducts: [],
    pendingPublishProducts: []
  };
}

/**
 * 在伪造 DOM 里把 `admin.js` 跑起来。
 *
 * @param {object} options
 * @param {object} [options.data] `state.data` 的内容。
 * @param {Array} [options.rentalDeposits] `state.rentalDeposits` 的内容。
 * @param {string} [options.rentalDepositsError] 模拟押金接口失败。
 * @param {Array} [options.prompts] `prompt` 的依次返回值。
 * @param {object} [options.selectorResults] `querySelectorAll(selector)` 的返回值。
 * @param {Function} [options.fetchImpl] 覆盖默认的 `fetch`。
 * @returns {{app: object, elements: Map, calls: Array}}
 */
function loadAdminApp(options = {}) {
  const baseSource = readAdminSource();
  // ★ `sourceTransform` 供「给 label() 打桩」这类**渲染级**判据使用；
  //   不传时行为与从前完全一致（默认路径不受影响）。
  const source = options.sourceTransform ? options.sourceTransform(baseSource) : baseSource;
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
  const prompts = [...(options.prompts || [])];
  const calls = [];
  const jsonResponse = (payload) => ({ ok: true, status: 200, json: async () => ({ data: payload }) });
  const context = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      querySelector: element,
      querySelectorAll: (selector) => (options.selectorResults || {})[selector] || [],
      addEventListener() {}
    },
    fetch: options.fetchImpl || (async (url) => {
      calls.push(String(url));
      return jsonResponse(String(url).includes('/api/admin/rental-deposits') ? [] : {});
    }),
    alert() {},
    prompt: () => (prompts.length ? prompts.shift() : null),
    setTimeout: () => 0,
    __unknown: []
  };
  const app = vm.runInNewContext(`${source}; ({ state, render, statuses, options, leadStatuses, __unknown })`, context, { timeout: 5000 });
  app.state.data = options.data || overviewShape();
  app.state.rentalDeposits = options.rentalDeposits || [];
  if (options.rentalDepositsError) app.state.rentalDepositsError = options.rentalDepositsError;
  return { app, elements, calls };
}

/** 渲染指定视图，返回 `#content` 的 HTML。 */
function renderView(app, elements, view) {
  app.state.view = view;
  app.render();
  return elements.get('#content').innerHTML;
}

/**
 * 从 `render()` 里切出某个状态分组的 HTML。
 *
 * 分组之间用 `data-group="KEY"` 分隔，`HELD` 是最后一组，所以取不到下一个
 * 分隔符时切到末尾即可。
 */
function groupHtml(html, key) {
  const marker = `data-group="${key}"`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `渲染结果里必须存在分组 ${key}（找不到 ${marker}）`);
  const next = html.indexOf('data-group="', start + marker.length);
  return html.slice(start, next === -1 ? html.length : next);
}

const DEPOSIT_PENDING = {
  id: 'dep_pending_001',
  orderId: 'ord_rental_001',
  orderNo: 'SO20260901001',
  orderStatus: 'COMPLETED',
  orderKind: 'RENTAL',
  userId: 'u3',
  userName: '微信用户 1234***abcd',
  merchantId: 'mer_rental_001',
  merchantName: '远行租赁',
  amountInCents: 30000,
  status: 'REFUND_PENDING',
  refundedInCents: 0,
  deductionInCents: 0,
  createdAt: '2026-09-01T02:00:00.000Z'
};

const DEPOSIT_SETTLED_FULL = {
  ...DEPOSIT_PENDING,
  id: 'dep_settled_001',
  orderNo: 'SO20260901002',
  status: 'REFUNDED',
  refundedInCents: 30000,
  deductionInCents: 0,
  deductionNote: '',
  settledAt: '2026-09-02T03:00:00.000Z',
  settledBy: '财务小王'
};

const DEPOSIT_SETTLED_PARTIAL = {
  ...DEPOSIT_PENDING,
  id: 'dep_settled_002',
  orderNo: 'SO20260901003',
  status: 'PARTIALLY_REFUNDED',
  refundedInCents: 25000,
  deductionInCents: 5000,
  deductionNote: '车辆归还时存在损坏，按平台定损扣除',
  settledAt: '2026-09-02T04:00:00.000Z',
  settledBy: '财务小王'
};

const DEPOSIT_HELD = {
  ...DEPOSIT_PENDING,
  id: 'dep_held_001',
  orderNo: 'SO20260901004',
  status: 'HELD'
};

// ── ① 导航入口 ──────────────────────────────────────────────────────────────

test('T41 ① admin.html 新增「租赁管理」导航项，且只新增不删除', () => {
  const html = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');
  assert.ok(html.includes('data-view="rentals"'), '① admin.html 必须含 data-view="rentals"');
  assert.ok(/data-view="rentals"[^>]*>[^<]*<span>租<\/span>租赁管理/.test(html), '① 导航项文案应为「租赁管理」');
});

test('T41 ① titles 里有 rentals 键（否则 #pageTitle 会渲染成 undefined）', () => {
  const source = readAdminSource();
  const match = source.match(/const titles=\{([^}]*)\}/);
  assert.ok(match, '① 判据自测：必须能从源码里切出 titles 字面量');
  assert.ok(/rentals:'租赁管理'/.test(match[1]), `① titles 必须含 rentals:'租赁管理'，实得 ${match[1].slice(-80)}`);

  // 判据自测：同一正则对**不含** rentals 的字符串应当不命中，
  // 否则这条断言对任何输入都为真，等于没测。
  assert.equal(/rentals:'租赁管理'/.test("dashboard:'经营概览',merchants:'商家入驻'"), false, '① 判据自测：缺少 rentals 时该正则必须不命中');

  const { app, elements } = loadAdminApp();
  renderView(app, elements, 'rentals');
  const title = elements.get('#pageTitle').textContent;
  assert.equal(title, '租赁管理', '① #pageTitle 必须是「租赁管理」，不能是 undefined');
});

// ── ② views 映射 ────────────────────────────────────────────────────────────

test('T41 ② render() 的 views 映射表里有 rentals 渲染函数', () => {
  const source = readAdminSource();
  const match = source.match(/const views=\{([^}]*)\}/);
  assert.ok(match, '② 判据自测：必须能从源码里切出 views 字面量');
  const viewsLiteral = match[1];
  assert.ok(/(^|,)rentals:rentalsView(,|$)/.test(viewsLiteral), `② views 映射必须含 rentals:rentalsView，实得 ${viewsLiteral}`);

  // 判据自测：把 rentals 从映射里删掉后，同一条正则必须不命中 ——
  // 这正是变异 A 要打的位置。
  const mutated = viewsLiteral.replace(/,rentals:rentalsView/, '');
  assert.equal(/(^|,)rentals:rentalsView(,|$)/.test(mutated), false, '② 判据自测：删掉 rentals 后该正则必须不命中');
});

test('T41 ② 渲染 rentals 视图产出租赁管理内容（而不是空白或报错）', () => {
  const { app, elements } = loadAdminApp({
    rentalDeposits: [DEPOSIT_PENDING, DEPOSIT_SETTLED_FULL, DEPOSIT_SETTLED_PARTIAL, DEPOSIT_HELD]
  });
  const html = renderView(app, elements, 'rentals');
  assert.ok(html.length > 200, '② rentals 视图必须有实际内容');
  assert.ok(html.includes('待处理押金'), '② 必须有「待处理押金」分组');
  assert.ok(html.includes('已结算'), '② 必须有「已结算」分组');
  assert.ok(html.includes('冻结中'), '② 必须有「冻结中」分组');
  assert.ok(html.includes('SO20260901001'), '② 必须渲染出押金单对应的订单号');
  assert.ok(html.includes('远行租赁'), '② 必须渲染出商家名');
});

// ── ③ 其余 27 个 data-view 仍全部可切换 ──────────────────────────────────────

// 逐个写死，而不是「从 admin.html 里读出来再循环」：
// 读出来的写法在「有人删掉一个导航按钮」时会**自动通过**，
// 而这正是本用例要拦住的回归。
const EXISTING_VIEWS = [
  'dashboard', 'merchants', 'qualification', 'leads', 'products', 'stock', 'promos', 'reviews',
  'orders', 'payments', 'phones', 'recharges', 'finance', 'settlements', 'payouts',
  'market', 'forum', 'patrol', 'scores', 'serviceCollabs', 'broadband', 'plates',
  'afterSales', 'notifications', 'logs', 'admins', 'settings'
];

// ★ ③ 的**覆盖集**：27 个既有视图 + 新增的 `rentals` = 28。
//
// 为什么必须把 `rentals` 也算进来：变异 A（把 `rentals` 从 `views` 映射里删掉）改的是
// `admin.js`，而 27 个既有视图的渲染完全不受它影响 —— 只渲染那 27 个的 ③
// **在结构上就看不见 A**（不是"被别的缺陷掩盖"，是"根本没有观测能力"）。
// 把覆盖集扩到 28 之后，A 才会让 ③ 因为**正确的原因**转红。
const ALL_VIEWS = [...EXISTING_VIEWS, 'rentals'];

/**
 * 逐个渲染给定视图，把**全部**失败收集起来再返回。
 *
 * 刻意不在第一个失败处抛出：27 个视图是同一批改动的影响面，
 * 只报第一个会让「还有几个坏的」这个问题无法一次回答。
 *
 * @param {object} app 由 {@link loadAdminApp} 返回的 `{ state, render }`。
 * @param {Map} elements 伪造 DOM 的元素表。
 * @param {string[]} views 要渲染的视图名。
 * @param {string} html `admin.html` 的内容（用于核对导航项存在）。
 * @returns {{broken: string[], rendered: string[]}} 失败描述与成功渲染的视图名。
 */
function sweepViews(app, elements, views, html) {
  const broken = [];
  const rendered = [];
  for (const view of views) {
    if (!html.includes(`data-view="${view}"`)) {
      broken.push(`${view}: admin.html 缺少 data-view="${view}"`);
      continue;
    }
    try {
      renderView(app, elements, view);
    } catch (error) {
      broken.push(`${view}: 渲染抛错 —— ${error.message}`);
      continue;
    }
    const content = elements.get('#content').innerHTML;
    if (!(typeof content === 'string' && content.trim().length > 0)) {
      broken.push(`${view}: 产出空内容`);
      continue;
    }
    const title = elements.get('#pageTitle').textContent;
    if (!(typeof title === 'string' && title.trim().length > 0 && title !== 'undefined')) {
      broken.push(`${view}: 标题非法（${JSON.stringify(title)}）`);
      continue;
    }
    rendered.push(view);
  }
  return { broken, rendered };
}

test('T41 ③ 全部 28 个 data-view 必须可切换：其余 27 个逐个断言，外加新增的 rentals', () => {
  assert.equal(EXISTING_VIEWS.length, 27, '③ 判据自测：既有视图清单必须是 27 个');
  assert.equal(new Set(EXISTING_VIEWS).size, 27, '③ 判据自测：清单本身不能有重复项');
  assert.equal(ALL_VIEWS.length, 28, '③ 判据自测：覆盖集必须是 28 个（27 既有 + rentals）');

  const html = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');
  const { app, elements } = loadAdminApp({ rentalDeposits: [DEPOSIT_PENDING] });

  const { broken, rendered } = sweepViews(app, elements, ALL_VIEWS, html);
  assert.deepEqual(broken, [], `③ 以下视图不可切换：\n${broken.join('\n')}`);
  assert.equal(rendered.length, 28, `③ 28 个视图都必须成功渲染，实得 ${rendered.length}`);

  // 连同新增的 rentals，导航里一共 28 个可切换视图。
  const navViews = [...html.matchAll(/data-view="([a-zA-Z]+)"/g)].map((item) => item[1]);
  assert.equal(navViews.length, 28, `③ 导航项总数应为 28，实得 ${navViews.length}`);
  assert.equal(new Set(navViews).size, 28, '③ 导航项不得重复');
  assert.ok(navViews.includes('rentals'), '③ rentals 必须在导航里');
});

test('★ ③ 的判据基线：27 个既有视图在无变异时必须全部可渲染 —— 一个已经红的判据不能当探测器用', () => {
  // ── 这条用例存在的唯一理由，是把一条纪律变成可执行的断言 ──────────────────
  //
  // ③ 是「变异 A（把 rentals 从 views 映射里删掉）会不会转红」的探测器。
  // 但如果 ③ 在**没有任何变异**时就已经是红的，那它红的原因是别的缺陷，
  // 与被变异的 rentals 毫无关系 —— 此时 ③ 通过或失败**都不携带任何关于 A 的信息**。
  //
  // 本会话的真实事故：`notifications` 视图在 HEAD 就抛 `TypeError: rows.join is not a function`
  // （`admin.js:239` 把 `rows` 定义成了字符串，`:247` 却按数组传给 `table()`），
  // 于是 ③ 恒红；而它仍被写进变异 A 的预期里当探测器用，
  // 变异 A 跑出来的 ③ 报错与「完全没变异」时**逐字节相同**。
  //
  // 「判据不仅要能红，还要红在正确的原因上。」这条用例就是那句话的执行版本：
  // 它红了的时候，看到的人应当立刻明白 —— **问题不在被测代码，而在判据本身**。
  //
  // ★ 为什么本用例只扫 **27 个既有视图**，而 ③ 扫 28 个：
  // 要防的是「判据在**没有任何变异**时就已经是红的」。本轮的事故正是一个
  // **既有**视图（notifications）坏了把 ③ 变成恒红。
  // 把 `rentals` 排除在外，本用例才不会在「变异 A 正在生效」时跟着一起红 ——
  // 那时 `rentals` 本来就该红，而**基线本身仍然是干净的**。
  // 两个用例因此各自只回答一个问题：③ 问「28 个视图能不能切」，本用例问「基线脏没脏」。
  const html = fs.readFileSync(ADMIN_HTML_PATH, 'utf8');
  const { app, elements } = loadAdminApp({ rentalDeposits: [DEPOSIT_PENDING] });
  const { broken, rendered } = sweepViews(app, elements, EXISTING_VIEWS, html);

  assert.deepEqual(
    broken, [],
    '③ 的判据基线不干净 —— **一个已经红的判据不能当探测器用**。\n'
    + '③ 的职责是探测「变异 A：把 rentals 从 views 映射里删掉」会不会转红；\n'
    + '但下面这些**既有**视图（与 rentals 无关）无法渲染，会让 ③ 在没有任何变异时就红，\n'
    + '此时 ③ 的通过/失败都不携带关于 A 的信息。\n'
    + '请先修好这些视图（或把它们从 ③ 的覆盖集里显式排除并说明理由），③ 才能重新成为一个判据：\n'
    + broken.join('\n')
  );
  // 覆盖集必须恰好是 27 个：少一个就是"悄悄缩小覆盖范围来让判据变绿"，
  // 那与"判据恒红"是同一类问题的两种形态 —— 都是判据不再反映它声称要反映的东西。
  assert.equal(EXISTING_VIEWS.length, 27, '③ 的既有视图清单必须是 27 个，不得悄悄缩小');
  assert.equal(rendered.length, 27, `③ 的 27 个既有视图必须全部渲染成功，实得 ${rendered.length}/27`);
});

// ── ④⑤⑥ 分组与两个动作 ─────────────────────────────────────────────────────

test('T41 ④ REFUND_PENDING 的押金出现在「待处理押金」分组，并带两个动作按钮', () => {
  const { app, elements } = loadAdminApp({
    rentalDeposits: [DEPOSIT_PENDING, DEPOSIT_SETTLED_FULL, DEPOSIT_SETTLED_PARTIAL, DEPOSIT_HELD]
  });
  const html = renderView(app, elements, 'rentals');

  const pendingGroup = groupHtml(html, 'PENDING');
  assert.ok(pendingGroup.includes('SO20260901001'), '④ 待处理分组必须含该押金单');
  assert.ok(pendingGroup.includes('¥300.00'), '④ 待处理分组必须显示押金金额（走 money()）');
  assert.ok(pendingGroup.includes('待结算'), '④ 状态徽标应为「待结算」');
  assert.ok(pendingGroup.includes('settle-deposit'), '④ 必须有「全额退回」按钮');
  assert.ok(pendingGroup.includes('settle-deposit-partial'), '④ 必须有「扣款后退回」按钮');
  assert.ok(pendingGroup.includes('data-amount="30000"'), '④ 按钮必须带上押金金额（分）供扣款上限校验');

  // 另外两组不得混入待处理的单子 —— 分组必须是互斥的。
  assert.equal(groupHtml(html, 'SETTLED').includes('SO20260901001'), false, '④ 待处理单不得出现在「已结算」组');
  assert.equal(groupHtml(html, 'HELD').includes('SO20260901001'), false, '④ 待处理单不得出现在「冻结中」组');

  // 冻结中的单子不能带动作按钮：`HELD` 阶段 `settleRentalDeposit` 会 409。
  const heldGroup = groupHtml(html, 'HELD');
  assert.ok(heldGroup.includes('SO20260901004'), '④ 冻结中的单子应在「冻结中」组');
  assert.equal(heldGroup.includes('settle-deposit'), false, '④ 冻结中的单子不得出现结算按钮');
});

test('T41 ⑤ 全额退回后移出「待处理」并显示「已退回」', () => {
  const { app, elements } = loadAdminApp({
    rentalDeposits: [DEPOSIT_PENDING, DEPOSIT_SETTLED_FULL, DEPOSIT_SETTLED_PARTIAL, DEPOSIT_HELD]
  });
  const html = renderView(app, elements, 'rentals');

  const settledGroup = groupHtml(html, 'SETTLED');
  assert.ok(settledGroup.includes('SO20260901002'), '⑤ 已全额退回的单子必须在「已结算」组');
  assert.ok(settledGroup.includes('已退回'), '⑤ 状态徽标必须显示「已退回」');
  assert.equal(settledGroup.includes('settle-deposit"'), false, '⑤ 已结算的单子不得再出现「全额退回」按钮');
  assert.equal(groupHtml(html, 'PENDING').includes('SO20260901002'), false, '⑤ 已退回的单子必须已移出「待处理押金」组');

  // 分组对状态机的四个状态穷尽且互斥：每笔押金有且只有一个归属。
  const allDeposits = [DEPOSIT_PENDING, DEPOSIT_SETTLED_FULL, DEPOSIT_SETTLED_PARTIAL, DEPOSIT_HELD];
  for (const deposit of allDeposits) {
    const hits = ['PENDING', 'SETTLED', 'HELD']
      .filter((key) => groupHtml(html, key).includes(deposit.orderNo));
    assert.equal(hits.length, 1, `⑤ ${deposit.orderNo}（${deposit.status}）必须恰好出现在一个分组里，实得 ${JSON.stringify(hits)}`);
  }
});

test('T41 ⑥ 扣款 5000 分后退回，金额显示「已扣 ¥50.00」（两位小数）', () => {
  const { app, elements } = loadAdminApp({
    rentalDeposits: [DEPOSIT_SETTLED_PARTIAL]
  });
  const html = renderView(app, elements, 'rentals');

  assert.ok(html.includes('已扣 ¥50.00'), '⑥ 必须显示「已扣 ¥50.00」（两位小数，与可退还金额口径一致）');
  assert.ok(html.includes('¥250.00'), '⑥ 必须显示退回金额 ¥250.00');
  assert.ok(html.includes('¥300.00'), '⑥ 必须显示押金总额 ¥300.00');
  assert.ok(html.includes('扣款后已退回'), '⑥ 状态徽标应为「扣款后已退回」');
  assert.ok(html.includes('扣款后已退回'), '⑥ 徽标不得退化成原始状态码');

  // 判据自测：整数写法（¥50）不应被误判为通过 —— 本用例要拦的正是变异 C。
  assert.equal(html.includes('已扣 ¥50<'), false, '⑥ 判据自测：不得出现整数写法「已扣 ¥50<」');
  assert.equal('¥50.00'.includes('¥50.00'), true, '⑥ 判据自测：字符串比较本身可用');
});

test('T41 ⑥ 「扣款后退回」把「元」输入换算成「分」提交，全额退回提交 0', async () => {
  const posted = [];
  const fetchImpl = async (url, opts = {}) => {
    if (String(url).includes('/settle')) {
      posted.push({ url: String(url), body: JSON.parse(opts.body) });
      return { ok: true, status: 200, json: async () => ({ data: { deposit: {} } }) };
    }
    return { ok: true, status: 200, json: async () => ({ data: String(url).includes('/api/admin/rental-deposits') ? [] : {} }) };
  };

  // 第一轮：扣款输入「50」（元）→ 必须提交 5000（分）。
  const partialButton = { dataset: { id: 'dep_pending_001', amount: '30000' }, addEventListener: (type, handler) => { partialButton.handler = handler; } };
  const first = loadAdminApp({
    rentalDeposits: [DEPOSIT_PENDING],
    prompts: ['50', '车辆归还时存在损坏'],
    selectorResults: { '.settle-deposit-partial': [partialButton] },
    fetchImpl
  });
  renderView(first.app, first.elements, 'rentals');
  assert.equal(typeof partialButton.handler, 'function', '⑥ 扣款按钮必须绑定 click 处理器');
  await partialButton.handler();
  assert.equal(posted.length, 1, '⑥ 应发出一次结算请求');
  assert.equal(posted[0].url, '/api/admin/rental-deposits/dep_pending_001/settle', '⑥ 应打 T36 的结算端点');
  assert.equal(posted[0].body.deductionInCents, 5000, '⑥ 输入 50 元必须提交 5000 分');
  assert.equal(Number.isInteger(posted[0].body.deductionInCents), true, '⑥ deductionInCents 必须是整数分');
  assert.equal(posted[0].body.note, '车辆归还时存在损坏', '⑥ 扣款说明必须一并提交');

  // 判据自测：若直接把「元」当「分」提交（变异 C 的另一种形态），值会是 50 而不是 5000。
  assert.notEqual(posted[0].body.deductionInCents, 50, '⑥ 判据自测：不得把 50 直接当作分提交');

  // 第二轮：全额退回 → 必须提交 0，且不弹扣款输入。
  posted.length = 0;
  const fullButton = { dataset: { id: 'dep_pending_001', amount: '30000' }, addEventListener: (type, handler) => { fullButton.handler = handler; } };
  const second = loadAdminApp({
    rentalDeposits: [DEPOSIT_PENDING],
    prompts: ['用户已按期归还车辆，车况正常'],
    selectorResults: { '.settle-deposit': [fullButton] },
    fetchImpl
  });
  renderView(second.app, second.elements, 'rentals');
  assert.equal(typeof fullButton.handler, 'function', '⑥ 全额退回按钮必须绑定 click 处理器');
  await fullButton.handler();
  assert.equal(posted.length, 1, '⑥ 应发出一次结算请求');
  assert.equal(posted[0].body.deductionInCents, 0, '⑥ 全额退回必须提交 deductionInCents: 0');
});

test('T41 押金接口失败时必须显式报错，不得静默渲染成「没有押金」', () => {
  const { app, elements } = loadAdminApp({ rentalDepositsError: '登录已失效' });
  const html = renderView(app, elements, 'rentals');
  assert.ok(html.includes('押金读取失败'), '接口失败必须显式提示');
  assert.ok(html.includes('登录已失效'), '必须把原始错误带出来');
});

// ── ⑦ money() 是唯一格式化入口 ──────────────────────────────────────────────

test('T41 ⑦ 金额格式化必须复用 money()，不得引入第二个格式化函数', () => {
  const source = fs.readFileSync(ADMIN_JS_PATH, 'utf8');

  const currencySymbols = (source.match(/¥/g) || []).length;
  assert.equal(currencySymbols, 1, `⑦ 货币符号全文件只允许出现在 money() 里一次，实得 ${currencySymbols} 次`);
  const moneyLine = source.split('\n').find((line) => line.includes('¥'));
  assert.ok(/^const money=/.test(moneyLine), `⑦ 唯一那处货币符号必须在 money() 定义里，实得：${moneyLine.slice(0, 80)}`);

  const toFixedCalls = (source.match(/toFixed/g) || []).length;
  assert.equal(toFixedCalls, 0, `⑦ 不得另写定点小数格式化，实得 ${toFixedCalls} 处`);

  // 判据自测：这两条计数确实能区分「有一处」和「有两处」。
  assert.equal(('a ¥1.00'.match(/¥/g) || []).length, 1, '⑦ 判据自测：单处命中计为 1');
  assert.equal(('a ¥1.00 b ¥2.00'.match(/¥/g) || []).length, 2, '⑦ 判据自测：两处命中必须计为 2');
  assert.equal((('1.00'.includes('toFixed') ? 1 : 0)), 0, '⑦ 判据自测：不含 toFixed 的字符串必须计为 0');

  // 视图实际产出必须来自 money()：分 → 两位小数元。
  const { app, elements } = loadAdminApp({ rentalDeposits: [DEPOSIT_PENDING] });
  const html = renderView(app, elements, 'rentals');
  assert.ok(html.includes('¥300.00'), '⑦ 视图金额必须是 money() 的两位小数形态');
});

// ── #63 `money()` 负值形态：负号必须在币种【之前】 ────────────────────────────
//
// 现状 `money(-12000)` → `¥-120.00`（负号在 `¥` **之后**）；中文财务惯例是 `-¥120.00`。
// 这是**通用**缺陷：`money()` 是唯一的金额格式化入口（⑦ 已把这一点钉死），
// 所以每一处负值渲染都受影响 —— 总览的「退款支出」「商家打款」「资金净额」在常见数据下都是负的。
//
// 形态要求（与 ⑦ 的三条约束**同时**成立）：
//   ① 全文件 `¥` 仍只有 1 处；② 含 `¥` 那行仍以 `const money=` 开头（**不能有空格**）；③ 仍不用 `toFixed`。

test('#63 负值金额必须渲染成 -¥X（负号在币种之前），且正数形态不变', () => {
  // ★ 判据自测（放在最前，与渲染无关）：收集器必须只记录**不满足**项。
  //   若收集器恒空，下面那条 `violations.length === 0` 就是装饰。
  const probe = [];
  const probeExpect = (ok, message) => { if (!ok) probe.push(message); };
  probeExpect(false, 'A');
  probeExpect(true, 'B');
  probeExpect(false, 'C');
  assert.deepEqual(probe, ['A', 'C'], '#63 判据自测：收集器必须只记录不满足项');

  const data = overviewShape();
  // 财务面板直接消费 `financeSummary` 的出账字段（两者带符号、为负）。
  data.financeSummary = {
    paymentInCents: 120000,
    refundOutCents: -24900,
    payoutOutCents: -2300,
    netInCents: 92800
  };
  const { app, elements } = loadAdminApp({ data });
  const html = renderView(app, elements, 'finance');

  // 边界：1 分（最小单位）与 0 分（不得写成 -¥0.00）各自单独渲染一次。
  const cent = overviewShape();
  cent.financeSummary = { paymentInCents: 0, refundOutCents: -1, payoutOutCents: 0, netInCents: -1 };
  const second = loadAdminApp({ data: cent });
  const centHtml = renderView(second.app, second.elements, 'finance');

  // ★ 四组条件**全部求值后**再一次性断言。
  //   此前 ②（负值形态）用的是 `assert.ok`：它一旦抛错，③④ 就是**从未执行**——
  //   红跑里那两条的判别力**无从证明**（「非空转」不能靠「它们看起来对」来声称）。
  const violations = [];
  const expect = (ok, message) => { if (!ok) violations.push(message); };

  // ① 正数形态**不得**被改变 —— 这是回归保护，不是本次的目标。
  //    ★ 这两条同时是「面板真的渲染了 money() 输出」的**正向锚点**：它们若成立，
  //      下面的负值断言就不是在空 HTML 上求值。
  expect(html.includes('¥1,200.00'), '正数必须仍是 ¥1,200.00（本次不得改动正数形态）');
  expect(html.includes('¥928.00'), '正数必须仍是 ¥928.00（本次不得改动正数形态）');

  // ② ★ 负值：负号必须在币种【之前】。
  expect(html.includes('-¥249.00'), '退款支出必须渲染成 -¥249.00（负号在币种之前）');
  expect(html.includes('-¥23.00'), '商家打款必须渲染成 -¥23.00（负号在币种之前）');

  // ③ ★ 不得残留「¥-」形态。
  expect(!html.includes('¥-'), '不得出现「¥-」形态（负号在币种之后）');

  // ④ 边界：1 分（最小单位）也必须是 -¥0.01，而不是 ¥-0.01；零不得被写成 -¥0.00。
  expect(centHtml.includes('-¥0.01'), '1 分必须渲染成 -¥0.01（负号在币种之前）');
  expect(!centHtml.includes('¥-'), '1 分场景也不得出现「¥-」形态');
  expect(centHtml.includes('¥0.00'), '零必须仍是 ¥0.00，不得写成 -¥0.00');
  expect(!centHtml.includes('-¥0.00'), '零不得渲染成 -¥0.00');

  assert.equal(violations.length, 0, `#63 金额形态共 ${violations.length} 条不满足：\n  - ${violations.join('\n  - ')}`);
});

// ── (b) 结构式判据：状态码必须都有中文标签，不得回落成原样英文代码 ──────────────
//
// `label(v)` 的定义是 `statuses[v]||v||'—'` ⇒ **只要 `v` 不是 `statuses` 的 key，
// 它就被原样显示给用户**（英文代码直接进页面）。本判据把「会被 `label()` 消费的状态码」
// 全部枚举出来，逐个要求它是 `statuses` 的 key。
//
// ★ key 集必须取【运行时】的 `statuses`，**不能**只解析第 6 行的字面量 ——
//   `statuses` 还被 3 处**顶层** `Object.assign(statuses, …)` 追加
//   （leads / admins / market）。只取字面量会在 `marketView` 的
//   `['ACTIVE','RESERVED','SOLD','REMOVED']` 上**误红** —— 那 4 个是 market 合法追加的。
//   而误红之后最危险的「修法」是把这 4 个塞进第 6 行字面量，那会把 market 语义
//   **固化进全局字典**，加重「同名 key 跨域覆盖」问题（如 `ACTIVE` 先写「启用」后被写成「在售」）。
//
// ★ 三种 `statusesList` 形态都要覆盖 —— 缺任何一种就是**静默漏报**：
//   ① 数组字面量   `statusesList:['PENDING','PAID']`
//   ② 引用形态     `statusesList: options.afterSales`   ← 不是字面量
//   ③ 命名常量     `statusesList: leadStatuses`
//   并且 `statusControl()` 走的是 **`options[view]`**，**完全不经过 `statusesList`**
//   ⇒ 只扫 `statusesList` 的判据**天然覆盖不到它**，必须单独覆盖。

test('(b) 状态码不得回落成原样英文：statusesList 三形态 + statusControl 的 options 全覆盖', () => {
  const source = fs.readFileSync(ADMIN_JS_PATH, 'utf8');
  const { app } = loadAdminApp({});
  const statusKeys = Object.keys(app.statuses);

  // 判据本体：返回违规列表（空 = 通过）。抽成函数是为了能做下面的**反向控制**。
  const violationsOf = (name, list) => {
    if (!Array.isArray(list)) return [`${name} 求值结果不是数组（实得 ${typeof list}）—— 判据无法检查它`];
    return list
      .filter((code) => !statusKeys.includes(code))
      .map((code) => `${name} 里的 ${code} 不是 statuses 的 key（会被原样显示成英文代码）`);
  };

  // ① + ② + ③：源码里每一处 `statusesList: <expr>`，把 `<expr>` 在模块上下文里求值。
  //   用「求值」而不是「解析字面量」，三种形态就统一覆盖了，将来加新形态也不会漏。
  //   ★ 正则必须吃下**点号路径**（`options.afterSales`）：只写 `[A-Za-z_$][\w$]*`
  //     会停在 `options` 上，求值得到整个 `options` 对象 ⇒ 判据静默失效。
  const sites = [...source.matchAll(/statusesList\s*:\s*(\[[^\]]*\]|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/g)];
  // ★ 完备性自测：不得漏扫任何一处 `statusesList:`（正则若漏掉一种形态，这里会红）。
  const rawSites = (source.match(/statusesList\s*:/g) || []).length;
  assert.equal(sites.length, rawSites,
    `(b) 判据自测：扫描到的 statusesList 站点数必须等于源码里的总数（扫到 ${sites.length} / 实际 ${rawSites}）`);

  const violations = [];
  let literalForms = 0;
  let referenceForms = 0;
  for (const site of sites) {
    const line = source.slice(0, site.index).split('\n').length;
    const expr = site[1];
    if (expr.startsWith('[')) literalForms += 1; else referenceForms += 1;
    let list;
    try {
      list = vm.runInNewContext(expr, app, { timeout: 2000 });
    } catch (error) {
      violations.push(`L${line} statusesList:${expr} 无法在模块上下文求值（${error.message}）`);
      continue;
    }
    violations.push(...violationsOf(`L${line} statusesList:${expr}`, list));
  }
  // 两种形态都必须**真的被扫到**，否则「三种形态全覆盖」是自称的。
  assert.ok(literalForms >= 10, `(b) 判据自测：字面量形态至少 10 处，实得 ${literalForms}`);
  assert.ok(referenceForms >= 6, `(b) 判据自测：引用形态至少 6 处，实得 ${referenceForms}`);

  // ④ `statusControl` 走 `options[view]`，不经过 `statusesList` ⇒ 单独覆盖全部 6 组。
  const optionGroups = Object.entries(app.options);
  assert.ok(optionGroups.length >= 6, `(b) 判据自测：options 至少 6 组，实得 ${optionGroups.length}`);
  for (const [view, list] of optionGroups) violations.push(...violationsOf(`options.${view}`, list));

  assert.equal(violations.length, 0, `(b) 状态码回落共 ${violations.length} 条：\n  - ${violations.join('\n  - ')}`);

  // ★ 反向控制（判据必须能红）：
  //   ① 塞一个确实不存在的状态码 ⇒ 必须被报出；
  //   ② 合法 key（**含 `Object.assign` 追加的** `ACTIVE`/`RESERVED`）⇒ 不得误报。
  assert.deepEqual(
    violationsOf('自测', ['PENDING', '__NOT_A_STATUS__']),
    ['自测 里的 __NOT_A_STATUS__ 不是 statuses 的 key（会被原样显示成英文代码）'],
    '(b) 判据自测：不存在的状态码必须被报出'
  );
  assert.deepEqual(
    violationsOf('自测', ['PENDING', 'ACTIVE', 'RESERVED', 'SOLD', 'REMOVED', 'DISABLED']),
    [],
    '(b) 判据自测：合法 key（含 Object.assign 追加的）不得被误报'
  );
});

// ── (b2) 端到端：渲染真实数据后，`label()` 不得收到任何没有中文标签的值 ──────────────
//
// ★ 为什么 (b) 不够：`(b)` 只扫 `statusesList` 与 `options` 两条**静态**路径。
//   而 `label()` 还有第三条路径 —— **行内动态值**，例如 `phones` / `recharges` 的
//   `label(x.paymentStatus)`。服务端确实会写 `paymentStatus:'UNPAID'`（见 `src/app.js`），
//   而 `UNPAID` 曾经不在 `statuses` 里 ⇒ 页面把英文 `UNPAID` 直接显示给用户。
//   ★ 实测（变异：把补上的 4 个 key 删回去）：`(b)` **只报出 3 条**（PAYMENT/REFUND/PAYOUT），
//     对 `UNPAID` **恒绿** ⇒ 单靠 (b)，`UNPAID` 的修复**无人看守**。
// ⇒ 补一条**渲染级**判据：把 `label()` 打桩记录实参，渲染全部可达视图，
//   断言「没有任何实参不在 `statuses` 里」。它与路径形态无关 ⇒ 覆盖所有路径。

test('(b2) 端到端：渲染真实数据后，label() 不得收到任何没有中文标签的值', () => {
  const MARKER = "const label=v=>statuses[v]||v||'—';";
  const instrument = (source) => {
    // 判据自测：定位不到 `label()` 定义就必须红，否则打桩会**静默失效**（判据恒绿）。
    assert.ok(source.includes(MARKER), '(b2) 判据自测：必须能定位 label() 定义');
    return source.replace(MARKER,
      "const label=v=>{ if(v!==undefined&&v!==null&&v!==''&&!(v in statuses)){__unknown.push(v);} return statuses[v]||v||'—'; };");
  };

  // 每个集合里**会被 `label()` 消费**的字段，以及它们的取值域（取自服务端实测）。
  const PAY_STATUSES = ['UNPAID', 'PAID', 'CANCELLED', 'EXPIRED', 'PARTIALLY_REFUNDED', 'REFUNDED'];
  const SPEC = {
    orders: { status: ['PENDING_PAYMENT', 'PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED', 'AFTER_SALE'], paymentStatus: PAY_STATUSES, base: { orderNo: 'SO1', totalInCents: 100, items: [] } },
    paymentOrders: { status: ['PENDING', 'PAID', 'CANCELLED', 'PARTIALLY_REFUNDED', 'REFUNDED'], paymentStatus: PAY_STATUSES, base: {} },
    phoneCardOrders: { status: ['PENDING_PAYMENT', 'PENDING_REALNAME', 'ACTIVATED', 'CANCELLED', 'REJECTED'], paymentStatus: PAY_STATUSES, base: { customerName: 'c', phone: '1', planName: 'p', amountInCents: 1 } },
    rechargeOrders: { status: ['PENDING_PAYMENT', 'PENDING_CREDIT', 'CREDITED', 'CANCELLED', 'REJECTED'], paymentStatus: PAY_STATUSES, base: { phone: '1', paidInCents: 1, receiveInCents: 1 } },
    plateApplications: { status: ['PENDING_PAYMENT', 'MATERIAL_PENDING', 'REVIEWING', 'COMPLETED', 'REJECTED'], paymentStatus: PAY_STATUSES, base: { customerName: 'c', studentNo: 's' } },
    afterSales: { status: ['SUBMITTED', 'REVIEWING', 'CLOSED', 'REJECTED'], base: { orderId: 'o', type: 'REFUND', quantity: 0, customerName: 'c' } },
    broadbandApplications: { status: ['PENDING_VERIFY', 'APPROVED', 'REJECTED'], base: { ownerPhone: '1', companionPhone: '2' } },
    marketItems: { status: ['ACTIVE', 'RESERVED', 'SOLD', 'REMOVED'], base: { title: 't', sellerName: 's', categoryText: 'c', conditionText: 'k', priceText: '1', contact: 'x', statusText: 'z' } },
    productReviews: { visibility: ['PUBLISHED', 'HIDDEN'], base: { rating: 5, content: 'c', productId: 'p' } },
    forumPosts: { status: ['PUBLISHED', 'HIDDEN'], base: { title: 't', authorName: 'a', boardText: 'b', content: 'c', likes: 1, commentCount: 1 } },
    merchantScores: { grade: ['EXCELLENT', 'GOOD', 'WATCH', 'RISK'], stage: ['NORMAL', 'LIMITED', 'RESTRICTED'], base: { score: 90, merchantName: 'm' } },
    slaAlerts: { level: ['OVERDUE', 'WARNING'], status: ['OPEN', 'ACKNOWLEDGED', 'RESOLVED'], base: { title: 't', ownerName: 'o' } },
    settlements: { settlementStatus: ['PENDING_DELIVERY', 'IN_ACCOUNT_PERIOD', 'FROZEN', 'PENDING_SETTLE', 'PAYOUT_REQUESTED', 'SETTLED', 'REFUNDED'], base: { merchantName: 'm', amountInCents: 1 } },
    payoutRequests: { status: ['PENDING_REVIEW', 'SETTLED', 'REJECTED', 'CANCELLED'], base: { merchantName: 'm', amountInCents: 1 } },
    leads: { status: ['SUBMITTED', 'FOLLOW_UP', 'COMPLETED', 'INVALID'], base: { customerName: 'c', businessType: 'b' } },
    qualificationRenewals: { status: ['PENDING_REVIEW', 'APPROVED', 'REJECTED'], base: { merchantName: 'm' } },
    merchants: { status: ['APPROVED', 'PENDING_REVIEW', 'REJECTED'], base: { name: 'n' } },
    financeEvents: { eventType: ['PAYMENT', 'REFUND', 'PAYOUT', 'DEPOSIT_SETTLEMENT'], base: { amountInCents: 1, referenceId: 'r' } },
    adminUsers: { status: ['ACTIVE', 'DISABLED'], base: { username: 'u', displayName: 'd', role: 'OPERATOR' } }
  };

  // 造行：每个字段的每个取值各一行，其余字段取该字段的第一个值。
  const buildRows = (spec) => {
    const fieldNames = Object.keys(spec).filter((key) => key !== 'base');
    const out = [];
    let index = 0;
    for (const field of fieldNames) {
      for (const value of spec[field]) {
        const row = { id: `r${index}`, createdAt: '2026-01-01T00:00:00Z', ...(spec.base || {}) };
        for (const other of fieldNames) row[other] = spec[other][0];
        row[field] = value;
        index += 1;
        out.push(row);
      }
    }
    return out;
  };

  const data = overviewShape();
  for (const [collection, spec] of Object.entries(SPEC)) data[collection] = buildRows(spec);

  // ★ 视图清单必须含 `admins`：它在 `:265` 的 `views` 表里**没有**，
  //   而是在 `render` 被**重新赋值**时（`if (state.view === 'admins')`）接进来的。
  //   只读 `:265` 会漏掉它 —— 而它恰恰是 `ACTIVE` 标签被覆盖后的渲染点。
  const VIEWS = ['dashboard', 'merchants', 'qualification', 'leads', 'products', 'stock', 'promos',
    'reviews', 'market', 'forum', 'orders', 'payments', 'phones', 'recharges', 'finance',
    'serviceCollabs', 'settlements', 'payouts', 'rentals', 'patrol', 'scores', 'broadband',
    'plates', 'afterSales', 'notifications', 'logs', 'settings', 'admins'];

  const seen = new Set();
  const silent = [];
  for (const view of VIEWS) {
    const { app, elements } = loadAdminApp({ data, sourceTransform: instrument });
    const html = renderView(app, elements, view);
    // 判据自测：视图必须**真的渲染出内容**，否则「扫过了」是假的。
    if (!html) silent.push(view);
    for (const value of app.__unknown) seen.add(value);
  }
  assert.deepEqual(silent, [], `(b2) 判据自测：以下视图没有渲染出任何内容：${JSON.stringify(silent)}`);

  assert.equal(seen.size, 0,
    `(b2) 以下状态码没有中文标签，会被原样显示成英文代码：${JSON.stringify([...seen])}`);

  // ★ 反向控制：打桩必须真的能捕获（否则上面那条断言恒绿，判据就是装饰）。
  const probeData = overviewShape();
  probeData.phoneCardOrders = [{
    id: 'x', status: 'PENDING_PAYMENT', paymentStatus: '__NOT_A_STATUS__',
    customerName: 'c', phone: '1', planName: 'p', amountInCents: 1, createdAt: '2026-01-01T00:00:00Z'
  }];
  const probe = loadAdminApp({ data: probeData, sourceTransform: instrument });
  renderView(probe.app, probe.elements, 'phones');
  assert.deepEqual([...probe.app.__unknown], ['__NOT_A_STATUS__'],
    '(b2) 判据自测：打桩必须能捕获不存在的状态码');
});
