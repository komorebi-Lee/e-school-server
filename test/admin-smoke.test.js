'use strict';

/**
 * 管理端交付物冒烟测试
 *
 * 背景：`public/admin.js` 是**直接交付给用户、由浏览器 `<script src>` 加载**的文件。
 * 它曾在模块求值期读 `state.data.settings`，而 `state.data` 初值是 `null` ⇒
 * 加载即抛 `TypeError: Cannot read properties of null (reading 'settings')`，
 * 登录页 JS 完全中断（按钮无任何响应），而**当时 264 个测试全绿**。
 *
 * 之所以全绿：5 个管理端 UI 测试在读源码后做了
 * `.replace('const state={data:null,', 'const state={data:{settings:{}},')`
 * 的字符串替换，把崩溃那一行**绕过去了** —— 等于测了一个不存在的文件。
 *
 * 本测试的职责：**按浏览器语义加载原始文件**，不许任何改写。
 * ★ 并内建反向控制：把修复回退成旧写法后必须抛错，否则本判据自身无效。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ADMIN_JS_PATH = path.join(__dirname, '..', 'public', 'admin.js');

/** 最小的浏览器环境替身：够 `admin.js` 在模块级求值通过即可。 */
function fakeElement() {
  return {
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    querySelector: () => fakeElement(),
    querySelectorAll: () => [],
    style: {},
    dataset: {},
    focus() {},
    remove() {},
    appendChild() {},
    setAttribute() {},
    getAttribute: () => null,
  };
}

function browserContext() {
  const store = new Map();
  return {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
    },
    document: {
      querySelector: () => fakeElement(),
      querySelectorAll: () => [],
      addEventListener() {},
      body: fakeElement(),
      createElement: () => fakeElement(),
    },
    window: {},
    location: { search: '', pathname: '/admin', href: '' },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    alert() {},
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    console,
  };
}

/** 按浏览器语义加载源码；返回内部量。抛错则原样抛出，由调用方断言。 */
function loadAdmin(source) {
  return vm.runInNewContext(
    `${source}; ({ state, lowStockThreshold })`,
    browserContext(),
    { timeout: 5000 },
  );
}

// ─────────────────────────────────────────────────────────────
// 主判据
// ─────────────────────────────────────────────────────────────

test('管理端 admin.js 必须能按浏览器语义直接加载（不得在模块求值期抛错）', () => {
  const source = fs.readFileSync(ADMIN_JS_PATH, 'utf8');

  // 防空转：确认读到的确实是那份文件，而不是空内容
  assert.ok(source.length > 10000,
    `读到的 admin.js 过小（${source.length} 字节），判据可能扫错了文件`);

  let app;
  assert.doesNotThrow(() => { app = loadAdmin(source); },
    '★ admin.js 在模块求值期抛错 —— 浏览器会直接中断，管理端登录按钮将毫无响应');

  assert.equal(app.state.data, null,
    'state.data 的初值应为 null（本判据正是要覆盖「数据尚未加载」这一真实时序）');
});

test('lowStockThreshold 必须惰性取值：数据未加载时回落 10，加载后取配置值', () => {
  const source = fs.readFileSync(ADMIN_JS_PATH, 'utf8');
  const app = loadAdmin(source);

  assert.equal(typeof app.lowStockThreshold, 'function',
    'lowStockThreshold 必须是函数 —— 若仍是模块级常量，它在 state.data 为 null 时求值，'
    + '既会抛错，也会导致配置的阈值永远不生效');

  assert.equal(app.lowStockThreshold(), 10, '数据未加载时应回落默认值 10');

  app.state.data = { settings: { lowStockThreshold: 25 } };
  assert.equal(app.lowStockThreshold(), 25,
    '数据加载后必须读到配置值 —— 常量写法会永远停在默认值 10（低库存阈值形同虚设）');

  app.state.data = { settings: {} };
  assert.equal(app.lowStockThreshold(), 10, '配置缺失时应回落默认值 10');
});

// ─────────────────────────────────────────────────────────────
// 反向控制：证明本判据真的能判红
// ─────────────────────────────────────────────────────────────

test('反向控制：把修复回退成「模块级常量读 state.data.settings」必须被本判据抓到', () => {
  const source = fs.readFileSync(ADMIN_JS_PATH, 'utf8');

  const FIXED = 'const lowStockThreshold=()=>Number((state.data?.settings?.lowStockThreshold)??10);';
  assert.ok(source.includes(FIXED),
    `未找到修复后的写法，反向控制无法成立（期望源码含：${FIXED}）`);

  const regressed = source.replace(
    FIXED,
    'const lowStockThreshold=Number((state.data.settings||{}).lowStockThreshold??10);',
  );
  assert.notEqual(regressed, source, '替换未生效，反向控制无效');

  // ★ 不能用 `assert.throws(fn, TypeError)`：vm 里抛出的 TypeError 属于**另一个 realm**，
  //   外层的 `instanceof TypeError` 恒为 false，会导致反向控制假失败。改为匹配错误消息。
  assert.throws(
    () => loadAdmin(regressed),
    /reading 'settings'/,
    '★ 反向控制失败：回退成旧写法后本判据仍未报错，说明它抓不到这个缺陷',
  );
});
