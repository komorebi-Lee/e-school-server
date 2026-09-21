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

module.exports = { buildRentalOrderItem, createRentalDeposit };
