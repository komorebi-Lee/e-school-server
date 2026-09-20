const fs = require('node:fs');
const path = require('node:path');

const seedProducts = [
  {
    id: 'prod_ebike_001',
    name: '轻风 通勤版',
    category: 'E_BIKE_NEW',
    description: '45km参考续航，支持校内配送和购车免费牌照辅助。',
    priceInCents: 239900,
    stock: 8,
    campusIds: ['campus_demo'],
    imageUrl: 'https://placehold.co/600x400?text=E-Bike',
    merchantId: 'merchant_001',
    active: true
  },
  {
    id: 'prod_ebike_rent_001',
    name: '远途 长续航版',
    category: 'E_BIKE_NEW',
    description: '70km参考续航，支持在线支付、校内配送和牌照辅助。',
    priceInCents: 319900,
    stock: 5,
    campusIds: ['campus_demo'],
    imageUrl: 'https://placehold.co/600x400?text=Rental',
    merchantId: 'merchant_001',
    active: true,
    // 租赁形态：不新增 category，改用 listingType 区分售卖 / 租赁。
    listingType: 'RENT',
    rentalPlan: {
      unit: 'DAY',
      unitPriceInCents: 1500,
      minUnits: 1,
      maxUnits: 30,
      depositInCents: 29900
    }
  },
  {
    id: 'prod_card_service_001',
    name: '校园畅享卡',
    category: 'PHONE_PLAN',
    description: '80GB校园流量 · 100分钟通话 · 学生常选',
    voice: '100分钟通话',
    priceInCents: 2900,
    stock: 999,
    campusIds: ['campus_demo'],
    imageUrl: 'https://placehold.co/600x400?text=Campus+Card',
    active: true
  },
  {
    id: 'prod_card_service_002',
    name: '校园畅联卡',
    category: 'PHONE_PLAN',
    description: '120GB校园流量 · 200分钟通话 · 宿舍常用',
    voice: '200分钟通话',
    priceInCents: 3900,
    stock: 999,
    campusIds: ['campus_demo'],
    imageUrl: 'https://placehold.co/600x400?text=Campus+Card+Pro',
    active: true
  },
  {
    id: 'prod_card_service_003',
    name: '校园畅学卡',
    category: 'PHONE_PLAN',
    description: '180GB校园流量 · 300分钟通话 · 实习通勤推荐',
    voice: '300分钟通话',
    priceInCents: 5900,
    stock: 999,
    campusIds: ['campus_demo'],
    imageUrl: 'https://placehold.co/600x400?text=Campus+Card+Max',
    active: true
  }
];

const seedRechargePromos = [
  { id: 'promo_recharge_100', pay: 100, receive: 150, badge: '多得50元', active: true },
  { id: 'promo_recharge_150', pay: 150, receive: 200, badge: '多得50元', active: true },
  { id: 'promo_recharge_200_old', pay: 200, receive: 300, badge: '多得100元', active: true },
  { id: 'promo_recharge_200', pay: 200, receive: 250, badge: '多得50元', active: true }
];

const seedMerchants = [
  {
    id: 'merchant_001',
    userId: 'wx_merchant_demo',
    merchantType: 'INDIVIDUAL',
    name: '狮山校园车行',
    ownerName: '范毅',
    phone: '15527111396',
    licenseNo: 'DEMO_LICENSE_001',
    category: 'E_BIKE',
    serviceArea: '华中农业大学狮山校区',
    reviewNote: '',
    status: 'APPROVED',
    settlementAccountName: '狮山校园车行',
    settlementAccount: '6222 0000 0000 0000',
    settlementBank: '校园演示银行',
    createdAt: '2026-08-28T06:00:00.000Z',
    updatedAt: '2026-08-28T06:00:00.000Z'
  },
  {
    id: 'merchant_002',
    merchantType: 'INDIVIDUAL',
    name: '狮山数码驿站',
    ownerName: '李强',
    phone: '15527110002',
    licenseNo: 'DEMO_LICENSE_002',
    category: 'DIGITAL',
    serviceArea: '华中农业大学狮山校区',
    reviewNote: '',
    status: 'REVIEWING',
    createdAt: '2026-08-31T09:00:00.000Z',
    updatedAt: '2026-08-31T09:00:00.000Z'
  }
];

