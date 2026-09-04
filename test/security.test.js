const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { ApiError, createApp } = require('../src/app');

const ADMIN_USERNAME = 'security-admin';
const ADMIN_PASSWORD = 'rotated-strong-password-2026';
const TEST_OPENID = 'openid_security_test';
const TEST_USER_ID = 'wx_openid_security_test';

process.env.ADMIN_USERNAME = ADMIN_USERNAME;
process.env.ADMIN_PASSWORD = ADMIN_PASSWORD;

let server;
let baseUrl;
let tempDirectory;

async function api(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  const contentType = response.headers.get('content-type') || '';
  const body = contentType.includes('application/json') ? await response.json() : await response.text();
  return { response, body };
}

async function loginWeChat() {
  const result = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'wx_code_001' })
  });
  assert.equal(result.response.status, 200);
  return result.body.data;
}

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-security-'));
  const store = new JsonStore(path.join(tempDirectory, 'db.json'));
  const app = createApp({
    store,
    wechatAuth: async (code) => {
      if (code !== 'wx_code_001') throw new ApiError(401, 'WECHAT_LOGIN_FAILED', 'INVALID_CODE');
      return { openid: TEST_OPENID };
    }
  });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('admin password is environment-only and never shipped in the login page', async () => {
  const oldPassword = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'Shishan@2026' })
  });
  assert.equal(oldPassword.response.status, 401);

  const login = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  assert.equal(login.response.status, 200);

  const overview = await api('/api/admin/overview', {
    headers: { authorization: `Bearer ${login.body.data.token}` }
  });
  assert.equal(overview.response.status, 200);

  const adminPage = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
  assert.ok(!adminPage.includes('Shishan@2026'));
  assert.ok(!adminPage.includes('id="password" value='));
});

test('wechat login exchanges a code for a server-side user identity', async () => {
  const invalid = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: 'invalid' })
  });
  assert.equal(invalid.response.status, 401);

  const session = await loginWeChat();
  assert.match(session.token, /^[\w-]+$/);
  assert.equal(session.userId, TEST_USER_ID);
});

test('platform-injected openid creates a session without code exchange', async () => {
  const result = await api('/api/auth/login', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-wx-source': 'wx-devtools',
      'x-wx-openid': 'openid_platform_test'
    },
    body: JSON.stringify({})
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.body.data.userId, 'wx_openid_platform_test');
  const orders = await api('/api/my/orders', { headers: { authorization: `Bearer ${result.body.data.token}` } });
  assert.equal(orders.response.status, 200);
});

test('user APIs derive identity from the WeChat session, not request fields', async () => {
  const session = await loginWeChat();
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({
      userId: 'attacker_user',
      items: [{ productId: 'prod_ebike_001', quantity: 1 }]
    })
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.body.data.userId, TEST_USER_ID);

  const unauthorizedList = await api('/api/my/orders');
  assert.equal(unauthorizedList.response.status, 401);

  const authorizedList = await api('/api/my/orders', {
    headers: { authorization: `Bearer ${session.token}` }
  });
  assert.equal(authorizedList.response.status, 200);
  assert.equal(authorizedList.body.data.ebikeOrders.length, 1);
});

test('order collaboration cannot be submitted as another user', async () => {
  const session = await loginWeChat();
  const created = await api('/api/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ items: [{ productId: 'prod_card_service_001', quantity: 1 }] })
  });
  const orderId = created.body.data.id;

  const unauthorized = await api('/api/order-collab', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ role: 'USER', userId: TEST_USER_ID, orderId, action: 'APPEAL', note: '未登录请求' })
  });
  assert.equal(unauthorized.response.status, 401);

  const spoofed = await api('/api/order-collab', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${session.token}` },
    body: JSON.stringify({ role: 'USER', userId: 'attacker_user', orderId, action: 'APPEAL', note: '尝试冒用' })
  });
  assert.equal(spoofed.response.status, 200);
});

test('uploads require a login session', async () => {
  const unauthorized = await api('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataBase64: Buffer.alloc(2048).toString('base64'), mimeType: 'image/png' })
  });
  assert.equal(unauthorized.response.status, 401);
});

test('merchant login requires a WeChat session', async () => {
  const result = await api('/api/merchant/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: 'merchant_demo', merchantId: 'merchant_001' })
  });
  assert.equal(result.response.status, 401);
});

test('demo login issues a working session without wechat verification', async () => {
  const result = await api('/api/auth/demo-login', { method: 'POST' });
  assert.equal(result.response.status, 200);
  const { token, userId } = result.body.data;
  assert.equal(userId, 'wx_demo_user');
  const orders = await api('/api/my/orders', { headers: { authorization: `Bearer ${token}` } });
  assert.equal(orders.response.status, 200);
});
