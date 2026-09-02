const { randomUUID } = require('node:crypto');
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
    if (size > 1024 * 1024) throw new ApiError(413, 'PAYLOAD_TOO_LARGE', 'Request body exceeds 1 MB');
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

function createApp({ store }) {
  const adminSessions = new Map();
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
        if (body.username !== 'admin' || body.password !== 'Shishan@2026') throw new ApiError(401, 'INVALID_CREDENTIALS', '账号或密码错误');
        const token = randomUUID();
        adminSessions.set(token, { username: 'admin', expiresAt: Date.now() + 8 * 60 * 60 * 1000 });
        return sendJson(response, 200, { data: { token, user: { name: '运营管理员', role: '超级管理员' }, expiresIn: 28800 }, requestId });
      }

      if (pathname.startsWith('/api/admin/')) {
        const token = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
        const session = adminSessions.get(token);
        if (!session || session.expiresAt < Date.now()) throw new ApiError(401, 'ADMIN_UNAUTHORIZED', '请重新登录管理端');
      }

      if (request.method === 'GET' && pathname === '/health') {
        return sendJson(response, 200, { ok: true, service: 'campus-go-mock-api', requestId });
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
        return sendJson(response, 200, { data: items, total: items.length, requestId });
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
        const body = await readJson(request);
        const now = new Date();
        const lead = { id:`lead_${randomUUID()}`, leadNo:`LS${Date.now().toString().slice(-8)}`, userId:requireString(body.userId || 'guest','userId',{maxLength:64}), name:requireString(body.name,'name',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), businessType:requireString(body.businessType,'businessType',{maxLength:40}), interest:requireString(body.interest || '未指定','interest',{maxLength:120}), expectedTime:(body.expectedTime||'尽快').toString().slice(0,40), deliveryNeed:(body.deliveryNeed||'无').toString().slice(0,120), note:(body.note||'').toString().slice(0,500), status:'SUBMITTED', assignee:'', followUps:[], createdAt:now.toISOString(), updatedAt:now.toISOString(), slaDueAt:new Date(now.getTime()+24*3600*1000).toISOString() };
        store.update(data => { if (!Array.isArray(data.leads)) data.leads=[]; data.leads.unshift(lead); addAudit(data,'新增咨询线索',lead.leadNo); });
        return sendJson(response,201,{data:lead,requestId});
      }
      if (request.method === 'GET' && pathname === '/api/service-records') {
        const userId = requireString(url.searchParams.get('userId'), 'userId');
        const data = store.read();
        const phoneCardOrders = (data.phoneCardOrders || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'PHONE_PLAN', typeLabel:'电话卡', title:item.planName, status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.amountInCents || 0, phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const rechargeOrders = (data.rechargeOrders || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'RECHARGE', typeLabel:'话费权益', title:`充${((item.paidInCents || 0)/100).toFixed(0)}送${((item.receiveInCents || 0)/100).toFixed(0)}`, status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.paidInCents || 0, phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const broadbandApplications = (data.broadbandApplications || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'BROADBAND', typeLabel:'宽带', title:'双人购卡宽带', status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:0, phone:item.ownerPhone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const plateApplications = (data.plateApplications || []).filter(item => item.userId === userId).map(item => ({ id:item.id, recordNo:item.id, type:'PLATE', typeLabel:'校园牌照', title:item.vehicleModel || '校园牌照辅助', status:item.status, statusLabel:statusLabels[item.status] || item.status, amountInCents:item.feeInCents || 0, phone:item.phone, relatedIds:item.relatedIds || {}, createdAt:item.createdAt, updatedAt:item.updatedAt || item.createdAt }));
        const items = [...phoneCardOrders, ...rechargeOrders, ...broadbandApplications, ...plateApplications].sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
        return sendJson(response,200,{data:items,total:items.length,requestId});
      }
      if (request.method === 'GET' && pathname === '/api/my/orders') {
        const userId = requireString(url.searchParams.get('userId'), 'userId');
        const data = store.read();
        const ebikeOrders = (data.orders || []).filter(item => item.userId === userId).map(order => ({ ...order, plateApplicationId:((data.plateApplications||[]).find(plate=>(plate.relatedIds?.platformOrderIds||[]).includes(order.id))||{}).id || '' }));
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
        const body = await readJson(request);
        const ownerUserId = requireString(body.userId,'userId',{maxLength:64});
        const amountInCents = Number(body.amountInCents);
        if (!Number.isInteger(amountInCents) || amountInCents < 0 || amountInCents > 10000000) throw new ApiError(400,'VALIDATION_ERROR','amountInCents must be between 0 and 10000000');
        const now = new Date().toISOString();
        const record = { id:`tel_${randomUUID()}`, userId:ownerUserId, customerName:requireString(body.customerName,'customerName',{maxLength:50}), phone:requireString(body.phone,'phone',{maxLength:30}), planName:requireString(body.planName,'planName',{maxLength:80}), amountInCents, status:'PENDING_REALNAME', relatedIds:{}, createdAt:now, updatedAt:now };
        store.update(data=>{ (data.phoneCardOrders=data.phoneCardOrders||[]).unshift(record); (data.rechargeOrders||[]).forEach(item=>{if(item.userId===ownerUserId&&item.phone===record.phone&&!item.relatedIds?.phoneCardOrderId)item.relatedIds={...(item.relatedIds||{}),phoneCardOrderId:record.id};}); addAudit(data,'新增电话卡订单',record.id); });
        return sendJson(response,201,{data:record,requestId});
      }
      if (request.method === 'POST' && pathname === '/api/recharge-orders') {
        const body = await readJson(request);
        const ownerUserId = requireString(body.userId,'userId',{maxLength:64});
        const paidInCents = Number(body.paidInCents);
        const receiveInCents = Number(body.receiveInCents);
        if (!Number.isInteger(paidInCents) || paidInCents < 1000 || paidInCents > 10000000 || !Number.isInteger(receiveInCents) || receiveInCents <= paidInCents || receiveInCents > 10000000) throw new ApiError(400,'VALIDATION_ERROR','Invalid recharge amount');
        const now = new Date().toISOString();
        const record = { id:`top_${randomUUID()}`, userId:ownerUserId, phone:requireString(body.phone,'phone',{maxLength:30}), paidInCents, receiveInCents, status:'PENDING_CREDIT', relatedIds:{}, createdAt:now, updatedAt:now };
        store.update(data=>{ const related=(data.phoneCardOrders||[]).find(item=>item.userId===ownerUserId&&item.phone===record.phone); if(related)record.relatedIds={phoneCardOrderId:related.id}; (data.rechargeOrders=data.rechargeOrders||[]).unshift(record); addAudit(data,'新增话费权益订单',record.id); });
        return sendJson(response,201,{data:record,requestId});
      }
      if (request.method === 'POST' && pathname === '/api/broadband-applications') {
        const body = await readJson(request);
        const ownerPhone = requireString(body.ownerPhone,'ownerPhone',{maxLength:30});
        const companionPhone = requireString(body.companionPhone,'companionPhone',{maxLength:30});
        if (ownerPhone === companionPhone) throw new ApiError(400,'VALIDATION_ERROR','两个号码不能相同');
        const now = new Date().toISOString();
        const record = { id:`net_${randomUUID()}`, userId:requireString(body.userId,'userId',{maxLength:64}), ownerPhone, companionPhone, status:'PENDING_VERIFY', relatedIds:{}, createdAt:now, updatedAt:now };
        store.update(data=>{ (data.broadbandApplications=data.broadbandApplications||[]).unshift(record); addAudit(data,'新增宽带资格申请',record.id); });
        return sendJson(response,201,{data:record,requestId});
      }
      if (request.method === 'POST' && pathname === '/api/plate-applications') {
        const body = await readJson(request);
        const userId = requireString(body.userId,'userId',{maxLength:64});
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
        const body = await readJson(request);
        const userId = requireString(body.userId, 'userId', { maxLength:64 });
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
          userId: requireString(body.userId, 'userId', { maxLength: 64 }),
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
        const userId = requireString(url.searchParams.get('userId'), 'userId');
        const items = store.read().campusCardApplications
          .filter((item) => item.userId === userId)
          .map(publicApplication);
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      if (request.method === 'POST' && pathname === '/api/orders') {
        const body = await readJson(request);
        const userId = requireString(body.userId, 'userId', { maxLength: 64 });
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
            orderItems.push({ productId, name: product.name, priceInCents: product.priceInCents, quantity, subtotalInCents });
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
            updatedAt: now
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
        const userId = requireString(url.searchParams.get('userId'), 'userId');
        const items = store.read().orders
          .filter((order) => order.userId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        return sendJson(response, 200, { data: items, total: items.length, requestId });
      }

      const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (request.method === 'GET' && orderMatch) {
        const userId = requireString(url.searchParams.get('userId'), 'userId');
        const order = store.read().orders.find((item) => item.id === orderMatch[1] && item.userId === userId);
        if (!order) throw new ApiError(404, 'ORDER_NOT_FOUND', 'Order not found');
        return sendJson(response, 200, { data: order, requestId });
      }

      if (request.method === 'PATCH' && orderMatch) {
        const body = await readJson(request);
        const userId = requireString(body.userId, 'userId');
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
        const body = await readJson(request);
        const userId = requireString(body.userId, 'userId', { maxLength: 64 });
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
        const userId = requireString(url.searchParams.get('userId'), 'userId');
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