const seedProductReviews = [
  {
    id: 'review_1001',
    productId: 'prod_ebike_001',
    rating: 5,
    content: '中午下单，下午送到宿舍楼下，师傅还讲了校园上牌需要准备的材料，很省心。',
    customerName: '陈同学',
    college: '园艺林学学院',
    purchaseVerified: true,
    images: ['https://placehold.co/240x180?text=Campus+Ride'],
    reply: {
      merchantName: '狮山校园车行',
      content: '感谢同学反馈，后续有车况问题可随时在订单里联系商家。',
      repliedAt: '2026-09-01T19:00:00.000Z'
    },
    createdAt: '2026-09-01T10:20:00.000Z'
  },
  {
    id: 'review_1002',
    productId: 'prod_ebike_001',
    rating: 4,
    content: '车况不错，通勤去教学楼很方便。要是能多几个颜色选择就更好了。',
    customerName: '刘同学',
    college: '经济管理学院',
    purchaseVerified: true,
    images: [],
    reply: null,
    createdAt: '2026-09-03T15:05:00.000Z'
  }
];

const seedMarketItems = [
  {
    id: 'market_seed_1',
    sellerId: 'seed_user_1',
    sellerName: '刘同学',
    title: '高等数学教材（第七版）上下册',
    description: '大四学长毕业出，笔记很少，九成新，可狮山校区内自提。',
    category: 'BOOK',
    condition: 'LIKE_NEW',
    priceInCents: 1500,
    images: [],
    contact: '微信 shishan-study',
    status: 'ACTIVE',
    createdAt: '2026-09-10T10:00:00.000Z',
    updatedAt: '2026-09-10T10:00:00.000Z'
  },
  {
    id: 'market_seed_2',
    sellerId: 'seed_user_2',
    sellerName: '张同学',
    title: '宿舍学习台灯（可调亮度）',
    description: '用了半年，功能完好，毕业清仓，荟园自提。',
    category: 'DAILY',
    condition: 'GOOD',
    priceInCents: 2900,
    images: [],
    contact: '电话 156****8812',
    status: 'ACTIVE',
    createdAt: '2026-09-11T09:00:00.000Z',
    updatedAt: '2026-09-11T09:00:00.000Z'
  },
  {
    id: 'market_seed_3',
    sellerId: 'seed_user_3',
    sellerName: '王同学',
    title: 'CET-4/6 真题试卷全套',
    description: '2024 版带解析，做完一半，低价转给需要的同学。',
    category: 'BOOK',
    condition: 'USED',
    priceInCents: 800,
    images: [],
    contact: '微信 wang-cet',
    status: 'ACTIVE',
    createdAt: '2026-09-12T08:30:00.000Z',
    updatedAt: '2026-09-12T08:30:00.000Z'
  },
  {
    id: 'market_seed_4',
    sellerId: 'seed_user_4',
    sellerName: '陈同学',
    title: '室外篮球（附赠球袋）',
    description: '水泥地专用，买来打过几次，气足，已出。',
    category: 'SPORTS',
    condition: 'GOOD',
    priceInCents: 4500,
    images: [],
    contact: '微信 chen-ball',
    status: 'SOLD',
    createdAt: '2026-09-09T14:00:00.000Z',
    updatedAt: '2026-09-12T18:00:00.000Z'
  }
];

