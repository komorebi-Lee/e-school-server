/**
 * HTTP 请求体字段校验工具。
 *
 * 从请求载荷中提取必填字符串字段，缺失、过短或超长时抛出 ApiError。
 *
 * ## 选项是**纯追加**的
 *
 * `minLength` / `message` 都是可选新增项。**不传它们时，本函数的控制流与错误文案
 * 与引入这两个选项之前逐字相同** —— 既有 140 处调用方一律不传新选项，行为不受影响。
 * 之所以强调这点：这个函数被全仓复用的调用点很多，任何一个分支的默认路径被改动，
 * 都会以「某个端点突然开始拒绝合法请求」的形式在很远的地方爆出来。
 */

const { ApiError } = require('./api-error');

/**
 * 提取并校验一个必填字符串字段。
 *
 * @param {*} value 原始值（非字符串一律按空串处理）。
 * @param {string} field 字段名，用于拼默认错误文案。
 * @param {object} [options] 可选校验项。
 * @param {number} [options.minLength] 去空白后的最小长度；不传则不校验下界。
 * @param {number} [options.maxLength] 去空白后的最大长度；不传则不校验上界。
 * @param {string} [options.message] 自定义「缺失 / 过短」文案；不传则回落英文默认文案。
 * @returns {string} 去空白后的字符串。
 */
function requireString(value, field, options = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw new ApiError(400, 'VALIDATION_ERROR', options.message || `${field} is required`);
  }
  if (options.minLength && normalized.length < options.minLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', options.message || `${field} is too short`);
  }
  if (options.maxLength && normalized.length > options.maxLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is too long`);
  }
  return normalized;
}

module.exports = { requireString };
