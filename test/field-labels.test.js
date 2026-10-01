/**
 * `requireString` 默认文案中文化的**防漂移**用例。
 *
 * ## 这份用例防的是什么
 *
 * `server/src/http/body.js` 的 `requireString` 在调用方不传 `message` 时，会抛出
 * `缺少必填字段：<中文标签>` / `<中文标签>长度不足（至少 N 个字）` / `<中文标签>过长（最多 N 个字）`。
 * 标签来自 `server/src/http/field-labels.js` 的 `FIELD_LABELS`。
 *
 * 这条链路有两个**静默失效**口子：
 *
 * 1. **调用点的字段名不在表里** → 用户看到 `brandNewField过长`。不会抛错、不会红，
 *    只有用户看得见。所以必须有一个用例**遍历全部调用点**去比对。
 * 2. **有人把默认文案改回英文** → 用户重新看到 `title is required`，同样静默。
 *
 * 光有这两条还不够 —— 如果**提取器本身变钝**（例如返回空数组），第 1 条会以
 * 「一个字段名都没检查」的方式**永远绿**。所以本文件还有「判据自测」：
 * 用合成源码证明提取器能解析全部四种实参形态，用独立标签表证明完整性判据
 * 真的能把缺失的字段名点出来。这与 `miniapp-runtime.test.js` 里
 * `serverMinLength` / `serverMaxLength` 的判据自测是同一手法。
 *
 * ## 为什么字段名要靠源码提取而不是手写清单
 *
 * 手写清单会跟着实现一起漂移：有人在 `app.js` 加一个 `requireString`，清单不会变，
 * 用例也不会红。提取出来的名字是从**真实调用点**来的，加了就红。
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { FIELD_LABELS, fieldLabel, IMAGE_FIELD_PATTERN } = require('../src/http/field-labels');

const SERVER_ROOT = path.join(__dirname, '..');
const SRC_ROOT = path.join(SERVER_ROOT, 'src');

/** 唯一的两个调用方（定义处 `http/body.js` 不算调用方）。 */
const CALL_SITE_FILES = ['src/app.js', 'src/domain/orders.js'];

/** 中日韩统一表意文字。用来判「文案是不是中文」。 */
const CJK = /[\u4e00-\u9fff]/;

/** 动态字段名的两种已知形态：循环变量 `field`，与 `` `images.${index}` ``。 */
const DYNAMIC_FIELD_ARG = 'field';
const DYNAMIC_IMAGE_ARG = '`images.${index}`';

/**
 * 读取 `server/` 下的一个文件。
 *
 * @param {string} relative 相对 `server/` 的路径，用 `/` 分隔。
 * @returns {string} 文件内容。
 */
function readSource(relative) {
  return fs.readFileSync(path.join(SERVER_ROOT, ...relative.split('/')), 'utf8');
}

/**
 * 从 `openIndex` 处的开括号出发，找到与之配对的闭括号下标。
 *
 * 只跟踪**同一种**括号的深度（`(`/`)`、`[`/`]`、`{`/`}` 三选一），因为调用方只需要
 * 定位 `requireString(...)` 的右括号 —— 它内部即使嵌了 `{ maxLength: 60 }` 也不影响
 * `(` 的配对。字符串与模板字面量内的括号一律跳过。
 *
 * @param {string} source 源码。
 * @param {number} openIndex 开括号下标。
 * @returns {number} 配对闭括号的下标。
 */
function matchDelimiter(source, openIndex) {
  const closing = { '(': ')', '[': ']', '{': '}' }[source[openIndex]];
  assert.ok(closing, `matchDelimiter 只接受开括号，收到 ${JSON.stringify(source[openIndex])}`);
  const open = source[openIndex];
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
 * 按**顶层**逗号切分实参列表。
 *
 * 顶层 = 不在任何括号/方括号/花括号内、也不在字符串内。没有这层处理，
 * `requireString(body.contact, 'contact', { minLength: 5, maxLength: 50 })` 会被切成
 * 4 段，第 2 个实参就取错了。
 *
 * @param {string} inner 括号内的原文。
 * @returns {string[]} 各实参的原文（已 trim）。
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
 * 提取源码里全部 `requireString(...)` 调用的实参。
 *
 * @param {string} source 源码。
 * @returns {{ index: number, line: number, args: string[] }[]} 调用点列表。
 */
function extractRequireStringCalls(source) {
  const calls = [];
  const needle = 'requireString(';
  let index = source.indexOf(needle);
  while (index >= 0) {
    const open = index + needle.length - 1;
    const close = matchDelimiter(source, open);
    calls.push({
      index,
      line: source.slice(0, index).split('\n').length,
      args: splitTopLevelArgs(source.slice(open + 1, close))
    });
    index = source.indexOf(needle, close + 1);
  }
  return calls;
}

/**
 * 若实参是单引号或双引号字符串字面量，取出其内容；否则返回 `null`。
 *
 * @param {string|undefined} argument 实参原文。
 * @returns {string|null} 字面量内容；非字面量返回 `null`。
 */
function literalFieldOf(argument) {
  if (typeof argument !== 'string') return null;
  const single = /^'([^']*)'$/.exec(argument);
  if (single) return single[1];
  const double = /^"([^"]*)"$/.exec(argument);
  if (double) return double[1];
  return null;
}

