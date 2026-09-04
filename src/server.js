const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { JsonStore } = require('./store');
const { createApp } = require('./app');

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

const port = Number(process.env.PORT || 3000);
const databasePath = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'db.json');
const store = new JsonStore(databasePath);
const server = http.createServer(createApp({ store }));

server.listen(port, '0.0.0.0', () => {
  console.log(`Campus Go mock API listening on http://localhost:${port}`);
  console.log(`JSON database: ${databasePath}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
