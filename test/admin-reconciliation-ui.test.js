const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

test('admin payments view renders reconciliation controls and differences', () => {
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

  app.state.view = 'payments';
  app.state.data = {
    paymentOrders: [],
    settlements: [],
    merchants: [],
    paymentReconciliations: [
      {
        id: 'rec_001',
        billDate: '2026-09-06',
        provider: 'wechat',
        channel: 'WECHAT_PAY',
        status: 'DIFFERENCES',
        summary: {
          matchedPaymentCount: 2,
          providerPaymentCount: 3,
          localPaymentCount: 3,
          matchedRefundCount: 0,
          providerRefundCount: 0,
          localRefundCount: 1
        },
        differences: [
          {
            type: 'PROVIDER_PAYMENT_MISSING_LOCAL',
            paymentNo: 'PAY_PROVIDER_ONLY',
            providerAmountInCents: 129900
          }
        ],
        createdAt: '2026-09-07T08:00:00.000Z',
        updatedAt: '2026-09-07T08:00:00.000Z'
      }
    ]
  };

  app.render();
  const html = elements.get('#content').innerHTML;

  assert.ok(html.includes('支付对账'));
  assert.ok(html.includes('执行对账'));
  assert.ok(html.includes('reconciliation-date'));
  assert.ok(html.includes('2026-09-06'));
  assert.ok(html.includes('账实不符'));
  assert.ok(html.includes('渠道有支付，本地缺失'));
  assert.ok(html.includes('PAY_PROVIDER_ONLY'));
  assert.ok(html.includes('¥1,299.00'));
});