/**
 * 取动态站点所属 `for` 循环头里的字段名列表。
 *
 * 动态站点长这样（`app.js` 的收款账户与平台配置）：
 *
 * ```js
 * for (const [field, key] of [['settlementAccountName', 'settlementAccountName'], ...]) {
 *   const value = requireString(body[field], field, { maxLength: 80 });
 * ```
 *
 * 这 8 个名字**不在** `requireString` 的实参位置上，字面量断言覆盖不到，
 * 所以要从**调用点向上找最近的 `for (`**，再把循环头里的数组取出来。
 *
 * @param {string} source 源码。
 * @param {number} callIndex 调用点在源码里的下标。
 * @returns {string[]} 循环头里的字段名。
 */
function enclosingLoopFields(source, callIndex) {
  const loopIndex = source.lastIndexOf('for (', callIndex);
  assert.notEqual(loopIndex, -1, `动态站点（偏移 ${callIndex}）的字段名应来自一个 for 循环头`);
  const ofIndex = source.indexOf(' of ', loopIndex);
  assert.notEqual(ofIndex, -1, `未能定位 for 循环头的 of（偏移 ${loopIndex}）`);
  const open = source.indexOf('[', ofIndex);
  assert.notEqual(open, -1, `未能定位 for 循环头的数组（偏移 ${loopIndex}）`);
  const arrayText = source.slice(open, matchDelimiter(source, open) + 1);
  const names = [...arrayText.matchAll(/'([^']*)'/g)].map((match) => match[1]);
  // 成对形式 `[['字段', '键'], …]`：每对取第 1 个（字段名）。
  return /^\s*\[\s*\[/.test(arrayText) ? names.filter((_, index) => index % 2 === 0) : names;
}

/**
 * 列出目录下全部 `.js` 文件（递归）。
 *
 * @param {string} directory 目录。
 * @returns {string[]} 绝对路径列表。
 */
function listJsFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listJsFiles(full));
    else if (entry.name.endsWith('.js')) files.push(full);
  }
  return files;
}

/**
 * 挑出没有中文标签的字段名。
 *
 * @param {string[]} fieldNames 字段名（可含重复）。
 * @param {object} [labels] 标签表，默认 `FIELD_LABELS`。显式可传是为了让判据自测
 *   能用一张**独立**的小表验证本判据，从而在真表被改坏时仍能区分「判据坏了」还是「表坏了」。
 * @returns {string[]} 缺标签的字段名（去重，保持首次出现顺序）。
 */
function missingLabels(fieldNames, labels = FIELD_LABELS) {
  const seen = new Set();
  const missing = [];
  for (const name of fieldNames) {
    if (seen.has(name)) continue;
    seen.add(name);
    if (!Object.prototype.hasOwnProperty.call(labels, name)) missing.push(name);
  }
  return missing;
}

/** 提取全部调用点，并带上来源文件。 */
function allCallSites() {
  return CALL_SITE_FILES.flatMap((relative) =>
    extractRequireStringCalls(readSource(relative)).map((call) => ({ relative, ...call }))
  );
}

// ---------------------------------------------------------------------------
// 判据自测：先证明工具本身是锋利的，再用它去判代码
// ---------------------------------------------------------------------------

test('★ 判据自测：提取器能解析四种实参形态，否则下面的完整性断言会空转', () => {
  const synthetic = [
    "const a = requireString(body.title, 'title', { maxLength: 60 });",
    'const b = requireString(body.name, "name");',
    'const c = requireString(body[field], field, { maxLength: 80 });',
    'const d = requireString(image, `images.${index}`, { maxLength: 200 });',
    "const e = requireString(f(g, h), 'nested', { a: { b: 1 }, c: [1, 2] });",
    'const f = requireString(onlyValue);'
  ].join('\n');

  const calls = extractRequireStringCalls(synthetic);

  assert.equal(calls.length, 6, '6 个调用点应全部被提取到');
  assert.deepEqual(
    calls.map((call) => call.args[1]),
    ["'title'", '"name"', 'field', '`images.${index}`', "'nested'", undefined],
    '第 2 个实参应逐字取出（含动态形态与缺失实参）'
  );
  assert.deepEqual(
    calls.map((call) => call.line),
    [1, 2, 3, 4, 5, 6],
    '行号应逐条正确'
  );

  // 第 5 条同时证明：嵌套括号、对象字面量里的逗号、数组里的逗号都不会被误当分隔符。
  assert.equal(calls[4].args.length, 3, '顶层逗号切分不应被嵌套结构干扰');
  assert.equal(calls[4].args[0], 'f(g, h)');
  assert.equal(calls[4].args[2], '{ a: { b: 1 }, c: [1, 2] }');
});

