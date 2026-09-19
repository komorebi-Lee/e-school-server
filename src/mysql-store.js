const fs = require('node:fs');
const mysql = require('mysql2/promise');

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

class MysqlStore {
  constructor({ host, port, user, password, database, seedData, importFilePath }) {
    this.storage = 'mysql';
    this.filePath = importFilePath || 'mysql://app_state';
    this.pool = mysql.createPool({
      host,
      port: Number(port || 3306),
      user,
      password,
      database,
      connectionLimit: 4,
      connectTimeout: 8000
    });
    this.seedData = seedData;
    this.importFilePath = importFilePath;
    this.cache = null;
    // 串行写入队列：保证多次 update() 的落库顺序与调用顺序一致。
    this.pendingFlush = Promise.resolve();
    // 标记最近一次写入是否失败，供重试与排障使用。
    this.dirty = false;
  }

  async initialize() {
    const connection = await this.pool.getConnection();
    try {
      await connection.query(`CREATE TABLE IF NOT EXISTS app_state (
        id TINYINT NOT NULL PRIMARY KEY,
        payload LONGTEXT NOT NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      const [rows] = await connection.query('SELECT payload FROM app_state WHERE id = 1');
      if (rows.length > 0) {
        this.cache = JSON.parse(rows[0].payload);
        console.log(`MySQL store loaded existing state (updated_at: ${rows[0].updated_at})`);
        return;
      }
      this.cache = this.loadInitialData();
      await connection.query('INSERT INTO app_state (id, payload) VALUES (1, ?)', [JSON.stringify(this.cache)]);
      console.log('MySQL store initialized with seed data');
    } finally {
      connection.release();
    }
  }

  loadInitialData() {
    if (this.importFilePath && fs.existsSync(this.importFilePath)) {
      try {
        const imported = JSON.parse(fs.readFileSync(this.importFilePath, 'utf8'));
        if (imported && Array.isArray(imported.products)) {
          console.log(`Importing existing JSON database from ${this.importFilePath}`);
          return imported;
        }
      } catch (error) {
        console.warn(`Could not import ${this.importFilePath}: ${error.message}`);
      }
    }
    return this.seedData;
  }

  read() {
    return clone(this.cache);
  }

  /**
   * 同步修改内存状态，并把这次修改排进串行写入队列。
   *
   * 必须保持同步：调用方在全仓有大量「同步取用返回值」的用法，
   * 因此这里只负责排队，绝不 await，也不会返回 Promise。
   *
   * @param {(data: object) => any} mutator 修改内存状态的函数，返回值即本方法的返回值。
   * @returns {any} mutator 的返回值。
   */
  update(mutator) {
    const data = clone(this.cache);
    const result = mutator(data);
    this.cache = data;
    this.dirty = true;
    this.pendingFlush = this.flush();
    return result;
  }

  /**
   * 把当前内存状态排入串行写入队列并返回该次写入的 Promise。
   *
   * 连接池 connectionLimit 为 4，如果每次 update() 都并发发出
   * `INSERT ... ON DUPLICATE KEY UPDATE`，多个查询可能乱序提交，
   * 导致先发出的旧值覆盖后发出的新值。这里用 pendingFlush 链式队列
   * 保证写入严格按调用顺序执行。
   *
   * @returns {Promise<void>} 该次写入完成的 Promise（可 await）。
   */
  flush() {
    const payload = JSON.stringify(this.cache);
    const previous = this.pendingFlush || Promise.resolve();
    const current = previous
      // 上一次写入失败不应阻断后续写入；失败原因已在 writePayload 内记录。
      .catch(() => {})
      .then(() => this.writePayload(payload));
    this.pendingFlush = current;
    return current;
  }

  /**
   * 执行一次实际落库。失败时记录日志并保留 dirty 标记，供下次写入重试。
   *
   * @param {string} payload 序列化后的完整状态。
   * @returns {Promise<void>} 写入完成的 Promise。
   */
  writePayload(payload) {
    return this.pool
      .query('INSERT INTO app_state (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [payload])
      .then(() => {
        this.dirty = false;
      })
      .catch((error) => {
        this.dirty = true;
        console.error('[mysql-store] flush failed:', error.message);
      });
  }
}

async function createMysqlStore(options) {
  const store = new MysqlStore(options);
  await store.initialize();
  return store;
}

module.exports = { MysqlStore, createMysqlStore };
