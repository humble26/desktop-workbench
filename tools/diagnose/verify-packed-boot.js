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

fs.closeSync(fd);
console.log('\n' + (failed ? '校验失败（' + failed + ' 项）' : '打包产物校验通过：页面具备启动能力'));
process.exit(failed ? 1 : 0);
