/**
 * HTTP 响应写出与静态资源工具。
 *
 * 负责 JSON 响应、CORS 来源解析，以及静态文件的直接返回。
 */

const fs = require('node:fs');
const path = require('node:path');

function sendJson(response, statusCode, body) {
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type,idempotency-key,authorization',
    'cache-control': 'no-store'
  };
  if (response.corsOrigin) {
    headers['access-control-allow-origin'] = response.corsOrigin;
    headers.vary = 'Origin';
  }
  response.writeHead(statusCode, headers);
  response.end(JSON.stringify(body));
}

function normalizeCorsOrigins(input) {
  const values = Array.isArray(input)
    ? input
    : String(input || '').split(',');
  return values.map((value) => value.trim()).filter(Boolean);
}

function resolveCorsOrigin(request, allowedOrigins) {
  const origin = String(request.headers.origin || '').trim();
  if (!origin) return '';
  if (allowedOrigins.includes('*')) return '*';
  return allowedOrigins.includes(origin) ? origin : '';
}

function sendStatic(response, filePath) {
  const extensions = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };
  const extension = path.extname(filePath);
  if (!fs.existsSync(filePath)) return false;
  response.writeHead(200, { 'content-type': extensions[extension] || 'application/octet-stream', 'cache-control': 'no-store' });
  response.end(fs.readFileSync(filePath));
  return true;
}

module.exports = { sendJson, normalizeCorsOrigins, resolveCorsOrigin, sendStatic };
