/**
 * 租赁域：租赁订单项与押金记录构造。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 *
 * ## 押金隔离三层防线（改这个文件前必须先读懂）
 *
 * 分账（`app.js` 的 `createSettlements`）与售后退款用的是同一个取值模式：
 *
 * ```js
 * Number(item.subtotalInCents || (Number(item.priceInCents || 0) * Number(item.quantity || 0)))
 * ```
 *
 * 注意是 `||` 而不是 `??`：只要 `subtotalInCents` 为 0 或空，金额就会回退到
 * `priceInCents × quantity`。租赁商品的原售价是 319900 分，而日租只有 1500 分 ——
 * 一旦回退取到售价，商家分账金额会**膨胀两个数量级**，而打款不可逆。因此：
 *
 * - **L1**：押金**绝不**写入 `order.items[].subtotalInCents` —— 该字段只承载租金；
 * - **L2**：`order.items[].priceInCents` 也承载**租金**（不是商品售价），
 *   这样即使真的发生 `||` 回退，回退到的也是正确租金；
 * - **L3**：测试断言 `priceInCents === 租金合计`，任何回退膨胀都会立刻转红。
 *
 * 关键推论：押金不进 `subtotalInCents` ⇒ `createSettlements` 无需为租赁做任何改动，
 * 它天然只汇总租金。**禁止为了租赁单独修改分账逻辑。**
 *
 * 押金自身只活在 `data.rentalDeposits` 里（`status: 'HELD'`），
 * 与交易对价（租金）在数据结构上完全隔离。
 */

const { randomUUID } = require('node:crypto');
const { ApiError } = require('../http/api-error');

/**
 * 租期单位的中文名，仅用于错误提示。
 *
 * @param {string} unit 租期单位（`'DAY'` / `'HOUR'`）。
 * @returns {string} 中文单位名。
 */
function rentalUnitLabel(unit) {
  return unit === 'HOUR' ? '小时' : '天';
}

/**
 * 构造租赁订单项。
 *
 * 返回的 `subtotalInCents` **只含租金**（L1），`priceInCents` 也是租金单价（L2）。
 * 押金不在这里 —— 它由 {@link createRentalDeposit} 单独成条，不参与分账。
 *
 * @param {object} product 已带规范化 `rentalPlan` 的租赁商品。
 * @param {unknown} rentalUnits 用户选择的租期数量。
 * @returns {object} 订单项（`quantity` 恒为 1，因为一单只租一台车）。
 * @throws {ApiError} 400 VALIDATION_ERROR —— 租期非整数或越界、租赁方案不完整。
 */
function buildRentalOrderItem(product, rentalUnits) {
  const source = product || {};
  const plan = source.rentalPlan || {};
  const name = source.name || source.id || '租赁商品';
  const minUnits = Number(plan.minUnits);
  const maxUnits = Number(plan.maxUnits);
  const unitRentInCents = Number(plan.unitPriceInCents);
  if (!Number.isInteger(minUnits) || !Number.isInteger(maxUnits) || minUnits <= 0
    || !Number.isInteger(unitRentInCents) || unitRentInCents <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} 的租赁方案不完整，无法下单`);
  }
  const units = Number(rentalUnits);
  if (!Number.isInteger(units)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `items[].rentalUnits 必须是整数（${name} 按${rentalUnitLabel(plan.unit)}计租）`);
  }
  if (units < minUnits || units > maxUnits) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${name} 租期必须是 ${minUnits} 到 ${maxUnits} ${rentalUnitLabel(plan.unit)}`);
  }
  return {
    productId: source.id,
    merchantId: source.merchantId || '',
    name: source.name,
    // ★ L2：承载**该订单项的整项租金**（= 日租单价 × 租期），而不是商品售价。
    //
    // 为什么不是「单价」：分账与售后退款都用 `subtotalInCents || priceInCents × quantity`
    // 取值，而租赁项 quantity 恒为 1。若这里填单价 1500，一旦回退就会把整项租金
    // 少算成 1500（少收 2/3 租金）；填整项租金 4500，回退结果才恰好正确。
    // 同时保持售卖路径的不变量 `subtotalInCents === priceInCents × quantity`。
    // 单价可由 `subtotalInCents / rentalUnits` 还原，无需额外字段。
    priceInCents: unitRentInCents * units,
    // 买断参考价仅作前端展示，不参与任何金额计算。
    originalPriceInCents: Number(source.priceInCents) || 0,
    quantity: 1,
    // ★ L1：只含租金，押金绝不进来。
    subtotalInCents: unitRentInCents * units,
    rentalUnits: units,
    rentalUnit: plan.unit
  };
}

