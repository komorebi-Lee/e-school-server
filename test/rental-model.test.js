const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore, initialData } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'rental-model-admin';
process.env.ADMIN_PASSWORD = 'rental-model-admin-password-123';

const RENTAL_PRODUCT_ID = 'prod_ebike_rent_001';
const SALE_PRODUCT_ID = 'prod_ebike_001';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-rental-model-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  server = http.createServer(createApp({
    store,
    wechatAuth: async (code) => ({ openid: `openid_${code}`, userId: `wx_${code}` })
  }));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

async function api(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

async function loginWeChat(code) {
  const result = await api('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

async function merchantHeaders() {
  const session = await loginWeChat('merchant_demo');
  const login = await api('/api/merchant/login', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ merchantId: 'merchant_001' })
  });
  assert.equal(login.response.status, 200);
  return { 'content-type': 'application/json', authorization: `Bearer ${login.body.data.token}` };
}

async function adminHeaders() {
  const login = await api('/api/admin/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: process.env.ADMIN_USERNAME, password: process.env.ADMIN_PASSWORD })
  });
  assert.equal(login.response.status, 200);
  return { 'content-type': 'application/json', authorization: `Bearer ${login.body.data.token}` };
}

const VALID_RENTAL_PLAN = {
  unit: 'DAY',
  unitPriceInCents: 1500,
  minUnits: 1,
  maxUnits: 30,
  depositInCents: 29900
};

// ---------------------------------------------------------------------------
// 读取路径：列表 / 详情必须统一暴露 listingType
// ---------------------------------------------------------------------------

test('① 商品列表为每个商品输出 listingType，存量商品回落为 SALE', async () => {
  const products = await api('/api/products');
  assert.equal(products.response.status, 200);
  assert.ok(products.body.data.length > 0);

  // 每个商品都必须带 listingType，前端不需要再做 undefined 兜底。
  assert.ok(products.body.data.every((item) => ['SALE', 'RENT'].includes(item.listingType)));

  // 4 个未标注形态的存量种子商品必须输出 SALE，而不是 undefined / null。
  const legacy = products.body.data.find((item) => item.id === SALE_PRODUCT_ID);
  assert.ok(legacy, '存量商品 prod_ebike_001 应仍在列表中');
  assert.equal(legacy.listingType, 'SALE');
});

