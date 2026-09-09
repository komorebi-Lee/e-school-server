const { randomUUID, randomBytes, createHash, scryptSync, timingSafeEqual } = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');
const { createPaymentProvider } = require('./payment-provider');

class ApiError extends Error {
  constructor(statusCode, code, message, details) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

const allowedCardServices = new Set(['NEW_CARD', 'REPLACEMENT', 'TOP_UP']);
const allowedAfterSaleTypes = new Set(['REFUND', 'RETURN', 'REPAIR']);
const allowedLeadStatuses = new Set(['SUBMITTED', 'FOLLOW_UP', 'COMPLETED', 'INVALID']);
const allowedScoreComplaintTypes = new Set(['REMOVED_NEGATIVE_REVIEW', 'DELAYED_DELIVERY', 'AFTER_SALE_ISSUE']);
const openLeadStatuses = new Set(['SUBMITTED', 'FOLLOW_UP']);
const allowedMerchantCategories = new Set(['E_BIKE', 'DIGITAL', 'FOOD', 'LIFE_SERVICE']);
const allowedMerchantStatuses = new Set(['REVIEWING', 'APPROVED', 'REJECTED']);
const allowedMerchantOrderStatuses = new Set(['PENDING_PAYMENT', 'PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED']);
const allowedMerchantTypes = new Set(['INDIVIDUAL', 'ENTERPRISE', 'PERSONAL']);
const adminOrderStatuses = {
  orders: new Set(['PENDING_PAYMENT', 'PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED', 'AFTER_SALE']),
  'phone-card-orders': new Set(['PENDING_PAYMENT', 'PENDING_REALNAME', 'ACTIVATED', 'CANCELLED', 'REJECTED']),
  'recharge-orders': new Set(['PENDING_PAYMENT', 'PENDING_CREDIT', 'CREDITED', 'CANCELLED', 'REJECTED']),
  'broadband-applications': new Set(['PENDING_VERIFY', 'APPROVED', 'REJECTED']),
  'plate-applications': new Set(['PENDING_PAYMENT', 'MATERIAL_PENDING', 'REVIEWING', 'COMPLETED', 'REJECTED']),
  'after-sales': new Set(['SUBMITTED', 'REVIEWING', 'CLOSED'])
};
const allowedPaymentStatuses = new Set(['PENDING', 'PAID', 'CANCELLED', 'REFUNDED']);
const identityVerifications = new Map();
let weChatAccessToken = { token: '', expiresAt: 0 };

function isTlsInterceptionError(error) {
  const tlsCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
  return tlsCodes.has(error.code) || /self-signed/i.test(error.message);
}

function publicSettings(settings = {}) {
  return {
    brandName: settings.brandName || '狮山智生活',
    schoolName: settings.schoolName || '华中农业大学',
    campusName: settings.campusName || '狮山校区',
    servicePhone: settings.servicePhone || '',
    serviceWechat: settings.serviceWechat || '',
    deliveryFeeInCents: settings.deliveryFeeInCents || 0,
    commissionRatePercent: settings.commissionRatePercent ?? 2,
    deliveryResponseHours: settings.deliveryResponseHours || 24,
    plateResponseHours: settings.plateResponseHours || 48,
    afterSaleResponseHours: settings.afterSaleResponseHours || 24,
    afterSaleResolutionHours: settings.afterSaleResolutionHours || 72,
    externalPlateFeeInCents: settings.externalPlateFeeInCents ?? 4900,
    leadResponseHours: Number.isInteger(settings.leadResponseHours) && settings.leadResponseHours >= 1 && settings.leadResponseHours <= 168 ? settings.leadResponseHours : 24,
    phoneCardActivationHours: Number.isInteger(settings.phoneCardActivationHours) && settings.phoneCardActivationHours >= 1 && settings.phoneCardActivationHours <= 168 ? settings.phoneCardActivationHours : 24,
    paymentTimeoutMinutes: settings.paymentTimeoutMinutes || 30,
    paymentTimeoutText: `${settings.paymentTimeoutMinutes || 30} 分钟`,
    settlementPeriodDays: Number.isInteger(settings.settlementPeriodDays) ? settings.settlementPeriodDays : 7,
    deliveryTimeSlots: Array.isArray(settings.deliveryTimeSlots) && settings.deliveryTimeSlots.length ? settings.deliveryTimeSlots : ['尽快配送'],
    platformNotice: settings.platformNotice || '服务范围和办理结果以学校及合作方最终确认为准。'
  };
}

const scoreNotificationTemplates = {
  SCORE_STAGE_WARNING: {
    id: 'score_stage_warning',
    keywords: ['店铺', '服务分', '整改'],
    description: '服务分下降或进入整改阶段时提醒商家及时处理'
  },
  SCORE_RECTIFY_APPLY: {
    id: 'score_rectify_apply',
    keywords: ['整改', '申请', '审核'],
    description: '商家提交服务分整改申请后提醒管理员审核'
  },
  SCORE_RECTIFY_RESULT: {
    id: 'score_rectify_result',
    keywords: ['整改', '审核结果', '服务分'],
    description: '整改审核完成后通知商家处理结论'
  },
  SCORE_APPEAL_RESULT: {
    id: 'score_appeal_result',
    keywords: ['申诉', '审核结果', '服务分'],
    description: '差评记录申诉审核完成后通知商家结论'
  },
  PRODUCT_AUTO_DELIST: {
    id: 'product_auto_delist',
    keywords: ['商品', '自动下架', '整改'],
    description: '商品触发低质风控自动下架时提醒商家整改'
  },
  PRODUCT_COMPLIANCE_RESTORED: {
    id: 'product_compliance_restored',
    keywords: ['商品', '复核', '恢复上架'],
    description: '商品通过平台复核或整改验收后提醒商家'
  },
  PRODUCT_LOW_STOCK: {
    id: 'stock_low_stock',
    keywords: ['库存', '补货', '商品'],
    description: '商品可售库存达到补货阈值时提醒商家及时补货'
  },
  SLA_WARNING: {
    id: 'sla_warning',
    keywords: ['履约', '超时', '预警'],
    description: '订单、激活、核验或工单接近超时时提醒责任商家及时处理'
  }
};

const orderNotificationTemplates = {
  FAVORITE_PRICE_NOTICE: {
    id: 'favorite_price_notice',
    keywords: ['收藏', '降价', '限时促销'],
    description: '收藏的商品开始限时特价时提醒用户'
  },
  RESTOCK_NOTICE: {
    id: 'restock_notice',
    keywords: ['商品', '补货', '到货'],
    description: '用户登记的缺货商品重新可购时提醒用户'
  },
  ORDER_STATUS: {
    id: 'order_status',
    keywords: ['订单', '状态', '履约'],
    description: '支付、配送、激活和办理进度提醒'
  },
  ORDER_SERVICE: {
    id: 'order_service',
    keywords: ['订单', '客服', '留言'],
    description: '商家或平台回复订单消息时提醒用户'
  },
  AFTER_SALE: {
    id: 'after_sale',
    keywords: ['售后', '退款', '处理'],
    description: '售后受理、处理和完成提醒'
  },
  LEAD_FOLLOW_UP: {
    id: 'lead_follow_up',
    keywords: ['咨询', '客服', '跟进'],
    description: '客服跟进咨询结果时提醒用户查看订单'
  }
};

function normalizeTimeSlot(value) {
  return String(value || '').trim().slice(0, 40);
}

function normalizeDateValue(value) {
  return String(value || '').trim().slice(0, 10);
}

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

// 可售库存 = 实际库存 - 待支付订单占用的库存，避免同一批车被重复卖出。
function availableStock(product) {
  return Math.max(0, Number(product?.stock || 0) - Number(product?.reservedStock || 0));
}

function withAvailableStock(product) {
  return { ...product, reservedStock: Number(product.reservedStock || 0), availableStock: availableStock(product) };
}

function buildPaymentReconciliationTaskDetail(report) {
  const detail = report.differences
    .slice(0, 3)
    .map((item) => `${item.paymentNo || item.refundNo}：${item.type}`)
    .join('；');
  return report.differences.length > 3 ? `${detail}；等 ${report.differences.length} 项差异` : detail;
}

function financeTaskDueAt(data, baseIso) {
  const value = Number(data?.adminSettings?.financeTaskResponseHours);
  const hours = Number.isInteger(value) && value >= 1 && value <= 168 ? value : 24;
  const base = new Date(baseIso || Date.now()).getTime();
  return new Date(base + hours * 60 * 60 * 1000).toISOString();
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

function lowStockThreshold(data) {
  const value = Number(data?.adminSettings?.lowStockThreshold ?? 10);
  return Number.isInteger(value) && value >= 0 && value <= 999 ? value : 10;
}

function evaluateLowStockAlert(data, product, now = new Date().toISOString()) {
  if (!product?.id || !product.merchantId || product.active === false) return false;
  const threshold = lowStockThreshold(data);
  const stock = availableStock(product);
  if (stock > threshold) {
    if (product.lowStockAlertedAt) {
      product.lowStockAlertedAt = '';
      product.lowStockAlertStatus = '';
    }
    return false;
  }
  if (product.lowStockAlertedAt) return false;
  const merchant = (data.merchants || []).find((item) => item.id === product.merchantId);
  product.lowStockAlertedAt = now;
  product.lowStockAlertStatus = 'OPEN';
  const title = '商品库存偏低';
  const content = `「${product.name}」可售库存 ${stock} 件，已达到补货阈值 ${threshold} 件。`;
  if (merchant?.userId) {
    if (!Array.isArray(data.notifications)) data.notifications = [];
    data.notifications.unshift({
      id: `ntf_${randomUUID()}`,
      userId: merchant.userId,
      type: 'STOCK',
      title,
      content,
      metadata: { productId: product.id },
      read: false,
      createdAt: now
    });
    data.notifications = data.notifications.slice(0, 500);
    if ((data.serviceMessageSubscribers || []).includes(merchant.userId)) {
      if (!Array.isArray(data.subscribeMessages)) data.subscribeMessages = [];
      data.subscribeMessages.unshift({
        id: `sub_${randomUUID()}`,
        userId: merchant.userId,
        templateId: 'stock_low_stock',
        page: `/pages/merchant/products?focusId=${encodeURIComponent(product.id)}&filter=LOW`,
        metadata: { productId: product.id },
        status: 'QUEUED',
        title,
        content,
        error: '',
        createdAt: now,
        sentAt: ''
      });
      data.subscribeMessages = data.subscribeMessages.slice(0, 300);
    }
  }
  if (merchant?.id) {
    if (!Array.isArray(data.auditLogs)) data.auditLogs = [];
    data.auditLogs.unshift({
      id: `log_${randomUUID()}`,
      operator: '系统',
      action: '触发低库存提醒',
      target: product.name,
      createdAt: now
    });
    data.auditLogs = data.auditLogs.slice(0, 200);
  }
  return true;
}

function recordStockMovement(data, product, payload) {
  if (!product) return;
  if (!Array.isArray(data.stockMovements)) data.stockMovements = [];
  data.stockMovements.unshift({
    id: `mov_${randomUUID()}`,
    productId: product.id,
    productName: product.name,
    merchantId: product.merchantId || '',
    movementType: payload.movementType,
    quantity: Number(payload.quantity || 0),
    stockBefore: Number(payload.stockBefore || 0),
    stockAfter: Number(payload.stockAfter || 0),
    reservedBefore: Number(payload.reservedBefore || 0),
    reservedAfter: Number(payload.reservedAfter || 0),
    referenceId: payload.referenceId || '',
    referenceNo: payload.referenceNo || '',
    operator: payload.operator || 'SYSTEM',
    note: payload.note || '',
    createdAt: new Date().toISOString()
  });
  data.stockMovements = data.stockMovements.slice(0, 500);
}

function reserveOrderStock(data, order) {
  const affectedProducts = [];
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) {
      const stockBefore = Number(product.stock || 0);
      const reservedBefore = Number(product.reservedStock || 0);
      product.reservedStock = Number(product.reservedStock || 0) + Number(orderItem.quantity || 0);
      recordStockMovement(data, product, {
        movementType: 'RESERVE',
        quantity: orderItem.quantity,
        stockBefore,
        stockAfter: stockBefore,
        reservedBefore,
        reservedAfter: Number(product.reservedStock || 0),
        referenceId: order.id,
        referenceNo: order.orderNo,
        operator: 'ORDER_FLOW',
        note: '订单创建后预占库存'
      });
      affectedProducts.push(product);
    }
  }
  order.stockReservation = 'HELD';
  affectedProducts.forEach((product) => evaluateLowStockAlert(data, product, new Date().toISOString()));
}

function releaseOrderStock(data, order) {
  if (order.stockReservation !== 'HELD') return false;
  const affectedProducts = [];
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) {
      const reservedBefore = Number(product.reservedStock || 0);
      product.reservedStock = Math.max(0, Number(product.reservedStock || 0) - Number(orderItem.quantity || 0));
      recordStockMovement(data, product, {
        movementType: 'RELEASE',
        quantity: orderItem.quantity,
        stockBefore: Number(product.stock || 0),
        stockAfter: Number(product.stock || 0),
        reservedBefore,
        reservedAfter: Number(product.reservedStock || 0),
        referenceId: order.id,
        referenceNo: order.orderNo,
        operator: 'ORDER_FLOW',
        note: '订单取消释放预占库存'
      });
      affectedProducts.push(product);
    }
  }
  order.stockReservation = 'RELEASED';
  affectedProducts.forEach((product) => evaluateLowStockAlert(data, product, new Date().toISOString()));
  return true;
}

function consumeOrderStock(data, order) {
  if (order.stockReservation === 'CONSUMED') return false;
  const held = order.stockReservation === 'HELD';
  const affectedProducts = [];
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (!product) continue;
    const stockBefore = Number(product.stock || 0);
    const reservedBefore = Number(product.reservedStock || 0);
    if (held) product.reservedStock = Math.max(0, Number(product.reservedStock || 0) - Number(orderItem.quantity || 0));
    product.stock = Math.max(0, Number(product.stock || 0) - Number(orderItem.quantity || 0));
    recordStockMovement(data, product, {
      movementType: 'CONSUME',
      quantity: orderItem.quantity,
      stockBefore,
      stockAfter: Number(product.stock || 0),
      reservedBefore,
      reservedAfter: Number(product.reservedStock || 0),
      referenceId: order.id,
      referenceNo: order.orderNo,
      operator: 'ORDER_FLOW',
      note: '支付确认后扣减库存'
    });
    affectedProducts.push(product);
  }
  order.stockReservation = 'CONSUMED';
  affectedProducts.forEach((product) => evaluateLowStockAlert(data, product, new Date().toISOString()));
  return true;
}

// 退款/售后退货时把已扣减的库存还回可售池。
function restoreOrderStock(data, order) {
  if (order.stockReservation === 'HELD') return releaseOrderStock(data, order);
  if (order.stockReservation !== 'CONSUMED') return false;
  const affectedProducts = [];
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) {
      const stockBefore = Number(product.stock || 0);
      product.stock = Number(product.stock || 0) + Number(orderItem.quantity || 0);
      recordStockMovement(data, product, {
        movementType: 'RESTORE',
        quantity: orderItem.quantity,
        stockBefore,
        stockAfter: Number(product.stock || 0),
        reservedBefore: Number(product.reservedStock || 0),
        reservedAfter: Number(product.reservedStock || 0),
        referenceId: order.id,
        referenceNo: order.orderNo,
        operator: 'ORDER_FLOW',
        note: '退款/退货回补库存'
      });
      affectedProducts.push(product);
    }
  }
  order.stockReservation = 'RESTORED';
  affectedProducts.forEach((product) => evaluateLowStockAlert(data, product, new Date().toISOString()));
  return true;
}

function sanitizeOrderForMerchant(order) {
  const { deliveryCode, deliveryCodeIssuedAt, ...safe } = order;
  return safe;
}

function wechatOpenApiRequest(pathname, rejectUnauthorized) {
  return new Promise((resolve, reject) => {
    const request = https.get(`https://api.weixin.qq.com${pathname}`, { rejectUnauthorized }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          console.error('[wechat-login] unexpected status', response.statusCode, body.slice(0, 200));
          reject(new ApiError(502, 'WECHAT_LOGIN_UNAVAILABLE', '微信登录服务不可用', { reason: `HTTP ${response.statusCode}` }));
          return;
        }
        try { resolve(JSON.parse(body)); }
        catch {
          console.error('[wechat-login] non-json body', body.slice(0, 200));
          reject(new ApiError(502, 'WECHAT_LOGIN_UNAVAILABLE', '微信登录服务返回异常', { reason: 'non-json response' }));
        }
      });
    });
    request.on('error', (error) => {
      console.error('[wechat-login] request error:', error.message);
      reject(Object.assign(new Error(error.message), { code: error.code }));
    });
    request.setTimeout(8000, () => {
      request.destroy();
      console.error('[wechat-login] request timeout after 8s');
      reject(new Error('timeout after 8s'));
    });
  });
}

function wechatOpenApiPost(pathname, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(`https://api.weixin.qq.com${pathname}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
    }, (response) => {
      let responseBody = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { responseBody += chunk; });
      response.on('end', () => {
        try {
          if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`HTTP ${response.statusCode}`);
          resolve(JSON.parse(responseBody));
        } catch (error) {
          reject(Object.assign(new Error(error.message || 'response parse failed'), { code: 'WECHAT_API_UNAVAILABLE' }));
        }
      });
    });
    request.on('error', (error) => reject(Object.assign(new Error(error.message), { code: error.code || 'WECHAT_API_UNAVAILABLE' })));
    request.setTimeout(8000, () => request.destroy(new Error('timeout after 8s')));
    request.end(body);
  });
}

async function getWeChatAccessToken() {
  const appid = process.env.WECHAT_APPID || process.env.WX_APPID;
  const secret = process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET;
  if (!appid || !secret) throw Object.assign(new Error('微信订阅消息尚未配置'), { code: 'WECHAT_SUBSCRIBE_NOT_CONFIGURED' });
  if (weChatAccessToken.token && weChatAccessToken.expiresAt > Date.now() + 60000) return weChatAccessToken.token;
  const query = new URLSearchParams({ appid, secret, grant_type: 'client_credential' }).toString();
  const result = await wechatOpenApiRequest(`/cgi-bin/token?${query}`, true);
  if (!result.access_token) {
    throw Object.assign(new Error(result.errmsg || 'access_token 获取失败'), { code: `WECHAT_TOKEN_${result.errcode || 'FAILED'}` });
  }
  weChatAccessToken = { token: result.access_token, expiresAt: Date.now() + Number(result.expires_in || 7200) * 1000 };
  return weChatAccessToken.token;
}

async function sendWeChatSubscribeMessage(message) {
  const accessToken = await getWeChatAccessToken();
  return wechatOpenApiPost(`/cgi-bin/message/subscribe/send?access_token=${encodeURIComponent(accessToken)}`, message);
}

async function exchangeWeChatCode(code) {
  const appid = process.env.WECHAT_APPID || process.env.WX_APPID;
  const secret = process.env.WECHAT_APP_SECRET || process.env.WX_APP_SECRET;
  if (!appid || !secret) throw new ApiError(503, 'WECHAT_LOGIN_NOT_CONFIGURED', '微信登录尚未配置');

  const query = new URLSearchParams({ appid, secret, js_code: code, grant_type: 'authorization_code' }).toString();
  let result;
  try {
    result = await wechatOpenApiRequest(`/sns/jscode2session?${query}`, true);
  } catch (error) {
    if (error instanceof ApiError || !isTlsInterceptionError(error)) {
      throw error instanceof ApiError ? error : new ApiError(502, 'WECHAT_LOGIN_UNAVAILABLE', '微信登录服务不可用', { reason: error.message });
    }
    console.error('[wechat-login] tls interception detected, retrying with relaxed verification');
    try {
      result = await wechatOpenApiRequest(`/sns/jscode2session?${query}`, false);
    } catch (retryError) {
      throw retryError instanceof ApiError ? retryError : new ApiError(502, 'WECHAT_LOGIN_UNAVAILABLE', '微信登录服务不可用', { reason: retryError.message });
    }
  }
  if (!result.openid) throw new ApiError(401, 'WECHAT_LOGIN_FAILED', result.errmsg || '微信登录失败', result.errcode ? { errcode: result.errcode } : undefined);
  return { openid: result.openid, userId: `wx_${result.openid}` };
}
function sendJson(response, statusCode, body) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,idempotency-key,authorization',
    'cache-control': 'no-store'
  };
  if (response.corsOrigin) {
    headers['access-control-allow-origin'] = response.corsOrigin;
    headers.vary = 'Origin';
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

function normalizeCorsOrigins(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  return values.map((value) => value.trim()).filter(Boolean);
}

function resolveCorsOrigin(request, allowedOrigins) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return '';
  if (allowedOrigins.includes('*')) return '*';
  return allowedOrigins.includes(origin) ? origin : '';
}

function sendStatic(response, filePath) {
  const extensions = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const extension = path.extname(filePath);
  if (!fs.existsSync(filePath)) return false;
  response.writeHead(200, { 'content-type': extensions[extension] || 'application/octet-stream', 'cache-control': 'no-store' });
  response.end(fs.readFileSync(filePath));
  return true;
}

function requireString(value, field, options = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new ApiError(400, 'VALIDATION_ERROR', `${field} is required`);
  if (options.maxLength && normalized.length > options.maxLength) {
    throw new ApiError(400, 'VALIDATION_ERROR', `${field} is too long`);
  }
  return normalized;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
  if (size > 8 * 1024 * 1024) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 8 MB');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const rawBody = Buffer.concat(chunks).toString('utf8');
  try {
    const body = JSON.parse(rawBody);
    request.rawBody = rawBody;
    return body;
  } catch {
    throw new ApiError(400, 'INVALID_JSON', 'Request body must be valid JSON');
  }
}

function publicApplication(application) {
  const { applicantName, studentNo, ...safe } = application;
  return {
    ...safe,
    applicantNameMasked: applicantName ? `${applicantName.slice(0, 1)}**` : '',
    studentNoMasked: studentNo ? `${studentNo.slice(0, 2)}****${studentNo.slice(-2)}` : ''
  };
}

function merchantPublic(merchant) {
  const { ownerName, phone, settlementAccount = '', ...safe } = merchant;
  return {
    ...safe,
    merchantType: safe.merchantType || 'INDIVIDUAL',
    ownerNameMasked: ownerName ? `${ownerName.slice(0, 1)}**` : '',
    phoneMasked: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : '',
    settlementAccountMasked: settlementAccount ? `${settlementAccount.slice(0, 4)} **** ${settlementAccount.slice(-4)}` : '',
    settlementAccountReady: Boolean(settlementAccount)
  };
}

function withMerchantName(product, merchants) {
  return { ...product, merchantName: merchants.find((merchant) => merchant.id === product.merchantId)?.name || '平台自营' };
}

function withProductReviewSummary(product, reviews = []) {
  const matched = reviews.filter((review) => review.productId === product.id && review.purchaseVerified && review.visibility !== 'HIDDEN');
  const lowReviews = matched.filter((review) => Number(review.rating) <= 3);
  const repliedLowReviews = lowReviews.filter((review) => review.reply?.content);
  if (!matched.length) return {
    ...product,
    ratingSummary: {
      average: 0, count: 0, purchaseVerifiedCount: 0,
      positiveCount: 0, mediumNegativeCount: 0, repliedLowCount: 0, lowReplyRate: 1
    }
  };
  const average = matched.reduce((sum, review) => sum + (Number(review.rating) || 0), 0) / matched.length;
  return {
    ...product,
    ratingSummary: {
      average: Math.round(average * 10) / 10,
      count: matched.length,
      purchaseVerifiedCount: matched.length,
      positiveCount: matched.filter((review) => Number(review.rating) >= 4).length,
      mediumNegativeCount: lowReviews.length,
      repliedLowCount: repliedLowReviews.length,
      lowReplyRate: lowReviews.length ? Math.round((repliedLowReviews.length / lowReviews.length) * 100) / 100 : 1
    }
  };
}

function productSalesCount(data, productId) {
  let count = 0;
  for (const order of data.orders || []) {
    if (!['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(order.status)) continue;
    for (const item of order.items || []) {
      if (item.productId === productId) count += Number(item.quantity || 1);
    }
  }
  for (const order of data.phoneCardOrders || []) {
    if (!['PENDING_REALNAME', 'ACTIVATED'].includes(order.status) || order.productId !== productId) continue;
    count += 1;
  }
  return count;
}

function productStoreProfile(product, { deliveryResponseHours = 24, soldCount = 0 } = {}) {
  const score = product.merchantScore || null;
  const rating = product.ratingSummary || {};
  const positiveRate = rating.count
    ? Math.round((Number(rating.positiveCount || 0) / Number(rating.count)) * 1000) / 10
    : null;
  return {
    name: product.merchantName || '平台自营',
    serviceArea: product.serviceArea || '华中农业大学狮山校区',
    responseText: `校内配送 ${Number(deliveryResponseHours) || 24} 小时内响应`,
    score: score ? score.score : null,
    scoreText: score ? String(score.score) : '待评估',
    scoreLabel: score ? (score.gradeLabel || '已评估') : '新商家',
    scoreToneClass: score ? (score.stage === 'NORMAL' ? 'good' : score.stage === 'LIMITED' ? 'watch' : 'risk') : 'new',
    ratingText: rating.count ? Number(rating.average || 0).toFixed(1) : '新',
    ratingCountText: rating.count ? `${rating.count} 条已购评价` : '暂无已购评价',
    positiveText: positiveRate === null ? '暂无好评率' : `好评率 ${positiveRate}%`,
    soldCount,
    soldText: soldCount > 0 ? `已售 ${soldCount}` : '新品上架'
  };
}

function publicStorefrontReviews(data, merchantId) {
  const productNames = new Map((data.products || []).map((product) => [product.id, product.name]));
  const matched = (data.productReviews || []).filter((review) => {
    const product = (data.products || []).find((item) => item.id === review.productId);
    return product?.merchantId === merchantId
      && review.purchaseVerified
      && review.visibility !== 'HIDDEN';
  }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const average = matched.length
    ? matched.reduce((sum, review) => sum + (Number(review.rating) || 0), 0) / matched.length
    : 0;
  const positiveCount = matched.filter((review) => Number(review.rating) >= 4).length;
  return {
    summary: {
      count: matched.length,
      averageRating: Math.round(average * 10) / 10,
      positiveRate: matched.length ? Math.round((positiveCount / matched.length) * 100) / 100 : 0
    },
    items: matched.slice(0, 8).map((review) => ({
      id: review.id,
      rating: Number(review.rating) || 0,
      content: review.content || '',
      images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
      customerName: review.customerName || '匿名同学',
      college: review.college || '',
      createdAt: review.createdAt || '',
      productName: productNames.get(review.productId) || '平台商品',
      reply: review.reply?.content ? {
        merchantName: review.reply.merchantName || '商家回复',
        content: review.reply.content,
        repliedAt: review.reply.repliedAt || ''
      } : null
    }))
  };
}

function userNotificationLink(notification) {
  const metadata = notification?.metadata || {};
  if (metadata.focusId) {
    return `/pages/orders/orders?focusId=${encodeURIComponent(String(metadata.focusId))}`;
  }
  if (metadata.productId) {
    return `/pages/detail/detail?id=${encodeURIComponent(String(metadata.productId))}`;
  }
  return '';
}

function leadSourceRecord(data, userId, sourceType, sourceId) {
  if (!sourceType && !sourceId) return null;
  const collections = {
    ORDER: 'orders',
    PHONE_PLAN: 'phoneCardOrders',
    RECHARGE: 'rechargeOrders',
    BROADBAND: 'broadbandApplications',
    PLATE: 'plateApplications'
  };
  if (!collections[sourceType] || !sourceId) {
    throw new ApiError(400, 'VALIDATION_ERROR', '来源业务或来源单号不完整');
  }
  const source = (data[collections[sourceType]] || []).find((item) => item.id === sourceId && item.userId === userId);
  if (!source) throw new ApiError(404, 'LEAD_SOURCE_NOT_FOUND', '来源订单不存在或不属于当前用户');
  return source;
}

function rechargePromoAvailability(promo, now = new Date().toISOString()) {
  const current = new Date(now).getTime();
  const startsAt = promo.startsAt ? new Date(promo.startsAt).getTime() : null;
  const endsAt = promo.endsAt ? new Date(promo.endsAt).getTime() : null;
  if (startsAt && current < startsAt) return { status: 'SCHEDULED', statusLabel: '未开始' };
  if (endsAt && current >= endsAt) return { status: 'ENDED', statusLabel: '已结束' };
  return { status: 'ACTIVE', statusLabel: '进行中' };
}

function publicRechargePromo(promo, data, now) {
  const linkedOrders = (data.rechargeOrders || []).filter((order) => order.promoId === promo.id);
  const linkedPaidOrderCount = linkedOrders.filter((order) => order.paymentStatus === 'PAID'
    && ['PENDING_CREDIT', 'CREDITED'].includes(order.status)).length;
  return {
    ...promo,
    ...rechargePromoAvailability(promo, now),
    linkedOrderCount: linkedOrders.length,
    linkedPaidOrderCount,
    linkedAmountInCents: linkedPaidOrderCount * Math.round(Number(promo.pay || 0) * 100)
  };
}

function normalizeProductSaleCampaign(input = {}, currentProduct = null) {
  if (input.salePriceInCents === undefined && input.saleStartsAt === undefined && input.saleEndsAt === undefined) return null;
  const salePriceInCents = Number(input.salePriceInCents ?? currentProduct?.salePriceInCents);
  const startsAt = input.saleStartsAt ?? currentProduct?.saleStartsAt ?? '';
  const endsAt = input.saleEndsAt ?? currentProduct?.saleEndsAt ?? '';
  if (!Number.isInteger(salePriceInCents) || salePriceInCents <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', '促销价必须是大于 0 的整数分');
  }
  const startDate = startsAt ? new Date(startsAt) : null;
  const endDate = endsAt ? new Date(endsAt) : null;
  if (!startDate || Number.isNaN(startDate.getTime()) || !endDate || Number.isNaN(endDate.getTime())
    || startDate.getTime() >= endDate.getTime()) {
    throw new ApiError(400, 'VALIDATION_ERROR', '促销开始时间必须早于结束时间');
  }
  return {
    salePriceInCents,
    saleStartsAt: startDate.toISOString(),
    saleEndsAt: endDate.toISOString()
  };
}

function withProductSale(product, now = new Date().toISOString()) {
  const originalPriceInCents = Number(product.priceInCents) || 0;
  const salePriceInCents = Number(product.salePriceInCents) || 0;
  const availability = rechargePromoAvailability({
    startsAt: product.saleStartsAt,
    endsAt: product.saleEndsAt
  }, now);
  const active = salePriceInCents > 0
    && salePriceInCents < originalPriceInCents
    && availability.status === 'ACTIVE';
  return {
    ...product,
    effectivePriceInCents: active ? salePriceInCents : originalPriceInCents,
    promotion: active ? {
      originalPriceInCents,
      salePriceInCents,
      status: availability.status,
      statusText: '限时直降'
    } : null
  };
}

function productPromotionOrderMetrics(product, data, now = new Date().toISOString()) {
  if (!product?.salePriceInCents) {
    return {
      campaignOrderCount: 0,
      campaignPaidOrderCount: 0,
      campaignSalesQuantity: 0,
      campaignAmountInCents: 0,
      campaignDiscountInCents: 0,
      campaignStatus: null,
      campaignStatusLabel: ''
    };
  }
  const startsAt = product.saleStartsAt ? new Date(product.saleStartsAt).getTime() : null;
  const endsAt = product.saleEndsAt ? new Date(product.saleEndsAt).getTime() : null;
  const current = new Date(now).getTime();
  const campaignStatus = startsAt && current < startsAt ? 'SCHEDULED'
    : endsAt && current >= endsAt ? 'ENDED'
      : 'ACTIVE';
  const campaignStatusLabel = campaignStatus === 'SCHEDULED' ? '未开始'
    : campaignStatus === 'ENDED' ? '已结束' : '进行中';
  let campaignOrderCount = 0;
  let campaignPaidOrderCount = 0;
  let campaignSalesQuantity = 0;
  let campaignAmountInCents = 0;
  let campaignDiscountInCents = 0;
  for (const order of data.orders || []) {
    let matchedQuantity = 0;
    let matchedAmount = 0;
    for (const item of order.items || []) {
      if (item.productId !== product.id) continue;
      matchedQuantity += Number(item.quantity || 1);
      matchedAmount += Number(item.subtotalInCents || 0);
    }
    if (!matchedQuantity) continue;
    const paid = ['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(order.status);
    if (!paid) continue;
    campaignOrderCount += 1;
    campaignPaidOrderCount += 1;
    campaignSalesQuantity += matchedQuantity;
    campaignAmountInCents += matchedAmount;
    campaignDiscountInCents += matchedQuantity * Math.max(Number(product.priceInCents) - Number(product.salePriceInCents), 0);
  }
  for (const order of data.phoneCardOrders || []) {
    if (order.productId !== product.id
      || !['PENDING_REALNAME', 'ACTIVATED'].includes(order.status)
      || order.paymentStatus !== 'PAID') continue;
    campaignOrderCount += 1;
    campaignPaidOrderCount += 1;
    campaignSalesQuantity += 1;
    campaignAmountInCents += Number(order.amountInCents || 0);
    campaignDiscountInCents += Math.max(Number(product.priceInCents) - Number(product.salePriceInCents), 0);
  }
  return {
    campaignOrderCount,
    campaignPaidOrderCount,
    campaignSalesQuantity,
    campaignAmountInCents,
    campaignDiscountInCents,
    campaignStatus,
    campaignStatusLabel
  };
}

function createCollaboration(order, merchantId) {
  return {
    merchantId,
    handoffs: [
      { role:'PLATFORM', action:'PLATFORM_ACCEPTED', note:'平台已生成订单', createdAt:order.createdAt },
      { role:'MERCHANT', action:'WAIT_ACCEPT', note:'待商家确认履约', createdAt:order.createdAt }
    ],
    roleActions: {
      MERCHANT: order.status === 'PAID' ? ['ACCEPT'] : order.status === 'FULFILLING' ? ['COMPLETE'] : [],
      USER: order.status === 'FULFILLING' ? [] : order.status === 'COMPLETED' ? ['REVIEW'] : ['CONFIRM_INFO'],
      PLATFORM: []
    },
    intervention: { status:'NONE', note:'', updatedAt:'' },
    messages: [
      { id:`msg_${Date.now()}_${Math.random().toString(16).slice(2,8)}`, role:'PLATFORM', text:'订单已支付，等待商家确认履约。', createdAt:order.createdAt }
    ]
  };
}

function appendCollaborationEvent(order, role, action, note) {
  const time = new Date().toISOString();
  order.collaboration ||= { merchantId:'', handoffs:[], roleActions:{ MERCHANT:[],USER:[],PLATFORM:[] }, intervention:{ status:'NONE', note:'', updatedAt:'' }, messages:[] };
  order.collaboration.handoffs.unshift({ role, action, note, createdAt:time });
  order.collaboration.messages.unshift({ id:`msg_${Date.now()}_${Math.random().toString(16).slice(2,8)}`, role, text:note, createdAt:time });
  order.collaboration.roleActions = {
    MERCHANT: order.status === 'PAID' ? ['ACCEPT'] : order.status === 'FULFILLING' ? ['COMPLETE'] : [],
    USER: order.status === 'COMPLETED' ? ['REVIEW'] : ['CONFIRM_INFO'],
    PLATFORM: order.collaboration.intervention.status === 'REQUESTED' ? ['RESOLVE'] : []
  };
  order.collaboration.intervention.status = role === 'PLATFORM' ? 'RESOLVED' : order.collaboration.intervention.status;
  order.collaboration.intervention.updatedAt = time;
}

function serviceRecordOwner(data, recordId) {
  const collections = [
    { key: 'phoneCardOrders', type: 'PHONE_PLAN', label: '电话卡订单' },
    { key: 'rechargeOrders', type: 'RECHARGE', label: '话费权益' },
    { key: 'broadbandApplications', type: 'BROADBAND', label: '宽带资格' },
    { key: 'plateApplications', type: 'PLATE', label: '校园牌照' }
  ];
  for (const collection of collections) {
    const item = (data[collection.key] || []).find((row) => row.id === recordId);
    if (item) return { ...collection, item };
  }
  return null;
}

function appendServiceRecordEvent(record, role, action, note) {
  const time = new Date().toISOString();
  record.collaboration ||= { handoffs: [], roleActions: { MERCHANT: [], USER: [], PLATFORM: [] }, intervention: { status: 'NONE', note: '', updatedAt: '' }, messages: [] };
  record.collaboration.handoffs.unshift({ role, action, note, createdAt: time });
  record.collaboration.messages.unshift({ id: `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`, role, text: note, createdAt: time });
  record.collaboration.intervention.updatedAt = time;
}

const scoreComplaintTypeLabels = {
  REMOVED_NEGATIVE_REVIEW: '差评记录有误',
  DELAYED_DELIVERY: '履约延时有合理原因',
  AFTER_SALE_ISSUE: '售后责任认定有异议'
};

function complaintDueAt(now) {
  return new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString();
}

const adminRoleLabels = {
  SUPER_ADMIN: '超级管理员',
  OPERATOR: '运营管理员',
  FINANCE: '财务管理员',
  SUPPORT: '客服管理员'
};

const adminRolePermissions = {
  SUPER_ADMIN: ['*'],
  OPERATOR: ['CONFIG_MANAGE', 'CATALOG_MANAGE', 'MERCHANT_MANAGE', 'ORDER_MANAGE', 'REPORT_VIEW'],
  FINANCE: ['FINANCE_MANAGE', 'REPORT_VIEW'],
  SUPPORT: ['ORDER_MANAGE', 'REPORT_VIEW']
};

function hashPassword(password) {
  const salt = randomBytes(16);
  const passwordHash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${passwordHash.toString('hex')}`;
}

function verifyPasswordHash(suppliedPassword, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expectedHash;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expectedHash = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length !== 16 || expectedHash.length !== 64) return false;
  const actualHash = scryptSync(String(suppliedPassword || ''), salt, 64);
  return timingSafeEqual(actualHash, expectedHash);
}

function adminPermissionForRequest(pathname) {
  if (pathname.startsWith('/api/admin/admins')) return 'ADMIN_MANAGE';
  if (pathname.startsWith('/api/admin/uploads')) return 'FINANCE_MANAGE';
  if (/^\/api\/admin\/merchants\/[^/]+\/settle$/.test(pathname)) return 'FINANCE_MANAGE';
  if (pathname.startsWith('/api/admin/settings')
    || pathname.startsWith('/api/admin/subscribe-templates')) return 'CONFIG_MANAGE';
  if (pathname.startsWith('/api/admin/payment-orders')
    || pathname.startsWith('/api/admin/payment-reconciliations')
    || pathname.startsWith('/api/admin/finance-tasks')
    || pathname.startsWith('/api/admin/payout-requests')
    || pathname.startsWith('/api/admin/finance-events')) return 'FINANCE_MANAGE';
  if (pathname.startsWith('/api/admin/products')
    || pathname.startsWith('/api/admin/recharge-promos')
    || pathname.startsWith('/api/admin/product-reviews')) return 'CATALOG_MANAGE';
  if (pathname.startsWith('/api/admin/merchants')
    || pathname.startsWith('/api/admin/qualification-renewals')
    || pathname.startsWith('/api/admin/merchant-scores')
    || pathname.startsWith('/api/admin/score-cases')) return 'MERCHANT_MANAGE';
  if (pathname.startsWith('/api/admin/orders')
    || pathname.startsWith('/api/admin/phone-card-orders')
    || pathname.startsWith('/api/admin/recharge-orders')
    || pathname.startsWith('/api/admin/broadband-applications')
    || pathname.startsWith('/api/admin/plate-applications')
    || pathname.startsWith('/api/admin/after-sales')
    || pathname.startsWith('/api/admin/leads')
    || pathname.startsWith('/api/admin/sla-alerts')
    || pathname.startsWith('/api/admin/patrol/run')
    || pathname.startsWith('/api/admin/notifications')
    || pathname.startsWith('/api/admin/subscribe-messages')) return 'ORDER_MANAGE';
  if (pathname.startsWith('/api/admin/overview')
    || pathname.startsWith('/api/admin/operations-report')) return 'REPORT_VIEW';
  return 'ADMIN_MANAGE';
}


function publicAdminUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  updatedAt: user.updatedAt
  };
}

function normalizeQualificationExpireDate(value) {
  const date = typeof value === 'string' ? value.trim() : '';
  if (!date) return '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00.000Z`).getTime())) {
    throw new ApiError(400, 'VALIDATION_ERROR', '资质有效期格式需为 YYYY-MM-DD');
  }
  return date;
}

function createApp({
  store,
  wechatAuth = exchangeWeChatCode,
  wechatSubscribeSend = sendWeChatSubscribeMessage,
  paymentProvider = createPaymentProvider(),
  corsAllowedOrigins,
  adminLoginLockout,
  adminPasswordHash
}) {
  const allowedCorsOrigins = normalizeCorsOrigins(
    corsAllowedOrigins ?? process.env.CORS_ALLOWED_ORIGINS ?? 'http://localhost:3000,http://127.0.0.1:3000'
  );
  const merchantSessions = new Map();
  const {
    maxFailures: adminLoginMaxFailures = 5,
    lockDurationMs: adminLoginLockDurationMs = 15 * 60 * 1000
  } = adminLoginLockout || {};
  const configuredAdminPasswordHash = adminPasswordHash || process.env.ADMIN_PASSWORD_HASH || '';
  const userWeChatIdentities = new Map();
  const userSessions = new Map();
  const userSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

  async function attachProviderIntent(paymentOrder) {
    if (!paymentOrder) return null;
    const payerOpenId = store.read().userOpenIds?.[paymentOrder.userId] || paymentOrder.openid || '';
    let intent;
    try {
      intent = await paymentProvider.createIntent({
        ...paymentOrder,
        openid: payerOpenId,
        description: paymentOrder.description || `狮山智生活订单 ${paymentOrder.paymentNo}`
      });
    } catch (error) {
      throw new ApiError(502, 'PAYMENT_PROVIDER_FAILED', `支付渠道暂不可用：${error.message}`);
    }
    return store.update((data) => {
      const payment = (data.paymentOrders || []).find((item) => item.id === paymentOrder.id);
      if (!payment || payment.status !== 'PENDING') {
        throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '仅待支付单可生成支付参数');
      }
      payment.provider = paymentProvider.name;
      payment.channel = paymentProvider.channel;
      payment.providerTradeNo = intent.providerTradeNo || '';
      payment.providerPayload = intent.payload || null;
      payment.updatedAt = new Date().toISOString();
      return payment;
    });
  }

  async function confirmProviderPayment(paymentOrder) {
    try {
      const result = await paymentProvider.confirm(paymentOrder);
      if (result?.status !== 'PAID') {
        throw new Error(`provider returned ${result?.status || 'UNKNOWN'}`);
      }
      return result;
    } catch (error) {
      throw new ApiError(502, 'PAYMENT_PROVIDER_FAILED', `支付确认失败：${error.message}`);
    }
  }

  async function queryProviderRefund(paymentOrder) {
    try {
      if (typeof paymentProvider.queryRefund !== 'function') {
        throw new Error('payment provider does not support refund query');
      }
      const result = await paymentProvider.queryRefund(paymentOrder);
      if (!['REFUNDED', 'PENDING', 'FAILED'].includes(result?.status)) {
        throw new Error(`provider returned ${result?.status || 'UNKNOWN'}`);
      }
      return result;
    } catch (error) {
      throw new ApiError(502, 'PAYMENT_PROVIDER_FAILED', `退款查询失败：${error.message}`);
    }
  }

  function completePaymentRefund(paymentId, providerRefund, source = 'ADMIN_REFUND') {
    return store.update((data) => {
      if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
      const paymentOrder = data.paymentOrders.find((item) => item.id === paymentId);
      if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
      if (paymentOrder.status === 'REFUNDED') return { paymentOrder, duplicate: true };
      if (paymentOrder.status !== 'PAID') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '仅已支付单可退款');
      const now = new Date().toISOString();
      const refundNo = providerRefund?.refundNo || paymentOrder.refund?.refundNo || `RF_${paymentOrder.paymentNo}`;
      paymentOrder.status = 'REFUNDED';
      paymentOrder.refundedAt = now;
      paymentOrder.updatedAt = now;
      paymentOrder.providerTradeNo = providerRefund?.providerTradeNo || paymentOrder.providerTradeNo || '';
      paymentOrder.refund = {
        status: 'REFUNDED',
        refundNo,
        requestedAt: paymentOrder.refund?.requestedAt || now,
        updatedAt: now,
        note: paymentOrder.refund?.note || '',
        providerPayload: providerRefund?.payload || paymentOrder.refund?.providerPayload || null
      };

      const order = (data.orders || []).find((item) => item.id === paymentOrder.orderId);
      const rechargeOrder = (data.rechargeOrders || []).find((item) => item.id === paymentOrder.businessId && item.paymentOrderId === paymentOrder.id);
      const phoneCardOrder = (data.phoneCardOrders || []).find((item) => item.id === paymentOrder.businessId && item.paymentOrderId === paymentOrder.id);
      const plateApplication = (data.plateApplications || []).find((item) => item.id === paymentOrder.businessId && item.paymentOrderId === paymentOrder.id);
      if (phoneCardOrder) {
        phoneCardOrder.status = 'CANCELLED';
        phoneCardOrder.paymentStatus = 'REFUNDED';
        phoneCardOrder.updatedAt = now;
      }
      if (rechargeOrder) {
        rechargeOrder.status = 'CANCELLED';
        rechargeOrder.paymentStatus = 'REFUNDED';
        rechargeOrder.updatedAt = now;
      }
      if (plateApplication) {
        plateApplication.status = 'REJECTED';
        plateApplication.paymentStatus = 'REFUNDED';
        plateApplication.updatedAt = now;
      }
      if (order) {
        order.status = 'CANCELLED';
        order.paymentStatus = 'REFUNDED';
        order.updatedAt = now;
        restoreOrderStock(data, order);
      }
      markSettlementsRefunded(data, order?.id || '', now);
      addFinanceEvent(data, 'REFUND', `REFUND_${paymentOrder.id}`, -(paymentOrder.amountInCents || 0), {
        userId: paymentOrder.userId,
        paymentNo: paymentOrder.paymentNo,
        orderNo: order?.orderNo || '',
        businessType: phoneCardOrder ? 'PHONE_PLAN' : rechargeOrder ? 'RECHARGE' : plateApplication ? 'PLATE' : 'ORDER'
      }, now);
      const refundAuditAction = source === 'REFUND_QUERY'
        ? '管理端退款查询确认'
        : source === 'REFUND_CALLBACK'
          ? '退款回调自动确认'
          : source === 'LATE_PAYMENT_CALLBACK'
            ? '超时支付自动退款'
          : '管理端退款';
      addAudit(data, refundAuditAction, paymentOrder.paymentNo);
      if (rechargeOrder) {
        addNotification(data, paymentOrder.userId, 'RECHARGE', '话费权益已退款', `订单 ${paymentOrder.paymentNo} 已完成退款。`, { focusId: rechargeOrder.id });
      } else if (phoneCardOrder) {
        addNotification(data, paymentOrder.userId, 'PHONE_PLAN', '电话卡订单已退款', `订单 ${paymentOrder.paymentNo} 已完成退款。`, { focusId: phoneCardOrder.id });
      } else if (plateApplication) {
        addNotification(data, paymentOrder.userId, 'PLATE', '牌照服务费已退款', `申请 ${paymentOrder.paymentNo} 已完成退款，如需重新办理可再次提交。`, { focusId: plateApplication.id });
      } else {
        addNotification(data, paymentOrder.userId, 'ORDER', '订单已退款', `订单 ${paymentOrder.orderNo} 已完成退款。`, { focusId: order?.id || paymentOrder.businessId });
      }
      return { order, rechargeOrder, phoneCardOrder, plateApplication, paymentOrder };
    });
  }

  async function handleLatePaymentCallback(paymentOrder, providerPayment) {
    const captured = store.update((data) => {
      const currentPayment = (data.paymentOrders || []).find((item) => item.id === paymentOrder.id);
      if (!currentPayment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
      if (currentPayment.status !== 'CANCELLED') return { paymentOrder: currentPayment, duplicate: true };

      const now = new Date().toISOString();
      const refundNo = `RF_${currentPayment.paymentNo}`;
      currentPayment.status = 'PAID';
      currentPayment.paidAt = providerPayment?.paidAt || now;
      currentPayment.updatedAt = now;
      currentPayment.providerTradeNo = providerPayment?.providerTradeNo || currentPayment.providerTradeNo || '';
      currentPayment.providerPayload = providerPayment?.payload || currentPayment.providerPayload || null;
      currentPayment.latePaymentCaptured = true;
      currentPayment.refund = {
        status: 'PENDING',
        refundNo,
        requestedAt: now,
        updatedAt: now,
        note: '订单已关闭后收到支付，平台自动退款',
        providerPayload: null
      };
      addFinanceEvent(data, 'PAYMENT', `PAYMENT_${currentPayment.id}`, currentPayment.amountInCents, {
        userId: currentPayment.userId,
        paymentNo: currentPayment.paymentNo,
        businessType: 'LATE_PAYMENT'
      }, now);
      addAudit(data, '超时订单收到延迟支付，自动发起退款', currentPayment.paymentNo);
      addNotification(
        data,
        currentPayment.userId,
        'ORDER',
        '超时订单收到支付，正在退款',
        `订单支付单 ${currentPayment.paymentNo} 在关闭后收到支付，平台已自动发起退款。`
      );
      return { paymentOrder: currentPayment, duplicate: false };
    });

    if (captured.duplicate) {
      const order = store.read().orders.find((item) => item.id === paymentOrder.orderId);
      return { paymentOrder: captured.paymentOrder, order, duplicate: true };
    }

    let providerRefund;
    try {
      providerRefund = await paymentProvider.refund(captured.paymentOrder);
    } catch (error) {
      const failedPayment = store.update((data) => {
        const currentPayment = (data.paymentOrders || []).find((item) => item.id === paymentOrder.id);
        currentPayment.refund.status = 'FAILED';
        currentPayment.refund.updatedAt = new Date().toISOString();
        currentPayment.refund.providerPayload = { error: error.message };
        addAudit(data, '超时支付自动退款失败', currentPayment.paymentNo);
        return currentPayment;
      });
      const order = store.read().orders.find((item) => item.id === paymentOrder.orderId);
      return { paymentOrder: failedPayment, order, lateRefundFailed: true };
    }

    if (providerRefund?.status === 'REFUNDED') {
      return completePaymentRefund(paymentOrder.id, providerRefund, 'LATE_PAYMENT_CALLBACK');
    }

    const pendingPayment = store.update((data) => {
      const currentPayment = (data.paymentOrders || []).find((item) => item.id === paymentOrder.id);
      currentPayment.refund.status = ['PENDING', 'FAILED'].includes(providerRefund?.status) ? providerRefund.status : 'FAILED';
      currentPayment.refund.updatedAt = new Date().toISOString();
      currentPayment.refund.providerPayload = providerRefund?.payload || null;
      if (currentPayment.refund.status === 'FAILED') {
        addAudit(data, '超时支付自动退款失败', currentPayment.paymentNo);
      }
      return currentPayment;
    });
    const order = store.read().orders.find((item) => item.id === paymentOrder.orderId);
    return { paymentOrder: pendingPayment, order };
  }

  function settlePaymentOrder(paymentId, providerPayment, source = 'USER_CONFIRM') {
    return store.update((data) => {
      const paymentOrder = (data.paymentOrders || []).find((item) => item.id === paymentId);
      if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
      if (paymentOrder.status !== 'PENDING') return { paymentOrder, duplicate: true };

      const order = data.orders.find((item) => item.id === paymentOrder.orderId && item.userId === paymentOrder.userId);
      const rechargeOrder = data.rechargeOrders.find((item) => item.id === paymentOrder.businessId && item.userId === paymentOrder.userId);
      const phoneCardOrder = data.phoneCardOrders.find((item) => item.id === paymentOrder.businessId && item.userId === paymentOrder.userId);
      const plateApplication = (data.plateApplications || []).find((item) => item.id === paymentOrder.businessId && item.userId === paymentOrder.userId && item.paymentOrderId === paymentOrder.id);
      if (!order && !rechargeOrder && !phoneCardOrder && !plateApplication) {
        throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
      }

      const now = new Date().toISOString();
      paymentOrder.status = 'PAID';
      paymentOrder.paidAt = providerPayment?.paidAt || now;
      paymentOrder.updatedAt = now;
      paymentOrder.providerTradeNo = providerPayment?.providerTradeNo || paymentOrder.providerTradeNo || '';
      paymentOrder.providerPayload = providerPayment?.payload || paymentOrder.providerPayload || null;

      if (rechargeOrder) {
        rechargeOrder.status = 'PENDING_CREDIT';
        rechargeOrder.paymentStatus = 'PAID';
        rechargeOrder.updatedAt = now;
        addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
          userId: paymentOrder.userId,
          paymentNo: paymentOrder.paymentNo,
          businessType: 'RECHARGE'
        }, now);
        addAudit(data, source === 'PROVIDER_CALLBACK' ? '话费权益支付回调成功' : '话费权益支付成功', rechargeOrder.id);
        addNotification(data, paymentOrder.userId, 'RECHARGE', '话费权益支付成功', `充 ${Math.round(rechargeOrder.paidInCents / 100)} 送 ${Math.round((rechargeOrder.receiveInCents - rechargeOrder.paidInCents) / 100)} 已支付，等待运营确认到账。`, { focusId: rechargeOrder.id });
        return { rechargeOrder, paymentOrder };
      }

      if (phoneCardOrder) {
        phoneCardOrder.status = 'PENDING_REALNAME';
        phoneCardOrder.paymentStatus = 'PAID';
        phoneCardOrder.updatedAt = now;
        const activationHours = publicSettings(data.adminSettings).phoneCardActivationHours;
        addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
          userId: paymentOrder.userId,
          paymentNo: paymentOrder.paymentNo,
          businessType: 'PHONE_PLAN'
        }, now);
        addAudit(data, source === 'PROVIDER_CALLBACK' ? '电话卡支付回调成功' : '电话卡支付成功', phoneCardOrder.id);
        addNotification(data, paymentOrder.userId, 'PHONE_PLAN', '电话卡支付成功', `${phoneCardOrder.planName} 已支付，运营商将在 ${activationHours} 小时内联系实名激活。`, { focusId: phoneCardOrder.id });
        return { phoneCardOrder, paymentOrder };
      }

      if (plateApplication) {
        plateApplication.status = 'MATERIAL_PENDING';
        plateApplication.paymentStatus = 'PAID';
        plateApplication.updatedAt = now;
        addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
          userId: paymentOrder.userId,
          paymentNo: paymentOrder.paymentNo,
          businessType: 'PLATE'
        }, now);
        addAudit(data, source === 'PROVIDER_CALLBACK' ? '自带车上牌服务费支付回调成功' : '自带车上牌服务费支付成功', plateApplication.id);
        addNotification(data, paymentOrder.userId, 'PLATE', '牌照服务费支付成功', `${plateApplication.vehicleModel} 已支付服务费，请按提示补充车辆和身份材料。`, { focusId: plateApplication.id });
        return { plateApplication, paymentOrder };
      }

      order.paymentStatus = 'PAID';
      order.status = 'PAID';
      order.updatedAt = now;
      order.paidAt = order.paidAt || now;
      issueDeliveryCode(order, now);
      consumeOrderStock(data, order);
      const bikeItem = order.items.find((item) => (data.products || []).find((product) => product.id === item.productId)?.category === 'E_BIKE_NEW');
      if (bikeItem) {
        const plateApplication = {
          id: `plate_${randomUUID()}`,
          userId: paymentOrder.userId,
          customerName: order.fulfillment?.contactName || '平台购车用户',
          phone: order.fulfillment?.contactPhone || '',
          vehicleModel: bikeItem.name,
          source: 'PLATFORM_ORDER',
          feeInCents: 0,
          relatedOrderId: order.id,
          status: 'MATERIAL_PENDING',
          relatedIds: { platformOrderIds: [order.id] },
          createdAt: now,
          updatedAt: now
        };
        (data.plateApplications = data.plateApplications || []).unshift(plateApplication);
        addAudit(data, source === 'PROVIDER_CALLBACK' ? '购车支付回调后自动创建免费牌照辅助' : '购车支付后自动创建免费牌照辅助', order.orderNo);
        addNotification(data, paymentOrder.userId, 'PLATE', '免费牌照辅助已发起', '平台购车后可享受免费校园牌照辅助。', { focusId: plateApplication.id });
      }
      order.collaboration ||= createCollaboration(order, order.items[0]?.merchantId || '');
      createSettlements(data, order, now);
      addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
        userId: paymentOrder.userId,
        paymentNo: paymentOrder.paymentNo,
        orderNo: order.orderNo,
        businessType: 'ORDER'
      }, now);
      order.collaboration.messages.unshift({
        id: `msg_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
        role: 'PLATFORM',
        text: '支付成功，待商家确认履约。',
        createdAt: now
      });
      addAudit(data, source === 'PROVIDER_CALLBACK' ? '支付回调成功' : '支付成功', order.orderNo);
      sendOrderNotification(data, paymentOrder.userId, 'ORDER_STATUS', '支付成功', `订单 ${order.orderNo} 支付成功，商家将尽快确认履约。`,
        now, { orderId: order.id });
      notifyOrderMerchant(data, order, 'ORDER', '新订单已支付', `订单 ${order.orderNo} 已支付，请尽快确认履约。`);
      return { order, paymentOrder };
    });
  }

  function ensureBootstrapAdmin() {
    store.update((data) => {
      data.adminUsers = Array.isArray(data.adminUsers) ? data.adminUsers : [];
      if (data.adminUsers.length > 0) return false;

      const username = process.env.ADMIN_USERNAME || 'admin';
      const passwordHash = configuredAdminPasswordHash || (
        process.env.ADMIN_PASSWORD ? hashPassword(process.env.ADMIN_PASSWORD) : ''
      );
      if (!passwordHash) return false;

      const now = new Date().toISOString();
      data.adminUsers.push({
        id: `admin_${randomUUID()}`,
        username,
        displayName: '运营管理员',
        passwordHash,
        role: 'SUPER_ADMIN',
        status: 'ACTIVE',
        createdAt: now,
        updatedAt: now
      });
      return true;
    });
  }
  ensureBootstrapAdmin();

  function getAdminLoginLockKey(request, attemptedUsername) {
    const clientAddress = request.socket?.remoteAddress || 'unknown';
    const normalizedUsername = String(attemptedUsername || '').trim().toLowerCase();
    return `${clientAddress}|${normalizedUsername}`;
  }

  function getActiveAdminLoginLock(lockKey, now) {
    const state = (store.read().adminLoginFailures || []).find((item) => item.key === lockKey);
    if (!state) return null;
    if (state.lockedUntil > now) return state;
    if (state.lastFailedAt + adminLoginLockDurationMs <= now) {
      return null;
    }
    return state.lockedUntil ? null : state;
  }

  function recordAdminLoginFailure(lockKey, now) {
    return store.update((data) => {
      data.adminLoginFailures = Array.isArray(data.adminLoginFailures) ? data.adminLoginFailures : [];
      data.adminLoginFailures = data.adminLoginFailures.filter((item) => (
        item.lockedUntil > now || item.lastFailedAt + adminLoginLockDurationMs > now
      ));
      const state = data.adminLoginFailures.find((item) => item.key === lockKey) || {
        key: lockKey,
        failures: 0,
        lockedUntil: 0,
        lastFailedAt: 0
      };
      if (state.lastFailedAt + adminLoginLockDurationMs <= now) {
        state.failures = 0;
        state.lockedUntil = 0;
      }
      state.failures += 1;
      state.lastFailedAt = now;
      if (state.failures >= adminLoginMaxFailures) {
        state.lockedUntil = now + adminLoginLockDurationMs;
      }
      if (!data.adminLoginFailures.includes(state)) {
        data.adminLoginFailures.push(state);
      }
      return state;
    });
  }

  function clearAdminLoginFailure(lockKey) {
    store.update((data) => {
      data.adminLoginFailures = (data.adminLoginFailures || []).filter((item) => item.key !== lockKey);
      return true;
    });
  }

  function hashAdminToken(token) {
    return createHash('sha256').update(`admin-session:${token}`).digest('hex');
  }

  function saveAdminSession(token, adminUserId, expiresAt) {
    const tokenHash = hashAdminToken(token);
    store.update((data) => {
      data.adminSessions = Array.isArray(data.adminSessions) ? data.adminSessions : [];
      data.adminSessions = data.adminSessions.filter((item) => (
        item.tokenHash !== tokenHash && item.expiresAt > Date.now()
      ));
      data.adminSessions.push({ tokenHash, adminUserId, expiresAt });
      return { tokenHash, adminUserId, expiresAt };
    });
  }

  function requireAdmin(request, requiredPermission) {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请重新登录管理端');

    const tokenHash = hashAdminToken(token);
    const data = store.read();
    const session = (data.adminSessions || []).find((item) => item.tokenHash === tokenHash);
    const user = session ? (data.adminUsers || []).find((item) => item.id === session.adminUserId) : null;
    if (!session || !user) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请重新登录管理端');

    if (user.status !== 'ACTIVE' || session.expiresAt <= Date.now()) {
      store.update((state) => {
        state.adminSessions = (state.adminSessions || []).filter((item) => item.tokenHash !== tokenHash);
        return true;
      });
      throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请重新登录管理端');
    }

    if (requiredPermission) {
      const permissions = adminRolePermissions[user.role] || [];
      if (!permissions.includes('*') && !permissions.includes(requiredPermission)) {
        throw new ApiError(403, 'ADMIN_FORBIDDEN', '当前管理员角色无权执行该操作');
      }
    }

    return {
      id: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      expiresAt: session.expiresAt
    };
  }

  function loadWeChatIdentity(data, userId) {
    if (userWeChatIdentities.has(userId)) return userWeChatIdentities.get(userId);
    const saved = data.userOpenIds?.[userId];
    if (saved) userWeChatIdentities.set(userId, saved);
    return saved || '';
  }

  function saveWeChatIdentity(data, userId, openid) {
    if (!openid) return;
    userWeChatIdentities.set(userId, openid);
    data.userOpenIds = data.userOpenIds || {};
    data.userOpenIds[userId] = openid;
  }

  function requireUser(request) {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = token ? userSessions.get(token) : null;
    if (!session || session.expiresAt < Date.now()) throw new ApiError(401, 'USER_UNAUTHORIZED', '请先使用微信登录');
    return session;
  }
  const uploadsDirectory = path.join(path.dirname(store.filePath), 'uploads');
  const statusLabels = {
    PENDING_PAYMENT:'\u5f85\u652f\u4ed8',
    PAID:'已支付，待配送', FULFILLING:'配送中', COMPLETED:'已完成', CANCELLED:'已取消', AFTER_SALE:'售后中',
    PENDING_REALNAME:'待实名激活', ACTIVATED:'已激活', REJECTED:'未通过',
    PENDING_CREDIT:'待到账', CREDITED:'已到账',
    PENDING_VERIFY:'待核验', APPROVED:'可预约安装',
    MATERIAL_PENDING:'待补材料', REVIEWING:'审核中'
  };
  function addAudit(data, action, target, operator = '运营管理员') {
    if (!Array.isArray(data.auditLogs)) data.auditLogs = [];
    data.auditLogs.unshift({ id: `log_${randomUUID()}`, operator, action, target, createdAt: new Date().toISOString() });
    data.auditLogs = data.auditLogs.slice(0, 200);
  }

  function addNotification(data, userId, type, title, content, metadata = null) {
    if (!userId) return null;
    if (!Array.isArray(data.notifications)) data.notifications = [];
    const notification = {
      id: `ntf_${randomUUID()}`,
      userId,
      type,
      title: String(title).slice(0, 80),
      content: String(content).slice(0, 300),
      read: false,
      createdAt: new Date().toISOString(),
      ...(metadata ? { metadata } : {})
    };
    data.notifications.unshift(notification);
    data.notifications = data.notifications.slice(0, 500);
    return notification;
  }

  function sendScoreNotification(data, userId, templateKey, title, content, now = new Date().toISOString(), notificationType = 'SCORE', metadata = null) {
    const notification = addNotification(data, userId, notificationType, title, content);
    if (!notification) return null;
    if (!(data.serviceMessageSubscribers || []).includes(userId)) return { notification, subscribeMessage: null };
    if (!Array.isArray(data.subscribeMessages)) data.subscribeMessages = [];
    data.subscribeMessages.unshift({
      id: `sub_${randomUUID()}`,
      userId,
      templateId: scoreNotificationTemplates[templateKey]?.id || templateKey,
      page: subscribeMessagePage(notificationType, metadata, true) || undefined,
      status: 'QUEUED',
      title,
      content,
      error: '',
      createdAt: now,
      sentAt: ''
    });
    data.subscribeMessages = data.subscribeMessages.slice(0, 300);
    return { notification, subscribeMessage: data.subscribeMessages[0] };
  }

  function subscribeMessagePage(notificationType, metadata, isMerchantMessage) {
    if (isMerchantMessage) return merchantNotificationLink({ type: notificationType, metadata });
    if ((notificationType === 'ORDER' || notificationType === 'AFTER_SALE') && metadata?.orderId) {
      return `/pages/orders/orders?focusId=${encodeURIComponent(String(metadata.orderId))}`;
    }
    if (metadata?.focusId) {
      return `/pages/orders/orders?focusId=${encodeURIComponent(String(metadata.focusId))}`;
    }
    return '';
  }

  function sendOrderNotification(data, userId, templateKey, title, content, now = new Date().toISOString(), metadata = null) {
    const notification = addNotification(data, userId, templateKey === 'AFTER_SALE' ? 'AFTER_SALE' : 'ORDER', title, content, metadata);
    if (!notification) return null;
    if (!Array.isArray(data.subscribeMessages)) data.subscribeMessages = [];
    data.subscribeMessages.unshift({
      id: `sub_${randomUUID()}`,
      userId,
      templateId: orderNotificationTemplates[templateKey]?.id || templateKey,
      page: subscribeMessagePage(templateKey === 'AFTER_SALE' ? 'AFTER_SALE' : 'ORDER', metadata, false) || undefined,
      status: 'QUEUED',
      title,
      content,
      error: '',
      createdAt: now,
      sentAt: ''
    });
    data.subscribeMessages = data.subscribeMessages.slice(0, 500);
    return { notification, subscribeMessage: data.subscribeMessages[0] };
  }

  function sendLeadFollowUpNotification(data, userId, notificationType, title, content, now = new Date().toISOString(), metadata = null) {
    const notification = addNotification(data, userId, notificationType, title, content, metadata);
    if (!notification) return null;
    if (!(data.orderMessageSubscribers || []).includes(userId)) return { notification, subscribeMessage: null };
    if (!Array.isArray(data.subscribeMessages)) data.subscribeMessages = [];
    data.subscribeMessages.unshift({
      id: `sub_${randomUUID()}`,
      userId,
      templateId: orderNotificationTemplates.LEAD_FOLLOW_UP.id,
      page: subscribeMessagePage('LEAD_FOLLOW_UP', metadata, false) || undefined,
      status: 'QUEUED',
      title,
      content,
      error: '',
      createdAt: now,
      sentAt: ''
    });
    data.subscribeMessages = data.subscribeMessages.slice(0, 500);
    return { notification, subscribeMessage: data.subscribeMessages[0] };
  }

  function sendFavoritePriceDropNotification(data, userId, product, promotion, now = new Date().toISOString()) {
    if (!product || !promotion) return null;
    const savedInCents = Math.max(0, Number(promotion.originalPriceInCents || 0) - Number(promotion.salePriceInCents || 0));
    const title = '收藏商品降价';
    const content = `「${product.name}」开始限时特价 ¥${(Number(promotion.salePriceInCents) / 100).toFixed(2).replace(/\.00$/, '')}，较原价节省 ¥${(savedInCents / 100).toFixed(2).replace(/\.00$/, '')}，库存有限先到先得。`;
    const notification = addNotification(data, userId, 'PROMOTION', title, content, { productId: product.id });
    if (!notification) return null;
    if (!Array.isArray(data.subscribeMessages)) data.subscribeMessages = [];
    data.subscribeMessages.unshift({
      id: `sub_${randomUUID()}`,
      userId,
      templateId: 'favorite_price_notice',
      page: 'pages/detail/detail',
      status: 'QUEUED',
      title,
      content,
      error: '',
      createdAt: now,
      sentAt: ''
    });
    data.subscribeMessages = data.subscribeMessages.slice(0, 500);
    return { notification, subscribeMessage: data.subscribeMessages[0] };
  }

  function notifyMerchant(data, merchantId, type, title, content, metadata = null) {
    const merchant = (data.merchants || []).find((item) => item.id === merchantId);
    return addNotification(data, merchant?.userId, type, title, content, metadata);
  }

  function notifyRestockSubscribers(data, product, merchantName = '', now = new Date().toISOString()) {
    if (!product || Number(product.stock || 0) <= 0 || product.active === false) return [];
    const waiting = (data.productRestockAlerts || []).filter((item) => (
      item.productId === product.id && item.status === 'WAITING'
    ));
    for (const item of waiting) {
      sendOrderNotification(
        data,
        item.userId,
        'RESTOCK_NOTICE',
        '你登记的商品已到货',
        `「${product.name}」已补货上架${merchantName ? `，来自 ${merchantName}` : ''}，先到先得。`,
        now,
        { productId: product.id }
      );
      item.status = 'NOTIFIED';
      item.notifiedAt = now;
      item.updatedAt = now;
    }
    return waiting;
  }

  function notifyFavoriteRestockSubscribers(data, product, merchantName = '', now = new Date().toISOString()) {
    if (!product || product.active === false || availableStock(product) <= 0) return [];
    const registeredUserIds = new Set((data.productRestockAlerts || [])
      .filter((item) => item.productId === product.id && item.status === 'WAITING')
      .map((item) => item.userId));
    const favorites = (data.productFavorites || []).filter((item) => (
      item.productId === product.id
      && !registeredUserIds.has(item.userId)
      && item.lastRestockNoticeAt !== product.lastFavoriteRestockNoticeAt
    ));
    for (const favorite of favorites) {
      const title = '收藏商品已补货';
      const content = `你收藏的「${product.name}」已重新有货${merchantName ? `，来自 ${merchantName}` : ''}，先到先得。`;
      const notification = addNotification(data, favorite.userId, 'PROMOTION', title, content, { productId: product.id });
      if (!notification) continue;
      if (!Array.isArray(data.subscribeMessages)) data.subscribeMessages = [];
      data.subscribeMessages.unshift({
        id: `sub_${randomUUID()}`,
        userId: favorite.userId,
        templateId: 'restock_notice',
        page: 'pages/detail/detail',
        status: 'QUEUED',
        title,
        content,
        error: '',
        createdAt: now,
        sentAt: ''
      });
      data.subscribeMessages = data.subscribeMessages.slice(0, 500);
      favorite.lastRestockNoticeAt = now;
    }
    if (favorites.length) product.lastFavoriteRestockNoticeAt = now;
    return favorites;
  }


  function notifyMerchantScore(data, merchantId, templateKey, title, content, now = new Date().toISOString()) {
    const merchant = (data.merchants || []).find((item) => item.id === merchantId);
    return sendScoreNotification(data, merchant?.userId, templateKey, title, content, now);
  }

  function notifyOrderMerchant(data, order, type, title, content) {
    const product = (data.products || []).find((item) => item.id === order.items?.[0]?.productId);
    return notifyMerchant(data, order.collaboration?.merchantId || order.items?.[0]?.merchantId || product?.merchantId || '', type, title, content, { orderId: order.id });
  }

  function addFinanceEvent(data, eventType, referenceId, amountInCents, meta = {}, now = new Date().toISOString()) {
    if (!Array.isArray(data.financeEvents)) data.financeEvents = [];
    const key = `${eventType}:${referenceId}`;
    if (data.financeEvents.some((event) => `${event.eventType}:${event.referenceId}` === key)) return null;
    const event = {
      id: `fin_${randomUUID()}`,
      eventType,
      referenceId,
      amountInCents: Number(amountInCents) || 0,
      userId: meta.userId || '',
      paymentNo: meta.paymentNo || '',
      orderNo: meta.orderNo || '',
      merchantId: meta.merchantId || '',
      merchantName: meta.merchantName || '',
      settlementReference: meta.settlementReference || '',
      receiptUrl: meta.receiptUrl || '',
      businessType: meta.businessType || '',
      createdAt: now
    };
    data.financeEvents.unshift(event);
    data.financeEvents = data.financeEvents.slice(0, 5000);
    return event;
  }

  function createSettlements(data, order, now) {
    if (!Array.isArray(data.settlements)) data.settlements = [];
    if (!order?.id || data.settlements.some((item) => item.orderId === order.id)) return [];
    const configuredRate = Number(data.adminSettings?.commissionRatePercent);
    const commissionRatePercent = Number.isInteger(configuredRate) && configuredRate >= 0 && configuredRate <= 50 ? configuredRate : 2;
    const grouped = new Map();
    for (const item of order.items || []) {
      const merchantId = item.merchantId || '';
      if (!merchantId) continue;
      const gross = Number(item.subtotalInCents || (Number(item.priceInCents || 0) * Number(item.quantity || 0)));
      if (!Number.isFinite(gross) || gross <= 0) continue;
      const settlement = grouped.get(merchantId) || {
        id: `stl_${randomUUID()}`,
        paymentId: order.paymentOrderId || '',
        orderId: order.id,
        orderNo: order.orderNo || '',
        merchantId,
        amountInCents: 0,
        commissionRatePercent,
        platformFeeInCents: 0,
        // 支付成功只是资金在途，必须等交付核验通过并过完账期才可打款。
        settlementStatus: 'PENDING_DELIVERY',
        deliveredAt: '',
        availableAt: '',
        settlementPeriodDays: settlementPeriodDays(data),
        statusBeforeFreeze: '',
        frozenReason: '',
        createdAt: now,
        updatedAt: now,
        refundedAt: ''
      };
      const platformFee = Math.round(gross * commissionRatePercent / 100);
      settlement.amountInCents += gross;
      settlement.platformFeeInCents += platformFee;
      grouped.set(merchantId, settlement);
    }
    const created = [...grouped.values()];
    for (const settlement of created) {
      settlement.payableAmountInCents = settlement.amountInCents - settlement.platformFeeInCents;
      data.settlements.unshift(settlement);
    }
    return created;
  }

  function settlementPeriodDays(data) {
    const value = Number(data?.adminSettings?.settlementPeriodDays);
    return Number.isInteger(value) && value >= 0 && value <= 60 ? value : 7;
  }

  // 交付核验通过后开始计算账期；账期为 0 天时立即可结算。
  function activateOrderSettlements(data, order, now) {
    if (!order?.id || !Array.isArray(data.settlements)) return [];
    const days = settlementPeriodDays(data);
    const touched = [];
    for (const settlement of data.settlements) {
      if (settlement.orderId !== order.id) continue;
      if (['SETTLED', 'REFUNDED'].includes(settlement.settlementStatus)) continue;
      // 已经开始计算账期的分账不重置到期时间，避免售后关闭后账期被无故延长。
      const availableAt = settlement.availableAt || new Date(new Date(now).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
      settlement.deliveredAt = settlement.deliveredAt || now;
      settlement.availableAt = availableAt;
      settlement.settlementPeriodDays = settlement.deliveredAt === now ? days : (settlement.settlementPeriodDays ?? days);
      settlement.settlementStatus = availableAt <= now ? 'PENDING_SETTLE' : 'IN_ACCOUNT_PERIOD';
      settlement.statusBeforeFreeze = '';
      settlement.frozenReason = '';
      settlement.updatedAt = now;
      touched.push(settlement);
    }
    return touched;
  }

  // 订单进入售后时冻结分账，避免钱已打款但商品要退回。
  function freezeOrderSettlements(data, order, now, reason) {
    if (!order?.id || !Array.isArray(data.settlements)) return [];
    const frozen = [];
    const affectedPayoutRequests = new Set();
    for (const settlement of data.settlements) {
      if (settlement.orderId !== order.id) continue;
      if (!['PENDING_DELIVERY', 'IN_ACCOUNT_PERIOD', 'PENDING_SETTLE', 'PAYOUT_REQUESTED'].includes(settlement.settlementStatus)) continue;
      if (settlement.payoutRequestId) affectedPayoutRequests.add(settlement.payoutRequestId);
      settlement.statusBeforeFreeze = settlement.settlementStatus;
      settlement.settlementStatus = 'FROZEN';
      settlement.frozenReason = String(reason || '售后处理中').slice(0, 120);
      settlement.updatedAt = now;
      frozen.push(settlement);
    }
    for (const payoutRequestId of affectedPayoutRequests) {
      syncPayoutRequest(data, payoutRequestId, now, '关联订单进入售后，提现申请已自动关闭');
    }
    return frozen;
  }

  function unfreezeOrderSettlements(data, order, now) {
    if (!order?.id || !Array.isArray(data.settlements)) return [];
    const restored = [];
    for (const settlement of data.settlements) {
      if (settlement.orderId !== order.id || settlement.settlementStatus !== 'FROZEN') continue;
      const previous = settlement.statusBeforeFreeze || 'PENDING_DELIVERY';
      settlement.settlementStatus = previous === 'PENDING_DELIVERY'
        ? 'PENDING_DELIVERY'
        : (settlement.availableAt && settlement.availableAt <= now ? 'PENDING_SETTLE' : 'IN_ACCOUNT_PERIOD');
      settlement.statusBeforeFreeze = '';
      settlement.frozenReason = '';
      settlement.payoutRequestId = '';
      settlement.updatedAt = now;
      restored.push(settlement);
    }
    return restored;
  }

  function releaseMaturedSettlements(data, now = new Date().toISOString()) {
    const released = [];
    for (const settlement of data.settlements || []) {
      if (settlement.settlementStatus !== 'IN_ACCOUNT_PERIOD') continue;
      if (!settlement.availableAt || settlement.availableAt > now) continue;
      settlement.settlementStatus = 'PENDING_SETTLE';
      settlement.updatedAt = now;
      released.push(settlement.id);
    }
    return released;
  }

  function sweepMaturedSettlements() {
    const snapshot = store.read();
    const now = new Date().toISOString();
    const hasMatured = (snapshot.settlements || []).some((item) => item.settlementStatus === 'IN_ACCOUNT_PERIOD' && item.availableAt && item.availableAt <= now);
    if (!hasMatured) return [];
    return store.update((data) => releaseMaturedSettlements(data, new Date().toISOString()));
  }

  function settlementSummary(settlements) {
    const sum = (status) => settlements
      .filter((item) => item.settlementStatus === status)
      .reduce((total, item) => total + (item.payableAmountInCents || 0), 0);
    return {
      pendingDeliveryInCents: sum('PENDING_DELIVERY'),
      inAccountPeriodInCents: sum('IN_ACCOUNT_PERIOD'),
      frozenInCents: sum('FROZEN'),
      payableInCents: sum('PENDING_SETTLE'),
      payoutRequestedInCents: sum('PAYOUT_REQUESTED'),
      settledInCents: sum('SETTLED'),
      refundedInCents: sum('REFUNDED')
    };
  }

  function merchantStatementStatuses(data) {
    return {
      ...statusLabels,
      PENDING_SETTLE: '待结算',
      PAYOUT_REQUESTED: '提现待审核',
      SETTLED: '已结算',
      REFUNDED: '已冲销'
    };
  }

  function buildMerchantStatement(data, merchant, monthInput = '') {
    const month = /^\d{4}-\d{2}$/.test(monthInput) ? monthInput : new Date().toISOString().slice(0, 7);
    const [year, monthNumber] = month.split('-').map(Number);
    const startDateIso = new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString();
    const endDate = new Date(Date.UTC(year, monthNumber, 1)).toISOString();
    const statusMap = merchantStatementStatuses(data);
    const settlements = (data.settlements || [])
      .filter((item) => item.merchantId === merchant.id
        && item.createdAt >= startDateIso
        && item.createdAt < endDate)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const payouts = (data.payoutRequests || [])
      .filter((item) => item.merchantId === merchant.id
        && item.createdAt >= startDateIso
        && item.createdAt < endDate)
      .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const refundInCents = settlements
      .filter((item) => item.settlementStatus === 'REFUNDED')
      .reduce((sum, item) => sum + (item.payableAmountInCents || 0), 0);
    const businessGrossInCents = settlements
      .filter((item) => item.settlementStatus !== 'REFUNDED')
      .reduce((sum, item) => sum + (item.amountInCents || 0), 0);
    const commissionInCents = settlements
      .filter((item) => item.settlementStatus !== 'REFUNDED')
      .reduce((sum, item) => sum + (item.platformFeeInCents || 0), 0);
    const businessPayableInCents = settlements
      .filter((item) => item.settlementStatus !== 'REFUNDED')
      .reduce((sum, item) => sum + (item.payableAmountInCents || 0), 0);
    const payoutPaidInCents = payouts
      .filter((item) => item.status === 'SETTLED')
      .reduce((sum, item) => sum + (item.paidAmountInCents || item.amountInCents || 0), 0);
    return {
      month,
      generatedAt: new Date().toISOString(),
      merchant: { id: merchant.id, name: merchant.name },
      settlements: settlements.map((item) => ({
        id: item.id,
        settlementNo: item.id,
        orderNo: item.orderNo,
        status: item.settlementStatus,
        statusLabel: statusMap[item.settlementStatus] || item.settlementStatus,
        amountInCents: item.amountInCents || 0,
        commissionRatePercent: item.commissionRatePercent || 0,
        platformFeeInCents: item.platformFeeInCents || 0,
        payableInCents: item.payableAmountInCents || 0,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        availableAt: item.availableAt || '',
        settlementReference: item.settlementReference || ''
      })),
      payouts: payouts.map((item) => ({
        id: item.id,
        requestNo: item.requestNo,
        status: item.status,
        statusLabel: ({ PENDING_REVIEW: '待审核', SETTLED: '已打款', REJECTED: '已驳回', CANCELLED: '已关闭' })[item.status] || item.status,
        amountInCents: item.amountInCents || 0,
        paidAmountInCents: item.paidAmountInCents || 0,
        settlementCount: item.settlementCount || 0,
        settlementReference: item.settlementReference || '',
        remark: item.remark || '',
        createdAt: item.createdAt,
        reviewedAt: item.reviewedAt || ''
      })),
      totals: {
        businessGrossInCents,
        commissionInCents,
        businessPayableInCents,
        refundInCents,
        payoutPaidInCents,
        netInCents: businessPayableInCents - refundInCents - payoutPaidInCents
      }
    };
  }

  function payoutMinimumInCents(data) {
    const value = Number(data?.adminSettings?.payoutMinimumInCents);
    return Number.isInteger(value) && value >= 0 && value <= 1000000 ? value : 10000;
  }

  // 商家提现走「申请 → 平台审核 → 打款/驳回」，避免商家自己给自己确认打款。
  function createPayoutRequest(data, merchant, now, remark) {
    if (!Array.isArray(data.payoutRequests)) data.payoutRequests = [];
    if (!merchant.settlementAccountName || !merchant.settlementBank || !merchant.settlementAccount) {
      throw new ApiError(409, 'SETTLEMENT_ACCOUNT_INCOMPLETE', '请先补全收款账户资料再申请提现');
    }
    const pendingRequest = data.payoutRequests.find((item) => item.merchantId === merchant.id && item.status === 'PENDING_REVIEW');
    if (pendingRequest) throw new ApiError(409, 'PAYOUT_REQUEST_EXISTS', `已有提现申请 ${pendingRequest.requestNo} 正在审核，请等待平台处理`);
    releaseMaturedSettlements(data, now);
    const settlements = (data.settlements || []).filter((item) => item.merchantId === merchant.id && item.settlementStatus === 'PENDING_SETTLE');
    if (!settlements.length) {
      const blocked = (data.settlements || []).filter((item) => item.merchantId === merchant.id && ['PENDING_DELIVERY', 'IN_ACCOUNT_PERIOD', 'FROZEN'].includes(item.settlementStatus));
      const reasons = {
        PENDING_DELIVERY: '订单尚未完成交付核验',
        IN_ACCOUNT_PERIOD: '账期未到期',
        FROZEN: '存在售后冻结的分账'
      };
      const detail = [...new Set(blocked.map((item) => reasons[item.settlementStatus]))].join('、');
      throw new ApiError(409, 'SETTLEMENT_NOT_RELEASED', detail ? `暂无可提现金额：${detail}` : '暂无可提现金额');
    }
    const amountInCents = settlements.reduce((total, item) => total + (item.payableAmountInCents || 0), 0);
    const minimum = payoutMinimumInCents(data);
    if (amountInCents < minimum) {
      throw new ApiError(409, 'PAYOUT_BELOW_MINIMUM', `可提现金额 ¥${(amountInCents / 100).toFixed(2)} 低于起提金额 ¥${(minimum / 100).toFixed(2)}`);
    }
    const requestId = `pyo_${randomUUID()}`;
    for (const settlement of settlements) {
      settlement.settlementStatus = 'PAYOUT_REQUESTED';
      settlement.payoutRequestId = requestId;
      settlement.updatedAt = now;
    }
    const payoutRequest = {
      id: requestId,
      requestNo: `PO${Date.now().toString().slice(-10)}`,
      merchantId: merchant.id,
      merchantName: merchant.name,
      amountInCents,
      settlementCount: settlements.length,
      settlementIds: settlements.map((item) => item.id),
      status: 'PENDING_REVIEW',
      accountName: merchant.settlementAccountName,
      accountBank: merchant.settlementBank,
      accountMasked: `${merchant.settlementAccount.slice(0, 4)} **** ${merchant.settlementAccount.slice(-4)}`,
      remark: String(remark || '').slice(0, 200),
      reviewNote: '',
      settlementReference: '',
      reviewedAt: '',
      createdAt: now,
      updatedAt: now
    };
    data.payoutRequests.unshift(payoutRequest);
    addAudit(data, '商家提交提现申请', `${merchant.name} ${payoutRequest.requestNo}`);
    notifyMerchant(data, merchant.id, 'SETTLEMENT', '提现申请已提交', `提现单 ${payoutRequest.requestNo} 合计 ¥${(amountInCents / 100).toFixed(2)}，平台审核通过后打款到 ${payoutRequest.accountBank} ${payoutRequest.accountMasked}。`);
    return payoutRequest;
  }

  function payoutRequestSettlements(data, payoutRequest) {
    const ids = new Set(payoutRequest.settlementIds || []);
    return (data.settlements || []).filter((item) => ids.has(item.id) || item.payoutRequestId === payoutRequest.id);
  }

  // 提现申请里的分账被冻结或退款时，申请金额已不成立，整单退回并让商家重新申请。
  function syncPayoutRequest(data, payoutRequestId, now, reason) {
    const payoutRequest = (data.payoutRequests || []).find((item) => item.id === payoutRequestId);
    if (!payoutRequest || payoutRequest.status !== 'PENDING_REVIEW') return null;
    const settlements = payoutRequestSettlements(data, payoutRequest);
    if (settlements.every((item) => item.settlementStatus === 'PAYOUT_REQUESTED')) return null;
    for (const settlement of settlements) {
      if (settlement.settlementStatus !== 'PAYOUT_REQUESTED') continue;
      settlement.settlementStatus = 'PENDING_SETTLE';
      settlement.payoutRequestId = '';
      settlement.updatedAt = now;
    }
    payoutRequest.status = 'CANCELLED';
    payoutRequest.reviewNote = reason;
    payoutRequest.reviewedAt = now;
    payoutRequest.updatedAt = now;
    addAudit(data, '提现申请自动关闭', `${payoutRequest.merchantName} ${payoutRequest.requestNo}`);
    notifyMerchant(data, payoutRequest.merchantId, 'SETTLEMENT', '提现申请已关闭', `提现单 ${payoutRequest.requestNo} ${reason}，未受影响的金额已退回可结算余额，可重新申请。`);
    return payoutRequest;
  }

  function approvePayoutRequest(data, payoutRequest, now, reference) {
    const settlements = payoutRequestSettlements(data, payoutRequest).filter((item) => item.settlementStatus === 'PAYOUT_REQUESTED');
    if (!settlements.length) throw new ApiError(409, 'PAYOUT_REQUEST_EMPTY', '该提现申请没有待打款的分账，可能已被退款或处理');
    let totalInCents = 0;
    for (const settlement of settlements) {
      settlement.settlementStatus = 'SETTLED';
      settlement.settledAt = now;
      settlement.settlementReference = reference;
      settlement.updatedAt = now;
      totalInCents += settlement.payableAmountInCents || 0;
    }
    payoutRequest.status = 'SETTLED';
    payoutRequest.settlementReference = reference;
    payoutRequest.paidAmountInCents = totalInCents;
    payoutRequest.reviewedAt = now;
    payoutRequest.updatedAt = now;
    addFinanceEvent(data, 'PAYOUT', `PAYOUT_${payoutRequest.requestNo}`, -totalInCents, {
      merchantId: payoutRequest.merchantId, merchantName: payoutRequest.merchantName, settlementReference: reference,
      receiptUrl: payoutRequest.receiptUrl
    }, now);
    addAudit(data, '平台确认提现打款', `${payoutRequest.merchantName} ${payoutRequest.requestNo}`);
    notifyMerchant(data, payoutRequest.merchantId, 'SETTLEMENT', '提现已打款', `提现单 ${payoutRequest.requestNo} 已打款 ¥${(totalInCents / 100).toFixed(2)}，凭证 ${reference}。`);
    return totalInCents;
  }

  function rejectPayoutRequest(data, payoutRequest, now, reviewNote) {
    const settlements = payoutRequestSettlements(data, payoutRequest).filter((item) => item.settlementStatus === 'PAYOUT_REQUESTED');
    for (const settlement of settlements) {
      settlement.settlementStatus = 'PENDING_SETTLE';
      settlement.payoutRequestId = '';
      settlement.updatedAt = now;
    }
    payoutRequest.status = 'REJECTED';
    payoutRequest.reviewNote = reviewNote;
    payoutRequest.reviewedAt = now;
    payoutRequest.updatedAt = now;
    addAudit(data, '平台驳回提现申请', `${payoutRequest.merchantName} ${payoutRequest.requestNo}`);
    notifyMerchant(data, payoutRequest.merchantId, 'SETTLEMENT', '提现申请被驳回', `提现单 ${payoutRequest.requestNo} 未通过审核：${reviewNote}。金额已退回可结算余额。`);
    return settlements.length;
  }

  function markSettlementsRefunded(data, orderId, now) {
    if (!orderId || !Array.isArray(data.settlements)) return;
    const affectedPayoutRequests = new Set();
    for (const settlement of data.settlements) {
      if (settlement.orderId !== orderId || settlement.settlementStatus === 'REFUNDED') continue;
      if (settlement.payoutRequestId) affectedPayoutRequests.add(settlement.payoutRequestId);
      settlement.settlementStatus = 'REFUNDED';
      settlement.updatedAt = now;
      settlement.refundedAt = now;
      settlement.statusBeforeFreeze = '';
      settlement.frozenReason = '';
    }
    for (const payoutRequestId of affectedPayoutRequests) {
      syncPayoutRequest(data, payoutRequestId, now, '关联订单已退款，提现申请已自动关闭');
    }
  }

  function settleMerchant(data, merchantId, now, reference) {
    if (!Array.isArray(data.settlements)) throw new ApiError(404, 'SETTLEMENT_NOT_FOUND', 'Settlement record not found');
    releaseMaturedSettlements(data, now);
    const settlements = data.settlements.filter((item) => item.merchantId === merchantId && item.settlementStatus === 'PENDING_SETTLE');
    if (!settlements.length) {
      const requested = data.settlements.filter((item) => item.merchantId === merchantId && item.settlementStatus === 'PAYOUT_REQUESTED');
      if (requested.length) {
        throw new ApiError(409, 'PAYOUT_REQUEST_PENDING', '该商家已提交提现申请，请到「商家提现」页审核后打款');
      }
      const blocked = data.settlements.filter((item) => item.merchantId === merchantId && ['PENDING_DELIVERY', 'IN_ACCOUNT_PERIOD', 'FROZEN'].includes(item.settlementStatus));
      if (blocked.length) {
        const reasons = {
          PENDING_DELIVERY: '订单尚未完成交付核验',
          IN_ACCOUNT_PERIOD: '账期未到期',
          FROZEN: '存在售后冻结的分账'
        };
        const detail = [...new Set(blocked.map((item) => reasons[item.settlementStatus]))].join('、');
        throw new ApiError(409, 'SETTLEMENT_NOT_RELEASED', `暂无可结算金额：${detail}`);
      }
      throw new ApiError(404, 'PENDING_SETTLEMENT_NOT_FOUND', 'No pending settlement');
    }
    let totalInCents = 0;
    for (const settlement of settlements) {
      settlement.settlementStatus = 'SETTLED';
      settlement.settledAt = now;
      settlement.settlementReference = reference;
      settlement.updatedAt = now;
      totalInCents += settlement.payableAmountInCents || 0;
    }
    recordPlatformPayout(data, merchantId, settlements, totalInCents, now, reference);
    return totalInCents;
  }

  // 平台主动打款也写一条提现单，保证所有出款都有统一的资金台账。
  function recordPlatformPayout(data, merchantId, settlements, totalInCents, now, reference) {
    if (!Array.isArray(data.payoutRequests)) data.payoutRequests = [];
    const merchant = (data.merchants || []).find((item) => item.id === merchantId);
    data.payoutRequests.unshift({
      id: `pyo_${randomUUID()}`,
      requestNo: `PO${Date.now().toString().slice(-10)}`,
      merchantId,
      merchantName: merchant?.name || '',
      amountInCents: totalInCents,
      paidAmountInCents: totalInCents,
      settlementCount: settlements.length,
      settlementIds: settlements.map((item) => item.id),
      status: 'SETTLED',
      initiatedBy: 'PLATFORM',
      accountName: merchant?.settlementAccountName || '',
      accountBank: merchant?.settlementBank || '',
      accountMasked: merchant?.settlementAccount ? `${merchant.settlementAccount.slice(0, 4)} **** ${merchant.settlementAccount.slice(-4)}` : '',
      remark: '平台主动打款',
      reviewNote: '',
      settlementReference: reference,
      reviewedAt: now,
      createdAt: now,
      updatedAt: now
    });
  }

  function applyOrderRefund(data, order, now) {
    const paymentOrder = (data.paymentOrders || []).find((item) => item.id === order.paymentOrderId);
    if (paymentOrder && paymentOrder.status === 'PAID') {
      paymentOrder.status = 'REFUNDED';
      paymentOrder.refundedAt = now;
      paymentOrder.updatedAt = now;
    }
    order.status = 'CANCELLED';
    order.paymentStatus = 'REFUNDED';
    order.updatedAt = now;
    restoreOrderStock(data, order);
    markSettlementsRefunded(data, order.id, now);
    if (paymentOrder) {
      addFinanceEvent(data, 'REFUND', `REFUND_${paymentOrder.id}`, -(paymentOrder.amountInCents || 0), {
        userId: order.userId, paymentNo: paymentOrder.paymentNo, orderNo: order.orderNo, businessType: 'ORDER'
      }, now);
    }
    addAudit(data, '\u552e\u540e\u9000\u6b3e\u5b8c\u6210', order.orderNo);
    addNotification(data, order.userId, 'ORDER', '\u8ba2\u5355\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${order.orderNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`, { focusId: order.id });
    return paymentOrder;
  }

  function requireMerchant(request) {
    const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const session = merchantSessions.get(token);
    if (!session || session.expiresAt < Date.now()) throw new ApiError(401, 'MERCHANT_UNAUTHORIZED', '请重新登录商家工作台');
    return session;
  }

  // 待支付订单超时后自动关闭并释放库存，让库存回到真实可售状态。
  function expirePendingOrders(data, now = new Date().toISOString()) {
    const timeoutMinutes = Number(data.adminSettings?.paymentTimeoutMinutes || 30);
    const expired = [];
    for (const order of data.orders || []) {
      if (order.status !== 'PENDING_PAYMENT') continue;
      const dueAt = order.paymentExpiresAt || new Date(new Date(order.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString();
      if (dueAt > now) continue;
      order.status = 'CANCELLED';
      order.paymentStatus = 'EXPIRED';
      order.cancelReason = 'PAYMENT_TIMEOUT';
      order.updatedAt = now;
      releaseOrderStock(data, order);
      const paymentOrder = (data.paymentOrders || []).find((item) => item.id === order.paymentOrderId);
      if (paymentOrder && paymentOrder.status === 'PENDING') {
        paymentOrder.status = 'CANCELLED';
        paymentOrder.providerCloseStatus = 'PENDING';
        paymentOrder.providerCloseRequestedAt = now;
        paymentOrder.providerCloseError = '';
        paymentOrder.updatedAt = now;
      }
      addAudit(data, '待支付订单超时自动关闭', order.orderNo);
      addNotification(data, order.userId, 'ORDER', '订单已超时关闭', `订单 ${order.orderNo} 超过 ${timeoutMinutes} 分钟未支付，已自动关闭并释放库存。`, { focusId: order.id });
      expired.push(order.orderNo);
    }

    const serviceTimeoutTargets = [
      { collection: 'phoneCardOrders', type: 'PHONE_PLAN', label: '电话卡订单' },
      { collection: 'rechargeOrders', type: 'RECHARGE', label: '话费权益订单' },
      { collection: 'plateApplications', type: 'PLATE', label: '校园牌照申请' }
    ];
    for (const target of serviceTimeoutTargets) {
      for (const record of data[target.collection] || []) {
        if (record.status !== 'PENDING_PAYMENT') continue;
        const dueAt = record.paymentExpiresAt
          || new Date(new Date(record.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString();
        if (dueAt > now) continue;
        record.status = 'CANCELLED';
        record.paymentStatus = 'EXPIRED';
        record.cancelReason = 'PAYMENT_TIMEOUT';
        record.updatedAt = now;
        const paymentOrder = (data.paymentOrders || []).find((item) => item.id === record.paymentOrderId);
        if (paymentOrder && paymentOrder.status === 'PENDING') {
          paymentOrder.status = 'CANCELLED';
          paymentOrder.providerCloseStatus = 'PENDING';
          paymentOrder.providerCloseRequestedAt = now;
          paymentOrder.providerCloseError = '';
          paymentOrder.updatedAt = now;
        }
        addAudit(data, `${target.label}超时自动关闭`, record.id);
        addNotification(
          data,
          record.userId,
          target.type,
          `${target.label}已超时关闭`,
          `超过 ${timeoutMinutes} 分钟未支付，已自动关闭。如仍需办理，请重新下单。`
        );
        expired.push(record.id);
      }
    }
    return expired;
  }

  async function sweepExpiredOrders() {
    const snapshot = store.read();
    const now = new Date().toISOString();
    const timeoutMinutes = Number(snapshot.adminSettings?.paymentTimeoutMinutes || 30);
    const hasExpired = (snapshot.orders || []).some((order) => {
      if (order.status !== 'PENDING_PAYMENT') return false;
      const dueAt = order.paymentExpiresAt || new Date(new Date(order.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString();
      return dueAt <= now;
    })
      || (snapshot.phoneCardOrders || []).some((item) => item.status === 'PENDING_PAYMENT'
        && (item.paymentExpiresAt || new Date(new Date(item.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString()) <= now)
      || (snapshot.rechargeOrders || []).some((item) => item.status === 'PENDING_PAYMENT'
        && (item.paymentExpiresAt || new Date(new Date(item.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString()) <= now)
      || (snapshot.plateApplications || []).some((item) => item.status === 'PENDING_PAYMENT'
        && (item.paymentExpiresAt || new Date(new Date(item.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString()) <= now);
    if (!hasExpired) return [];
    const expired = store.update((data) => expirePendingOrders(data, new Date().toISOString()));
    if (!expired.length) return expired;
    await processProviderCloseQueue();
    return expired;
  }

  async function processProviderCloseQueue() {
    const queued = store.update((data) => {
      if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
      return data.paymentOrders
        .filter((item) => item.status === 'CANCELLED' && item.providerCloseStatus === 'PENDING')
        .map((item) => {
          item.providerCloseStatus = 'REQUESTED';
          item.updatedAt = new Date().toISOString();
          return item;
        });
    });

    let closedCount = 0;
    let failedCount = 0;
    for (const queuedPayment of queued) {
      try {
        if (typeof paymentProvider.close !== 'function') {
          throw new Error('payment provider does not support transaction close');
        }
        const result = await paymentProvider.close(queuedPayment);
        if (result?.status !== 'CLOSED') {
          throw new Error(`provider returned ${result?.status || 'UNKNOWN'}`);
        }
        store.update((data) => {
          const paymentOrder = (data.paymentOrders || []).find((item) => item.id === queuedPayment.id);
          if (!paymentOrder || paymentOrder.status !== 'CANCELLED') return;
          const now = new Date().toISOString();
          paymentOrder.providerCloseStatus = 'CLOSED';
          paymentOrder.providerClosedAt = now;
          paymentOrder.providerCloseError = '';
          paymentOrder.providerTradeNo = result.providerTradeNo || paymentOrder.providerTradeNo || '';
          paymentOrder.updatedAt = now;
          addAudit(data, '支付渠道订单已关闭', paymentOrder.paymentNo);
        });
        closedCount += 1;
      } catch (error) {
        store.update((data) => {
          const paymentOrder = (data.paymentOrders || []).find((item) => item.id === queuedPayment.id);
          if (!paymentOrder || paymentOrder.status !== 'CANCELLED') return;
          const now = new Date().toISOString();
          paymentOrder.providerCloseStatus = 'FAILED';
          paymentOrder.providerCloseError = error.message;
          paymentOrder.updatedAt = now;
          addAudit(data, '支付渠道关单失败', paymentOrder.paymentNo);
        });
        failedCount += 1;
      }
    }
    return { closedCount, failedCount };
  }

  // ---------------------------------------------------------------------------
  // 运营巡检：把「谁该在什么时候处理完」变成可查、可提醒、可复盘的超时预警工单。
  // ---------------------------------------------------------------------------
  function slaHours(data, field, fallback) {
    const value = Number(data?.adminSettings?.[field]);
    return Number.isInteger(value) && value >= 1 && value <= 168 ? value : fallback;
  }

  function addHours(baseIso, hours) {
    const base = new Date(baseIso || Date.now()).getTime();
    return new Date(base + hours * 60 * 60 * 1000).toISOString();
  }

  // 每条规则回答三个问题：哪些单在等人处理、最晚什么时候要处理完、逾期该找谁。
  function collectSlaTargets(data) {
    const targets = [];
    const merchantName = (merchantId) => (data.merchants || []).find((item) => item.id === merchantId)?.name || '';
    const orderMerchantId = (order) => order.collaboration?.merchantId
      || order.items?.[0]?.merchantId
      || (data.products || []).find((product) => product.id === order.items?.[0]?.productId)?.merchantId
      || '';

    for (const order of data.orders || []) {
      if (!['PAID', 'FULFILLING'].includes(order.status)) continue;
      const merchantId = orderMerchantId(order);
      targets.push({
        ruleKey: 'ORDER_DELIVERY',
        ruleLabel: '电瓶车订单履约',
        businessType: 'ORDER',
        businessId: order.id,
        businessNo: order.orderNo || order.id,
        ownerRole: 'MERCHANT',
        merchantId,
        merchantName: merchantName(merchantId),
        userId: order.userId || '',
        dueAt: addHours(order.paidAt || order.updatedAt || order.createdAt, slaHours(data, 'deliveryResponseHours', 24)),
        detail: `${order.status === 'PAID' ? '已支付待接单' : '配送中待交付核验'} · ${(order.items || []).map((item) => item.name).join('、') || '订单商品'}`
      });
    }

    for (const record of data.phoneCardOrders || []) {
      if (record.status !== 'PENDING_REALNAME') continue;
      targets.push({
        ruleKey: 'PHONE_ACTIVATION',
        ruleLabel: '电话卡实名激活',
        businessType: 'PHONE_PLAN',
        businessId: record.id,
        businessNo: record.id,
        ownerRole: 'PLATFORM',
        merchantId: '',
        merchantName: '',
        ownerId: record.assigneeId || '',
        ownerName: record.assignee || '',
        userId: record.userId || '',
        dueAt: addHours(record.updatedAt || record.createdAt, slaHours(data, 'phoneCardActivationHours', 24)),
        detail: `${record.planName || '校园电话卡'} · ${record.customerName || ''} ${record.phone || ''}`.trim()
      });
    }

    for (const record of data.rechargeOrders || []) {
      if (record.status !== 'PENDING_CREDIT') continue;
      targets.push({
        ruleKey: 'RECHARGE_CREDIT',
        ruleLabel: '话费权益到账',
        businessType: 'RECHARGE',
        businessId: record.id,
        businessNo: record.id,
        ownerRole: 'PLATFORM',
        merchantId: '',
        merchantName: '',
        ownerId: record.assigneeId || '',
        ownerName: record.assignee || '',
        userId: record.userId || '',
        dueAt: addHours(record.updatedAt || record.createdAt, slaHours(data, 'rechargeCreditHours', 12)),
        detail: `充 ${Math.round((record.paidInCents || 0) / 100)} 送 ${Math.round(((record.receiveInCents || 0) - (record.paidInCents || 0)) / 100)} · ${record.phone || ''}`
      });
    }

    for (const record of data.broadbandApplications || []) {
      if (record.status !== 'PENDING_VERIFY') continue;
      targets.push({
        ruleKey: 'BROADBAND_VERIFY',
        ruleLabel: '双人宽带资格核验',
        businessType: 'BROADBAND',
        businessId: record.id,
        businessNo: record.id,
        ownerRole: 'PLATFORM',
        merchantId: '',
        merchantName: '',
        ownerId: record.assigneeId || '',
        ownerName: record.assignee || '',
        userId: record.userId || '',
        dueAt: addHours(record.updatedAt || record.createdAt, slaHours(data, 'broadbandVerifyHours', 48)),
        detail: `${record.ownerPhone || ''} + ${record.companionPhone || ''}`
      });
    }

    for (const record of data.plateApplications || []) {
      if (!['MATERIAL_PENDING', 'REVIEWING'].includes(record.status)) continue;
      targets.push({
        ruleKey: 'PLATE_PROGRESS',
        ruleLabel: '校园牌照辅助跟进',
        businessType: 'PLATE',
        businessId: record.id,
        businessNo: record.id,
        ownerRole: 'PLATFORM',
        merchantId: '',
        merchantName: '',
        userId: record.userId || '',
        dueAt: addHours(record.updatedAt || record.createdAt, slaHours(data, 'plateResponseHours', 48)),
        detail: `${record.vehicleModel || '车辆'} · ${record.status === 'MATERIAL_PENDING' ? '等待材料核对' : '审核中'}`
      });
    }

    for (const record of data.afterSales || []) {
      if (record.status === 'CLOSED') continue;
      const order = (data.orders || []).find((item) => item.id === record.orderId);
      const merchantId = order ? orderMerchantId(order) : '';
      const shared = {
        businessType: 'AFTER_SALE',
        businessId: record.id,
        businessNo: record.id,
        ownerRole: 'MERCHANT',
        merchantId,
        merchantName: merchantName(merchantId),
        userId: record.userId || '',
        detail: `${record.typeLabel || record.type} · ${record.reason || ''}`.slice(0, 120)
      };
      if (record.status === 'SUBMITTED') {
        targets.push({
          ...shared,
          ruleKey: 'AFTER_SALE_RESPONSE',
          ruleLabel: '售后首次响应',
          dueAt: record.responseDueAt || addHours(record.createdAt, slaHours(data, 'afterSaleResponseHours', 24))
        });
      }
      targets.push({
        ...shared,
        ruleKey: 'AFTER_SALE_RESOLUTION',
        ruleLabel: '售后处理完成',
        dueAt: record.resolutionDueAt || addHours(record.createdAt, slaHours(data, 'afterSaleResolutionHours', 72))
      });
    }

    for (const record of data.payoutRequests || []) {
      if (record.status !== 'PENDING_REVIEW') continue;
      targets.push({
        ruleKey: 'PAYOUT_REVIEW',
        ruleLabel: '商家提现审核',
        businessType: 'PAYOUT',
        businessId: record.id,
        businessNo: record.requestNo || record.id,
        ownerRole: 'PLATFORM',
        merchantId: record.merchantId || '',
        merchantName: record.merchantName || '',
        userId: '',
        dueAt: addHours(record.createdAt, slaHours(data, 'payoutReviewHours', 48)),
        detail: `${record.merchantName || record.merchantId} 申请 ¥${((record.amountInCents || 0) / 100).toFixed(2)}`
      });
    }

    for (const record of data.leads || []) {
      if (!openLeadStatuses.has(record.status)) continue;
      targets.push({
        ruleKey: 'LEAD_FOLLOW_UP',
        ruleLabel: '咨询线索跟进',
        businessType: 'LEAD',
        businessId: record.id,
        businessNo: record.leadNo || record.id,
        ownerRole: 'PLATFORM',
        merchantId: '',
        merchantName: '',
        ownerId: record.assigneeId || '',
        ownerName: record.assignee || '',
        userId: record.userId || '',
        dueAt: record.slaDueAt || addHours(record.createdAt, slaHours(data, 'leadResponseHours', 24)),
        detail: `${record.businessType || '咨询'} · ${record.name || ''} ${record.phone || ''}`.trim()
      });
    }

    for (const record of data.serviceScoreCases || []) {
      if (!['SUBMITTED', 'REVIEWING'].includes(record.status)) continue;
      targets.push({
        ruleKey: record.type === 'APPEAL' ? 'SCORE_APPEAL_REVIEW' : 'SCORE_RECTIFY_REVIEW',
        ruleLabel: record.type === 'APPEAL' ? '服务分申诉审核' : '服务分整改审核',
        businessType: 'SCORE_CASE',
        businessId: record.id,
        businessNo: record.caseNo || record.id,
        ownerRole: 'PLATFORM',
        merchantId: record.merchantId || '',
        merchantName: record.merchantName || '',
        userId: record.userId || '',
        dueAt: record.dueAt || addHours(record.createdAt, 48),
        detail: `${record.reason || ''}`.slice(0, 120)
      });
    }

    // 整改是商家自己的业务动作，平台复核前要让商家先知道自己临期了，
    // 否则商家可能等平台提醒，平台又在等商家提交，最后两边都错过时限。
    for (const record of data.serviceScoreCases || []) {
      if (record.type !== 'RECTIFY' || !['SUBMITTED', 'REVIEWING'].includes(record.status)) continue;
      const dueAt = record.dueAt || addHours(record.createdAt, 48);
      targets.push({
        ruleKey: 'SCORE_RECTIFY_MERCHANT',
        ruleLabel: '商家整改临期',
        businessType: 'SCORE_CASE',
        businessId: record.id,
        businessNo: record.caseNo || record.id,
        ownerRole: 'MERCHANT',
        merchantId: record.merchantId || '',
        merchantName: record.merchantName || '',
        userId: record.userId || '',
        dueAt,
        detail: `${record.productName || record.reason || ''}`.slice(0, 120)
      });
    }

    for (const record of data.financeTasks || []) {
      if (record.type !== 'PAYMENT_RECONCILIATION' || record.status === 'RESOLVED') continue;
      targets.push({
        ruleKey: 'FINANCE_RECONCILIATION',
        ruleLabel: '支付对账差异处理',
        businessType: 'FINANCE_TASK',
        businessId: record.id,
        businessNo: `${record.billDate} ${record.provider}`,
        ownerRole: 'PLATFORM',
        merchantId: '',
        merchantName: '',
        userId: '',
        dueAt: record.dueAt || financeTaskDueAt(data, record.createdAt),
        detail: `${record.differenceCount} 项差异 · ${record.detail || ''}`.slice(0, 120)
      });
    }

    // 资质有效期是长期经营风险：复审要提前完成，不能等到执照过期后再处理。
    for (const merchant of data.merchants || []) {
      if (merchant.status !== 'APPROVED' || !merchant.licenseExpireDate) continue;
      const expireMs = new Date(`${merchant.licenseExpireDate}T00:00:00.000Z`).getTime();
      if (!Number.isFinite(expireMs)) continue;
      const dueMs = expireMs - 30 * 24 * 60 * 60 * 1000;
      targets.push({
        ruleKey: 'MERCHANT_QUALIFICATION',
        ruleLabel: '商家资质复审',
        businessType: 'MERCHANT_QUALIFICATION',
        businessId: merchant.id,
        businessNo: merchant.applicationNo || merchant.id,
        ownerRole: 'MERCHANT',
        merchantId: merchant.id,
        merchantName: merchant.name,
        userId: merchant.userId || '',
        dueAt: new Date(dueMs).toISOString(),
        detail: `资质有效期 ${merchant.licenseExpireDate} · 请提前提交新执照复审`
      });
    }

    return targets;
  }

  function patrolWarningWindowMs(data) {
    // 预警提前量：取巡检间隔的 12 倍，最少 1 小时、最多 6 小时，保证运营有反应时间。
    const interval = Number(data?.adminSettings?.patrolIntervalMinutes);
    const minutes = Number.isInteger(interval) && interval >= 1 && interval <= 1440 ? interval : 10;
    return Math.min(Math.max(minutes * 12, 60), 360) * 60 * 1000;
  }

  // 巡检一轮：新增/升级超时预警、关闭已完成事项的预警，并把结果写进 patrolState。
  function runOperationsPatrol(data, now = new Date().toISOString()) {
    if (!Array.isArray(data.slaAlerts)) data.slaAlerts = [];
    // 待支付超时关单放进常驻巡检，避免无人访问时库存一直被预占。
    const expiredOrders = expirePendingOrders(data, now);
    // 账期到期的可结算分账同样由巡检推进，商家提现不依赖有人打开工作台。
    const maturedSettlements = releaseMaturedSettlements(data, now);
    const nowMs = new Date(now).getTime();
    const warningWindowMs = patrolWarningWindowMs(data);
    const targets = collectSlaTargets(data);
    const openAlerts = data.slaAlerts.filter((alert) => alert.status !== 'RESOLVED');
    const seen = new Set();
    const created = [];
    const escalated = [];

    for (const target of targets) {
      const dueMs = new Date(target.dueAt).getTime();
      if (!Number.isFinite(dueMs)) continue;
      const key = `${target.ruleKey}:${target.businessId}`;
      const level = dueMs <= nowMs ? 'OVERDUE' : (dueMs - nowMs <= warningWindowMs ? 'WARNING' : '');
      if (!level) continue;
      seen.add(key);
      const overdueMinutes = level === 'OVERDUE' ? Math.floor((nowMs - dueMs) / 60000) : 0;
      const existing = openAlerts.find((alert) => `${alert.ruleKey}:${alert.businessId}` === key);
      if (existing) {
        const wasLevel = existing.level;
        Object.assign(existing, {
          level,
          overdueMinutes,
          dueAt: target.dueAt,
          detail: target.detail,
          merchantId: target.merchantId,
          merchantName: target.merchantName,
          ownerId: target.ownerId || existing.ownerId || '',
          ownerName: target.ownerName || existing.ownerName || '',
          updatedAt: now
        });
        if (wasLevel !== level) {
          escalated.push(existing);
          // 从预警升级为超时时重新提醒一次，但不会重复刷同一等级。
          if (!existing.notifiedLevels.includes(level)) {
            existing.notifiedLevels.push(level);
            notifySlaAlert(data, existing);
          }
        }
        continue;
      }
      const alert = {
        id: `sla_${randomUUID()}`,
        alertNo: `SLA${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`,
        ruleKey: target.ruleKey,
        ruleLabel: target.ruleLabel,
        businessType: target.businessType,
        businessId: target.businessId,
        businessNo: target.businessNo,
        ownerRole: target.ownerRole,
        merchantId: target.merchantId,
        merchantName: target.merchantName,
        ownerId: target.ownerId || '',
        ownerName: target.ownerName || '',
        userId: target.userId,
        detail: target.detail,
        dueAt: target.dueAt,
        level,
        overdueMinutes,
        status: 'OPEN',
        notifiedLevels: [level],
        acknowledgedAt: '',
        acknowledgeNote: '',
        resolvedAt: '',
        resolvedReason: '',
        createdAt: now,
        updatedAt: now
      };
      data.slaAlerts.unshift(alert);
      created.push(alert);
      notifySlaAlert(data, alert);
    }

    const resolved = [];
    for (const alert of openAlerts) {
      if (seen.has(`${alert.ruleKey}:${alert.businessId}`)) continue;
      alert.status = 'RESOLVED';
      alert.resolvedAt = now;
      alert.resolvedReason = alert.resolvedReason || '业务已推进到下一环节，预警自动关闭';
      alert.updatedAt = now;
      resolved.push(alert);
    }

    // 预警变化会直接影响服务分，所以巡检末尾统一重算一次分档。
    const scoreChanges = refreshMerchantScores(data, now);

    data.slaAlerts = data.slaAlerts.slice(0, 1000);
    const stillOpen = data.slaAlerts.filter((alert) => alert.status !== 'RESOLVED');
    data.patrolState = {
      lastRunAt: now,
      runCount: Number(data.patrolState?.runCount || 0) + 1,
      lastCreated: created.length,
      lastResolved: resolved.length,
      lastOpen: stillOpen.length,
      lastExpiredOrders: expiredOrders.length,
      lastMaturedSettlements: maturedSettlements.length,
      lastScoreChanges: scoreChanges.length
    };
    if (created.length || resolved.length || escalated.length || expiredOrders.length || maturedSettlements.length) {
      addAudit(data, '运营巡检执行', `新增 ${created.length} · 升级 ${escalated.length} · 关闭 ${resolved.length} · 超时关单 ${expiredOrders.length} · 分账到期 ${maturedSettlements.length} · 服务分 ${scoreChanges.length}`);
    }
    return { created, escalated, resolved, open: stillOpen.length, scoreChanges, expiredOrders, maturedSettlements };
  }

  function notifySlaAlert(data, alert) {
    const overdueText = alert.level === 'OVERDUE'
      ? `已超时 ${alert.overdueMinutes >= 60 ? `${Math.floor(alert.overdueMinutes / 60)} 小时` : `${alert.overdueMinutes} 分钟`}`
      : '即将超时';
    const content = `${alert.ruleLabel}：${alert.businessNo} ${overdueText}，请尽快处理。${alert.detail ? `（${alert.detail}）` : ''}`.slice(0, 300);
    const merchant = (data.merchants || []).find((item) => item.id === alert.merchantId);
    const isMerchantOwner = alert.ownerRole === 'MERCHANT' && alert.merchantId;
    const title = isMerchantOwner
      ? (alert.level === 'OVERDUE' ? '履约已超时' : '履约即将超时')
      : `${alert.ruleLabel}${alert.level === 'OVERDUE' ? '已逾期' : '即将超时'}`;
    const message = isMerchantOwner
      ? content
      : `${alert.ruleLabel}：${alert.businessNo} ${overdueText}，平台已收到提醒。`;
    if (isMerchantOwner && merchant?.userId) {
      sendScoreNotification(data, merchant.userId, 'SLA_WARNING', title, message, alert.updatedAt || alert.createdAt, 'SLA',
        alert.businessType === 'ORDER' ? { orderId: alert.businessId } : {});
      return;
    }
    if (alert.ownerRole === 'PLATFORM' && !merchant?.userId) {
      const owner = (data.adminUsers || []).find((item) => item.id === alert.ownerId);
      if (owner) addNotification(data, owner.id, 'SLA', title, content);
      else addNotification(data, 'PLATFORM', 'SLA', title, content);
    }
  }

  async function patrolOnce() {
    const result = store.update((data) => runOperationsPatrol(data, new Date().toISOString()));
    const providerCloses = await processProviderCloseQueue();
    return {
      ...result,
      providerCloses: providerCloses.closedCount,
      providerCloseFailures: providerCloses.failedCount
    };
  }

  // 读接口顺带触发巡检，但按巡检间隔节流，避免每次请求都全量扫描。
  function sweepOperationsPatrol() {
    const snapshot = store.read();
    const interval = Number(snapshot.adminSettings?.patrolIntervalMinutes);
    const minutes = Number.isInteger(interval) && interval >= 1 && interval <= 1440 ? interval : 10;
    const lastRunAt = snapshot.patrolState?.lastRunAt;
    if (lastRunAt && Date.now() - new Date(lastRunAt).getTime() < minutes * 60 * 1000) return null;
    return patrolOnce();
  }

  function slaSummary(alerts) {
    const open = alerts.filter((alert) => alert.status !== 'RESOLVED');
    return {
      openCount: open.length,
      overdueCount: open.filter((alert) => alert.level === 'OVERDUE').length,
      warningCount: open.filter((alert) => alert.level === 'WARNING').length,
      acknowledgedCount: open.filter((alert) => alert.status === 'ACKNOWLEDGED').length,
      merchantOwnedCount: open.filter((alert) => alert.ownerRole === 'MERCHANT').length,
      platformOwnedCount: open.filter((alert) => alert.ownerRole === 'PLATFORM').length,
      resolvedCount: alerts.length - open.length
    };
  }

  function slaOwnerKey(alert) {
    if (alert.ownerRole === 'MERCHANT') return `MERCHANT:${alert.merchantId || 'UNASSIGNED'}`;
    if (alert.ownerId || alert.acknowledgedById) return `PLATFORM:${alert.ownerId || alert.acknowledgedById}`;
    return 'PLATFORM:UNASSIGNED';
  }

  function slaOwnerTasks(alerts = []) {
    const groups = new Map();
    for (const alert of alerts) {
      if (alert.status === 'RESOLVED') continue;
      const key = slaOwnerKey(alert);
      const ownerRole = alert.ownerRole === 'MERCHANT' ? 'MERCHANT' : 'PLATFORM';
      const ownerName = ownerRole === 'MERCHANT'
        ? (alert.merchantName || alert.ownerName || alert.acknowledgedBy || '商家')
        : (alert.ownerName || alert.acknowledgedBy || '待认领');
      const group = groups.get(key) || {
        key,
        ownerRole,
        ownerId: key.endsWith(':UNASSIGNED') ? '' : key.split(':')[1] || '',
        ownerName,
        openCount: 0,
        overdueCount: 0,
        warningCount: 0,
        acknowledgedCount: 0,
        businessTypes: [],
        nearestDueAt: ''
      };
      group.openCount += 1;
      group.overdueCount += alert.level === 'OVERDUE' ? 1 : 0;
      group.warningCount += alert.level === 'WARNING' ? 1 : 0;
      group.acknowledgedCount += alert.status === 'ACKNOWLEDGED' ? 1 : 0;
      if (alert.businessType && !group.businessTypes.includes(alert.businessType)) group.businessTypes.push(alert.businessType);
      if (alert.dueAt && (!group.nearestDueAt || String(alert.dueAt) < group.nearestDueAt)) group.nearestDueAt = alert.dueAt;
      groups.set(key, group);
    }
    return [...groups.values()].sort((a, b) => (
      b.overdueCount - a.overdueCount
      || b.openCount - a.openCount
      || String(a.nearestDueAt).localeCompare(String(b.nearestDueAt))
      || a.ownerName.localeCompare(b.ownerName)
    ));
  }

  // 商家与运营看板需要当下的分数，读接口先重算一次再返回。
  // ===== 商家服务分 =====
  // 分数只由平台已经记录的事实推导：交付是否按时、售后多不多、学生评价好不好、超时预警有没有堆积。
  const serviceScoreWeights = [
    { key: 'DELIVERY', label: '履约及时', weight: 35 },
    { key: 'AFTER_SALE', label: '售后表现', weight: 25 },
    { key: 'REVIEW', label: '学生评价', weight: 20 },
    { key: 'SLA', label: '超时预警', weight: 15 },
    { key: 'NEGATIVE_REVIEW', label: '差评处理', weight: 5 }
  ];

  // 分档不是标签，而是真实处置：曝光权重影响商品排序，是否自动上架影响商家上新。
  const serviceScoreStages = {
    NORMAL: { label: '正常经营', exposureWeight: 1, autoPublish: true },
    LIMITED: { label: '限流整改', exposureWeight: 0.6, autoPublish: false },
    RESTRICTED: { label: '暂停上新', exposureWeight: 0.2, autoPublish: false }
  };

  const serviceScoreGrades = [
    { grade: 'EXCELLENT', label: '优秀', min: 90 },
    { grade: 'GOOD', label: '良好', min: 80 },
    { grade: 'WATCH', label: '观察', min: 70 },
    { grade: 'WARNING', label: '预警', min: 60 },
    { grade: 'RISK', label: '高风险', min: 0 }
  ];

  function scoreThresholds(data) {
    const limitedRaw = Number(data?.adminSettings?.serviceScoreLimitedThreshold);
    const limited = Number.isInteger(limitedRaw) && limitedRaw >= 50 && limitedRaw <= 100 ? limitedRaw : 80;
    const restrictedRaw = Number(data?.adminSettings?.serviceScoreRestrictedThreshold);
    const restricted = Number.isInteger(restrictedRaw) && restrictedRaw >= 0 && restrictedRaw < limited ? restrictedRaw : Math.min(60, limited - 1);
    return { limited, restricted };
  }

  function clampScore(value) {
    return Math.max(0, Math.min(100, Math.round(value)));
  }

  function resolveOrderMerchantId(data, order) {
    return order.collaboration?.merchantId
      || order.items?.[0]?.merchantId
      || (data.products || []).find((product) => product.id === order.items?.[0]?.productId)?.merchantId
      || '';
  }

  // 交付时间优先取协作流水里的完成事件，避免后续改单把履约时长算宽。
  function orderCompletedAt(order) {
    const events = [...(order.collaboration?.handoffs || [])].reverse();
    const done = events.find((event) => event.action === 'COMPLETE' || event.action === 'AFTER_SALE_CLOSED');
    return done?.createdAt || order.updatedAt || order.createdAt;
  }

  function computeMerchantScore(data, merchant, now = new Date().toISOString()) {
    const deliveryHours = slaHours(data, 'deliveryResponseHours', 24);
    const productIds = new Set((data.products || []).filter((item) => item.merchantId === merchant.id).map((item) => item.id));
    const orders = (data.orders || []).filter((order) => resolveOrderMerchantId(data, order) === merchant.id
      || (order.items || []).some((item) => productIds.has(item.productId)));
    const paidOrders = orders.filter((order) => ['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(order.status));
    const completedOrders = orders.filter((order) => order.status === 'COMPLETED' && order.paidAt);
    let onTimeCount = 0;
    let lateCount = 0;
    for (const order of completedOrders) {
      const usedHours = (new Date(orderCompletedAt(order)).getTime() - new Date(order.paidAt).getTime()) / 3600000;
      if (Number.isFinite(usedHours) && usedHours <= deliveryHours) onTimeCount += 1;
      else lateCount += 1;
    }

    const openAlerts = (data.slaAlerts || []).filter((alert) => alert.status !== 'RESOLVED'
      && alert.ownerRole === 'MERCHANT' && alert.merchantId === merchant.id);
    const overdueAlerts = openAlerts.filter((alert) => alert.level === 'OVERDUE');
    const overdueDeliveryAlerts = overdueAlerts.filter((alert) => alert.ruleKey === 'ORDER_DELIVERY').length;

    // 没有成交记录的新商家给 92 分起步，不用零分把新店直接压死。
    const deliveryBase = completedOrders.length ? (onTimeCount / completedOrders.length) * 100 : 92;
    const deliveryScore = clampScore(deliveryBase - overdueDeliveryAlerts * 8);

    const afterSales = (data.afterSales || []).filter((record) => orders.some((order) => order.id === record.orderId));
    const openAfterSales = afterSales.filter((record) => record.status !== 'CLOSED');
    const overdueAfterSales = afterSales.filter((record) => record.status !== 'CLOSED'
      && record.responseDueAt && record.responseDueAt < now);
    const afterSaleRate = paidOrders.length ? afterSales.length / paidOrders.length : 0;
    const afterSaleScore = clampScore(100 - afterSaleRate * 120 - overdueAfterSales.length * 12 - openAfterSales.length * 4);

    const reviews = (data.productReviews || []).filter((review) => productIds.has(review.productId)
      && review.visibility !== 'HIDDEN' && review.purchaseVerified !== false);
    const averageRating = reviews.length
      ? reviews.reduce((sum, review) => sum + (Number(review.rating) || 0), 0) / reviews.length
      : 0;
    const lowRatings = reviews.filter((review) => Number(review.rating) <= 2).length;
    const reviewScore = reviews.length ? clampScore((averageRating / 5) * 100 - lowRatings * 5) : 85;
    const negativeReviews = reviews.filter((review) => Number(review.rating) <= 2);
    const negativeReviewRepliedCount = negativeReviews.filter((review) => review.reply && String(review.reply.content || '').trim()).length;
    const negativeReviewScore = negativeReviews.length
      ? clampScore((negativeReviewRepliedCount / negativeReviews.length) * 100)
      : 100;

    const slaScore = clampScore(100 - overdueAlerts.length * 20 - (openAlerts.length - overdueAlerts.length) * 8);

    // 低质商品自动下架要直接影响商家服务分：不是只把单件商品藏起来，而是让商家重视整改。
    const complianceWindowStart = new Date(new Date(now).getTime() - 30 * 24 * 3600 * 1000).toISOString();
    const merchantComplianceProducts = (data.products || []).filter((item) => item.merchantId === merchant.id
      && item.autoDelistRule === 'LOW_QUALITY'
      && item.autoDelistAt
      && String(item.autoDelistAt) >= complianceWindowStart);
    const activeAutoDelistCount = merchantComplianceProducts.filter((item) => item.active === false).length;
    const compliancePenalty = Math.min(12, merchantComplianceProducts.length * 3);

    const rawScores = {
      DELIVERY: deliveryScore,
      AFTER_SALE: afterSaleScore,
      REVIEW: reviewScore,
      SLA: slaScore,
      NEGATIVE_REVIEW: negativeReviewScore
    };
    const totalWeight = serviceScoreWeights.reduce((sum, item) => sum + item.weight, 0);
    const weighted = serviceScoreWeights.reduce((sum, item) => sum + rawScores[item.key] * item.weight, 0) / totalWeight;
    const manualAdjustment = Math.max(-20, Math.min(20, Number(merchant.serviceScore?.manualAdjustment || 0)));
    const appealAdjustment = Math.max(-20, Math.min(20, Number(merchant.serviceScore?.appealAdjustment || 0)));
    const score = clampScore(weighted + manualAdjustment + appealAdjustment - compliancePenalty);
    const thresholds = scoreThresholds(data);
    const stage = score >= thresholds.limited ? 'NORMAL' : (score >= thresholds.restricted ? 'LIMITED' : 'RESTRICTED');
    const gradeEntry = serviceScoreGrades.find((item) => score >= item.min) || serviceScoreGrades[serviceScoreGrades.length - 1];
    const details = {
      DELIVERY: completedOrders.length
        ? `已完成 ${completedOrders.length} 单，按时 ${onTimeCount} 单、超时 ${lateCount} 单`
        : '暂无完成订单，按新商家基准计分',
      AFTER_SALE: afterSales.length
        ? `售后 ${afterSales.length} 单，未关闭 ${openAfterSales.length} 单、响应逾期 ${overdueAfterSales.length} 单`
        : '暂无售后工单',
      REVIEW: reviews.length
        ? `${reviews.length} 条已购评价，均分 ${(Math.round(averageRating * 10) / 10).toFixed(1)}，低分 ${lowRatings} 条`
        : '暂无已购评价，按中性基准计分',
      SLA: openAlerts.length
        ? `未关闭预警 ${openAlerts.length} 条，其中已超时 ${overdueAlerts.length} 条`
        : '无未关闭的履约预警',
      NEGATIVE_REVIEW: negativeReviews.length
        ? `差评 ${negativeReviews.length} 条，已回复 ${negativeReviewRepliedCount} 条`
        : '暂无差评，按满分计入'
    };
    return {
      score,
      grade: gradeEntry.grade,
      gradeLabel: gradeEntry.label,
      stage,
      stageLabel: serviceScoreStages[stage].label,
      exposureWeight: serviceScoreStages[stage].exposureWeight,
      autoPublish: serviceScoreStages[stage].autoPublish,
      manualAdjustment,
      appealAdjustment,
      thresholds,
      breakdown: serviceScoreWeights.map((item) => ({
        key: item.key,
        label: item.label,
        weight: item.weight,
        score: rawScores[item.key],
        detail: details[item.key]
      })),
      metrics: {
        paidOrderCount: paidOrders.length,
        completedOrderCount: completedOrders.length,
        onTimeCount,
        lateCount,
        afterSaleCount: afterSales.length,
        openAfterSaleCount: openAfterSales.length,
        overdueAfterSaleCount: overdueAfterSales.length,
        reviewCount: reviews.length,
        averageRating: Math.round(averageRating * 10) / 10,
        lowRatingCount: lowRatings,
        negativeReviewCount: negativeReviews.length,
        negativeReviewRepliedCount,
        openAlertCount: openAlerts.length,
        overdueAlertCount: overdueAlerts.length,
        autoDelistCount30d: merchantComplianceProducts.length,
        activeAutoDelistCount,
        compliancePenalty
      },
      updatedAt: now
    };
  }

  function addMerchantScoreLog(data, merchant, entry, now) {
    if (!Array.isArray(data.merchantScoreLogs)) data.merchantScoreLogs = [];
    const log = {
      id: `msl_${randomUUID()}`,
      merchantId: merchant.id,
      merchantName: merchant.name,
      score: merchant.serviceScore?.score ?? 0,
      stage: merchant.serviceScore?.stage || 'NORMAL',
      createdAt: now,
      ...entry
    };
    data.merchantScoreLogs.unshift(log);
    data.merchantScoreLogs = data.merchantScoreLogs.slice(0, 300);
    return log;
  }

  // 每天最多保留一次服务分快照，这样趋势图反映真实日常变化，而不是被巡检频率放大。
  function refreshMerchantScoreSnapshots(data, now) {
    const date = String(now || '').slice(0, 10);
    if (!date) return;
    data.merchantScoreSnapshots = Array.isArray(data.merchantScoreSnapshots) ? data.merchantScoreSnapshots : [];
    let changed = false;
    for (const merchant of data.merchants || []) {
      if (merchant.status !== 'APPROVED' || !merchant.serviceScore) continue;
      const existing = data.merchantScoreSnapshots.find((item) => item.merchantId === merchant.id && item.date === date);
      if (existing) {
        if (existing.score === merchant.serviceScore.score && existing.stage === merchant.serviceScore.stage) continue;
        existing.score = merchant.serviceScore.score;
        existing.stage = merchant.serviceScore.stage;
        existing.updatedAt = now;
        changed = true;
        continue;
      }
      data.merchantScoreSnapshots.unshift({
        id: `mss_${randomUUID()}`,
        merchantId: merchant.id,
        date,
        score: merchant.serviceScore.score,
        stage: merchant.serviceScore.stage,
        createdAt: now,
        updatedAt: now
      });
      changed = true;
    }
    if (changed) {
      data.merchantScoreSnapshots.sort((a, b) => b.date.localeCompare(a.date));
      const kept = new Set();
      data.merchantScoreSnapshots = data.merchantScoreSnapshots.filter((item) => {
        const key = `${item.merchantId}:${item.date}`;
        if (kept.has(key)) return false;
        kept.add(key);
        return true;
      });
    }
  }

  function merchantScoreRisk(data, merchant) {
    if (!merchant?.serviceScore) return null;
    const now = new Date().toISOString();
    const openAlerts = (data.slaAlerts || []).filter((alert) => alert.status !== 'RESOLVED'
      && alert.ownerRole === 'MERCHANT' && alert.merchantId === merchant.id);
    const overdueAlerts = openAlerts.filter((alert) => alert.level === 'OVERDUE').length;
    const productIds = new Set((data.products || []).filter((item) => item.merchantId === merchant.id).map((item) => item.id));
    const orders = (data.orders || []).filter((order) => resolveOrderMerchantId(data, order) === merchant.id
      || (order.items || []).some((item) => productIds.has(item.productId)));
    const afterSales = (data.afterSales || []).filter((record) => orders.some((order) => order.id === record.orderId));
    const openAfterSales = afterSales.filter((record) => record.status !== 'CLOSED').length;
    const overdueAfterSales = afterSales.filter((record) => record.status !== 'CLOSED'
      && record.responseDueAt && record.responseDueAt < now).length;
    const breakdown = (merchant.serviceScore.breakdown || []);
    const currentAfterSale = breakdown.find((item) => item.key === 'AFTER_SALE')?.score ?? 100;
    const currentSla = breakdown.find((item) => item.key === 'SLA')?.score ?? 100;
    // 和评分公式同一套扣分系数：这里只计算“处理完当前超时/未关闭事项”能找回的分数。
    const projectedAfterSale = clampScore(100 - overdueAfterSales * 12 - openAfterSales * 4);
    const projectedSla = clampScore(100 - overdueAlerts * 20 - (openAlerts.length - overdueAlerts) * 8);
    const afterSaleRecoverable = Math.max(0, projectedAfterSale - currentAfterSale);
    const slaRecoverable = Math.max(0, projectedSla - currentSla);
    const riskPoints = Math.round((afterSaleRecoverable * 25 + slaRecoverable * 15) / 100);
    if (!riskPoints) return null;
    return {
      riskPoints,
      overdueAfterSales,
      openAfterSales,
      overdueAlerts,
      openAlerts: openAlerts.length
    };
  }

  function merchantRiskTasks(afterSales = [], slaAlerts = [], reviews = [], products = [], stockThreshold = 10) {
    const now = new Date().toISOString();
    const priorityOrder = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
    const tasks = [];
    for (const record of afterSales) {
      if (record.status === 'CLOSED') continue;
      const overdue = Boolean(record.responseDueAt && record.responseDueAt < now);
      tasks.push({
        id: record.id,
        type: 'AFTER_SALE',
        priority: overdue ? 'URGENT' : 'HIGH',
        title: `售后工单 · ${record.typeLabel || '售后处理'}`,
        detail: record.reason || record.orderId || '',
        reference: record.orderId,
        dueAt: record.responseDueAt || '',
        action: '去处理售后'
      });
    }
    for (const alert of slaAlerts) {
      tasks.push({
        id: alert.id,
        type: 'SLA',
        priority: alert.level === 'OVERDUE' ? 'URGENT' : 'HIGH',
        title: `履约预警 · ${alert.ruleLabel || '超时预警'}`,
        detail: `${alert.businessNo || ''}${alert.detail ? `：${alert.detail}` : ''}`,
        reference: alert.businessId || alert.id,
        dueAt: alert.dueAt || '',
        action: '去处理履约'
      });
    }
    for (const review of reviews) {
      if (Number(review.rating) > 2 || review.reply) continue;
      tasks.push({
        id: review.id,
        type: 'NEGATIVE_REVIEW',
        priority: 'MEDIUM',
        title: `差评待回复 · ${review.rating} 分`,
        detail: review.content || '',
        reference: review.id,
        dueAt: '',
        action: '去回复差评'
      });
    }
    for (const product of products) {
      if (product.active === false || availableStock(product) > stockThreshold) continue;
      tasks.push({
        id: product.id,
        type: 'LOW_STOCK',
        priority: 'LOW',
        title: `库存偏低 · ${product.name || '商品'}`,
        detail: `当前可用 ${availableStock(product)} 件，阈值 ${stockThreshold} 件`,
        reference: product.id,
        dueAt: '',
        action: '去补充库存'
      });
    }
    return tasks
      .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
      .slice(0, 20);
  }

  function merchantScoreTrend(data, merchantId, days = 14) {
    const count = Number.isInteger(days) && days >= 2 && days <= 90 ? days : 14;
    const today = new Date().toISOString().slice(0, 10);
    const byDate = new Map();
    for (const item of data.merchantScoreSnapshots || []) {
      if (item.merchantId === merchantId) byDate.set(item.date, item);
    }
    const rows = [];
    for (let index = count - 1; index >= 0; index -= 1) {
      const date = new Date(`${today}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - index);
      const key = date.toISOString().slice(0, 10);
      rows.push({ date: key, score: byDate.has(key) ? byDate.get(key).score : null, stage: byDate.has(key) ? byDate.get(key).stage : null });
    }
    let lastKnown = null;
    for (let index = 0; index < rows.length; index += 1) {
      if (rows[index].score !== null) lastKnown = rows[index].score;
      else if (lastKnown !== null) rows[index].score = lastKnown;
    }
    lastKnown = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      if (rows[index].score !== null) lastKnown = rows[index].score;
      else if (lastKnown !== null) rows[index].score = lastKnown;
    }
    const points = rows.filter((item) => item.score !== null);
    const first = points[0];
    const latest = points[points.length - 1];
    const rangeStart = rows[0]?.date || today;
    const effectLog = (data.merchantScoreLogs || []).find((item) => item.merchantId === merchantId
      && item.type === 'RECTIFY_APPROVED'
      && Number.isInteger(item.scoreBefore)
      && Number.isInteger(item.scoreAfter)
      && String(item.createdAt || '').slice(0, 10) >= rangeStart);
    const effect = effectLog ? {
      caseNo: effectLog.caseNo || '',
      approvedDate: String(effectLog.createdAt || '').slice(0, 10),
      scoreBefore: effectLog.scoreBefore,
      scoreAfter: effectLog.scoreAfter,
      gain: effectLog.scoreAfter - effectLog.scoreBefore
    } : null;
    return {
      days: count,
      range: [rows[0]?.date || today, rows[rows.length - 1]?.date || today],
      change: first && latest ? latest.score - first.score : 0,
      trendText: first && latest ? `${latest.score - first.score >= 0 ? '+' : ''}${latest.score - first.score} 分` : '暂无趋势',
      effect,
      risk: merchantScoreRisk(data, (data.merchants || []).find((item) => item.id === merchantId)),
      points: rows
    };
  }

  function merchantNotificationLink(notification) {
    const metadata = notification?.metadata || {};
    if ((notification.type === 'ORDER' || notification.type === 'AFTER_SALE') && metadata.orderId) {
      const focusId = encodeURIComponent(String(metadata.orderId));
      return `/pages/merchant/orders?focusId=${focusId}${notification.type === 'AFTER_SALE' ? '&filter=AFTER_SALE' : ''}`;
    }
    if (notification.type === 'STOCK' && metadata.productId) {
      return `/pages/merchant/products?focusId=${encodeURIComponent(String(metadata.productId))}&filter=LOW`;
    }
    return '';
  }

  // 分档变化才通知和留痕，避免每轮巡检都刷一遍相同结论。
  function refreshMerchantScores(data, now = new Date().toISOString()) {
    const changes = [];
    const complianceActions = enforceProductCompliance(data, now);
    for (const merchant of data.merchants || []) {
      if (merchant.status !== 'APPROVED') continue;
      const previous = merchant.serviceScore || null;
      merchant.serviceScore = computeMerchantScore(data, merchant, now);
      if (previous && previous.stage === merchant.serviceScore.stage) continue;
      const fromStage = previous?.stage || '';
      const toStage = merchant.serviceScore.stage;
      const improved = Boolean(previous) && serviceScoreStages[toStage].exposureWeight > serviceScoreStages[fromStage]?.exposureWeight;
      const note = !previous
        ? `服务分初始化为 ${merchant.serviceScore.score} 分（${merchant.serviceScore.stageLabel}）`
        : `服务分 ${previous.score} → ${merchant.serviceScore.score}，处置从${serviceScoreStages[fromStage]?.label || fromStage}调整为${merchant.serviceScore.stageLabel}`;
      addMerchantScoreLog(data, merchant, { type: 'STAGE_CHANGE', fromStage, toStage, note }, now);
      if (previous) {
        const consequence = toStage === 'RESTRICTED'
          ? '已暂停新增商品，商品曝光大幅降低，请尽快处理超时与售后工单'
          : toStage === 'LIMITED'
            ? '商品曝光已降权，新增商品需平台复核后才会上架'
            : '商品曝光与上新已恢复正常';
        notifyMerchantScore(data, merchant.id, toStage === 'NORMAL' ? 'SCORE_RECTIFY_RESULT' : 'SCORE_STAGE_WARNING',
          improved ? '服务分已恢复' : '服务分下降', `${note}。${consequence}。`, now);
        addNotification(data, 'PLATFORM', 'SCORE', improved ? '服务分已恢复' : '服务分下降',
          `${merchant.name}：${note}。${consequence}。`, now);
      }
      changes.push({ merchantId: merchant.id, fromStage, toStage, score: merchant.serviceScore.score });
    }
    for (const action of complianceActions) {
      changes.push({ merchantId: (data.products || []).find((item) => item.id === action.productId)?.merchantId || '', action: action.action });
    }
    return changes;
  }

  function merchantServiceStage(data, merchantId) {
    if (!merchantId) return 'NORMAL';
    const merchant = (data.merchants || []).find((item) => item.id === merchantId);
    const stage = merchant?.serviceScore?.stage;
    return serviceScoreStages[stage] ? stage : 'NORMAL';
  }

  function merchantExposureWeight(data, merchantId) {
    return serviceScoreStages[merchantServiceStage(data, merchantId)].exposureWeight;
  }

  function dailyOperationsReports(data, days = 7) {
    const count = Number.isInteger(days) && days >= 1 && days <= 90 ? days : 7;
    const dayOf = (value) => String(value || '').slice(0, 10);
    const now = new Date().toISOString().slice(0, 10);
    const byDate = new Map();
    for (let index = 0; index < count; index += 1) {
      const date = new Date(`${now}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - index);
      const key = date.toISOString().slice(0, 10);
      byDate.set(key, {
        date: key,
        ebikeOrders: 0,
        phoneCardOrders: 0,
        rechargeOrders: 0,
        plateApplications: 0,
        completedEbikeOrders: 0,
        afterSalesCreated: 0,
        afterSalesClosed: 0,
        reviewsCreated: 0,
        autoDelists: 0,
        complianceRestores: 0,
        scoreStageChanges: 0,
        rectifyCasesCreated: 0,
        rectifyCasesApproved: 0,
        paymentTimeouts: 0,
        paymentInCents: 0,
        refundOutCents: 0,
        payoutOutCents: 0,
        netInCents: 0
      });
    }
    const add = (value, field, amount = 1) => {
      const report = byDate.get(dayOf(value));
      if (report) report[field] += amount;
    };
    for (const item of data.orders || []) {
      add(item.createdAt, 'ebikeOrders');
      if (item.status === 'COMPLETED') add(orderCompletedAt(item), 'completedEbikeOrders');
    }
    const timeoutClosures = [
      ...(data.orders || []),
      ...(data.phoneCardOrders || []),
      ...(data.rechargeOrders || []),
      ...(data.plateApplications || [])
    ].filter((item) => item.cancelReason === 'PAYMENT_TIMEOUT');
    for (const item of timeoutClosures) add(item.updatedAt || item.createdAt, 'paymentTimeouts');
    for (const item of data.phoneCardOrders || []) add(item.createdAt, 'phoneCardOrders');
    for (const item of data.rechargeOrders || []) add(item.createdAt, 'rechargeOrders');
    for (const item of data.plateApplications || []) add(item.createdAt, 'plateApplications');
    for (const item of data.afterSales || []) {
      add(item.createdAt, 'afterSalesCreated');
      if (item.status === 'CLOSED') add(item.updatedAt, 'afterSalesClosed');
    }
    for (const item of data.productReviews || []) add(item.createdAt, 'reviewsCreated');
    for (const item of data.merchantScoreLogs || []) {
      if (item.type === 'AUTO_DELIST') add(item.createdAt, 'autoDelists');
      if (item.type === 'STAGE_CHANGE') add(item.createdAt, 'scoreStageChanges');
      if (['COMPLIANCE_RESTORED', 'SCORE_CASE_COMPLIANCE_RESTORED', 'MANUAL_COMPLIANCE_RESTORED'].includes(item.type)) {
        add(item.createdAt, 'complianceRestores');
      }
    }
    for (const item of data.serviceScoreCases || []) {
      if (item.type !== 'RECTIFY') continue;
      add(item.createdAt, 'rectifyCasesCreated');
      if (item.status === 'COMPLETED') add(item.updatedAt, 'rectifyCasesApproved');
    }
    for (const item of data.financeEvents || []) {
      if (item.eventType === 'PAYMENT') add(item.createdAt, 'paymentInCents', item.amountInCents);
      if (item.eventType === 'REFUND') add(item.createdAt, 'refundOutCents', Math.abs(item.amountInCents));
      if (item.eventType === 'PAYOUT') add(item.createdAt, 'payoutOutCents', Math.abs(item.amountInCents));
      add(item.createdAt, 'netInCents', item.amountInCents);
    }
    const reports = [...byDate.values()];
    const totals = reports.reduce((sum, item) => ({
      ebikeOrders: sum.ebikeOrders + item.ebikeOrders,
      phoneCardOrders: sum.phoneCardOrders + item.phoneCardOrders,
      rechargeOrders: sum.rechargeOrders + item.rechargeOrders,
      plateApplications: sum.plateApplications + item.plateApplications,
      completedEbikeOrders: sum.completedEbikeOrders + item.completedEbikeOrders,
      afterSalesCreated: sum.afterSalesCreated + item.afterSalesCreated,
      afterSalesClosed: sum.afterSalesClosed + item.afterSalesClosed,
      reviewsCreated: sum.reviewsCreated + item.reviewsCreated,
      autoDelists: sum.autoDelists + item.autoDelists,
      complianceRestores: sum.complianceRestores + item.complianceRestores,
      scoreStageChanges: sum.scoreStageChanges + item.scoreStageChanges,
      rectifyCasesCreated: sum.rectifyCasesCreated + item.rectifyCasesCreated,
      rectifyCasesApproved: sum.rectifyCasesApproved + item.rectifyCasesApproved,
      paymentTimeouts: sum.paymentTimeouts + item.paymentTimeouts,
      paymentInCents: sum.paymentInCents + item.paymentInCents,
      refundOutCents: sum.refundOutCents + item.refundOutCents,
      payoutOutCents: sum.payoutOutCents + item.payoutOutCents,
      netInCents: sum.netInCents + item.netInCents
    }), {
      ebikeOrders: 0, phoneCardOrders: 0, rechargeOrders: 0, plateApplications: 0,
      completedEbikeOrders: 0, afterSalesCreated: 0, afterSalesClosed: 0, reviewsCreated: 0,
      autoDelists: 0, complianceRestores: 0, scoreStageChanges: 0, rectifyCasesCreated: 0, rectifyCasesApproved: 0, paymentTimeouts: 0,
      paymentInCents: 0, refundOutCents: 0, payoutOutCents: 0, netInCents: 0
    });
    return {
      reports,
      totals
    };
  }

  function operationsReportInsights(data) {
    const reports = dailyOperationsReports(data, 14).reports;
    const currentReports = reports.slice(0, 7);
    const previousReports = reports.slice(7);
    const sum = (items) => items.reduce((result, item) => ({
      ebikeOrders: result.ebikeOrders + item.ebikeOrders,
      phoneCardOrders: result.phoneCardOrders + item.phoneCardOrders,
      rechargeOrders: result.rechargeOrders + item.rechargeOrders,
      plateApplications: result.plateApplications + item.plateApplications,
      completedEbikeOrders: result.completedEbikeOrders + item.completedEbikeOrders,
      afterSalesCreated: result.afterSalesCreated + item.afterSalesCreated,
      afterSalesClosed: result.afterSalesClosed + item.afterSalesClosed,
      autoDelists: result.autoDelists + item.autoDelists,
      complianceRestores: result.complianceRestores + item.complianceRestores,
      scoreStageChanges: result.scoreStageChanges + item.scoreStageChanges,
      rectifyCasesCreated: result.rectifyCasesCreated + item.rectifyCasesCreated,
      rectifyCasesApproved: result.rectifyCasesApproved + item.rectifyCasesApproved,
      paymentTimeouts: result.paymentTimeouts + item.paymentTimeouts,
      paymentInCents: result.paymentInCents + item.paymentInCents,
      netInCents: result.netInCents + item.netInCents
    }), {
      ebikeOrders: 0, phoneCardOrders: 0, rechargeOrders: 0, plateApplications: 0,
      completedEbikeOrders: 0, afterSalesCreated: 0, afterSalesClosed: 0,
      autoDelists: 0, complianceRestores: 0, scoreStageChanges: 0, rectifyCasesCreated: 0, rectifyCasesApproved: 0, paymentTimeouts: 0,
      paymentInCents: 0, netInCents: 0
    });
    const current = sum(currentReports);
    const previous = sum(previousReports);
    const total = (item) => item.ebikeOrders + item.phoneCardOrders + item.rechargeOrders + item.plateApplications;
    const change = (now, before) => {
      if (!before) return now > 0 ? 100 : 0;
      return Math.round(((now - before) / before) * 1000) / 10;
    };
    const metrics = [
      { label: '新增业务', now: total(current), before: total(previous) },
      { label: '支付收入', now: current.paymentInCents, before: previous.paymentInCents, money: true },
      { label: '完成电瓶车订单', now: current.completedEbikeOrders, before: previous.completedEbikeOrders },
      { label: '新增售后', now: current.afterSalesCreated, before: previous.afterSalesCreated }
    ];
    const now = new Date().toISOString();
    const alerts = [];
    if ((data.metrics || []).afterSaleOverdue || (data.afterSales || []).some((item) => item.status !== 'CLOSED' && item.responseDueAt && item.responseDueAt < now)) {
      alerts.push({ level: 'HIGH', message: '有售后超过承诺响应时限，需当天处理。' });
    }
    const leadsOverdue = (data.leads || []).filter((item) => openLeadStatuses.has(item.status) && item.slaDueAt < now).length;
    if (leadsOverdue) alerts.push({ level: 'HIGH', message: `有 ${leadsOverdue} 条咨询线索超过跟进时限。` });
    const openPatrol = (data.slaAlerts || []).filter((item) => item.status !== 'RESOLVED').length;
    if (openPatrol) alerts.push({ level: 'MEDIUM', message: `有 ${openPatrol} 条运营巡检预警未闭环。` });
    const stockThreshold = lowStockThreshold(data);
    const lowStock = (data.products || []).filter((item) => item.active !== false && availableStock(item) <= stockThreshold).length;
    if (lowStock) alerts.push({ level: 'MEDIUM', message: `有 ${lowStock} 个在售商品库存已达到 ${stockThreshold} 件补货阈值。` });
    const afterSaleRate = total(current) ? Math.round((current.afterSalesCreated / total(current)) * 1000) / 10 : 0;
    if (afterSaleRate >= 20) alerts.push({ level: 'MEDIUM', message: `近 7 天售后率为 ${afterSaleRate}%，建议复核商品质量与履约。` });
    if (current.paymentTimeouts >= 3) {
      alerts.push({ level: 'MEDIUM', message: `近 7 天支付超时 ${current.paymentTimeouts} 次，建议优化待支付提醒和下单转化。` });
    }
    const paymentChange = change(current.paymentInCents, previous.paymentInCents);
    if (previous.paymentInCents > 0 && paymentChange <= -30) {
      alerts.push({ level: 'MEDIUM', message: `支付收入环比下降 ${Math.abs(paymentChange)}%，建议排查流量、库存和转化。` });
    }
    if (current.autoDelists >= 3 && current.complianceRestores < current.autoDelists) {
      alerts.push({ level: 'HIGH', message: `近 7 天自动下架 ${current.autoDelists} 次，仅恢复 ${current.complianceRestores} 次，商品供给质量需要专项跟进。` });
    }
    if (current.scoreStageChanges > 0) {
      alerts.push({ level: 'MEDIUM', message: `近 7 天有 ${current.scoreStageChanges} 次商家服务分分档变化，请确认处置与整改结果。` });
    }
    if (current.rectifyCasesCreated > 0 && current.rectifyCasesApproved === 0) {
      alerts.push({ level: 'MEDIUM', message: `近 7 天有 ${current.rectifyCasesCreated} 个整改工单尚未验收通过，请检查商家整改进度。` });
    }
    return {
      reports,
      current: { reports: currentReports, totals: current },
      previous: { reports: previousReports, totals: previous },
      comparisons: [
      { label: '新增业务', key: 'totalOrders', current: total(current), previous: total(previous), changePercent: change(total(current), total(previous)) },
      { label: '电话卡订单', key: 'phoneCardOrders', current: current.phoneCardOrders, previous: previous.phoneCardOrders, changePercent: change(current.phoneCardOrders, previous.phoneCardOrders) },
      { label: '话费权益', key: 'rechargeOrders', current: current.rechargeOrders, previous: previous.rechargeOrders, changePercent: change(current.rechargeOrders, previous.rechargeOrders) },
      { label: '自动下架', key: 'autoDelists', current: current.autoDelists, previous: previous.autoDelists, changePercent: change(current.autoDelists, previous.autoDelists) },
      { label: '服务分分档变化', key: 'scoreStageChanges', current: current.scoreStageChanges, previous: previous.scoreStageChanges, changePercent: change(current.scoreStageChanges, previous.scoreStageChanges) },
      { label: '整改工单', key: 'rectifyCasesCreated', current: current.rectifyCasesCreated, previous: previous.rectifyCasesCreated, changePercent: change(current.rectifyCasesCreated, previous.rectifyCasesCreated) },
      { label: '支付超时', key: 'paymentTimeouts', current: current.paymentTimeouts, previous: previous.paymentTimeouts, changePercent: change(current.paymentTimeouts, previous.paymentTimeouts) },
      { label: '支付收入', key: 'paymentInCents', current: current.paymentInCents, previous: previous.paymentInCents, changePercent: change(current.paymentInCents, previous.paymentInCents) }
      ],
      alerts
    };
  }

  // 学生也要看得到店铺服务分，否则分数只是内部指标。
  function withMerchantScore(product, merchants = []) {
    const merchant = merchants.find((item) => item.id === product.merchantId);
    const serviceScore = merchant?.serviceScore;
    return {
      ...product,
      merchantScore: serviceScore
        ? { score: serviceScore.score, grade: serviceScore.grade, gradeLabel: serviceScore.gradeLabel, stage: serviceScore.stage }
        : null
    };
  }

  // 低分商家的商品整体后置，但同档内保持原有顺序，排序结果可预期。
  function orderProductsByExposure(data, products) {
    return products
      .map((product, index) => ({ product, index, weight: merchantExposureWeight(data, product.merchantId) }))
      .sort((a, b) => b.weight - a.weight || a.index - b.index)
      .map((entry) => entry.product);
  }

  // 列表排序统一放在后端，客户端、商家端和后台看到的转化口径保持一致。
  function withProductSales(product, salesCounts) {
    return { ...product, salesCount: salesCounts.get(product.id) || 0 };
  }

  function calculateProductSalesCounts(data) {
    const salesCounts = new Map();
    for (const order of data.orders || []) {
      if (!['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(order.status)) continue;
      for (const item of order.items || []) {
        salesCounts.set(item.productId, (salesCounts.get(item.productId) || 0) + Number(item.quantity || 1));
      }
    }
    for (const order of data.phoneCardOrders || []) {
      if (!['PENDING_REALNAME', 'ACTIVATED'].includes(order.status) || !order.productId) continue;
      salesCounts.set(order.productId, (salesCounts.get(order.productId) || 0) + 1);
    }
    return salesCounts;
  }

  function calculateProductFavoriteCounts(data) {
    const favoriteCounts = new Map();
    for (const favorite of data.productFavorites || []) {
      favoriteCounts.set(favorite.productId, (favoriteCounts.get(favorite.productId) || 0) + 1);
    }
    return favoriteCounts;
  }

  function favoriteDemandText(count) {
    if (!count) return '暂无收藏需求';
    return `${count} 人收藏`;
  }

  function productRestockHint(product, salesCount, threshold, favoriteCount = 0) {
    if (availableStock(product) > threshold) return '';
    if (favoriteCount > 0) return `热销·需补货 · ${favoriteDemandText(favoriteCount)}`;
    return salesCount > 0 ? '热销·需补货' : '可售偏低';
  }

  function orderProductsForList(data, products, sort = 'recommend') {
    const salesCounts = calculateProductSalesCounts(data);
    const entries = products.map((product, index) => {
      const salesCount = salesCounts.get(product.id) || 0;
      const rating = product.ratingSummary?.average || 0.1;
      return {
        product,
        index,
        salesCount,
        ratingWeight: rating * 100 + Math.min(salesCount, 50)
      };
    });
    const sorters = {
      rating: (a, b) => b.ratingWeight - a.ratingWeight || a.index - b.index,
      price_asc: (a, b) => Number(a.product.priceInCents || 0) - Number(b.product.priceInCents || 0) || a.index - b.index,
      price_desc: (a, b) => Number(b.product.priceInCents || 0) - Number(a.product.priceInCents || 0) || a.index - b.index,
      stock: (a, b) => availableStock(a.product) - availableStock(b.product) || a.index - b.index
    };
    const ranked = sorters[sort] ? entries.sort(sorters[sort]) : entries;
    return ranked.map((entry) => withProductSales(entry.product, salesCounts));
  }

  function serviceScoreSummary(merchants = []) {
    const scored = merchants.filter((item) => item.status === 'APPROVED' && item.serviceScore);
    const byStage = (stage) => scored.filter((item) => item.serviceScore.stage === stage).length;
    return {
      scoredCount: scored.length,
      averageScore: scored.length
        ? Math.round(scored.reduce((sum, item) => sum + item.serviceScore.score, 0) / scored.length)
        : 0,
      normalCount: byStage('NORMAL'),
      limitedCount: byStage('LIMITED'),
      restrictedCount: byStage('RESTRICTED')
    };
  }

  function refreshScoresNow() {
    return store.update((data) => refreshMerchantScores(data, new Date().toISOString()));
  }

  function refreshScoreSnapshotsNow() {
    return store.update((data) => refreshMerchantScoreSnapshots(data, new Date().toISOString()));
  }

  function productComplianceMetrics(product, data) {
    const reviews = (data.productReviews || []).filter((review) => review.productId === product.id
      && review.purchaseVerified !== false
      && review.visibility !== 'HIDDEN');
    const lowRatingCount = reviews.filter((review) => Number(review.rating) <= 2).length;
    const averageRating = reviews.length
      ? reviews.reduce((sum, review) => sum + Number(review.rating || 0), 0) / reviews.length
      : 0;
    const violationCount = lowRatingCount;
    const lowReviewLimit = Math.max(1, Number(data?.adminSettings?.productComplianceLowReviewThreshold ?? 3));
    const reviewSampleLimit = Math.max(2, Number(data?.adminSettings?.productComplianceReviewSampleThreshold ?? 3));
    const averageLimit = Math.max(1, Math.min(4.5, Number(data?.adminSettings?.productComplianceAverageRatingThreshold ?? 3.5)));
    const violation = violationCount >= lowReviewLimit
      || (reviews.length >= reviewSampleLimit && averageRating > 0 && averageRating < averageLimit);
    return {
      reviewCount: reviews.length,
      lowRatingCount,
      thresholds: {
        lowReviewLimit,
        reviewSampleLimit,
        averageLimit
      },
      averageRating: Math.round(averageRating * 10) / 10,
      violationCount,
      violation
    };
  }

  function productComplianceReason(metrics) {
    const thresholds = metrics.thresholds || {};
    if (metrics.lowRatingCount >= (thresholds.lowReviewLimit || 3)) {
      return `低分评价达到 ${metrics.lowRatingCount} 条`;
    }
    return `${metrics.reviewCount} 条已购评价均分 ${metrics.averageRating}，低于 ${thresholds.averageLimit || 3.5} 分`;
  }

  function enforceProductCompliance(data, now = new Date().toISOString()) {
    const actions = [];
    for (const product of data.products || []) {
      if (!product.merchantId) continue;
      const metrics = productComplianceMetrics(product, data);
      if (metrics.violation && product.active) {
        product.active = false;
        product.autoDelistRule = 'LOW_QUALITY';
        product.autoDelistReason = productComplianceReason(metrics);
        product.autoDelistEvidence = metrics;
        product.autoDelistAt = now;
        product.autoDelistStatus = 'DELISTED';
        product.autoDelistReviewNote = '请提交整改申请，等待平台复核';
        product.autoDelistReviewUpdatedAt = now;
        if (product.publishReviewStatus === 'PENDING_REVIEW') {
          product.publishReviewStatus = 'REJECTED';
          product.publishReviewNote = '自动风控已下架：' + product.autoDelistReason;
        }
        addMerchantScoreLog(data, { id: product.merchantId, name: '' }, {
          type: 'AUTO_DELIST',
          note: `商品「${product.name}」触发低质自动下架：${product.autoDelistReason}`
        }, now);
        addAudit(data, '商品自动下架', product.name);
        notifyMerchantScore(data, product.merchantId, 'PRODUCT_AUTO_DELIST', '商品已自动下架',
          `商品「${product.name}」触发低质规则：${product.autoDelistReason}。请完成整改后联系平台复核。`, now);
        actions.push({ productId: product.id, action: 'DELIST', metrics });
      } else if (!metrics.violation && product.autoDelistRule === 'LOW_QUALITY') {
        product.active = true;
        product.autoDelistRestoredAt = now;
        product.autoDelistStatus = 'AUTO_RESTORED';
        product.autoDelistReviewNote = '整改数据达标，系统已自动恢复上架';
        product.autoDelistReviewUpdatedAt = now;
        if (product.publishReviewStatus === 'REJECTED') {
          product.publishReviewStatus = 'AUTO';
          product.publishReviewNote = '';
        }
        addMerchantScoreLog(data, { id: product.merchantId, name: '' }, {
          type: 'COMPLIANCE_RESTORED',
          note: `商品「${product.name}」整改数据达标，已自动恢复上架`
        }, now);
        addAudit(data, '低质商品自动恢复', product.name);
        notifyMerchantScore(data, product.merchantId, 'PRODUCT_COMPLIANCE_RESTORED', '商品已恢复上架',
          `商品「${product.name}」整改数据达标，已自动恢复展示。`, now);
        actions.push({ productId: product.id, action: 'RESTORE', metrics });
      }
    }
    return actions;
  }

  function createServiceScoreCase(data, merchant, payload, now) {
    const complaints = data.serviceScoreCases = data.serviceScoreCases || [];
    const caseRecord = {
      id: `case_${randomUUID()}`,
      caseNo: `SC${Date.now().toString().slice(-8)}`,
      merchantId: merchant.id,
      merchantName: merchant.name,
      userId: merchant.userId,
      type: payload.type,
      typeLabel: payload.type === 'APPEAL' ? '记录申诉' : '整改申请',
      reasonType: payload.reasonType || '',
      reasonTypeLabel: scoreComplaintTypeLabels[payload.reasonType] || '',
      reason: payload.reason,
      plan: payload.plan,
      evidence: payload.evidence,
      requestedAdjustment: payload.requestedAdjustment || 0,
      score: merchant.serviceScore?.score || 0,
      stage: merchant.serviceScore?.stage || 'NORMAL',
      status: 'SUBMITTED',
      adminNote: '',
      appliedAdjustment: 0,
      createdAt: now,
      updatedAt: now,
      dueAt: new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString(),
      timeline: [{ status: 'SUBMITTED', note: '商家已提交，等待平台复核', createdAt: now }]
    };
    complaints.unshift(caseRecord);
    data.serviceScoreCases = complaints.slice(0, 200);
    addMerchantScoreLog(data, merchant, {
      type: 'SCORE_CASE_CREATED',
      note: `${caseRecord.typeLabel}已提交：${payload.reason}`
    }, now);
    addAudit(data, '收到服务分申诉或整改申请', `${merchant.name} ${caseRecord.caseNo}`);
    if (payload.type === 'RECTIFY') {
      notifyMerchantScore(data, merchant.id, 'SCORE_RECTIFY_APPLY', '整改申请已提交',
        `${caseRecord.caseNo} 已进入平台审核，处理时限 48 小时。请同步准备整改过程材料。`);
    }
    return caseRecord;
  }

  function restoreAutoDelistedProduct(data, product, merchant, caseRecord, note, now) {
    product.active = true;
    product.autoDelistRestoredAt = now;
    product.autoDelistRestoredBy = caseRecord ? 'SCORE_CASE' : 'MANUAL_REVIEW';
    if (caseRecord) product.autoDelistRestoredCaseId = caseRecord.id;
    product.autoDelistStatus = caseRecord ? 'SCORE_CASE_RESTORED' : 'MANUAL_RESTORED';
    product.autoDelistReviewNote = caseRecord
      ? `整改工单 ${caseRecord.caseNo} 验收通过：${note}`
      : `平台人工复核通过：${note}`;
    product.autoDelistReviewUpdatedAt = now;
    if (product.publishReviewStatus === 'REJECTED') {
      product.publishReviewStatus = 'AUTO';
      product.publishReviewNote = '';
    }
    addMerchantScoreLog(data, merchant, {
      type: caseRecord ? 'SCORE_CASE_COMPLIANCE_RESTORED' : 'MANUAL_COMPLIANCE_RESTORED',
      note: product.autoDelistReviewNote
    }, now);
    addAudit(data, caseRecord ? '整改工单自动恢复上架' : '低质商品人工恢复上架', product.name);
    return product.id;
  }

  function applyServiceScoreCaseAdjustment(data, merchant, caseRecord, adjustment, now) {
    if (!Number.isInteger(adjustment) || adjustment <= 0) return;
    const previous = merchant.serviceScore || computeMerchantScore(data, merchant, now);
    merchant.serviceScore = { ...previous, manualAdjustment: previous.manualAdjustment || 0 };
    merchant.serviceScore = computeMerchantScore(data, merchant, now);
    merchant.serviceScore.appealAdjustment = Math.min(20, (merchant.serviceScore.appealAdjustment || 0) + adjustment);
    merchant.serviceScore = computeMerchantScore(data, merchant, now);
    caseRecord.appliedAdjustment = adjustment;
    addMerchantScoreLog(data, merchant, {
      type: 'SCORE_APPEAL_APPROVED',
      adjustment,
      note: `申诉核实通过，人工补分 +${adjustment}`
    }, now);
  }

function requirePositiveInteger(value, field, { max = 100000000 } = {}) {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 0 || number > max) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 格式不正确`);
    return number;
  }

  function maskIdNumber(value) {
    return value.length >= 8 ? `${value.slice(0, 4)}********${value.slice(-4)}` : '********';
  }

  function validateMockIdNumber(value) {
    if (!/^\d{17}[\dXx]$/.test(value)) return false;
    const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const checksums = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
    let sum = 0;
    for (let index = 0; index < 17; index += 1) sum += Number(value[index]) * weights[index];
    return checksums[sum % 11] === value[17].toUpperCase();
  }
  const handler = async function app(request, response) {
    const requestId = randomUUID();
    try {
      response.corsOrigin = resolveCorsOrigin(request, allowedCorsOrigins);
      if (request.method === 'OPTIONS') return sendJson(response, 204, {});
      const url = new URL(request.url, 'http://localhost');
      const pathname = url.pathname.replace(/\/$/, '') || '/';

      if (request.method === 'GET' && pathname === '/favicon.ico') {
        response.writeHead(204); response.end(); return;
      }

      // 微信云托管使用该路径探测容器是否已经就绪。
      if (request.method === 'GET' && pathname === '/tcb_probe') {
        return sendJson(response, 200, { ok: true, service: 'campus-go-mock-api', requestId });
      }

      // 公网域名默认访问根路径，跳转到运营管理端。
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(302, { location: '/admin', 'cache-control': 'no-store' });
        response.end();
        return;
      }

      if (request.method === 'GET' && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
        const publicRoot = path.join(__dirname, '..', 'public');
        const requested = pathname === '/admin' ? 'admin.html' : pathname.slice('/admin/'.length);
        const safeName = path.basename(requested);
        if (sendStatic(response, path.join(publicRoot, safeName))) return;
        throw new ApiError(404, 'ADMIN_ASSET_NOT_FOUND', 'Admin asset not found');
      }

      if (request.method === 'POST' && pathname === '/api/admin/login') {
        const body = await readJson(request);
        const now = Date.now();
        const lockKey = getAdminLoginLockKey(request, body.username);
        const lockState = getActiveAdminLoginLock(lockKey, now);
        if (lockState?.lockedUntil) {
          throw new ApiError(429, 'ADMIN_LOGIN_LOCKED', '管理员登录失败次数过多，请稍后再试', {
            retryAfterSeconds: Math.ceil((lockState.lockedUntil - now) / 1000)
          });
        }
        const adminUser = (store.read().adminUsers || [])
          .find((item) => item.username === body.username && item.status === 'ACTIVE');
        if (!adminUser || !verifyPasswordHash(body.password, adminUser.passwordHash)) {
          recordAdminLoginFailure(lockKey, now);
          throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
        }
        clearAdminLoginFailure(lockKey);
        const token = createHash('sha256').update(`${adminUser.username}:${randomUUID()}`).digest('hex');
        const expiresAt = Date.now() + 8 * 60 * 60 * 1000;
        saveAdminSession(token, adminUser.id, expiresAt);
        return sendJson(response, 200, {
          data: {
            token,
            user: {
              name: adminUser.displayName,
              username: adminUser.username,
              role: adminUser.role,
              roleLabel: adminRoleLabels[adminUser.role] || adminUser.role
            },
            expiresIn: 28800
          },
          requestId
        });
      }

      if (request.method === 'POST' && pathname === '/api/auth/login') {
        const body = await readJson(request);
        const source = String(request.headers['x-wx-source'] || '');
        const platformOpenid = String(request.headers['x-wx-openid'] || '').trim();
        let userId = '';
        if (platformOpenid && source) {
          if (!/^[A-Za-z0-9_-]{1,128}$/.test(platformOpenid)) throw new ApiError(401, 'WECHAT_LOGIN_INVALID', '平台身份标识无效');
          userId = `wx_${platformOpenid}`;
        } else {
          const code = requireString(body.code, 'code', { maxLength: 128 });
          const identity = await wechatAuth(code);
          userId = identity.userId || `wx_${identity.openid}`;
          store.update((data) => saveWeChatIdentity(data, userId, identity.openid));
        }
        if (!userId) throw new ApiError(502, 'WECHAT_LOGIN_INVALID', '微信登录返回缺少用户标识');
        const token = createHash('sha256').update(`${userId}:${randomUUID()}`).digest('hex');
        userSessions.set(token, { userId, expiresAt: Date.now() + userSessionTtlMs });
        store.update((data) => saveWeChatIdentity(data, userId, platformOpenid));
        return sendJson(response, 200, { data: { token, userId, expiresIn: 604800 }, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/auth/demo-login') {
        const userId = 'wx_demo_user';
        const token = createHash('sha256').update(`${userId}:${randomUUID()}`).digest('hex');
        userSessions.set(token, { userId, expiresAt: Date.now() + userSessionTtlMs });
        return sendJson(response, 200, { data: { token, userId, expiresIn: 604800 }, requestId });
      }

      if (pathname === '/api/order-message-subscriptions') {
        const { userId } = requireUser(request);
        if (request.method === 'GET') {
          const subscribed = (store.read().orderMessageSubscribers || []).includes(userId);
          return sendJson(response, 200, { data: { subscribed }, requestId });
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          if (body.accepted === false) {
            const result = store.update((data) => {
              data.orderMessageSubscribers = (data.orderMessageSubscribers || []).filter((item) => item !== userId);
              return { subscribed: false };
            });
            return sendJson(response, 200, { data: result, requestId });
          }
          const result = store.update((data) => {
            data.orderMessageSubscribers = Array.isArray(data.orderMessageSubscribers) ? data.orderMessageSubscribers : [];
            if (!data.orderMessageSubscribers.includes(userId)) data.orderMessageSubscribers.unshift(userId);
            return { subscribed: true };
          });
          return sendJson(response, 200, { data: result, requestId });
        }
      }

      const addressMatch = pathname.match(/^\/api\/my\/addresses\/([^/]+)$/);
      if (pathname === '/api/my/addresses' || addressMatch) {
        const { userId } = requireUser(request);
        const contactPhonePattern = /^1\d{10}$/;
        const normalizeAddress = (input = {}) => ({
          contactName: requireString(input.contactName, 'contactName', { maxLength: 40 }),
          contactPhone: requireString(input.contactPhone, 'contactPhone', { maxLength: 20 }),
          address: requireString(input.address, 'address', { maxLength: 120 }),
          campusName: typeof input.campusName === 'string' ? input.campusName.trim().slice(0, 40) : ''
        });
        const sortAddresses = (items) => [...items].sort((a, b) => {
          if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
          return b.createdAt.localeCompare(a.createdAt);
        });

        if (request.method === 'GET' && pathname === '/api/my/addresses') {
          const data = store.read();
          const items = sortAddresses((data.addresses || []).filter((item) => item.userId === userId));
          return sendJson(response, 200, { data: items, total: items.length, requestId });
        }

        if (request.method === 'POST' && pathname === '/api/my/addresses') {
          const body = await readJson(request);
          const normalized = normalizeAddress(body);
          if (!contactPhonePattern.test(normalized.contactPhone)) {
            throw new ApiError(400, 'VALIDATION_ERROR', '请输入正确的手机号');
          }
          const created = store.update((data) => {
            data.addresses ||= [];
            const userAddresses = data.addresses.filter((item) => item.userId === userId);
            if (userAddresses.length >= 10) {
              throw new ApiError(409, 'ADDRESS_LIMIT_REACHED', '最多保存 10 个常用地址');
            }
            const isDefault = body.isDefault === true || userAddresses.length === 0;
            if (isDefault) {
              for (const item of data.addresses) {
                if (item.userId === userId) item.isDefault = false;
              }
            }
            const item = {
              id: `addr_${randomUUID()}`,
              userId,
              ...normalized,
              isDefault,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString()
            };
            data.addresses.push(item);
            return item;
          });
          return sendJson(response, 201, { data: created, requestId });
        }

        if (request.method === 'POST' && addressMatch) {
          const body = await readJson(request);
          const address = body.address === undefined ? undefined : requireString(body.address, 'address', { maxLength: 120 });
          const contactName = body.contactName === undefined ? undefined : requireString(body.contactName, 'contactName', { maxLength: 40 });
          const contactPhone = body.contactPhone === undefined ? undefined : requireString(body.contactPhone, 'contactPhone', { maxLength: 20 });
          if (contactPhone !== undefined && !contactPhonePattern.test(contactPhone)) {
            throw new ApiError(400, 'VALIDATION_ERROR', '请输入正确的手机号');
          }
          const campusName = body.campusName === undefined ? undefined : String(body.campusName || '').trim().slice(0, 40);
          const updated = store.update((data) => {
            const item = (data.addresses || []).find((row) => row.id === addressMatch[1] && row.userId === userId);
            if (!item) throw new ApiError(404, 'ADDRESS_NOT_FOUND', 'Address not found');
            if (address !== undefined) item.address = address;
            if (contactName !== undefined) item.contactName = contactName;
            if (contactPhone !== undefined) item.contactPhone = contactPhone;
            if (campusName !== undefined) item.campusName = campusName;
            if (body.isDefault === true) {
              for (const row of data.addresses) {
                if (row.userId === userId) row.isDefault = false;
              }
              item.isDefault = true;
            }
            item.updatedAt = new Date().toISOString();
            return item;
          });
          return sendJson(response, 200, { data: updated, requestId });
        }

        if (request.method === 'DELETE' && addressMatch) {
          const removed = store.update((data) => {
            data.addresses ||= [];
            const before = data.addresses.length;
            data.addresses = data.addresses.filter((item) => !(item.id === addressMatch[1] && item.userId === userId));
            if (data.addresses.length === before) throw new ApiError(404, 'ADDRESS_NOT_FOUND', 'Address not found');
            const remaining = data.addresses.filter((item) => item.userId === userId);
            if (remaining.length && !remaining.some((item) => item.isDefault)) {
              const nextDefault = sortAddresses(remaining)[0];
              nextDefault.isDefault = true;
            }
            return { id: addressMatch[1] };
          });
          return sendJson(response, 200, { data: removed, requestId });
        }
      }

      if (request.method === 'POST' && pathname === '/api/uploads') {
        requireUser(request);
        const body = await readJson(request);
        const dataBase64 = requireString(body.dataBase64, 'dataBase64', { maxLength: 7000000 });
        const mimeType = requireString(body.mimeType, 'mimeType', { maxLength: 50 });
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
          throw new ApiError(400, 'VALIDATION_ERROR', '仅支持 JPG、PNG 或 WebP 图片');
        }
        const file = Buffer.from(dataBase64, 'base64');
        if (file.length < 1024 || file.length > 5 * 1024 * 1024) {
          throw new ApiError(400, 'VALIDATION_ERROR', '图片大小需在 1KB 到 5MB 之间');
        }
        const isJpeg = file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff;
        const isPng = file[0] === 0x89 && file[1] === 0x50 && file[2] === 0x4e;
        const isWebp = file.slice(0, 4).toString('ascii') === 'RIFF' && file.slice(8, 12).toString('ascii') === 'WEBP';
        if (!isJpeg && !isPng && !isWebp) throw new ApiError(400, 'VALIDATION_ERROR', '图片内容格式不正确');
        const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
        const fileName = `${randomUUID()}${extension}`;
        fs.mkdirSync(uploadsDirectory, { recursive: true });
        fs.writeFileSync(path.join(uploadsDirectory, fileName), file);
        return sendJson(response, 201, { data: { url: `/api/uploads/${fileName}`, size: file.length }, requestId });
      }

      const restockAlertMatch = pathname.match(/^\/api\/products\/([^/]+)\/restock-alert$/);
      const productFavoriteMatch = pathname.match(/^\/api\/products\/([^/]+)\/favorite$/);
      if (request.method === 'GET' && pathname === '/api/my/favorites') {
        const { userId } = requireUser(request);
        const data = store.read();
        const favoriteProductIds = new Set(
          (data.productFavorites || [])
            .filter((item) => item.userId === userId)
            .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
            .map((item) => item.productId)
        );
        const now = new Date().toISOString();
        const items = data.products
          .filter((product) => product.active && favoriteProductIds.has(product.id))
          .map((product) => withProductSale(
            withMerchantScore(
              withAvailableStock(
                withProductReviewSummary(
                  withMerchantName(product, data.merchants || []),
                  data.productReviews || []
                )
              ),
              data.merchants || []
            ),
            now
          ));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (productFavoriteMatch) {
        requireUser(request);
        if (request.method === 'GET') {
          const { userId } = requireUser(request);
          const data = store.read();
          const favorited = (data.productFavorites || []).some((item) => (
            item.productId === productFavoriteMatch[1]
            && item.userId === userId
          ));
          return sendJson(response, 200, { data: { favorited }, requestId });
        }
        if (request.method === 'POST') {
          const { userId } = requireUser(request);
          const body = await readJson(request);
          if (body.favorited === false) {
            const result = store.update((data) => {
              data.productFavorites = (data.productFavorites || []).filter((item) => !(
                item.productId === productFavoriteMatch[1] && item.userId === userId
              ));
              return { favorited: false };
            });
            return sendJson(response, 200, { data: result, requestId });
          }
          const result = store.update((data) => {
            const product = data.products.find((item) => item.id === productFavoriteMatch[1] && item.active);
            if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
            data.productFavorites = data.productFavorites || [];
            const existing = data.productFavorites.find((item) => (
              item.productId === product.id && item.userId === userId
            ));
            if (existing) {
              existing.updatedAt = new Date().toISOString();
            } else {
              const now = new Date().toISOString();
              data.productFavorites.unshift({ productId: product.id, userId, createdAt: now, updatedAt: now });
            }
            return { favorited: true };
          });
          return sendJson(response, 200, { data: result, requestId });
        }
      }

      if (request.method === 'GET' && restockAlertMatch) {
        const { userId } = requireUser(request);
        const data = store.read();
        const product = data.products.find((item) => item.id === restockAlertMatch[1] && item.active);
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        const item = (data.productRestockAlerts || []).find((row) => (
          row.productId === product.id && row.userId === userId && row.status === 'WAITING'
        ));
        return sendJson(response, 200, { data: { subscribed: Boolean(item) }, requestId });
      }

      if (request.method === 'POST' && restockAlertMatch) {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        if (body.subscribed === false) {
          const removed = store.update((data) => {
            data.productRestockAlerts ||= [];
            const before = data.productRestockAlerts.length;
            data.productRestockAlerts = data.productRestockAlerts.filter((item) => !(
              item.productId === restockAlertMatch[1] && item.userId === userId
            ));
            return { subscribed: data.productRestockAlerts.length < before ? false : Boolean(data.productRestockAlerts.some((item) => item.productId === restockAlertMatch[1] && item.userId === userId)) };
          });
          return sendJson(response, 200, { data: removed, requestId });
        }
        const result = store.update((data) => {
          const product = (data.products || []).find((item) => item.id === restockAlertMatch[1] && item.active);
          if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
          if (availableStock(product) > 0) throw new ApiError(409, 'PRODUCT_IN_STOCK', '商品当前可购，无需登记到货提醒');
          data.productRestockAlerts ||= [];
          const existing = data.productRestockAlerts.find((item) => (
            item.productId === product.id && item.userId === userId
          ));
          if (existing) {
            existing.status = 'WAITING';
            existing.notifiedAt = '';
            existing.updatedAt = new Date().toISOString();
            return existing;
          }
          const item = {
            id: `restock_${randomUUID()}`,
            productId: product.id,
            userId,
            status: 'WAITING',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            notifiedAt: ''
          };
          data.productRestockAlerts.push(item);
          return item;
        });
        return sendJson(response, 201, { data: { subscribed: true, id: result.id }, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/uploads') {
        requireAdmin(request, 'FINANCE_MANAGE');
        const body = await readJson(request);
        const dataBase64 = requireString(body.dataBase64, 'dataBase64', { maxLength: 7000000 });
        const mimeType = requireString(body.mimeType, 'mimeType', { maxLength: 50 });
        if (!['image/jpeg', 'image/png', 'image/webp'].includes(mimeType)) {
          throw new ApiError(400, 'VALIDATION_ERROR', '仅支持 JPG、PNG 或 WebP 图片');
        }
        const file = Buffer.from(dataBase64, 'base64');
        if (file.length < 1024 || file.length > 5 * 1024 * 1024) {
          throw new ApiError(400, 'VALIDATION_ERROR', '图片大小需在 1KB 到 5MB 之间');
        }
        const isJpeg = file[0] === 0xff && file[1] === 0xd8 && file[2] === 0xff;
        const isPng = file[0] === 0x89 && file[1] === 0x50 && file[2] === 0x4e;
        const isWebp = file.slice(0, 4).toString('ascii') === 'RIFF' && file.slice(8, 12).toString('ascii') === 'WEBP';
        if (!isJpeg && !isPng && !isWebp) throw new ApiError(400, 'VALIDATION_ERROR', '图片内容格式不正确');
        const extension = mimeType === 'image/png' ? '.png' : mimeType === 'image/webp' ? '.webp' : '.jpg';
        const fileName = `${randomUUID()}${extension}`;
        const receiptsDirectory = path.join(path.dirname(store.filePath), 'admin-receipts');
        fs.mkdirSync(receiptsDirectory, { recursive: true });
        fs.writeFileSync(path.join(receiptsDirectory, fileName), file);
        return sendJson(response, 201, { data: { url: `/api/admin/uploads/${fileName}`, size: file.length }, requestId });
      }

      const adminUploadMatch = pathname.match(/^\/api\/admin\/uploads\/([^/]+)$/);
      if (request.method === 'GET' && adminUploadMatch) {
        const fileName = path.basename(adminUploadMatch[1]);
        const filePath = path.join(path.dirname(store.filePath), 'admin-receipts', fileName);
        if (!fs.existsSync(filePath)) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
        const extension = path.extname(filePath).toLowerCase();
        const mimeType = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[extension] || 'application/octet-stream';
        response.writeHead(200, { 'content-type': mimeType, 'cache-control': 'private, max-age=3600' });
        response.end(fs.readFileSync(filePath));
        return;
      }

      const uploadMatch = pathname.match(/^\/api\/uploads\/([^/]+)$/);
      if (request.method === 'GET' && uploadMatch) {
        const fileName = path.basename(uploadMatch[1]);
        const filePath = path.join(uploadsDirectory, fileName);
        if (!fs.existsSync(filePath)) throw new ApiError(404, 'UPLOAD_NOT_FOUND', 'Upload not found');
        const extension = path.extname(filePath).toLowerCase();
        const mimeType = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[extension] || 'application/octet-stream';
        response.writeHead(200, { 'content-type': mimeType, 'cache-control': 'private, max-age=3600' });
        response.end(fs.readFileSync(filePath));
        return;
      }

      if (request.method === 'POST' && pathname === '/api/identity/verify') {
        const identity = requireUser(request);
        const body = await readJson(request);
        const ownerName = requireString(body.ownerName, 'ownerName', { maxLength: 40 });
        const idNumber = requireString(body.idNumber, 'idNumber', { maxLength: 18 });
        const normalizedIdNumber = idNumber.toUpperCase();
        if (!validateMockIdNumber(normalizedIdNumber)) {
          throw new ApiError(400, 'INVALID_ID_NUMBER', '身份证号格式或校验位不正确');
        }
        if (ownerName === '123' || ownerName.length > 10) throw new ApiError(400, 'ID_NAME_MISMATCH', '姓名与身份证号不一致');
        const verifiedAt = new Date().toISOString();
        const token = randomUUID();
        const maskedIdNumber = maskIdNumber(normalizedIdNumber);
        identityVerifications.set(token, {
          userId: identity.userId,
          ownerName,
          idNumber: normalizedIdNumber,
          maskedIdNumber,
          verifiedAt,
          expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString()
        });
        return sendJson(response, 200, {
          data: {
            token,
            status: 'VERIFIED',
            ownerNameMasked: `${ownerName.slice(0, 1)}${ownerName.length > 1 ? '*' : ''}`,
            idNumberMasked: maskedIdNumber,
            verifiedAt
          },
          requestId
        });
      }

      if (pathname.startsWith('/api/admin/')) {
        requireAdmin(request, adminPermissionForRequest(pathname));
      }

      if (pathname === '/api/admin/admins') {
        if (request.method === 'GET') {
          const users = (store.read().adminUsers || []).map(publicAdminUser);
          return sendJson(response, 200, { data: users, total: users.length, requestId });
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          const username = requireString(body.username, 'username', { maxLength: 32 });
          const displayName = requireString(body.displayName, 'displayName', { maxLength: 30 });
          const password = requireString(body.password, 'password', { maxLength: 128 });
          const role = requireString(body.role, 'role', { maxLength: 20 });
          if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) {
            throw new ApiError(400, 'VALIDATION_ERROR', '管理员账号仅支持 3-32 位字母、数字、下划线或短横线');
          }
          if (password.length < 12) {
            throw new ApiError(400, 'VALIDATION_ERROR', '管理员密码至少需要 12 位');
          }
          if (!adminRolePermissions[role]) {
            throw new ApiError(400, 'VALIDATION_ERROR', '不支持的管理员角色');
          }

          const created = store.update((data) => {
            data.adminUsers = Array.isArray(data.adminUsers) ? data.adminUsers : [];
            if (data.adminUsers.some((item) => item.username === username)) {
              throw new ApiError(409, 'ADMIN_USERNAME_EXISTS', '管理员账号已存在');
            }
            const now = new Date().toISOString();
            const user = {
              id: `admin_${randomUUID()}`,
              username,
              displayName,
              passwordHash: hashPassword(password),
              role,
              status: 'ACTIVE',
              createdAt: now,
              updatedAt: now
            };
            data.adminUsers.push(user);
            addAudit(data, '新增管理员', `${displayName} ${adminRoleLabels[role] || role}`);
            return publicAdminUser(user);
          });
          return sendJson(response, 201, { data: created, requestId });
        }
      }

      const adminUserMatch = pathname.match(/^\/api\/admin\/admins\/([^/]+)$/);
      if (request.method === 'PATCH' && adminUserMatch) {
        const body = await readJson(request);
        const actor = requireAdmin(request, 'ADMIN_MANAGE');
        const updated = store.update((data) => {
          const user = (data.adminUsers || []).find((item) => item.id === adminUserMatch[1]);
          if (!user) throw new ApiError(404, 'ADMIN_NOT_FOUND', '管理员不存在');

          if (body.displayName !== undefined) {
            user.displayName = requireString(body.displayName, 'displayName', { maxLength: 30 });
          }
          if (body.role !== undefined) {
            const role = requireString(body.role, 'role', { maxLength: 20 });
            if (!adminRolePermissions[role]) throw new ApiError(400, 'VALIDATION_ERROR', '不支持的管理员角色');
            user.role = role;
          }
          if (body.status !== undefined) {
            if (!['ACTIVE', 'DISABLED'].includes(body.status)) {
              throw new ApiError(400, 'VALIDATION_ERROR', '管理员状态仅支持 ACTIVE 或 DISABLED');
            }
            if (user.id === actor.id && body.status === 'DISABLED') {
              throw new ApiError(400, 'VALIDATION_ERROR', '不能停用当前登录的超级管理员');
            }
            user.status = body.status;
          }
          if (body.password !== undefined) {
            const password = requireString(body.password, 'password', { maxLength: 128 });
            if (password.length < 12) throw new ApiError(400, 'VALIDATION_ERROR', '管理员密码至少需要 12 位');
            user.passwordHash = hashPassword(password);
          }
          user.updatedAt = new Date().toISOString();
          addAudit(data, '更新管理员', `${user.displayName} ${adminRoleLabels[user.role] || user.role}`);
          return publicAdminUser(user);
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (request.method === 'GET' && pathname === '/health') {
        const dbExists = fs.existsSync(store.filePath);
        return sendJson(response, 200, { ok: true, service: 'campus-go-mock-api', dbFile: store.filePath, dbExists, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/products') {
        await sweepExpiredOrders();
        sweepOperationsPatrol();
        refreshScoresNow();
        const data = store.read();
        const products = data.products;
        const category = url.searchParams.get('category');
        const campusId = url.searchParams.get('campusId');
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const items = products.filter((product) => product.active)
          .filter((product) => !category || product.category === category)
          .filter((product) => !campusId || product.campusIds.includes(campusId))
          .filter((product) => !query || `${product.name} ${product.description}`.toLowerCase().includes(query));
        // 服务分低的商家整体后置，让好服务真的能换到曝光。
        const sort = url.searchParams.get('sort') || 'recommend';
        if (!['recommend', 'rating', 'price_asc', 'price_desc', 'stock'].includes(sort)) {
          throw new ApiError(400, 'VALIDATION_ERROR', '排序方式不支持');
        }
        const summarized = items.map((product) => withProductReviewSummary(
          withMerchantName(product, data.merchants || []), data.productReviews || []
        ));
        const ranked = sort === 'recommend'
          ? orderProductsByExposure(data, summarized)
          : orderProductsForList(data, summarized, sort);
        const salesCounts = calculateProductSalesCounts(data);
        const now = new Date().toISOString();
        return sendJson(response, 200, {
          data: ranked.map((product) => withProductSale(withMerchantScore(
            withAvailableStock(withProductSales(product, salesCounts)), data.merchants || []
          ), now)),
          total: ranked.length,
          requestId
        });
      }

      if (request.method === 'GET' && pathname === '/api/recharge-promos') {
        const now = new Date().toISOString();
        const items = (store.read().rechargePromos || [])
          .filter((item) => item.active !== false && rechargePromoAvailability(item, now).status === 'ACTIVE')
          .map((item) => publicRechargePromo(item, store.read(), now));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/business-config') {
        return sendJson(response, 200, { data: publicSettings(store.read().adminSettings), requestId });
      }

      if (request.method === 'GET' && pathname === '/api/subscribe-templates') {
        const settings = store.read().adminSettings || {};
        const configuredIds = {
          score_stage_warning: settings.scoreStageWarningTemplateId || '',
          score_rectify_apply: settings.scoreRectifyApplyTemplateId || '',
          score_rectify_result: settings.scoreRectifyResultTemplateId || '',
          score_appeal_result: settings.scoreAppealResultTemplateId || ''
          ,product_auto_delist: settings.productAutoDelistTemplateId || '',
          product_compliance_restored: settings.productComplianceRestoredTemplateId || '',
          stock_low_stock: settings.stockLowStockTemplateId || '',
          sla_warning: settings.slaWarningTemplateId || ''
        };
        const configuredUserIds = {
          lead_follow_up: settings.leadFollowUpTemplateId || '',
          favorite_price_notice: settings.favoritePriceNoticeTemplateId || '',
          order_status: settings.orderStatusTemplateId || '',
          order_service: settings.orderServiceTemplateId || '',
          restock_notice: settings.restockNoticeTemplateId || '',
          after_sale: settings.afterSaleTemplateId || ''
        };
        const data = [
          ...Object.entries(scoreNotificationTemplates).map(([key, item]) => ({
            key,
            id: item.id,
            audience: 'MERCHANT',
            description: item.description,
            configuredId: configuredIds[item.id] || ''
          })),
          ...Object.entries(orderNotificationTemplates).map(([key, item]) => ({
            key,
            id: item.id,
            audience: 'USER',
            description: item.description,
            configuredId: configuredUserIds[item.id] || ''
          }))
        ];
        return sendJson(response, 200, { data, total: data.length, requestId });
      }

      const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (request.method === 'GET' && productMatch) {
        await sweepExpiredOrders();
        refreshScoresNow();
        const data = store.read();
        const product = data.products.find((item) => item.id === productMatch[1] && item.active);
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        const now = new Date().toISOString();
        const settings = publicSettings(data.adminSettings);
        const relatedProducts = orderProductsByExposure(data, data.products
          .filter((item) => item.active && item.id !== product.id && item.category === product.category)
        )
        .slice(0, 3)
          .map((item) => withProductSale(withMerchantScore(withAvailableStock(withProductReviewSummary(withMerchantName(item, data.merchants || []), data.productReviews || [])), data.merchants || []), now));
        const productMerchant = (data.merchants || []).find((item) => item.id === product.merchantId);
        const enrichedProduct = withProductSale(withMerchantScore(
          withAvailableStock(
            withProductReviewSummary(withMerchantName(product, data.merchants || []), data.productReviews || [])
          ),
          data.merchants || []
        ), now);
        enrichedProduct.serviceArea = productMerchant?.serviceArea || '华中农业大学狮山校区';
        const storeProfile = productStoreProfile(enrichedProduct, {
          deliveryResponseHours: settings.deliveryResponseHours,
          soldCount: productSalesCount(data, product.id)
        });
        storeProfile.merchantId = productMerchant?.id || '';
        return sendJson(response, 200, {
          data: {
            ...enrichedProduct,
            storeProfile,
            merchantServiceScore: productMerchant?.serviceScore
              ? {
                score: productMerchant.serviceScore.score,
                grade: productMerchant.serviceScore.grade,
                gradeLabel: productMerchant.serviceScore.gradeLabel,
                stage: productMerchant.serviceScore.stage,
                stageLabel: productMerchant.serviceScore.stageLabel,
                onTimeRate: productMerchant.serviceScore.metrics?.completedOrderCount
                  ? Math.round((productMerchant.serviceScore.metrics.onTimeCount / productMerchant.serviceScore.metrics.completedOrderCount) * 100)
                  : null,
                reviewCount: productMerchant.serviceScore.metrics?.reviewCount || 0,
                averageRating: productMerchant.serviceScore.metrics?.averageRating || 0
              }
              : null,
            reviews: (data.productReviews || [])
              .filter((review) => review.productId === product.id && review.visibility !== 'HIDDEN' && review.purchaseVerified !== false)
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
              .slice(0, 5)
              .map((review) => ({
                id: review.id,
                rating: Number(review.rating) || 0,
                content: review.content,
                customerName: review.customerName,
                college: review.college,
                purchaseVerified: review.purchaseVerified !== false,
                images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
                reply: review.reply || null,
                createdAt: review.createdAt
              }))
            ,
            relatedProducts
            ,
            settings
          },
          requestId
        });
      }

      // 云托管网关会把未带尾斜杠的 /api/products 转发成 /api/products/，
      // 这里统一归一化，避免商品列表和下单链路出现网关路径差异。
      if (request.method === 'GET' && request.url.startsWith('/api/products/')) {
        const normalized = new URL('/api/products' + (request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : ''), 'http://localhost');
        request.url = normalized.pathname + normalized.search;
        return handler(request, response);
      }

      if (request.method === 'POST' && pathname === '/api/product-reviews') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const orderId = requireString(body.orderId, 'orderId', { maxLength: 100 });
        const productId = requireString(body.productId, 'productId', { maxLength: 100 });
        const rating = Number(body.rating);
        const content = requireString(body.content, 'content', { maxLength: 500 });
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw new ApiError(400, 'VALIDATION_ERROR', 'rating must be an integer between 1 and 5');
        const images = Array.isArray(body.images) ? body.images.slice(0, 3).map((image) => String(image || '').trim()) : [];
        if (images.some((image) => !image.startsWith('/api/uploads/'))) throw new ApiError(400, 'VALIDATION_ERROR', '评价图片必须来自平台上传目录');
        const review = store.update((data) => {
          const order = data.orders.find((item) => item.id === orderId && item.userId === userId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (order.status !== 'COMPLETED') throw new ApiError(409, 'ORDER_NOT_COMPLETED', 'Only completed orders can be reviewed');
          if (!order.items.some((item) => item.productId === productId)) throw new ApiError(404, 'PRODUCT_NOT_IN_ORDER', 'Product not found in order');
          const records = data.productReviews = data.productReviews || [];
          if (records.some((item) => item.orderId === orderId && item.productId === productId)) {
            throw new ApiError(409, 'REVIEW_ALREADY_EXISTS', 'This order product has already been reviewed');
          }
          const now = new Date().toISOString();
          const record = {
            id: `review_${randomUUID()}`,
            orderId,
            productId,
            userId,
            rating,
            content,
            customerName: '校园同学',
            college: '华中农业大学',
            purchaseVerified: true,
            visibility: 'PUBLISHED',
            images,
            reply: null,
            createdAt: now
          };
          records.unshift(record);
          addAudit(data, '新增已购商品评价', productId);
          return record;
        });
        return sendJson(response, 201, {
          data: {
            id: review.id,
            orderId: review.orderId,
            productId: review.productId,
            rating: review.rating,
            content: review.content,
            purchaseVerified: review.purchaseVerified,
            visibility: review.visibility,
            images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
            reply: review.reply || null,
            createdAt: review.createdAt
          },
          requestId
        });
      }

      if (request.method === 'POST' && pathname === '/api/order-collab') {
        const body = await readJson(request);
        const role = body.role || 'USER';
        const action = requireString(body.action, 'action', { maxLength: 40 });
        const orderId = requireString(body.orderId, 'orderId', { maxLength: 80 });
        const note = requireString(body.note, 'note', { maxLength: 300 });
        if (!['USER','MERCHANT','PLATFORM'].includes(role)) throw new ApiError(400,'VALIDATION_ERROR','Unsupported role');
        const userSession = role === 'USER' ? requireUser(request) : null;
        if (role === 'USER' && body.userId && body.userId !== userSession.userId) {
          throw new ApiError(403, 'ORDER_FORBIDDEN', '不能以其他用户身份提交订单消息');
        }
        if (role === 'MERCHANT') requireMerchant(request);
        if (role === 'PLATFORM') {
          requireAdmin(request);
        }
        const serviceRecordMatch = serviceRecordOwner(store.read(), orderId);
        if (serviceRecordMatch && ['USER', 'PLATFORM'].includes(role)) {
          const serviceResult = store.update((data) => {
            const match = serviceRecordOwner(data, orderId);
            const item = match?.item;
            if (!item) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
            if (role === 'USER' && item.userId !== userSession.userId) throw new ApiError(403, 'ORDER_FORBIDDEN', '无权操作该服务单');
            if (role === 'USER' && !['NOTE', 'APPEAL'].includes(action)) {
              throw new ApiError(409, 'ACTION_NOT_ALLOWED', '当前服务单不支持该用户动作');
            }
            if (role === 'PLATFORM' && !['NOTE', 'INTERVENE', 'RESOLVE'].includes(action)) {
              throw new ApiError(409, 'ACTION_NOT_ALLOWED', '当前服务单不支持该平台动作');
            }
            appendServiceRecordEvent(item, role, action, note);
            if (action === 'APPEAL' || (role === 'PLATFORM' && action === 'INTERVENE')) {
              item.collaboration.intervention = { status: 'REQUESTED', note, updatedAt: new Date().toISOString() };
              addAudit(data, role === 'USER' ? '用户申请平台协助服务单' : '平台介入服务单', item.id);
            } else if (role === 'PLATFORM' && action === 'RESOLVE') {
              item.collaboration.intervention = { status: 'RESOLVED', note, updatedAt: new Date().toISOString() };
          sendOrderNotification(data, item.userId, 'ORDER_SERVICE', '平台已处理服务单', note, item.updatedAt, { focusId: item.id });
              addAudit(data, '平台处理服务单', item.id);
            } else if (role === 'PLATFORM') {
          sendOrderNotification(data, item.userId, 'ORDER_SERVICE', '平台已回复服务单', note, item.updatedAt, { focusId: item.id });
              addAudit(data, '平台回复服务单', item.id);
            } else {
              addAudit(data, '用户提交服务单咨询', item.id);
            }
            return item;
          });
          return sendJson(response, 200, { data: serviceResult, requestId });
        }
        const order = store.update((data) => {
          const item = data.orders.find((row) => row.id === orderId);
          if (!item) throw new ApiError(404,'ORDER_NOT_FOUND','Order not found');
          if (role === 'USER' && item.userId !== userSession.userId) throw new ApiError(403,'ORDER_FORBIDDEN','无权操作该订单');
          item.collaboration ||= createCollaboration(item, item.items[0]?.merchantId || '');
          if (role === 'MERCHANT') {
            const merchant = (data.merchants||[]).find(row=>row.id===merchantSessions.get((request.headers.authorization||'').replace(/^Bearer\s+/i,''))?.merchantId);
            if (!merchant || merchant.id !== item.collaboration.merchantId) throw new ApiError(403,'ORDER_FORBIDDEN','无权操作该订单');
            if (action === 'ACCEPT' && item.status === 'PAID') item.status = 'FULFILLING';
            else if (action === 'COMPLETE' && item.status === 'FULFILLING') {
              const providedCode = typeof body.deliveryCode === 'string' ? requireString(body.deliveryCode, 'deliveryCode', { maxLength: 6 }) : '';
              if (!item.deliveryCode || providedCode !== item.deliveryCode) {
                throw new ApiError(409, 'DELIVERY_CODE_INVALID', '交付码不正确，请向用户确认后完成订单');
              }
              item.status = 'COMPLETED';
              activateOrderSettlements(data, item, new Date().toISOString());
            }
            else if (!['CONTACT','NOTE'].includes(action)) throw new ApiError(409,'ACTION_NOT_ALLOWED','当前状态不支持该商家动作');
          }
          if (role === 'USER' && item.collaboration.merchantId) {
            notifyOrderMerchant(data, item, 'ORDER', `订单 ${item.orderNo} 有新用户留言`, note);
          } else if (role === 'MERCHANT' && item.userId) {
          sendOrderNotification(data, item.userId, 'ORDER_SERVICE', `订单 ${item.orderNo} 有新商家留言`, note, item.updatedAt, { focusId: item.id });
          } else if (role === 'PLATFORM') {
            notifyOrderMerchant(data, item, 'ORDER', `平台已介入订单 ${item.orderNo}`, note);
          sendOrderNotification(data, item.userId, 'ORDER_SERVICE', `平台已处理订单 ${item.orderNo}`, note, item.updatedAt, { focusId: item.id });
          }
          if (role === 'PLATFORM' && action === 'INTERVENE') item.collaboration.intervention = { status:'REQUESTED', note, updatedAt:new Date().toISOString() };
          if (role === 'PLATFORM' && action === 'RESOLVE') item.collaboration.intervention = { status:'RESOLVED', note, updatedAt:new Date().toISOString() };
          if (role === 'USER' && action === 'APPEAL') item.collaboration.intervention = { status:'REQUESTED', note, updatedAt:new Date().toISOString() };
          const eventNote = role === 'MERCHANT' ? (action === 'ACCEPT' ? '商家已确认履约' : action === 'COMPLETE' ? '商家已核验交付码，订单已完成' : note) : note;
          appendCollaborationEvent(item, role, action, eventNote);
          addAudit(data, `${role}订单协同动作：${action}`, item.orderNo);
          return item;
        });
        return sendJson(response,200,{data:order,requestId});
      }

      if (request.method === 'POST' && pathname === '/api/merchants') {
        const identity = requireUser(request);
        const body = await readJson(request);
        const merchantType = requireString(body.merchantType, 'merchantType', { maxLength: 20 });
        if (!allowedMerchantTypes.has(merchantType)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported merchant type');
        const name = requireString(body.name, 'name', { maxLength: 80 });
        if (name.length < 2) throw new ApiError(400, 'VALIDATION_ERROR', '店铺名称至少 2 个字符');
        const ownerName = requireString(body.ownerName, 'ownerName', { maxLength: 40 });
        if (ownerName.length < 2) throw new ApiError(400, 'VALIDATION_ERROR', '经营者姓名至少 2 个字符');
        const phone = requireString(body.phone, 'phone', { maxLength: 20 });
        if (!/^1\d{10}$/.test(phone)) throw new ApiError(400, 'VALIDATION_ERROR', 'phone 格式不正确');
        const category = requireString(body.category, 'category', { maxLength: 30 });
        if (!allowedMerchantCategories.has(category)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported merchant category');
        const serviceArea = requireString(body.serviceArea, 'serviceArea', { maxLength: 100 });
        const description = requireString(body.description, 'description', { maxLength: 300 });
        const settlementAccountName = requireString(body.settlementAccountName, 'settlementAccountName', { maxLength: 80 });
        const settlementBank = requireString(body.settlementBank, 'settlementBank', { maxLength: 80 });
        const settlementAccount = requireString(body.settlementAccount, 'settlementAccount', { maxLength: 40 }).replace(/\s+/g, '');
        if (!/^\d{9,32}$/.test(settlementAccount)) throw new ApiError(400, 'VALIDATION_ERROR', '收款账户格式不正确');
        const licenseNo = merchantType === 'PERSONAL'
          ? (typeof body.licenseNo === 'string' ? body.licenseNo.trim() : '')
          : requireString(body.licenseNo, 'licenseNo', { maxLength: 30 });
        if (licenseNo && !/^[0-9A-Z]{15,18}$/.test(licenseNo)) throw new ApiError(400, 'VALIDATION_ERROR', 'licenseNo 格式不正确');
        const licenseUrl = merchantType === 'PERSONAL'
          ? (typeof body.licenseUrl === 'string' ? body.licenseUrl.trim() : '')
          : requireString(body.licenseUrl, 'licenseUrl', { maxLength: 200 });
        const licenseExpireDate = normalizeQualificationExpireDate(body.licenseExpireDate);
        if (body.agreeAgreement !== true || body.agreePrivacy !== true) {
          throw new ApiError(400, 'VALIDATION_ERROR', '请先同意入驻协议和隐私保护指引');
        }
        const identityVerificationToken = merchantType === 'PERSONAL' ? requireString(body.identityVerificationToken, 'identityVerificationToken', { maxLength: 80 }) : '';
        if (identityVerificationToken) {
          const verification = identityVerifications.get(identityVerificationToken);
          if (!verification || verification.userId !== identity.userId || verification.ownerName !== ownerName || verification.expiresAt < new Date().toISOString()) {
            throw new ApiError(400, 'IDENTITY_VERIFICATION_INVALID', '实名验证无效，请重新验证');
          }
        } else if (merchantType === 'PERSONAL') {
          throw new ApiError(400, 'IDENTITY_VERIFICATION_REQUIRED', '请先完成模拟实名验证');
        }

        const existing = store.read().merchants?.find((item) => item.userId === identity.userId && item.status !== 'REJECTED');
        if (existing) {
          return sendJson(response, 200, { data: merchantPublic(existing), idempotent: true, message: '您已有入驻申请', requestId });
        }

        const application = store.update((data) => {
          const record = {
            id: `merchant_${randomUUID()}`,
            applicationNo: `MC${Date.now()}`,
            userId: identity.userId,
            merchantType,
            name: requireString(body.name, 'name', { maxLength: 80 }),
            ownerName: requireString(body.ownerName, 'ownerName', { maxLength: 40 }),
            phone,
            licenseNo,
            licenseUrl,
            licenseExpireDate,
            category,
            serviceArea,
            description,
            settlementAccountName,
            settlementBank,
            settlementAccount,
            status: 'REVIEWING',
            reviewNote: '',
            identityVerification: merchantType === 'PERSONAL' ? {
              status: 'VERIFIED',
              ownerNameMasked: `${ownerName.slice(0, 1)}${ownerName.length > 1 ? '*' : ''}`,
              idNumberMasked: identityVerifications.get(identityVerificationToken)?.maskedIdNumber || '',
              verifiedAt: identityVerifications.get(identityVerificationToken)?.verifiedAt || new Date().toISOString()
            } : null,
            timeline: [{ status: 'REVIEWING', note: '商家入驻申请已提交', createdAt: new Date().toISOString() }],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          data.merchants.unshift(record);
          addAudit(data, '新增商家入驻申请', record.name);
          return record;
        });
        return sendJson(response, 201, { data: merchantPublic(application), requestId });
      }

      if (request.method === 'GET' && pathname === '/api/merchants') {
        const identity = requireUser(request);
        const items = (store.read().merchants || [])
          .filter((item) => item.userId === identity.userId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
          .map(merchantPublic);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      const merchantStorefrontMatch = pathname.match(/^\/api\/merchants\/([^/]+)\/storefront$/);
      if (request.method === 'GET' && merchantStorefrontMatch) {
        refreshScoresNow();
        const data = store.read();
        const merchant = (data.merchants || []).find((item) => (
          item.id === merchantStorefrontMatch[1] && item.status === 'APPROVED'
        ));
        if (!merchant) throw new ApiError(404, 'STOREFRONT_NOT_FOUND', '店铺不存在或未通过平台核准');
        const settings = publicSettings(data.adminSettings);
        const salesCounts = calculateProductSalesCounts(data);
        const now = new Date().toISOString();
        const products = data.products
          .filter((product) => product.active && product.merchantId === merchant.id)
          .map((product) => withProductReviewSummary(
            withMerchantName(product, data.merchants || []), data.productReviews || []
          ))
          .map((product) => withProductSale(withMerchantScore(
            withAvailableStock(withProductSales(product, salesCounts)), data.merchants || []
          ), now));
      const rankedProducts = orderProductsByExposure(data, products);
      const storefrontReviews = publicStorefrontReviews(data, merchant.id);
      return sendJson(response, 200, {
        data: {
            merchant: {
              id: merchant.id,
              name: merchant.name,
              description: merchant.description || '专注狮山校区的校内商品与服务',
              serviceArea: merchant.serviceArea || settings.campusName,
              serviceScore: merchant.serviceScore || null,
              createdAt: merchant.createdAt || ''
            },
            productCount: products.length,
            totalSalesCount: products.reduce((sum, product) => sum + Number(product.salesCount || 0), 0),
            deliveryResponseHours: settings.deliveryResponseHours,
            products: rankedProducts,
            reviewSummary: storefrontReviews.summary,
            reviews: storefrontReviews.items
          },
          requestId
        });
      }

      // 资质被驳回的商家必须能补充平台可核验的材料并进入复审，否则被驳回就变成死单。
      const merchantResubmitMatch = pathname.match(/^\/api\/merchants\/([^/]+)\/resubmit$/);
      if (request.method === 'POST' && merchantResubmitMatch) {
        const identity = requireUser(request);
        const body = await readJson(request);
        const licenseNo = typeof body.licenseNo === 'string' && body.licenseNo.trim()
          ? requireString(body.licenseNo, 'licenseNo', { maxLength: 30 })
          : '';
        if (licenseNo && !/^[0-9A-Z]{15,18}$/.test(licenseNo)) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'licenseNo 格式不正确');
        }
        const licenseUrl = typeof body.licenseUrl === 'string' && body.licenseUrl.trim()
          ? requireString(body.licenseUrl, 'licenseUrl', { maxLength: 200 })
          : '';
        const licenseExpireDate = normalizeQualificationExpireDate(body.licenseExpireDate);
        if (licenseUrl && !licenseUrl.startsWith('/api/uploads/')) {
          throw new ApiError(400, 'VALIDATION_ERROR', '资质图片必须来自平台上传目录');
        }
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
        const merchant = store.update((data) => {
          const item = (data.merchants || []).find((row) => row.id === merchantResubmitMatch[1] && row.userId === identity.userId);
          if (!item) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          if (item.status !== 'REJECTED') {
            throw new ApiError(409, 'MERCHANT_NOT_REJECTED', '仅被驳回的商家可以补充资料复审');
          }
          if (!licenseUrl) throw new ApiError(400, 'VALIDATION_ERROR', '请上传新的资质图片');
          if (item.merchantType === 'INDIVIDUAL') {
            const currentLicenseNo = licenseNo || item.licenseNo || '';
            if (!/^[0-9A-Z]{15,18}$/.test(currentLicenseNo)) {
              throw new ApiError(400, 'VALIDATION_ERROR', 'licenseNo 格式不正确');
            }
            item.licenseNo = currentLicenseNo;
          } else if (licenseNo) {
            item.licenseNo = licenseNo;
          }
          item.licenseUrl = licenseUrl;
          if (licenseExpireDate) item.licenseExpireDate = licenseExpireDate;
          for (const [field, key] of [
            ['settlementAccountName', 'settlementAccountName'],
            ['settlementBank', 'settlementBank'],
            ['settlementAccount', 'settlementAccount']
          ]) {
            if (body[field] !== undefined) {
              const value = requireString(body[field], field, { maxLength: 80 });
              item[key] = field === 'settlementAccount' ? value.replace(/\s+/g, '') : value;
            }
          }
          if (item.settlementAccount && !/^\d{9,32}$/.test(item.settlementAccount)) {
            throw new ApiError(400, 'VALIDATION_ERROR', '收款账号格式不正确');
          }
          if (!item.settlementAccountName || !item.settlementBank || !item.settlementAccount) {
            throw new ApiError(400, 'VALIDATION_ERROR', '收款账户资料不完整');
          }
          const now = new Date().toISOString();
          item.status = 'REVIEWING';
          item.reviewNote = '商家已补充资质，等待平台复审';
          item.resubmitCount = Number(item.resubmitCount || 0) + 1;
          item.resubmittedAt = now;
          item.timeline = item.timeline || [];
          item.timeline.push({
            status: 'REVIEWING',
            note: note ? `商家已补充资质并申请复审：${note}` : '商家已补充资质并申请复审',
            createdAt: now
          });
          item.updatedAt = now;
          addAudit(data, '商家补充资质申请复审', item.name);
          return item;
        });
        return sendJson(response, 200, { data: merchantPublic(merchant), requestId });
      }

      if (request.method === 'POST' && pathname === '/api/merchant/login') {
        const identity = requireUser(request);
        const body = await readJson(request);
        const merchantId = requireString(body.merchantId, 'merchantId', { maxLength: 80 });
        const merchant = store.read().merchants?.find((item) => item.id === merchantId && item.userId === identity.userId);
        if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号尚未通过审核');
        const token = randomUUID();
        merchantSessions.set(token, { merchantId, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return sendJson(response, 200, { data: { token, merchant: merchantPublic(merchant), expiresIn: 28800 }, requestId });
      }

      if (pathname.startsWith('/api/merchant/')) {
        var merchantSession = requireMerchant(request);
      }

      // 商家定期上传新执照，平台审核通过后才更新正式资质。
      if (request.method === 'POST' && pathname === '/api/merchant/qualification-renewals') {
        const body = await readJson(request);
        const licenseNo = requireString(body.licenseNo, 'licenseNo', { maxLength: 30 });
        if (!/^[0-9A-Z]{15,18}$/.test(licenseNo)) throw new ApiError(400, 'VALIDATION_ERROR', 'licenseNo 格式不正确');
        const licenseUrl = requireString(body.licenseUrl, 'licenseUrl', { maxLength: 200 });
        if (!licenseUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '资质图片必须来自平台上传目录');
        const licenseExpireDate = normalizeQualificationExpireDate(body.licenseExpireDate);
        if (!licenseExpireDate) throw new ApiError(400, 'VALIDATION_ERROR', '请填写资质有效期');
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
        const renewal = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号不可用');
          data.qualificationRenewals ||= [];
          if (data.qualificationRenewals.some((item) => item.merchantId === merchant.id && item.status === 'PENDING_REVIEW')) {
            throw new ApiError(409, 'QUALIFICATION_RENEWAL_EXISTS', '已有资质复审申请待平台审核');
          }
          const now = new Date().toISOString();
          const record = {
            id: `qual_${randomUUID()}`,
            merchantId: merchant.id,
            merchantName: merchant.name,
            merchantUserId: merchant.userId,
            licenseNo,
            licenseUrl,
            licenseExpireDate,
            note,
            status: 'PENDING_REVIEW',
            reviewNote: '',
            reviewedAt: '',
            createdAt: now,
            updatedAt: now
          };
          data.qualificationRenewals.unshift(record);
          addAudit(data, '商家提交资质复审', `${merchant.name} ${licenseExpireDate}`);
          notifyMerchant(data, merchant.id, 'SCORE', '资质复审已提交', `新执照有效期 ${licenseExpireDate}，平台审核通过后会更新店铺资质。`);
          return record;
        });
        return sendJson(response, 201, { data: renewal, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/merchant/overview') {
        await sweepExpiredOrders();
        sweepMaturedSettlements();
        sweepOperationsPatrol();
        refreshScoresNow();
        refreshScoreSnapshotsNow();
        const data = store.read();
        const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
        if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
        data.products
          .filter((item) => item.merchantId === merchant.id)
          .forEach((item) => evaluateLowStockAlert(data, item, new Date().toISOString()));
        store.write(data);
        const products = data.products.filter((item) => item.merchantId === merchant.id);
        const stockThreshold = lowStockThreshold(data);
        const productSalesCounts = calculateProductSalesCounts(data);
        const productFavoriteCounts = calculateProductFavoriteCounts(data);
        const merchantFavoriteCount = products.reduce((sum, product) => (
          sum + (productFavoriteCounts.get(product.id) || 0)
        ), 0);
        const complianceCases = (data.serviceScoreCases || [])
          .filter((item) => item.merchantId === merchant.id && item.productId);
        const merchantProductIds = new Set(products.map((product) => product.id));
        const reviews = (data.productReviews || [])
          .filter((review) => merchantProductIds.has(review.productId))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, 50)
          .map((review) => ({
            id: review.id,
            orderId: review.orderId,
            productId: review.productId,
            productName: products.find((product) => product.id === review.productId)?.name || review.productId,
            rating: review.rating,
            content: review.content,
            customerName: review.customerName,
            college: review.college,
            purchaseVerified: review.purchaseVerified !== false,
            visibility: review.visibility || 'PUBLISHED',
            images: Array.isArray(review.images) ? review.images.slice(0, 3) : [],
            reply: review.reply || null,
            createdAt: review.createdAt
          }));
            const orders = data.orders
              .filter((order) => order.items.some((item) => merchantProductIds.has(item.productId) || item.merchantId === merchant.id))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const enrichedOrders = orders.map((order) => ({
          ...sanitizeOrderForMerchant(order),
          merchantName: merchant.name,
          collaboration: order.collaboration || createCollaboration(order, merchant.id)
        }));
        const settlements = (data.settlements || []).filter((item) => item.merchantId === merchant.id);
        const payoutRequests = (data.payoutRequests || [])
          .filter((item) => item.merchantId === merchant.id)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const settlementMetrics = {
          commissionRatePercent: Number(data.adminSettings?.commissionRatePercent ?? 2),
          settlementPeriodDays: settlementPeriodDays(data),
          payoutMinimumInCents: payoutMinimumInCents(data),
          pendingPayoutRequest: payoutRequests.find((item) => item.status === 'PENDING_REVIEW') || null,
          ...settlementSummary(settlements)
        };
        const afterSales = (data.afterSales || []).filter((record) => orders.some((order) => order.id === record.orderId));
        const qualificationRenewals = (data.qualificationRenewals || [])
          .filter((record) => record.merchantId === merchant.id)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        // 商家只看得到需要自己处理的超时预警，平台内部事项不下发。
        const slaAlerts = (data.slaAlerts || [])
          .filter((alert) => alert.status !== 'RESOLVED' && alert.ownerRole === 'MERCHANT' && alert.merchantId === merchant.id)
          .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
        const revenueInCents = orders.filter((order) => ['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(order.status))
          .reduce((sum, order) => sum + (order.totalInCents || 0), 0);
        return sendJson(response, 200, {
          data: {
            merchant: merchantPublic(merchant),
            serviceScore: merchant.serviceScore || null,
            scoreTrend: merchantScoreTrend(data, merchant.id),
            riskTasks: merchantRiskTasks(afterSales, slaAlerts, reviews, products, stockThreshold),
            lowStockThreshold: stockThreshold,
            scoreCases: (data.serviceScoreCases || []).filter((item) => item.merchantId === merchant.id),
            qualificationRenewals,
            metrics: {
              revenueInCents,
              orderCount: orders.length,
              pendingCount: orders.filter((order) => ['PAID', 'FULFILLING'].includes(order.status)).length,
              afterSaleCount: afterSales.filter((record) => record.status !== 'CLOSED').length,
              productCount: products.length,
              lowStockCount: products.filter((product) => product.active !== false && availableStock(product) <= stockThreshold).length,
              afterSaleOverdueCount: afterSales.filter((record) => record.status !== 'CLOSED' && record.responseDueAt && record.responseDueAt < new Date().toISOString()).length,
              reviewCount: reviews.length,
              pendingReplyCount: reviews.filter((review) => !review.reply).length,
              slaOpenCount: slaAlerts.length,
              slaOverdueCount: slaAlerts.filter((alert) => alert.level === 'OVERDUE').length,
              favoriteCount: merchantFavoriteCount,
              favoriteDemandText: favoriteDemandText(merchantFavoriteCount),
              settlementMetrics
            },
            products: products.map((product) => {
            const complianceCase = complianceCases.find((item) => item.productId === product.id
                && item.id === product.autoDelistCaseId);
            const salesCount = productSalesCounts.get(product.id) || 0;
            const favoriteCount = productFavoriteCounts.get(product.id) || 0;
            const campaign = withProductSale(product);
            const campaignMetrics = productPromotionOrderMetrics(product, data, new Date().toISOString());
            return withAvailableStock({
              ...product,
              effectivePriceInCents: campaign.effectivePriceInCents,
              promotion: campaign.promotion,
              ...campaignMetrics,
              salesCount,
                favoriteCount,
                favoriteDemandText: favoriteDemandText(favoriteCount),
                restockHint: productRestockHint(product, salesCount, stockThreshold, favoriteCount),
                complianceCase: product.autoDelistRule === 'LOW_QUALITY' && complianceCase ? {
                  id: complianceCase.id,
                  caseNo: complianceCase.caseNo,
                  status: complianceCase.status,
                  statusLabel: complianceCase.status === 'SUBMITTED' ? '整改待平台复核'
                    : complianceCase.status === 'REVIEWING' ? '平台正在复核'
                    : complianceCase.status === 'COMPLETED' ? '整改验收通过'
                    : complianceCase.status === 'REJECTED' ? '整改未通过' : '处理中',
                  adminNote: complianceCase.adminNote || '',
                  dueAt: complianceCase.dueAt || '',
                  updatedAt: complianceCase.updatedAt
                } : null
              });
            }),
            promotionSummary: products
              .filter((product) => Number(product.salePriceInCents || 0) > 0)
              .map((product) => ({
                id: product.id,
                name: product.name,
                merchantId: product.merchantId || '',
                merchantName: merchant.name,
                priceInCents: Number(product.priceInCents || 0),
                salePriceInCents: Number(product.salePriceInCents || 0),
                saleStartsAt: product.saleStartsAt || '',
                saleEndsAt: product.saleEndsAt || '',
                ...productPromotionOrderMetrics(product, data, new Date().toISOString())
              }))
              .sort((a, b) => b.campaignAmountInCents - a.campaignAmountInCents),
            lowStockProducts: products
              .filter((product) => product.active !== false && availableStock(product) <= stockThreshold)
              .sort((a, b) => availableStock(a) - availableStock(b))
              .map((product) => ({
                id: product.id,
                name: product.name,
                availableStock: availableStock(product),
                reservedStock: Number(product.reservedStock || 0),
                stock: Number(product.stock || 0),
                threshold: stockThreshold,
                alertedAt: product.lowStockAlertedAt || '',
                status: product.lowStockAlertStatus || ''
              }))
              .map((product) => ({
                ...product,
                favoriteCount: productFavoriteCounts.get(product.id) || 0,
                favoriteDemandText: favoriteDemandText(productFavoriteCounts.get(product.id) || 0)
              })),
            orders: enrichedOrders,
            afterSales,
            reviews,
            settlements,
            payoutRequests,
            slaAlerts,
            pendingPublishProducts: products
              .filter((product) => product.publishReviewStatus === 'PENDING_REVIEW')
              .map((product) => ({ id: product.id, name: product.name, publishReviewNote: product.publishReviewNote || '' }))
          },
          requestId
        });
      }

      if (pathname.startsWith('/api/merchant/settlement-statement')) {
        const merchant = (store.read().merchants || []).find((item) => item.id === merchantSession.merchantId);
        if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
        const monthQuery = url.searchParams.get('month') || '';
        if (monthQuery && !/^\d{4}-\d{2}$/.test(monthQuery)) {
          throw new ApiError(400, 'VALIDATION_ERROR', '账单月份需为 YYYY-MM');
        }
        const statement = buildMerchantStatement(store.read(), merchant, monthQuery);

        if (request.method === 'GET' && pathname === '/api/merchant/settlement-statement') {
          return sendJson(response, 200, { data: statement, requestId });
        }

        if (request.method === 'GET' && pathname === '/api/merchant/settlement-statement/export') {
          const money = (value) => ((Number(value) || 0) / 100).toFixed(2);
          const headers = ['记录类型', '单据号', '状态', '金额(元)', '服务费率', '平台佣金(元)', '商家应收(元)', '时间', '打款凭证'];
          const rows = statement.settlements.map((item) => [
            '收入分账', item.orderNo, item.statusLabel, money(item.amountInCents),
            `${item.commissionRatePercent}%`, money(item.platformFeeInCents), money(item.payableInCents),
            item.createdAt, item.settlementReference
          ]);
          for (const item of statement.payouts) {
            const paid = item.paidAmountInCents || (item.status === 'SETTLED' ? item.amountInCents : 0);
            rows.push([
              '提现出账', item.requestNo, item.statusLabel, `-${money(paid)}`, '', '', `-${money(paid)}`,
              item.reviewedAt || item.createdAt, item.settlementReference
            ]);
          }
          rows.push([
            '本月汇总', '', '', money(statement.totals.businessGrossInCents), '',
            money(statement.totals.commissionInCents),
            money(statement.totals.netInCents), statement.generatedAt, ''
          ]);
          const csv = [headers, ...rows].map((row) => row.map((value) => {
            const text = String(value ?? '');
            return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
          }).join(',')).join('\r\n');
          const fileName = `shishan-merchant-statement-${merchant.id}-${statement.month}.csv`;
          response.writeHead(200, {
            'content-type': 'text/csv; charset=utf-8',
            'content-disposition': `attachment; filename="${fileName}"`,
            ...(response.corsOrigin ? { 'access-control-allow-origin': response.corsOrigin, vary: 'Origin' } : {}),
            'cache-control': 'no-store'
          });
          response.end(`\ufeff${csv}`);
          return;
        }
      }

      if (request.method === 'GET' && pathname === '/api/merchant/stock-movements') {
        const allowedTypes = new Set(['INITIAL', 'ADJUST_IN', 'ADJUST_OUT', 'RESERVE', 'RELEASE', 'CONSUME', 'RESTORE']);
        const data = store.read();
        let items = (data.stockMovements || []).filter((item) => item.merchantId === merchantSession.merchantId);
        const productId = url.searchParams.get('productId') || '';
        const movementType = url.searchParams.get('type') || '';
        const referenceNo = url.searchParams.get('referenceNo') || '';
        const limitRaw = Number(url.searchParams.get('limit') || 50);
        if (productId && !items.some((item) => item.productId === productId)) {
          throw new ApiError(404, 'PRODUCT_NOT_FOUND', '未找到本店库存商品');
        }
        if (movementType && !allowedTypes.has(movementType)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported stock movement type');
        if (!Number.isInteger(limitRaw) || limitRaw < 1 || limitRaw > 100) throw new ApiError(400, 'VALIDATION_ERROR', 'limit 需为 1-100 的整数');
        if (productId) items = items.filter((item) => item.productId === productId);
        if (movementType) items = items.filter((item) => item.movementType === movementType);
        if (referenceNo) items = items.filter((item) => item.referenceNo === referenceNo);
        const total = items.length;
        return sendJson(response, 200, { data: items.slice(0, limitRaw), total, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/merchant/notifications') {
        const data = store.read();
        const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
        if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
        const items = (data.notifications || [])
          .filter((item) => item.userId === merchant.userId)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const linkedItems = items.map((item) => ({ ...item, link: merchantNotificationLink(item) }));
        return sendJson(response, 200, { data: linkedItems, total: linkedItems.length, unreadCount: linkedItems.filter((item) => !item.read).length, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/merchant/notifications/read') {
        const updated = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          let count = 0;
          for (const item of data.notifications || []) {
            if (item.userId === merchant.userId && !item.read) {
              item.read = true;
              count += 1;
            }
          }
          return { updated: count };
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (pathname === '/api/merchant/message-subscriptions') {
        const dataStore = store.read();
        const merchant = dataStore.merchants.find((item) => item.id === merchantSession.merchantId);
        if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
        if (request.method === 'GET') {
          return sendJson(response, 200, {
            data: { subscribed: (dataStore.serviceMessageSubscribers || []).includes(merchant.userId) },
            requestId
          });
        }
        if (request.method === 'POST') {
          const body = await readJson(request);
          const result = store.update((current) => {
            if (body.accepted === false) {
              current.serviceMessageSubscribers = (current.serviceMessageSubscribers || [])
                .filter((item) => item !== merchant.userId);
              return { subscribed: false };
            }
            current.serviceMessageSubscribers = Array.isArray(current.serviceMessageSubscribers)
              ? current.serviceMessageSubscribers
              : [];
            if (!current.serviceMessageSubscribers.includes(merchant.userId)) {
              current.serviceMessageSubscribers.unshift(merchant.userId);
            }
            return { subscribed: true };
          });
          return sendJson(response, 200, { data: result, requestId });
        }
      }

      // 商家只能发起提现申请，实际打款由平台在管理端审核后确认。
      if (request.method === 'POST' && pathname === '/api/merchant/payout-requests') {
        const body = await readJson(request);
        const remark = typeof body.remark === 'string' ? body.remark.trim().slice(0, 200) : '';
        const payoutRequest = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号不可用');
          return createPayoutRequest(data, merchant, new Date().toISOString(), remark);
        });
        return sendJson(response, 201, { data: payoutRequest, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/merchant/score-cases') {
        const body = await readJson(request);
        const type = requireString(body.type, 'type', { maxLength: 20 });
        if (!['APPEAL', 'RECTIFY'].includes(type)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported service score case type');
        const reasonType = type === 'APPEAL' ? requireString(body.reasonType, 'reasonType', { maxLength: 40 }) : '';
        if (reasonType && !allowedScoreComplaintTypes.has(reasonType)) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported appeal reason type');
        }
        const reason = requireString(body.reason, 'reason', { maxLength: 500 });
        const plan = type === 'RECTIFY' ? requireString(body.plan, 'plan', { maxLength: 500 }) : '';
        if (!reason.trim()) throw new ApiError(400, 'VALIDATION_ERROR', '请填写申诉或整改说明');
        if (type === 'RECTIFY' && !plan.trim()) throw new ApiError(400, 'VALIDATION_ERROR', '请填写整改计划');
        const evidence = Array.isArray(body.evidence)
          ? body.evidence.slice(0, 6).map((item) => String(item || '').trim()).filter(Boolean)
          : [];
        if (evidence.some((item) => !item.startsWith('/api/uploads/'))) {
          throw new ApiError(400, 'VALIDATION_ERROR', '材料图片必须来自平台上传目录');
        }
        const requestedAdjustment = Number(body.requestedAdjustment || 0);
        if (!Number.isInteger(requestedAdjustment) || requestedAdjustment < 0 || requestedAdjustment > 20) {
          throw new ApiError(400, 'VALIDATION_ERROR', '申请补分需为 0-20 分的整数');
        }
        await sweepExpiredOrders();
        const result = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号不可用');
          if (type === 'RECTIFY' && body.productId !== undefined) {
            const productId = requireString(body.productId, 'productId', { maxLength: 80 });
            const product = data.products.find((item) => item.id === productId
              && item.merchantId === merchant.id
              && item.autoDelistRule === 'LOW_QUALITY'
              && item.active === false);
            if (!product) throw new ApiError(404, 'DELISTED_PRODUCT_NOT_FOUND', '未找到待整改的自动下架商品');
          }
          if ((data.serviceScoreCases || []).some((item) => item.merchantId === merchant.id
            && ['SUBMITTED', 'REVIEWING'].includes(item.status))) {
            throw new ApiError(409, 'SCORE_CASE_EXISTS', '已有一件申诉或整改工单在处理中');
          }
          const now = new Date().toISOString();
          const caseRecord = createServiceScoreCase(data, merchant, {
            type,
            reasonType,
            reason: reason.trim(),
            plan: plan.trim(),
            evidence,
            requestedAdjustment
          }, now);
          if (type === 'RECTIFY' && body.productId) {
            caseRecord.productId = requireString(body.productId, 'productId', { maxLength: 80 });
            const product = data.products.find((item) => item.id === caseRecord.productId);
            caseRecord.productName = product?.name || '';
            if (product) {
              product.autoDelistCaseId = caseRecord.id;
              product.autoDelistCaseNo = caseRecord.caseNo;
              product.autoDelistStatus = 'REVIEW_PENDING';
              product.autoDelistReviewNote = `整改工单 ${caseRecord.caseNo} 已提交，等待平台复核`;
              product.autoDelistReviewUpdatedAt = now;
            }
          }
          addAudit(data, '服务分工单待审核', `${merchant.name} ${caseRecord.caseNo}`);
          return caseRecord;
        });
        return sendJson(response, 201, { data: result, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/merchant/score-cases') {
        const data = store.read();
        const items = (data.serviceScoreCases || [])
          .filter((item) => item.merchantId === merchantSession.merchantId)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/merchant/payout-requests') {
        const data = store.read();
        const items = (data.payoutRequests || [])
          .filter((item) => item.merchantId === merchantSession.merchantId)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/merchant/products') {
        const body = await readJson(request);
        const product = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号不可用');
          const stage = merchantServiceStage(data, merchant.id);
          if (stage === 'RESTRICTED') {
            throw new ApiError(409, 'MERCHANT_SCORE_RESTRICTED', `服务分 ${merchant.serviceScore?.score ?? 0} 分已触发暂停上新，请先处理超时与售后工单`);
          }
          const priceInCents = requirePositiveInteger(body.priceInCents, 'priceInCents');
          const stock = requirePositiveInteger(body.stock, 'stock', { max: 999999 });
          const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
          if (imageUrl && !imageUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '商品图片必须来自平台上传目录');
          // 限流整改期间新增商品先进入待复核，避免低分商家继续放量。
          const autoPublish = serviceScoreStages[stage].autoPublish;
          const sale = normalizeProductSaleCampaign(body);
          if (sale && sale.salePriceInCents >= priceInCents) throw new ApiError(400, 'VALIDATION_ERROR', '促销价必须低于商品原价');
          const item = {
            id: `prod_${randomUUID()}`,
            name: requireString(body.name, 'name', { maxLength: 80 }),
            category: requireString(body.category, 'category', { maxLength: 50 }),
            description: requireString(body.description, 'description', { maxLength: 300 }),
            priceInCents,
            stock,
            campusIds: ['campus_demo'],
            imageUrl,
            merchantId: merchant.id,
            active: autoPublish ? body.active !== false : false,
            publishReviewStatus: autoPublish ? 'AUTO' : 'PENDING_REVIEW',
            ...(sale || {})
            ,
            publishReviewNote: autoPublish ? '' : '服务分处限期间，商品需平台复核后上架'
          };
          data.products.unshift(item);
          recordStockMovement(data, item, {
            movementType: 'INITIAL',
            quantity: item.stock,
            stockBefore: 0,
            stockAfter: item.stock,
            reservedBefore: 0,
            reservedAfter: 0,
            referenceId: item.id,
            operator: merchantSession.merchantId,
            note: '商家创建商品'
          });
          evaluateLowStockAlert(data, item, item.createdAt);
          addAudit(data, autoPublish ? '商家新增商品' : '商家新增商品待复核', item.name);
          return item;
        });
        return sendJson(response, 201, { data: product, requestId });
      }

      const merchantProductMatch = pathname.match(/^\/api\/merchant\/products\/([^/]+)$/);
      if (request.method === 'POST' && merchantProductMatch) {
        const body = await readJson(request);
        const product = store.update((data) => {
          const item = data.products.find((row) => row.id === merchantProductMatch[1] && row.merchantId === merchantSession.merchantId);
          if (!item) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
          const stage = merchantServiceStage(data, merchantSession.merchantId);
          // 待复核和暂停上新期间商家不能自己把商品重新挂上架。
          if (body.active === true && item.active === false) {
            if (item.publishReviewStatus === 'PENDING_REVIEW') throw new ApiError(409, 'PRODUCT_REVIEW_PENDING', '该商品正在平台复核，通过后会自动上架');
            if (stage === 'RESTRICTED') throw new ApiError(409, 'MERCHANT_SCORE_RESTRICTED', '服务分过低已暂停上新，请先完成整改');
          }
          if (body.name !== undefined) item.name = requireString(body.name, 'name', { maxLength: 80 });
          if (body.description !== undefined) item.description = requireString(body.description, 'description', { maxLength: 300 });
          if (body.imageUrl !== undefined) {
            const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
            if (imageUrl && !imageUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '商品图片必须来自平台上传目录');
            item.imageUrl = imageUrl;
          }
          if (body.priceInCents !== undefined) item.priceInCents = requirePositiveInteger(body.priceInCents, 'priceInCents');
          const previousPromotion = withProductSale(item).promotion;
          const availableBefore = availableStock(item);
          const sale = normalizeProductSaleCampaign(body, item);
          if (sale) {
            if (sale.salePriceInCents >= item.priceInCents) throw new ApiError(400, 'VALIDATION_ERROR', '促销价必须低于商品原价');
            item.salePriceInCents = sale.salePriceInCents;
            item.saleStartsAt = sale.saleStartsAt;
            item.saleEndsAt = sale.saleEndsAt;
          }
          if (body.stock !== undefined) {
            const stockBefore = Number(item.stock || 0);
            item.stock = requirePositiveInteger(body.stock, 'stock', { max: 999999 });
            if (item.stock !== stockBefore) {
              recordStockMovement(data, item, {
                movementType: item.stock > stockBefore ? 'ADJUST_IN' : 'ADJUST_OUT',
                quantity: Math.abs(item.stock - stockBefore),
                stockBefore,
                stockAfter: item.stock,
                reservedBefore: Number(item.reservedStock || 0),
                reservedAfter: Number(item.reservedStock || 0),
                referenceId: item.id,
                operator: merchantSession.merchantId,
                note: '商家调整可用库存'
              });
            }
          }
          if (body.active !== undefined) item.active = Boolean(body.active);
          const now = new Date().toISOString();
          item.updatedAt = now;
          evaluateLowStockAlert(data, item, item.updatedAt);
          addAudit(data, '商家更新商品', item.name);
          notifyRestockSubscribers(
            data,
            item,
            data.merchants.find((merchant) => merchant.id === merchantSession.merchantId)?.name || '',
            item.updatedAt
          );
          if (availableBefore === 0 && availableStock(item) > 0) {
            notifyFavoriteRestockSubscribers(
              data,
              item,
              data.merchants.find((merchant) => merchant.id === merchantSession.merchantId)?.name || '',
              item.updatedAt
            );
          }
          if (availableStock(item) === 0) item.lastFavoriteRestockNoticeAt = '';
          const currentPromotion = withProductSale(item, now).promotion;
          const saleSignature = `${item.salePriceInCents || 0}:${item.saleStartsAt || ''}:${item.saleEndsAt || ''}`;
          if (currentPromotion && sale && previousPromotion !== currentPromotion && item.lastSaleNoticeKey !== saleSignature) {
            for (const favorite of (data.productFavorites || []).filter((row) => row.productId === item.id)) {
              if (favorite.userId !== merchantSession.userId) {
                sendFavoritePriceDropNotification(data, favorite.userId, item, currentPromotion, now);
              }
            }
            item.lastSaleNoticeKey = saleSignature;
          }
          return item;
        });
        return sendJson(response, 200, { data: product, requestId });
      }

        const merchantOrderMatch = pathname.match(/^\/api\/merchant\/orders\/([^/]+)\/status$/);
      if (request.method === 'POST' && merchantOrderMatch) {
        const body = await readJson(request);
        const status = requireString(body.status, 'status', { maxLength: 30 });
        if (!allowedMerchantOrderStatuses.has(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported merchant order status');
        const order = store.update((data) => {
          const item = data.orders.find((row) => row.id === merchantOrderMatch[1] && row.items.some((orderItem) => {
            const product = data.products.find((candidate) => candidate.id === orderItem.productId);
            return product?.merchantId === merchantSession.merchantId;
          }));
          if (!item) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (!['PAID', 'FULFILLING'].includes(item.status)) throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', '当前订单状态不可更新');
          if (status === 'COMPLETED') {
            const providedCode = typeof body.deliveryCode === 'string' ? requireString(body.deliveryCode, 'deliveryCode', { maxLength: 6 }) : '';
            if (!item.deliveryCode || providedCode !== item.deliveryCode) {
              throw new ApiError(409, 'DELIVERY_CODE_INVALID', '交付码不正确，请向用户确认后完成订单');
            }
          }
          item.status = status;
          item.updatedAt = new Date().toISOString();
          appendCollaborationEvent(item, 'MERCHANT', status === 'FULFILLING' ? 'ACCEPT' : 'COMPLETE', status === 'FULFILLING' ? '商家已确认履约' : '商家已核验交付码，订单已完成');
          addAudit(data, '商家更新订单状态', item.orderNo);
          if (status === 'COMPLETED') {
            const released = activateOrderSettlements(data, item, item.updatedAt);
            addNotification(data, item.userId, 'ORDER', '订单已完成', `订单 ${item.orderNo} 已通过交付码核验并完成。`, { focusId: item.id });
            if (released.length) {
              const days = settlementPeriodDays(data);
              notifyMerchant(data, merchantSession.merchantId, 'SETTLEMENT', '分账已进入账期', `订单 ${item.orderNo} 交付核验通过，${days > 0 ? `${days} 天账期后可结算` : '可立即结算'}。`);
            }
          }
          return item;
        });
        return sendJson(response, 200, { data: order, requestId });
      }

      const merchantAfterSaleMatch = pathname.match(/^\/api\/merchant\/after-sales\/([^/]+)\/status$/);
      if (request.method === 'POST' && merchantAfterSaleMatch) {
        const body = await readJson(request);
        const status = requireString(body.status, 'status', { maxLength: 30 });
        if (!['SUBMITTED', 'REVIEWING', 'CLOSED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported merchant after-sale status');
        const resolutionNote = status === 'CLOSED' ? requireString(body.resolutionNote, 'resolutionNote', { maxLength: 500 }) : '';
        const afterSale = store.update((data) => {
          const item = (data.afterSales || []).find((record) => record.id === merchantAfterSaleMatch[1]);
          if (!item) throw new ApiError(404, 'AFTER_SALE_NOT_FOUND', 'After-sale record not found');
          const order = data.orders.find((row) => row.id === item.orderId && row.items.some((orderItem) => {
            const product = data.products.find((candidate) => candidate.id === orderItem.productId);
            return product?.merchantId === merchantSession.merchantId;
          }));
          if (!order) throw new ApiError(404, 'AFTER_SALE_NOT_FOUND', 'After-sale record not found');
          item.status = status;
          item.updatedAt = new Date().toISOString();
          if (status === 'CLOSED') item.resolutionNote = resolutionNote;
          if (status === 'CLOSED' && item.type === 'REFUND') {
            applyOrderRefund(data, order, item.updatedAt);
            appendCollaborationEvent(order, 'MERCHANT', 'AFTER_SALE_CLOSED', `退款已完成，订单关闭：${resolutionNote}`);
          } else if (status === 'CLOSED') {
            order.status = 'COMPLETED';
            order.updatedAt = item.updatedAt;
            unfreezeOrderSettlements(data, order, item.updatedAt);
            activateOrderSettlements(data, order, item.updatedAt);
            appendCollaborationEvent(order, 'MERCHANT', 'AFTER_SALE_CLOSED', `售后处理完成：${resolutionNote}`);
            addNotification(data, order.userId, 'AFTER_SALE', '售后处理完成', resolutionNote, { focusId: order.id });
          }
          if (status === 'REVIEWING') addNotification(data, order.userId, 'AFTER_SALE', '售后正在处理', '商家已开始处理您的售后申请。', { focusId: order.id });
          addAudit(data, '商家更新售后状态', item.id);
          return item;
        });
        return sendJson(response, 200, { data: afterSale, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/payment-orders') {
        const data = store.read();
        const items = (data.paymentOrders || []).filter(Boolean);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/payment-reconciliations/run') {
        const body = await readJson(request);
        const billDate = requireString(body.billDate, 'billDate', { maxLength: 10 });
        if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate)) {
          throw new ApiError(400, 'VALIDATION_ERROR', '账单日期格式必须为 YYYY-MM-DD');
        }
        if (typeof paymentProvider.fetchBills !== 'function') {
          throw new ApiError(501, 'PAYMENT_RECONCILIATION_UNSUPPORTED', '当前支付提供方不支持对账');
        }
        let bills;
        try {
          bills = await paymentProvider.fetchBills(billDate);
        } catch (error) {
          throw new ApiError(502, 'PAYMENT_PROVIDER_FAILED', `获取支付账单失败：${error.message}`);
        }

        const snapshot = store.read();
        const providerPayments = (bills.tradeBill || [])
          .filter((item) => item.paymentNo && ['SUCCESS', 'PAID'].includes(item.status))
          .map((item) => ({
            paymentNo: item.paymentNo,
            providerTradeNo: item.providerTradeNo || '',
            amountInCents: Number(item.amountInCents || 0),
            paidAt: item.paidAt || ''
          }));
        const providerRefunds = (bills.fundBill || [])
          .filter((item) => item.refundNo)
          .map((item) => ({
            paymentNo: item.paymentNo || '',
            refundNo: item.refundNo,
            providerTradeNo: item.providerTradeNo || '',
            amountInCents: Number(item.amountInCents || 0),
            refundedAt: item.refundedAt || ''
          }));
        const localPayments = (snapshot.paymentOrders || [])
          .filter((item) => ['PAID', 'REFUNDED'].includes(item.status)
            && String(item.paidAt || '').startsWith(billDate))
          .map((item) => ({
            paymentNo: item.paymentNo,
            providerTradeNo: item.providerTradeNo || '',
            amountInCents: Number(item.amountInCents || 0),
            paidAt: item.paidAt || ''
          }));
        const localRefunds = (snapshot.paymentOrders || [])
          .filter((item) => item.status === 'REFUNDED'
            && (String(item.refundedAt || '').startsWith(billDate)
              || String(item.refund?.updatedAt || '').startsWith(billDate)))
          .map((item) => ({
            paymentNo: item.paymentNo,
            refundNo: item.refund?.refundNo || `RF_${item.paymentNo}`,
            amountInCents: Number(item.amountInCents || 0),
            refundedAt: item.refundedAt || item.refund?.updatedAt || ''
          }));

        const differences = [];
        const providerPaymentMap = new Map(providerPayments.map((item) => [item.paymentNo, item]));
        const localPaymentMap = new Map(localPayments.map((item) => [item.paymentNo, item]));
        for (const providerPayment of providerPayments) {
          const localPayment = localPaymentMap.get(providerPayment.paymentNo);
          if (!localPayment) {
            differences.push({
              type: 'PROVIDER_PAYMENT_MISSING_LOCAL',
              paymentNo: providerPayment.paymentNo,
              providerTradeNo: providerPayment.providerTradeNo,
              amountInCents: providerPayment.amountInCents
            });
          } else if (localPayment.amountInCents !== providerPayment.amountInCents) {
            differences.push({
              type: 'PAYMENT_AMOUNT_MISMATCH',
              paymentNo: providerPayment.paymentNo,
              providerTradeNo: providerPayment.providerTradeNo,
              localAmountInCents: localPayment.amountInCents,
              providerAmountInCents: providerPayment.amountInCents
            });
          }
        }
        for (const localPayment of localPayments) {
          if (!providerPaymentMap.has(localPayment.paymentNo)) {
            differences.push({
              type: 'LOCAL_PAYMENT_MISSING_PROVIDER',
              paymentNo: localPayment.paymentNo,
              providerTradeNo: localPayment.providerTradeNo,
              amountInCents: localPayment.amountInCents
            });
          }
        }

        const providerRefundMap = new Map(providerRefunds.map((item) => [item.refundNo, item]));
        const localRefundMap = new Map(localRefunds.map((item) => [item.refundNo, item]));
        for (const providerRefund of providerRefunds) {
          const localRefund = localRefundMap.get(providerRefund.refundNo);
          if (!localRefund) {
            differences.push({
              type: 'PROVIDER_REFUND_MISSING_LOCAL',
              paymentNo: providerRefund.paymentNo,
              refundNo: providerRefund.refundNo,
              amountInCents: providerRefund.amountInCents
            });
          } else if (localRefund.amountInCents !== providerRefund.amountInCents) {
            differences.push({
              type: 'REFUND_AMOUNT_MISMATCH',
              paymentNo: providerRefund.paymentNo,
              refundNo: providerRefund.refundNo,
              localAmountInCents: localRefund.amountInCents,
              providerAmountInCents: providerRefund.amountInCents
            });
          }
        }
        for (const localRefund of localRefunds) {
          if (!providerRefundMap.has(localRefund.refundNo)) {
            differences.push({
              type: 'LOCAL_REFUND_MISSING_PROVIDER',
              paymentNo: localRefund.paymentNo,
              refundNo: localRefund.refundNo,
              amountInCents: localRefund.amountInCents
            });
          }
        }

        const matchedPaymentCount = providerPayments
          .filter((item) => localPaymentMap.has(item.paymentNo)
            && localPaymentMap.get(item.paymentNo).amountInCents === item.amountInCents).length;
        const matchedRefundCount = providerRefunds
          .filter((item) => localRefundMap.has(item.refundNo)
            && localRefundMap.get(item.refundNo).amountInCents === item.amountInCents).length;
        const report = {
          id: `rec_${randomUUID()}`,
          billDate,
          provider: paymentProvider.name,
          channel: paymentProvider.channel,
          status: differences.length ? 'DIFFERENCES' : 'MATCHED',
          summary: {
            providerPaymentCount: providerPayments.length,
            localPaymentCount: localPayments.length,
            matchedPaymentCount,
            missingLocalPaymentCount: providerPayments.length - matchedPaymentCount,
            missingProviderPaymentCount: localPayments.length - matchedPaymentCount,
            providerRefundCount: providerRefunds.length,
            localRefundCount: localRefunds.length,
            matchedRefundCount,
            missingLocalRefundCount: providerRefunds.length - matchedRefundCount,
            missingProviderRefundCount: localRefunds.length - matchedRefundCount,
            differenceCount: differences.length
          },
          differences,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        const persisted = store.update((data) => {
          if (!Array.isArray(data.paymentReconciliations)) data.paymentReconciliations = [];
          const existingIndex = data.paymentReconciliations.findIndex((item) => (
            item.billDate === billDate && item.provider === paymentProvider.name
          ));
          if (existingIndex >= 0) {
            report.id = data.paymentReconciliations[existingIndex].id;
            report.createdAt = data.paymentReconciliations[existingIndex].createdAt;
            data.paymentReconciliations[existingIndex] = report;
          } else {
            data.paymentReconciliations.unshift(report);
          }
          data.paymentReconciliations = data.paymentReconciliations.slice(0, 500);
          const financeTask = upsertPaymentReconciliationTask(data, report, new Date().toISOString(), addAudit);
          addAudit(data, '执行支付对账', `${billDate} ${paymentProvider.name}`);
          return { ...report, financeTask };
        });
        return sendJson(response, 200, { data: persisted, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/finance-tasks') {
        const data = store.read();
        const status = url.searchParams.get('status') || '';
        const items = (data.financeTasks || []).filter((item) => !status || item.status === status);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      const financeTaskAckMatch = pathname.match(/^\/api\/admin\/finance-tasks\/([^/]+)\/acknowledge$/);
      if (request.method === 'POST' && financeTaskAckMatch) {
        const body = await readJson(request);
        const note = requireString(body.note, 'note', { maxLength: 200 });
        const task = store.update((data) => {
          const item = (data.financeTasks || []).find((row) => row.id === financeTaskAckMatch[1]);
          if (!item) throw new ApiError(404, 'FINANCE_TASK_NOT_FOUND', '财务待办不存在');
          if (item.status === 'RESOLVED') throw new ApiError(409, 'FINANCE_TASK_RESOLVED', '该财务待办已关闭');
          const now = new Date().toISOString();
          item.status = 'ACKNOWLEDGED';
          item.acknowledgeNote = note;
          item.acknowledgedAt = now;
          item.updatedAt = now;
          addAudit(data, '认领支付对账待办', `${item.billDate} ${item.provider}`);
          return item;
        });
        return sendJson(response, 200, { data: task, requestId });
      }

      const financeTaskResolveMatch = pathname.match(/^\/api\/admin\/finance-tasks\/([^/]+)\/resolve$/);
      if (request.method === 'POST' && financeTaskResolveMatch) {
        const body = await readJson(request);
        const note = requireString(body.note, 'note', { maxLength: 200 });
        const task = store.update((data) => {
          const item = (data.financeTasks || []).find((row) => row.id === financeTaskResolveMatch[1]);
          if (!item) throw new ApiError(404, 'FINANCE_TASK_NOT_FOUND', '财务待办不存在');
          if (item.status === 'RESOLVED') throw new ApiError(409, 'FINANCE_TASK_RESOLVED', '该财务待办已关闭');
          const now = new Date().toISOString();
          item.status = 'RESOLVED';
          item.resolutionNote = note;
          item.resolvedAt = now;
          item.updatedAt = now;
          addAudit(data, '完成支付对账待办', `${item.billDate} ${item.provider}`);
          return item;
        });
        return sendJson(response, 200, { data: task, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/notifications') {
        const data = store.read();
        const items = (data.notifications || []).filter(Boolean);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      // 运营巡检：手动立即跑一轮，用于处理完一批工单后马上刷新预警。
      if (request.method === 'POST' && pathname === '/api/admin/patrol/run') {
        const result = await patrolOnce();
        const data = store.read();
        return sendJson(response, 200, {
          data: {
            created: result.created.length,
            escalated: result.escalated.length,
            resolved: result.resolved.length,
            expiredOrders: result.expiredOrders,
            maturedSettlements: result.maturedSettlements,
            open: result.open,
            patrolState: data.patrolState || {},
            slaSummary: slaSummary(data.slaAlerts || [])
          },
          requestId
        });
      }

      if (request.method === 'GET' && pathname === '/api/admin/sla-alerts') {
        sweepOperationsPatrol();
        const data = store.read();
        const status = url.searchParams.get('status') || '';
        const items = (data.slaAlerts || []).filter((alert) => !status || alert.status === status);
        return sendJson(response, 200, {
          data: items,
          total: items.length,
          summary: slaSummary(data.slaAlerts || []),
          patrolState: data.patrolState || {},
          requestId
        });
      }

      const slaAckMatch = pathname.match(/^\/api\/admin\/sla-alerts\/([^/]+)\/acknowledge$/);
      if (request.method === 'POST' && slaAckMatch) {
        const actor = requireAdmin(request, 'ORDER_MANAGE');
        const body = await readJson(request);
        const note = requireString(body.note, 'note', { maxLength: 200 });
        const alert = store.update((data) => {
          const item = (data.slaAlerts || []).find((row) => row.id === slaAckMatch[1]);
          if (!item) throw new ApiError(404, 'SLA_ALERT_NOT_FOUND', '预警记录不存在');
          if (item.status === 'RESOLVED') throw new ApiError(409, 'SLA_ALERT_RESOLVED', '该预警已自动关闭，无需处理');
          const now = new Date().toISOString();
          item.status = 'ACKNOWLEDGED';
          item.acknowledgedBy = actor.displayName || actor.username;
          item.acknowledgedById = actor.id;
          if (item.ownerRole !== 'MERCHANT' && !item.ownerId) {
            item.ownerId = actor.id;
            item.ownerName = actor.displayName || actor.username;
          }
          item.acknowledgedAt = now;
          item.acknowledgeNote = note;
          item.updatedAt = now;
          addAudit(data, '认领超时预警', `${item.ruleLabel} ${item.businessNo}`, actor.displayName || actor.username);
          if (item.ownerRole === 'MERCHANT' && item.merchantId) {
            notifyMerchant(data, item.merchantId, 'SLA', '平台已跟进超时事项', `${item.ruleLabel}：${item.businessNo} 平台处理意见：${note}`);
          }
          return item;
        });
        return sendJson(response, 200, { data: alert, requestId });
      }

      const adminPaymentRefundRefreshMatch = pathname.match(/^\/api\/admin\/payment-orders\/([^/]+)\/refund\/refresh$/);
      if (request.method === 'POST' && adminPaymentRefundRefreshMatch) {
        const currentPayment = store.read().paymentOrders.find((item) => item.id === adminPaymentRefundRefreshMatch[1]);
        if (!currentPayment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
        if (currentPayment.status !== 'PAID' || currentPayment.refund?.status !== 'PENDING') {
          throw new ApiError(409, 'PAYMENT_REFUND_NOT_PENDING', '仅渠道处理中的退款可查询结果');
        }
        const providerRefund = await queryProviderRefund(currentPayment);
        if (providerRefund.status === 'REFUNDED') {
          const completed = completePaymentRefund(currentPayment.id, providerRefund, 'REFUND_QUERY');
          return sendJson(response, 200, { data: completed, requestId });
        }
        const updated = store.update((data) => {
          const paymentOrder = data.paymentOrders.find((item) => item.id === adminPaymentRefundRefreshMatch[1]);
          if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          if (paymentOrder.status !== 'PAID' || paymentOrder.refund?.status !== 'PENDING') {
            throw new ApiError(409, 'PAYMENT_REFUND_NOT_PENDING', '仅渠道处理中的退款可查询结果');
          }
          const now = new Date().toISOString();
          paymentOrder.refund.status = providerRefund.status;
          paymentOrder.refund.updatedAt = now;
          paymentOrder.refund.providerPayload = providerRefund.payload || paymentOrder.refund.providerPayload || null;
          paymentOrder.updatedAt = now;
          return { paymentOrder };
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      const adminPaymentRefundMatch = pathname.match(/^\/api\/admin\/payment-orders\/([^/]+)\/refund$/);
      if (request.method === 'POST' && adminPaymentRefundMatch) {
        const body = await readJson(request);
        const refundNote = requireString(body.note, 'note', { maxLength: 200 });
        const currentPayment = store.read().paymentOrders.find((item) => item.id === adminPaymentRefundMatch[1]);
        if (!currentPayment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
        if (currentPayment.status !== 'PAID') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '仅已支付单可退款');
        let providerRefund;
        try {
          providerRefund = await paymentProvider.refund(currentPayment);
        } catch (error) {
          throw new ApiError(502, 'PAYMENT_PROVIDER_FAILED', `退款渠道失败：${error.message}`);
        }
        if (!['REFUNDED', 'PENDING', 'FAILED'].includes(providerRefund?.status)) {
          throw new ApiError(502, 'PAYMENT_PROVIDER_FAILED', `退款渠道返回未知状态：${providerRefund?.status || 'UNKNOWN'}`);
        }
        if (providerRefund.status !== 'REFUNDED') {
          const pending = store.update((data) => {
            const paymentOrder = data.paymentOrders.find((item) => item.id === adminPaymentRefundMatch[1]);
            if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
            if (paymentOrder.status !== 'PAID') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '仅已支付单可退款');
            const now = new Date().toISOString();
            const refundNo = providerRefund.refundNo || `RF_${paymentOrder.paymentNo}`;
            paymentOrder.refund = {
              status: providerRefund.status,
              refundNo,
              requestedAt: now,
              updatedAt: now,
              note: refundNote,
              providerPayload: providerRefund.payload || null
            };
            paymentOrder.updatedAt = now;
            return { paymentOrder };
          });
          return sendJson(response, 202, { data: pending, requestId });
        }
        const updated = store.update((data) => {
          if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
          const paymentOrder = data.paymentOrders.find((item) => item.id === adminPaymentRefundMatch[1]);
          if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          if (paymentOrder.status !== 'PAID') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '\u4ec5\u5df2\u652f\u4ed8\u5355\u53ef\u9000\u6b3e');
          const now = new Date().toISOString();
          paymentOrder.status = 'REFUNDED';
          paymentOrder.refundedAt = now;
          paymentOrder.updatedAt = now;
          paymentOrder.providerTradeNo = providerRefund.providerTradeNo || paymentOrder.providerTradeNo || '';
          paymentOrder.refund = {
            status: 'REFUNDED',
            refundNo: providerRefund.refundNo || `RF_${paymentOrder.paymentNo}`,
            requestedAt: now,
            updatedAt: now,
            note: refundNote,
            providerPayload: providerRefund.payload || null
          };
          const order = (data.orders || []).find((item) => item.id === paymentOrder.orderId);
          const rechargeOrder = (data.rechargeOrders || []).find((item) => item.id === paymentOrder.businessId && item.paymentOrderId === paymentOrder.id);
          const phoneCardOrder = (data.phoneCardOrders || []).find((item) => item.id === paymentOrder.businessId && item.paymentOrderId === paymentOrder.id);
          const plateApplication = (data.plateApplications || []).find((item) => item.id === paymentOrder.businessId && item.paymentOrderId === paymentOrder.id);
          if (phoneCardOrder) {
            phoneCardOrder.status = 'CANCELLED';
            phoneCardOrder.paymentStatus = 'REFUNDED';
            phoneCardOrder.updatedAt = now;
          }
          if (rechargeOrder) {
            rechargeOrder.status = 'CANCELLED';
            rechargeOrder.paymentStatus = 'REFUNDED';
            rechargeOrder.updatedAt = now;
          }
          if (plateApplication) {
            plateApplication.status = 'REJECTED';
            plateApplication.paymentStatus = 'REFUNDED';
            plateApplication.updatedAt = now;
          }
          if (order) {
            order.status = 'CANCELLED';
            order.paymentStatus = 'REFUNDED';
            order.updatedAt = now;
            restoreOrderStock(data, order);
          }
          markSettlementsRefunded(data, order?.id || '', now);
          addFinanceEvent(data, 'REFUND', `REFUND_${paymentOrder.id}`, -(paymentOrder.amountInCents || 0), {
            userId: paymentOrder.userId, paymentNo: paymentOrder.paymentNo, orderNo: order?.orderNo || '',
            businessType: phoneCardOrder ? 'PHONE_PLAN' : rechargeOrder ? 'RECHARGE' : plateApplication ? 'PLATE' : 'ORDER'
          }, now);
          addAudit(data, '\u7ba1\u7406\u7aef\u9000\u6b3e', paymentOrder.paymentNo);
          if (rechargeOrder) {
            addNotification(data, paymentOrder.userId, 'RECHARGE', '\u8bdd\u8d39\u6743\u76ca\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${paymentOrder.paymentNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`, { focusId: rechargeOrder.id });
          } else if (phoneCardOrder) {
            addNotification(data, paymentOrder.userId, 'PHONE_PLAN', '电话卡订单已退款', `\u8ba2\u5355 ${paymentOrder.paymentNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`, { focusId: phoneCardOrder.id });
          } else if (plateApplication) {
            addNotification(data, paymentOrder.userId, 'PLATE', '牌照服务费已退款', `申请 ${paymentOrder.paymentNo} 已完成退款，如需重新办理可再次提交。`, { focusId: plateApplication.id });
          } else {
            addNotification(data, paymentOrder.userId, 'ORDER', '\u8ba2\u5355\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${paymentOrder.orderNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`, { focusId: order?.id || paymentOrder.businessId });
          }
          return { order, rechargeOrder, phoneCardOrder, plateApplication, paymentOrder };
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/overview') {
        await sweepExpiredOrders();
        sweepMaturedSettlements();
        sweepOperationsPatrol();
        refreshScoresNow();
        const data = store.read();
        const leads = data.leads || [];
        const revenueInCents = data.orders.filter((item) => item.status !== 'PENDING_PAYMENT' && item.status !== 'CANCELLED').reduce((sum, order) => sum + (order.totalInCents || 0), 0)
          + data.phoneCardOrders.filter((item) => ['PENDING_REALNAME', 'ACTIVATED'].includes(item.status)).reduce((sum, order) => sum + (order.amountInCents || 0), 0)
          + data.rechargeOrders.filter((item) => ['PENDING_CREDIT', 'CREDITED'].includes(item.status)).reduce((sum, order) => sum + (order.paidInCents || 0), 0)
          + data.plateApplications.filter((item) => item.paymentStatus === 'PAID').reduce((sum, item) => sum + (item.feeInCents || 0), 0);
        const paidOrders = data.orders.filter((item) => ['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(item.status)).length
          + data.phoneCardOrders.filter((item) => ['PENDING_REALNAME', 'ACTIVATED'].includes(item.status)).length
          + data.rechargeOrders.filter((item) => ['PENDING_CREDIT', 'CREDITED'].includes(item.status)).length
          + data.plateApplications.filter((item) => item.paymentStatus === 'PAID').length;
        const pending = data.orders.filter((item) => ['PAID', 'FULFILLING', 'AFTER_SALE'].includes(item.status)).length
          + data.phoneCardOrders.filter((item) => item.status === 'PENDING_REALNAME').length
          + data.rechargeOrders.filter((item) => item.status === 'PENDING_CREDIT').length
          + data.broadbandApplications.filter((item) => item.status === 'PENDING_VERIFY').length
          + data.plateApplications.filter((item) => ['MATERIAL_PENDING', 'REVIEWING'].includes(item.status)).length;
        const financeEvents = data.financeEvents || [];
        const paymentTimeouts = [
          ...data.orders,
          ...data.phoneCardOrders,
          ...data.rechargeOrders,
          ...data.plateApplications
        ].filter((item) => item.cancelReason === 'PAYMENT_TIMEOUT').length;
        const financeSummary = {
          paymentInCents: financeEvents.filter((event) => event.eventType === 'PAYMENT').reduce((sum, event) => sum + event.amountInCents, 0),
          refundOutCents: financeEvents.filter((event) => event.eventType === 'REFUND').reduce((sum, event) => sum + event.amountInCents, 0),
          payoutOutCents: financeEvents.filter((event) => event.eventType === 'PAYOUT').reduce((sum, event) => sum + event.amountInCents, 0),
          netInCents: financeEvents.reduce((sum, event) => sum + event.amountInCents, 0)
        };
        const productFavoriteCounts = calculateProductFavoriteCounts(data);
        const favoriteDemandProducts = data.products
          .map((product) => ({
            id: product.id,
            name: product.name,
            merchantId: product.merchantId || '',
            merchantName: (data.merchants || []).find((merchant) => merchant.id === product.merchantId)?.name || '平台自营',
            favoriteCount: productFavoriteCounts.get(product.id) || 0,
            favoriteDemandText: favoriteDemandText(productFavoriteCounts.get(product.id) || 0),
            availableStock: availableStock(product)
          }))
          .filter((item) => item.favoriteCount > 0)
          .sort((a, b) => b.favoriteCount - a.favoriteCount)
          .slice(0, 10);
        return sendJson(response, 200, {
          data: {
            metrics: { revenueInCents, paidOrders, pending, lowStock: data.products.filter((item) => item.active !== false && availableStock(item) <= lowStockThreshold(data)).length, paymentTimeouts, leadsToday: leads.filter(x => x.createdAt.slice(0,10) === new Date().toISOString().slice(0,10)).length, leadsPending: leads.filter(x => openLeadStatuses.has(x.status)).length, leadsOverdue: leads.filter(x => x.slaDueAt < new Date().toISOString() && openLeadStatuses.has(x.status)).length, afterSaleOverdue: (data.afterSales || []).filter((item) => item.status !== 'CLOSED' && item.responseDueAt && item.responseDueAt < new Date().toISOString()).length, favoriteCount: favoriteDemandProducts.reduce((sum, item) => sum + item.favoriteCount, 0), favoriteDemandText: favoriteDemandText(favoriteDemandProducts.reduce((sum, item) => sum + item.favoriteCount, 0)) },
            lowStockProducts: data.products
              .filter((item) => item.active !== false && availableStock(item) <= lowStockThreshold(data))
              .sort((a, b) => availableStock(a) - availableStock(b))
              .map((item) => ({
                id: item.id,
                name: item.name,
                merchantId: item.merchantId || '',
                merchantName: (data.merchants || []).find((merchant) => merchant.id === item.merchantId)?.name || '平台自营',
                availableStock: availableStock(item),
                reservedStock: Number(item.reservedStock || 0),
                threshold: lowStockThreshold(data),
                alertedAt: item.lowStockAlertedAt || '',
                status: item.lowStockAlertStatus || ''
              })),
            products: data.products.map((product) => {
              const favoriteCount = productFavoriteCounts.get(product.id) || 0;
              return {
                ...withAvailableStock(product),
                ...productPromotionOrderMetrics(product, data, new Date().toISOString()),
                favoriteCount,
                favoriteDemandText: favoriteDemandText(favoriteCount)
              };
            }),
            favoriteDemandProducts,
            promotionSummary: (data.products || [])
              .filter((product) => Number(product.salePriceInCents || 0) > 0)
              .map((product) => ({
                id: product.id,
                name: product.name,
                merchantId: product.merchantId || '',
                merchantName: (data.merchants || []).find((merchant) => merchant.id === product.merchantId)?.name || '平台自营',
                priceInCents: Number(product.priceInCents || 0),
                salePriceInCents: Number(product.salePriceInCents || 0),
                saleStartsAt: product.saleStartsAt || '',
                saleEndsAt: product.saleEndsAt || '',
                ...productPromotionOrderMetrics(product, data, new Date().toISOString())
              }))
              .sort((a, b) => b.campaignAmountInCents - a.campaignAmountInCents),
            stockMovements: data.stockMovements || [],
            adminUsers: (data.adminUsers || []).map(publicAdminUser),
            rechargePromos: (data.rechargePromos || [])
              .map((item) => publicRechargePromo(item, data, new Date().toISOString())),
            merchants: data.merchants,
            qualificationRenewals: data.qualificationRenewals || [],
            orders: data.orders,
            phoneCardOrders: data.phoneCardOrders,
            rechargeOrders: data.rechargeOrders,
            broadbandApplications: data.broadbandApplications,
            plateApplications: data.plateApplications,
            paymentOrders: data.paymentOrders || [],
            paymentReconciliations: data.paymentReconciliations || [],
            financeTasks: data.financeTasks || [],
            notifications: data.notifications || [],
            afterSales: data.afterSales,
            productReviews: data.productReviews || [],
            settlements: data.settlements || [],
            settlementSummary: { ...settlementSummary(data.settlements || []), settlementPeriodDays: settlementPeriodDays(data), payoutMinimumInCents: payoutMinimumInCents(data) },
            payoutRequests: data.payoutRequests || [],
            financeEvents: data.financeEvents || [],
            financeSummary,
            slaAlerts: data.slaAlerts || [],
            slaSummary: slaSummary(data.slaAlerts || []),
            slaOwnerTasks: slaOwnerTasks(data.slaAlerts || []),
            patrolState: data.patrolState || {},
            operationsReport: dailyOperationsReports(data, 7),
            operationsInsights: operationsReportInsights(data),
            merchantScores: (data.merchants || [])
              .filter((merchant) => merchant.status === 'APPROVED' && merchant.serviceScore)
              .sort((a, b) => a.serviceScore.score - b.serviceScore.score)
              .map((merchant) => ({ merchantId: merchant.id, merchantName: merchant.name, ...merchant.serviceScore })),
            merchantScoreSummary: serviceScoreSummary(data.merchants || []),
            merchantScoreLogs: (data.merchantScoreLogs || []).slice(0, 50),
            settingChangeLogs: (data.settingChangeLogs || []).slice(0, 20),
            serviceScoreCases: (data.serviceScoreCases || []).slice(0, 80),
            autoDelistedProducts: (data.products || [])
              .filter((product) => product.autoDelistRule === 'LOW_QUALITY' && !product.active)
              .map((product) => ({
                id: product.id,
                name: product.name,
                merchantId: product.merchantId,
                merchantName: (data.merchants || []).find((merchant) => merchant.id === product.merchantId)?.name || '',
                reason: product.autoDelistReason || '',
                metrics: product.autoDelistEvidence || {},
                status: product.autoDelistStatus || 'DELISTED',
                caseNo: product.autoDelistCaseNo || '',
                reviewNote: product.autoDelistReviewNote || '',
                restoredAt: product.autoDelistRestoredAt || ''
              })),
            pendingPublishProducts: (data.products || [])
              .filter((product) => product.publishReviewStatus === 'PENDING_REVIEW')
              .map((product) => ({
                id: product.id,
                name: product.name,
                merchantId: product.merchantId,
                merchantName: (data.merchants || []).find((item) => item.id === product.merchantId)?.name || '',
                priceInCents: product.priceInCents,
                publishReviewNote: product.publishReviewNote || ''
              })),
            subscribeMessages: (data.subscribeMessages || []).slice(0, 120),
            orderMessageSubscribers: (data.orderMessageSubscribers || []).length,
            serviceMessageSubscribers: (data.serviceMessageSubscribers || []).length,
            subscribeStats: {
              queued: (data.subscribeMessages || []).filter((item) => item.status === 'QUEUED').length,
              sent: (data.subscribeMessages || []).filter((item) => item.status === 'SENT').length,
              failed: (data.subscribeMessages || []).filter((item) => item.status === 'FAILED').length
            },
            settings: data.adminSettings,
            auditLogs: data.auditLogs
            ,leads
          }, requestId
        });
      }

      if (request.method === 'GET' && pathname === '/api/admin/operations-report/export') {
        const data = store.read();
        const { reports, totals } = dailyOperationsReports(data, 14);
        const headers = ['日期', '电瓶车订单', '电话卡订单', '话费权益', '牌照申请', '完成电瓶车订单', '新增售后', '完成售后', '新增评价', '自动下架', '恢复上架', '服务分分档变化', '整改工单', '整改通过', '支付超时', '支付收入(元)', '退款支出(元)', '商家打款(元)', '净额(元)'];
        const money = (value) => ((Number(value) || 0) / 100).toFixed(2);
        const rows = reports.map((item) => [
          item.date, item.ebikeOrders, item.phoneCardOrders, item.rechargeOrders, item.plateApplications,
          item.completedEbikeOrders, item.afterSalesCreated, item.afterSalesClosed, item.reviewsCreated,
          item.autoDelists, item.complianceRestores, item.scoreStageChanges, item.rectifyCasesCreated, item.rectifyCasesApproved, item.paymentTimeouts,
          money(item.paymentInCents), money(item.refundOutCents), money(item.payoutOutCents), money(item.netInCents)
        ]);
        rows.push(['近14天合计', totals.ebikeOrders, totals.phoneCardOrders, totals.rechargeOrders, totals.plateApplications,
          totals.completedEbikeOrders, totals.afterSalesCreated, totals.afterSalesClosed, totals.reviewsCreated,
          totals.autoDelists, totals.complianceRestores, totals.scoreStageChanges, totals.rectifyCasesCreated, totals.rectifyCasesApproved, totals.paymentTimeouts,
          money(totals.paymentInCents), money(totals.refundOutCents), money(totals.payoutOutCents), money(totals.netInCents)]);
        const csv = [headers, ...rows].map((row) => row.map((value) => {
          const text = String(value ?? '');
          return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
        }).join(',')).join('\r\n');
        const fileName = `shishan-operations-report-${new Date().toISOString().slice(0, 10)}.csv`;
        response.writeHead(200, {
          'content-type': 'text/csv; charset=utf-8',
          'content-disposition': `attachment; filename="${fileName}"`,
          ...(response.corsOrigin ? { 'access-control-allow-origin': response.corsOrigin, vary: 'Origin' } : {}),
          'cache-control': 'no-store'
        });
        response.end(`${String.fromCharCode(65279)}${csv}`);
        return;
      }

      const adminSettlementMatch = pathname.match(/^\/api\/admin\/merchants\/([^/]+)\/settle$/);
      if (request.method === 'POST' && adminSettlementMatch) {
        const body = await readJson(request);
        const settlementReference = requireString(body.reference || '平台线下打款', 'reference', { maxLength: 120 });
        const result = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === adminSettlementMatch[1]);
          if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          if (!merchant.settlementAccountName || !merchant.settlementBank || !merchant.settlementAccount) {
            throw new ApiError(409, 'SETTLEMENT_ACCOUNT_INCOMPLETE', '商家收款账户资料不完整，暂不能结算');
          }
          const now = new Date().toISOString();
          const totalInCents = settleMerchant(data, merchant.id, now, settlementReference);
          addFinanceEvent(data, 'PAYOUT', `PAYOUT_${merchant.id}_${now}`, -totalInCents, {
            merchantId: merchant.id, merchantName: merchant.name, settlementReference
          }, now);
          const settlementCount = (data.settlements || []).filter((item) => item.merchantId === merchant.id && item.settlementStatus === 'SETTLED').length;
          addAudit(data, '平台确认商家结算', `${merchant.name} ${settlementReference}`);
          addNotification(data, merchant.userId, 'SETTLEMENT', '结算已完成', `平台已确认结算 ${settlementCount} 笔，合计 ¥${(totalInCents / 100).toFixed(2)}。`);
          return { merchantId: merchant.id, merchantName: merchant.name, totalInCents, settlementCount, settlementReference };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      const adminPayoutReviewMatch = pathname.match(/^\/api\/admin\/payout-requests\/([^/]+)\/review$/);
      if (request.method === 'POST' && adminPayoutReviewMatch) {
        const body = await readJson(request);
        const decision = requireString(body.decision, 'decision', { maxLength: 20 });
        if (!['APPROVE', 'REJECT'].includes(decision)) throw new ApiError(400, 'VALIDATION_ERROR', 'decision 需为 APPROVE 或 REJECT');
        const reference = decision === 'APPROVE' ? requireString(body.reference, 'reference', { maxLength: 120 }) : '';
        const reviewNote = decision === 'REJECT' ? requireString(body.reviewNote, 'reviewNote', { maxLength: 300 }) : String(body.reviewNote || '').slice(0, 300);
        const result = store.update((data) => {
          const payoutRequest = (data.payoutRequests || []).find((item) => item.id === adminPayoutReviewMatch[1]);
          if (!payoutRequest) throw new ApiError(404, 'PAYOUT_REQUEST_NOT_FOUND', '提现申请不存在');
          if (payoutRequest.status !== 'PENDING_REVIEW') throw new ApiError(409, 'PAYOUT_REQUEST_CLOSED', '该提现申请已处理');
          const now = new Date().toISOString();
          let receiptUrl = '';
          if (decision === 'APPROVE') {
            receiptUrl = String(body.receiptUrl || '').trim();
            if (!receiptUrl) throw new ApiError(400, 'PAYOUT_RECEIPT_REQUIRED', '确认打款前需上传银行回单');
            if (receiptUrl.length > 200 || !receiptUrl.startsWith('/api/admin/uploads/')) {
              throw new ApiError(400, 'PAYOUT_RECEIPT_INVALID', '打款回单必须来自平台上传目录');
            }
            const receiptPath = path.join(path.dirname(store.filePath), 'admin-receipts', path.basename(receiptUrl.replace('/api/admin/uploads/', '')));
            if (!fs.existsSync(receiptPath)) throw new ApiError(400, 'PAYOUT_RECEIPT_INVALID', '打款回单文件不存在');
          }
          if (decision === 'REJECT') {
            const restored = rejectPayoutRequest(data, payoutRequest, now, reviewNote);
            return { ...payoutRequest, restoredSettlementCount: restored };
          }
          payoutRequest.reviewNote = reviewNote;
          payoutRequest.receiptUrl = receiptUrl;
          const paidInCents = approvePayoutRequest(data, payoutRequest, now, reference);
          return { ...payoutRequest, paidAmountInCents: paidInCents };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/leads') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const now = new Date();
        const leadResponseHours = slaHours(store.read(), 'leadResponseHours', 24);
        const sourceType = typeof body.sourceType === 'string' ? body.sourceType.trim().slice(0, 30) : '';
        const sourceId = typeof body.sourceId === 'string' ? body.sourceId.trim().slice(0, 100) : '';
        const sourceRecord = leadSourceRecord(store.read(), userId, sourceType, sourceId);
        const sourceNo = sourceRecord?.orderNo || sourceRecord?.paymentNo || sourceRecord?.id || '';
        const lead = {
          id: `lead_${randomUUID()}`,
          leadNo: `LS${Date.now().toString().slice(-8)}`,
          userId,
          name: requireString(body.name, 'name', { maxLength: 50 }),
          phone: requireString(body.phone, 'phone', { maxLength: 30 }),
          businessType: requireString(body.businessType, 'businessType', { maxLength: 40 }),
          interest: requireString(body.interest || '未指定', 'interest', { maxLength: 120 }),
          expectedTime: (body.expectedTime || '尽快').toString().slice(0, 40),
          deliveryNeed: (body.deliveryNeed || '无').toString().slice(0, 120),
          note: (body.note || '').toString().slice(0, 500),
          sourceType,
          sourceId,
          sourceNo: String(sourceNo).slice(0, 100),
          status: 'SUBMITTED',
          assignee: '',
          followUps: [],
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
          slaDueAt: new Date(now.getTime() + leadResponseHours * 3600 * 1000).toISOString()
        };
        store.update(data => { if (!Array.isArray(data.leads)) data.leads=[]; data.leads.unshift(lead); addAudit(data,'新增咨询线索',lead.leadNo); });
        return sendJson(response,201,{data:lead,requestId});
      }
      if (request.method === 'GET' && pathname === '/api/service-records') {
        const { userId } = requireUser(request);
        const data = store.read();
        const phoneCardOrders = (data.phoneCardOrders || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.amountInCents || 0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const rechargeOrders = (data.rechargeOrders || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents || 0)/100).toFixed(0)}送${((item.receiveInCents || 0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.paidInCents || 0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const broadbandApplications = (data.broadbandApplications || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'BROADBAND', typeLabel:'宽带', title:'双人购卡宽带', status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:0, phone:item.ownerPhone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const plateApplications = (data.plateApplications || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel || '校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.feeInCents || 0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', phone:item.phone, studentNo:item.studentNo || '', materialCount:(item.materials || []).length, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const items = [...phoneCardOrders, ...rechargeOrders, ...broadbandApplications, ...plateApplications].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        return sendJson(response,200,{data:items,total:items.length,requestId});
      }
      if (request.method === 'GET' && pathname === '/api/my/orders') {
        const { userId } = requireUser(request);
        await sweepExpiredOrders();
        const data = store.read();
        const merchants = data.merchants || [];
          const userAfterSales = (data.afterSales || []).filter(item => item.userId === userId);
          const ebikeOrders = (data.orders || []).filter(item => item.userId === userId).map(order => ({ ...order, statusLabel:statusLabels[order.status]||order.status, collaboration:order.collaboration || createCollaboration(order, order.items?.[0]?.merchantId || ''), merchantName:merchants.find(merchant=>merchant.id===order.collaboration?.merchantId)?.name || '平台自营', plateApplicationId:((data.plateApplications||[]).find(plate=>(plate.relatedIds?.platformOrderIds||[]).includes(order.id))||{}).id || '', afterSales:userAfterSales.filter(item=>item.orderId===order.id).sort((a,b)=>String(b.createdAt).localeCompare(String(a.createdAt))).map(({userId,...record})=>({ ...record, statusLabel:{SUBMITTED:'待处理',REVIEWING:'处理中',CLOSED:'已完成'}[record.status]||record.status })) }));
        const serviceRecords = (() => {
          const phoneCardOrders=(data.phoneCardOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.amountInCents||0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', paymentExpiresAt:item.paymentExpiresAt || '', cancelReason:item.cancelReason || '', relatedIds:item.relatedIds||{}, collaboration:item.collaboration||null, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const rechargeOrders=(data.rechargeOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents||0)/100).toFixed(0)}送${((item.receiveInCents||0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.paidInCents||0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', paymentExpiresAt:item.paymentExpiresAt || '', cancelReason:item.cancelReason || '', relatedIds:item.relatedIds||{}, collaboration:item.collaboration||null, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const broadbandApplications=(data.broadbandApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'BROADBAND', typeLabel:'宽带', title:'双人购卡宽带', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:0, relatedIds:item.relatedIds||{}, collaboration:item.collaboration||null, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const plateApplications=(data.plateApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel||'校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.feeInCents||0, paymentOrderId:item.paymentOrderId||'', paymentStatus:item.paymentStatus||'', paymentExpiresAt:item.paymentExpiresAt || '', cancelReason:item.cancelReason || '', studentNo:item.studentNo||'', materialCount:(item.materials||[]).length, relatedIds:item.relatedIds||{}, collaboration:item.collaboration||null, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          return [...phoneCardOrders,...rechargeOrders,...broadbandApplications,...plateApplications];
        })();
        return sendJson(response,200,{data:{ebikeOrders,serviceRecords,afterSalesSummary:{activeCount:userAfterSales.filter(item=>item.status!=='CLOSED').length}},requestId});
      }

      if (request.method === 'GET' && pathname === '/api/my/product-reviews') {
        const { userId } = requireUser(request);
        const records = (store.read().productReviews || [])
          .filter((item) => item.userId === userId)
          .map((item) => ({ id:item.id, orderId:item.orderId, productId:item.productId, rating:item.rating, createdAt:item.createdAt }));
        return sendJson(response, 200, { data: records, total: records.length, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/my/notifications') {
        const { userId } = requireUser(request);
        const data = store.read();
        const items = (data.notifications || [])
          .filter((item) => item.userId === userId)
          .map((item) => ({ ...item, link: userNotificationLink(item) }));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/my/notifications/read') {
        const { userId } = requireUser(request);
        const updated = store.update((data) => {
          let count = 0;
          for (const item of data.notifications || []) {
            if (item.userId === userId && !item.read) { item.read = true; count += 1; }
          }
          return { updated: count };
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      const favoriteNoticeMatch = pathname.match(/^\/api\/my\/notifications\/([^/]+)\/action$/);
      if (request.method === 'POST' && favoriteNoticeMatch) {
        const { userId } = requireUser(request);
        const result = store.update((data) => {
          const notification = (data.notifications || []).find((item) => item.id === favoriteNoticeMatch[1]);
          if (!notification || notification.userId !== userId) throw new ApiError(404, 'NOTIFICATION_NOT_FOUND', '通知不存在');
          if (!notification.read) notification.read = true;
          const productId = notification.metadata?.productId;
          const product = productId ? (data.products || []).find((item) => item.id === productId) : null;
          if (!product || !product.active) throw new ApiError(404, 'PRODUCT_NOT_FOUND', '商品已下架');
          return { productId: product.id };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/phone-card-orders') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const productId = requireString(body.productId, 'productId', { maxLength: 100 });
        const planProduct = store.read().products.find((item) => item.id === productId && item.category === 'PHONE_PLAN' && item.active);
        if (!planProduct) throw new ApiError(404, 'PHONE_PLAN_NOT_FOUND', '套餐不存在或已下架');
        const amountInCents = withProductSale(planProduct).effectivePriceInCents;
        const cardIdempotencyKey = String(request.headers['idempotency-key'] || '');
        if (cardIdempotencyKey) {
          const compoundKey = `card:${userId}:${cardIdempotencyKey}`;
          const existingId = store.read().idempotencyKeys?.[compoundKey];
          if (existingId) {
            const existing = store.read().phoneCardOrders.find(item=>item.id===existingId);
            if (existing) return sendJson(response,200,{data:existing,requestId});
          }
        }
        const now = new Date().toISOString();
        const paymentTimeoutMinutes = Number(store.read().adminSettings?.paymentTimeoutMinutes || 30);
        const record = { id:`tel_${randomUUID()}`, userId, customerName:requireString(body.customerName,'customerName',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), productId, planName:planProduct.name, amountInCents, originalPriceInCents:planProduct.priceInCents, status:'PENDING_PAYMENT', paymentStatus:'UNPAID', paymentExpiresAt:new Date(new Date(now).getTime() + paymentTimeoutMinutes * 60 * 1000).toISOString(), relatedIds:{}, createdAt:now, updatedAt:now };
        const result = store.update(data=>{
          (data.phoneCardOrders=data.phoneCardOrders||[]).unshift(record);
          (data.rechargeOrders||[]).forEach(item=>{if(item.userId===userId&&item.phone===record.phone&&!item.relatedIds?.phoneCardOrderId)item.relatedIds={...(item.relatedIds||{}),phoneCardOrderId:record.id};});
          if(cardIdempotencyKey)data.idempotencyKeys[`card:${userId}:${cardIdempotencyKey}`]=record.id;
          if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
          const paymentOrder = {
            id:`pay_${randomUUID()}`,
            paymentNo:`PAY${Date.now()}${Math.floor(Math.random()*9000+1000)}`,
            businessType:'PHONE_PLAN',
            businessId:record.id,
            userId,
            amountInCents,
            currency:'CNY',
            status:'PENDING',
            idempotencyKey:cardIdempotencyKey?`card:${userId}:${cardIdempotencyKey}`:'',
            channel:paymentProvider.channel,
            provider:paymentProvider.name,
            providerTradeNo:'',
            providerPayload:null,
            createdAt:now,
            updatedAt:now,
            paidAt:'',
            refundedAt:''
          };
          data.paymentOrders.unshift(paymentOrder);
          record.paymentOrderId=paymentOrder.id;
          addAudit(data,'新增待支付电话卡订单',record.id);
          return { record, paymentOrder };
        });
        const paymentOrder = result.reused ? result.paymentOrder : await attachProviderIntent(result.paymentOrder);
        return sendJson(response, result.reused?200:201, { data:result.record, paymentOrder, requestId });
      }
      if (request.method === 'POST' && pathname === '/api/recharge-orders') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const promoId = requireString(body.promoId, 'promoId', { maxLength: 100 });
        const promoRead = store.read().rechargePromos?.find((item) => item.id === promoId && item.active !== false);
        if (!promoRead || rechargePromoAvailability(promoRead).status !== 'ACTIVE') {
          throw new ApiError(404, 'RECHARGE_PROMO_NOT_FOUND', '话费活动不存在、未开始或已结束');
        }
        const promo = promoRead;
        const paidInCents = Math.round(Number(promo.pay) * 100);
        const receiveInCents = Math.round(Number(promo.receive) * 100);
        const idempotencyKey = String(request.headers['idempotency-key'] || '');
        if (idempotencyKey) {
          const compoundKey = `recharge:${userId}:${idempotencyKey}`;
          const existingId = store.read().idempotencyKeys?.[compoundKey];
          if (existingId) {
            const existing = store.read().rechargeOrders.find(item=>item.id===existingId);
            if (existing) return sendJson(response,200,{data:existing,requestId});
          }
        }
        const now = new Date().toISOString();
        const paymentTimeoutMinutes = Number(store.read().adminSettings?.paymentTimeoutMinutes || 30);
        const record = { id:`top_${randomUUID()}`, userId, phone:requireString(body.phone,'phone',{maxLength:30}), promoId, paidInCents, receiveInCents, status:'PENDING_PAYMENT', paymentStatus:'UNPAID', paymentExpiresAt:new Date(new Date(now).getTime() + paymentTimeoutMinutes * 60 * 1000).toISOString(), relatedIds:{}, createdAt:now, updatedAt:now };
        const result = store.update(data=>{
          const related=(data.phoneCardOrders||[]).find(item=>item.userId===userId&&item.phone===record.phone);
          if(related)record.relatedIds={phoneCardOrderId:related.id};
          (data.rechargeOrders=data.rechargeOrders||[]).unshift(record);
          if(idempotencyKey)data.idempotencyKeys[`recharge:${userId}:${idempotencyKey}`]=record.id;
          if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
          const paymentOrder = {
            id:`pay_${randomUUID()}`,
            paymentNo:`PAY${Date.now()}${Math.floor(Math.random()*9000+1000)}`,
            businessType:'RECHARGE',
            businessId:record.id,
            userId,
            amountInCents:paidInCents,
            currency:'CNY',
            status:'PENDING',
            idempotencyKey:idempotencyKey?`recharge:${userId}:${idempotencyKey}`:'',
            channel:paymentProvider.channel,
            provider:paymentProvider.name,
            providerTradeNo:'',
            providerPayload:null,
            createdAt:now,
            updatedAt:now,
            paidAt:'',
            refundedAt:''
          };
          data.paymentOrders.unshift(paymentOrder);
          record.paymentOrderId=paymentOrder.id;
          addAudit(data,'新增待支付话费权益订单',record.id);
          return { record, paymentOrder };
        });
        const paymentOrder = await attachProviderIntent(result.paymentOrder);
        return sendJson(response,201,{data:result.record,paymentOrder,requestId});
      }
      if (request.method === 'POST' && pathname === '/api/broadband-applications') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const ownerPhone = requireString(body.ownerPhone,'ownerPhone',{maxLength:30});
        const companionPhone = requireString(body.companionPhone,'companionPhone',{maxLength:30});
        if (!/^1\d{10}$/.test(ownerPhone) || !/^1\d{10}$/.test(companionPhone)) throw new ApiError(400,'VALIDATION_ERROR','请输入正确的双方手机号');
        if (ownerPhone === companionPhone) throw new ApiError(400,'VALIDATION_ERROR','两个号码不能相同');
        const activatedCardNumbers = new Set((store.read().phoneCardOrders || [])
          .filter((item) => item.status === 'ACTIVATED')
          .map((item) => item.phone));
        if (!activatedCardNumbers.has(ownerPhone) || !activatedCardNumbers.has(companionPhone)) {
          throw new ApiError(409,'BROADBAND_ELIGIBILITY_NOT_MET','两位同学都需要已激活的校园电话卡');
        }
        const hasApplication = (store.read().broadbandApplications || []).some((item) => {
          return [`${item.ownerPhone}:${item.companionPhone}`, `${item.companionPhone}:${item.ownerPhone}`].includes(`${ownerPhone}:${companionPhone}`) && item.status !== 'REJECTED';
        });
        if (hasApplication) throw new ApiError(409,'BROADBAND_APPLICATION_EXISTS','这两位同学的宽带资格申请已存在');
        const now = new Date().toISOString();
        const record = { id:`net_${randomUUID()}`, userId, ownerPhone, companionPhone, status:'PENDING_VERIFY', relatedIds:{}, qualificationCheckedAt:now, createdAt:now, updatedAt:now };
        store.update(data=>{ (data.broadbandApplications=data.broadbandApplications||[]).unshift(record); addAudit(data,'新增宽带资格申请','双方已购卡且已激活'); });
        return sendJson(response,201,{data:record,requestId});
      }
      if (request.method === 'POST' && pathname === '/api/plate-applications') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const customerName = requireString(body.customerName,'customerName',{maxLength:50});
        const customerPhone = requireString(body.customerPhone,'customerPhone',{maxLength:30});
        const studentNo = requireString(body.studentNo,'studentNo',{maxLength:40});
        const vehicleModel = requireString(body.vehicleModel,'vehicleModel',{maxLength:80});
        const now = new Date().toISOString();
        const paymentTimeoutMinutes = Number(store.read().adminSettings?.paymentTimeoutMinutes || 30);
        const result = store.update(data=>{
          const order = body.orderId ? (data.orders||[]).find(item=>item.id===body.orderId && item.userId===userId) : null;
          if (body.orderId && !order) throw new ApiError(404,'ORDER_NOT_FOUND','Order not found');
          const platformOrder = order && (data.products||[]).find(product=>product.id===order.items?.[0]?.productId)?.category === 'E_BIKE_NEW';
          const feeInCents = platformOrder ? 0 : ((data.adminSettings||{}).externalPlateFeeInCents ?? 4900);
          const application = { id:`plate_${randomUUID()}`, userId, customerName, phone:customerPhone, studentNo, vehicleModel, source:platformOrder?'PLATFORM_ORDER':'EXTERNAL', feeInCents, relatedOrderId:order?.id || '', status:platformOrder?'MATERIAL_PENDING':'PENDING_PAYMENT', paymentStatus:platformOrder?'PAID':'UNPAID', paymentExpiresAt:platformOrder?'':new Date(new Date(now).getTime() + paymentTimeoutMinutes * 60 * 1000).toISOString(), relatedIds:order?{ platformOrderIds:[order.id] }:{}, createdAt:now, updatedAt:now };
          if (!platformOrder) {
            const paymentOrder = {
              id:`pay_${randomUUID()}`,
              paymentNo:`PAY${Date.now()}${Math.floor(Math.random()*9000+1000)}`,
              userId,
              orderId:'',
              businessType:'PLATE',
              businessId:application.id,
              amountInCents:feeInCents,
              currency:'CNY',
              status:'PENDING',
              channel:paymentProvider.channel,
              provider:paymentProvider.name,
              providerTradeNo:'',
              providerPayload:null,
              createdAt:now,
              updatedAt:now,
              paidAt:'',
              refundedAt:''
            };
            (data.paymentOrders=data.paymentOrders||[]).unshift(paymentOrder);
            application.paymentOrderId = paymentOrder.id;
            addAudit(data,'创建自带车上牌待支付单',application.id);
          }
          (data.plateApplications=data.plateApplications||[]).unshift(application);
          addAudit(data,'新增校园牌照辅助申请',application.id);
          return { application, paymentOrder: !platformOrder ? (data.paymentOrders||[]).find(item=>item.id===application.paymentOrderId) : null };
        });
        const paymentOrder = await attachProviderIntent(result.paymentOrder);
        return sendJson(response,201,{data:result.application,paymentOrder,requestId});
      }
      const businessMatch = pathname.match(/^\/api\/service-records\/([^/]+)\/actions$/);
      const plateMaterialMatch = pathname.match(/^\/api\/plate-applications\/([^/]+)\/materials$/);
      if (request.method === 'POST' && plateMaterialMatch) {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        if (!Array.isArray(body.images) || !body.images.length || body.images.length > 6) throw new ApiError(400,'VALIDATION_ERROR','请上传 1 到 6 张材料图片');
        const images = body.images.map((image, index) => {
          const url = requireString(image, `images.${index}`, { maxLength: 200 });
          if (!url.startsWith('/api/uploads/')) throw new ApiError(400,'VALIDATION_ERROR','材料图片必须来自平台上传目录');
          return url;
        });
        const application = store.update((data) => {
          const item = (data.plateApplications || []).find(row => row.id === plateMaterialMatch[1] && row.userId === userId);
          if (!item) throw new ApiError(404,'PLATE_APPLICATION_NOT_FOUND','Plate application not found');
          if (!['MATERIAL_PENDING','REVIEWING'].includes(item.status)) throw new ApiError(409,'PLATE_STATUS_NOT_ALLOWED','当前状态暂不能上传材料');
          const existing = Array.isArray(item.materials) ? item.materials : [];
          if (existing.length + images.length > 9) throw new ApiError(409,'PLATE_MATERIAL_LIMIT','每个牌照工单最多上传 9 张材料');
          const now = new Date().toISOString();
          item.materials = [...existing, ...images.map(url => ({ id:`mat_${randomUUID().slice(0,8)}`, url, uploadedAt:now }))];
          item.updatedAt = now;
          addAudit(data,'用户上传校园牌照材料',item.id);
          addNotification(data,userId,'PLATE','牌照材料已提交','客服将核对车辆和身份材料，如需补充会另行联系。');
          return item;
        });
        return sendJson(response,200,{data:application,requestId});
      }
      if (request.method === 'POST' && businessMatch) {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const action = requireString(body.action, 'action', { maxLength:40 });
        const recordId = businessMatch[1];
        const result = store.update((data) => {
          const collections = [
            { key:'phoneCardOrders', type:'PHONE_PLAN' },
            { key:'rechargeOrders', type:'RECHARGE' },
            { key:'broadbandApplications', type:'BROADBAND' },
            { key:'plateApplications', type:'PLATE' }
          ];
          for (const collection of collections) {
            const item = (data[collection.key] || []).find(row => row.id === recordId && row.userId === userId);
            if (!item) continue;
            if (collection.type === 'PHONE_PLAN' && action === 'APPLY_BROADBAND') {
              if (item.relatedIds?.broadbandApplicationId) throw new ApiError(409,'ACTION_ALREADY_DONE','该订单已提交宽带资格');
              const companionPhone = requireString(body.companionPhone, 'companionPhone', { maxLength: 30 });
              if (!/^1\d{10}$/.test(companionPhone) || companionPhone === item.phone) throw new ApiError(400,'VALIDATION_ERROR','请填写与本人不同的同伴手机号');
              const activatedPhones = new Set((data.phoneCardOrders || []).filter((row) => row.status === 'ACTIVATED').map((row) => row.phone));
              if (!activatedPhones.has(item.phone) || !activatedPhones.has(companionPhone)) throw new ApiError(409,'BROADBAND_ELIGIBILITY_NOT_MET','两位同学都需要已激活的校园电话卡');
              const application = { id:`net_${randomUUID().slice(0,8)}`, userId, ownerPhone:item.phone, companionPhone, relatedOrderId:item.id, status:'PENDING_VERIFY', relatedIds:{ phoneCardOrderId:item.id }, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
              (data.broadbandApplications = data.broadbandApplications || []).unshift(application);
              item.relatedIds = { ...(item.relatedIds || {}), broadbandApplicationId:application.id };
              item.updatedAt = new Date().toISOString();
              addAudit(data, '电话卡订单申请宽带资格', item.id);
              return { type:'BROADBAND', record:application };
            }
            if (collection.type === 'RECHARGE' && action === 'ACTIVATE_CARD') {
              if (!item.relatedIds?.phoneCardOrderId) throw new ApiError(409,'ACTION_NOT_ALLOWED','请先关联电话卡订单');
              const cardOrder = (data.phoneCardOrders || []).find(row => row.id === item.relatedIds.phoneCardOrderId && row.userId === userId);
              if (!cardOrder) throw new ApiError(404,'RELATED_ORDER_NOT_FOUND','未找到关联电话卡订单');
              if (cardOrder.status === 'ACTIVATED') throw new ApiError(409,'ACTION_ALREADY_DONE','电话卡已激活');
              cardOrder.status = 'ACTIVATED';
              cardOrder.updatedAt = new Date().toISOString();
              addAudit(data, '话费权益订单激活电话卡', cardOrder.id);
              return { type:'PHONE_PLAN', record:cardOrder };
            }
            if (collection.type === 'PLATE' && action === 'SYNC_PLATFORM_ORDER') {
              const order = (data.orders || []).find(row => row.userId === userId && (item.relatedIds?.platformOrderIds || []).includes(row.id));
              if (!order) throw new ApiError(404,'PLATFORM_ORDER_NOT_FOUND','未找到平台购车订单');
              item.source = 'PLATFORM_ORDER';
              item.feeInCents = 0;
              item.updatedAt = new Date().toISOString();
              addAudit(data, '牌照辅助关联平台购车订单', item.id);
              return { type:'PLATE', record:item };
            }
            break;
          }
          throw new ApiError(404,'SERVICE_RECORD_NOT_FOUND','Service record not found');
        });
        return sendJson(response,200,{data:result.record,type:result.type,requestId});
      }
      if (request.method === 'GET' && pathname === '/api/admin/leads') return sendJson(response,200,{data:store.read().leads||[],requestId});
      const leadMatch = pathname.match(/^\/api\/admin\/leads\/([^/]+)$/);
      if (request.method === 'PATCH' && leadMatch) {
        const actor = requireAdmin(request, 'ORDER_MANAGE');
        const body = await readJson(request);
        if (body.status !== undefined && !allowedLeadStatuses.has(body.status)) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported lead status. Use SUBMITTED, FOLLOW_UP, COMPLETED or INVALID.');
        }
        const updated = store.update((data) => {
          const item = (data.leads || []).find((x) => x.id === leadMatch[1]);
          if (!item) throw new ApiError(404, 'LEAD_NOT_FOUND', 'Lead not found');
          for (const k of ['status','assignee','interest','expectedTime','deliveryNeed','note']) {
            if (body[k] !== undefined) item[k] = String(body[k]).slice(0, 500);
          }
          item.updatedAt = new Date().toISOString();
          addAudit(data, '更新咨询线索', item.leadNo, actor.displayName || actor.username);
          return item;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }
      const followMatch = pathname.match(/^\/api\/admin\/leads\/([^/]+)\/follow-ups$/);
      if (request.method === 'POST' && followMatch) {
        const actor = requireAdmin(request, 'ORDER_MANAGE');
        const body = await readJson(request);
        if (body.status !== undefined && !allowedLeadStatuses.has(body.status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported lead status. Use SUBMITTED, FOLLOW_UP, COMPLETED or INVALID.');
        const now = new Date().toISOString();
        const updated = store.update((data) => {
          const item = (data.leads || []).find((x) => x.id === followMatch[1]);
          if (!item) throw new ApiError(404, 'LEAD_NOT_FOUND', 'Lead not found');
          const text = requireString(body.content, 'content', { maxLength: 500 });
          const operator = actor.displayName || actor.username;
          if (!item.assignee) item.assignee = operator;
          if (!item.assigneeId) item.assigneeId = actor.id;
          if (!item.assigneeRole) item.assigneeRole = actor.role;
          item.followUps = item.followUps || [];
          item.followUps.unshift({
            id: `fu_${randomUUID()}`,
            content: text,
            operator,
            createdAt: now
          });
          if (body.status !== undefined) item.status = body.status;
          item.updatedAt = now;

          const source = item.sourceType && item.sourceId
            ? leadSourceRecord(data, item.userId, item.sourceType, item.sourceId)
            : null;
          if (source) {
            if (item.sourceType === 'ORDER') appendCollaborationEvent(source, 'PLATFORM', 'LEAD_FOLLOW_UP', text);
            else appendServiceRecordEvent(source, 'PLATFORM', 'LEAD_FOLLOW_UP', text);
            sendLeadFollowUpNotification(data, item.userId, item.sourceType, '咨询跟进更新', `${item.businessType}：${text}`, now, { focusId: source.id });
          } else {
            sendLeadFollowUpNotification(data, item.userId, 'LEAD', '咨询跟进更新', `${item.businessType}：${text}`, now);
          }
          addAudit(data, '线索跟进', item.leadNo, operator);
          return item;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }
      if (request.method === 'GET' && pathname === '/api/admin/leads/export') { const leads=store.read().leads||[]; return sendJson(response,200,{data:leads,requestId}); }

      const adminReviewVisibilityMatch = pathname.match(/^\/api\/admin\/product-reviews\/([^/]+)\/visibility$/);
      const merchantReviewReplyMatch = pathname.match(/^\/api\/merchant\/product-reviews\/([^/]+)\/reply$/);
      if (request.method === 'POST' && merchantReviewReplyMatch) {
        const body = await readJson(request);
        const content = requireString(body.content, 'content', { maxLength: 300 });
        const review = store.update((data) => {
          const item = (data.productReviews || []).find((record) => record.id === merchantReviewReplyMatch[1]);
          if (!item) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
          const ownsProduct = data.products.some((product) => product.id === item.productId && product.merchantId === merchantSession.merchantId);
          if (!ownsProduct) throw new ApiError(403, 'REVIEW_FORBIDDEN', '只能回复自己店铺的商品评价');
          const repliedProduct = data.products.find((product) => product.id === item.productId);
          item.reply = {
            merchantName: data.merchants.find((merchant) => merchant.id === merchantSession.merchantId)?.name || '商家回复',
            content,
            repliedAt: new Date().toISOString()
          };
          item.updatedAt = item.reply.repliedAt;
          sendOrderNotification(
            data,
            item.userId,
            'ORDER',
            '你的评价收到了商家回复',
            `${repliedProduct?.name || '商品'}：${content}`
          );
          addAudit(data, '商家回复商品评价', item.productId);
          // 差评处理率是服务分的计算维度，回复完成后立即落盘，避免后台与用户端看到旧分数。
          refreshMerchantScores(data, item.reply.repliedAt);
          return item;
        });
        return sendJson(response, 200, { data: review, requestId });
      }

      if (request.method === 'POST' && adminReviewVisibilityMatch) {
        const body = await readJson(request);
        const visibility = requireString(body.visibility, 'visibility', { maxLength: 20 });
        if (!['PUBLISHED', 'HIDDEN'].includes(visibility)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported review visibility');
        const review = store.update((data) => {
          const item = (data.productReviews || []).find((record) => record.id === adminReviewVisibilityMatch[1]);
          if (!item) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Review not found');
          item.visibility = visibility;
          item.updatedAt = new Date().toISOString();
          addAudit(data, visibility === 'HIDDEN' ? '隐藏商品评价' : '恢复商品评价', item.productId);
          return item;
        });
        return sendJson(response, 200, { data: review, requestId });
      }

      const adminStatusMatch = pathname.match(/^\/api\/admin\/(orders|phone-card-orders|recharge-orders|broadband-applications|plate-applications|after-sales)\/([^/]+)\/status$/);
      if (request.method === 'POST' && adminStatusMatch) {
        const body = await readJson(request);
        const status = requireString(body.status, 'status', { maxLength: 50 });
        const resolutionNote = adminStatusMatch[1] === 'after-sales' && status === 'CLOSED'
          ? requireString(body.resolutionNote, 'resolutionNote', { maxLength: 500 })
          : '';
        const collectionMap = { orders: 'orders', 'phone-card-orders': 'phoneCardOrders', 'recharge-orders': 'rechargeOrders', 'broadband-applications': 'broadbandApplications', 'plate-applications': 'plateApplications', 'after-sales': 'afterSales' };
        const notificationTemplates = {
          orders: {
            PENDING_PAYMENT:['ORDER','订单待支付','请尽快完成支付，超时未支付可取消订单。'],
            PAID:['ORDER','订单已支付','商家已收到订单，将尽快安排校内配送。'],
            FULFILLING:['ORDER','订单配送中','商家正在按约定安排校内配送。'],
            COMPLETED:['ORDER','订单已完成','本次服务已完成，欢迎评价本次体验。'],
            CANCELLED:['ORDER','订单已取消','您的订单已取消，如需服务请重新下单。'],
            AFTER_SALE:['ORDER','售后处理中','您的售后请求已进入处理流程。']
          },
          'phone-card-orders': {
            PENDING_PAYMENT:['PHONE_PLAN','电话卡订单待支付','请完成支付后进入实名激活流程。'],
            PENDING_REALNAME:['PHONE_PLAN','电话卡待实名激活','运营人员将协助您完成实名激活。'],
            ACTIVATED:['PHONE_PLAN','电话卡已激活','您的校园电话卡已激活，可正常使用。'],
            CANCELLED:['PHONE_PLAN','电话卡订单已取消','您的电话卡订单已取消。'],
            REJECTED:['PHONE_PLAN','电话卡办理未通过','办理未通过，请联系客服确认原因。']
          },
          'recharge-orders': {
            PENDING_PAYMENT:['RECHARGE','话费权益待支付','请完成支付后等待确认到账。'],
            PENDING_CREDIT:['RECHARGE','话费权益待到账','支付成功，运营将确认优惠到账。'],
            CREDITED:['RECHARGE','话费权益已到账','您的限时话费权益已到账。'],
            CANCELLED:['RECHARGE','话费权益已取消','您的话费权益订单已取消。'],
            REJECTED:['RECHARGE','话费权益办理未通过','办理未通过，请联系客服确认原因。']
          },
          'broadband-applications': {
            PENDING_VERIFY:['BROADBAND','宽带资格待核验','我们正在核验双人购卡宽带资格。'],
            APPROVED:['BROADBAND','宽带资格已通过','资格核验通过，可预约宽带安装。'],
            REJECTED:['BROADBAND','宽带资格未通过','资格核验未通过，请联系客服确认原因。']
          },
          'plate-applications': {
            PENDING_PAYMENT:['PLATE','校园牌照待支付','请完成自带车服务费支付后进入材料跟进。'],
            MATERIAL_PENDING:['PLATE','校园牌照待补材料','请按提示补充车辆和身份材料。'],
            REVIEWING:['PLATE','校园牌照审核中','校园牌照材料已进入审核流程。'],
            COMPLETED:['PLATE','校园牌照办理完成','校园牌照辅助办理已完成。'],
            REJECTED:['PLATE','校园牌照办理未通过','办理未通过，请联系客服确认原因。']
          },
          'after-sales': {
            SUBMITTED:['AFTER_SALE','售后已受理','您的售后请求已受理，预计 24 小时内响应。'],
            REVIEWING:['AFTER_SALE','售后处理中','客服正在处理您的售后请求。'],
            CLOSED:['AFTER_SALE','售后已关闭','您的售后工单已关闭。']
          }
        };
        if (!adminOrderStatuses[adminStatusMatch[1]].has(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported status');
        const updated = store.update((data) => {
          const item = data[collectionMap[adminStatusMatch[1]]].find((record) => record.id === adminStatusMatch[2]);
          if (!item) throw new ApiError(404, 'ADMIN_RECORD_NOT_FOUND', 'Record not found');
          const isOrder = adminStatusMatch[1] === 'orders';
          const isPendingPaymentCollection = ['orders', 'phone-card-orders', 'recharge-orders', 'plate-applications'].includes(adminStatusMatch[1]);
          if (isOrder) {
            if (status === 'PAID') throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', '已支付状态必须通过支付单确认，不能人工设置');
            if (status === 'FULFILLING' && item.status !== 'PAID') throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', '仅已支付订单可以进入履约');
            if (status === 'COMPLETED' && !['PAID', 'FULFILLING'].includes(item.status)) throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', '仅未完成订单可以标记完成');
            if (status === 'CANCELLED' && item.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', '已支付订单请先走售后退款，不能直接取消');
          }
          item.status = status; item.updatedAt = new Date().toISOString(); addAudit(data, `更新${adminStatusMatch[1]}状态为${status}`, item.id);
          if (isPendingPaymentCollection && status === 'PENDING_PAYMENT') {
            const timeoutMinutes = Number(data.adminSettings?.paymentTimeoutMinutes || 30);
            item.paymentExpiresAt = new Date(new Date(item.updatedAt).getTime() + timeoutMinutes * 60 * 1000).toISOString();
          }
          if (isOrder && status === 'CANCELLED') {
            releaseOrderStock(data, item);
            const paymentOrder = (data.paymentOrders || []).find((row) => row.id === item.paymentOrderId);
            if (paymentOrder && paymentOrder.status === 'PENDING') {
              paymentOrder.status = 'CANCELLED';
              paymentOrder.updatedAt = item.updatedAt;
            }
            item.cancelReason = 'PLATFORM_CANCELLED';
            item.collaboration ||= createCollaboration(item, item.items[0]?.merchantId || '');
            appendCollaborationEvent(item, 'PLATFORM', 'CANCELLED', '平台已取消待支付订单，库存已释放');
            addAudit(data, '平台取消待支付订单并释放库存', item.orderNo);
          }
          if (isOrder && status === 'FULFILLING') {
            item.collaboration ||= createCollaboration(item, item.items[0]?.merchantId || '');
            issueDeliveryCode(item, item.updatedAt);
            appendCollaborationEvent(item, 'PLATFORM', 'ACCEPT', '平台已确认履约，校内配送将按约定执行');
            notifyOrderMerchant(data, item, 'ORDER', '平台已确认履约', `订单 ${item.orderNo} 已由平台确认履约，请尽快安排校内配送。`);
          }
          if (isOrder && status === 'COMPLETED') {
            const providedCode = typeof body.deliveryCode === 'string' ? requireString(body.deliveryCode, 'deliveryCode', { maxLength: 6 }) : '';
            const completionNote = String(body.completionNote || '').trim();
            if (!providedCode && completionNote.length < 8) {
              throw new ApiError(400, 'VALIDATION_ERROR', '未提供交付码时，请填写至少 8 字的平台核验依据');
            }
            if (!item.deliveryCode) issueDeliveryCode(item, item.updatedAt);
            if (providedCode && item.deliveryCode !== providedCode) {
              throw new ApiError(409, 'DELIVERY_CODE_INVALID', '交付码不正确，请与用户确认后完成订单');
            }
            item.collaboration ||= createCollaboration(item, item.items[0]?.merchantId || '');
            appendCollaborationEvent(
              item,
              'PLATFORM',
              'COMPLETE',
              providedCode ? '平台已核验交付码，订单已完成' : `平台代履约完成：${completionNote}`
            );
            addAudit(data, providedCode ? '平台核验交付码完成订单' : '平台代履约完成订单', item.orderNo);
          }
          if (adminStatusMatch[1] === 'after-sales' && status === 'CLOSED') {
            const order = (data.orders || []).find((row) => row.id === item.orderId);
            if (order && item.type === 'REFUND') applyOrderRefund(data, order, item.updatedAt);
            else if (order) {
              order.status = 'COMPLETED';
              order.updatedAt = item.updatedAt;
              unfreezeOrderSettlements(data, order, item.updatedAt);
              activateOrderSettlements(data, order, item.updatedAt);
            }
            item.resolutionNote = resolutionNote;
          }
          if (adminStatusMatch[1] === 'orders' && status === 'COMPLETED') {
            activateOrderSettlements(data, item, item.updatedAt);
          }
          if (adminStatusMatch[1] === 'orders' && status === 'AFTER_SALE') {
            freezeOrderSettlements(data, item, item.updatedAt, '平台已将订单转入售后');
          }
          const template = adminStatusMatch[1] === 'after-sales' && status === 'CLOSED'
            ? null
            : notificationTemplates[adminStatusMatch[1]]?.[status];
          if (adminStatusMatch[1] === 'after-sales' && status === 'CLOSED' && item.userId) {
            sendOrderNotification(data, item.userId, 'AFTER_SALE', '售后处理完成', resolutionNote, item.updatedAt, { focusId: item.orderId || item.id });
          }
          if (template && item.userId) {
            const detail = item.planName || item.vehicleModel || item.reason || item.orderNo || item.id;
            const message = adminStatusMatch[1] === 'after-sales' && status === 'SUBMITTED'
              ? `您的售后请求已受理，预计 ${publicSettings(data.adminSettings).afterSaleResponseHours} 小时内响应。`
              : template[2];
            sendOrderNotification(data, item.userId, adminStatusMatch[1] === 'after-sales' ? 'AFTER_SALE' : 'ORDER_STATUS', template[1], `${detail}：${message}`, item.updatedAt, { focusId: item.id });
          }
          return item;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      const adminMerchantStatusMatch = pathname.match(/^\/api\/admin\/merchants\/([^/]+)\/status$/);
      if (request.method === 'POST' && adminMerchantStatusMatch) {
        const body = await readJson(request);
        const status = requireString(body.status, 'status', { maxLength: 30 });
        if (!allowedMerchantStatuses.has(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported merchant status');
        const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 300) : '';
        const merchant = store.update((data) => {
          const item = (data.merchants || []).find((row) => row.id === adminMerchantStatusMatch[1]);
          if (!item) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          item.status = status;
          item.reviewNote = reviewNote;
          item.timeline = item.timeline || [];
          item.timeline.push({ status, note: reviewNote || (status === 'APPROVED' ? '平台审核通过' : '商家申请被驳回'), createdAt: new Date().toISOString() });
          item.updatedAt = new Date().toISOString();
          addAudit(data, `更新商家状态为${status}`, item.name);
          return item;
        });
        return sendJson(response, 200, { data: merchant, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/qualification-renewals') {
        const data = store.read();
        const items = (data.qualificationRenewals || [])
          .slice()
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      const qualificationReviewMatch = pathname.match(/^\/api\/admin\/qualification-renewals\/([^/]+)\/review$/);
      if (request.method === 'POST' && qualificationReviewMatch) {
        const body = await readJson(request);
        const decision = requireString(body.decision, 'decision', { maxLength: 20 });
        if (!['APPROVE', 'REJECT'].includes(decision)) throw new ApiError(400, 'VALIDATION_ERROR', 'decision 需为 APPROVE 或 REJECT');
        const reviewNote = typeof body.reviewNote === 'string' ? body.reviewNote.trim().slice(0, 300) : '';
        if (decision === 'REJECT' && !reviewNote) throw new ApiError(400, 'VALIDATION_ERROR', '驳回需要填写原因');
        const renewal = store.update((data) => {
          const item = (data.qualificationRenewals || []).find((row) => row.id === qualificationReviewMatch[1]);
          if (!item) throw new ApiError(404, 'QUALIFICATION_RENEWAL_NOT_FOUND', '资质复审申请不存在');
          if (item.status !== 'PENDING_REVIEW') throw new ApiError(409, 'QUALIFICATION_RENEWAL_CLOSED', '该资质复审申请已处理');
          const merchant = (data.merchants || []).find((row) => row.id === item.merchantId);
          if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          const now = new Date().toISOString();
          item.status = decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
          item.reviewNote = reviewNote || (decision === 'APPROVE' ? '资质复审通过' : '');
          item.reviewedAt = now;
          item.updatedAt = now;
          merchant.timeline = merchant.timeline || [];
          if (decision === 'APPROVE') {
            merchant.licenseNo = item.licenseNo;
            merchant.licenseUrl = item.licenseUrl;
            merchant.licenseExpireDate = item.licenseExpireDate;
            merchant.timeline.push({ status: 'APPROVED', note: `资质复审通过，有效期 ${item.licenseExpireDate}`, createdAt: now });
            addAudit(data, '资质复审通过', merchant.name);
          } else {
            merchant.timeline.push({ status: 'REVIEWING', note: `资质复审未通过：${reviewNote}`, createdAt: now });
            addAudit(data, '资质复审未通过', merchant.name);
          }
          merchant.updatedAt = now;
          notifyMerchant(data, merchant.id, 'SCORE', decision === 'APPROVE' ? '资质复审通过' : '资质复审未通过',
            decision === 'APPROVE'
              ? `新资质有效期 ${item.licenseExpireDate} 已生效。`
              : `复审未通过：${reviewNote}。请补充材料后重新提交。`);
          return item;
        });
        return sendJson(response, 200, { data: renewal, requestId });
      }

      const adminProductMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);

      // 平台复核限流商家的新商品：通过即上架，驳回保持下架并给出原因。
      const adminProductReviewMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)\/publish-review$/);
      if (request.method === 'POST' && adminProductReviewMatch) {
        const body = await readJson(request);
        const decision = requireString(body.decision, 'decision', { maxLength: 20 });
        if (!['APPROVED', 'REJECTED'].includes(decision)) throw new ApiError(400, 'VALIDATION_ERROR', 'decision 需为 APPROVED 或 REJECTED');
        const note = typeof body.note === 'string' ? body.note.trim().slice(0, 200) : '';
        if (decision === 'REJECTED' && !note) throw new ApiError(400, 'VALIDATION_ERROR', '驳回需要填写原因');
        const updated = store.update((data) => {
          const product = data.products.find((item) => item.id === adminProductReviewMatch[1]);
          if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
          if (product.publishReviewStatus !== 'PENDING_REVIEW') throw new ApiError(409, 'PRODUCT_REVIEW_NOT_PENDING', '该商品不在待复核状态');
          const now = new Date().toISOString();
          product.publishReviewStatus = decision;
          product.publishReviewNote = note || (decision === 'APPROVED' ? '平台复核通过' : '');
          product.active = decision === 'APPROVED';
          product.updatedAt = now;
          addAudit(data, decision === 'APPROVED' ? '复核通过商家商品' : '复核驳回商家商品', product.name);
          notifyMerchant(data, product.merchantId, 'SCORE', decision === 'APPROVED' ? '商品复核通过' : '商品复核未通过',
            `${product.name}${decision === 'APPROVED' ? ' 已上架。' : ` 未通过复核：${note}`}`);
          return product;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      // 服务分列表让运营一眼看到谁在被限流、限流原因是什么。
      if (request.method === 'GET' && pathname === '/api/admin/merchant-scores') {
        sweepOperationsPatrol();
        const refreshed = store.update((data) => {
          refreshMerchantScores(data, new Date().toISOString());
          return data.merchants || [];
        });
        const data = store.read();
        const stageFilter = url.searchParams.get('stage');
        const items = refreshed
          .filter((merchant) => merchant.status === 'APPROVED')
          .filter((merchant) => !stageFilter || merchant.serviceScore?.stage === stageFilter)
          .sort((a, b) => (a.serviceScore?.score ?? 0) - (b.serviceScore?.score ?? 0))
          .map((merchant) => ({
            merchantId: merchant.id,
            merchantName: merchant.name,
            category: merchant.category,
            ...merchant.serviceScore
          }));
        return sendJson(response, 200, {
          data: items,
          total: items.length,
          summary: serviceScoreSummary(data.merchants || []),
          scoreLogs: (data.merchantScoreLogs || []).slice(0, 50),
          pendingProducts: (data.products || [])
            .filter((product) => product.publishReviewStatus === 'PENDING_REVIEW')
            .map((product) => ({
              id: product.id,
              name: product.name,
              merchantId: product.merchantId,
              merchantName: (data.merchants || []).find((item) => item.id === product.merchantId)?.name || '',
              priceInCents: product.priceInCents,
              publishReviewNote: product.publishReviewNote || ''
            })),
          requestId
        });
      }

      // 人工加减分用于处理线下事实（例如学校投诉、商家整改验收），并限制在 ±20 分内。
      const adminScoreAdjustMatch = pathname.match(/^\/api\/admin\/merchant-scores\/([^/]+)\/adjust$/);
      if (request.method === 'POST' && adminScoreAdjustMatch) {
        const body = await readJson(request);
        const adjustment = Number(body.adjustment);
        if (!Number.isInteger(adjustment) || adjustment < -20 || adjustment > 20) throw new ApiError(400, 'VALIDATION_ERROR', '人工调整需为 -20 到 20 的整数');
        const reason = requireString(body.reason, 'reason', { maxLength: 200 });
        const result = store.update((data) => {
          const merchant = (data.merchants || []).find((item) => item.id === adminScoreAdjustMatch[1]);
          if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          if (merchant.status !== 'APPROVED') throw new ApiError(409, 'MERCHANT_NOT_APPROVED', '只能为已通过审核的商家调整服务分');
          const now = new Date().toISOString();
          const previous = merchant.serviceScore || computeMerchantScore(data, merchant, now);
          merchant.serviceScore = { ...previous, manualAdjustment: adjustment };
          merchant.serviceScore = computeMerchantScore(data, merchant, now);
          merchant.updatedAt = now;
          addMerchantScoreLog(data, merchant, {
            type: 'MANUAL_ADJUST',
            fromStage: previous.stage,
            toStage: merchant.serviceScore.stage,
            adjustment,
            note: `人工调整 ${adjustment > 0 ? '+' : ''}${adjustment} 分：${reason}`
          }, now);
          addAudit(data, '调整商家服务分', `${merchant.name} ${adjustment > 0 ? '+' : ''}${adjustment}`);
          notifyMerchant(data, merchant.id, 'SCORE', '服务分已人工调整',
            `平台调整 ${adjustment > 0 ? '+' : ''}${adjustment} 分：${reason}。当前 ${merchant.serviceScore.score} 分（${merchant.serviceScore.stageLabel}）。`);
          return { merchantId: merchant.id, merchantName: merchant.name, serviceScore: merchant.serviceScore };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      const adminScoreCaseMatch = pathname.match(/^\/api\/admin\/score-cases\/([^/]+)\/review$/);
      if (request.method === 'POST' && adminScoreCaseMatch) {
        const body = await readJson(request);
        const decision = requireString(body.decision, 'decision', { maxLength: 20 });
        if (!['APPROVE', 'REJECT'].includes(decision)) throw new ApiError(400, 'VALIDATION_ERROR', 'decision 需为 APPROVE 或 REJECT');
        const note = requireString(body.note, 'note', { maxLength: 500 });
        const adjustmentInput = Number(body.adjustment || 0);
        if (!Number.isInteger(adjustmentInput) || adjustmentInput < 0 || adjustmentInput > 20) {
          throw new ApiError(400, 'VALIDATION_ERROR', '核定补分需为 0-20 分的整数');
        }
        const result = store.update((data) => {
          const caseRecord = (data.serviceScoreCases || []).find((item) => item.id === adminScoreCaseMatch[1]);
          if (!caseRecord) throw new ApiError(404, 'SCORE_CASE_NOT_FOUND', '工单不存在');
          if (caseRecord.status !== 'SUBMITTED') throw new ApiError(409, 'SCORE_CASE_CLOSED', '工单已处理完成');
          const merchant = data.merchants.find((item) => item.id === caseRecord.merchantId);
          if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
          const now = new Date().toISOString();
          caseRecord.status = decision === 'APPROVE' ? 'COMPLETED' : 'REJECTED';
          caseRecord.adminNote = note.trim();
          caseRecord.updatedAt = now;
          (data.products || []).filter((item) => item.autoDelistCaseId === caseRecord.id).forEach((product) => {
            product.autoDelistReviewNote = caseRecord.type === 'RECTIFY'
              ? `整改工单 ${caseRecord.caseNo} ${decision === 'APPROVE' ? '验收通过' : '未通过'}：${note.trim()}`
              : `工单 ${caseRecord.caseNo} 已处理：${note.trim()}`;
            product.autoDelistReviewUpdatedAt = now;
            if (decision !== 'APPROVE') product.autoDelistStatus = 'REVIEW_REJECTED';
          });
          if (decision === 'APPROVE' && caseRecord.type === 'APPEAL' && adjustmentInput > 0) {
            applyServiceScoreCaseAdjustment(data, merchant, caseRecord, adjustmentInput, now);
          }
          if (decision === 'APPROVE' && caseRecord.type === 'RECTIFY') {
            const previous = merchant.serviceScore || computeMerchantScore(data, merchant, now);
            const scoreBefore = previous.score;
            merchant.serviceScore = { ...previous, manualAdjustment: Math.max(-20, Math.min(20, (previous.manualAdjustment || 0) + 5)) };
            merchant.serviceScore = computeMerchantScore(data, merchant, now);
            addMerchantScoreLog(data, merchant, {
              type: 'RECTIFY_APPROVED',
              caseNo: caseRecord.caseNo,
              scoreBefore,
              scoreAfter: merchant.serviceScore.score,
              note: `整改验收通过：${note}`
            }, now);
          }
          if (decision === 'APPROVE' && caseRecord.type === 'RECTIFY') {
            const restoredProducts = (data.products || []).filter((item) => item.merchantId === merchant.id
              && item.autoDelistRule === 'LOW_QUALITY' && item.active === false
              && (!caseRecord.productId || item.id === caseRecord.productId))
              .map((product) => restoreAutoDelistedProduct(data, product, merchant, caseRecord, note.trim(), now));
            caseRecord.restoredProductIds = restoredProducts;
          }
          caseRecord.timeline.unshift({
            status: caseRecord.status,
            note: note.trim(),
            createdAt: now
          });
          const outcome = caseRecord.status === 'COMPLETED'
            ? (caseRecord.type === 'APPEAL' ? `申诉核实通过${caseRecord.appliedAdjustment ? `，核定补分 +${caseRecord.appliedAdjustment}` : ''}` : '整改验收通过')
            : `${caseRecord.typeLabel}未通过：${note}`;
          notifyMerchantScore(data, merchant.id,
            caseRecord.type === 'APPEAL' ? 'SCORE_APPEAL_RESULT' : 'SCORE_RECTIFY_RESULT',
            '服务分工单已处理', outcome, now);
          addAudit(data, '处理服务分工单', `${merchant.name} ${caseRecord.caseNo}`);
          return caseRecord;
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/subscribe-templates') {
        const data = store.read();
        return sendJson(response, 200, {
          data: [
            ...Object.entries(scoreNotificationTemplates).map(([key, item]) => ({
              key,
              ...item,
              audience: 'MERCHANT',
              keywords: item.keywords.join('；'),
              configuredId: ({
                score_stage_warning: data.adminSettings?.scoreStageWarningTemplateId || '',
                score_rectify_apply: data.adminSettings?.scoreRectifyApplyTemplateId || '',
                score_rectify_result: data.adminSettings?.scoreRectifyResultTemplateId || '',
                score_appeal_result: data.adminSettings?.scoreAppealResultTemplateId || '',
                product_auto_delist: data.adminSettings?.productAutoDelistTemplateId || '',
                product_compliance_restored: data.adminSettings?.productComplianceRestoredTemplateId || '',
                stock_low_stock: data.adminSettings?.stockLowStockTemplateId || '',
                sla_warning: data.adminSettings?.slaWarningTemplateId || ''
              })[item.id] || ''
            })),
            ...Object.entries(orderNotificationTemplates).map(([key, item]) => ({
              key,
              ...item,
              audience: 'USER',
              keywords: item.keywords.join('；'),
              configuredId: ({
                lead_follow_up: data.adminSettings?.leadFollowUpTemplateId || '',
                favorite_price_notice: data.adminSettings?.favoritePriceNoticeTemplateId || '',
                order_status: data.adminSettings?.orderStatusTemplateId || '',
                order_service: data.adminSettings?.orderServiceTemplateId || '',
                restock_notice: data.adminSettings?.restockNoticeTemplateId || '',
                after_sale: data.adminSettings?.afterSaleTemplateId || ''
              })[item.id] || ''
            }))
          ],
          total: Object.keys(scoreNotificationTemplates).length + Object.keys(orderNotificationTemplates).length,
          requestId
        });
      }

      if (request.method === 'POST' && pathname === '/api/admin/subscribe-messages/dispatch') {
        const body = await readJson(request);
        const limitInput = Number(body.limit || 20);
        if (!Number.isInteger(limitInput) || limitInput < 1 || limitInput > 100) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'limit 需为 1-100 的整数');
        }
        const queued = (store.read().subscribeMessages || []).filter((item) => item.status === 'QUEUED');
        const batch = queued.slice(0, limitInput);
        if (!batch.length) return sendJson(response, 200, { data: { sent: 0, failed: 0, remaining: 0 }, requestId });
        const identityByUserId = new Map();
        const openIdData = store.read().userOpenIds || {};
        for (const [key, value] of Object.entries(openIdData)) identityByUserId.set(key, value);
        for (const [key, value] of userWeChatIdentities) identityByUserId.set(key, value);
        const settings = store.read().adminSettings || {};
        const templateIdByKey = {
          score_stage_warning: settings.scoreStageWarningTemplateId || '',
          score_rectify_apply: settings.scoreRectifyApplyTemplateId || '',
          score_rectify_result: settings.scoreRectifyResultTemplateId || '',
          score_appeal_result: settings.scoreAppealResultTemplateId || ''
          ,product_auto_delist: settings.productAutoDelistTemplateId || '',
          product_compliance_restored: settings.productComplianceRestoredTemplateId || ''
          ,stock_low_stock: settings.stockLowStockTemplateId || ''
          ,sla_warning: settings.slaWarningTemplateId || ''
          ,order_status: settings.orderStatusTemplateId || '',
          favorite_price_notice: settings.favoritePriceNoticeTemplateId || '',
          order_service: settings.orderServiceTemplateId || '',
          restock_notice: settings.restockNoticeTemplateId || '',
          after_sale: settings.afterSaleTemplateId || ''
          ,lead_follow_up: settings.leadFollowUpTemplateId || ''
        };
        let sent = 0;
        let failed = 0;
        for (const message of batch) {
          try {
            const wechatIdentity = identityByUserId.get(message.userId);
            if (!wechatIdentity) throw Object.assign(new Error('缺少微信身份'), { code: 'WECHAT_IDENTITY_MISSING' });
            const merchantTemplate = scoreNotificationTemplates[Object.keys(scoreNotificationTemplates)
              .find((key) => scoreNotificationTemplates[key].id === message.templateId) || ''];
            if (merchantTemplate
              && !(store.read().serviceMessageSubscribers || []).includes(message.userId)) {
              throw Object.assign(new Error('商家未开启服务分提醒'), { code: 'MERCHANT_SUBSCRIPTION_MISSING' });
            }
            const templateId = templateIdByKey[message.templateId];
            if (!templateId) throw Object.assign(new Error('订阅模板未配置'), { code: 'SUBSCRIBE_TEMPLATE_NOT_CONFIGURED' });
            const payload = {
              touser: wechatIdentity,
              template_id: templateId,
              page: message.page || (merchantTemplate ? 'pages/merchant/index' : 'pages/orders/orders'),
              data: {
                thing1: { value: (message.title || '').slice(0, 20) },
                thing2: { value: (message.content || '').slice(0, 20) }
              }
            };
            const result = await wechatSubscribeSend(payload);
            if (result && Number(result.errcode || 0) !== 0) {
              throw Object.assign(new Error(result.errmsg || '微信发送失败'), { code: `WECHAT_SEND_${result.errcode}` });
            }
            message.status = 'SENT';
            message.sentAt = new Date().toISOString();
            message.error = '';
            sent += 1;
          } catch (error) {
            message.status = 'FAILED';
            message.sentAt = '';
            message.error = String(error.code || 'SEND_FAILED') + ': ' + String(error.message || '发送失败').slice(0, 200);
            failed += 1;
          }
        }
        store.update((data) => {
          const queuedMessages = data.subscribeMessages || [];
          for (const message of batch) {
            const current = queuedMessages.find((item) => item.id === message.id);
            if (current) Object.assign(current, message);
          }
          return true;
        });
        addAudit(store.read(), '派发微信订阅消息', `成功 ${sent} · 失败 ${failed}`);
      const remaining = (store.read().subscribeMessages || []).filter((item) => item.status === 'QUEUED').length;
      return sendJson(response, 200, { data: { sent, failed, remaining }, requestId });
    }

      const subscribeRetryMatch = pathname.match(/^\/api\/admin\/subscribe-messages\/([^/]+)\/retry$/);
      if (request.method === 'POST' && subscribeRetryMatch) {
        const result = store.update((data) => {
          const message = (data.subscribeMessages || []).find((item) => item.id === subscribeRetryMatch[1]);
          if (!message) throw new ApiError(404, 'SUBSCRIBE_MESSAGE_NOT_FOUND', '订阅消息不存在');
          if (message.status !== 'FAILED') throw new ApiError(409, 'SUBSCRIBE_MESSAGE_NOT_FAILED', '仅发送失败的消息可以重试');
          message.status = 'QUEUED';
          message.error = '';
          message.sentAt = '';
          message.updatedAt = new Date().toISOString();
          addAudit(data, '重试微信订阅消息', message.templateId);
          return message;
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'POST' && adminProductMatch) {
        const body = await readJson(request);
        const updated = store.update((data) => {
          const product = data.products.find((item) => item.id === adminProductMatch[1]);
          if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
          if (body.stock !== undefined) {
            const stock = Number(body.stock); if (!Number.isInteger(stock) || stock < 0) throw new ApiError(400, 'VALIDATION_ERROR', 'stock must be a non-negative integer'); product.stock = stock;
          }
          if (body.name !== undefined) product.name = requireString(body.name, 'name', { maxLength: 80 });
          if (body.description !== undefined) product.description = requireString(body.description, 'description', { maxLength: 300 });
          if (body.priceInCents !== undefined) { const price = Number(body.priceInCents); if (!Number.isInteger(price) || price < 0) throw new ApiError(400, 'VALIDATION_ERROR', 'priceInCents must be non-negative'); product.priceInCents = price; }
          if (body.category !== undefined) product.category = requireString(body.category, 'category', { maxLength: 50 });
          const sale = normalizeProductSaleCampaign(body, product);
          if (sale) {
            if (sale.salePriceInCents >= product.priceInCents) throw new ApiError(400, 'VALIDATION_ERROR', '促销价必须低于商品原价');
            product.salePriceInCents = sale.salePriceInCents;
            product.saleStartsAt = sale.saleStartsAt;
            product.saleEndsAt = sale.saleEndsAt;
          }
          if (body.active !== undefined) product.active = Boolean(body.active);
          addAudit(data, '更新商品', product.name);
          notifyRestockSubscribers(data, product, '', new Date().toISOString());
          return product;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      const adminProductComplianceMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)\/compliance-restore$/);
      if (request.method === 'POST' && adminProductComplianceMatch) {
        const body = await readJson(request);
        const note = requireString(body.note, 'note', { maxLength: 300 });
        const result = store.update((data) => {
          const product = data.products.find((item) => item.id === adminProductComplianceMatch[1]);
          if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
          if (product.autoDelistRule !== 'LOW_QUALITY') {
            throw new ApiError(409, 'PRODUCT_NOT_AUTO_DELISTED', '仅低质规则自动下架的商品可以人工恢复');
          }
          const now = new Date().toISOString();
          const merchant = (data.merchants || []).find((item) => item.id === product.merchantId);
          restoreAutoDelistedProduct(data, product, merchant || { id: product.merchantId, name: '' }, null, note, now);
          notifyMerchantScore(data, product.merchantId, 'PRODUCT_COMPLIANCE_RESTORED', '商品已恢复上架',
            product.autoDelistReviewNote, now);
          return product;
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/recharge-promos') {
        const body = await readJson(request);
        const payInCents = Number(body.payInCents);
        const receiveInCents = Number(body.receiveInCents);
        if (!Number.isInteger(payInCents) || payInCents < 1000 || payInCents > 10000000 || !Number.isInteger(receiveInCents) || receiveInCents <= payInCents || receiveInCents > 10000000) {
          throw new ApiError(400, 'VALIDATION_ERROR', '充值金额和到账金额格式不正确');
        }
        const startsAt = body.startsAt ? new Date(body.startsAt) : null;
        const endsAt = body.endsAt ? new Date(body.endsAt) : null;
        if ((body.startsAt && Number.isNaN(startsAt.getTime()))
          || (body.endsAt && Number.isNaN(endsAt.getTime()))
          || (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime())) {
          throw new ApiError(400, 'VALIDATION_ERROR', '活动开始时间必须早于结束时间');
        }
        const promo = store.update((data) => {
          const records = data.rechargePromos = data.rechargePromos || [];
          const badge = typeof body.badge === 'string' && body.badge.trim() ? body.badge.trim().slice(0, 30) : '限时优惠';
          const active = body.active !== false;
          if (body.id) {
            const item = records.find((record) => record.id === body.id);
            if (!item) throw new ApiError(404, 'PROMO_NOT_FOUND', 'Promo not found');
            item.pay = Math.round(payInCents / 100);
            item.receive = Math.round(receiveInCents / 100);
            item.badge = badge;
            item.active = active;
            item.startsAt = startsAt ? startsAt.toISOString() : '';
            item.endsAt = endsAt ? endsAt.toISOString() : '';
            item.updatedAt = new Date().toISOString();
            addAudit(data, '更新话费活动', item.id);
            return item;
          }
          const item = { id: `promo_${randomUUID()}`, pay: Math.round(payInCents / 100), receive: Math.round(receiveInCents / 100), badge, active, startsAt: startsAt ? startsAt.toISOString() : '', endsAt: endsAt ? endsAt.toISOString() : '', createdAt: new Date().toISOString() };
          records.unshift(item);
          addAudit(data, '新增话费活动', item.id);
          return item;
        });
        return sendJson(response, 201, { data: promo, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/products') {
        const body = await readJson(request);
        const product = store.update((data) => {
          const priceInCents = Number(body.priceInCents); const stock = Number(body.stock);
          if (!Number.isInteger(priceInCents) || priceInCents < 0 || !Number.isInteger(stock) || stock < 0) throw new ApiError(400, 'VALIDATION_ERROR', '价格和库存格式不正确');
          const sale = normalizeProductSaleCampaign(body);
          if (sale && sale.salePriceInCents >= priceInCents) throw new ApiError(400, 'VALIDATION_ERROR', '促销价必须低于商品原价');
          const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
          if (imageUrl && !imageUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '商品图片必须来自平台上传目录');
          const item = { id: `prod_${randomUUID()}`, name: requireString(body.name, 'name', { maxLength: 80 }), category: requireString(body.category, 'category', { maxLength: 50 }), description: requireString(body.description, 'description', { maxLength: 300 }), priceInCents, stock, campusIds: ['campus_hzau'], imageUrl, active: body.active !== false, ...(sale || {}) };
          data.products.unshift(item);
          recordStockMovement(data, item, {
            movementType: 'INITIAL',
            quantity: item.stock,
            stockBefore: 0,
            stockAfter: item.stock,
            reservedBefore: 0,
            reservedAfter: 0,
            referenceId: item.id,
            operator: 'ADMIN',
            note: '管理员创建商品'
          });
          addAudit(data, '新增商品', item.name); return item;
        });
        return sendJson(response, 201, { data: product, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/settings') {
        const body = await readJson(request);
        const actor = requireAdmin(request, 'CONFIG_MANAGE');
        const settings = store.update((data) => {
          const current = data.adminSettings || {};
          const previous = { ...current };
          for (const field of ['brandName', 'schoolName', 'campusName', 'servicePhone', 'serviceWechat']) if (body[field] !== undefined) current[field] = requireString(body[field], field, { maxLength: 80 });
          if (body.externalPlateFeeInCents !== undefined) { const fee = Number(body.externalPlateFeeInCents); if (!Number.isInteger(fee) || fee < 0) throw new ApiError(400, 'VALIDATION_ERROR', '服务费格式不正确'); current.externalPlateFeeInCents = fee; }
          if (body.deliveryFeeInCents !== undefined) { const fee = Number(body.deliveryFeeInCents); if (!Number.isInteger(fee) || fee < 0 || fee > 10000000) throw new ApiError(400, 'VALIDATION_ERROR', '配送费格式不正确'); current.deliveryFeeInCents = fee; }
          if (body.commissionRatePercent !== undefined) {
            const rate = Number(body.commissionRatePercent);
            if (!Number.isInteger(rate) || rate < 0 || rate > 50) throw new ApiError(400, 'VALIDATION_ERROR', '平台佣金比例需为 0-50 的整数');
            current.commissionRatePercent = rate;
          }
          for (const field of ['deliveryResponseHours', 'plateResponseHours', 'afterSaleResponseHours', 'afterSaleResolutionHours', 'phoneCardActivationHours', 'rechargeCreditHours', 'broadbandVerifyHours', 'payoutReviewHours', 'leadResponseHours', 'financeTaskResponseHours']) {
            if (body[field] !== undefined) {
              const hours = Number(body[field]);
              if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 需为 1-168 小时`);
              current[field] = hours;
            }
          }
          if (body.patrolIntervalMinutes !== undefined) {
            const minutes = Number(body.patrolIntervalMinutes);
            if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new ApiError(400, 'VALIDATION_ERROR', '巡检间隔需为 1-1440 分钟');
            current.patrolIntervalMinutes = minutes;
          }
          // 两个阈值必须保持「限流线 > 暂停线」，否则分档会出现无法落入的区间。
          if (body.serviceScoreLimitedThreshold !== undefined || body.serviceScoreRestrictedThreshold !== undefined) {
            const limited = body.serviceScoreLimitedThreshold !== undefined
              ? Number(body.serviceScoreLimitedThreshold)
              : Number(current.serviceScoreLimitedThreshold ?? 80);
            const restricted = body.serviceScoreRestrictedThreshold !== undefined
              ? Number(body.serviceScoreRestrictedThreshold)
              : Number(current.serviceScoreRestrictedThreshold ?? 60);
            if (!Number.isInteger(limited) || limited < 50 || limited > 100) throw new ApiError(400, 'VALIDATION_ERROR', '限流阈值需为 50-100 分');
            if (!Number.isInteger(restricted) || restricted < 0 || restricted > 100) throw new ApiError(400, 'VALIDATION_ERROR', '暂停上新阈值需为 0-100 分');
            if (restricted >= limited) throw new ApiError(400, 'VALIDATION_ERROR', '暂停上新阈值必须低于限流阈值');
            current.serviceScoreLimitedThreshold = limited;
            current.serviceScoreRestrictedThreshold = restricted;
          }
          if (body.productComplianceLowReviewThreshold !== undefined) {
            const value = Number(body.productComplianceLowReviewThreshold);
            if (!Number.isInteger(value) || value < 1 || value > 20) throw new ApiError(400, 'VALIDATION_ERROR', '低分下架阈值需为 1-20 条');
            current.productComplianceLowReviewThreshold = value;
          }
          if (body.productComplianceReviewSampleThreshold !== undefined) {
            const value = Number(body.productComplianceReviewSampleThreshold);
            if (!Number.isInteger(value) || value < 2 || value > 20) throw new ApiError(400, 'VALIDATION_ERROR', '均分评价样本量需为 2-20 条');
            current.productComplianceReviewSampleThreshold = value;
          }
          if (body.productComplianceAverageRatingThreshold !== undefined) {
            const value = Number(body.productComplianceAverageRatingThreshold);
            if (!Number.isFinite(value) || value < 1 || value > 4.5) throw new ApiError(400, 'VALIDATION_ERROR', '均分下架阈值需为 1-4.5 分');
            current.productComplianceAverageRatingThreshold = Math.round(value * 10) / 10;
          }
          for (const field of ['scoreStageWarningTemplateId', 'scoreRectifyApplyTemplateId', 'scoreRectifyResultTemplateId', 'scoreAppealResultTemplateId', 'productAutoDelistTemplateId', 'productComplianceRestoredTemplateId', 'stockLowStockTemplateId', 'slaWarningTemplateId', 'favoritePriceNoticeTemplateId', 'orderStatusTemplateId', 'orderServiceTemplateId', 'restockNoticeTemplateId', 'afterSaleTemplateId', 'leadFollowUpTemplateId']) {
            if (body[field] !== undefined) current[field] = String(body[field]).trim().slice(0, 120);
          }
          if (body.paymentTimeoutMinutes !== undefined) {
            const minutes = Number(body.paymentTimeoutMinutes);
            if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) throw new ApiError(400, 'VALIDATION_ERROR', '支付超时需为 5-1440 分钟');
            current.paymentTimeoutMinutes = minutes;
          }
          if (body.settlementPeriodDays !== undefined) {
            const days = Number(body.settlementPeriodDays);
            if (!Number.isInteger(days) || days < 0 || days > 60) throw new ApiError(400, 'VALIDATION_ERROR', '结算账期需为 0-60 天');
            current.settlementPeriodDays = days;
          }
          if (body.payoutMinimumInCents !== undefined) {
            const minimum = Number(body.payoutMinimumInCents);
            if (!Number.isInteger(minimum) || minimum < 0 || minimum > 1000000) throw new ApiError(400, 'VALIDATION_ERROR', '起提金额需为 0-1000000 分');
            current.payoutMinimumInCents = minimum;
          }
          if (body.lowStockThreshold !== undefined) {
            const threshold = Number(body.lowStockThreshold);
            if (!Number.isInteger(threshold) || threshold < 0 || threshold > 999) throw new ApiError(400, 'VALIDATION_ERROR', '低库存阈值需为 0-999 的整数');
            current.lowStockThreshold = threshold;
          }
          if (body.deliveryTimeSlots !== undefined) {
            if (!Array.isArray(body.deliveryTimeSlots) || body.deliveryTimeSlots.length < 1 || body.deliveryTimeSlots.length > 8) throw new ApiError(400, 'VALIDATION_ERROR', '配送时段需为 1-8 个');
            const slots = body.deliveryTimeSlots.map(normalizeTimeSlot).filter(Boolean);
            if (slots.length !== body.deliveryTimeSlots.length) throw new ApiError(400, 'VALIDATION_ERROR', '配送时段不能为空');
            current.deliveryTimeSlots = slots;
          }
          if (body.platformNotice !== undefined) current.platformNotice = requireString(body.platformNotice, 'platformNotice', { maxLength: 200 });
          data.adminSettings = current;
          const changes = Object.keys(current)
            .filter((field) => JSON.stringify(current[field]) !== JSON.stringify(previous[field]))
            .map((field) => ({ field, before: previous[field], after: current[field] }));
          if (changes.length > 0) {
            data.settingChangeLogs = Array.isArray(data.settingChangeLogs) ? data.settingChangeLogs : [];
            data.settingChangeLogs.unshift({
              id: `setting_log_${randomUUID()}`,
              version: data.settingChangeLogs.length + 1,
              operator: {
                id: actor.id,
                username: actor.username,
                displayName: actor.displayName,
                role: actor.role
              },
              changes,
              snapshot: { ...current },
              createdAt: new Date().toISOString()
            });
            data.settingChangeLogs = data.settingChangeLogs.slice(0, 50);
            addAudit(data, '更新系统设置', changes.map((item) => item.field).join(', '));
          }
          return current;
        });
        return sendJson(response, 200, { data: settings, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/campus-card-applications') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const serviceType = requireString(body.serviceType, 'serviceType');
        if (!allowedCardServices.has(serviceType)) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported campus card service type');
        }
        if (body.consent !== true) {
          throw new ApiError(400, 'CONSENT_REQUIRED', 'Privacy and service consent is required');
        }
        const now = new Date().toISOString();
        const application = {
          id: `cca_${randomUUID()}`,
          userId,
          schoolId: requireString(body.schoolId, 'schoolId', { maxLength: 64 }),
          campusId: requireString(body.campusId, 'campusId', { maxLength: 64 }),
          serviceType,
          applicantName: requireString(body.applicantName, 'applicantName', { maxLength: 50 }),
          studentNo: requireString(body.studentNo, 'studentNo', { maxLength: 40 }),
          status: 'SUBMITTED',
          createdAt: now,
          updatedAt: now
        };
        store.update((data) => data.campusCardApplications.push(application));
        return sendJson(response, 201, { data: publicApplication(application), requestId });
      }

      if (request.method === 'GET' && pathname === '/api/campus-card-applications') {
        const { userId } = requireUser(request);
        const items = store.read().campusCardApplications
          .filter((item) => item.userId === userId)
          .map(publicApplication);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/orders') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        if (!Array.isArray(body.items) || body.items.length === 0) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'items must be a non-empty array');
        }
        const idempotencyKey = (request.headers['idempotency-key'] || '').trim();
        if (idempotencyKey.length > 128) throw new ApiError(400, 'VALIDATION_ERROR', 'Idempotency-Key is too long');
        if (body.fulfillment !== undefined) {
          if (!body.fulfillment || typeof body.fulfillment !== 'object') throw new ApiError(400, 'VALIDATION_ERROR', 'fulfillment 格式不正确');
          if (body.fulfillment.type === 'DELIVERY') {
            const contactName = requireString(body.fulfillment.contactName, 'fulfillment.contactName', { maxLength: 50 });
            const contactPhone = requireString(body.fulfillment.contactPhone, 'fulfillment.contactPhone', { maxLength: 30 });
            const address = requireString(body.fulfillment.address, 'fulfillment.address', { maxLength: 120 });
            if (!/^1\d{10}$/.test(contactPhone)) throw new ApiError(400, 'VALIDATION_ERROR', '请输入正确的联系手机号');
            if (!contactName || !address) throw new ApiError(400, 'VALIDATION_ERROR', '请填写联系人和校内配送地址');
            if (body.fulfillment.timeSlot !== undefined) requireString(body.fulfillment.timeSlot, 'fulfillment.timeSlot', { maxLength: 40 });
          }
        }

        const result = store.update((data) => {
          expirePendingOrders(data);
          const compoundKey = idempotencyKey ? `${userId}:${idempotencyKey}` : '';
          if (compoundKey && data.idempotencyKeys[compoundKey]) {
            const existing = data.orders.find((order) => order.id === data.idempotencyKeys[compoundKey]);
            return { order: existing, reused: true };
          }
          const mergedQuantities = new Map();
          for (const requestedItem of body.items) {
            const productId = requireString(requestedItem.productId, 'items[].productId');
            const quantity = Number(requestedItem.quantity);
            if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) {
              throw new ApiError(400, 'VALIDATION_ERROR', 'Each quantity must be an integer from 1 to 99');
            }
            mergedQuantities.set(productId, (mergedQuantities.get(productId) || 0) + quantity);
          }
          const orderItems = [];
          let totalInCents = 0;
          const settings = data.adminSettings || {};
          const deliveryFeeInCents = Number(settings.deliveryFeeInCents || 0);
          for (const [productId, quantity] of mergedQuantities) {
            const product = data.products.find((item) => item.id === productId && item.active);
            if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
            if (availableStock(product) < quantity) {
              throw new ApiError(409, 'INSUFFICIENT_STOCK', `${product.name} 可售库存不足，当前仅剩 ${availableStock(product)} 件`);
            }
            const { effectivePriceInCents } = withProductSale(product);
            const subtotalInCents = effectivePriceInCents * quantity;
            totalInCents += subtotalInCents;
            orderItems.push({ productId, merchantId: product.merchantId || '', name: product.name, priceInCents: effectivePriceInCents, originalPriceInCents: product.priceInCents, quantity, subtotalInCents });
          }
          const isDelivery = body.fulfillment?.type === 'DELIVERY';
          if (isDelivery) validateDeliverySchedule(body.fulfillment, settings);
          if (isDelivery) totalInCents += deliveryFeeInCents;
          const now = new Date().toISOString();
          const paymentTimeoutMinutes = Number(settings.paymentTimeoutMinutes || 30);
          const order = {
            id: `ord_${randomUUID()}`,
            orderNo: `CG${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`,
            userId,
            items: orderItems,
            totalInCents,
            currency: 'CNY',
            status: 'PENDING_PAYMENT',
            paymentStatus: 'UNPAID',
            paymentExpiresAt: new Date(new Date(now).getTime() + paymentTimeoutMinutes * 60 * 1000).toISOString(),
            stockReservation: 'NONE',
            fulfillment: body.fulfillment || { type: 'PICKUP' },
            feeSummary: {
              itemsInCents: totalInCents - (isDelivery ? deliveryFeeInCents : 0),
              deliveryFeeInCents: isDelivery ? deliveryFeeInCents : 0,
              totalInCents
            },
            createdAt: now,
            updatedAt: now,
            collaboration: createCollaboration({ createdAt: now, status:'PAID' }, orderItems[0]?.merchantId || '')
          };
          data.orders.push(order);
          reserveOrderStock(data, order);
          if (compoundKey) data.idempotencyKeys[compoundKey] = order.id;
          if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
          const paymentOrder = {
            id: `pay_${randomUUID()}`,
            paymentNo: `PAY${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`,
            orderId: order.id,
            orderNo: order.orderNo,
            userId,
            amountInCents: totalInCents,
            currency: 'CNY',
            status: 'PENDING',
            idempotencyKey: compoundKey || idempotencyKey || '',
            channel: paymentProvider.channel,
            provider: paymentProvider.name,
            providerTradeNo: '',
            providerPayload: null,
            createdAt: now,
            updatedAt: now,
            paidAt: '',
            refundedAt: ''
          };
          data.paymentOrders.unshift(paymentOrder);
          order.paymentOrderId = paymentOrder.id;
          addAudit(data, '\u521b\u5efa\u5f85\u652f\u4ed8\u5355', order.orderNo);
          return { order, paymentOrder, reused: false };
        });
        const paymentOrder = result.reused ? result.paymentOrder : await attachProviderIntent(result.paymentOrder);
        return sendJson(response, result.reused ? 200 : 201, { data: result.order, paymentOrder, idempotencyReused: result.reused, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/orders') {
        const { userId } = requireUser(request);
        const items = store.read().orders
          .filter((order) => order.userId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (request.method === 'GET' && orderMatch) {
        const { userId } = requireUser(request);
        const order = store.read().orders.find((item) => item.id === orderMatch[1] && item.userId === userId);
        if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
        return sendJson(response, 200, { data: order, requestId });
      }

      const userPaymentMatch = pathname.match(/^\/api\/my\/payment-orders\/by-order\/([^/]+)\/confirm$/);
      if (request.method === 'POST' && userPaymentMatch) {
        const { userId } = requireUser(request);
        const data = store.read();
        const order = (data.orders || []).find((item) => item.id === userPaymentMatch[1] && item.userId === userId);
        const paymentOrder = order ? (data.paymentOrders || []).find((item) => item.id === order.paymentOrderId) : null;
        if (!order || !paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
        if (paymentOrder.status !== 'PENDING') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '仅待支付单可支付');
        const providerPayment = await confirmProviderPayment(paymentOrder);
        const result = settlePaymentOrder(paymentOrder.id, providerPayment, 'USER_CONFIRM');
        return sendJson(response, 200, { data: result, requestId });
      }

      const providerCallbackMatch = pathname.match(/^\/api\/payment-callbacks\/([^/]+)$/);
      if (request.method === 'POST' && providerCallbackMatch) {
        const providerName = decodeURIComponent(providerCallbackMatch[1]);
        if (providerName !== paymentProvider.name) {
          throw new ApiError(404, 'PAYMENT_PROVIDER_NOT_FOUND', 'Payment provider not found');
        }
        const body = await readJson(request);
        let callbackResult;
        try {
          callbackResult = await paymentProvider.verifyCallback(request, body);
        } catch (error) {
          throw new ApiError(401, 'PAYMENT_CALLBACK_INVALID', `支付回调校验失败：${error.message}`);
        }
        const callbackType = callbackResult?.type || 'PAYMENT';
        if (!callbackResult?.providerTradeNo) {
          throw new ApiError(400, 'PAYMENT_CALLBACK_INVALID', '支付回调缺少渠道交易号');
        }
        if (callbackType === 'REFUND') {
          if (callbackResult.status !== 'REFUNDED') {
            throw new ApiError(400, 'PAYMENT_CALLBACK_UNSUPPORTED', '当前仅支持退款成功回调');
          }
          if (!callbackResult.refundNo) {
            throw new ApiError(400, 'PAYMENT_CALLBACK_INVALID', '退款回调缺少退款单号');
          }
          const paymentOrder = (store.read().paymentOrders || [])
            .find((item) => item.refund?.refundNo === callbackResult.refundNo);
          if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          const result = completePaymentRefund(paymentOrder.id, callbackResult, 'REFUND_CALLBACK');
          return sendJson(response, 200, { data: result, requestId });
        }

        if (callbackResult.status !== 'PAID') {
          throw new ApiError(400, 'PAYMENT_CALLBACK_UNSUPPORTED', '当前仅支持支付成功回调');
        }
        const paymentOrder = (store.read().paymentOrders || []).find((item) => item.providerTradeNo === callbackResult.providerTradeNo);
        if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
        if (paymentOrder.status === 'CANCELLED') {
          const result = await handleLatePaymentCallback(paymentOrder, callbackResult);
          return sendJson(response, 200, { data: result, requestId });
        }
        const result = settlePaymentOrder(paymentOrder.id, callbackResult, 'PROVIDER_CALLBACK');
        return sendJson(response, 200, { data: result, requestId });
      }

      const reloadPaymentMatch = pathname.match(/^\/api\/payment-orders\/([^/]+)$/);
      if (request.method === 'GET' && reloadPaymentMatch) {
        const { userId } = requireUser(request);
        const paymentOrder = (store.read().paymentOrders || [])
          .find((item) => item.id === reloadPaymentMatch[1] && item.userId === userId);
        if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
        return sendJson(response, 200, { data: paymentOrder, requestId });
      }

      const paymentMatch = pathname.match(/^\/api\/payment-orders\/([^/]+)(?:\/(confirm|cancel|refund))?$/);
      if (request.method === 'POST' && paymentMatch) {
        const { userId } = requireUser(request);
        const action = paymentMatch[2];
        if (!action) throw new ApiError(404, 'NOT_FOUND', 'Payment action is required');
        await sweepExpiredOrders();
        if (action === 'confirm') {
          const currentPayment = store.read().paymentOrders.find((item) => item.id === paymentMatch[1] && item.userId === userId);
          if (!currentPayment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          if (currentPayment.status !== 'PENDING') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '仅待支付单可操作');
          const providerPayment = await confirmProviderPayment(currentPayment);
          const result = settlePaymentOrder(currentPayment.id, providerPayment, 'USER_CONFIRM');
          return sendJson(response, 200, { data: result, requestId });
        }
        const updated = store.update((data) => {
          if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
          const paymentOrder = data.paymentOrders.find((item) => item.id === paymentMatch[1] && item.userId === userId);
          if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          const order = data.orders.find((item) => item.id === paymentOrder.orderId && item.userId === userId);
          const rechargeOrder = data.rechargeOrders.find((item) => item.id === paymentOrder.businessId && item.userId === userId);
          const phoneCardOrder = data.phoneCardOrders.find((item) => item.id === paymentOrder.businessId && item.userId === userId);
          const plateApplication = (data.plateApplications || []).find((item) => item.id === paymentOrder.businessId && item.userId === userId && item.paymentOrderId === paymentOrder.id);
          if (!order && !rechargeOrder && !phoneCardOrder && !plateApplication) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          const now = new Date().toISOString();
          if (action === 'cancel') {
            if (paymentOrder.status !== 'PENDING') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '\u4ec5\u5f85\u652f\u4ed8\u5355\u53ef\u64cd\u4f5c');
            paymentOrder.status = 'CANCELLED';
            paymentOrder.providerCloseStatus = 'PENDING';
            paymentOrder.providerCloseRequestedAt = now;
            paymentOrder.providerCloseError = '';
            paymentOrder.updatedAt = now;
            if (rechargeOrder) {
              rechargeOrder.status = 'CANCELLED';
              rechargeOrder.paymentStatus = 'CANCELLED';
              rechargeOrder.updatedAt = now;
              addAudit(data, '\u8bdd\u8d39\u6743\u76ca\u5f85\u652f\u4ed8\u5df2\u53d6\u6d88', rechargeOrder.id);
              addNotification(data, userId, 'RECHARGE', '\u8bdd\u8d39\u6743\u76ca\u5df2\u53d6\u6d88', '\u60a8\u7684\u5f85\u652f\u4ed8\u8bdd\u8d39\u6743\u76ca\u8ba2\u5355\u5df2\u53d6\u6d88\u3002', { focusId: rechargeOrder.id });
              return { rechargeOrder, paymentOrder };
            }
            if (phoneCardOrder) {
              phoneCardOrder.status = 'CANCELLED';
              phoneCardOrder.paymentStatus = 'CANCELLED';
              phoneCardOrder.updatedAt = now;
              addAudit(data, '电话卡待支付已取消', phoneCardOrder.id);
            addNotification(data, userId, 'PHONE_PLAN', '电话卡订单已取消', '您的待支付电话卡订单已取消，如需办理可重新下单。', { focusId: phoneCardOrder.id });
            return { phoneCardOrder, paymentOrder };
          }
          if (plateApplication) {
            plateApplication.status = 'CANCELLED';
            plateApplication.paymentStatus = 'CANCELLED';
            plateApplication.updatedAt = now;
            addAudit(data, '自带车上牌待支付已取消', plateApplication.id);
            addNotification(data, userId, 'PLATE', '牌照服务申请已取消', '您的待支付上牌辅助申请已取消，如需办理可重新提交。', { focusId: plateApplication.id });
            return { plateApplication, paymentOrder };
          }
            order.status = 'CANCELLED';
            order.paymentStatus = 'CANCELLED';
            order.updatedAt = now;
            releaseOrderStock(data, order);
            addAudit(data, '\u7528\u6237\u53d6\u6d88\u5f85\u652f\u4ed8', order.orderNo);
            addNotification(data, userId, 'ORDER', '\u8ba2\u5355\u5df2\u53d6\u6d88', `\u8ba2\u5355 ${order.orderNo} \u5df2\u53d6\u6d88\uff0c\u82e5\u9700\u8981\u53ef\u91cd\u65b0\u4e0b\u5355\u3002`, { focusId: order.id });
            return { order, paymentOrder };
          }
          throw new ApiError(403, 'FORBIDDEN', '\u4ec5\u7ba1\u7406\u7aef\u53ef\u9000\u6b3e');
        });
        await processProviderCloseQueue();
        const closedPaymentOrder = store.read().paymentOrders
          .find((item) => item.id === paymentMatch[1] && item.userId === userId);
        return sendJson(response, 200, { data: { order: updated.order, rechargeOrder: updated.rechargeOrder, phoneCardOrder: updated.phoneCardOrder, plateApplication: updated.plateApplication, paymentOrder: closedPaymentOrder }, requestId });
      }

      if (request.method === 'PATCH' && orderMatch) {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const updated = store.update((data) => {
          const order = data.orders.find((item) => item.id === orderMatch[1] && item.userId === userId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (['COMPLETED', 'CANCELLED', 'AFTER_SALE'].includes(order.status)) throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', 'Current order cannot be edited');
          if (body.fulfillment && typeof body.fulfillment === 'object') {
            const previousSchedule = order.fulfillment?.type === 'DELIVERY' ? `${order.fulfillment.date || '尽快'} ${order.fulfillment.timeSlot || ''}`.trim() : '';
            if (order.fulfillment?.type === 'DELIVERY') {
              if (body.fulfillment.type && body.fulfillment.type !== 'DELIVERY') throw new ApiError(400, 'VALIDATION_ERROR', '当前订单不支持切换为自提');
              const mergedFulfillment = { ...order.fulfillment, ...body.fulfillment, type: 'DELIVERY' };
              const contactName = requireString(mergedFulfillment.contactName, 'fulfillment.contactName', { maxLength: 50 });
              const contactPhone = requireString(mergedFulfillment.contactPhone, 'fulfillment.contactPhone', { maxLength: 30 });
              const address = requireString(mergedFulfillment.address, 'fulfillment.address', { maxLength: 120 });
              if (!/^1\d{10}$/.test(contactPhone)) throw new ApiError(400, 'VALIDATION_ERROR', '请输入正确的联系手机号');
              if (!contactName || !address) throw new ApiError(400, 'VALIDATION_ERROR', '请填写联系人和校内配送地址');
              validateDeliverySchedule(mergedFulfillment, data.adminSettings);
              order.fulfillment = mergedFulfillment;
              const nextSchedule = `${order.fulfillment.date || '尽快'} ${order.fulfillment.timeSlot || ''}`.trim();
              if (previousSchedule !== nextSchedule) {
                appendCollaborationEvent(order, 'USER', 'RESCHEDULE', `用户已改约：${previousSchedule || '未安排'} → ${nextSchedule}`);
                addNotification(data, userId, 'ORDER', '配送时间已更新', `订单 ${order.orderNo} 的新配送安排：${nextSchedule}。`, { focusId: order.id });
              }
            } else if (body.fulfillment.type === 'DELIVERY') {
              throw new ApiError(400, 'VALIDATION_ERROR', '当前订单不支持切换为校内配送');
            }
          }
          order.updatedAt = new Date().toISOString();
          return order;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      const orderCancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
      if (request.method === 'POST' && orderCancelMatch) {
        const { userId } = requireUser(request);
        const updated = store.update((data) => {
          const order = data.orders.find((item) => item.id === orderCancelMatch[1] && item.userId === userId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (order.status !== 'PENDING_PAYMENT') throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', '\u4ec5\u5f85\u652f\u4ed8\u8ba2\u5355\u53ef\u53d6\u6d88');
          const now = new Date().toISOString();
          order.status = 'CANCELLED';
          order.paymentStatus = 'CANCELLED';
          order.updatedAt = now;
          releaseOrderStock(data, order);
          const paymentOrder = (data.paymentOrders || []).find((item) => item.id === order.paymentOrderId);
          if (paymentOrder && paymentOrder.status === 'PENDING') {
            paymentOrder.status = 'CANCELLED';
            paymentOrder.providerCloseStatus = 'PENDING';
            paymentOrder.providerCloseRequestedAt = now;
            paymentOrder.providerCloseError = '';
            paymentOrder.updatedAt = now;
          }
          addAudit(data, '\u7528\u6237\u53d6\u6d88\u8ba2\u5355', order.orderNo);
          addNotification(data, userId, 'ORDER', '\u8ba2\u5355\u5df2\u53d6\u6d88', `\u8ba2\u5355 ${order.orderNo} \u5df2\u53d6\u6d88\u3002`, { focusId: order.id });
          return order;
        });
        await processProviderCloseQueue();
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/after-sales') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const orderId = requireString(body.orderId, 'orderId', { maxLength: 100 });
        const type = requireString(body.type, 'type');
        if (!allowedAfterSaleTypes.has(type)) {
          throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported after-sale type');
        }
        const reason = requireString(body.reason, 'reason', { maxLength: 500 });
        const images = Array.isArray(body.images) ? body.images.slice(0, 3) : [];
        const normalizedImages = images.map((image, index) => {
          const url = requireString(image, `images.${index}`, { maxLength: 200 });
          if (!url.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '售后图片必须来自平台上传目录');
          return url;
        });
        const afterSale = store.update((data) => {
          const order = data.orders.find((item) => item.id === orderId && item.userId === userId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (!['PAID', 'FULFILLING', 'COMPLETED'].includes(order.status)) {
            throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', 'Current order status does not support after-sale requests');
          }
          const duplicate = data.afterSales.find((item) => item.orderId === orderId && item.status !== 'CLOSED');
          if (duplicate) throw new ApiError(409, 'ACTIVE_AFTER_SALE_EXISTS', 'An active after-sale request already exists');
          const now = new Date().toISOString();
          const settings = publicSettings(data.adminSettings);
          const record = {
            id: `as_${randomUUID()}`,
            userId,
            orderId,
            type,
            typeLabel: { REFUND: '申请退款', RETURN: '退货', REPAIR: '维修' }[type] || type,
            reason,
            images: normalizedImages,
            status: 'SUBMITTED',
            responseDueAt: new Date(new Date(now).getTime() + settings.afterSaleResponseHours * 60 * 60 * 1000).toISOString(),
            resolutionDueAt: new Date(new Date(now).getTime() + settings.afterSaleResolutionHours * 60 * 60 * 1000).toISOString(),
            createdAt: now,
            updatedAt: now
          };
          data.afterSales.push(record);
          order.status = 'AFTER_SALE';
          order.updatedAt = now;
          freezeOrderSettlements(data, order, now, `${record.typeLabel}：${reason}`);
          notifyOrderMerchant(data, order, 'AFTER_SALE', '收到新的售后申请', `订单 ${order.orderNo}：${record.typeLabel}，${reason}`);
          sendOrderNotification(data, userId, 'AFTER_SALE', '售后已受理', `${order.orderNo}：已受理，预计 ${settings.afterSaleResponseHours} 小时内响应。`,
            new Date().toISOString(), { orderId: order.id, focusId: order.id });
          addAudit(data, '用户提交售后申请', order.orderNo);
          return record;
        });
        return sendJson(response, 201, { data: afterSale, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/after-sales') {
        const { userId } = requireUser(request);
        const items = store.read().afterSales.filter((item) => item.userId === userId);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      const afterSaleMaterialMatch = pathname.match(/^\/api\/after-sales\/([^/]+)\/materials$/);
      if (request.method === 'POST' && afterSaleMaterialMatch) {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        if (!Array.isArray(body.images) || !body.images.length || body.images.length > 3) throw new ApiError(400, 'VALIDATION_ERROR', '请上传 1 到 3 张问题图片');
        const images = body.images.map((image, index) => {
          const url = requireString(image, `images.${index}`, { maxLength: 200 });
          if (!url.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '售后图片必须来自平台上传目录');
          return url;
        });
        const afterSale = store.update((data) => {
          const item = (data.afterSales || []).find((record) => record.id === afterSaleMaterialMatch[1] && record.userId === userId);
          if (!item) throw new ApiError(404, 'AFTER_SALE_NOT_FOUND', 'After-sale record not found');
          if (item.status === 'CLOSED') throw new ApiError(409, 'AFTER_SALE_STATUS_NOT_ALLOWED', '售后已关闭，不能补充图片');
          const existing = Array.isArray(item.images) ? item.images : [];
          if (existing.length + images.length > 9) throw new ApiError(409, 'AFTER_SALE_IMAGE_LIMIT', '售后图片最多 9 张');
          item.images = [...existing, ...images];
          item.updatedAt = new Date().toISOString();
          addAudit(data, '用户补充售后图片', item.id);
          return item;
        });
        return sendJson(response, 200, { data: afterSale, requestId });
      }

      throw new ApiError(404, 'ROUTE_NOT_FOUND', 'Route not found');
    } catch (error) {
      const statusCode = error instanceof ApiError ? error.statusCode : 500;
      const code = error instanceof ApiError ? error.code : 'INTERNAL_ERROR';
      if (!(error instanceof ApiError)) console.error(`[${requestId}]`, error);
      return sendJson(response, statusCode, {
        error: { code, message: statusCode === 500 ? 'Internal server error' : error.message, details: error.details },
        requestId
      });
    }
  };
  // 定时巡检：由 server.js 启动，让超时预警不依赖有人访问接口。
  handler.startOperationsPatrol = function startOperationsPatrol({ onRun } = {}) {
    const settings = store.read().adminSettings || {};
    const configured = Number(settings.patrolIntervalMinutes);
    const minutes = Number.isInteger(configured) && configured >= 1 && configured <= 1440 ? configured : 10;
    const tick = async () => {
      try {
        const result = await patrolOnce();
        if (typeof onRun === 'function') onRun(result);
      } catch (error) {
        console.error('[patrol] run failed:', error.message);
      }
    };
    tick();
    const timer = setInterval(tick, minutes * 60 * 1000);
    timer.unref?.();
    return { intervalMinutes: minutes, stop: () => clearInterval(timer) };
  };
  handler.runOperationsPatrolOnce = patrolOnce;
  return handler;
}

module.exports = { createApp, ApiError };
