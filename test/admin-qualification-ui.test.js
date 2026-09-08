const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('admin qualification view renders renewal review controls', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8')
    .replace('const state={data:null,', 'const state={data:{settings:{}},');
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        selector,
        textContent: '',
        innerHTML: '',
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {},
        querySelector: (childSelector) => element(`${selector} ${childSelector}`)
      });
    }
    return elements.get(selector);
  };
  const context = {
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      querySelector: element,
      querySelectorAll: () => [],
      addEventListener() {}
    },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({ data: {} }) }),
    alert() {},
    prompt: () => null
  };
  const app = vm.runInNewContext(`${source}; ({ state, render })`, context, { timeout: 5000 });

  app.state.view = 'qualification';
  app.state.data = {
    qualificationRenewals: [
      {
        id: 'qual_001',
        merchantName: '资质复审测试店',
        licenseNo: '92420111MAKMT4535S',
        licenseUrl: '/api/uploads/new-license.jpg',
        licenseExpireDate: '2028-12-31',
        note: '新执照已上传',
        status: 'PENDING_REVIEW',
        reviewNote: '',
        createdAt: '2026-09-08T08:00:00.000Z',
        updatedAt: '2026-09-08T08:00:00.000Z'
      }
    ]
  };

  app.render();
  const html = elements.get('#content').innerHTML;

  assert.ok(html.includes('资质复审'));
  assert.ok(html.includes('待平台审核'));
  assert.ok(html.includes('资质复审测试店'));
  assert.ok(html.includes('92420111MAKMT4535S'));
  assert.ok(html.includes('2028-12-31'));
  assert.ok(html.includes('/api/uploads/new-license.jpg'));
  assert.ok(html.includes('新执照已上传'));
  assert.ok(html.includes('qualification-approve'));
  assert.ok(html.includes('qualification-reject'));
});
