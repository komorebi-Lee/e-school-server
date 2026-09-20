/**
 * 商品目录域：评价摘要、销量统计、店铺档案与促销活动。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { ApiError } = require('../http/api-error');

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

/**
 * 商品形态与租赁方案。
 *
 * 售卖 / 租赁用 `listingType` 区分，而不是新增 category：`E_BIKE_NEW` 被首页、
 * 列表页、管理端分类下拉以及免费牌照辅助等 20+ 处当作「电瓶车品类」使用，
 * 新增 category 会让租赁车从所有既有入口消失。
 */

const RENTAL_UNITS = ['DAY', 'HOUR'];
const LISTING_TYPES = ['SALE', 'RENT'];

/**
 * 校验并规范化租赁方案。
 *
 * @param {unknown} value 原始 rentalPlan；空值表示「非租赁商品」。
 * @returns {{unit: string, unitPriceInCents: number, minUnits: number, maxUnits: number, depositInCents: number}|null}
 *          规范化后的方案；传入空值时返回 null。
 * @throws {ApiError} 400 VALIDATION_ERROR —— 结构或数值非法。
 */
function normalizeRentalPlan(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalPlan 必须是对象');
  }
  const unit = typeof value.unit === 'string' ? value.unit.trim().toUpperCase() : '';
  if (!RENTAL_UNITS.includes(unit)) {
    throw new ApiError(400, 'VALIDATION_ERROR', `rentalPlan.unit 仅支持 ${RENTAL_UNITS.join(' / ')}`);
  }
  const unitPriceInCents = Number(value.unitPriceInCents);
  if (!Number.isInteger(unitPriceInCents) || unitPriceInCents <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalPlan.unitPriceInCents 必须是大于 0 的整数分');
  }
  const minUnits = Number(value.minUnits);
  if (!Number.isInteger(minUnits) || minUnits <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalPlan.minUnits 必须是大于 0 的整数');
  }
  const maxUnits = Number(value.maxUnits);
  if (!Number.isInteger(maxUnits) || maxUnits <= 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalPlan.maxUnits 必须是大于 0 的整数');
  }
  if (maxUnits < minUnits) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalPlan.maxUnits 不能小于 minUnits');
  }
  const depositInCents = Number(value.depositInCents);
  if (!Number.isInteger(depositInCents) || depositInCents < 0) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'rentalPlan.depositInCents 必须是非负整数分');
  }
  // 字段顺序固定，保证响应体与落库 JSON 稳定，便于快照比对。
  return { unit, unitPriceInCents, minUnits, maxUnits, depositInCents };
}

/**
 * 为商品补上 `listingType`（及租赁商品的规范化 `rentalPlan`）。
 *
 * 存量商品没有 `listingType` 字段，统一按 `'SALE'` 输出，保证前端只认一种形态。
 * 非租赁商品不输出 `rentalPlan` 字段（而不是输出 null），避免前端误判。
 *
 * @param {object} product 商品记录。
 * @returns {object} 带 `listingType` 的商品对象。
 */
function withListingType(product) {
  const source = product || {};
  if (source.listingType === 'RENT') {
    try {
      const rentalPlan = normalizeRentalPlan(source.rentalPlan);
      if (rentalPlan) return { ...source, listingType: 'RENT', rentalPlan };
    } catch (error) {
      // 读取路径不允许因单条脏数据把整个商品列表打成 400，降级为售卖形态。
    }
  }
  const { rentalPlan, ...rest } = source;
  return { ...rest, listingType: 'SALE' };
}

module.exports = { withProductReviewSummary, productSalesCount, productStoreProfile, rechargePromoAvailability, publicRechargePromo, normalizeProductSaleCampaign, withProductSale, productPromotionOrderMetrics, normalizeRentalPlan, withListingType, LISTING_TYPES, RENTAL_UNITS };
