const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { ApiError, createApp } = require('../src/app');

const ADMIN_USERNAME = 'security-admin';
const ADMIN_PASSWORD = 'rotated-strong-password-2026';
const ADMIN_HASH_PASSWORD = 'hashed-admin-password-2026';
const ADMIN_PASSWORD_HASH = 'scrypt$64b9725fa13b9ede663b108a46b4b096$d2dc19258e712f34d776eedb1c75718a5faa0d09723baf0f331cc7a5c98a217b77ab3109e34799aca37110d622a524245595d52b4485c5979125244b7585fa57';
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

test('admin login locks after repeated credential failures', async () => {
  const failedLogin = {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: 'wrong-password' })
  };

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const failed = await api('/api/admin/login', failedLogin);
    assert.equal(failed.response.status, 401);
  }

  const locked = await api('/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
  });
  assert.equal(locked.response.status, 429);
  assert.equal(locked.body.error.code, 'ADMIN_LOGIN_LOCKED');
});

test('admin login lock expires and allows another attempt', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-lock-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const lockServer = http.createServer(createApp({
    store,
    adminLoginLockout: { maxFailures: 5, lockDurationMs: 100 }
  }));
  await new Promise((resolve) => lockServer.listen(0, '127.0.0.1', resolve));
  const lockBaseUrl = `http://127.0.0.1:${lockServer.address().port}`;
  const login = (password) => fetch(`${lockBaseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password })
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login('wrong-password')).status, 401);
    }
    assert.equal((await login(ADMIN_PASSWORD)).status, 429);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal((await login(ADMIN_PASSWORD)).status, 200);
  } finally {
    await new Promise((resolve) => lockServer.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('admin login lock survives a service restart', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-lock-restart-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const startServer = async () => {
    const restartServer = http.createServer(createApp({ store }));
    await new Promise((resolve) => restartServer.listen(0, '127.0.0.1', resolve));
    return restartServer;
  };
  const firstServer = await startServer();
  const firstBaseUrl = `http://127.0.0.1:${firstServer.address().port}`;
  const login = (baseUrl, password) => fetch(`${baseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password })
  });

  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await login(firstBaseUrl, 'wrong-password')).status, 401);
    }

    await new Promise((resolve) => firstServer.close(resolve));
    const secondServer = await startServer();
    const secondBaseUrl = `http://127.0.0.1:${secondServer.address().port}`;
    try {
      const locked = await login(secondBaseUrl, ADMIN_PASSWORD);
      assert.equal(locked.status, 429);
      assert.equal((await locked.json()).error.code, 'ADMIN_LOGIN_LOCKED');
    } finally {
      await new Promise((resolve) => secondServer.close(resolve));
    }
  } finally {
    if (firstServer.listening) {
      await new Promise((resolve) => firstServer.close(resolve));
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('admin login verifies a configured scrypt password hash', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-hash-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const hashServer = http.createServer(createApp({
    store,
    adminPasswordHash: ADMIN_PASSWORD_HASH
  }));
  await new Promise((resolve) => hashServer.listen(0, '127.0.0.1', resolve));
  const hashBaseUrl = `http://127.0.0.1:${hashServer.address().port}`;
  const login = (password) => fetch(`${hashBaseUrl}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USERNAME, password })
  });

  try {
    const valid = await login(ADMIN_HASH_PASSWORD);
    assert.equal(valid.status, 200);

    const invalid = await login('wrong-hashed-password');
    assert.equal(invalid.status, 401);
  } finally {
    await new Promise((resolve) => hashServer.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('admin password hash helper reads the secret from stdin', async () => {
  const helper = spawnSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'hash-admin-password.js')], {
    input: 'stdin-admin-password-2026\n',
    encoding: 'utf8'
  });
  assert.equal(helper.status, 0);
  assert.match(helper.stdout.trim(), /^scrypt\$[0-9a-f]+\$[0-9a-f]+$/);

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-helper-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const helperServer = http.createServer(createApp({
    store,
    adminPasswordHash: helper.stdout.trim()
  }));
  await new Promise((resolve) => helperServer.listen(0, '127.0.0.1', resolve));
  try {
    const login = await fetch(`http://127.0.0.1:${helperServer.address().port}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: 'stdin-admin-password-2026' })
    });
    assert.equal(login.status, 200);
  } finally {
    await new Promise((resolve) => helperServer.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('admin sessions survive a service restart from the persistent store', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-session-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const startServer = async () => {
    const restartServer = http.createServer(createApp({ store }));
    await new Promise((resolve) => restartServer.listen(0, '127.0.0.1', resolve));
    return restartServer;
  };
  const firstServer = await startServer();
  const firstBaseUrl = `http://127.0.0.1:${firstServer.address().port}`;

  try {
    const login = await fetch(`${firstBaseUrl}/api/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
    });
    assert.equal(login.status, 200);
    const token = (await login.json()).data.token;
    const persistedState = store.read();
    assert.ok(Array.isArray(persistedState.adminSessions));
    assert.ok(persistedState.adminSessions.length > 0);
    assert.equal(JSON.stringify(persistedState).includes(token), false);

    await new Promise((resolve) => firstServer.close(resolve));
    const secondServer = await startServer();
    const secondBaseUrl = `http://127.0.0.1:${secondServer.address().port}`;
    try {
      const overview = await fetch(`${secondBaseUrl}/api/admin/overview`, {
        headers: { authorization: `Bearer ${token}` }
      });
      assert.equal(overview.status, 200);
    } finally {
      await new Promise((resolve) => secondServer.close(resolve));
    }
  } finally {
    if (firstServer.listening) {
      await new Promise((resolve) => firstServer.close(resolve));
    }
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('super admin can create role-limited admins', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-rbac-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const rbacServer = http.createServer(createApp({ store }));
  await new Promise((resolve) => rbacServer.listen(0, '127.0.0.1', resolve));
  const rbacBaseUrl = `http://127.0.0.1:${rbacServer.address().port}`;
  const request = (pathname, options) => fetch(`${rbacBaseUrl}${pathname}`, options);
  const jsonRequest = (pathname, options = {}) => request(pathname, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });

  try {
    const superLogin = await jsonRequest('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
    });
    assert.equal(superLogin.status, 200);
    const superToken = (await superLogin.json()).data.token;

    const created = await jsonRequest('/api/admin/admins', {
      method: 'POST',
      headers: { authorization: `Bearer ${superToken}` },
      body: JSON.stringify({
        username: 'finance-admin',
        displayName: '财务管理员',
        password: 'finance-password-2026',
        role: 'FINANCE'
      })
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.data.role, 'FINANCE');
    assert.equal('passwordHash' in createdBody.data, false);

    const list = await jsonRequest('/api/admin/admins', {
      headers: { authorization: `Bearer ${superToken}` }
    });
    assert.equal(list.status, 200);
    const listedBody = await list.json();
    assert.ok(listedBody.data.some((item) => item.username === 'finance-admin'));
    assert.ok(listedBody.data.every((item) => !('passwordHash' in item)));

    const financeLogin = await jsonRequest('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ username: 'finance-admin', password: 'finance-password-2026' })
    });
    assert.equal(financeLogin.status, 200);
    const financeToken = (await financeLogin.json()).data.token;

    const financeVisible = await jsonRequest('/api/admin/payment-orders', {
      headers: { authorization: `Bearer ${financeToken}` }
    });
    assert.equal(financeVisible.status, 200);

    const financeForbidden = await jsonRequest('/api/admin/products', {
      method: 'POST',
      headers: { authorization: `Bearer ${financeToken}` },
      body: JSON.stringify({})
    });
    assert.equal(financeForbidden.status, 403);
    assert.equal((await financeForbidden.json()).error.code, 'ADMIN_FORBIDDEN');
  } finally {
    await new Promise((resolve) => rbacServer.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('disabling an admin revokes active sessions immediately', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-admin-disable-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const disableServer = http.createServer(createApp({ store }));
  await new Promise((resolve) => disableServer.listen(0, '127.0.0.1', resolve));
  const disableBaseUrl = `http://127.0.0.1:${disableServer.address().port}`;
  const request = (pathname, options) => fetch(`${disableBaseUrl}${pathname}`, options);

  try {
    const superLogin = await request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_PASSWORD })
    });
    const superToken = (await superLogin.json()).data.token;

    const created = await request('/api/admin/admins', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${superToken}` },
      body: JSON.stringify({
        username: 'support-admin',
        displayName: '客服管理员',
        password: 'support-password-2026',
        role: 'SUPPORT'
      })
    });
    const createdBody = await created.json();

    const supportLogin = await request('/api/admin/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'support-admin', password: 'support-password-2026' })
    });
    const supportToken = (await supportLogin.json()).data.token;

    const beforeDisable = await request('/api/admin/leads', {
      headers: { authorization: `Bearer ${supportToken}` }
    });
    assert.equal(beforeDisable.status, 200);

    const disabled = await request(`/api/admin/admins/${createdBody.data.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${superToken}` },
      body: JSON.stringify({ status: 'DISABLED' })
    });
    assert.equal(disabled.status, 200);

    const afterDisable = await request('/api/admin/leads', {
      headers: { authorization: `Bearer ${supportToken}` }
    });
    assert.equal(afterDisable.status, 401);
  } finally {
    await new Promise((resolve) => disableServer.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
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
  assert.equal(spoofed.response.status, 403);
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

test('CORS responses only allow explicitly configured origins', async () => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-cors-'));
  const store = new JsonStore(path.join(temporaryDirectory, 'db.json'));
  const corsServer = http.createServer(createApp({
    store,
    corsAllowedOrigins: ['https://allowed.example']
  }));
  await new Promise((resolve) => corsServer.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${corsServer.address().port}`;
  try {
    const allowed = await fetch(`${origin}/health`, { headers: { origin: 'https://allowed.example' } });
    assert.equal(allowed.status, 200);
    assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://allowed.example');
    assert.equal(allowed.headers.get('vary'), 'Origin');

    const denied = await fetch(`${origin}/health`, { headers: { origin: 'https://attacker.example' } });
    assert.equal(denied.status, 200);
    assert.equal(denied.headers.get('access-control-allow-origin'), null);

    const preflight = await fetch(`${origin}/api/orders`, {
      method: 'OPTIONS',
      headers: { origin: 'https://attacker.example' }
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  } finally {
    await new Promise((resolve) => corsServer.close(resolve));
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
