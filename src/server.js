const path = require('node:path');
const http = require('node:http');
const { JsonStore } = require('./store');
const { createApp } = require('./app');

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
