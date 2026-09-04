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

  update(mutator) {
    const data = clone(this.cache);
    const result = mutator(data);
    this.cache = data;
    this.flush();
    return result;
  }

  flush() {
    const payload = JSON.stringify(this.cache);
    this.pool.query('INSERT INTO app_state (id, payload) VALUES (1, ?) ON DUPLICATE KEY UPDATE payload = VALUES(payload)', [payload])
      .catch((error) => console.error('[mysql-store] flush failed:', error.message));
  }
}

async function createMysqlStore(options) {
  const store = new MysqlStore(options);
  await store.initialize();
  return store;
}

module.exports = { MysqlStore, createMysqlStore };
