/* build.js — 唯一插件构建入口
 * 只生成 current/dist/plugin/buffer-calculator/，共十一个运行文件：
 *   manifest.json
 *   index.html
 *   engine.js  db.js  data-model.js  db-store.js  toolkit-api.js
 *   toolkit-platform.js  neut-chart.js  app.js  plugin-entry.js
 * 先在输出根同级的专用临时目录构建，校验通过后替换输出目录；不追加独立版 HTML、
 * 源码模板、package、文档、测试、依赖或清单，也不嵌入当前时间戳。
 */
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const OUT_ROOT = path.join(ROOT, 'dist', 'plugin');
const OUT_DIR = path.join(OUT_ROOT, 'buffer-calculator');
const TEMP_DIR = path.join(OUT_ROOT, '.build-buffer-calculator');

// 固定白名单：九个 JS 的顺序即 index.html 中的脚本加载顺序
const SCRIPTS = [
  'engine.js',
  'db.js',
  'data-model.js',
  'db-store.js',
  'toolkit-api.js',
  'toolkit-platform.js',
  'neut-chart.js',
  'app.js',
  'plugin-entry.js',
];
const EXTRA = ['index.html', 'manifest.json'];
const MANIFEST_TEMPLATE = path.join(ROOT, 'plugin', 'manifest.template.json');
const TEMPLATE = path.join(ROOT, 'template.html');
const PACKAGE = path.join(ROOT, 'package.json');

