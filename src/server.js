const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { JsonStore } = require('./store');
const { createMysqlStore } = require('./mysql-store');
const { createApp } = require('./app');
const { initialData } = require('./store');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '..', '.env'));

function ensureDefaultProducts(store) {
  const defaultProducts = initialData().products;
  store.update((data) => {
    data.products ||= [];
    const existingIds = new Set(data.products.map((item) => item.id));
    for (const product of defaultProducts) {
      if (!existingIds.has(product.id)) data.products.push(product);
    }
  });
}

function ensureDefaultRechargePromos(store) {
  const defaultPromos = initialData().rechargePromos;
  store.update((data) => {
    data.rechargePromos ||= [];
    const existingKeys = new Set(data.rechargePromos.map((item) => `${item.pay}:${item.receive}`));
    for (const promo of defaultPromos) {
      if (!existingKeys.has(`${promo.pay}:${promo.receive}`)) data.rechargePromos.push(promo);
    }
  });
}

async function bootstrap() {
  const port = Number(process.env.PORT || 3000);
  const databasePath = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
  let store;
  if (process.env.MYSQL_HOST && process.env.MYSQL_DATABASE) {
    const { initialData } = require('./store');
    try {
      store = await createMysqlStore({
        host: process.env.MYSQL_HOST,
        port: process.env.MYSQL_PORT || 3306,
        user: process.env.MYSQL_USERNAME || 'root',
        password: process.env.MYSQL_PASSWORD || '',
        database: process.env.MYSQL_DATABASE,
        seedData: initialData(),
        importFilePath: databasePath
      });
      console.log(`MySQL store ready (${process.env.MYSQL_HOST}/${process.env.MYSQL_DATABASE})`);
    } catch (error) {
      console.error(`MySQL unavailable, falling back to JSON: ${error.message}`);
      store = new JsonStore(databasePath);
    }
  } else {
    store = new JsonStore(databasePath);
    console.log(`JSON database: ${databasePath}`);
  }
  ensureDefaultProducts(store);
  ensureDefaultRechargePromos(store);
  const server = http.createServer(createApp({ store }));
  server.listen(port, '0.0.0.0', () => {
    console.log(`Campus Go API listening on http://localhost:${port}`);
  });

  function shutdown() {
    server.close(() => process.exit(0));
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

bootstrap().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