const seedForumPosts = [
  {
    id: 'post_seed_1',
    authorId: 'seed_user_1',
    authorName: '刘同学',
    board: 'STUDY',
    title: '考研自习占座攻略（狮子山校区）',
    content: '图书馆三楼靠窗位置早上 7 点前基本有空位，行政楼自习室周末人少。分享给大家，祝上岸。',
    images: [],
    likedBy: ['seed_user_2'],
    comments: [
      { id: 'cmt_seed_1', authorId: 'seed_user_2', authorName: '张同学', content: '感谢整理，周末就去！', createdAt: '2026-09-11T12:00:00.000Z' }
    ],
    status: 'PUBLISHED',
    createdAt: '2026-09-11T08:00:00.000Z',
    updatedAt: '2026-09-11T08:00:00.000Z'
  },
  {
    id: 'post_seed_2',
    authorId: 'seed_user_2',
    authorName: '张同学',
    board: 'SECONDHAND',
    title: '毕业跳蚤市集本周六荟园广场开市',
    content: '本周六上午 9 点开市，学长学姐出清生活用品和书籍，欢迎来淘。',
    images: [],
    likedBy: ['seed_user_3', 'seed_user_4'],
    comments: [],
    status: 'PUBLISHED',
    createdAt: '2026-09-12T10:30:00.000Z',
    updatedAt: '2026-09-12T10:30:00.000Z'
  },
  {
    id: 'post_seed_3',
    authorId: 'seed_user_4',
    authorName: '陈同学',
    board: 'LOST_FOUND',
    title: '拾到一张校园卡（名字被磨掉了）',
    content: '在东体操场看台捡到一张校园卡，失主带学生证来认领，或联系平台客服转交。',
    images: [],
    likedBy: [],
    comments: [
      { id: 'cmt_seed_2', authorId: 'seed_user_1', authorName: '刘同学', content: '已转发到班群，帮失主留意。', createdAt: '2026-09-13T09:00:00.000Z' }
    ],
    status: 'PUBLISHED',
    createdAt: '2026-09-13T08:20:00.000Z',
    updatedAt: '2026-09-13T08:20:00.000Z'
  }
];

function initialData() {
  return {
    schemaVersion: 1,
    products: seedProducts,
    merchants: seedMerchants,
    campusCardApplications: [],
    orders: [],
    paymentOrders: [],
    settlements: [],
    payoutRequests: [],
    financeEvents: [],
    paymentReconciliations: [],
    financeTasks: [],
    userOpenIds: {},
    adminUsers: [],
    adminSessions: [],
    adminLoginFailures: [],
    notifications: [],
    slaAlerts: [],
    patrolState: { lastRunAt: '', runCount: 0, lastCreated: 0, lastResolved: 0, lastOpen: 0 },
    merchantScoreLogs: [],
    merchantScoreSnapshots: [],
    serviceRiskFollowUps: [],
    settingChangeLogs: [],
    afterSales: [],
    productReviews: seedProductReviews,
    rechargePromos: seedRechargePromos,
    leads: [],
    addresses: [],
    productRestockAlerts: [],
    productFavorites: [],
    uploadRecords: [],
    rentalDeposits: [],
    marketItems: seedMarketItems,
    forumPosts: seedForumPosts,
    phoneCardOrders: [
      { id: 'tel_1001', customerName: '张同学', phone: '138****3201', planName: '校园畅享卡', amountInCents: 2900, status: 'PENDING_REALNAME', createdAt: '2026-08-28T08:20:00.000Z' },
      { id: 'tel_1002', customerName: '李同学', phone: '156****7812', planName: '校园畅联卡', amountInCents: 3900, status: 'ACTIVATED', createdAt: '2026-08-28T07:10:00.000Z' }
    ],
    rechargeOrders: [
      { id: 'top_1001', phone: '138****3201', paidInCents: 15000, receiveInCents: 20000, status: 'PENDING_CREDIT', createdAt: '2026-08-28T09:00:00.000Z' }
    ],
    broadbandApplications: [
      { id: 'net_1001', ownerPhone: '138****3201', companionPhone: '156****7812', status: 'PENDING_VERIFY', createdAt: '2026-08-28T09:15:00.000Z' }
    ],
    plateApplications: [
      { id: 'plate_1001', customerName: '王同学', vehicleModel: '轻风 通勤版', source: 'PLATFORM_ORDER', feeInCents: 0, status: 'MATERIAL_PENDING', createdAt: '2026-08-28T08:45:00.000Z' },
      { id: 'plate_1002', customerName: '周同学', vehicleModel: '自带车辆', source: 'EXTERNAL', feeInCents: 4900, status: 'REVIEWING', createdAt: '2026-08-28T06:40:00.000Z' }
    ],
    adminSettings: {
      brandName: '狮山智生活',
      schoolName: '华中农业大学',
      campusName: '狮山校区',
      servicePhone: '15527111396',
      serviceWechat: '15527111396',
      externalPlateFeeInCents: 4900,
      commissionRatePercent: 2,
      deliveryFeeInCents: 0,
      deliveryResponseHours: 24,
      plateResponseHours: 48,
      afterSaleResponseHours: 24,
      afterSaleResolutionHours: 72,
      phoneCardActivationHours: 24,
      rechargeCreditHours: 12,
      broadbandVerifyHours: 48,
      payoutReviewHours: 48,
      leadResponseHours: 24,
      reviewReplyHours: 24,
      financeTaskResponseHours: 24,
      patrolIntervalMinutes: 10,
      lowStockThreshold: 10,
      uploadRateLimitPer24h: 30,
      serviceScoreLimitedThreshold: 80,
      serviceScoreRestrictedThreshold: 60,
      paymentTimeoutMinutes: 30,
      settlementPeriodDays: 7,
      payoutMinimumInCents: 10000,
      deliveryTimeSlots: ['今天 12:00-14:00', '今天 16:00-18:00', '明天 10:00-12:00'],
      platformNotice: '服务范围和办理结果以学校及合作方最终确认为准。'
    },
    auditLogs: [
      { id: 'log_seed_1', operator: '系统', action: '初始化管理后台', target: '系统', createdAt: '2026-08-28T06:00:00.000Z' }
    ],
    idempotencyKeys: {}
  };
}

