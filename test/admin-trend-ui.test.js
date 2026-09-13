const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

test('admin dashboard renders a platform revenue trend panel', () => {
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.css'), 'utf8');

  assert.ok(js.includes('/api/admin/revenue-trend'), 'dashboard should load the platform trend endpoint');
  assert.ok(js.includes('revenueTrendPanel'), 'dashboard should render a trend panel');
  assert.ok(js.includes('近7日营收趋势'), 'trend panel should use plain wording');
  assert.ok(css.includes('.trend-chart'), 'trend chart styles should exist');
});
