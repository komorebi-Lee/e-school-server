const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { JsonStore } = require('../src/store');

const SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'store.js'), 'utf8');

let tempDirectory;
let dbPath;
let store;

before(() => {
  tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-store-invariants-'));
  dbPath = path.join(tempDirectory, 'db.json');
  store = new JsonStore(dbPath);
});

after(() => {
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

/**
 * 取出 JsonStore 某个方法（2 空格缩进）的源码片段，用于结构性断言。
 * 依赖 store.js 当前的缩进风格；若后续格式化需同步调整。
 */
function methodSource(name) {
  const lines = SOURCE.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^\\s{2}${name}\\(`).test(line));
  assert.notEqual(start, -1, `未能在 store.js 中定位方法 ${name}`);
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^\s{2}\}$/.test(lines[index])) return lines.slice(start, index + 1).join('\n');
  }
  throw new Error(`未找到方法 ${name} 的结尾`);
}

test('update 同步返回结果，不是 Promise', () => {
  const result = store.update(() => 'value');
  assert.equal(result, 'value');
  // 若被改成 Promise，全仓 100+ 处同步取用返回值的调用点会立刻失效
  assert.equal(typeof result?.then, 'undefined');
  assert.notEqual(store.update.constructor.name, 'AsyncFunction');
});

test('update / read / write 均非 async 函数', () => {
  for (const name of ['update', 'read', 'write']) {
    assert.notEqual(
      store[name].constructor.name,
      'AsyncFunction',
      `${name} 不得改为 async，同步性是当前无丢失更新的前提`
    );
  }
});

test('update / read / write 函数体内不出现 await', () => {
  for (const name of ['update', 'read', 'write']) {
    const body = methodSource(name);
    assert.ok(body.includes(`${name}(`), `方法 ${name} 的源码定位失败`);
    assert.equal(/\bawait\b/.test(body), false, `${name} 内出现 await 会重新引入丢失更新窗口`);
  }
});

test('每次 update 递增写序号且不发生重入', () => {
  const before = store.stats();
  store.update((data) => {
    data.products.push({ id: `probe_${data.products.length}`, active: false });
    return true;
  });
  const after = store.stats();

  assert.equal(after.writeSeq, before.writeSeq + 1, 'writeSeq 应单调递增');
  assert.equal(after.maxWriteReentrancy, 0, '正常调用不应发生重入');
  assert.equal(after.pendingAsyncWrites, 0, 'JsonStore 为同步写，不应有悬挂写');
});

test('mutator 抛错时不写入文件', () => {
  const snapshot = fs.readFileSync(dbPath, 'utf8');
  const seqBefore = store.stats().writeSeq;

  assert.throws(() => {
    store.update((data) => {
      data.products.push({ id: 'should_not_persist', active: false });
      throw new Error('mutator 失败');
    });
  }, /mutator 失败/);

  assert.equal(fs.readFileSync(dbPath, 'utf8'), snapshot, '失败后文件内容应保持不变');
  assert.equal(store.stats().writeSeq, seqBefore, '失败后不应递增写序号');
  assert.equal(store.read().products.some((item) => item.id === 'should_not_persist'), false);
});

test('mutator 内再次调用 update 会被统计为重入', () => {
  const freshDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'campus-go-reentrancy-'));
  try {
    const nested = new JsonStore(path.join(freshDirectory, 'db.json'));
    nested.update((data) => {
      // 模拟有人在 mutator 内部再次写入 —— 这正是会丢失更新的写法
      nested.update(() => true);
      data.products.push({ id: 'nested_write', active: false });
      return true;
    });

    assert.equal(
      nested.stats().maxWriteReentrancy,
      1,
      'mutator 内的嵌套 update 必须被检测到，便于在测试中暴露该写法'
    );
  } finally {
    fs.rmSync(freshDirectory, { recursive: true, force: true });
  }
});
