/**
 * 库存与商品可售量域。
 *
 * 负责「可售库存」计算、低库存提醒、库存流水记录，以及订单维度的
 * 预占 / 释放 / 扣减 / 回补四类库存流转。所有函数均为纯数据操作，
 * 直接读写传入的 data / product / order 对象，不做持久化。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { randomUUID } = require('node:crypto');

// 可售库存 = 实际库存 - 待支付订单占用的库存，避免同一批车被重复卖出。
function availableStock(product) {
  return Math.max(0, Number(product?.stock || 0) - Number(product?.reservedStock || 0));
}

function withAvailableStock(product) {
  return { ...product, reservedStock: Number(product.reservedStock || 0), availableStock: availableStock(product) };
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
  const restoredByProduct = order.stockRestoredByProduct || {};
  const affectedProducts = [];
  for (const orderItem of order.items || []) {
    const outstandingQuantity = Math.max(0, Number(orderItem.quantity || 0) - Number(restoredByProduct[orderItem.productId] || 0));
    if (outstandingQuantity <= 0) continue;
    const product = (data.products || []).find((candidate) => candidate.id === orderItem.productId);
    if (product) {
      const stockBefore = Number(product.stock || 0);
      product.stock = Number(product.stock || 0) + outstandingQuantity;
      recordStockMovement(data, product, {
        movementType: 'RESTORE',
        quantity: outstandingQuantity,
        stockBefore,
        stockAfter: Number(product.stock || 0),
        reservedBefore: Number(product.reservedStock || 0),
        reservedAfter: Number(product.reservedStock || 0),
        referenceId: order.id,
        referenceNo: order.orderNo,
        operator: 'ORDER_FLOW',
        note: '退款/退货回补库存'
      });
      restoredByProduct[orderItem.productId] = Number(orderItem.quantity || 0);
      affectedProducts.push(product);
    }
  }
  order.stockRestoredByProduct = restoredByProduct;
  order.stockReservation = 'RESTORED';
  affectedProducts.forEach((product) => evaluateLowStockAlert(data, product, new Date().toISOString()));
  return true;
}

function restoreOrderStockQuantity(data, order, refundItems = []) {
  const restoredByProduct = order.stockRestoredByProduct || {};
  const affectedProducts = [];
  for (const refundItem of refundItems) {
    const quantity = Math.max(0, Number(refundItem.quantity || 0));
    if (!quantity) continue;
    const product = (data.products || []).find((candidate) => candidate.id === refundItem.productId);
    if (!product) continue;
    const orderQuantity = Math.max(0, Number((order.items || []).find((item) => item.productId === refundItem.productId)?.quantity || 0));
    const stockBefore = Number(product.stock || 0);
    product.stock = Number(product.stock || 0) + quantity;
    restoredByProduct[refundItem.productId] = Math.min(orderQuantity, Number(restoredByProduct[refundItem.productId] || 0) + quantity);
    recordStockMovement(data, product, {
      movementType: 'RESTORE',
      quantity,
      stockBefore,
      stockAfter: Number(product.stock || 0),
      reservedBefore: Number(product.reservedStock || 0),
      reservedAfter: Number(product.reservedStock || 0),
      referenceId: order.id,
      referenceNo: order.orderNo,
      operator: 'ORDER_FLOW',
      note: '部分售后按数量回补库存'
    });
    affectedProducts.push(product);
  }
  order.stockRestoredByProduct = restoredByProduct;
  affectedProducts.forEach((product) => evaluateLowStockAlert(data, product, new Date().toISOString()));
  return Boolean(affectedProducts.length);
}

module.exports = {
  availableStock,
  withAvailableStock,
  lowStockThreshold,
  evaluateLowStockAlert,
  recordStockMovement,
  reserveOrderStock,
  releaseOrderStock,
  consumeOrderStock,
  restoreOrderStock,
  restoreOrderStockQuantity
};
