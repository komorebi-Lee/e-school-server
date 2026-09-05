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
const allowedMerchantOrderStatuses = new Set(['PAID', 'FULFILLING', 'COMPLETED', 'CANCELLED']);
const allowedMerchantTypes = new Set(['INDIVIDUAL', 'ENTERPRISE', 'PERSONAL']);
const identityVerifications = new Map();

function isTlsInterceptionError(error) {
  const tlsCodes = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED']);
  return tlsCodes.has(error.code) || /self-signed/i.test(error.message);
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
  const { ownerName, phone, ...safe } = merchant;
  return {
    ...safe,
    merchantType: safe.merchantType || 'INDIVIDUAL',
    ownerNameMasked: ownerName ? `${ownerName.slice(0, 1)}**` : '',
    phoneMasked: phone ? `${phone.slice(0, 3)}****${phone.slice(-4)}` : ''
  };
}

function withMerchantName(product, merchants) {
  return { ...product, merchantName: merchants.find((merchant) => merchant.id === product.merchantId)?.name || '平台自营' };
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
        const { products } = store.read();
        const category = url.searchParams.get('category');
        const campusId = url.searchParams.get('campusId');
        const query = (url.searchParams.get('q') || '').trim().toLowerCase();
        const items = products.filter((product) => product.active)
          .filter((product) => !category || product.category === category)
          .filter((product) => !campusId || product.campusIds.includes(campusId))
          .filter((product) => !query || `${product.name} ${product.description}`.toLowerCase().includes(query));
        return sendJson(response, 200, { data: items.map((product) => withMerchantName(product, store.read().merchants || [])), total: items.length, requestId });
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
            else if (action === 'COMPLETE' && item.status === 'FULFILLING') item.status = 'COMPLETED';
            else if (!['CONTACT','NOTE'].includes(action)) throw new ApiError(409,'ACTION_NOT_ALLOWED','当前状态不支持该商家动作');
          }
          if (role === 'PLATFORM' && action === 'INTERVENE') item.collaboration.intervention = { status:'REQUESTED', note, updatedAt:new Date().toISOString() };
          if (role === 'PLATFORM' && action === 'RESOLVE') item.collaboration.intervention = { status:'RESOLVED', note, updatedAt:new Date().toISOString() };
          if (role === 'USER' && action === 'APPEAL') item.collaboration.intervention = { status:'REQUESTED', note, updatedAt:new Date().toISOString() };
          const eventNote = role === 'MERCHANT' ? (action === 'ACCEPT' ? '商家已确认履约' : action === 'COMPLETE' ? '商家已完成服务' : note) : note;
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
        const orders = data.orders
          .filter((order) => order.items.some((item) => products.some((product) => product.id === item.productId)))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const enrichedOrders = orders.map((order) => ({
          ...order,
          merchantName: merchant.name,
          collaboration: order.collaboration || createCollaboration(order, merchant.id)
        }));
        const revenueInCents = orders.reduce((sum, order) => sum + order.totalInCents, 0);
        return sendJson(response, 200, {
          data: {
            merchant: merchantPublic(merchant),
            metrics: {
              revenueInCents,
              orderCount: orders.length,
              pendingCount: orders.filter((order) => !['COMPLETED', 'CANCELLED', 'AFTER_SALE'].includes(order.status)).length,
              productCount: products.length,
              lowStockCount: products.filter((product) => product.stock < 10).length
            },
            products,
            orders: enrichedOrders
          },
          requestId
        });
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
          item.status = status;
          item.updatedAt = new Date().toISOString();
          appendCollaborationEvent(item, 'MERCHANT', status === 'FULFILLING' ? 'ACCEPT' : 'COMPLETE', status === 'FULFILLING' ? '商家已确认履约' : '商家已完成服务');
          addAudit(data, '商家更新订单状态', item.orderNo);
          return item;
        });
        return sendJson(response, 200, { data: order, requestId });
      }

      if (request.method === 'GET' && pathname === '/api/admin/overview') {
        const data = store.read();
        const leads = data.leads || [];
        const revenueInCents = data.orders.reduce((sum, order) => sum + (order.totalInCents || 0), 0)
          + data.phoneCardOrders.reduce((sum, order) => sum + (order.amountInCents || 0), 0)
          + data.rechargeOrders.reduce((sum, order) => sum + (order.paidInCents || 0), 0)
          + data.plateApplications.reduce((sum, item) => sum + (item.feeInCents || 0), 0);
        const pending = data.orders.filter((item) => !['COMPLETED', 'CANCELLED'].includes(item.status)).length
          + data.phoneCardOrders.filter((item) => item.status !== 'ACTIVATED').length
          + data.rechargeOrders.filter((item) => item.status !== 'CREDITED').length
          + data.broadbandApplications.filter((item) => item.status !== 'APPROVED').length
          + data.plateApplications.filter((item) => item.status !== 'COMPLETED').length;
        return sendJson(response, 200, {
          data: {
            metrics: { revenueInCents, paidOrders: data.orders.length + data.phoneCardOrders.length + data.rechargeOrders.length, pending, lowStock: data.products.filter((item) => item.stock < 10).length, leadsToday: leads.filter(x => x.createdAt.slice(0,10) === new Date().toISOString().slice(0,10)).length, leadsPending: leads.filter(x => openLeadStatuses.has(x.status)).length, leadsOverdue: leads.filter(x => x.slaDueAt < new Date().toISOString() && openLeadStatuses.has(x.status)).length },
            products: data.products,
            merchants: data.merchants,
            orders: data.orders,
            phoneCardOrders: data.phoneCardOrders,
            rechargeOrders: data.rechargeOrders,
            broadbandApplications: data.broadbandApplications,
            plateApplications: data.plateApplications,
            afterSales: data.afterSales,
            settings: data.adminSettings,
            auditLogs: data.auditLogs
            ,leads
          }, requestId
        });
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
        const phoneCardOrders = (data.phoneCardOrders || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.amountInCents || 0, phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const rechargeOrders = (data.rechargeOrders || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents || 0)/100).toFixed(0)}送${((item.receiveInCents || 0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.paidInCents || 0, phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
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
          const phoneCardOrders=(data.phoneCardOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.amountInCents||0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const rechargeOrders=(data.rechargeOrders||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents||0)/100).toFixed(0)}送${((item.receiveInCents||0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.paidInCents||0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const broadbandApplications=(data.broadbandApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'BROADBAND', typeLabel:'宽带', title:'双人购卡宽带', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          const plateApplications=(data.plateApplications||[]).filter(item=>item.userId===userId).map(item=>({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel||'校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status]||item.status, amountInCents:item.feeInCents||0, relatedIds:item.relatedIds||{}, createdAt:item.createdAt, updatedAt:item.updatedAt||item.createdAt }));
          return [...phoneCardOrders,...rechargeOrders,...broadbandApplications,...plateApplications];
        })();
        return sendJson(response,200,{data:{ebikeOrders,serviceRecords},requestId});
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
        const record = { id:`tel_${randomUUID()}`, userId, customerName:requireString(body.customerName,'customerName',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), planName:requireString(body.planName,'planName',{maxLength:80}), amountInCents, status:'PENDING_REALNAME', relatedIds:{}, createdAt:now, updatedAt:now };
        store.update(data=>{ (data.phoneCardOrders=data.phoneCardOrders||[]).unshift(record); (data.rechargeOrders||[]).forEach(item=>{if(item.userId===userId&&item.phone===record.phone&&!item.relatedIds?.phoneCardOrderId)item.relatedIds={...(item.relatedIds||{}),phoneCardOrderId:record.id};}); if(cardIdempotencyKey)data.idempotencyKeys[`card:${userId}:${cardIdempotencyKey}`]=record.id; addAudit(data,'新增电话卡订单',record.id); });
        return sendJson(response,201,{data:record,requestId});
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
        const record = { id:`top_${randomUUID()}`, userId, phone:requireString(body.phone,'phone',{maxLength:30}), paidInCents, receiveInCents, status:'PENDING_CREDIT', relatedIds:{}, createdAt:now, updatedAt:now };
        store.update(data=>{ const related=(data.phoneCardOrders||[]).find(item=>item.userId===userId&&item.phone===record.phone); if(related)record.relatedIds={phoneCardOrderId:related.id}; (data.rechargeOrders=data.rechargeOrders||[]).unshift(record); if(idempotencyKey)data.idempotencyKeys[`recharge:${userId}:${idempotencyKey}`]=record.id; addAudit(data,'新增话费权益订单',record.id); });
        return sendJson(response,201,{data:record,requestId});
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

      const adminStatusMatch = pathname.match(/^\/api\/admin\/(orders|phone-card-orders|recharge-orders|broadband-applications|plate-applications|after-sales)\/([^/]+)\/status$/);
      if (request.method === 'POST' && adminStatusMatch) {
        const body = await readJson(request);
        const status = requireString(body.status, 'status', { maxLength: 50 });
        const collectionMap = { orders: 'orders', 'phone-card-orders': 'phoneCardOrders', 'recharge-orders': 'rechargeOrders', 'broadband-applications': 'broadbandApplications', 'plate-applications': 'plateApplications', 'after-sales': 'afterSales' };
        const updated = store.update((data) => {
          const item = data[collectionMap[adminStatusMatch[1]]].find((record) => record.id === adminStatusMatch[2]);
          if (!item) throw new ApiError(404, 'ADMIN_RECORD_NOT_FOUND', 'Record not found');
          item.status = status; item.updatedAt = new Date().toISOString(); addAudit(data, `更新${adminStatusMatch[1]}状态为${status}`, item.id); return item;
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
          data.adminSettings = current; addAudit(data, '更新系统设置', '运营配置'); return current;
        });
        return sendJson(response, 200, { data: settings, requestId });
      }

      const productMatch = pathname.match(/^\/api\/products\/([^/]+)$/);
      if (request.method === 'GET' && productMatch) {
        const product = store.read().products.find((item) => item.id === productMatch[1] && item.active);
        if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', 'Product not found');
        return sendJson(response, 200, { data: product, requestId });
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
          for (const [productId, quantity] of mergedQuantities) {
            const product = data.products.find((item) => item.id === productId && item.active);
            if (!product) throw new ApiError(404, 'PRODUCT_NOT_FOUND', `Product ${productId} not found`);
            if (product.stock < quantity) {
              throw new ApiError(409, 'INSUFFICIENT_STOCK', `Insufficient stock for ${product.name}`);
            }
            product.stock -= quantity;
            const subtotalInCents = product.priceInCents * quantity;
            totalInCents += subtotalInCents;
            orderItems.push({ productId, merchantId: product.merchantId || '', name: product.name, priceInCents: product.priceInCents, quantity, subtotalInCents });
          }
          const now = new Date().toISOString();
          const order = {
            id: `ord_${randomUUID()}`,
            orderNo: `CG${Date.now()}${Math.floor(Math.random() * 9000 + 1000)}`,
            userId,
            items: orderItems,
            totalInCents,
            currency: 'CNY',
            status: 'PAID',
            paymentStatus: 'MOCK_SUCCESS',
            fulfillment: body.fulfillment || { type: 'PICKUP' },
            createdAt: now,
            updatedAt: now,
            collaboration: createCollaboration({ createdAt: now, status:'PAID' }, orderItems[0]?.merchantId || '')
          };
          data.orders.push(order);
          const bikeItem = order.items.find((item) => (data.products || []).find((product) => product.id === item.productId)?.category === 'E_BIKE_NEW');
          if (bikeItem) {
            const plateApplication = {
              id: `plate_${randomUUID()}`,
              userId,
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
            addAudit(data, '购车订单自动创建免费牌照辅助', order.orderNo);
          }
          if (compoundKey) data.idempotencyKeys[compoundKey] = order.id;
          return { order, reused: false };
        });
        return sendJson(response, result.reused ? 200 : 201, { data: result.order, idempotencyReused: result.reused, requestId });
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

      if (request.method === 'PATCH' && orderMatch) {
        const { userId } = requireUser(request);
        const body = await readJson(request);
        const updated = store.update((data) => {
          const order = data.orders.find((item) => item.id === orderMatch[1] && item.userId === userId);
          if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
          if (['COMPLETED', 'CANCELLED', 'AFTER_SALE'].includes(order.status)) throw new ApiError(409, 'ORDER_STATUS_NOT_ALLOWED', 'Current order cannot be edited');
          if (body.fulfillment && typeof body.fulfillment === 'object') order.fulfillment = { ...order.fulfillment, ...body.fulfillment };
          order.updatedAt = new Date().toISOString();
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
            reason,
            status: 'SUBMITTED',
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
