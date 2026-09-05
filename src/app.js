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
  'plate-applications': new Set(['MATERIAL_PENDING', 'REVIEWING', 'COMPLETED', 'REJECTED']),
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
        settlementStatus: 'PENDING_SETTLE',
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

  function markSettlementsRefunded(data, orderId, now) {
    if (!orderId || !Array.isArray(data.settlements)) return;
    for (const settlement of data.settlements) {
      if (settlement.orderId !== orderId || settlement.settlementStatus === 'REFUNDED') continue;
      settlement.settlementStatus = 'REFUNDED';
      settlement.updatedAt = now;
      settlement.refundedAt = now;
    }
  }

  function settleMerchant(data, merchantId, now, reference) {
    if (!Array.isArray(data.settlements)) throw new ApiError(404, 'SETTLEMENT_NOT_FOUND', 'Settlement record not found');
    const settlements = data.settlements.filter((item) => item.merchantId === merchantId && item.settlementStatus === 'PENDING_SETTLE');
    if (!settlements.length) throw new ApiError(404, 'PENDING_SETTLEMENT_NOT_FOUND', 'No pending settlement');
    let totalInCents = 0;
    for (const settlement of settlements) {
      settlement.settlementStatus = 'SETTLED';
      settlement.settledAt = now;
      settlement.settlementReference = reference;
      settlement.updatedAt = now;
      totalInCents += settlement.payableAmountInCents || 0;
    }
    return totalInCents;
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
    for (const orderItem of order.items) {
      const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
      if (product) product.stock = Number(product.stock || 0) + Number(orderItem.quantity || 0);
    }
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
  return async function app(request, response) {
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
        const data = store.read();
        const products = data.products;
        const category = url.searchParams.get('category');
        const campusId = url.searchParams.get('campusId');
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const items = products.filter((product) => product.active)
          .filter((product) => !category || product.category === category)
          .filter((product) => !campusId || product.campusIds.includes(campusId))
          .filter((product) => !query || `${product.name} ${product.description}`.toLowerCase().includes(query));
        return sendJson(response, 200, { data: items.map((product) => withProductReviewSummary(withMerchantName(product, data.merchants || []), data.productReviews || [])), total: items.length, requestId });
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
        const data = store.read();
        const product = data.products.find((item) => item.id === productMatch[1] && item.active);
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        const settings = publicSettings(data.adminSettings);
        const relatedProducts = data.products
          .filter((item) => item.active && item.id !== product.id && item.category === product.category)
          .slice(0, 3)
          .map((item) => withProductReviewSummary(withMerchantName(item, data.merchants || []), data.productReviews || []));
        return sendJson(response, 200, {
          data: {
            ...withProductReviewSummary(withMerchantName(product, data.merchants || []), data.productReviews || []),
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
            }
            else if (!['CONTACT','NOTE'].includes(action)) throw new ApiError(409,'ACTION_NOT_ALLOWED','当前状态不支持该商家动作');
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
        const data = store.read();
            const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
            if (!merchant) throw new ApiError(404, 'MERCHANT_NOT_FOUND', 'Merchant not found');
            const products = data.products.filter((item) => item.merchantId === merchant.id);
            const merchantProductIds = new Set(products.map((product) => product.id));
            const orders = data.orders
              .filter((order) => order.items.some((item) => merchantProductIds.has(item.productId) || item.merchantId === merchant.id))
              .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const enrichedOrders = orders.map((order) => ({
          ...sanitizeOrderForMerchant(order),
          merchantName: merchant.name,
          collaboration: order.collaboration || createCollaboration(order, merchant.id)
        }));
        const settlements = (data.settlements || []).filter((item) => item.merchantId === merchant.id);
        const settlementMetrics = {
          commissionRatePercent: Number(data.adminSettings?.commissionRatePercent ?? 2),
          payableInCents: settlements.filter((item) => item.settlementStatus === 'PENDING_SETTLE').reduce((sum, item) => sum + (item.payableAmountInCents || 0), 0),
          settledInCents: settlements.filter((item) => item.settlementStatus === 'SETTLED').reduce((sum, item) => sum + (item.payableAmountInCents || 0), 0),
          refundedInCents: settlements.filter((item) => item.settlementStatus === 'REFUNDED').reduce((sum, item) => sum + (item.payableAmountInCents || 0), 0)
        };
        const revenueInCents = orders.reduce((sum, order) => sum + order.totalInCents, 0);
        const afterSales = (data.afterSales || []).filter((record) => orders.some((order) => order.id === record.orderId));
        return sendJson(response, 200, {
          data: {
            merchant: merchantPublic(merchant),
            metrics: {
              revenueInCents,
              orderCount: orders.length,
              pendingCount: orders.filter((order) => !['COMPLETED', 'CANCELLED', 'AFTER_SALE'].includes(order.status)).length,
              productCount: products.length,
              lowStockCount: products.filter((product) => product.stock < 10).length,
              settlementMetrics
            },
            products,
            orders: enrichedOrders,
            afterSales,
            settlements
          },
          requestId
        });
      }

      if (request.method === 'POST' && pathname === '/api/merchant/settlement') {
        const body = await readJson(request);
        const settlementReference = requireString(body.reference || '平台线下打款', 'reference', { maxLength: 120 });
        const result = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号不可用');
          const now = new Date().toISOString();
          const totalInCents = settleMerchant(data, merchant.id, now, settlementReference);
          addFinanceEvent(data, 'PAYOUT', `PAYOUT_${merchant.id}_${now}`, -totalInCents, {
            merchantId: merchant.id, merchantName: merchant.name, settlementReference
          }, now);
          const settlementCount = (data.settlements || []).filter((item) => item.merchantId === merchant.id && item.settlementStatus === 'SETTLED').length;
          addAudit(data, '商家结算打款确认', `${merchant.name} ${settlementReference}`);
          addNotification(data, merchant.userId, 'SETTLEMENT', '结算已完成', `平台已确认结算 ${settlementCount} 笔，合计 ¥${(totalInCents / 100).toFixed(2)}。`);
          return { merchantId: merchant.id, totalInCents, settlementCount, settlementReference };
        });
        return sendJson(response, 200, { data: result, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/merchant/products') {
        const body = await readJson(request);
        const product = store.update((data) => {
          const merchant = data.merchants.find((item) => item.id === merchantSession.merchantId);
          if (!merchant || merchant.status !== 'APPROVED') throw new ApiError(403, 'MERCHANT_NOT_APPROVED', '商家账号不可用');
          const priceInCents = requirePositiveInteger(body.priceInCents, 'priceInCents');
          const stock = requirePositiveInteger(body.stock, 'stock', { max: 999999 });
          const item = {
            id: `prod_${randomUUID()}`,
            name: requireString(body.name, 'name', { maxLength: 80 }),
            category: requireString(body.category, 'category', { maxLength: 50 }),
            description: requireString(body.description, 'description', { maxLength: 300 }),
            priceInCents,
            stock,
            campusIds: ['campus_demo'],
            imageUrl: '',
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
          if (status === 'COMPLETED') addNotification(data, item.userId, 'ORDER', '订单已完成', `订单 ${item.orderNo} 已通过交付码核验并完成。`);
          return item;
        });
        return sendJson(response, 200, { data: order, requestId });
      }

      const merchantAfterSaleMatch = pathname.match(/^\/api\/merchant\/after-sales\/([^/]+)\/status$/);
      if (request.method === 'POST' && merchantAfterSaleMatch) {
        const body = await readJson(request);
        const status = requireString(body.status, 'status', { maxLength: 30 });
        if (!['SUBMITTED', 'REVIEWING', 'CLOSED'].includes(status)) throw new ApiError(400, 'VALIDATION_ERROR', 'Unsupported merchant after-sale status');
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
          if (status === 'CLOSED' && item.type === 'REFUND') {
            applyOrderRefund(data, order, item.updatedAt);
            appendCollaborationEvent(order, 'MERCHANT', 'AFTER_SALE_CLOSED', '退款已完成，订单关闭');
          } else if (status === 'CLOSED') {
            order.status = 'COMPLETED';
            order.updatedAt = item.updatedAt;
            appendCollaborationEvent(order, 'MERCHANT', 'AFTER_SALE_CLOSED', '售后处理完成，订单继续履约');
            addNotification(data, order.userId, 'AFTER_SALE', '售后处理完成', '您的售后已关闭，订单继续按约定履约。');
          }
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
          if (order) {
            order.status = 'CANCELLED';
            order.paymentStatus = 'REFUNDED';
            order.updatedAt = now;
            for (const orderItem of order.items) {
              const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
              if (product) product.stock = Number(product.stock || 0) + Number(orderItem.quantity || 0);
            }
          }
          markSettlementsRefunded(data, order?.id || '', now);
          addFinanceEvent(data, 'REFUND', `REFUND_${paymentOrder.id}`, -(paymentOrder.amountInCents || 0), {
            userId: paymentOrder.userId, paymentNo: paymentOrder.paymentNo, orderNo: order?.orderNo || '',
            businessType: phoneCardOrder ? 'PHONE_PLAN' : rechargeOrder ? 'RECHARGE' : 'ORDER'
          }, now);
          addAudit(data, '\u7ba1\u7406\u7aef\u9000\u6b3e', paymentOrder.paymentNo);
          if (rechargeOrder) {
            addNotification(data, paymentOrder.userId, 'RECHARGE', '\u8bdd\u8d39\u6743\u76ca\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${paymentOrder.paymentNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
          } else if (phoneCardOrder) {
            addNotification(data, paymentOrder.userId, 'PHONE_PLAN', '电话卡订单已退款', `\u8ba2\u5355 ${paymentOrder.paymentNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
          } else {
            addNotification(data, paymentOrder.userId, 'ORDER', '\u8ba2\u5355\u5df2\u9000\u6b3e', `\u8ba2\u5355 ${paymentOrder.orderNo} \u5df2\u5b8c\u6210\u9000\u6b3e\u3002`);
          }
          return { order, rechargeOrder, phoneCardOrder, paymentOrder };
        });
        return sendJson(response, 200, { data: updated, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/overview') {
        const data = store.read();
        const leads = data.leads || [];
        const revenueInCents = data.orders.filter((item) => item.status !== 'PENDING_PAYMENT' && item.status !== 'CANCELLED').reduce((sum, order) => sum + (order.totalInCents || 0), 0)
          + data.phoneCardOrders.filter((item) => ['PENDING_REALNAME', 'ACTIVATED'].includes(item.status)).reduce((sum, order) => sum + (order.amountInCents || 0), 0)
          + data.rechargeOrders.filter((item) => ['PENDING_CREDIT', 'CREDITED'].includes(item.status)).reduce((sum, order) => sum + (order.paidInCents || 0), 0)
          + data.plateApplications.reduce((sum, item) => sum + (item.feeInCents || 0), 0);
        const pending = data.orders.filter((item) => !['COMPLETED', 'CANCELLED'].includes(item.status)).length
          + data.phoneCardOrders.filter((item) => item.status !== 'ACTIVATED' && item.status !== 'CANCELLED' && item.status !== 'PENDING_PAYMENT').length
          + data.rechargeOrders.filter((item) => item.status !== 'CREDITED').length
          + data.broadbandApplications.filter((item) => item.status !== 'APPROVED').length
          + data.plateApplications.filter((item) => item.status !== 'COMPLETED').length;
        const financeEvents = data.financeEvents || [];
        const financeSummary = {
          paymentInCents: financeEvents.filter((event) => event.eventType === 'PAYMENT').reduce((sum, event) => sum + event.amountInCents, 0),
          refundOutCents: financeEvents.filter((event) => event.eventType === 'REFUND').reduce((sum, event) => sum + event.amountInCents, 0),
          payoutOutCents: financeEvents.filter((event) => event.eventType === 'PAYOUT').reduce((sum, event) => sum + event.amountInCents, 0),
          netInCents: financeEvents.reduce((sum, event) => sum + event.amountInCents, 0)
        };
        return sendJson(response, 200, {
          data: {
            metrics: { revenueInCents, paidOrders: data.orders.length + data.phoneCardOrders.length + data.rechargeOrders.length, pending, lowStock: data.products.filter((item) => item.stock < 10).length, leadsToday: leads.filter(x => x.createdAt.slice(0,10) === new Date().toISOString().slice(0,10)).length, leadsPending: leads.filter(x => openLeadStatuses.has(x.status)).length, leadsOverdue: leads.filter(x => x.slaDueAt < new Date().toISOString() && openLeadStatuses.has(x.status)).length },
            products: data.products,
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
            financeEvents: data.financeEvents || [],
            financeSummary,
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
        const plateApplications = (data.plateApplications || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel || '校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.feeInCents || 0, phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const items = [...phoneCardOrders, ...rechargeOrders, ...broadbandApplications, ...plateApplications].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        return sendJson(response,200,{data:items,total:items.length,requestId});
      }
      if (request.method === 'GET' && pathname === '/api/my/orders') {
        const { userId } = requireUser(request);
        const data = store.read();
        const merchants = data.merchants || [];
          const ebikeOrders = (data.orders || []).filter(item => item.userId === userId).map(order => ({ ...order, statusLabel:statusLabels[order.status]||order.status, collaboration:order.collaboration || createCollaboration(order, order.items?.[0]?.merchantId || ''), merchantName:merchants.find(merchant=>merchant.id===order.collaboration?.merchantId)?.name || '平台自营', plateApplicationId:((data.plateApplications||[]).find(plate=>(plate.relatedIds?.platformOrderIds||[]).includes(order.id))||{}).id || '' }));
        const serviceRecords = (() => {
          const phoneCardOrders=(data.phoneCardOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.amountInCents||0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const rechargeOrders=(data.rechargeOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents||0)/100).toFixed(0)}送${((item.receiveInCents||0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.paidInCents||0, paymentOrderId:item.paymentOrderId || '', paymentStatus:item.paymentStatus || '', relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const broadbandApplications=(data.broadbandApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'BROADBAND', typeLabel:'宽带', title:'双人购卡宽带', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const plateApplications=(data.plateApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel||'校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.feeInCents||0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
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
        const amountInCents = Number(body.amountInCents);
        if (!Number.isInteger(amountInCents) || amountInCents < 0 || amountInCents > 10000000) throw new ApiError(400,'VALIDATION_ERROR','amountInCents must be between 0 and 10000000');
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
        const record = { id:`tel_${randomUUID()}`, userId, customerName:requireString(body.customerName,'customerName',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), planName:requireString(body.planName,'planName',{maxLength:80}), amountInCents, status:'PENDING_PAYMENT', paymentStatus:'UNPAID', relatedIds:{}, createdAt:now, updatedAt:now };
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
        const paidInCents = Number(body.paidInCents);
        const receiveInCents = Number(body.receiveInCents);
        if (!Number.isInteger(paidInCents) || paidInCents < 1000 || paidInCents > 10000000 || !Number.isInteger(receiveInCents) || receiveInCents <= paidInCents || receiveInCents > 10000000) throw new ApiError(400,'VALIDATION_ERROR','Invalid recharge amount');
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
        const record = { id:`top_${randomUUID()}`, userId, phone:requireString(body.phone,'phone',{maxLength:30}), paidInCents, receiveInCents, status:'PENDING_PAYMENT', paymentStatus:'UNPAID', relatedIds:{}, createdAt:now, updatedAt:now };
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
        if (ownerPhone === companionPhone) throw new ApiError(400,'VALIDATION_ERROR','两个号码不能相同');
        const now = new Date().toISOString();
        const record = { id:`net_${randomUUID()}`, userId, ownerPhone, companionPhone, status:'PENDING_VERIFY', relatedIds:{}, createdAt:now, updatedAt:now };
        store.update(data=>{ (data.broadbandApplications=data.broadbandApplications||[]).unshift(record); addAudit(data,'新增宽带资格申请',record.id); });
        return sendJson(response,201,{data:record,requestId});
      }
      if (request.method === 'POST' && pathname === '/api/plate-applications') {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const customerName = requireString(body.customerName,'customerName',{maxLength:50});
        const customerPhone = requireString(body.customerPhone,'customerPhone',{maxLength:30});
        const vehicleModel = requireString(body.vehicleModel,'vehicleModel',{maxLength:80});
        const now = new Date().toISOString();
        const record = store.update(data=>{
          const order = body.orderId ? (data.orders||[]).find(item=>item.id===body.orderId && item.userId===userId) : null;
          if (body.orderId && !order) throw new ApiError(404,'ORDER_NOT_FOUND','Order not found');
          const platformOrder = order && (data.products||[]).find(product=>product.id===order.items?.[0]?.productId)?.category === 'E_BIKE_NEW';
          const application = { id:`plate_${randomUUID()}`, userId, customerName, phone:customerPhone, vehicleModel, source:platformOrder?'PLATFORM_ORDER':'EXTERNAL', feeInCents:platformOrder?0:((data.adminSettings||{}).externalPlateFeeInCents ?? 4900), relatedOrderId:order?.id || '', status:'MATERIAL_PENDING', relatedIds:order?{ platformOrderIds:[order.id] }:{}, createdAt:now, updatedAt:now };
          (data.plateApplications=data.plateApplications||[]).unshift(application);
          addAudit(data,'新增校园牌照辅助申请',application.id);
          return application;
        });
        return sendJson(response,201,{data:record,requestId});
      }
      const businessMatch = pathname.match(/^\/api\/service-records\/([^/]+)\/actions$/);
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
              const application = { id:`net_${randomUUID().slice(0,8)}`, userId, ownerPhone:item.phone, companionPhone:item.companionPhone || '', relatedOrderId:item.id, status:'PENDING_VERIFY', relatedIds:{ phoneCardOrderId:item.id }, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString() };
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
            else if (order) { order.status = 'COMPLETED'; order.updatedAt = item.updatedAt; }
          }
          const template = notificationTemplates[adminStatusMatch[1]]?.[status];
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
          const item = { id: `prod_${randomUUID()}`, name: requireString(body.name, 'name', { maxLength: 80 }), category: requireString(body.category, 'category', { maxLength: 50 }), description: requireString(body.description, 'description', { maxLength: 300 }), priceInCents, stock, campusIds: ['campus_hzau'], imageUrl: '', active: body.active !== false };
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
          for (const field of ['deliveryResponseHours', 'plateResponseHours', 'afterSaleResponseHours']) {
            if (body[field] !== undefined) {
              const hours = Number(body[field]);
              if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new ApiError(400, 'VALIDATION_ERROR', `${field} 需为 1-168 小时`);
              current[field] = hours;
            }
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
            if (product.stock < quantity) {
              throw new ApiError(409, 'INSUFFICIENT_STOCK', `Insufficient stock for ${product.name}`);
            }
            const subtotalInCents = product.priceInCents * quantity;
            totalInCents += subtotalInCents;
            orderItems.push({ productId, merchantId: product.merchantId || '', name: product.name, priceInCents: product.priceInCents, quantity, subtotalInCents });
          }
          const isDelivery = body.fulfillment?.type === 'DELIVERY';
          if (isDelivery) validateDeliverySchedule(body.fulfillment, settings);
          if (isDelivery) totalInCents += deliveryFeeInCents;
          const now = new Date().toISOString();
          const order = {
            id: `ord_${randomUUID()}`,
            orderNo: `CG${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`,
            userId,
            items: orderItems,
            totalInCents,
            currency: 'CNY',
            status: 'PENDING_PAYMENT',
            paymentStatus: 'UNPAID',
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
          for (const orderItem of linkedOrder.items) {
            const product = (innerData.products || []).find((candidate) => candidate.id === orderItem.productId);
            if (product) product.stock = Math.max(0, Number(product.stock || 0) - Number(orderItem.quantity || 0));
          }
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
          if (!order && !rechargeOrder && !phoneCardOrder) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
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
            order.paymentStatus = 'PAID';
            order.status = 'PAID';
            order.updatedAt = now;
            issueDeliveryCode(order, now);
            for (const orderItem of order.items) {
              const product = data.products.find((candidate) => candidate.id === orderItem.productId);
              if (!product) continue;
              product.stock = Math.max(0, Number(product.stock || 0) - Number(orderItem.quantity || 0));
            }
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
            order.status = 'CANCELLED';
            order.paymentStatus = 'CANCELLED';
            order.updatedAt = now;
            addAudit(data, '\u7528\u6237\u53d6\u6d88\u5f85\u652f\u4ed8', order.orderNo);
            addNotification(data, userId, 'ORDER', '\u8ba2\u5355\u5df2\u53d6\u6d88', `\u8ba2\u5355 ${order.orderNo} \u5df2\u53d6\u6d88\uff0c\u82e5\u9700\u8981\u53ef\u91cd\u65b0\u4e0b\u5355\u3002`);
            return { order, paymentOrder };
          }
          throw new ApiError(403, 'FORBIDDEN', '\u4ec5\u7ba1\u7406\u7aef\u53ef\u9000\u6b3e');
        });
        return sendJson(response, 200, { data: { order: updated.order, rechargeOrder: updated.rechargeOrder, phoneCardOrder: updated.phoneCardOrder, paymentOrder: updated.paymentOrder }, requestId });
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
        const afterSale = store.update((data) => {
          const order = data.orders.find((item) => item.id === orderId && item.userId === userId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (!['PAID', 'FULFILLING', 'COMPLETED'].includes(order.status)) {
            throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', 'Current order status does not support after-sale requests');
          }
          const duplicate = data.afterSales.find((item) => item.orderId === orderId && item.status !== 'CLOSED');
          if (duplicate) throw new ApiError(409, 'ACTIVE_AFTER_SALE_EXISTS', 'An active after-sale request already exists');
          const now = new Date().toISOString();
          const record = {
            id: `as_${randomUUID()}`,
            userId,
            orderId,
            type,
            typeLabel: { REFUND: '申请退款', RETURN: '退货', REPAIR: '维修' }[type] || type,
            reason,
            status: 'SUBMITTED',
            responseDueAt: new Date(new Date(now).getTime() + 24 * 60 * 60 * 1000).toISOString(),
            resolutionDueAt: new Date(new Date(now).getTime() + 72 * 60 * 60 * 1000).toISOString(),
            createdAt: now,
            updatedAt: now
          };
          data.afterSales.push(record);
          order.status = 'AFTER_SALE';
          order.updatedAt = now;
          return record;
        });
        return sendJson(response, 201, { data: afterSale, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/after-sales') {
        const { userId } = requireUser(request);
        const items = store.read().afterSales.filter((item) => item.userId === userId);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
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
}

module.exports = { createApp, ApiError };
