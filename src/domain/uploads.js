/**
 * 上传配额与上传记录域。
 *
 * 提供上传频率上限（默认每 24 小时 30 张，可经后台设置覆盖）、
 * 配额校验（超限抛 429 ApiError）以及上传记录的写入与窗口内清理。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { randomUUID } = require('node:crypto');
const { ApiError } = require('../http/api-error');

const UPLOAD_RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const UPLOAD_RATE_DEFAULT_LIMIT = 30;

function uploadQuotaLimit(settings = {}) {
  const raw = Number(settings.uploadRateLimitPer24h);
  if (!Number.isFinite(raw) || raw <= 0) return UPLOAD_RATE_DEFAULT_LIMIT;
  return Math.min(200, Math.max(1, Math.trunc(raw)));
}

function enforceUploadQuota(data, actorId, settings, now = new Date()) {
  const limit = uploadQuotaLimit(settings);
  const windowStart = new Date(now.getTime() - UPLOAD_RATE_WINDOW_MS).toISOString();
  const recent = (data.uploadRecords || []).filter(
    (item) => item.actorId === actorId && item.createdAt > windowStart
  );
  if (recent.length < limit) return;
  const oldest = recent.reduce(
    (min, item) => (item.createdAt < min ? item.createdAt : min),
    recent[0].createdAt
  );
  const resetInMinutes = Math.max(
    1,
    Math.ceil((new Date(oldest).getTime() + UPLOAD_RATE_WINDOW_MS - now.getTime()) / 60000)
  );
  throw new ApiError(429, 'UPLOAD_RATE_LIMITED', `上传过于频繁，每 24 小时最多 ${limit} 张，请约 ${resetInMinutes} 分钟后重试`);
}

function recordUpload(data, actorId, fileName, size, now = new Date()) {
  if (!Array.isArray(data.uploadRecords)) data.uploadRecords = [];
  const windowStart = new Date(now.getTime() - UPLOAD_RATE_WINDOW_MS).toISOString();
  // 只保留窗口内的记录，避免 uploadRecords 无限增长
  data.uploadRecords = data.uploadRecords.filter((item) => item.createdAt > windowStart);
  data.uploadRecords.push({
    id: `upl_${randomUUID()}`,
    actorId,
    fileName,
    size,
    createdAt: now.toISOString()
  });
}

module.exports = { uploadQuotaLimit, enforceUploadQuota, recordUpload };
