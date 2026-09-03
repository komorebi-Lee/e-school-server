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
    active: true
  },
  {
    id: 'prod_card_service_001',
    name: '校园畅享卡',
    category: 'PHONE_PLAN',
    description: '模拟29元/月校园电话套餐，正式资费以运营商确认为准。',
    priceInCents: 2900,
    stock: 999,
    campusIds: ['campus_demo'],
    imageUrl: 'https://placehold.co/600x400?text=Campus+Card',
    active: true
  }
];

const seedMerchants = [
  {
    id: 'merchant_001',
    userId: 'merchant_demo',
    merchantType: 'INDIVIDUAL',
    name: '狮山校园车行',
    ownerName: '范毅',
    phone: '15527111396',
    licenseNo: 'DEMO_LICENSE_001',
    category: 'E_BIKE',
    serviceArea: '华中农业大学狮山校区',
    reviewNote: '',
    status: 'APPROVED',
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

function initialData() {
  return {
    schemaVersion: 1,
    products: seedProducts,
    merchants: seedMerchants,
    campusCardApplications: [],
    orders: [],
    afterSales: [],
    leads: [],
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
    adminSettings: { brandName: '狮山智生活', schoolName: '华中农业大学', campusName: '狮山校区', servicePhone: '15527111396', serviceWechat: '15527111396', externalPlateFeeInCents: 4900 },
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
      for (const key of ['phoneCardOrders', 'rechargeOrders', 'broadbandApplications', 'plateApplications', 'afterSales', 'leads', 'auditLogs', 'merchants']) {
        if (!Array.isArray(data[key])) { data[key] = defaults[key]; changed = true; }
      }
      if (!data.adminSettings) { data.adminSettings = defaults.adminSettings; changed = true; }
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

  update(mutator) {
    const data = this.read();
    const result = mutator(data);
    this.write(data);
    return result;
  }
}

module.exports = { JsonStore, initialData };
