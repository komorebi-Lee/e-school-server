/**
 * 通用时间与日期工具。
 *
 * 提供本地日期键、日期/时段规范化，以及财务任务到期时间计算。
 */

function localDateKey(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function normalizeTimeSlot(value) {
  return String(value || '').trim().slice(0, 40);
}

function normalizeDateValue(value) {
  return String(value || '').trim().slice(0, 10);
}

function financeTaskDueAt(data, baseIso) {
  const value = Number(data?.adminSettings?.financeTaskResponseHours);
  const hours = Number.isInteger(value) && value >= 1 && value <= 168 ? value : 24;
  const base = new Date(baseIso || Date.now()).getTime();
  return new Date(base + hours * 60 * 60 * 1000).toISOString();
}

module.exports = { localDateKey, normalizeTimeSlot, normalizeDateValue, financeTaskDueAt };