test('★ 判据自测：完整性判据真的能把缺失的字段名点出来', () => {
  const labels = { title: '标题' };
  assert.deepEqual(
    missingLabels(['title', 'brandNewField'], labels),
    ['brandNewField'],
    '表里有的不该被点出来，表里没有的必须被点出来'
  );
  assert.deepEqual(missingLabels(['title'], labels), []);
  assert.deepEqual(
    missingLabels(['title'], {}),
    ['title'],
    '★ 若把表清空，判据必须把 title 点出来 —— 否则它就是永远绿的'
  );
});

// ---------------------------------------------------------------------------
// 完整性：每个调用点的字段名都要有中文标签
// ---------------------------------------------------------------------------

test('每个 requireString 调用点的字面量字段名都有中文标签', () => {
  const calls = allCallSites();

  // 防「提取器变钝 → 本断言空转」。故意用**下界**而不是精确值：
  // 精确值会随无关改动漂移，下界只负责挡住「一个都没提取到」这类失效。
  assert.ok(calls.length >= 100, `只提取到 ${calls.length} 个调用点，提取器可能已失效`);

  const literalNames = calls
    .map((call) => literalFieldOf(call.args[1]))
    .filter((name) => name !== null);
  assert.ok(literalNames.length > 0, '一个字面量字段名都没提取到');

  const missing = missingLabels(literalNames);
  assert.equal(
    missing.length,
    0,
    `以下字段名在 FIELD_LABELS 中缺少中文标签，用户会直接看到原始字段名：${missing.join(', ')}`
  );
});

test('两处动态站点的字段名列表也有中文标签，且 `body[field], field` 形式恰好 2 处', () => {
  const calls = allCallSites();

  const dynamicSites = calls.filter(
    (call) => call.args[0] === 'body[field]' && call.args[1] === DYNAMIC_FIELD_ARG
  );
  assert.equal(
    dynamicSites.length,
    2,
    '★ `body[field], field` 形式的调用点恰好 2 处（app.js 的收款账户、平台配置）。'
      + '数量变化时必须先给新站点的字段名补中文标签，再有意识地更新这个计数 —— '
      + '否则新站点的字段名会静默落回原始英文名。'
  );

  const loopNames = dynamicSites.flatMap((call) => enclosingLoopFields(readSource(call.relative), call.index));

  // 这 8 个名字只以「循环变量」形式出现，上面的字面量断言覆盖不到，必须单独钉住。
  for (const name of [
    'settlementAccountName',
    'settlementBank',
    'settlementAccount',
    'brandName',
    'schoolName',
    'campusName',
    'servicePhone',
    'serviceWechat'
  ]) {
    assert.ok(loopNames.includes(name), `动态站点的字段名列表里应有 ${name}（实际取到：${loopNames.join(', ')}）`);
  }

  const missing = missingLabels(loopNames);
  assert.equal(missing.length, 0, `动态站点的以下字段名缺少中文标签：${missing.join(', ')}`);
});

test('动态字段名只有两种已知形态，出现第三种时必须显式处理', () => {
  const unknown = allCallSites().filter(
    (call) =>
      literalFieldOf(call.args[1]) === null
      && call.args[1] !== DYNAMIC_FIELD_ARG
      && call.args[1] !== DYNAMIC_IMAGE_ARG
  );

  assert.equal(
    unknown.length,
    0,
    '★ 出现未处理的动态字段名形态，它会绕过 FIELD_LABELS 落回原始字段名：'
      + unknown.map((call) => `${call.relative}:${call.line} -> ${call.args[1]}`).join('; ')
  );
});

