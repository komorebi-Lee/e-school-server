/**
 * `app.js` 里 `new ApiError` 文案**中文化**的防漂移用例。
 *
 * ## 这份用例守的是什么
 *
 * **守的是「用户看不到英文」，不是「文案风格统一」。**
 * 这句话很重要，因为它决定了失败时的处置方式：转红意味着**有中文用户会看到英文**，
 * 而不是「措辞不够好」。所以它是硬伤，不是风格问题。
 *
 * `app.js` 的 366 个 `new ApiError` 里，原先有 **99 处**的文案不含中文（涉及 28 个错误码），
 * 例如 `Order not found`、`Unsupported role`、`items must be a non-empty array`。
 * 这些文案会直接送到用户眼前：`miniprogram/lib/cloud-request.js` 把
 * `response.data.error.message` 塞进 `new Error(...)`，页面再 `wx.showToast`。
 *
 * ## 检测器必须**查表求值**，否则断言是假的
 *
 * `*_NOT_FOUND` 家族的 70 处已收口到 `http/error-messages.js`，调用点写成
 * `notFoundMessage('ORDER_NOT_FOUND')` —— **这串源码里一个中文字都没有**。
 * 如果检测器只读源码原文，它会把这 70 处全部误判成英文；反过来，只要有人把
 * 检测器写成「源码里没有中文就算违规」，他也会被迫放弃表驱动。
 * 所以检测器必须把 `notFoundMessage('X')` 解析成表里 `X` 对应的文案再判。
 * 这正是下面第一条用例（判据自测）要钉住的东西。
 *
 * ## 与 T45 用例的分工
 *
 * `http/body.js` 的三条默认文案由 `test/field-labels.test.js` 覆盖，本文件**不重复断言**。
 * 本文件只管 `app.js` 的硬编码文案。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { NOT_FOUND_MESSAGES, productNotFoundMessage } = require('../src/http/error-messages');

const SERVER_ROOT = path.join(__dirname, '..');
const APP_SOURCE = fs.readFileSync(path.join(SERVER_ROOT, 'src', 'app.js'), 'utf8');

/** 中日韩统一表意文字。用来判「文案是不是中文」。 */
const CJK = /[\u4e00-\u9fff]/;

/** 表驱动形态：`notFoundMessage('ORDER_NOT_FOUND')`。 */
const NOT_FOUND_CALL = /^notFoundMessage\(\s*'([^']*)'\s*\)$/;

/** 带 id 的形态：`productNotFoundMessage(productId)`。 */
const PRODUCT_NOT_FOUND_CALL = /^productNotFoundMessage\([\s\S]*\)$/;

/**
 * 从 `openIndex` 处的开括号出发找配对闭括号，跳过字符串与模板字面量内部。
 *
 * @param {string} source 源码。
 * @param {number} openIndex 开括号下标。
 * @returns {number} 配对闭括号下标。
 */
function matchDelimiter(source, openIndex) {
  const closing = { '(': ')', '[': ']', '{': '}' }[source[openIndex]];
  const open = source[openIndex];
  assert.ok(closing, `matchDelimiter 只接受开括号，收到 ${JSON.stringify(source[openIndex])}`);
  let depth = 0;
  let quote = null;
  for (let index = openIndex; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === closing) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(`未找到 ${open} 的配对 ${closing}（起点 ${openIndex}）`);
}

/**
 * 按**顶层**逗号切分实参列表（顶层 = 不在括号内、也不在字符串内）。
 *
 * @param {string} inner 括号内的原文。
 * @returns {string[]} 各实参原文（已 trim）。
 */
