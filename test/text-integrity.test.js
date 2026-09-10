'use strict';

/* 文本编码完整性检查
   ---------------------------------------------------------------------------
   由来：一次实际事故 —— 用 PowerShell 的 `Get-Content -Raw | Set-Content -Encoding UTF8`
   改写 UTF-8 文档时，PowerShell 5.1 会按系统 ANSI 代码页解码，中文被写成乱码，
   结果 GitHub 上的 README 与某个 Release 说明整篇变成「鈥/鍙/鐨」这类乱码。
   这个测试把「仓库里的文本文件必须是干净 UTF-8」变成可自动检查的规则：

     · 不得出现典型的 UTF-8 被按 GBK 解码后的乱码字符
     · 不得出现替换字符 U+FFFD（编码转换丢字符的痕迹）
     · 不得有 PowerShell 常见的多余 BOM（JS/JSON/MD 都不需要）
     · 常见文本文件里不应出现 NUL（那是二进制误入文本）
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = ['node_modules', 'dist', 'dist-new', '.git', 'ocr-data'];
const TEXT_EXT = ['.js', '.json', '.md', '.txt', '.html', '.css', '.yml', '.yaml'];
const TEXT_NAMES = ['LICENSE', '.gitignore', '.gitattributes', '.nvmrc', '.npmrc'];

/* 乱码标记：UTF-8 文本被当成 GBK 解读后的三字组合。
   注意两点：
     · 只挑「正常中文里几乎不可能出现」的三字组合 —— 单字会误报
       （例如「官」是常用字，出现在「官方源」里）
     · 用 \uXXXX 转义书写，避免本文件自身的内容命中标记
   这些标记来自一次真实事故样本（README 与某条 Release 说明被 PowerShell 换成乱码）。 */
const MOJIBAKE_MARKERS = [
  '\u951F\u65A4\u62F7',   // 经典「替换字符」乱码（三个特定汉字，此处不写出原文以免本文件自命中）
  '\u7039\u5C7D\u53CF',   // ← 完全
  '\u7568\u7441\u546D',   // ← 安装
  '\u9423\u5C84\u6F70',   // ← 界面
  '\u7ECC\u8679\u6AE7',   // ← 空白
  '\u93B7\u55D7\u578E',   // ← 拆分
  '\u59DB\u9473\u6212',   // ← 功能
  '\u68F6\u68F0\u6A48'    // ← 问题
];

function collectTextFiles(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.indexOf(ent.name) !== -1) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { collectTextFiles(full, out); continue; }
    const ext = path.extname(ent.name).toLowerCase();
    if (TEXT_EXT.indexOf(ext) !== -1 || TEXT_NAMES.indexOf(ent.name) !== -1) out.push(full);
  }
  return out;
}

const files = collectTextFiles(ROOT, []);

test('仓库文本文件数量合理（防扫描逻辑失效）', () => {
  assert.ok(files.length > 30, '扫描到的文本文件过少：' + files.length);
});

test('文本文件不得含 UTF-8 → GBK 乱码字符', () => {
  const problems = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const marker of MOJIBAKE_MARKERS) {
      if (text.indexOf(marker) !== -1) {
        const idx = text.indexOf(marker);
        problems.push(path.relative(ROOT, f) + ' 含乱码「' + marker + '」：…' + text.slice(Math.max(0, idx - 20), idx + 20).replace(/\n/g, ' ') + '…');
        break;
      }
    }
  }
  assert.deepStrictEqual(problems, [], '以下文件出现乱码（通常是编码转换事故）：\n' + problems.join('\n'));
});

test('文本文件不得含替换字符 U+FFFD（编码转换丢字符的痕迹）', () => {
  const problems = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    if (text.indexOf('\uFFFD') !== -1) problems.push(path.relative(ROOT, f));
  }
  assert.deepStrictEqual(problems, [], '以下文件含 U+FFFD：' + problems.join(', '));
});

test('JS / JSON / Markdown 不得带 BOM', () => {
  const problems = [];
  for (const f of files) {
    const buf = fs.readFileSync(f);
    const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    if (hasBom) problems.push(path.relative(ROOT, f));
  }
  assert.deepStrictEqual(problems, [], '以下文件带 BOM（会被 PowerShell 之外的工具误读）：' + problems.join(', '));
});

test('文本文件不得含 NUL 字节（那是二进制内容误入）', () => {
  const problems = [];
  for (const f of files) {
    if (fs.readFileSync(f).indexOf(0) !== -1) problems.push(path.relative(ROOT, f));
  }
  assert.deepStrictEqual(problems, [], '以下文件含 NUL：' + problems.join(', '));
});

test('关键文档含预期中文（防「文件被清空或整体替换」）', () => {
  const must = [
    ['README.md', ['桌面工作台', 'v1.8.5', '数据存在哪']],
    ['CHANGELOG.md', ['更新日志', 'v1.8.5']],
    ['package.json', ['桌面工作台']],
    ['renderer/index.html', ['桌面工作台']],
    ['renderer/app.js', ['启动入口']]
  ];
  for (const [rel, needles] of must) {
    const p = path.join(ROOT, rel);
    assert.ok(fs.existsSync(p), rel + ' 不存在');
    const text = fs.readFileSync(p, 'utf8');
    for (const n of needles) {
      assert.ok(text.indexOf(n) !== -1, rel + ' 缺少预期内容：' + n);
    }
  }
});
