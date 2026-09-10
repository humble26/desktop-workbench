'use strict';

/* 开发工具：解析 app.asar 的文件索引，校验打包内容是否符合预期。
   asar 结构：| UInt32=4 | UInt32=headerSize | UInt32=headerStringSize | UInt32=jsonSize | JSON |
   运行： node tools/refactor/inspect-asar.js <app.asar> */

const fs = require('fs');

const file = process.argv[2];
if (!file) { console.error('用法：node tools/refactor/inspect-asar.js <app.asar>'); process.exit(2); }

const fd = fs.openSync(file, 'r');
const sizeBuf = Buffer.alloc(16);
fs.readSync(fd, sizeBuf, 0, 16, 0);
const headerSize = sizeBuf.readUInt32LE(4);
const jsonSize = sizeBuf.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
fs.closeSync(fd);

const index = JSON.parse(jsonBuf.toString('utf8'));

const out = [];
(function walk(node, prefix) {
  for (const name of Object.keys(node.files || {})) {
    const child = node.files[name];
    const rel = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, rel);
    else out.push({ path: rel, size: child.size || 0, unpacked: !!child.unpacked });
  }
})(index, '');

const byTop = new Map();
for (const f of out) {
  const top = f.path.split('/')[0];
  if (!byTop.has(top)) byTop.set(top, []);
  byTop.get(top).push(f);
}

console.log('app.asar 索引条目：' + out.length + ' 个文件');
console.log('--- 顶层条目 ---');
for (const [top, list] of [...byTop.entries()].sort()) {
  console.log('  ' + top.padEnd(16) + list.length + ' 个文件');
}

const want = [
  'main.js', 'preload.js', 'package.json',
  'renderer/index.html', 'renderer/style.css', 'renderer/storeproto.js',
  'renderer/core.js', 'renderer/icons.js', 'renderer/shell.js', 'renderer/actions.js',
  'renderer/guide.js', 'renderer/search.js', 'renderer/diagnostics.js', 'renderer/dialogs.js',
  'renderer/view-dashboard.js', 'renderer/view-todos.js', 'renderer/view-calendar.js',
  'renderer/view-settings.js', 'renderer/view-usage.js', 'renderer/app.js',
  'renderer/widget.html', 'renderer/clipboard.html', 'renderer/quickadd.html', 'renderer/shot.html',
  'lib/store.js', 'lib/migrate.js', 'lib/defaults.js', 'lib/security.js',
  'lib/powershell.js', 'lib/quickadd.js', 'lib/usage.js', 'lib/iconcache.js', 'lib/patchguard.js'
];
const paths = new Set(out.map(f => f.path));
const missing = want.filter(w => !paths.has(w));

const forbidden = out.filter(f => /^(test|tools)\//.test(f.path));
const rendererFiles = out.filter(f => f.path.indexOf('renderer/') === 0);

console.log('--- 必需的运行期文件 ---');
console.log(missing.length ? '  缺失：' + missing.join(', ') : '  全部就位 ✔');
console.log('--- 不应打包的开发文件 ---');
console.log(forbidden.length ? '  被打包：' + forbidden.map(f => f.path).join(', ') : '  未打包 ✔');
console.log('--- renderer 打包明细 ---');
console.log('  ' + rendererFiles.length + ' 个文件：' + rendererFiles.map(f => f.path.replace('renderer/', '')).join(', '));
console.log('--- lib 打包明细 ---');
console.log('  ' + out.filter(f => f.path.indexOf('lib/') === 0).map(f => f.path.replace('lib/', '')).join(', '));
console.log('--- asar 外置（unpacked）---');
const unpacked = out.filter(f => f.unpacked);
console.log('  ' + (unpacked.length ? unpacked.length + ' 个文件（如 OCR 模型 / tesseract）' : '（无）'));

process.exit(missing.length || forbidden.length ? 1 : 0);