/**
 * 租期单位 → 毫秒。
 *
 * 与前端 `miniprogram/utils/product-view.js` 的 `RENTAL_UNIT_STEP_MS` 保持同一口径。
 * 表里查不到的单位按 `DAY` 兜底 —— 与建单时 `item.rentalUnit === 'HOUR' ? ... : 天`
 * 的原始语义完全一致（即「不是 HOUR 就当 DAY」）。
 *
 * @type {Readonly<Record<string, number>>}
 */
const RENTAL_UNIT_MS = Object.freeze({
  DAY: 24 * 60 * 60 * 1000,
  HOUR: 60 * 60 * 1000
});

/**
 * 计算一张订单的租期长度（毫秒）。
 *
 * **建单与支付两处都必须走这一个函数**：租期的起算时点从「建单」改到「支付成功」
 * 之后，如果两处各算一遍，公式一旦漂移就会出现「建单算 3 天、支付算 2 天」这类
 * 无法从订单数据上看出来的错账。抽成单一实现后，这类漂移在结构上不可能发生。
 *
 * 多租赁项取**最长**租期（而不是求和）：一张订单的车是同时交付、同时归还的，
 * 整体可租时长由最长的那一项决定。这个口径与建单时的原始实现逐字一致。
 *
 * @param {Array<object>} [orderItems] 订单项列表（租赁项带 `rentalUnits` / `rentalUnit`）。
 * @returns {number} 租期毫秒数；无租赁项时返回 0。
 */
function rentalDurationMsOf(orderItems) {
  const items = Array.isArray(orderItems) ? orderItems : [];
  return items.reduce((longest, item) => {
    const units = Number(item && item.rentalUnits);
    if (!Number.isInteger(units) || units <= 0) return longest;
    const stepMs = RENTAL_UNIT_MS[item.rentalUnit] || RENTAL_UNIT_MS.DAY;
    return Math.max(longest, units * stepMs);
  }, 0);
}

/**
 * 租赁状态机的合法迁移表。
 *
 * ```
 * PENDING_PAYMENT --(支付成功/startRental)--> RENTING
 * RENTING --RETURN_REQUEST--> RETURN_REQUESTED --RETURN_VERIFY--> RETURNED
 * ```
 *
 * `PENDING_PAYMENT`（已建单、未支付）**刻意没有任何出边**：租期尚未起算，
 * 用户不该能申请归还。支付成功由 {@link startRental} 直接写入 `RENTING`，
 * 不走这张迁移表 —— 「支付成功」是订单域的外部事件，不是租赁状态机上的动作。
 *
 * 表是「动作 → { 当前状态 → 下一个状态 }」的二维映射：动作不在表里、
 * 或当前状态没有出边，都属于非法迁移（统一抛 409 `ACTION_NOT_ALLOWED`）。
 * 状态一旦走到 `RETURNED` 就没有出边 —— 归还核验不可回退，因为押金结算与
 * 分账打款都已在下游发生。
 *
 * @type {Readonly<Record<string, Readonly<Record<string, string>>>>}
 */
const RENTAL_ACTIONS = Object.freeze({
  RETURN_REQUEST: Object.freeze({ RENTING: 'RETURN_REQUESTED' }),
  RETURN_VERIFY: Object.freeze({ RETURN_REQUESTED: 'RETURNED' })
});

/**
 * 「该动作已经成功执行过」时使用的专属错误码。
 *
 * 只有**不可逆的终态迁移**才配一个专属码。`RETURN_VERIFY` 一旦成功，就同时改动了
 * 库存（回补）、押金（转待退）、分账（进账期）与订单状态（COMPLETED）——商家双击、
 * 客户端重试、网络重发都会再打一次这个接口。此时返回通用的 `ACTION_NOT_ALLOWED`
 * 会让前端无法区分「已经成功了」和「操作非法」，只能靠额外查一次订单状态来猜。
 *
 * `RETURN_REQUEST` 没有副作用、也不是终态，重复提交按普通非法迁移处理即可，
 * 不需要专属码。这个不对称是**有意**的，不是遗漏。
 *
 * @type {Readonly<Record<string, string>>}
 */