test('⑧ 非租赁商品的响应不含 rentalPlan 字段（而非 null）', async () => {
  const list = await api('/api/products');
  const legacyInList = list.body.data.find((item) => item.id === SALE_PRODUCT_ID);
  assert.equal(Object.prototype.hasOwnProperty.call(legacyInList, 'rentalPlan'), false);

  const detail = await api(`/api/products/${SALE_PRODUCT_ID}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.listingType, 'SALE');
  assert.equal(Object.prototype.hasOwnProperty.call(detail.body.data, 'rentalPlan'), false);
});

test('② 种子租赁商品返回 RENT 与规范化 rentalPlan', async () => {
  const detail = await api(`/api/products/${RENTAL_PRODUCT_ID}`);
  assert.equal(detail.response.status, 200);
  assert.equal(detail.body.data.listingType, 'RENT');
  assert.equal(detail.body.data.rentalPlan.unit, 'DAY');
  assert.equal(detail.body.data.rentalPlan.unitPriceInCents, 1500);
  assert.equal(detail.body.data.rentalPlan.minUnits, 1);
  assert.equal(detail.body.data.rentalPlan.maxUnits, 30);
  assert.equal(detail.body.data.rentalPlan.depositInCents, 29900);

  const list = await api('/api/products');
  const rentalInList = list.body.data.find((item) => item.id === RENTAL_PRODUCT_ID);
  assert.equal(rentalInList.listingType, 'RENT');
  assert.deepEqual(rentalInList.rentalPlan, VALID_RENTAL_PLAN);
});

test('⑤ category=E_BIKE_NEW 同时返回租赁车与售卖车', async () => {
  const filtered = await api('/api/products?category=E_BIKE_NEW');
  assert.equal(filtered.response.status, 200);

  const ids = filtered.body.data.map((item) => item.id);
  assert.ok(ids.includes(RENTAL_PRODUCT_ID), '租赁车不能被 listingType 过滤掉');
  assert.ok(ids.includes(SALE_PRODUCT_ID), '售卖车必须仍在同一列表');

  const rental = filtered.body.data.find((item) => item.id === RENTAL_PRODUCT_ID);
  const sale = filtered.body.data.find((item) => item.id === SALE_PRODUCT_ID);
  assert.equal(rental.listingType, 'RENT');
  assert.equal(sale.listingType, 'SALE');
  assert.ok(filtered.body.data.every((item) => item.category === 'E_BIKE_NEW'));
});

test('⑥ 存量种子商品仍为 5 个', () => {
  assert.equal(initialData().products.length, 5);
  assert.equal(initialData().products.filter((item) => item.listingType === 'RENT').length, 1);

  // 用一份全新的 db.json 再确认一次，避免受本文件后续写操作影响。
  const fresh = new JsonStore(path.join(tempDirectory, 'seed-count-db.json'));
  assert.equal(fresh.read().products.length, 5);
  assert.deepEqual(
    fresh.read().products.map((item) => item.id),
    ['prod_ebike_001', RENTAL_PRODUCT_ID, 'prod_card_service_001', 'prod_card_service_002', 'prod_card_service_003']
  );
});

// ---------------------------------------------------------------------------
// 写入路径：商家 / 管理端创建与编辑
// ---------------------------------------------------------------------------

test('③ 商家创建租赁商品缺少 rentalPlan.unit 时返回 400', async () => {
  const headers = await merchantHeaders();
  const missingUnit = await api('/api/merchant/products', {
    method: 'POST', headers,
    body: JSON.stringify({
      name: '缺 unit 的租赁车', category: 'E_BIKE_NEW', description: '用于校验 unit 必填',
      priceInCents: 219900, stock: 2,
      listingType: 'RENT',
      rentalPlan: { unitPriceInCents: 1200, minUnits: 1, maxUnits: 7, depositInCents: 19900 }
    })
  });
  assert.equal(missingUnit.response.status, 400);
  assert.equal(missingUnit.body.error.code, 'VALIDATION_ERROR');

  // 声明 RENT 却完全不传 rentalPlan 同样必须被拒绝，不能落库成「半租赁」商品。
  const missingPlan = await api('/api/merchant/products', {
    method: 'POST', headers,
    body: JSON.stringify({
      name: '缺 rentalPlan 的租赁车', category: 'E_BIKE_NEW', description: '用于校验 rentalPlan 必填',
      priceInCents: 219900, stock: 2, listingType: 'RENT'
    })
  });
  assert.equal(missingPlan.response.status, 400);
  assert.equal(missingPlan.body.error.code, 'VALIDATION_ERROR');

  assert.equal(store.read().products.filter((item) => item.name.startsWith('缺')).length, 0);
});

test('③ 管理端创建租赁商品缺少 rentalPlan.unit 时返回 400', async () => {
  const headers = await adminHeaders();
  const missingUnit = await api('/api/admin/products', {
    method: 'POST', headers,
    body: JSON.stringify({
      name: '管理端缺 unit 的租赁车', category: 'E_BIKE_NEW', description: '用于校验 unit 必填',
      priceInCents: 219900, stock: 2,
      listingType: 'RENT',
      rentalPlan: { unit: 'WEEK', unitPriceInCents: 1200, minUnits: 1, maxUnits: 7, depositInCents: 19900 }
    })
  });
  assert.equal(missingUnit.response.status, 400);
  assert.equal(missingUnit.body.error.code, 'VALIDATION_ERROR');
});

test('④ maxUnits 小于 minUnits 时返回 400', async () => {
  const merchant = await merchantHeaders();
  const admin = await adminHeaders();

  const created = await api('/api/merchant/products', {
    method: 'POST', headers: merchant,
    body: JSON.stringify({
      name: '可租赁演示车', category: 'E_BIKE_NEW', description: '用于校验区间与编辑路径',
      priceInCents: 259900, stock: 3,
      listingType: 'RENT',
      rentalPlan: VALID_RENTAL_PLAN
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.listingType, 'RENT');
  const productId = created.body.data.id;

  const invertedRange = { ...VALID_RENTAL_PLAN, minUnits: 10, maxUnits: 2 };

  const merchantEdit = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: merchant,
    body: JSON.stringify({ rentalPlan: invertedRange })
  });
  assert.equal(merchantEdit.response.status, 400);
  assert.equal(merchantEdit.body.error.code, 'VALIDATION_ERROR');

  const adminEdit = await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ rentalPlan: invertedRange })
  });
  assert.equal(adminEdit.response.status, 400);
  assert.equal(adminEdit.body.error.code, 'VALIDATION_ERROR');

  const adminCreate = await api('/api/admin/products', {
    method: 'POST', headers: admin,
    body: JSON.stringify({
      name: '管理端区间倒置租赁车', category: 'E_BIKE_NEW', description: '用于校验 maxUnits >= minUnits',
      priceInCents: 259900, stock: 3, listingType: 'RENT', rentalPlan: invertedRange
    })
  });
  assert.equal(adminCreate.response.status, 400);
  assert.equal(adminCreate.body.error.code, 'VALIDATION_ERROR');

  // 失败请求不得留下任何副作用。
  const stored = store.read().products.find((item) => item.id === productId);
  assert.deepEqual(stored.rentalPlan, VALID_RENTAL_PLAN);
});

test('商家 / 管理端可创建与编辑租赁商品，切回售卖时清除 rentalPlan', async () => {
  const merchant = await merchantHeaders();
  const admin = await adminHeaders();

  const created = await api('/api/merchant/products', {
    method: 'POST', headers: merchant,
    body: JSON.stringify({
      name: '商家上架租赁车', category: 'E_BIKE_NEW', description: '租赁形态落库演示',
      priceInCents: 269900, stock: 4,
      listingType: 'RENT',
      rentalPlan: { unit: 'hour', unitPriceInCents: 800, minUnits: 2, maxUnits: 12, depositInCents: 15900 }
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.listingType, 'RENT');
  // unit 会被规范化成大写。
  assert.equal(created.body.data.rentalPlan.unit, 'HOUR');
  const productId = created.body.data.id;

  const detail = await api(`/api/products/${productId}`);
  assert.equal(detail.body.data.listingType, 'RENT');
  assert.equal(detail.body.data.rentalPlan.depositInCents, 15900);

  const merchantUpdated = await api(`/api/merchant/products/${productId}`, {
    method: 'POST', headers: merchant,
    body: JSON.stringify({ rentalPlan: { unit: 'DAY', unitPriceInCents: 2200, minUnits: 1, maxUnits: 5, depositInCents: 25900 } })
  });
  assert.equal(merchantUpdated.response.status, 200);

  const adminUpdated = await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ rentalPlan: { unit: 'DAY', unitPriceInCents: 2600, minUnits: 3, maxUnits: 9, depositInCents: 32900 } })
  });
  assert.equal(adminUpdated.response.status, 200);
  assert.equal(adminUpdated.body.data.listingType, 'RENT');
  assert.deepEqual(adminUpdated.body.data.rentalPlan, {
    unit: 'DAY', unitPriceInCents: 2600, minUnits: 3, maxUnits: 9, depositInCents: 32900
  });

  // 切回售卖形态必须真正删掉 rentalPlan，而不是留一个陈旧方案。
  const switched = await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ listingType: 'SALE' })
  });
  assert.equal(switched.response.status, 200);
  assert.equal(switched.body.data.listingType, 'SALE');
  assert.equal(Object.prototype.hasOwnProperty.call(switched.body.data, 'rentalPlan'), false);

  const refreshed = await api(`/api/products/${productId}`);
  assert.equal(refreshed.body.data.listingType, 'SALE');
  assert.equal(Object.prototype.hasOwnProperty.call(refreshed.body.data, 'rentalPlan'), false);

  const invalidType = await api(`/api/admin/products/${productId}`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ listingType: 'LEASE' })
  });
  assert.equal(invalidType.response.status, 400);
  assert.equal(invalidType.body.error.code, 'VALIDATION_ERROR');
});

// ---------------------------------------------------------------------------
// 集合声明一致性
// ---------------------------------------------------------------------------

test('⑦ initialize() 的集合补齐列表全部存在于 initialData()', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');
  const backfill = source.match(/for \(const key of \[([^\]]+)\]\)/);
  assert.ok(backfill, 'initialize() 必须保留集合补齐列表');

  const keys = backfill[1]
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.ok(keys.length > 30, `补齐列表应覆盖全部集合，实际 ${keys.length} 个`);
  assert.ok(keys.includes('rentalDeposits'), '补齐列表必须包含 rentalDeposits');

  const data = initialData();
  for (const key of keys) {
    assert.ok(Object.prototype.hasOwnProperty.call(data, key), `initialData() 缺少集合 ${key}`);
  }
  assert.ok(Array.isArray(data.rentalDeposits));
  assert.equal(data.rentalDeposits.length, 0);
});

test('旧 db.json 缺少 rentalDeposits 时加载后会被补齐为数组', () => {
  const legacyPath = path.join(tempDirectory, 'legacy-db.json');
  const legacy = initialData();
  delete legacy.rentalDeposits;
  fs.writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');

  const reloaded = new JsonStore(legacyPath);
  assert.ok(Array.isArray(reloaded.read().rentalDeposits));
  assert.deepEqual(reloaded.read().rentalDeposits, []);
});
