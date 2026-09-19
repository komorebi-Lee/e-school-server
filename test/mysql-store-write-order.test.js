const assert = require('node:assert/strict');
const test = require('node:test');
const { MysqlStore } = require('../src/mysql-store');

const FLUSH_SQL = 'INSERT INTO app_state (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)';

/**
 * 构造一个可控延迟的假连接池：第 N 次 query 在 delays[N] 毫秒后 resolve。
 *
 * 记录的是「提交完成」时刻的 payload，因此 commits 的顺序还原了真实的落库先后顺序，
 * 这正是判断写入是否乱序的关键。
 *
 * @param {number[]} delays 每次 query 的延迟毫秒数，缺省为 0。
 * @returns {{ commits: object[], query: Function }} 假连接池。
 */
function createFakePool(delays) {
  const commits = [];
  let issued = 0;
  return {
    commits,
    query(sql, params) {
      const position = issued;
      issued += 1;
      const delay = Number(delays[position] ?? 0);
      return new Promise((resolve) => {
        setTimeout(() => {
          commits.push({ position, sql, payload: JSON.parse(params[0]) });
          resolve([{ affectedRows: 1 }]);
        }, delay);
      });
    }
  };
}

/**
 * 构造一个已注入假连接池、且内存状态就绪的 store。
 *
 * @param {object} fakePool 假连接池。
 * @returns {{ store: MysqlStore, realPool: object }} store 与真实连接池（需在测试结束时 end）。
 */
function createStore(fakePool) {
  const store = new MysqlStore({
    host: '127.0.0.1',
    user: 'tester',
    password: 'secret',
    database: 'campus_go',
    seedData: { marker: 'seed' }
  });
  const realPool = store.pool;
  store.pool = fakePool;
  store.cache = { marker: 'A' };
  return { store, realPool };
}

/**
 * 等待一段时间，确保所有「已发出」的写入都已提交完成。
 *
 * 这是刻意不依赖 store.pendingFlush 的兜底等待：即使实现没有暴露可 await 的句柄，
 * 断言也依然能看到真实的落库顺序。
 *
 * @param {number} milliseconds 等待毫秒数，需大于假连接池的最大延迟。
 * @returns {Promise<void>} 等待完成的 Promise。
 */
async function settle(milliseconds = 120) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test('MysqlStore serializes flushes so the newest write wins', async () => {
  // 第一次落库慢（30ms）、第二次落库快（0ms）：不串行化时慢的旧写会后提交，覆盖成 A。
  const fakePool = createFakePool([30, 0]);
  const { store, realPool } = createStore(fakePool);
  try {
    const first = store.update((data) => {
      data.marker = 'A';
      return data.marker;
    });
    assert.equal(first, 'A', 'update() 必须同步返回 mutator 的结果，不得改成 async');

    const second = store.update((data) => {
      data.marker = 'B';
      return data.marker;
    });
    assert.equal(second, 'B', 'update() 必须同步返回 mutator 的结果，不得改成 async');
    assert.equal(store.read().marker, 'B', '内存状态应立刻可见，无需等待落库');

    // 新实现可 await 队列排空；旧实现没有该句柄，settle 兜底保证断言仍能观察到真实顺序。
    await store.pendingFlush;
    await settle();

    assert.equal(fakePool.commits.length, 2, '两次 update 应恰好产生两次落库');
    assert.ok(fakePool.commits.every((commit) => commit.sql === FLUSH_SQL), '落库应使用 upsert 语句');
    assert.equal(
      fakePool.commits[fakePool.commits.length - 1].payload.marker,
      'B',
      '最终落库必须是最新值 B（写入乱序时慢的旧写会最后提交，最终读到 A）'
    );
    assert.equal(fakePool.commits[0].payload.marker, 'A', '第一次提交应是当时的旧值 A');

    // await 之后不应再有任何悬挂写入。
    await settle(60);
    assert.equal(fakePool.commits.length, 2, 'await pendingFlush 之后不应存在悬挂写');
    assert.equal(store.dirty, false, '写入成功后 dirty 应被清除');
  } finally {
    await realPool.end();
  }
});

test('MysqlStore keeps flushing in order after a failed write', async () => {
  const commits = [];
  let issued = 0;
  const failingPool = {
    query(sql, params) {
      const position = issued;
      issued += 1;
      if (position === 0) {
        return Promise.reject(new Error('connection lost'));
      }
      return Promise.resolve().then(() => {
        commits.push({ sql, payload: JSON.parse(params[0]) });
        return [{ affectedRows: 1 }];
      });
    }
  };
  const { store, realPool } = createStore(failingPool);
  const logged = [];
  const originalError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  try {
    store.update((data) => {
      data.marker = 'B';
    });
    await store.pendingFlush;
    await settle(20);

    assert.equal(store.dirty, true, '写入失败后必须保留 dirty 供下次重试');
    assert.ok(
      logged.some((line) => line.includes('[mysql-store] flush failed')),
      '写入失败必须记录日志，不能静默吞掉'
    );

    // 失败不应阻断后续写入，且下一次写入必须落库最新值。
    store.update((data) => {
      data.marker = 'C';
    });
    await store.pendingFlush;
    await settle(20);

    assert.equal(commits.length, 1, '失败的那次不应落库，重试的那次应落库');
    assert.equal(commits[0].payload.marker, 'C', '重试写入应落库最新值 C');
    assert.equal(store.dirty, false, '重试成功后应清除 dirty');
  } finally {
    console.error = originalError;
    await realPool.end();
  }
});