const RENTAL_ACTION_DONE_CODES = Object.freeze({ RETURN_VERIFY: 'RENTAL_ALREADY_RETURNED' });

/**
 * 判断订单是否是一张可走租赁状态机的租赁单。
 *
 * `orderKind === 'RENTAL'` 与 `order.rental` 必须同时成立：只有前者意味着
 * 数据形态已经损坏（T33 建单时会同时写入），此时任何租赁动作都必须失败，
 * 而不是在 `undefined` 上继续读写状态。
 *
 * @param {object} order 订单。
 * @returns {boolean} 是否为形态完整的租赁单。
 */
function isRentalOrder(order) {
  return Boolean(order && order.orderKind === 'RENTAL' && order.rental);
}

/**
 * 支付成功 ⇒ 租赁周期正式开始（租期起算的**唯一入口**）。
 *
 * ## 为什么需要这个函数（改动前的真实缺口）
 *
 * 改动前建单时 `rental.status` 直接写成 `'RENTING'`、`dueAt` 按建单时刻算。
 * 后果有两条，第二条是资损级的：
 *
 * 1. **未支付单被当作「已支付待取车」**：订单页进度条第 1 步直接点亮，
 *    用户还没付钱就看到「凭交付码到校内取车点取车」。
 * 2. **租期在支付前就开始消耗**：`dueAt` 由建单时刻推出，用户不付款时
 *    `paymentTimeoutMinutes` 关单，但那一段租期窗口已经被烧掉了。
 *
 * 更严重的是：`RETURN_REQUEST` 的迁移表是 `{ RENTING: 'RETURN_REQUESTED' }`，
 * 而未支付单也是 `RENTING` —— 于是**未支付单可以成功申请归还**（已实测复现）。
 *
 * ## 改动后的语义
 *
 * 建单 ⇒ `rental.status = 'PENDING_PAYMENT'`、`dueAt = null`（占用，不消耗租期）；
 * 支付成功 ⇒ 本函数把状态推进到 `'RENTING'` 并按**支付时刻**起算 `dueAt`。
 *
 * 这样一来「未支付不能申请归还」**由状态机本身保证** —— `PENDING_PAYMENT`
 * 在 `RENTAL_ACTIONS.RETURN_REQUEST` 里没有出边，天然 409。
 * 洞口被关掉，而不是在每条调用路径上再加一道支付判断。
 *
 * @param {object} order 订单（原地修改 `order.rental`）。
 * @param {string|Date} [now] 支付时刻，缺省为当前时间。
 * @returns {object|null} 起算后的 `order.rental`；非租赁单返回 `null`。
 */
function startRental(order, now) {
  if (!isRentalOrder(order)) return null;
  const paidAt = now === undefined || now === null ? new Date() : new Date(now);
  const startedAt = Number.isFinite(paidAt.getTime()) ? paidAt : new Date();
  order.rental.status = 'RENTING';
  order.rental.dueAt = new Date(startedAt.getTime() + rentalDurationMsOf(order.items)).toISOString();
  return order.rental;
}

/**
 * 在租赁状态机上执行一个动作（唯一的状态迁移入口）。
 *
 * 只做状态迁移，不碰订单状态、不碰分账 —— 那些由调用方在迁移成功后显式触发，
 * 保证「状态机」与「资金/订单副作用」的职责分离。
 *
 * @param {object} order 租赁订单（原地修改 `order.rental.status`）。
 * @param {string} action 动作名，见 {@link RENTAL_ACTIONS}。
 * @returns {string} 迁移后的 `rental.status`。
 * @throws {ApiError} 409 ACTION_NOT_ALLOWED —— 非租赁单，或当前状态不支持该动作。
 */
function applyRentalAction(order, action) {
  if (!isRentalOrder(order)) {
    throw new ApiError(409, 'ACTION_NOT_ALLOWED', '当前订单不是租赁单，不支持租赁动作');
  }
  const current = order.rental.status;
  const transitions = RENTAL_ACTIONS[action];
  const next = transitions?.[current];
  if (!next) {
    // 区分「已经做过」与「本来就不合法」：当前状态恰好是该动作的目标状态 ⇒ 重复提交。
    // 这一步必须在任何副作用（库存回补、押金、分账）之前抛出，重复提交才不会二次回补。
    const doneCode = RENTAL_ACTION_DONE_CODES[action];
    if (doneCode && Object.values(transitions || {}).includes(current)) {
      throw new ApiError(409, doneCode, '租赁单已完成归还核验，请勿重复提交');
    }
    throw new ApiError(409, 'ACTION_NOT_ALLOWED', `租赁单当前状态 ${current} 不支持动作 ${action}`);
  }
  order.rental.status = next;
  return next;
}

