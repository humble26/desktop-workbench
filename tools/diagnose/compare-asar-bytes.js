'use strict';
/* 打包产物与源码逐字节比对：确认 asar 里的 renderer/ 与 lib/ 文件与工作区完全一致。
   用于排除「打包过程弄坏/截断/改写编码」这类只在安装后出现的问题。
   用法：node tools/diagnose/compare-asar-bytes.js [app.asar] */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const asar = process.argv[2] || path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar');
if (!fs.existsSync(asar)) { console.error('未找到：' + asar); process.exit(2); }

// 内容区起点：8 + headerSize（详见 verify-packed-boot.js 里的说明）
const fd = fs.openSync(asar, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
const headerSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(12);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const index = JSON.parse(jsonBuf.toString('utf8'));
const baseOffset = 8 + headerSize;

const packed = [];
(function walk(node, prefix) {
  for (const name of Object.keys(node.files || {})) {
    const child = node.files[name];
    const rel = prefix ? prefix + '/' + name : name;
    if (child.files) walk(child, rel);
    else if (/^(renderer|lib)\//.test(rel)) packed.push({ rel: rel, size: child.size, offset: parseInt(child.offset, 10) });
  }
})(index, '');

let same = 0, diff = 0, missing = 0;
const problems = [];
for (const p of packed) {
  const local = path.join(ROOT, p.rel);
  if (!fs.existsSync(local)) { missing++; problems.push('工作区缺少 ' + p.rel); continue; }
  const a = fs.readFileSync(local);
  const b = Buffer.alloc(p.size);
  fs.readSync(fd, b, 0, p.size, baseOffset + p.offset);
  if (a.length === b.length && a.equals(b)) { same++; continue; }
  diff++;
  let why = '长度 ' + a.length + ' vs ' + b.length;
  if (a.length === b.length) {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) { why += '，首个差异在第 ' + i + ' 字节'; break; }
  }
  problems.push(p.rel + '：' + why);
}
fs.closeSync(fd);

console.log('比对 renderer/ 与 lib/ 共 ' + packed.length + ' 个文件：一致 ' + same + '，不一致 ' + diff + '，工作区缺失 ' + missing);
if (problems.length) {
  console.log('问题：');
  for (const p of problems) console.log('  ✖ ' + p);
}
console.log(problems.length ? '\n结论：打包内容与源码不一致 ✖' : '\n结论：打包内容与源码逐字节一致 ✔');
process.exit(problems.length ? 1 : 0);
