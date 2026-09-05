const { randomUUID, createHash } = require('node:crypto');
const https = require('node:https');
const { URL } = require('node:url');
const fs = require('node:fs');
const path = require('node:path');

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
    paymentTimeoutMinutes: settings.paymentTimeoutMinutes || 30,
    settlementPeriodDays: Number.isInteger(settings.settlementPeriodDays) ? settings.settlementPeriodDays : 7,
    deliveryTimeSlots: Array.isArray(settings.deliveryTimeSlots) && settings.deliveryTimeSlots.length ? settings.deliveryTimeSlots : ['尽快配送'],
    platformNotice: settings.platformNotice || '服务范围和办理结果以学校及合作方最终确认为准。'
  };
}

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

function reserveOrderStock(data, order) {
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) product.reservedStock = Number(product.reservedStock || 0) + Number(orderItem.quantity || 0);
  }
  order.stockReservation = 'HELD';
}

function releaseOrderStock(data, order) {
  if (order.stockReservation !== 'HELD') return false;
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) product.reservedStock = Math.max(0, Number(product.reservedStock || 0) - Number(orderItem.quantity || 0));
  }
  order.stockReservation = 'RELEASED';
  return true;
}

function consumeOrderStock(data, order) {
  if (order.stockReservation === 'CONSUMED') return false;
  const held = order.stockReservation === 'HELD';
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (!product) continue;
    if (held) product.reservedStock = Math.max(0, Number(product.reservedStock || 0) - Number(orderItem.quantity || 0));
    product.stock = Math.max(0, Number(product.stock || 0) - Number(orderItem.quantity || 0));
  }
  order.stockReservation = 'CONSUMED';
  return true;
}

