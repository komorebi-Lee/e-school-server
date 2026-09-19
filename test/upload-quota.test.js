const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');
const { createApp } = require('../src/app');

process.env.ADMIN_USERNAME = 'upload-quota-admin';
process.env.ADMIN_PASSWORD = 'upload-quota-admin-password-123';

let server;
let baseUrl;
let tempDirectory;
let store;

before(async () => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-upload-quota-'));
  store = new JsonStore(path.join(tempDirectory, 'db.json'));
  // 把配额调小，避免为验证限流而真的上传 30 次
  store.update((data) => {
    data.adminSettings.uploadRateLimitPer24h = 3;
    return true;
  });
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

// 最小可用的 JPEG：魔数 FF D8 FF 开头，长度需 >= 1KB 才能通过体积校验
const JPEG_BODY = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(1200, 1)]);
const DATA_BASE64 = JPEG_BODY.toString('base64');

async function api(pathname, options) {
  const response = await fetch(`${baseUrl}${pathname}`, options);
  return { response, body: await response.json() };
}

async function login(code) {
  const result = await api('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  });
  assert.equal(result.response.status, 200);
  return result.body.data.token;
}

function upload(token) {
  return api('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ dataBase64: DATA_BASE64, mimeType: 'image/jpeg' })
  });
}

test('upload requires an authenticated user', async () => {
  const result = await api('/api/uploads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dataBase64: DATA_BASE64, mimeType: 'image/jpeg' })
  });
  assert.equal(result.response.status, 401);
  assert.equal(result.body.error.code, 'USER_UNAUTHORIZED');
});

test('uploads within the quota succeed and record a receipt', async () => {
  const token = await login('quota_ok_user');
  const result = await upload(token);

  assert.equal(result.response.status, 201);
  assert.match(result.body.data.url, /^\/api\/uploads\/[0-9a-f-]+\.jpg$/);

  const records = store.read().uploadRecords.filter((item) => item.actorId === 'wx_quota_ok_user');
  assert.equal(records.length, 1);
  assert.equal(records[0].size, JPEG_BODY.length);
});

test('exceeding the 24h quota returns 429 UPLOAD_RATE_LIMITED', async () => {
  const token = await login('quota_exceed_user');

  for (let index = 0; index < 3; index += 1) {
    const ok = await upload(token);
    assert.equal(ok.response.status, 201, `第 ${index + 1} 次上传应在配额内`);
  }

  const blocked = await upload(token);
  assert.equal(blocked.response.status, 429);
  assert.equal(blocked.body.error.code, 'UPLOAD_RATE_LIMITED');
  assert.match(blocked.body.error.message, /24 小时/);
  // 错误响应必须沿用统一结构，便于前端统一处理
  assert.ok(blocked.body.requestId);
});

test('quota is tracked per user, not globally', async () => {
  const other = await login('quota_other_user');
  const result = await upload(other);
  assert.equal(result.response.status, 201);
});

test('upload records are pruned to the 24h window', async () => {
  const token = await login('quota_prune_user');
  await upload(token);

  // 人为把该记录推到 24 小时之前，模拟过期
  store.update((data) => {
    data.uploadRecords = (data.uploadRecords || []).map((item) => (
      item.actorId === 'wx_quota_prune_user'
        ? { ...item, createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString() }
        : item
    ));
    return true;
  });

  // 窗口外的记录不再计入，因此仍可继续上传
  const result = await upload(token);
  assert.equal(result.response.status, 201);

  const records = store.read().uploadRecords.filter((item) => item.actorId === 'wx_quota_prune_user');
  assert.equal(records.length, 1, '过期记录应被清理，只保留本次上传');
});