function fail(message) {
  const error = new Error(message);
  error.code = 'BUILD_FAILED';
  throw error;
}
function assertInside(target, parent, label) {
  const resolved = path.resolve(target);
  const parentResolved = path.resolve(parent);
  if (resolved !== parentResolved && !resolved.startsWith(parentResolved + path.sep)) {
    fail(`${label} 解析到 ${resolved}，不在 ${parentResolved} 内`);
  }
  return resolved;
}
function checkNoLinks(dir) {
  if (fs.lstatSync(dir).isSymbolicLink()) fail(`${dir} 是符号链接/联接，拒绝清理`);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`${full} 是符号链接/联接，拒绝清理`);
    if (entry.isDirectory()) checkNoLinks(full);
  }
}
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  checkNoLinks(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

// 构建期静态检查：不引入内联脚本、事件属性、javascript:、eval 或外部资源
function checkStatic(html, label) {
  if (/<script(?![^>]*\bsrc=)/i.test(html)) fail(`${label}: 存在内联 <script>（CSP 不允许）`);
  if (/\son[a-z]+\s*=/i.test(html)) fail(`${label}: 存在内联事件属性`);
  if (/javascript:/i.test(html)) fail(`${label}: 存在 javascript: 伪协议`);
  if (/\beval\s*\(|new\s+Function\s*\(/.test(html)) fail(`${label}: 存在 eval / new Function`);
  const externals = [...html.matchAll(/(?:src|href)\s*=\s*"([^"]+)"/gi)].map(m => m[1])
    .filter(url => /^(https?:)?\/\//i.test(url) || /^data:text/i.test(url));
  if (externals.length) fail(`${label}: 存在外网或 data: 资源 ${externals.join(', ')}`);
  const local = [...html.matchAll(/<script[^>]*\bsrc\s*=\s*"([^"]+)"/gi)].map(m => m[1]);
  if (local.some(src => /[\\/]|\.\./.test(src))) fail(`${label}: 脚本路径必须为同目录文件名`);
  return local;
}

// 用宿主实际校验器核对 manifest；校验器不可用时明确失败，不用自制规则冒充宿主校验
function validateWithHost(manifest) {
  // 独立副本构建时用 ETK_HOST_ROOT 指向相邻工具箱（只影响构建期校验，不进入运行包）
  const hostRoot = process.env.ETK_HOST_ROOT
    ? path.resolve(process.env.ETK_HOST_ROOT)
    : path.resolve(ROOT, '..', '..', 'Experiment Tool Kit');
  const corePath = path.join(hostRoot, 'electron', 'core.cjs');
  if (!fs.existsSync(corePath)) {
    fail(`缺少宿主校验器：${corePath}（本项目构建要求相邻工具箱存在，仅构建期需要，不进入运行包；可用 ETK_HOST_ROOT 指定路径）`);
  }
  const core = require(corePath);
  if (typeof core.validateManifest !== 'function') fail('宿主校验器没有 validateManifest');
  core.validateManifest(manifest);   // 失败时抛 {code, message}
  return { validator: corePath, api: core.API };
}

function build() {
  if (!fs.existsSync(TEMPLATE)) fail('缺少 template.html');
  if (!fs.existsSync(MANIFEST_TEMPLATE)) fail('缺少 plugin/manifest.template.json');
  const pkg = JSON.parse(fs.readFileSync(PACKAGE, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) fail(`package.json version 必须是三段数字，当前 ${pkg.version}`);
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_TEMPLATE, 'utf8'));
  manifest.version = pkg.version;   // 产品版本唯一权威是 package.json

  const missing = SCRIPTS.concat(['template.html', 'plugin/manifest.template.json']).filter(f => !fs.existsSync(path.join(ROOT, f)));
  if (missing.length) fail('缺少源码文件：' + missing.join('、'));

  const html = fs.readFileSync(TEMPLATE, 'utf8');
  const used = checkStatic(html, 'template.html');
  const expected = SCRIPTS.slice().sort();
  const actual = used.slice().sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`template.html 的脚本列表与白名单不一致：${actual.join(', ')} ≠ ${expected.join(', ')}`);
  }
  for (const file of SCRIPTS) {
    if (!html.includes(`<script src="${file}"></script>`)) fail(`template.html 缺少 ${file} 的固定引用形式 <script src="${file}"></script>`);
  }
  if (/\b20\d\d-\d\d-\d\dT\d\d:\d\d/.test(html)) fail('index.html 不得嵌入构建时间戳');

  removeTree(TEMP_DIR);
  assertInside(TEMP_DIR, OUT_ROOT, '临时目录');
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  for (const file of SCRIPTS) fs.copyFileSync(path.join(ROOT, file), path.join(TEMP_DIR, file));
  fs.writeFileSync(path.join(TEMP_DIR, 'index.html'), html, 'utf8');
  fs.writeFileSync(path.join(TEMP_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');

  const produced = fs.readdirSync(TEMP_DIR).sort();
  const allowed = SCRIPTS.concat(EXTRA).sort();
  if (JSON.stringify(produced) !== JSON.stringify(allowed)) {
    fail(`输出文件集合不符：${produced.join(', ')} ≠ ${allowed.join(', ')}`);
  }
  checkNoLinks(TEMP_DIR);
  const manifestCheck = validateWithHost(JSON.parse(fs.readFileSync(path.join(TEMP_DIR, 'manifest.json'), 'utf8')));
  let total = 0;
  const sizes = {};
  for (const file of produced) {
    const full = path.join(TEMP_DIR, file);
    const size = fs.statSync(full).size;
    sizes[file] = size;
    total += size;
    if (size === 0) fail(`${file} 为空`);
  }
  if (total > 20 * 1024 * 1024) fail(`包体积 ${total} 字节超过 20 MiB`);
  if (produced.length >= 200) fail(`文件数 ${produced.length} 超过 200`);

  removeTree(OUT_DIR);
  fs.renameSync(TEMP_DIR, OUT_DIR);
  return { dir: OUT_DIR, files: produced, sizes, total, version: manifest.version, manifestCheck };
}

function main() {
  const result = build();
  const manifest = JSON.parse(fs.readFileSync(path.join(result.dir, 'manifest.json'), 'utf8'));
  console.log(`built plugin: ${path.relative(ROOT, result.dir)}`);
  console.log(`  version ${manifest.version} · api ${manifest.apiVersion} · id ${manifest.id}`);
  console.log(`  ${result.files.length} files · ${result.total} bytes`);
  console.log('  ' + result.files.map(f => `${f}(${result.sizes[f]})`).join(' '));
  console.log(`  manifest 校验：${result.manifestCheck.validator}`);
}

if (require.main === module) {
  try { main(); } catch (error) { console.error('构建失败：' + error.message); process.exitCode = 1; }
}
module.exports = { build, SCRIPTS, EXTRA, OUT_DIR, checkStatic };
