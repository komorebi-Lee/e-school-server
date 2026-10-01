/**
 * HTTP 请求体字段校验工具。
 *
 * 从请求载荷中提取必填字符串字段，缺失、过短或超长时抛出 ApiError。
 *
 * ## 选项是**纯追加**的
 *
 * `minLength` / `message` 都是可选新增项。**不传它们时，本函数的控制流与引入这两个
 * 选项之前逐字相同** —— 既有调用方一律不传新选项，行为不受影响。
 * 之所以强调这点：这个函数被全仓复用的调用点很多，任何一个分支的默认路径被改动，
 * 都会以「某个端点突然开始拒绝合法请求」的形式在很远的地方爆出来。
 *
 * ## 默认文案已统一为中文（此处曾是「逐字相同」的承诺）
 *
 * 本注释原先还承诺「不传它们时……**错误文案**与引入前逐字相同」。那句话现在**为假**：
 * 默认文案已由英文 `${field} is required` 系列改为中文（见 `field-labels.js`）。
 * 之所以要改：全仓 146 个调用点里只有 1 个传了 `message`，其余全部落到默认文案；
 * 而 `miniprogram/lib/cloud-request.js` 把 `error.message` 直接塞进 `new Error(...)`，
 * 页面再 `wx.showToast({ title: error.message })` —— 中文用户会看到 `title is required`。
 *
 * 留一条**现在仍然成立**的承诺：**控制流逐字不变**。分支条件、判定顺序、返回值语义
 * 与引入 `minLength` / `message` 之前完全一致，变的只有抛出时的文案。
 */

const { ApiError } = require('./api-error');
const { fieldLabel } = require('./field-labels');

/**
 * 提取并校验一个必填字符串字段。
 *
 * @param {*} value 原始值（非字符串一律按空串处理）。
 * @param {string} field 字段名，经 `fieldLabel` 翻成中文标签后拼进默认错误文案。
 * @param {object} [options] 可选校验项。
 * @param {number} [options.minLength] 去空白后的最小长度；不传则不校验下界。
 * @param {number} [options.maxLength] 去空白后的最大长度；不传则不校验上界。
 * @param {string} [options.message] 自定义「缺失 / 过短」文案；不传则回落中文默认文案。
 *   ⚠️ 只对「缺失」与「过短」生效，「过长」一律用默认文案 —— 这是既有行为，本次未改。
 * @returns {string} 去空白后的字符串。
 */
function requireString(value, field, options = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new ApiError(400, 'VALIDATION_ERROR', options.message || `缺少必填字段：${fieldLabel(field)}`);
  }
  if (options.minLength && normalized.length < options.minLength) {
    // 此分支由 `options.minLength &&` 守卫，故 `minLength` 必然存在，无需再判空。
    throw new ApiError(
      400,
      'VALIDATION_ERROR',
      options.message || `${fieldLabel(field)}长度不足（至少 ${options.minLength} 个字）`
    );
  }
  if (options.maxLength && normalized.length > options.maxLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${fieldLabel(field)}过长（最多 ${options.maxLength} 个字）`);
  }
  return normalized;
}

module.exports = { requireString };
