/**
 * HTTP 请求体字段校验工具。
 *
 * 从请求载荷中提取必填字符串字段，缺失或超长时抛出 ApiError。
 */

const { ApiError } = require('./api-error');

function requireString(value, field, options = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new ApiError(400, 'VALIDATION_ERROR', `${field} is required`);
  if (options.maxLength && normalized.length > options.maxLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is too long`);
  }
  return normalized;
}

module.exports = { requireString };
