/**
 * 支付对账待办域。
 *
 * 依据支付对账报告的差异项生成 / 更新 / 自动关闭平台财务待办
 * （type = PAYMENT_RECONCILIATION），并同步写入审计日志。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { randomUUID } = require('node:crypto');
const { financeTaskDueAt } = require('../utils/time');

function buildPaymentReconciliationTaskDetail(report) {
  const detail = report.differences
    .slice(0, 3)
    .map((item) => `${item.paymentNo || item.refundNo}：${item.type}`)
    .join('；');
  return report.differences.length > 3 ? `${detail}；等 ${report.differences.length} 项差异` : detail;
}

function upsertPaymentReconciliationTask(data, report, now = new Date().toISOString(), addAuditLog = () => {}) {
  if (!Array.isArray(data.financeTasks)) data.financeTasks = [];
  if (!Array.isArray(data.auditLogs)) data.auditLogs = [];
  const existing = data.financeTasks.find((item) => (
    item.type === 'PAYMENT_RECONCILIATION'
    && item.billDate === report.billDate
    && item.provider === report.provider
  ));
  const differenceCount = report.differences.length;
  if (!differenceCount) {
    if (existing && existing.status !== 'RESOLVED') {
      existing.status = 'RESOLVED';
      existing.resolvedAt = now;
      existing.resolvedReason = '重新对账后账实相符，待办自动关闭';
      existing.updatedAt = now;
      addAuditLog(data, '关闭支付对账待办', `${report.billDate} ${report.provider}`);
    }
    return existing || null;
  }

  const detail = buildPaymentReconciliationTaskDetail(report);
  if (!existing) {
    const task = {
      id: `fin_${randomUUID()}`,
      type: 'PAYMENT_RECONCILIATION',
      reportId: report.id,
      billDate: report.billDate,
      provider: report.provider,
      channel: report.channel,
      differenceCount,
      detail: differenceCount > 3 ? `${detail}；等 ${differenceCount} 项差异` : detail,
      status: 'PENDING',
      ownerRole: 'PLATFORM',
      dueAt: financeTaskDueAt(data, now),
      acknowledgeNote: '',
      acknowledgedAt: '',
      resolutionNote: '',
      resolvedAt: '',
      resolvedReason: '',
      reopenCount: 0,
      createdAt: now,
      updatedAt: now
    };
    data.financeTasks.unshift(task);
    addAuditLog(data, '生成支付对账待办', `${report.billDate} ${report.provider} ${differenceCount} 项差异`);
    return task;
  }

  existing.reportId = report.id;
  existing.differenceCount = differenceCount;
  existing.detail = differenceCount > 3 ? `${detail}；等 ${differenceCount} 项差异` : detail;
  existing.updatedAt = now;
  if (existing.status === 'RESOLVED') {
    existing.status = 'PENDING';
    existing.acknowledgeNote = '';
    existing.acknowledgedAt = '';
    existing.resolutionNote = '';
    existing.resolvedAt = '';
    existing.resolvedReason = '';
    existing.reopenCount = Number(existing.reopenCount || 0) + 1;
    addAuditLog(data, '重新打开支付对账待办', `${report.billDate} ${report.provider}`);
  }
  return existing;
}

module.exports = { buildPaymentReconciliationTaskDetail, upsertPaymentReconciliationTask };