/**
 * 把某张租赁单仍在冻结中的押金转入「待退」。
 *
 * 归还核验通过 = 车已回到商家手上 = 押金的占用理由消失，因此押金从 `HELD`
 * 转入 `REFUND_PENDING` 并打上 `refundPendingAt`（T36「押金结算」的入口状态）。
 * **本函数只改状态，不动金额**：实际退款额要等车况核验（是否有损坏扣款）才能定，
 * 那是 T36 的职责。
 *
 * 幂等：只处理 `HELD` 的押金，重复调用不会覆盖已进入后续状态的记录，
 * 也不会刷新 `refundPendingAt`（否则「待退时长」这类指标会失真）。
 *
 * @param {object} data 全量数据（原地修改 `data.rentalDeposits`）。
 * @param {object} order 租赁订单。
 * @param {string} now 转入待退的时间（ISO 字符串）。
 * @returns {object[]} 被本次调用改动的押金记录。
 */
function markRentalDepositsRefundPending(data, order, now) {
  const deposits = Array.isArray(data?.rentalDeposits) ? data.rentalDeposits : [];
  const touched = [];
  for (const deposit of deposits) {
    if (deposit.orderId !== order?.id) continue;
    if (deposit.status !== 'HELD') continue;
    deposit.status = 'REFUND_PENDING';
    deposit.refundPendingAt = now;
    touched.push(deposit);
  }
  return touched;
}

/**
 * 裁决订单「完成」时应当进入的状态。
 *
 * 这是订单侧 `COMPLETED` 的**唯一裁决函数**，所有把订单标记完成的入口
 * （商家端、管理端、协同接口、售后关闭）都必须经过它：
 *
 * - **SALE 单**：保持原语义，直接 `COMPLETED`；
 * - **RENTAL 单**：只有 `rental.status === 'RETURNED'`（归还核验完成）才 `COMPLETED`，
 *   否则停在 `FULFILLING` —— 「交付取车」不等于「订单完成」，车还在用户手上。
 *
 * 该函数是纯函数（无副作用），返回裁决结果而不写回，避免与调用点紧邻的
 * `updatedAt` 赋值产生两个不同时间戳的冗余写入。
 *
 * @param {object} order 订单。
 * @returns {string} `'COMPLETED'` 或 `'FULFILLING'`。
 */
function resolveOrderCompletion(order) {
  if (order?.orderKind !== 'RENTAL') return 'COMPLETED';
  // rental 缺失时按「未归还」处理：失败方向必须偏向不完成订单（不放款）。
  return order.rental?.status === 'RETURNED' ? 'COMPLETED' : 'FULFILLING';
}

/**
 * 押金状态取值白名单。
 *
 * ```
 * HELD --归还核验--> REFUND_PENDING --平台结算--> REFUNDED / PARTIALLY_REFUNDED
 * ```
 *
 * 前两个是**在途态**（钱还占着，金额恒等式无从谈起），后两个是**终态**
 * （钱已结清，必须满足 {@link assertDepositBalance} 的恒等式）。
 *
 * @type {Readonly<string[]>}
 */
const RENTAL_DEPOSIT_STATUSES = Object.freeze(['HELD', 'REFUND_PENDING', 'REFUNDED', 'PARTIALLY_REFUNDED']);

/**
 * 押金终态：进入即代表资金已结清，金额恒等式必须成立。
 *
 * @type {Readonly<string[]>}
 */
const RENTAL_DEPOSIT_FINAL_STATUSES = Object.freeze(['REFUNDED', 'PARTIALLY_REFUNDED']);

/**
 * 唯一可被平台结算的押金状态。
 *
 * `HELD`（车还没还）不能结算 —— 车况未知；终态不能结算 —— 会二次退款/二次扣款。
 *
 * @type {string}
 */
const RENTAL_DEPOSIT_SETTLEABLE_STATUS = 'REFUND_PENDING';

