/**
 * 面向用户端的公开视图投影。
 *
 * 将内部实体裁剪与脱敏为公开字段并附加展示文案；
 * 同时提供商品分类、成色与论坛板块的展示标签映射。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */


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
    // ★ 单笔每商品购买上限（M3-P1-02）。判据与上面的 `leadResponseHours` 同形式：
    // 非整数或越界（1~99）一律回落 5。
    //
    // 这个回落**不是**可有可无的兜底：前端拿到 `undefined` 会算
    // `Math.min(stock, undefined)` → `NaN` → 被 `|| 1` 压成「只能买 1 件」。
    // 宁可下发一个明确的 5，也不要让前端去猜。
    maxOrderQuantityPerItem: Number.isInteger(settings.maxOrderQuantityPerItem) && settings.maxOrderQuantityPerItem >= 1 && settings.maxOrderQuantityPerItem <= 99 ? settings.maxOrderQuantityPerItem : 5,
    settlementPeriodDays: Number.isInteger(settings.settlementPeriodDays) ? settings.settlementPeriodDays : 7,
    deliveryTimeSlots: Array.isArray(settings.deliveryTimeSlots) && settings.deliveryTimeSlots.length ? settings.deliveryTimeSlots : ['尽快配送'],
    platformNotice: settings.platformNotice || '服务范围和办理结果以学校及合作方最终确认为准。'
  };
}

function sanitizeOrderForMerchant(order) {
  const { deliveryCode, deliveryCodeIssuedAt, ...safe } = order;
  return safe;
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

const marketCategoryLabels = {
  BOOK: '二手书',
  DAILY: '生活用品',
  ELECTRONICS: '数码',
  SPORTS: '运动装备',
  OTHER: '其他'
};

const marketConditionLabels = {
  LIKE_NEW: '九成新',
  GOOD: '七成新',
  USED: '有使用痕迹'
};

const forumBoardLabels = {
  CAMPUS: '校园生活',
  SECONDHAND: '二手交流',
  LOST_FOUND: '失物招领',
  STUDY: '学习互助',
  RIDES: '拼车顺风'
};

/**
 * 闲置状态 → 用户可见文案（M6-P1-01）。
 *
 * 之前这里是一串嵌套三元，**没有 `DELETED` 分支**，于是未知状态会掉进兜底的
 * 「在售」—— 卖家删掉自己的闲置后，列表里那一条会显示成「在售」，
 * 向用户断言了一个假事实。改成显式映射：新增状态时漏写会显示兜底文案，
 * 而不是被误标成在售。
 *
 * `DELETED` = 卖家软删除（本人可在「我发布的闲置」看到）；
 * `REMOVED` = 平台违规下架（卖家自己也不能改回来，见 `MARKET_ITEM_REMOVED`）。
 */
const marketItemStatusLabels = {
  ACTIVE: '在售',
  RESERVED: '已预留',
  SOLD: '已出',
  DELETED: '已删除',
  REMOVED: '已下架'
};

/**
 * 对**公众**可见的闲置状态。
 *
 * 主列表按 `ACTIVE` 过滤；详情端点用这个集合 —— 详情此前没有任何状态过滤，
 * 拿到 id 就能直接打开，`contact`（卖家的手机号 / 微信号）会照常返回。
 * 平台下架是因为违规，内容与联系方式都不该继续可达。
 */
const MARKET_ITEM_PUBLIC_STATUSES = ['ACTIVE', 'RESERVED', 'SOLD'];

function publicMarketItem(item) {
  const price = Math.round((Number(item.priceInCents) || 0) / 100);
  return {
    id: item.id,
    sellerName: item.sellerName || '狮山同学',
    title: item.title,
    description: item.description || '',
    category: item.category,
    categoryText: marketCategoryLabels[item.category] || '其他',
    condition: item.condition,
    conditionText: marketConditionLabels[item.condition] || '七成新',
    price,
    priceText: `¥${price.toFixed(2)}`,
    images: Array.isArray(item.images) ? item.images.slice(0, 6) : [],
    contact: item.contact || '通过平台客服联系',
    status: item.status,
    // ★ 走显式映射表，不再用嵌套三元。旧写法没有 `DELETED` 分支，
    // 卖家删除后列表里会显示成「在售」—— 那是在向用户断言一个假事实。
    statusText: marketItemStatusLabels[item.status] || '在售',
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function publicForumComment(comment) {
  return {
    id: comment.id,
    authorName: comment.authorName || '狮山同学',
    content: comment.content || '',
    createdAt: comment.createdAt
  };
}

function publicForumPost(post, viewerId) {
  return {
    id: post.id,
    authorName: post.authorName || '狮山同学',
    board: post.board,
    boardText: forumBoardLabels[post.board] || '校园生活',
    title: post.title,
    content: post.content || '',
    images: Array.isArray(post.images) ? post.images.slice(0, 3) : [],
    likes: (post.likedBy || []).length,
    liked: viewerId ? (post.likedBy || []).includes(viewerId) : false,
    // 是否为当前浏览者的帖子（M7-P1-01 作者自管理）。
    // 前端据此决定要不要显示「隐藏 / 恢复」——**服务端才是真正的防线**，
    // 这个字段只负责界面，不能当作权限判据（状态端点是独立校验作者的）。
    isOwner: Boolean(viewerId && post.authorId === viewerId),
    comments: (post.comments || []).map(publicForumComment),
    commentCount: (post.comments || []).length,
    status: post.status,
    createdAt: post.createdAt
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

module.exports = { publicSettings, sanitizeOrderForMerchant, publicApplication, merchantPublic, withMerchantName, marketCategoryLabels, marketConditionLabels, marketItemStatusLabels, MARKET_ITEM_PUBLIC_STATUSES, forumBoardLabels, publicMarketItem, publicForumComment, publicForumPost, publicStorefrontReviews, publicAdminUser };
