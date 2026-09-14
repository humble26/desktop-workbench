'use strict';
/* 发布前/打包后校验：确认打进 asar 的 renderer/app.js 仍然带有启动入口调用。
   这是 v1.8.2「界面空白」事故的针对性防线 —— 校验的是**打包产物**，不是源码。

   用法：node tools/diagnose/verify-packed-boot.js [app.asar] */
const fs = require('fs');
const path = require('path');

const asar = process.argv[2] || path.join(__dirname, '..', '..', 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asar)) { console.error('未找到：' + asar); process.exit(2); }

// asar 头部：| UInt32=4 | UInt32=headerSize | UInt32=jsonStringSize | UInt32=jsonSize | JSON | 填充 |
// 内容区起点是 8 + headerSize（**不是** 16 + jsonSize —— 头部 JSON 之后可能有填充字节，
// 用后者会把所有文件读偏，曾因此误报「打包后的 app.js 缺少 boot();」）
const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const index = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 8 + headerSize;

function find(node, prefix, target) {
  for (const name of Object.keys(node.files || {})) {
    const child = node.files[name];
    const rel = prefix ? prefix + '/' + name : name;
    if (child.files) { const r = find(child, rel, target); if (r) return r; }
    else if (rel === target) return child;
  }
  return null;
}

let failed = 0;

// 1) renderer/app.js 必须含启动调用
const appEntry = find(index, '', 'renderer/app.js');
if (!appEntry) { console.error('✖ asar 中缺少 renderer/app.js'); failed++; }
else {
  const buf = Buffer.alloc(appEntry.size);
  fs.readSync(fd, buf, 0, appEntry.size, baseOffset + parseInt(appEntry.offset, 10));
  const src = buf.toString('utf8');
  const hasBoot = /^\s*boot\(\);\s*$/m.test(src);
  const hasFn = /async function boot\s*\(/.test(src);
  console.log((hasBoot ? 'OK  ' : '✖   ') + '打包后的 renderer/app.js 含启动调用 boot();');
  console.log((hasFn ? 'OK  ' : '✖   ') + '打包后的 renderer/app.js 定义了 boot()');
  if (!hasBoot || !hasFn) failed++;
}

// 2) index.html 里声明的脚本必须都在 asar 内（缺一个就可能白屏）
const idx = find(index, '', 'renderer/index.html');
if (!idx) { console.error('✖ asar 中缺少 renderer/index.html'); failed++; }
else {
  const buf = Buffer.alloc(idx.size);
  fs.readSync(fd, buf, 0, idx.size, baseOffset + parseInt(idx.offset, 10));
  const html = buf.toString('utf8');
  const scripts = [];
  const re = /<script src="([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  const missing = scripts.filter(s => !find(index, '', 'renderer/' + s));
  console.log((missing.length ? '✖   ' : 'OK  ') + 'index.html 声明的 ' + scripts.length + ' 个脚本都在包内' +
    (missing.length ? '，缺少：' + missing.join(', ') : ''));
  if (missing.length) failed++;
}

// 3) 主进程模块齐备
for (const f of ['lib/store.js', 'lib/migrate.js', 'lib/sensitive.js', 'renderer/dateutil.js', 'renderer/importguard.js', 'renderer/storeproto.js']) {
  const ok = !!find(index, '', f);
  console.log((ok ? 'OK  ' : '✖   ') + '包内包含 ' + f);
  if (!ok) failed++;
}

// 4) 打包后的 IPC 来源校验必须是「不依赖 Electron 对象同一性」的修复版
//    （v1.8.2 / v1.8.3 界面空白的根因就是这里用了 senderFrame !== sender.mainFrame）
function stripComments(code) {
  // 只做代码判定，避免把「解释这个 bug 的注释」当成 bug 本身
  return String(code)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}
const sec = find(index, '', 'lib/security.js');
if (!sec) { console.error('✖ asar 中缺少 lib/security.js'); failed++; }
else {
  const buf = Buffer.alloc(sec.size);
  fs.readSync(fd, buf, 0, sec.size, baseOffset + parseInt(sec.offset, 10));
  const raw = buf.toString('utf8');
  const code = stripComments(raw);
  const identity = [
    /senderFrame\s*!==\s*\w+\.sender\.mainFrame/,
    /frame\s*!==\s*\w+\.sender\.mainFrame/,
    /senderFrame\s*===\s*\w+\.sender\.mainFrame/
  ].find(re => re.test(code));
  const hasGetUrlFallback = /\.getURL\s*\(/.test(code);
  console.log((identity ? '✖   ' : 'OK  ') + '来源校验未依赖 senderFrame/sender.mainFrame 的对象同一性' + (identity ? '（命中 ' + identity + '）' : ''));
  console.log((hasGetUrlFallback ? 'OK  ' : '✖   ') + '来源校验含 WebContents.getURL() 回退');
  if (identity || !hasGetUrlFallback) failed++;
}

// 5) AI 余额监测：包内模块齐备，且**安全关键的那几行原样进包**
//    （打包环节若把注释/代码搞丢，防的是「源码里是对的、发出去的不对」）
function readEntry(rel) {
  const node = find(index, '', rel);
  if (!node) return null;
  const buf = Buffer.alloc(node.size);
  fs.readSync(fd, buf, 0, node.size, baseOffset + parseInt(node.offset, 10));
  return buf.toString('utf8');
}
for (const f of ['lib/ai/providers.js', 'lib/ai/settings.js', 'lib/ai/http.js', 'lib/ai/keystore.js', 'lib/ai/monitor.js', 'renderer/view-ai.js']) {
  const ok = !!find(index, '', f);
  console.log((ok ? 'OK  ' : '✖   ') + '包内包含 ' + f);
  if (!ok) failed++;
}

const aiProbe = [
  ['lib/ai/http.js', /redirect:\s*'manual'/, '取 JSON 时设置 redirect: manual（不跟随跳转，防止密钥被带到别的域名）'],
  ['lib/ai/providers.js', /https:\/\/api\.deepseek\.com\/user\/balance/, '内置平台地址白名单（DeepSeek）'],
  ['lib/ai/providers.js', /https:\/\/openrouter\.ai\/api\/v1\/key/, '内置平台地址白名单（OpenRouter）'],
  ['lib/ai/keystore.js', /isEncryptionAvailable/, '密钥保存前检查系统安全存储是否可用'],
  ['lib/ai/monitor.js', /ai-usage\.json|spreadSpend/, '余额差值推算消耗的实现'],
  ['renderer/view-ai.js', /估算/, 'AI 页面上标注 token 是估算']
];
for (const [rel, re, label] of aiProbe) {
  const src = readEntry(rel);
  const ok = !!src && re.test(src);
  console.log((ok ? 'OK  ' : '✖   ') + '打包后仍具备：' + label);
  if (!ok) failed++;
}

fs.closeSync(fd);
console.log('\n' + (failed ? '校验失败（' + failed + ' 项）' : '打包产物校验通过：页面具备启动能力，AI 监测的安全边界完好'));
process.exit(failed ? 1 : 0);