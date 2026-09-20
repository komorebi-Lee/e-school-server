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

module.exports = { withProductReviewSummary, productSalesCount, productStoreProfile, rechargePromoAvailability, publicRechargePromo, normalizeProductSaleCampaign, withProductSale, productPromotionOrderMetrics };