function splitTopLevelArgs(inner) {
  const args = [];
  let current = '';
  let depth = 0;
  let quote = null;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote) {
      current += char;
      if (char === '\\') {
        current += inner[index + 1] || '';
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

/**
 * 去掉源码片段里的 `${...}` 插值段（深度计数，容忍插值内的嵌套花括号）。
 *
 * @param {string} text 源码片段。
 * @returns {string} 去掉插值后的片段。
 */
function stripInterpolations(text) {
  let output = '';
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '$' && text[index + 1] === '{') {
      let depth = 0;
      let cursor = index + 1;
      for (; cursor < text.length; cursor += 1) {
        if (text[cursor] === '{') depth += 1;
        else if (text[cursor] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      index = cursor;
      continue;
    }
    output += text[index];
  }
  return output;
}

/**
 * 把 `\uXXXX` 解码成真实字符。
 *
 * @param {string} text 源码片段。
 * @returns {string} 解码后的片段。
 */
function decodeUnicodeEscapes(text) {
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (whole, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * 把一条文案实参解析成**静态可判定**的文本。
 *
 * 三种形态：
 * - `notFoundMessage('X')` → 查 `table` 取 `X` 的文案（查不到返回 `null`）；
 * - `productNotFoundMessage(...)` → 用占位 id 求值；
 * - 其它 → 去掉 `${...}` 插值、解码 `\uXXXX` 后的原文。
 *
 * @param {string|undefined} argument 第 3 个实参原文。
 * @param {object} [table] 错误码 → 文案的表，默认 `NOT_FOUND_MESSAGES`。
 *   显式可传是为了让判据自测能用一张**独立**的小表验证本判据。
 * @returns {{ text: string|null, escaped: boolean, viaTable: boolean }} 解析结果；
 *   `text` 为 `null` 表示无法静态判定（会被当作违规）。
 */
function resolveMessage(argument, table = NOT_FOUND_MESSAGES) {
  if (typeof argument !== 'string') return { text: null, escaped: false, viaTable: false };

  const tableCall = NOT_FOUND_CALL.exec(argument);
  if (tableCall) {
    const code = tableCall[1];
    const hit = Object.prototype.hasOwnProperty.call(table, code) ? table[code] : null;
    return { text: hit, escaped: false, viaTable: true };
  }
  if (PRODUCT_NOT_FOUND_CALL.test(argument)) {
    return { text: productNotFoundMessage('__ID__'), escaped: false, viaTable: true };
  }

  const withoutInterpolation = stripInterpolations(argument);
  const escaped = /\\u[0-9a-fA-F]{4}/.test(withoutInterpolation);
  return { text: decodeUnicodeEscapes(withoutInterpolation), escaped, viaTable: false };
}

/**
 * 判断一条文案实参在**静态可判定**的意义上是否含中文。
 *
 * @param {string|undefined} argument 第 3 个实参原文。
 * @param {object} [table] 错误码 → 文案的表。
 * @returns {{ decidable: boolean, hasCjk: boolean, readable: string, escaped: boolean, viaTable: boolean }} 判定结果。
 */
function classify(argument, table = NOT_FOUND_MESSAGES) {
  const resolved = resolveMessage(argument, table);
  if (resolved.text === null) {
    return { decidable: false, hasCjk: false, readable: '', escaped: false, viaTable: resolved.viaTable };
  }
  return {
    decidable: true,
    hasCjk: CJK.test(resolved.text),
    readable: resolved.text,
    escaped: resolved.escaped,
    viaTable: resolved.viaTable
  };
}

/**
 * 提取源码里全部 `new ApiError(...)` 调用。
 *
 * @param {string} source 源码。
 * @returns {{ line: number, code: string, message: string|undefined }[]} 调用点。
 */
function extractApiErrors(source) {
  const calls = [];
  const needle = 'new ApiError(';
  let index = source.indexOf(needle);
  while (index >= 0) {
    const open = index + needle.length - 1;
    const close = matchDelimiter(source, open);
    const args = splitTopLevelArgs(source.slice(open + 1, close));
    const codeArg = (args[1] || '').trim();
    const codeMatch = /^'([^']*)'$/.exec(codeArg);
    calls.push({
      line: source.slice(0, index).split('\n').length,
      code: codeMatch ? codeMatch[1] : codeArg,
      message: args[2]
    });
    index = source.indexOf(needle, close + 1);
  }
  return calls;
}

/** 全部 `new ApiError` 调用点。 */
const API_ERROR_SITES = extractApiErrors(APP_SOURCE);

/** 取出文案字面量的内容（去掉两端引号）。 */
const MESSAGE_LITERAL = /^['"`]([\s\S]*)['"`]$/;

/**
 * 取一个调用点文案的纯文本（去引号），用于和例外登记表比对。
 *
 * @param {{ message: string|undefined }} site 调用点。
 * @returns {string|null} 纯文本；不可判定时返回 `null`。
 */
function messageTextOf(site) {
  const resolved = resolveMessage(site.message);
  if (resolved.text === null) return null;
  const match = MESSAGE_LITERAL.exec(resolved.text);
  return match ? match[1] : resolved.text;
}

/**
 * 允许「同一个错误码 + 站点专属文案」的**显式例外**。
 *
 * 表里给的是该码的**通用**文案。下面这几处说的是**更具体、且不同的事实**，
 * 换成通用文案会变成**错误信息**（不是措辞变差）：
 *
 * - `PRODUCT_NOT_FOUND` / `未找到本店库存商品`：商家查自己店里的库存流水。
 *   商品很可能确实存在，只是**本店没有该商品的流水** —— 说「商品不存在」是错的。
 * - `PRODUCT_NOT_FOUND` / `商品已下架`：商品存在但已下架（`active === false`）。
 *   说「商品不存在」是错的；且「已下架」明确告诉用户**别重试**。
 * - `PLATE_APPLICATION_NOT_FOUND` / `牌照辅助申请不存在`：该站点的实体是
 *   「牌照辅助申请」这一子类，比表里的「牌照申请」更精确。
 * - `MERCHANT_NOT_FOUND` / `未找到评价关联商家`：商家是**通过评价的商品**反查出来的，
 *   说清「关联」能帮运营定位。
 *
 * 登记在这里而不是散在断言里，是为了让**新增**一处绕过立刻转红 ——
 * 逼迫一次有意识的决定：要么改用通用文案，要么在这里登记并写明理由。
 */
const CONTEXT_SPECIFIC_OVERRIDES = {
  PRODUCT_NOT_FOUND: ['未找到本店库存商品', '商品已下架'],
  PLATE_APPLICATION_NOT_FOUND: ['牌照辅助申请不存在'],
  MERCHANT_NOT_FOUND: ['未找到评价关联商家']
};

/** 例外登记表的扁平化键集合。 */
const ALLOWED_OVERRIDE_KEYS = new Set(
  Object.entries(CONTEXT_SPECIFIC_OVERRIDES).flatMap(([code, texts]) =>
    texts.map((text) => `${code}\u0000${text}`)
  )
);

// ---------------------------------------------------------------------------
// 判据自测：先证明检测器是锋利的，再用它去判代码
// ---------------------------------------------------------------------------

test('★ 判据自测：检测器能分辨英文 / 中文 / 表驱动 / 未登记的码', () => {
  // ① 纯英文字面量 → 必须判为违规
  assert.equal(classify("'Payment order not found'").hasCjk, false, '英文文案必须被判为违规');

  // ② 中文字面量 → 必须判为合规
  assert.equal(classify("'支付单不存在'").hasCjk, true, '中文文案必须被判为合规');

  // ③ 表驱动形态 → 必须**查表**后判为合规。
  //    若检测器只看源码原文，这里会返回 false，主不变量就会对 70 处误报。
  const viaTable = classify("notFoundMessage('PAYMENT_NOT_FOUND')");
  assert.equal(viaTable.viaTable, true, 'notFoundMessage(...) 必须被识别为表驱动形态');
  assert.equal(viaTable.hasCjk, true, '★ 表驱动形态必须查表求值后再判 —— 源码里没有中文不代表文案是英文');

  // ④ 未登记的码 → 不可静态判定 → 必须判为违规（否则表里漏了码也没人发现）
  const unknownCode = classify("notFoundMessage('BRAND_NEW_CODE')", {});
  assert.equal(unknownCode.decidable, false, '表里没有的码必须判为「不可判定」');
  assert.equal(unknownCode.hasCjk, false, '不可判定必须按违规处理，不能默认放行');

  // ⑤ 带插值的模板字面量 → 去掉 `${...}` 后按剩余文本判
  assert.equal(classify('`商品 ${productId} 不存在`').hasCjk, true, '插值不该影响判定');
  assert.equal(classify('`Product ${productId} not found`').hasCjk, false, '英文模板必须被判为违规');

  // ⑥ 带 id 的函数形态 → 必须按求值结果判
  assert.equal(classify('productNotFoundMessage(productId)').hasCjk, true);

  // ⑦ 转义写法 → 解码后再判
  assert.equal(classify("'\\u5546\\u54c1\\u4e0d\\u5b58\\u5728'").hasCjk, true, '\\uXXXX 转义必须先解码');
  assert.equal(classify("'\\u5546\\u54c1\\u4e0d\\u5b58\\u5728'").escaped, true, '转义写法必须被标出');
});

// ---------------------------------------------------------------------------
// 主不变量
// ---------------------------------------------------------------------------

test('★ app.js 里不含中文的 ApiError 文案数 === 0', () => {
  // 防「提取器变钝 → 本断言空转」。用**下界**而不是精确值：精确值会随无关改动漂移。
  assert.ok(API_ERROR_SITES.length >= 300, `只提取到 ${API_ERROR_SITES.length} 个调用点，提取器可能已失效`);

  // ★ 这一行守的是「**用户看不到英文**」，不是「文案风格统一」。
  // 转红意味着有中文用户会在 wx.showToast 里看到英文，是硬伤，不是风格问题。
  const offenders = API_ERROR_SITES.filter((site) => !classify(site.message).hasCjk);

  assert.equal(
    offenders.length,
    0,
    '以下 ApiError 文案不含中文，中文用户会在 wx.showToast 里直接看到英文：\n'
      + offenders
        .map((site) => `  app.js:${site.line}  [${site.code}]  ${site.message}`)
        .join('\n')
      + '\n「不存在」类请走 http/error-messages.js 的 notFoundMessage(码)；其余直接写中文。'
  );
});

test('app.js 里不再有 `\\uXXXX` 转义写成的中文（可读性）', () => {
  const escaped = API_ERROR_SITES.filter((site) => classify(site.message).escaped);

  assert.equal(
    escaped.length,
    0,
    '以下文案用 \\uXXXX 转义写成，源码里不可读 —— 请改成明文中文（零行为变更）：\n'
      + escaped.map((site) => `  app.js:${site.line}  [${site.code}]  ${site.message}`).join('\n')
  );
});

// ---------------------------------------------------------------------------
// 收口不变量：表驱动的部分不得被绕过
// ---------------------------------------------------------------------------

test('每个 notFoundMessage(码) 的码都在 NOT_FOUND_MESSAGES 里', () => {
  const unknown = [];
  for (const site of API_ERROR_SITES) {
    const call = NOT_FOUND_CALL.exec(site.message || '');
    if (!call) continue;
    if (!Object.prototype.hasOwnProperty.call(NOT_FOUND_MESSAGES, call[1])) {
      unknown.push(`app.js:${site.line} -> ${call[1]}`);
    }
  }

  assert.equal(
    unknown.length,
    0,
    `以下错误码没有登记在 NOT_FOUND_MESSAGES 里，会静默回落成通用文案：${unknown.join('; ')}`
  );
});

test('★ 表里已登记的码不得在 app.js 里被内联字符串绕过（例外须显式登记）', () => {
  const tableCodes = new Set(Object.keys(NOT_FOUND_MESSAGES));

  // ① 违规 = 用了表里的码 + 没走 notFoundMessage + 也不在例外登记表里
  const bypasses = API_ERROR_SITES.filter((site) => {
    if (!tableCodes.has(site.code)) return false;
    if (resolveMessage(site.message).viaTable) return false;
    return !ALLOWED_OVERRIDE_KEYS.has(`${site.code}\u0000${messageTextOf(site)}`);
  });

  assert.equal(
    bypasses.length,
    0,
    '★ 以下调用点给已收口的错误码写了未登记的内联文案 —— 同一个码的措辞又变成两处，必然漂移：\n'
      + bypasses.map((site) => `  app.js:${site.line}  [${site.code}]  ${site.message}`).join('\n')
      + '\n要么改用 notFoundMessage(码)，要么在 CONTEXT_SPECIFIC_OVERRIDES 里登记并写明理由。'
  );

  // ② 反向控制：例外登记表不得有失效条目。
  //    没有这条，删掉一个站点后残留的登记会**掩盖将来真正的绕过**（判据变钝而无人知）。
  const liveKeys = new Set(
    API_ERROR_SITES.filter((site) => tableCodes.has(site.code) && !resolveMessage(site.message).viaTable)
      .map((site) => `${site.code}\u0000${messageTextOf(site)}`)
  );
  const stale = [...ALLOWED_OVERRIDE_KEYS].filter((key) => !liveKeys.has(key));
  assert.equal(
    stale.length,
    0,
    '★ 例外登记已失效（app.js 里已不存在对应的内联文案），请删掉它，'
      + '否则它会掩盖将来真正的绕过：' + stale.map((key) => key.replace('\u0000', ' / ')).join('; ')
  );
});

test('★ productNotFoundMessage 与表里的 PRODUCT_NOT_FOUND 同源', () => {
  const withId = productNotFoundMessage('prod_abc123');

  assert.ok(withId.includes('prod_abc123'), '带 id 的文案必须真的带上那个 id');
  assert.equal(
    withId.replace('prod_abc123', '').replace(/\s+/g, ''),
    NOT_FOUND_MESSAGES.PRODUCT_NOT_FOUND,
    '★ 去掉 id 后必须与表里 PRODUCT_NOT_FOUND 逐字一致 —— '
      + '否则同一概念在两处漂移，用户会在不同页面看到不同说法'
  );
});