// 退款/售后退货时把已扣减的库存还回可售池。
function restoreOrderStock(data, order) {
  if (order.stockReservation === 'HELD') return releaseOrderStock(data, order);
  if (order.stockReservation === 'RESTORED') return false;
  for (const orderItem of order.items || []) {
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) product.stock = Number(product.stock || 0) + Number(orderItem.quantity || 0);
  }
  order.stockReservation = 'RESTORED';
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
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,idempotency-key,authorization',
    'cache-control': 'no-store'
  });
  response.end(JSON.stringify(body));
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
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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
  if (!matched.length) return { ...product, ratingSummary: { average: 0, count: 0, purchaseVerifiedCount: 0 } };
  const average = matched.reduce((sum, review) => sum + (Number(review.rating) || 0), 0) / matched.length;
  return {
    ...product,
    ratingSummary: {
      average: Math.round(average * 10) / 10,
      count: matched.length,
      purchaseVerifiedCount: matched.length
    }
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

function createApp({ store, wechatAuth = exchangeWeChatCode }) {
  const adminSessions = new Map();
  const merchantSessions = new Map();
  const userSessions = new Map();
  const userSessionTtlMs = 7 * 24 * 60 * 60 * 1000;

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
  function addAudit(data, action, target) {
    if (!Array.isArray(data.auditLogs)) data.auditLogs = [];
    data.auditLogs.unshift({ id: `log_${randomUUID()}`, operator: '运营管理员', action, target, createdAt: new Date().toISOString() });
    data.auditLogs = data.auditLogs.slice(0, 200);
  }

  function addNotification(data, userId, type, title, content) {
    if (!userId) return null;
    if (!Array.isArray(data.notifications)) data.notifications = [];
    const notification = {
      id: `ntf_${randomUUID()}`,
      userId,
      type,
      title: String(title).slice(0, 80),
      content: String(content).slice(0, 300),
      read: false,
      createdAt: new Date().toISOString()
    };
    data.notifications.unshift(notification);
    data.notifications = data.notifications.slice(0, 500);
    return notification;
  }

  function notifyMerchant(data, merchantId, type, title, content) {
    const merchant = (data.merchants || []).find((item) => item.id === merchantId);
    return addNotification(data, merchant?.userId, type, title, content);
  }

  function notifyOrderMerchant(data, order, type, title, content) {
    const product = (data.products || []).find((item) => item.id === order.items?.[0]?.productId);
    return notifyMerchant(data, order.collaboration?.merchantId || order.items?.[0]?.merchantId || product?.merchantId || '', type, title, content);
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
      merchantId: payoutRequest.merchantId, merchantName: payoutRequest.merchantName, settlementReference: reference
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
    addNotification(data, order.userId, 'ORDER', '\u8ba2\u5355\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${order.orderNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
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
        paymentOrder.updatedAt = now;
      }
      addAudit(data, '待支付订单超时自动关闭', order.orderNo);
      addNotification(data, order.userId, 'ORDER', '订单已超时关闭', `订单 ${order.orderNo} 超过 ${timeoutMinutes} 分钟未支付，已自动关闭并释放库存。`);
      expired.push(order.orderNo);
    }
    return expired;
  }

  function sweepExpiredOrders() {
    const snapshot = store.read();
    const now = new Date().toISOString();
    const timeoutMinutes = Number(snapshot.adminSettings?.paymentTimeoutMinutes || 30);
    const hasExpired = (snapshot.orders || []).some((order) => {
      if (order.status !== 'PENDING_PAYMENT') return false;
      const dueAt = order.paymentExpiresAt || new Date(new Date(order.createdAt).getTime() + timeoutMinutes * 60 * 1000).toISOString();
      return dueAt <= now;
    });
    if (!hasExpired) return [];
    return store.update((data) => expirePendingOrders(data, new Date().toISOString()));
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
        userId: record.userId || '',
        dueAt: record.slaDueAt || addHours(record.createdAt, slaHours(data, 'leadResponseHours', 24)),
        detail: `${record.businessType || '咨询'} · ${record.name || ''} ${record.phone || ''}`.trim()
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

    data.slaAlerts = data.slaAlerts.slice(0, 1000);
    const stillOpen = data.slaAlerts.filter((alert) => alert.status !== 'RESOLVED');
    data.patrolState = {
      lastRunAt: now,
      runCount: Number(data.patrolState?.runCount || 0) + 1,
      lastCreated: created.length,
      lastResolved: resolved.length,
      lastOpen: stillOpen.length
    };
    if (created.length || resolved.length || escalated.length) {
      addAudit(data, '运营巡检执行', `新增 ${created.length} · 升级 ${escalated.length} · 关闭 ${resolved.length}`);
    }
    return { created, escalated, resolved, open: stillOpen.length };
  }

  function notifySlaAlert(data, alert) {
    const overdueText = alert.level === 'OVERDUE'
      ? `已超时 ${alert.overdueMinutes >= 60 ? `${Math.floor(alert.overdueMinutes / 60)} 小时` : `${alert.overdueMinutes} 分钟`}`
      : '即将超时';
    const content = `${alert.ruleLabel}：${alert.businessNo} ${overdueText}，请尽快处理。${alert.detail ? `（${alert.detail}）` : ''}`.slice(0, 300);
    if (alert.ownerRole === 'MERCHANT' && alert.merchantId) {
      notifyMerchant(data, alert.merchantId, 'SLA', alert.level === 'OVERDUE' ? '履约已超时' : '履约即将超时', content);
    }
    if (alert.ownerRole === 'PLATFORM' && alert.merchantId) {
      notifyMerchant(data, alert.merchantId, 'SLA', '平台正在处理中', `${alert.ruleLabel}：${alert.businessNo} ${overdueText}，平台已收到提醒。`);
    }
  }

  function patrolOnce() {
    return store.update((data) => runOperationsPatrol(data, new Date().toISOString()));
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
        const username = process.env.ADMIN_USERNAME || 'admin';
        const password = process.env.ADMIN_PASSWORD;
        if (!password || body.username !== username || body.password !== password) {
          throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
        }
        const token = createHash('sha256').update(`${username}:${password}:${randomUUID()}`).digest('hex');
        adminSessions.set(token, { username, expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return sendJson(response, 200, { data: { token, user: { name: '运营管理员', role: '超级管理员' }, expiresIn: 28800 }, requestId });
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
        }
        if (!userId) throw new ApiError(502, 'WECHAT_LOGIN_INVALID', '微信登录返回缺少用户标识');
        const token = createHash('sha256').update(`${userId}:${randomUUID()}`).digest('hex');
        userSessions.set(token, { userId, expiresAt: Date.now() + userSessionTtlMs });
        return sendJson(response, 200, { data: { token, userId, expiresIn: 604800 }, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/auth/demo-login') {
        const userId = 'wx_demo_user';
        const token = createHash('sha256').update(`${userId}:${randomUUID()}`).digest('hex');
        userSessions.set(token, { userId, expiresAt: Date.now() + userSessionTtlMs });
        return sendJson(response, 200, { data: { token, userId, expiresIn: 604800 }, requestId });
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
        const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const session = adminSessions.get(token);
        if (!session || session.expiresAt < Date.now()) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请重新登录管理端');
      }

      if (request.method === 'GET' && pathname === '/health') {
        const dbExists = fs.existsSync(store.filePath);
        return sendJson(response, 200, { ok: true, service: 'campus-go-mock-api', dbFile: store.filePath, dbExists, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/products') {
        sweepExpiredOrders();
        const data = store.read();
        const products = data.products;
        const category = url.searchParams.get('category');
        const campusId = url.searchParams.get('campusId');
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const items = products.filter((product) => product.active)
          .filter((product) => !category || product.category === category)
          .filter((product) => !campusId || product.campusIds.includes(campusId))
          .filter((product) => !query || `${product.name} ${product.description}`.toLowerCase().includes(query));
        return sendJson(response, 200, { data: items.map((product) => withAvailableStock(withProductReviewSummary(withMerchantName(product, data.merchants || []), data.productReviews || []))), total: items.length, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/recharge-promos') {
        const items = (store.read().rechargePromos || []).filter((item) => item.active !== false);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/business-config') {
        return sendJson(response, 200, { data: publicSettings(store.read().adminSettings), requestId });
      }

      const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (request.method === 'GET' && productMatch) {
        sweepExpiredOrders();
        const data = store.read();
        const product = data.products.find((item) => item.id === productMatch[1] && item.active);
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        const settings = publicSettings(data.adminSettings);
        const relatedProducts = data.products
          .filter((item) => item.active && item.id !== product.id && item.category === product.category)
          .slice(0, 3)
          .map((item) => withAvailableStock(withProductReviewSummary(withMerchantName(item, data.merchants || []), data.productReviews || [])));
        return sendJson(response, 200, {
          data: {
            ...withAvailableStock(withProductReviewSummary(withMerchantName(product, data.merchants || []), data.productReviews || [])),
            reviews: (data.productReviews || [])
              .filter((review) => review.productId === product.id && review.visibility !== 'HIDDEN')
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
        if (role === 'MERCHANT') requireMerchant(request);
        if (role === 'PLATFORM') {
          const adminToken=(request.headers.authorization||'').replace(/^Bearer\s+/i,'');
          if (!adminSessions.get(adminToken)) throw new ApiError(401,'ADMIN_UNAUTHORIZED','请重新登录管理端');
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
            addNotification(data, item.userId, 'ORDER', `订单 ${item.orderNo} 有新商家留言`, note);
          } else if (role === 'PLATFORM') {
            notifyOrderMerchant(data, item, 'ORDER', `平台已介入订单 ${item.orderNo}`, note);
            addNotification(data, item.userId, 'ORDER', `平台已处理订单 ${item.orderNo}`, note);
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

      if (request.method === 'GET' && pathname === '/api/merchant/overview') {
        sweepExpiredOrders();
        sweepMaturedSettlements();
        sweepOperationsPatrol();
        const data = store.read();
            const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
            if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
        const products = data.products.filter((item) => item.merchantId === merchant.id);
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
        // 商家只看得到需要自己处理的超时预警，平台内部事项不下发。
        const slaAlerts = (data.slaAlerts || [])
          .filter((alert) => alert.status !== 'RESOLVED' && alert.ownerRole === 'MERCHANT' && alert.merchantId === merchant.id)
          .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)));
        const revenueInCents = orders.filter((order) => ['PAID', 'FULFILLING', 'COMPLETED', 'AFTER_SALE'].includes(order.status))
          .reduce((sum, order) => sum + (order.totalInCents || 0), 0);
        return sendJson(response, 200, {
          data: {
            merchant: merchantPublic(merchant),
            metrics: {
              revenueInCents,
              orderCount: orders.length,
              pendingCount: orders.filter((order) => ['PAID', 'FULFILLING'].includes(order.status)).length,
              afterSaleCount: afterSales.filter((record) => record.status !== 'CLOSED').length,
              productCount: products.length,
              lowStockCount: products.filter((product) => availableStock(product) < 10).length,
              afterSaleOverdueCount: afterSales.filter((record) => record.status !== 'CLOSED' && record.responseDueAt && record.responseDueAt < new Date().toISOString()).length,
              reviewCount: reviews.length,
              pendingReplyCount: reviews.filter((review) => !review.reply).length,
              slaOpenCount: slaAlerts.length,
              slaOverdueCount: slaAlerts.filter((alert) => alert.level === 'OVERDUE').length,
              settlementMetrics
            },
            products: products.map(withAvailableStock),
            orders: enrichedOrders,
            afterSales,
            reviews,
            settlements,
            payoutRequests,
            slaAlerts
          },
          requestId
        });
      }

      if (request.method === 'GET' && pathname === '/api/merchant/notifications') {
        const data = store.read();
        const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
        if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
        const items = (data.notifications || [])
          .filter((item) => item.userId === merchant.userId)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        return sendJson(response, 200, { data: items, total: items.length, unreadCount: items.filter((item) => !item.read).length, requestId });
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
          const priceInCents = requirePositiveInteger(body.priceInCents, 'priceInCents');
          const stock = requirePositiveInteger(body.stock, 'stock', { max: 999999 });
          const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
          if (imageUrl && !imageUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '商品图片必须来自平台上传目录');
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
            active: body.active !== false
          };
          data.products.unshift(item);
          addAudit(data, '商家新增商品', item.name);
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
          if (body.name !== undefined) item.name = requireString(body.name, 'name', { maxLength: 80 });
          if (body.description !== undefined) item.description = requireString(body.description, 'description', { maxLength: 300 });
          if (body.imageUrl !== undefined) {
            const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
            if (imageUrl && !imageUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '商品图片必须来自平台上传目录');
            item.imageUrl = imageUrl;
          }
          if (body.priceInCents !== undefined) item.priceInCents = requirePositiveInteger(body.priceInCents, 'priceInCents');
          if (body.stock !== undefined) item.stock = requirePositiveInteger(body.stock, 'stock', { max: 999999 });
          if (body.active !== undefined) item.active = Boolean(body.active);
          item.updatedAt = new Date().toISOString();
          addAudit(data, '商家更新商品', item.name);
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
            addNotification(data, item.userId, 'ORDER', '订单已完成', `订单 ${item.orderNo} 已通过交付码核验并完成。`);
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
            addNotification(data, order.userId, 'AFTER_SALE', '售后处理完成', resolutionNote);
          }
          if (status === 'REVIEWING') addNotification(data, order.userId, 'AFTER_SALE', '售后正在处理', '商家已开始处理您的售后申请。');
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

      if (request.method === 'GET' && pathname === '/api/admin/notifications') {
        const data = store.read();
        const items = (data.notifications || []).filter(Boolean);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      // 运营巡检：手动立即跑一轮，用于处理完一批工单后马上刷新预警。
      if (request.method === 'POST' && pathname === '/api/admin/patrol/run') {
        const result = patrolOnce();
        const data = store.read();
        return sendJson(response, 200, {
          data: {
            created: result.created.length,
            escalated: result.escalated.length,
            resolved: result.resolved.length,
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
        const body = await readJson(request);
        const note = requireString(body.note, 'note', { maxLength: 200 });
        const alert = store.update((data) => {
          const item = (data.slaAlerts || []).find((row) => row.id === slaAckMatch[1]);
          if (!item) throw new ApiError(404, 'SLA_ALERT_NOT_FOUND', '预警记录不存在');
          if (item.status === 'RESOLVED') throw new ApiError(409, 'SLA_ALERT_RESOLVED', '该预警已自动关闭，无需处理');
          const now = new Date().toISOString();
          item.status = 'ACKNOWLEDGED';
          item.acknowledgedAt = now;
          item.acknowledgeNote = note;
          item.updatedAt = now;
          addAudit(data, '认领超时预警', `${item.ruleLabel} ${item.businessNo}`);
          if (item.ownerRole === 'MERCHANT' && item.merchantId) {
            notifyMerchant(data, item.merchantId, 'SLA', '平台已跟进超时事项', `${item.ruleLabel}：${item.businessNo} 平台处理意见：${note}`);
          }
          return item;
        });
        return sendJson(response, 200, { data: alert, requestId });
      }

      const adminPaymentRefundMatch = pathname.match(/^\/api\/admin\/payment-orders\/([^/]+)\/refund$/);
      if (request.method === 'POST' && adminPaymentRefundMatch) {
        const updated = store.update((data) => {
          if (!Array.isArray(data.paymentOrders)) data.paymentOrders = [];
          const paymentOrder = data.paymentOrders.find((item) => item.id === adminPaymentRefundMatch[1]);
          if (!paymentOrder) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          if (paymentOrder.status !== 'PAID') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '\u4ec5\u5df2\u652f\u4ed8\u5355\u53ef\u9000\u6b3e');
          const now = new Date().toISOString();
          paymentOrder.status = 'REFUNDED';
          paymentOrder.refundedAt = now;
          paymentOrder.updatedAt = now;
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
            addNotification(data, paymentOrder.userId, 'RECHARGE', '\u8bdd\u8d39\u6743\u76ca\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${paymentOrder.paymentNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
          } else if (phoneCardOrder) {
            addNotification(data, paymentOrder.userId, 'PHONE_PLAN', '电话卡订单已退款', `\u8ba2\u5355 ${paymentOrder.paymentNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
          } else if (plateApplication) {
            addNotification(data, paymentOrder.userId, 'PLATE', '牌照服务费已退款', `申请 ${paymentOrder.paymentNo} 已完成退款，如需重新办理可再次提交。`);
          } else {
            addNotification(data, paymentOrder.userId, 'ORDER', '\u8ba2\u5355\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${paymentOrder.orderNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
          }
          return { order, rechargeOrder, phoneCardOrder, plateApplication, paymentOrder };
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/overview') {
        sweepExpiredOrders();
        sweepMaturedSettlements();
        sweepOperationsPatrol();
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
        const financeSummary = {
          paymentInCents: financeEvents.filter((event) => event.eventType === 'PAYMENT').reduce((sum, event) => sum + event.amountInCents, 0),
          refundOutCents: financeEvents.filter((event) => event.eventType === 'REFUND').reduce((sum, event) => sum + event.amountInCents, 0),
          payoutOutCents: financeEvents.filter((event) => event.eventType === 'PAYOUT').reduce((sum, event) => sum + event.amountInCents, 0),
          netInCents: financeEvents.reduce((sum, event) => sum + event.amountInCents, 0)
        };
        return sendJson(response, 200, {
          data: {
            metrics: { revenueInCents, paidOrders, pending, lowStock: data.products.filter((item) => availableStock(item) < 10).length, leadsToday: leads.filter(x => x.createdAt.slice(0,10) === new Date().toISOString().slice(0,10)).length, leadsPending: leads.filter(x => openLeadStatuses.has(x.status)).length, leadsOverdue: leads.filter(x => x.slaDueAt < new Date().toISOString() && openLeadStatuses.has(x.status)).length, afterSaleOverdue: (data.afterSales || []).filter((item) => item.status !== 'CLOSED' && item.responseDueAt && item.responseDueAt < new Date().toISOString()).length },
            products: data.products.map(withAvailableStock),
            rechargePromos: data.rechargePromos || [],
            merchants: data.merchants,
            orders: data.orders,
            phoneCardOrders: data.phoneCardOrders,
            rechargeOrders: data.rechargeOrders,
            broadbandApplications: data.broadbandApplications,
            plateApplications: data.plateApplications,
            paymentOrders: data.paymentOrders || [],
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
            patrolState: data.patrolState || {},
            settings: data.adminSettings,
            auditLogs: data.auditLogs
            ,leads
          }, requestId
        });
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
          if (decision === 'REJECT') {
            const restored = rejectPayoutRequest(data, payoutRequest, now, reviewNote);
            return { ...payoutRequest, restoredSettlementCount: restored };
          }
          payoutRequest.reviewNote = reviewNote;
          const paidInCents = approvePayoutRequest(data, payoutRequest, now, reference);
          return { ...payoutRequest, paidAmountInCents: paidInCents };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/leads') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const now = new Date();
        const lead = { id:`lead_${randomUUID()}`, leadNo:`LS${Date.now().toString().slice(-8)}`, userId, name:requireString(body.name,'name',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), businessType:requireString(body.businessType,'businessType',{maxLength:40}), interest:requireString(body.interest || '未指定','interest',{maxLength:120}), expectedTime:(body.expectedTime||'尽快').toString().slice(0,40), deliveryNeed:(body.deliveryNeed||'无').toString().slice(0,120), note:(body.note||'').toString().slice(0,500), status:'SUBMITTED', assignee:'', followUps:[], createdAt:now.toISOString(), updatedAt:now.toISOString(), slaDueAt:new Date(now.getTime()+24*3600*1000).toISOString() };
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
        sweepExpiredOrders();
        const data = store.read();
        const merchants = data.merchants || [];
          const ebikeOrders = (data.orders || []).filter(item => item.userId === userId).map(order => ({ ...order, statusLabel:statusLabels[order.status]||order.status, collaboration:order.collaboration || createCollaboration(order, order.items?.[0]?.merchantId || ''), merchantName:merchants.find(merchant=>merchant.id===order.collaboration?.merchantId)?.name || '平台自营', plateApplicationId:((data.plateApplications||[]).find(plate=>(plate.relatedIds?.platformOrderIds||[]).includes(order.id))||{}).id || '' }));
        const serviceRecords = (() => {
          const phoneCardOrders=(data.phoneCardOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.amountInCents||0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const rechargeOrders=(data.rechargeOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents||0)/100).toFixed(0)}送${((item.receiveInCents||0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.paidInCents||0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const broadbandApplications=(data.broadbandApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'BROADBAND', typeLabel:'宽带', title:'双人购卡宽带', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const plateApplications=(data.plateApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel||'校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.feeInCents||0, paymentOrderId:item.paymentOrderId||'', paymentStatus:item.paymentStatus||'', studentNo:item.studentNo||'', materialCount:(item.materials||[]).length, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          return [...phoneCardOrders,...rechargeOrders,...broadbandApplications,...plateApplications];
        })();
        return sendJson(response,200,{data:{ebikeOrders,serviceRecords},requestId});
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
        const items = (data.notifications || []).filter((item) => item.userId === userId);
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
      if (request.method === 'POST' && pathname === '/api/phone-card-orders') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const productId = requireString(body.productId, 'productId', { maxLength: 100 });
        const planProduct = store.read().products.find((item) => item.id === productId && item.category === 'PHONE_PLAN' && item.active);
        if (!planProduct) throw new ApiError(404, 'PHONE_PLAN_NOT_FOUND', '套餐不存在或已下架');
        const amountInCents = Number(planProduct.priceInCents || 0);
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
        const record = { id:`tel_${randomUUID()}`, userId, customerName:requireString(body.customerName,'customerName',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), productId, planName:planProduct.name, amountInCents, status:'PENDING_PAYMENT', paymentStatus:'UNPAID', relatedIds:{}, createdAt:now, updatedAt:now };
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
            channel:'MOCK',
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
        return sendJson(response, result.reused?200:201, { data:result.record, paymentOrder:result.paymentOrder, requestId });
      }
      if (request.method === 'POST' && pathname === '/api/recharge-orders') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const promoId = requireString(body.promoId, 'promoId', { maxLength: 100 });
        const promo = store.read().rechargePromos?.find((item) => item.id === promoId && item.active !== false);
        if (!promo) throw new ApiError(404, 'RECHARGE_PROMO_NOT_FOUND', '话费活动不存在或已下架');
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
        const record = { id:`top_${randomUUID()}`, userId, phone:requireString(body.phone,'phone',{maxLength:30}), promoId, paidInCents, receiveInCents, status:'PENDING_PAYMENT', paymentStatus:'UNPAID', relatedIds:{}, createdAt:now, updatedAt:now };
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
            channel:'MOCK',
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
        return sendJson(response,201,{data:result.record,paymentOrder:result.paymentOrder,requestId});
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
        const result = store.update(data=>{
          const order = body.orderId ? (data.orders||[]).find(item=>item.id===body.orderId && item.userId===userId) : null;
          if (body.orderId && !order) throw new ApiError(404,'ORDER_NOT_FOUND','Order not found');
          const platformOrder = order && (data.products||[]).find(product=>product.id===order.items?.[0]?.productId)?.category === 'E_BIKE_NEW';
          const feeInCents = platformOrder ? 0 : ((data.adminSettings||{}).externalPlateFeeInCents ?? 4900);
          const application = { id:`plate_${randomUUID()}`, userId, customerName, phone:customerPhone, studentNo, vehicleModel, source:platformOrder?'PLATFORM_ORDER':'EXTERNAL', feeInCents, relatedOrderId:order?.id || '', status:platformOrder?'MATERIAL_PENDING':'PENDING_PAYMENT', paymentStatus:platformOrder?'PAID':'UNPAID', relatedIds:order?{ platformOrderIds:[order.id] }:{}, createdAt:now, updatedAt:now };
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
              channel:'MOCK',
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
        return sendJson(response,201,{data:result.application,paymentOrder:result.paymentOrder,requestId});
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
        const body=await readJson(request);
        if (body.status !== undefined && !allowedLeadStatuses.has(body.status)) throw new ApiError(400,'VALIDATION_ERROR','Unsupported lead status. Use SUBMITTED, FOLLOW_UP, COMPLETED or INVALID.');
        const updated=store.update(data=>{const item=(data.leads||[]).find(x=>x.id===leadMatch[1]); if(!item) throw new ApiError(404,'LEAD_NOT_FOUND','Lead not found'); for(const k of ['status','assignee','interest','expectedTime','deliveryNeed','note']) if(body[k]!==undefined) item[k]=String(body[k]).slice(0,500); item.updatedAt=new Date().toISOString(); addAudit(data,'更新咨询线索',item.leadNo); return item;});
        return sendJson(response,200,{data:updated,requestId});
      }
      const followMatch = pathname.match(/^\/api\/admin\/leads\/([^/]+)\/follow-ups$/);
      if (request.method === 'POST' && followMatch) { const body=await readJson(request); if (body.status !== undefined && !allowedLeadStatuses.has(body.status)) throw new ApiError(400,'VALIDATION_ERROR','Unsupported lead status. Use SUBMITTED, FOLLOW_UP, COMPLETED or INVALID.'); const updated=store.update(data=>{const item=(data.leads||[]).find(x=>x.id===followMatch[1]); if(!item) throw new ApiError(404,'LEAD_NOT_FOUND','Lead not found'); const text=requireString(body.content,'content',{maxLength:500}); item.followUps=item.followUps||[]; item.followUps.unshift({id:`fu_${randomUUID()}`,content:text,operator:body.operator||'运营管理员',createdAt:new Date().toISOString()}); if (body.status !== undefined) item.status=body.status; item.updatedAt=new Date().toISOString(); return item;}); return sendJson(response,200,{data:updated,requestId}); }
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
          item.reply = {
            merchantName: data.merchants.find((merchant) => merchant.id === merchantSession.merchantId)?.name || '商家回复',
            content,
            repliedAt: new Date().toISOString()
          };
          item.updatedAt = item.reply.repliedAt;
          addAudit(data, '商家回复商品评价', item.productId);
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
          item.status = status; item.updatedAt = new Date().toISOString(); addAudit(data, `更新${adminStatusMatch[1]}状态为${status}`, item.id);
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
            addNotification(data, item.userId, 'AFTER_SALE', '售后处理完成', resolutionNote);
          }
          if (template && item.userId) {
            const detail = item.planName || item.vehicleModel || item.reason || item.orderNo || item.id;
            addNotification(data, item.userId, template[0], template[1], `${detail}：${template[2]}`);
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

      const adminProductMatch = pathname.match(/^\/api\/admin\/products\/([^/]+)$/);
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
          if (body.active !== undefined) product.active = Boolean(body.active);
          addAudit(data, '更新商品', product.name);
          return product;
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/recharge-promos') {
        const body = await readJson(request);
        const payInCents = Number(body.payInCents);
        const receiveInCents = Number(body.receiveInCents);
        if (!Number.isInteger(payInCents) || payInCents < 1000 || payInCents > 10000000 || !Number.isInteger(receiveInCents) || receiveInCents <= payInCents || receiveInCents > 10000000) {
          throw new ApiError(400, 'VALIDATION_ERROR', '充值金额和到账金额格式不正确');
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
            item.updatedAt = new Date().toISOString();
            addAudit(data, '更新话费活动', item.id);
            return item;
          }
          const item = { id: `promo_${randomUUID()}`, pay: Math.round(payInCents / 100), receive: Math.round(receiveInCents / 100), badge, active, createdAt: new Date().toISOString() };
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
          const imageUrl = typeof body.imageUrl === 'string' ? body.imageUrl.trim() : '';
          if (imageUrl && !imageUrl.startsWith('/api/uploads/')) throw new ApiError(400, 'VALIDATION_ERROR', '商品图片必须来自平台上传目录');
          const item = { id: `prod_${randomUUID()}`, name: requireString(body.name, 'name', { maxLength: 80 }), category: requireString(body.category, 'category', { maxLength: 50 }), description: requireString(body.description, 'description', { maxLength: 300 }), priceInCents, stock, campusIds: ['campus_hzau'], imageUrl, active: body.active !== false };
          data.products.unshift(item); addAudit(data, '新增商品', item.name); return item;
        });
        return sendJson(response, 201, { data: product, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/admin/settings') {
        const body = await readJson(request);
        const settings = store.update((data) => {
          const current = data.adminSettings || {};
          for (const field of ['brandName', 'schoolName', 'campusName', 'servicePhone', 'serviceWechat']) if (body[field] !== undefined) current[field] = requireString(body[field], field, { maxLength: 80 });
          if (body.externalPlateFeeInCents !== undefined) { const fee = Number(body.externalPlateFeeInCents); if (!Number.isInteger(fee) || fee < 0) throw new ApiError(400, 'VALIDATION_ERROR', '服务费格式不正确'); current.externalPlateFeeInCents = fee; }
          if (body.deliveryFeeInCents !== undefined) { const fee = Number(body.deliveryFeeInCents); if (!Number.isInteger(fee) || fee < 0 || fee > 10000000) throw new ApiError(400, 'VALIDATION_ERROR', '配送费格式不正确'); current.deliveryFeeInCents = fee; }
          if (body.commissionRatePercent !== undefined) {
            const rate = Number(body.commissionRatePercent);
            if (!Number.isInteger(rate) || rate < 0 || rate > 50) throw new ApiError(400, 'VALIDATION_ERROR', '平台佣金比例需为 0-50 的整数');
            current.commissionRatePercent = rate;
          }
          for (const field of ['deliveryResponseHours', 'plateResponseHours', 'afterSaleResponseHours', 'afterSaleResolutionHours', 'phoneCardActivationHours', 'rechargeCreditHours', 'broadbandVerifyHours', 'payoutReviewHours', 'leadResponseHours']) {
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
          if (body.deliveryTimeSlots !== undefined) {
            if (!Array.isArray(body.deliveryTimeSlots) || body.deliveryTimeSlots.length < 1 || body.deliveryTimeSlots.length > 8) throw new ApiError(400, 'VALIDATION_ERROR', '配送时段需为 1-8 个');
            const slots = body.deliveryTimeSlots.map(normalizeTimeSlot).filter(Boolean);
            if (slots.length !== body.deliveryTimeSlots.length) throw new ApiError(400, 'VALIDATION_ERROR', '配送时段不能为空');
            current.deliveryTimeSlots = slots;
          }
          if (body.platformNotice !== undefined) current.platformNotice = requireString(body.platformNotice, 'platformNotice', { maxLength: 200 });
          data.adminSettings = current; addAudit(data, '更新系统设置', '运营配置'); return current;
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
            const subtotalInCents = product.priceInCents * quantity;
            totalInCents += subtotalInCents;
            orderItems.push({ productId, merchantId: product.merchantId || '', name: product.name, priceInCents: product.priceInCents, quantity, subtotalInCents });
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
            channel: 'MOCK',
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
        return sendJson(response, result.reused ? 200 : 201, { data: result.order, paymentOrder: result.paymentOrder, idempotencyReused: result.reused, requestId });
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
        request.url = `/api/payment-orders/${paymentOrder.id}/confirm`;
        const rerouted = new URL(request.url, 'http://localhost');
        const match = rerouted.pathname.match(/^\/api\/payment-orders\/([^/]+)\/confirm$/);
        const result = store.update((innerData) => {
          const payment = innerData.paymentOrders.find((item) => item.id === match[1] && item.userId === userId);
          if (!payment) throw new ApiError(404, 'PAYMENT_NOT_FOUND', 'Payment order not found');
          const linkedOrder = innerData.orders.find((item) => item.id === payment.orderId && item.userId === userId);
          if (!linkedOrder) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          const now = new Date().toISOString();
          if (payment.status !== 'PENDING') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '\u4ec5\u5f85\u652f\u4ed8\u5355\u53ef\u652f\u4ed8');
          payment.status = 'PAID';
          payment.paidAt = now;
          payment.updatedAt = now;
          linkedOrder.status = 'PAID';
          linkedOrder.paymentStatus = 'PAID';
          linkedOrder.updatedAt = now;
          issueDeliveryCode(linkedOrder, now);
          consumeOrderStock(innerData, linkedOrder);
          const bikeItem = linkedOrder.items.find((item) => (innerData.products || []).find((product) => product.id === item.productId)?.category === 'E_BIKE_NEW');
          if (bikeItem) {
            const plateApplication = {
              id: `plate_${randomUUID()}`,
              userId,
              customerName: linkedOrder.fulfillment?.contactName || '\u5e73\u53f0\u8d2d\u8f66\u7528\u6237',
              phone: linkedOrder.fulfillment?.contactPhone || '',
              vehicleModel: bikeItem.name,
              source: 'PLATFORM_ORDER',
              feeInCents: 0,
              relatedOrderId: linkedOrder.id,
              status: 'MATERIAL_PENDING',
              relatedIds: { platformOrderIds: [linkedOrder.id] },
              createdAt: now,
              updatedAt: now
            };
            (innerData.plateApplications = innerData.plateApplications || []).unshift(plateApplication);
            addAudit(innerData, '\u7528\u6237\u652f\u4ed8\u540e\u521b\u5efa\u514d\u8d39\u724c\u7167\u8f85\u52a9', linkedOrder.orderNo);
            addNotification(innerData, userId, 'PLATE', '\u514d\u8d39\u724c\u7167\u8f85\u52a9\u5df2\u53d1\u8d77', '\u5e73\u53f0\u8d2d\u8f66\u540e\u53ef\u4eab\u53d7\u514d\u8d39\u6821\u56ed\u724c\u7167\u8f85\u52a9\u3002');
          }
          linkedOrder.collaboration ||= createCollaboration(linkedOrder, linkedOrder.items[0]?.merchantId || '');
          createSettlements(innerData, linkedOrder, now);
          addFinanceEvent(innerData, 'PAYMENT', `PAYMENT_${payment.id}`, payment.amountInCents, {
            userId, paymentNo: payment.paymentNo, orderNo: linkedOrder.orderNo, businessType: 'ORDER'
          }, now);
          linkedOrder.collaboration.messages.unshift({ id:`msg_${Date.now()}_${Math.random().toString(16).slice(2,8)}`, role:'PLATFORM', text:'\u652f\u4ed8\u6210\u529f\uff0c\u5f85\u5546\u5bb6\u786e\u8ba4\u5c65\u7ea6\u3002', createdAt:now });
          addAudit(innerData, '\u7528\u6237\u6a21\u62df\u652f\u4ed8\u6210\u529f', linkedOrder.orderNo);
          addNotification(innerData, userId, 'ORDER', '\u652f\u4ed8\u6210\u529f', `\u8ba2\u5355 ${linkedOrder.orderNo} \u652f\u4ed8\u6210\u529f\uff0c\u5546\u5bb6\u5c06\u5c3d\u5feb\u786e\u8ba4\u5c65\u7ea6\u3002`);
          notifyOrderMerchant(innerData, linkedOrder, 'ORDER', '新订单已支付', `订单 ${linkedOrder.orderNo} 已支付，请尽快确认履约。`);
          return { order: linkedOrder, paymentOrder: payment };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      const paymentMatch = pathname.match(/^\/api\/payment-orders\/([^/]+)(?:\/(confirm|cancel|refund))?$/);
      if (request.method === 'POST' && paymentMatch) {
        const { userId } = requireUser(request);
        const action = paymentMatch[2];
        if (!action) throw new ApiError(404, 'NOT_FOUND', 'Payment action is required');
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
          if (action === 'confirm') {
            if (paymentOrder.status !== 'PENDING') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '\u4ec5\u5f85\u652f\u4ed8\u5355\u53ef\u64cd\u4f5c');
            paymentOrder.status = 'PAID';
            paymentOrder.paidAt = now;
            paymentOrder.updatedAt = now;
            if (rechargeOrder) {
              rechargeOrder.status = 'PENDING_CREDIT';
              rechargeOrder.paymentStatus = 'PAID';
              rechargeOrder.updatedAt = now;
              addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
                userId, paymentNo: paymentOrder.paymentNo, businessType: 'RECHARGE'
              }, now);
              addAudit(data, '\u8bdd\u8d39\u6743\u76ca\u652f\u4ed8\u6210\u529f', rechargeOrder.id);
              addNotification(data, userId, 'RECHARGE', '\u8bdd\u8d39\u6743\u76ca\u652f\u4ed8\u6210\u529f', `\u5145 ${Math.round(rechargeOrder.paidInCents/100)} \u9001 ${Math.round((rechargeOrder.receiveInCents-rechargeOrder.paidInCents)/100)} \u5df2\u652f\u4ed8\uff0c\u7b49\u5f85\u8fd0\u8425\u786e\u8ba4\u5230\u8d26\u3002`);
              return { rechargeOrder, paymentOrder };
            }
            if (phoneCardOrder) {
              phoneCardOrder.status = 'PENDING_REALNAME';
              phoneCardOrder.paymentStatus = 'PAID';
              phoneCardOrder.updatedAt = now;
              addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
                userId, paymentNo: paymentOrder.paymentNo, businessType: 'PHONE_PLAN'
              }, now);
              addAudit(data, '电话卡支付成功', phoneCardOrder.id);
            addNotification(data, userId, 'PHONE_PLAN', '电话卡支付成功', `${phoneCardOrder.planName} 已支付，运营将在 24 小时内联系实名激活。`);
            return { phoneCardOrder, paymentOrder };
          }
          if (plateApplication) {
            plateApplication.status = 'MATERIAL_PENDING';
            plateApplication.paymentStatus = 'PAID';
            plateApplication.updatedAt = now;
            addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
              userId, paymentNo: paymentOrder.paymentNo, businessType: 'PLATE'
            }, now);
            addAudit(data, '自带车上牌服务费支付成功', plateApplication.id);
            addNotification(data, userId, 'PLATE', '牌照服务费支付成功', `${plateApplication.vehicleModel} 已支付服务费，请按客服指引补充车辆和身份材料。`);
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
                userId,
                customerName: order.fulfillment?.contactName || '\u5e73\u53f0\u8d2d\u8f66\u7528\u6237',
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
              addAudit(data, '\u8d2d\u8f66\u652f\u4ed8\u540e\u81ea\u52a8\u521b\u5efa\u514d\u8d39\u724c\u7167\u8f85\u52a9', order.orderNo);
              addNotification(data, userId, 'PLATE', '\u514d\u8d39\u724c\u7167\u8f85\u52a9\u5df2\u53d1\u8d77', '\u6211\u4eec\u5df2\u4e3a\u60a8\u521b\u5efa\u6821\u56ed\u724c\u7167\u8f85\u52a9\u5de5\u5355\uff0c\u8bf7\u51c6\u5907\u8f66\u8f86\u4e0e\u8eab\u4efd\u6750\u6599\u3002');
            }
            order.collaboration ||= createCollaboration(order, order.items[0]?.merchantId || '');
            createSettlements(data, order, now);
            addFinanceEvent(data, 'PAYMENT', `PAYMENT_${paymentOrder.id}`, paymentOrder.amountInCents, {
              userId, paymentNo: paymentOrder.paymentNo, orderNo: order.orderNo, businessType: 'ORDER'
            }, now);
            order.collaboration.messages.unshift({ id:`msg_${Date.now()}_${Math.random().toString(16).slice(2,8)}`, role:'PLATFORM', text:'\u652f\u4ed8\u6210\u529f\uff0c\u5f85\u5546\u5bb6\u786e\u8ba4\u5c65\u7ea6\u3002', createdAt:now });
            addAudit(data, '\u6a21\u62df\u652f\u4ed8\u56de\u8c03\u6210\u529f', order.orderNo);
            addNotification(data, userId, 'ORDER', '\u652f\u4ed8\u6210\u529f', `\u8ba2\u5355 ${order.orderNo} \u652f\u4ed8\u6210\u529f\uff0c\u5546\u5bb6\u5c06\u5c3d\u5feb\u786e\u8ba4\u5c65\u7ea6\u3002`);
            notifyOrderMerchant(data, order, 'ORDER', '新订单已支付', `订单 ${order.orderNo} 已支付，请尽快确认履约。`);
            return { order, paymentOrder };
          }
          if (action === 'cancel') {
            if (paymentOrder.status !== 'PENDING') throw new ApiError(409, 'PAYMENT_STATUS_NOT_ALLOWED', '\u4ec5\u5f85\u652f\u4ed8\u5355\u53ef\u64cd\u4f5c');
            paymentOrder.status = 'CANCELLED';
            paymentOrder.updatedAt = now;
            if (rechargeOrder) {
              rechargeOrder.status = 'CANCELLED';
              rechargeOrder.paymentStatus = 'CANCELLED';
              rechargeOrder.updatedAt = now;
              addAudit(data, '\u8bdd\u8d39\u6743\u76ca\u5f85\u652f\u4ed8\u5df2\u53d6\u6d88', rechargeOrder.id);
              addNotification(data, userId, 'RECHARGE', '\u8bdd\u8d39\u6743\u76ca\u5df2\u53d6\u6d88', '\u60a8\u7684\u5f85\u652f\u4ed8\u8bdd\u8d39\u6743\u76ca\u8ba2\u5355\u5df2\u53d6\u6d88\u3002');
              return { rechargeOrder, paymentOrder };
            }
            if (phoneCardOrder) {
              phoneCardOrder.status = 'CANCELLED';
              phoneCardOrder.paymentStatus = 'CANCELLED';
              phoneCardOrder.updatedAt = now;
              addAudit(data, '电话卡待支付已取消', phoneCardOrder.id);
            addNotification(data, userId, 'PHONE_PLAN', '电话卡订单已取消', '您的待支付电话卡订单已取消，如需办理可重新下单。');
            return { phoneCardOrder, paymentOrder };
          }
          if (plateApplication) {
            plateApplication.status = 'CANCELLED';
            plateApplication.paymentStatus = 'CANCELLED';
            plateApplication.updatedAt = now;
            addAudit(data, '自带车上牌待支付已取消', plateApplication.id);
            addNotification(data, userId, 'PLATE', '牌照服务申请已取消', '您的待支付上牌辅助申请已取消，如需办理可重新提交。');
            return { plateApplication, paymentOrder };
          }
            order.status = 'CANCELLED';
            order.paymentStatus = 'CANCELLED';
            order.updatedAt = now;
            releaseOrderStock(data, order);
            addAudit(data, '\u7528\u6237\u53d6\u6d88\u5f85\u652f\u4ed8', order.orderNo);
            addNotification(data, userId, 'ORDER', '\u8ba2\u5355\u5df2\u53d6\u6d88', `\u8ba2\u5355 ${order.orderNo} \u5df2\u53d6\u6d88\uff0c\u82e5\u9700\u8981\u53ef\u91cd\u65b0\u4e0b\u5355\u3002`);
            return { order, paymentOrder };
          }
          throw new ApiError(403, 'FORBIDDEN', '\u4ec5\u7ba1\u7406\u7aef\u53ef\u9000\u6b3e');
        });
        return sendJson(response, 200, { data: { order: updated.order, rechargeOrder: updated.rechargeOrder, phoneCardOrder: updated.phoneCardOrder, plateApplication: updated.plateApplication, paymentOrder: updated.paymentOrder }, requestId });
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
                addNotification(data, userId, 'ORDER', '配送时间已更新', `订单 ${order.orderNo} 的新配送安排：${nextSchedule}。`);
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
            paymentOrder.updatedAt = now;
          }
          addAudit(data, '\u7528\u6237\u53d6\u6d88\u8ba2\u5355', order.orderNo);
          addNotification(data, userId, 'ORDER', '\u8ba2\u5355\u5df2\u53d6\u6d88', `\u8ba2\u5355 ${order.orderNo} \u5df2\u53d6\u6d88\u3002`);
          return order;
        });
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
    const tick = () => {
      try {
        const result = patrolOnce();
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