class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.initialize();
  }

  initialize() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) {
      this.write(initialData());
      return;
    }
    try {
      const data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!data || !Array.isArray(data.products)) throw new Error('invalid database');
      const defaults = initialData();
      let changed = false;
      for (const key of ['phoneCardOrders', 'rechargeOrders', 'broadbandApplications', 'plateApplications', 'afterSales', 'productReviews', 'rechargePromos', 'leads', 'addresses', 'productRestockAlerts', 'productFavorites', 'uploadRecords', 'rentalDeposits', 'marketItems', 'forumPosts', 'auditLogs', 'merchants', 'paymentOrders', 'settlements', 'payoutRequests', 'financeEvents', 'paymentReconciliations', 'financeTasks', 'notifications', 'slaAlerts', 'merchantScoreLogs', 'merchantScoreSnapshots', 'serviceRiskFollowUps', 'settingChangeLogs', 'adminUsers', 'adminSessions', 'adminLoginFailures']) {
        if (!Array.isArray(data[key])) { data[key] = defaults[key]; changed = true; }
      }
      if (!data.adminSettings) {
        data.adminSettings = defaults.adminSettings;
        changed = true;
      } else if (data.adminSettings.financeTaskResponseHours === undefined) {
        data.adminSettings.financeTaskResponseHours = defaults.adminSettings.financeTaskResponseHours;
        changed = true;
      }
      if (!data.userOpenIds || typeof data.userOpenIds !== 'object') { data.userOpenIds = {}; changed = true; }
      if (!data.patrolState || typeof data.patrolState !== 'object') { data.patrolState = defaults.patrolState; changed = true; }
      if (changed) this.write(data);
    } catch (error) {
      throw new Error(`Cannot load JSON database at ${this.filePath}: ${error.message}`);
    }
  }

  read() {
    return JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
  }

  write(data) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, this.filePath);
  }

  /**
   * 同步读 → 改 → 写。整段零 await，因此 Node 单线程下天然原子。
   *
   * 同步性是当前正确性的来源，一旦引入 await 就会重新出现丢失更新窗口，
   * 所以这里同步返回结果，并把「是否发生过重入」等不变量暴露到 stats() 供断言。
   */
  update(mutator) {
    this._activeWrites = (this._activeWrites || 0) + 1;
    const reentrancy = this._activeWrites - 1;
    if (reentrancy > (this._maxWriteReentrancy || 0)) this._maxWriteReentrancy = reentrancy;
    try {
      const data = this.read();
      const result = mutator(data);
      this.write(data);
      this._writeSeq = (this._writeSeq || 0) + 1;
      return result;
    } finally {
      this._activeWrites -= 1;
    }
  }

  /**
   * 暴露写路径的可观测不变量，供测试断言，防止未来重构引入回归。
   *
   * - `writeSeq`：成功写入次数，单调递增
   * - `maxWriteReentrancy`：mutator 内再次调用 update() 的最大嵌套层数，正常应为 0
   * - `pendingAsyncWrites`：悬挂的异步写数量（JsonStore 为同步写，恒为 0）
   */
  stats() {
    return {
      writeSeq: this._writeSeq || 0,
      maxWriteReentrancy: this._maxWriteReentrancy || 0,
      pendingAsyncWrites: 0
    };
  }
}

module.exports = { JsonStore, initialData };
