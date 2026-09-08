const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('admin stock view renders movement ledger', () => {
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

  app.state.view = 'stock';
  app.state.data = {
    settings: {},
    merchants: [{ id: 'merchant_001', name: '狮山校园车行' }],
    stockMovements: [
      {
        id: 'mov_001',
        productId: 'prod_001',
        productName: '台账测试车',
        merchantId: 'merchant_001',
        movementType: 'CONSUME',
        quantity: 2,
        stockBefore: 8,
        stockAfter: 6,
        reservedBefore: 2,
        reservedAfter: 0,
        referenceId: 'order_001',
        referenceNo: 'SO20260909001',
        operator: 'ORDER_FLOW',
        createdAt: '2026-09-09T08:00:00.000Z'
      }
    ]
  };

  app.render();
  const html = elements.get('#content').innerHTML;

  assert.ok(html.includes('台账测试车'));
  assert.ok(html.includes('狮山校园车行'));
  assert.ok(html.includes('支付扣减'));
  assert.ok(html.includes('8 → 6'));
  assert.ok(html.includes('2 → 0'));
  assert.ok(html.includes('SO20260909001'));
  assert.ok(html.includes('ORDER_FLOW'));
});
