/**
 * 通用输入校验工具。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { ApiError } = require('../http/api-error');

function normalizeQualificationExpireDate(value) {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!date) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', '资质有效期格式需为 YYYY-MM-DD');
  }
  return date;
}

module.exports = { normalizeQualificationExpireDate };
