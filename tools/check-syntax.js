'use strict';

/* 语法检查：把项目里所有 JS 过一遍 node --check。
   用途：`npm run check`（无构建步骤的项目里，这是最快的整体健全性检查）。
   注意这只看语法，行为回归请跑 `npm test`。 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');

function collect(dir, out, skip) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.indexOf(ent.name) !== -1) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collect(full, out, skip);
    else if (ent.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = [];
collect(ROOT, files, ['node_modules', 'dist', 'dist-new', 'ocr-data', '.git']);

let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (e) {
    failed++;
    console.error('语法错误：' + path.relative(ROOT, f));
    const out = (e.stderr || e.stdout || Buffer.from('')).toString();
    console.error(out.split('\n').slice(0, 6).join('\n'));
  }
}

console.log('检查 ' + files.length + ' 个文件，' + (failed ? failed + ' 个失败' : '全部通过'));
process.exit(failed ? 1 : 0);
