/**
 * 「不存在」类错误（`*_NOT_FOUND` 家族）的面向用户中文文案。
 *
 * ## 为什么需要它
 *
 * `app.js` 里有 70 处 `new ApiError(4xx, '*_NOT_FOUND', '<英文文案>')`，横跨 19 个错误码，
 * 其中 `Payment order not found` 一条就重复 14 次、`Merchant not found` 13 次。
 * 这些文案**会直接送到用户眼前**：`miniprogram/lib/cloud-request.js` 把
 * `response.data.error.message` 塞进 `new Error(...)`，页面再 `wx.showToast` ——
 * 中文用户会看到 `Order not found`。
 *
 * 70 处散落在 8000 行里，必然漂移：改一处忘一处，用户就会在不同页面看到不同说法。
 * 所以按**错误码**收口到这张表：文案只在这里定义一次，调用点只写错误码。
 *
 * ## 与 `http/field-labels.js` 的分工
 *
 * - `field-labels.js`：`requireString` 的**字段名** → 中文标签（「标题」「联系方式」）。
 * - 本文件：`new ApiError` 的**错误码** → 完整中文句子。
 *
 * 两者不重叠：本表给的是**整句**，不经过字段名。
 *
 * ## 唯一的例外：`PRODUCT_NOT_FOUND`
 *
 * `app.js` 有一处要带上运行时拿到的商品 id（`` `Product ${productId} not found` ``），
 * 静态字符串装不下。它由下面的 `productNotFoundMessage(productId)` 提供，
 * 与表里的 `PRODUCT_NOT_FOUND` 是**同一概念的两处措辞** ——
 * `test/error-messages.test.js` 有一条断言把两者的耦合钉住：去掉 id 后必须与表里逐字一致，
 * 所以改任一处而忘了另一处会立刻转红。
 *
 * ## 措辞约定
 *
 * - 「不存在」家族统一用「XX不存在」，不加「抱歉」「请重试」之类的语气词 ——
 *   这些文案走的是 `wx.showToast`，太长会被截断。
 * - 枚举类错误统一用「不支持的 XX」或「XX 仅支持 A、B、C」（保留枚举标识符原样，
 *   与既有文案 `管理员状态仅支持 ACTIVE 或 DISABLED` 同款）。
 */

/** 错误码 → 中文文案。键必须与 `app.js` 里 `new ApiError` 的第 2 个实参逐字一致。 */
const NOT_FOUND_MESSAGES = {
  // ---- 交易与资金 ----
  PAYMENT_NOT_FOUND: '支付单不存在',
  ORDER_NOT_FOUND: '订单不存在',
  SETTLEMENT_NOT_FOUND: '结算记录不存在',
  // 「没有待结算的记录」不是「XX不存在」句式 —— 它描述的是**状态**而非**缺失的实体**，
  // 所以没有强行套用模板。
  PENDING_SETTLEMENT_NOT_FOUND: '没有待结算的记录',
  PAYMENT_PROVIDER_NOT_FOUND: '支付渠道不存在',

  // ---- 商品与商家 ----
  PRODUCT_NOT_FOUND: '商品不存在',
  MERCHANT_NOT_FOUND: '商家不存在',
  PROMO_NOT_FOUND: '充值活动不存在',
  // 商品存在、但不在**这笔订单**里 —— 与 `PRODUCT_NOT_FOUND` 是不同的事实，不能同名。
  PRODUCT_NOT_IN_ORDER: '订单中不存在该商品',

  // ---- 用户侧 ----
  ADDRESS_NOT_FOUND: '收货地址不存在',
  REVIEW_NOT_FOUND: '评价不存在',
  AFTER_SALE_NOT_FOUND: '售后记录不存在',
  UPLOAD_NOT_FOUND: '上传记录不存在',

  // ---- 服务与牌照 ----
  SERVICE_RECORD_NOT_FOUND: '服务记录不存在',
  PLATE_APPLICATION_NOT_FOUND: '牌照申请不存在',

  // ---- 运营与管理端 ----
  LEAD_NOT_FOUND: '线索不存在',
  ADMIN_ASSET_NOT_FOUND: '管理端静态资源不存在',
  // 管理端通用集合的「查不到这条记录」，不特指实体类型。
  ADMIN_RECORD_NOT_FOUND: '记录不存在',

  // ---- 路由 ----
  ROUTE_NOT_FOUND: '接口不存在'
};

/**
 * 取「不存在」类错误的中文文案。
 *
 * @param {string} code 错误码（`app.js` 里 `new ApiError` 的第 2 个实参）。
 * @returns {string} 中文文案。
 */
function notFoundMessage(code) {
  // 用 `hasOwnProperty` 而不是 `NOT_FOUND_MESSAGES[code]`：后者会命中
  // `constructor` / `toString` 这类原型成员，把函数当文案返回。
  if (Object.prototype.hasOwnProperty.call(NOT_FOUND_MESSAGES, code)) return NOT_FOUND_MESSAGES[code];
  // 正常路径下不可达：`test/error-messages.test.js` 断言 `app.js` 里每个
  // `*_NOT_FOUND` 码都在表里。回落成通用句而不是 `undefined`，是为了万一漏了，
  // 用户看到的是「请求的资源不存在」而不是「undefined」。
  return '请求的资源不存在';
}

/**
 * 带实体 id 的「商品不存在」。
 *
 * 只有 `POST /api/orders` 的库存校验那一处用得到 —— 它要告诉用户**是哪个**商品没了。
 * 与表里的 `PRODUCT_NOT_FOUND` 是同一概念：去掉 id 后必须与表里逐字一致
 * （由 `test/error-messages.test.js` 断言，防止两处措辞漂移）。
 *
 * @param {string} productId 商品 id。
 * @returns {string} 中文文案，带上该 id。
 */
function productNotFoundMessage(productId) {
  return `商品 ${productId} 不存在`;
}

module.exports = { NOT_FOUND_MESSAGES, notFoundMessage, productNotFoundMessage };
