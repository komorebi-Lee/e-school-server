/**
 * 管理员口令哈希与校验，以及按请求路径推导所需管理员权限。
 *
 * 自 app.js 拆出，便于独立复用与测试。
 */

const { randomBytes, scryptSync, timingSafeEqual } = require('node:crypto');

function hashPassword(password) {
  const salt = randomBytes(16);
  const passwordHash = scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${passwordHash.toString('hex')}`;
}

function verifyPasswordHash(suppliedPassword, storedHash) {
  const parts = String(storedHash || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  let salt;
  let expectedHash;
  try {
    salt = Buffer.from(parts[1], 'hex');
    expectedHash = Buffer.from(parts[2], 'hex');
  } catch {
    return false;
  }
  if (salt.length !== 16 || expectedHash.length !== 64) return false;
  const actualHash = scryptSync(String(suppliedPassword || ''), salt, 64);
  return timingSafeEqual(actualHash, expectedHash);
}

function adminPermissionForRequest(pathname) {
  if (pathname.startsWith('/api/admin/admins')) return 'ADMIN_MANAGE';
  if (pathname.startsWith('/api/admin/uploads')) return 'FINANCE_MANAGE';
  if (/^\/api\/admin\/merchants\/[^/]+\/settle$/.test(pathname)) return 'FINANCE_MANAGE';
  if (pathname.startsWith('/api/admin/settings')
    || pathname.startsWith('/api/admin/subscribe-templates')) return 'CONFIG_MANAGE';
  if (pathname.startsWith('/api/admin/payment-orders')
    || pathname.startsWith('/api/admin/payment-reconciliations')
    || pathname.startsWith('/api/admin/finance-tasks')
    || pathname.startsWith('/api/admin/payout-requests')
    || pathname.startsWith('/api/admin/finance-events')) return 'FINANCE_MANAGE';
  if (pathname.startsWith('/api/admin/products')
    || pathname.startsWith('/api/admin/recharge-promos')
    || pathname.startsWith('/api/admin/product-reviews')
    || pathname.startsWith('/api/admin/market-items')
    || pathname.startsWith('/api/admin/forum-posts')) return 'CATALOG_MANAGE';
  if (pathname.startsWith('/api/admin/merchants')
    || pathname.startsWith('/api/admin/qualification-renewals')
    || pathname.startsWith('/api/admin/merchant-scores')
    || pathname.startsWith('/api/admin/service-risk')
    || pathname.startsWith('/api/admin/score-cases')) return 'MERCHANT_MANAGE';
  if (pathname.startsWith('/api/admin/orders')
    || pathname.startsWith('/api/admin/phone-card-orders')
    || pathname.startsWith('/api/admin/recharge-orders')
    || pathname.startsWith('/api/admin/broadband-applications')
    || pathname.startsWith('/api/admin/plate-applications')
    || pathname.startsWith('/api/admin/after-sales')
    || pathname.startsWith('/api/admin/leads')
    || pathname.startsWith('/api/admin/sla-alerts')
    || pathname.startsWith('/api/admin/patrol/run')
    || pathname.startsWith('/api/admin/notifications')
    || pathname.startsWith('/api/admin/subscribe-messages')) return 'ORDER_MANAGE';
  if (pathname.startsWith('/api/admin/overview')
    || pathname.startsWith('/api/admin/operations-report')) return 'REPORT_VIEW';
  return 'ADMIN_MANAGE';
}

module.exports = { hashPassword, verifyPasswordHash, adminPermissionForRequest };
