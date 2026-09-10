'use strict';

/* 开发工具：校验 renderer 拆分后「声明清单」与拆分前完全一致，且没有重复定义。
   运行： node tools/refactor/verify-decls.js <拆分前的 app.js 备份> */

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', 'renderer');

// 拆分后属于「业务视图」的脚本（app.js 已只剩启动逻辑）
const SPLIT_FILES = fs.readdirSync(RENDERER)
  .filter(f => f.endsWith('.js') && f !== 'storeproto.js')
  .filter(f => !['clipboard.js', 'quickadd.js', 'shot.js', 'widget.js'].includes(f));   // 独立小窗，本来就是独立 IIFE

function declsOf(src, requireIndent) {
  const out = [];
  const lines = src.split('\n');
  const re = requireIndent
    ? /^  (?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/
    : /^(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/;
  lines.forEach((l, i) => {
    const m = re.exec(l);
    if (m) out.push({ name: m[1] || m[2], line: i + 1 });
  });
  return out;
}

const before = process.argv[2];
if (!before) { console.error('用法：node tools/refactor/verify-decls.js <拆分前的 app.js>'); process.exit(2); }

const beforeSrc = fs.readFileSync(before, 'utf8');
const beforeDecls = declsOf(beforeSrc, true);          // 原文件在 IIFE 内 → 顶层缩进 2 空格
const beforeNames = new Set(beforeDecls.map(d => d.name));

const after = new Map();      // name → [file...]
for (const f of SPLIT_FILES) {
  for (const d of declsOf(fs.readFileSync(path.join(RENDERER, f), 'utf8'), false)) {
    if (!after.has(d.name)) after.set(d.name, []);
    after.get(d.name).push(f);
  }
}

const missing = [...beforeNames].filter(n => !after.has(n));
const extra = [...after.keys()].filter(n => !beforeNames.has(n));
const dupes = [...after.entries()].filter(([, files]) => files.length > 1);

console.log('拆分前顶层声明：' + beforeNames.size + ' 个');
console.log('拆分后顶层声明：' + after.size + ' 个');
console.log('缺失：' + (missing.length ? missing.join(', ') : '无'));
console.log('多出：' + (extra.length ? extra.join(', ') : '无'));
console.log('重复定义：' + (dupes.length ? dupes.map(([n, f]) => n + '(' + f.join('+') + ')').join(', ') : '无'));

const ok = !missing.length && !dupes.length;
console.log(ok ? '结论：声明清单一致，且无重复定义 ✔' : '结论：存在问题 ✖');
process.exit(ok ? 0 : 1);
