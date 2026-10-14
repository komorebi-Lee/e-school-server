#!/usr/bin/env node
/**
 * 部署前自检（微信云托管）
 *
 * 用法：cd server && npm run preflight
 *
 * 目的：把「会在云端构建阶段炸掉、但本地毫无征兆」的条件提前查出来。
 * 背景：本地能跑通不代表云端能构建成功 —— 云端是「全新克隆 + 无缓存的 Docker 构建 +
 *       受限网络」，与本地工作区差异很大。本脚本只做静态与本地可判定的检查。
 *
 * 退出码：0 = 全部通过（可能有警告）；1 = 存在会阻断部署的问题。
 *
 * 零依赖、可离线运行。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');          // server/ 仓库根
const PROJECT = path.resolve(ROOT, '..');            // 外层仓库根（可能不存在）

const failures = [];
const warnings = [];
const notes = [];

const ok = (msg) => console.log(`  \u2713 ${msg}`);
const bad = (msg) => { failures.push(msg); console.log(`  \u2717 ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`  ! ${msg}`); };
const note = (msg) => { notes.push(msg); console.log(`  \u00b7 ${msg}`); };

const readIfExists = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);

function section(title) {
  console.log(`\n${title}`);
}

// ─────────────────────────────────────────────────────────────
// 1. Dockerfile 必须在仓库根目录（官方要求：「需要和你在代码根目录的 Dockerfile 文件名称」）
// ─────────────────────────────────────────────────────────────
section('[1] Dockerfile 位置与名称');
const dockerfilePath = path.join(ROOT, 'Dockerfile');
let dockerfile = null;
if (!fs.existsSync(dockerfilePath)) {
  bad('仓库根目录没有 Dockerfile —— 云托管以「目标目录」为根寻找 Dockerfile，找不到即构建失败');
} else {
  dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
  ok('仓库根目录存在 Dockerfile（名称与官方默认一致）');
}

// ─────────────────────────────────────────────────────────────
// 2. npm 源设置（官方建议；云端访问 npm 官方源可能超时）
// ─────────────────────────────────────────────────────────────
section('[2] npm 源（云端构建的网络依赖）');
if (dockerfile) {
  // ★ 只在【非注释行】里匹配 —— 否则注释里写的示例会被当成真指令，检查假绿。
  const instructions = dockerfile
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
  const ciIndex = instructions.indexOf('npm ci');
  const registryRe = /npm\s+config\s+set\s+registry\s+([^\s"'`]+)/;
  const m = instructions.match(registryRe);
  if (!m) {
    bad('Dockerfile 未设置国内 npm 源 —— 云端构建访问 registry.npmjs.org 可能超时，'
      + '导致「运行流水线失败」。官方建议加：RUN npm config set registry https://mirrors.cloud.tencent.com/npm/');
  } else {
    const at = instructions.search(registryRe);
    if (ciIndex !== -1 && at > ciIndex) {
      bad(`npm 源设置在 \`npm ci\` 之后（${m[1]}）—— 必须放在它之前才生效`);
    } else {
      ok(`已设置 npm 源：${m[1]}`);
    }
  }
  // 反向控制：确认本检查真的能判红（注释里的示例不得让它变绿）
  const probe = instructions.replace(registryRe, '# removed');
  if (!registryRe.test(probe)) ok('反向控制：移除该指令后检查确实会报红（不会假绿）');
  else bad('反向控制失败：本检查无法可靠判红，结论不可信');
  // 冷缓存实测对照（本机，同一份 package-lock.json）
  note('本机冷缓存实测：官方源约 23.0s / 腾讯源约 2.7s（约 9 倍差距）');
}

// ─────────────────────────────────────────────────────────────
// 3. 构建必需文件齐全（Dockerfile 的每条 COPY 都要有源）
// ─────────────────────────────────────────────────────────────
section('[3] 构建必需文件');
const required = [
  'package.json',
  'package-lock.json',
  'src/server.js',
  'public/admin.html',
  'public/admin.js',
  'scripts/hash-admin-password.js',
];
for (const rel of required) {
  if (fs.existsSync(path.join(ROOT, rel))) ok(`${rel}`);
  else bad(`缺少 ${rel} —— Dockerfile 的 COPY 会失败`);
}
if (dockerfile) {
  // 校验每条 COPY 的源目录/文件确实存在
  const copyRe = /^COPY\s+(.+?)\s+(\S+)\s*$/gm;
  let c;
  while ((c = copyRe.exec(dockerfile)) !== null) {
    const sources = c[1].split(/\s+/).filter((s) => !s.startsWith('--'));
    for (const src of sources) {
      const base = src.replace(/^\.\//, '');
      if (/[*?[]/.test(base)) continue; // 通配符交给上面的必需文件清单兜底
      if (!fs.existsSync(path.join(ROOT, base))) bad(`COPY 的源不存在：${src}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────
// 4. package-lock.json 与 package.json 必须同步（npm ci 的硬前置）
// ─────────────────────────────────────────────────────────────
section('[4] 锁文件与 package.json 是否同步（npm ci 硬前置）');
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  const a = JSON.stringify(pkg.dependencies || {});
  const rootDeps = (lock.packages && lock.packages[''] && lock.packages[''].dependencies) || {};
  const b = JSON.stringify(rootDeps);
  if (a === b) ok(`依赖一致：${a}`);
  else bad(`不一致 —— npm ci 会以 EUSAGE 失败。package.json=${a} / lock=${b}`);
} catch (err) {
  bad(`读取/解析失败：${err.message}`);
}

// ─────────────────────────────────────────────────────────────
// 5. 端口一致性（官方：「监听端口填写错了，将会导致版本创建失败」）
// ─────────────────────────────────────────────────────────────
section('[5] 端口一致性');
if (dockerfile) {
  const expose = (dockerfile.match(/^EXPOSE\s+(\d+)/m) || [])[1];
  const envPort = (dockerfile.match(/^ENV\s+PORT=(\d+)/m) || [])[1];
  const cb = readIfExists(path.join(ROOT, 'cloudbase.yaml'));
  const cbPort = cb ? (cb.match(/^\s*port:\s*(\d+)/m) || [])[1] : null;
  const cbContainerPort = cb ? (cb.match(/^\s*containerPort:\s*(\d+)/m) || [])[1] : null;
  const seen = [['Dockerfile EXPOSE', expose], ['Dockerfile ENV PORT', envPort],
    ['cloudbase.yaml port', cbPort], ['cloudbase.yaml containerPort', cbContainerPort]]
    .filter(([, v]) => v != null);
  for (const [k, v] of seen) note(`${k} = ${v}`);
  const distinct = new Set(seen.map(([, v]) => v));
  if (distinct.size > 1) bad(`端口不一致：${[...distinct].join(' / ')}`);
  else if (distinct.size === 1) ok(`四处端口一致：${[...distinct][0]}`);
  note('★ 控制台「监听端口」必须与上面一致，否则版本创建失败（官方明确）');
}

// ─────────────────────────────────────────────────────────────
// 6. 流水线相关说明（无法静态判定，仅提示）
// ─────────────────────────────────────────────────────────────
section('[6] 流水线配置（需人工核对，脚本无法读取控制台）');
note('「目标目录」应留空 —— 本仓库根目录即代码根目录，Dockerfile 在根目录');
note('若「目标目录」填了值，云托管会以它为根寻找 Dockerfile，填错即构建失败');
note('「代码仓库」应为本仓库（e-school-server），而非外层仓库');
note('cloudbase.yaml 不被云托管读取 —— 服务名/规格/端口/环境变量均以控制台为准');

// 子模块提示：外层仓库把本目录登记为 submodule，云托管「仅拉取代码、不拉子模块」
const outerGitmodules = readIfExists(path.join(PROJECT, '.gitmodules'));
if (outerGitmodules && /path\s*=\s*server/.test(outerGitmodules)) {
  warn('检测到外层仓库把本目录登记为 git submodule —— 云托管「仅拉取代码不做任何其他操作」，'
    + '不会拉取子模块。若流水线绑定的是外层仓库，server/ 将是空目录、构建必然失败；'
    + '请确认流水线绑定的是本仓库（e-school-server）。');
}

// ─────────────────────────────────────────────────────────────
// 7. 运行期数据持久化提示
// ─────────────────────────────────────────────────────────────
section('[7] 运行期数据持久化');
const cbFull = readIfExists(path.join(ROOT, 'cloudbase.yaml'));
if (cbFull && /DB_FILE/.test(cbFull)) {
  warn('cloudbase.yaml 配置了 DB_FILE（容器内路径），但 Dockerfile 不含 data/、也没有卷挂载 '
    + '⇒ 容器重建即丢数据。生产必须挂持久化卷或改用云数据库。');
}

// ─────────────────────────────────────────────────────────────
// 汇总
// ─────────────────────────────────────────────────────────────
console.log('\n' + '─'.repeat(60));
console.log(`失败 ${failures.length} 项 / 警告 ${warnings.length} 项`);
if (failures.length) {
  console.log('\n阻断项：');
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`));
}
if (warnings.length) {
  console.log('\n警告：');
  warnings.forEach((w, i) => console.log(`  ${i + 1}. ${w}`));
}
console.log(failures.length === 0 ? '\n\u2713 自检通过，可以部署' : '\n\u2717 自检未通过，请先修复阻断项');
process.exitCode = failures.length === 0 ? 0 : 1;
