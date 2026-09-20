/**
 * 履约协同域：订单与服务记录的协同事件、留言与责任归属。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { ApiError } = require('../http/api-error');

function userNotificationLink(notification, data = null) {
  const metadata = notification?.metadata || {};
  if (metadata.focusId) {
    const recordType = metadata.recordType ? `&recordType=${encodeURIComponent(String(metadata.recordType))}` : '';
    return `/pages/orders/orders?focusId=${encodeURIComponent(String(metadata.focusId))}${recordType}`;
  }
  if (metadata.productId) {
    return `/pages/detail/detail?id=${encodeURIComponent(String(metadata.productId))}`;
  }
  if (data && metadata.reviewId) {
    const review = (data.productReviews || []).find((item) => item.id === metadata.reviewId);
    if (review) return `/pages/orders/orders?focusId=${encodeURIComponent(String(review.orderId))}`;
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
  if (role === 'USER' && action === 'NOTE') {
    order.collaboration.unrepliedMessage = { text: note, createdAt: time };
  } else if (['MERCHANT', 'PLATFORM'].includes(role) && order.collaboration.unrepliedMessage) {
    order.collaboration.unrepliedMessage = null;
  }
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

function complaintDueAt(now) {
  return new Date(new Date(now).getTime() + 48 * 3600 * 1000).toISOString();
}

module.exports = { userNotificationLink, leadSourceRecord, createCollaboration, appendCollaborationEvent, serviceRecordOwner, complaintDueAt };
