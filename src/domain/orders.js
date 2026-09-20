/**
 * 订单域：配送排期校验与配送码签发。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { ApiError } = require('../http/api-error');
const { requireString } = require('../http/body');
const { normalizeDateValue, normalizeTimeSlot } = require('../utils/time');

function validateDeliverySchedule(fulfillment, settings) {
  if (fulfillment.type !== 'DELIVERY') return;
  const date = normalizeDateValue(fulfillment.date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'VALIDATION_ERROR', '请选择配送日期');
  if (date < new Date().toISOString().slice(0, 10)) throw new ApiError(400, 'VALIDATION_ERROR', '配送日期不能早于今天');
  const slot = requireString(fulfillment.timeSlot, 'fulfillment.timeSlot', { maxLength: 40 });
  const configuredSlots = Array.isArray(settings?.deliveryTimeSlots) ? settings.deliveryTimeSlots.map(normalizeTimeSlot) : [];
  if (!configuredSlots.includes(slot)) throw new ApiError(400, 'VALIDATION_ERROR', '请选择平台提供的配送时段');
}

function issueDeliveryCode(order, now) {
  if (!order.deliveryCode) {
    order.deliveryCode = String(Math.floor(100000 + Math.random() * 900000));
    order.deliveryCodeIssuedAt = now;
  }
  return order.deliveryCode;
}

module.exports = { validateDeliverySchedule, issueDeliveryCode };