/**
 * 扣款所得的资金归属口径说明，写入 `financeEvents.note`。
 *
 * 扣款是车损/超时的补偿，而**车是商家的、损失也是商家的**。本轮不做真实分账，
 * 因此这笔钱既不写进商家余额、也不记为平台收入，只留一条带本说明的流水暂挂。
 * 若直接记为平台收入，下一轮做真实分账时这批历史数据必须回头清洗，且会引发商家抗议。
 *
 * @type {string}
 */
const DEPOSIT_DEDUCTION_ATTRIBUTION_NOTE = '扣款所得归属口径本轮未定，暂挂待分配';

/**
 * 校验押金终态的资金恒等式：`refundedInCents + deductionInCents === amountInCents`。
 *
 * 这是押金账本的**唯一不变量**：押金总量只有两个出口 —— 退给用户的部分与扣下的部分，
 * 二者之和必须精确等于原始押金，不能多（凭空退款）也不能少（钱不知去向）。
 *
 * 只对终态校验：在途态（`HELD` / `REFUND_PENDING`）尚未发生结算，
 * `refundedInCents` 与 `deductionInCents` 本来就都还是 0，此时校验没有意义。
 *
 * 失败时抛 **500 而不是 400**：能走到这里说明服务端自己写出了坏数据，
 * 是服务端不变量被破坏，不是用户输入错误 —— 让调用方按 400 处理会把
 * 「我们的账本坏了」误报成「你参数填错了」，掩盖真正的资损。
 *
 * @param {object} deposit 押金记录。
 * @returns {boolean} 恒等式成立（或该记录不是终态、无需校验）时返回 `true`。
 * @throws {ApiError} 500 DEPOSIT_BALANCE_BROKEN —— 终态记录的金额恒等式被破坏。
 */
function assertDepositBalance(deposit) {
  if (!deposit || !RENTAL_DEPOSIT_FINAL_STATUSES.includes(deposit.status)) return true;
  const amountInCents = Number(deposit.amountInCents);
  const refundedInCents = Number(deposit.refundedInCents);
  const deductionInCents = Number(deposit.deductionInCents);
  if (refundedInCents + deductionInCents !== amountInCents) {
    throw new ApiError(
      500,
      'DEPOSIT_BALANCE_BROKEN',
      `押金 ${deposit.id || ''} 终态金额恒等式被破坏：refundedInCents(${refundedInCents}) + deductionInCents(${deductionInCents}) !== amountInCents(${amountInCents})`
    );
  }
  return true;
}

/**
 * 结算一笔押金（平台审核扣款后确定实退金额）。
 *
 * 这是押金从「待退」走向终态的**唯一入口**，它同时决定了三件事：
 * 退多少、扣多少、以及钱在账本上算不算平 —— 因此函数末尾会强制
 * 调用 {@link assertDepositBalance} 自检，把「算错金额」变成一次立刻失败的写操作，
 * 而不是一条躺在库里的坏数据。
 *
 * **幂等守卫放在这里（而不是端点里）**：与 T34 的 `activateOrderSettlements` 入口守卫
 * 同一思路 —— 只有 `REFUND_PENDING` 可结算，其他状态一律 409。守卫写在域函数里，
 * 将来任何新调用方（批量结算、对账补单）都自动被保护，不必记得再加一次校验。
 *
 * **扣款所得不进商家余额、也不记为平台收入**：本函数只改押金记录本身，
 * 完全不触碰 `data.settlements`。扣款金额由调用方写入一条带
 * {@link DEPOSIT_DEDUCTION_ATTRIBUTION_NOTE} 说明的 `financeEvents` 流水暂挂待分配。
 *
 * @param {object} deposit 押金记录（原地修改）。
 * @param {object} options 结算参数。
 * @param {number} options.deductionInCents 扣款金额（分），必须是非负整数且不超过押金总额。
 * @param {string} [options.operator] 操作人展示名，写入 `settledBy`。
 * @param {string} [options.note] 扣款原因备注，写入 `deductionNote`。
 * @param {string} now 结算时间（ISO 字符串），写入 `settledAt`。
 * @returns {object} 更新后的押金记录。
 * @throws {ApiError} 400 VALIDATION_ERROR —— 扣款金额非非负整数，或超过押金总额。
 * @throws {ApiError} 409 DEPOSIT_NOT_SETTLEABLE —— 押金不在 `REFUND_PENDING`，重复结算会被挡下。
 * @throws {ApiError} 500 DEPOSIT_BALANCE_BROKEN —— 自检发现恒等式被破坏。
 */