test('`images.<n>` 形态的字段名翻成「第 N 张图片」，不是「images.0过长」', () => {
  // 这三个站点的字段名由模板字面量产生，无法静态枚举，只能断言**翻译规则**本身。
  assert.equal(fieldLabel('images.0'), '第 1 张图片', '下标 0 起 → 展示 1 起');
  assert.equal(fieldLabel('images.5'), '第 6 张图片');
  assert.equal(IMAGE_FIELD_PATTERN.test('images.0'), true);
  assert.equal(IMAGE_FIELD_PATTERN.test('images'), false, '不带下标的 images 不是图片下标形态');
  assert.equal(IMAGE_FIELD_PATTERN.test('images.x'), false);
  assert.equal(IMAGE_FIELD_PATTERN.test('ximages.0'), false, '必须整串匹配');
});

// ---------------------------------------------------------------------------
// 默认文案：必须是中文，且旧英文模板不得复活
// ---------------------------------------------------------------------------

test('requireString 的三条默认文案含中日韩字符', () => {
  const source = readSource('src/http/body.js');
  const functionIndex = source.indexOf('function requireString(');
  assert.notEqual(functionIndex, -1, '未能在 body.js 中定位 requireString');
  // 先配平形参表的 `(`，再配平函数体的 `{` —— 只取到形参表的 `)` 会漏掉整个函数体。
  const paramsClose = matchDelimiter(source, source.indexOf('(', functionIndex));
  const bodyOpen = source.indexOf('{', paramsClose);
  assert.notEqual(bodyOpen, -1, '未能在 body.js 中定位 requireString 的函数体');
  const functionSource = source.slice(functionIndex, matchDelimiter(source, bodyOpen) + 1);

  const throws = [...functionSource.matchAll(/new ApiError\(/g)].map((match) => match.index);
  assert.equal(throws.length, 3, `requireString 应有 3 个抛错分支（缺失 / 过短 / 过长），实际 ${throws.length} 个`);

  const messages = throws.map((index) => {
    const open = index + 'new ApiError('.length - 1;
    return splitTopLevelArgs(functionSource.slice(open + 1, matchDelimiter(functionSource, open)))[2];
  });

  for (const [index, message] of messages.entries()) {
    assert.ok(message, `第 ${index + 1} 个抛错分支取不到文案`);
    assert.ok(CJK.test(message), `第 ${index + 1} 个抛错分支的默认文案不含中日韩字符：${message}`);
  }

  // 反向：旧英文模板不得复活。只扫**函数体**而不是整个文件 —— 文件头注释里正当地
  // 引用了旧模板（「默认文案已由英文 `${field} is required` 系列改为中文」），
  // 那不是一条会抛出去的文案。注释不产生错误消息，函数体才产生。
  for (const legacy of ['is required', 'is too short', 'is too long']) {
    assert.equal(
      new RegExp(`\\$\\{field\\}\\s+${legacy}`).test(functionSource),
      false,
      `requireString 函数体里仍存在英文默认模板 \`\${field} ${legacy}\``
    );
  }
});

test('★ 判据自测：fieldLabel 对未知字段回落为原始字段名，而不是 undefined', () => {
  assert.equal(fieldLabel('brandNewField'), 'brandNewField', '未知字段必须回落为原始字段名');
  assert.equal(typeof fieldLabel('brandNewField'), 'string', '回落值必须是字符串');
  assert.notEqual(fieldLabel('brandNewField'), undefined);
  assert.equal(fieldLabel('brandNewField').includes('undefined'), false, '不得出现「undefined过长」这类文案');

  // 原型成员不得被误当标签 —— 用 `FIELD_LABELS[name]` 的写法会命中它们并返回函数。
  assert.equal(fieldLabel('constructor'), 'constructor');
  assert.equal(fieldLabel('toString'), 'toString');

  // 非字符串输入的兜底。
  assert.equal(fieldLabel(undefined), '');
  assert.equal(fieldLabel(null), '');
  assert.equal(fieldLabel(42), '');
});

// ---------------------------------------------------------------------------
// 使用方清单：新文件开始调用 requireString 时，逼迫一次有意识的决定
// ---------------------------------------------------------------------------

test('requireString 的使用方只有显式枚举的 4 个文件', () => {
  const users = listJsFiles(SRC_ROOT)
    .filter((file) => fs.readFileSync(file, 'utf8').includes('requireString('))
    .map((file) => path.relative(SERVER_ROOT, file).split(path.sep).join('/'))
    .sort();

  assert.deepEqual(
    users,
    [
      'src/app.js', // 调用方
      'src/domain/orders.js', // 调用方
      'src/http/body.js', // 定义处
      'src/http/field-labels.js' // 仅在注释里提到
    ],
    '★ 出现新的 requireString 使用方时，必须先确认它可能产生的字段名都进了 FIELD_LABELS，'
      + '再有意识地更新这个列表 —— 否则它的字段名会静默落回原始英文名。'
  );
});