function settleRentalDeposit(deposit, options = {}, now) {
  if (!deposit || typeof deposit !== 'object') {
    throw new ApiError(400, 'VALIDATION_ERROR', '押金记录不存在');
  }
  const { deductionInCents, operator, note } = options;
  // 先校验请求体（400），再校验状态（409）：请求本身不合法时不该被状态判断掩盖。
  if (!Number.isInteger(deductionInCents) || deductionInCents < 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'deductionInCents 必须是非负整数');
  }
  const amountInCents = Number(deposit.amountInCents);
  if (!Number.isInteger(amountInCents) || amountInCents < 0) {
    throw new ApiError(500, 'DEPOSIT_BALANCE_BROKEN', `押金 ${deposit.id || ''} 的 amountInCents 非法：${deposit.amountInCents}`);
  }
  if (deductionInCents > amountInCents) {
    throw new ApiError(400, 'VALIDATION_ERROR', `deductionInCents 不得超过押金总额 ${amountInCents}`);
  }
  if (deposit.status !== RENTAL_DEPOSIT_SETTLEABLE_STATUS) {
    throw new ApiError(
      409,
      'DEPOSIT_NOT_SETTLEABLE',
      `押金 ${deposit.id || ''} 当前状态 ${deposit.status} 不可结算（仅 ${RENTAL_DEPOSIT_SETTLEABLE_STATUS} 可结算）`
    );
  }
  deposit.deductionInCents = deductionInCents;
  deposit.refundedInCents = amountInCents - deductionInCents;
  // 无扣款 = 全额退回；有扣款 = 部分退回。押金只有这两种终态，不存在「全部扣光」之外的第三态。
  deposit.status = deductionInCents === 0 ? 'REFUNDED' : 'PARTIALLY_REFUNDED';
  deposit.settledAt = now;
  deposit.settledBy = String(operator || '');
  deposit.deductionNote = String(note || '');
  // ★ 自检：算错了就在这里炸，绝不把破坏恒等式的记录写进库。
  assertDepositBalance(deposit);
  return deposit;
}

/**
 * 构造押金记录。
 *
 * 押金独立于订单项存在：`amountInCents` 计入订单 `totalInCents`（用户实付金额），
 * 但**不进入** `order.items[].subtotalInCents`，因此不参与分账。
 *
 * @param {object} order 已落库的订单（提供 `id` / `userId`）。
 * @param {object} product 租赁商品（提供 `rentalPlan.depositInCents`）。
 * @param {unknown} rentalUnits 租期数量。当前方案是「每单固定押金」，
 *        该参数只做前置校验，为后续按租期阶梯计押金预留。
 * @param {string} now 创建时间（ISO 字符串）。
 * @returns {object} 押金记录，`status` 恒为 `'HELD'`。
 * @throws {ApiError} 400 VALIDATION_ERROR —— 租期非法或商品缺少押金配置。
 */
function createRentalDeposit(order, product, rentalUnits, now) {
  const source = product || {};
  const units = Number(rentalUnits);
  if (!Number.isInteger(units) || units < 1) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalUnits 必须是大于 0 的整数');
  }
  const depositInCents = Number(source.rentalPlan?.depositInCents);
  if (!Number.isInteger(depositInCents) || depositInCents < 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${source.name || source.id || '租赁商品'} 缺少合法的 rentalPlan.depositInCents`);
  }
  return {
    id: `dep_${randomUUID()}`,
    orderId: order.id,
    userId: order.userId,
    merchantId: source.merchantId || '',
    amountInCents: depositInCents,
    status: 'HELD',
    refundedInCents: 0,
    deductionInCents: 0,
    createdAt: now
  };
}

module.exports = {
  buildRentalOrderItem,
  rentalDurationMsOf,
  startRental,
  createRentalDeposit,
  applyRentalAction,
  markRentalDepositsRefundPending,
  resolveOrderCompletion,
  assertDepositBalance,
  settleRentalDeposit,
  isRentalOrder,
  RENTAL_ACTIONS,
  RENTAL_UNIT_MS,
  RENTAL_ACTION_DONE_CODES,
  RENTAL_DEPOSIT_STATUSES,
  RENTAL_DEPOSIT_FINAL_STATUSES,
  RENTAL_DEPOSIT_SETTLEABLE_STATUS,
  DEPOSIT_DEDUCTION_ATTRIBUTION_NOTE
};
