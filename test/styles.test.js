'use strict';

/* 样式令牌一致性检查（无需浏览器）
   1. style.css 里引用的 var(--x) 必须都有定义
   2. 深浅两套主题必须提供同一批语义化令牌（否则深色下会退回浅色值）
   3. 已令牌化的语义色不应再出现在 :root.dark 的规则覆盖里（防止两套机制并存） */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CSS = path.join(__dirname, '..', 'renderer', 'style.css');
const src = fs.readFileSync(CSS, 'utf8');

function matchAll(re) {
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// 取出 :root { ... } 与 :root.dark { ... } 两个令牌块
const rootMatch = /:root\s*\{([\s\S]*?)\n\}/.exec(src);
const darkMatch = /:root\.dark\s*\{([\s\S]*?)\n\}/.exec(src);

function names(block) {
  const set = new Set();
  const re = /(--[a-z0-9-]+)\s*:/gi;
  let m;
  while ((m = re.exec(block || '')) !== null) set.add(m[1]);
  return set;
}

test('样式文件结构完整（能定位到浅色与深色令牌块）', () => {
  assert.ok(rootMatch, '未找到 :root 令牌块');
  assert.ok(darkMatch, '未找到 :root.dark 令牌块');
  assert.ok(names(rootMatch[1]).size > 20, '浅色令牌数量异常');
  assert.ok(names(darkMatch[1]).size > 10, '深色令牌数量异常');
});

test('所有 var(--x) 引用都有定义（防拼写错误导致样式静默失效）', () => {
  const defined = new Set([...names(rootMatch[1]), ...names(darkMatch[1])]);
  // 局部变量（在规则内定义的）也算定义
  for (const n of matchAll(/(--[a-z0-9-]+)\s*:/gi)) defined.add(n);
  const used = new Set(matchAll(/var\((--[a-z0-9-]+)/gi));
  const missing = [...used].filter(u => !defined.has(u));
  assert.deepStrictEqual(missing, [], '引用了未定义的令牌：' + missing.join(', '));
});

test('深色主题必须为语义化令牌提供同名值', () => {
  const light = names(rootMatch[1]);
  const dark = names(darkMatch[1]);
  // 这批令牌是深色适配的关键（浅色下是亮色，深色下必须换掉）
  const mustOverride = ['--page-bg', '--surface-card', '--text', '--border',
    '--greet-bg', '--greet-glow', '--overlay-chrome', '--titlebar-bg', '--toast-bg',
    '--tag-warn-bg', '--tag-warn-fg', '--tag-ok-bg', '--tag-ok-fg', '--tag-info-bg', '--tag-info-fg', '--text-strong'];
  const missing = mustOverride.filter(t => light.has(t) && !dark.has(t));
  assert.deepStrictEqual(missing, [], '深色主题缺少这些令牌的值：' + missing.join(', '));
});

// 把 CSS 拆成「选择器 → 声明体」，用于精确区分「令牌定义块」与「规则补丁」
function rules(block) {
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(block)) !== null) out.push({ selector: m[1].trim(), body: m[2] });
  return out;
}

test('已令牌化的颜色不再以硬编码形式出现在深色补丁里（避免两套机制并存）', () => {
  // 只看「:root.dark 下的具体规则」（令牌定义块 :root.dark { ... } 本身当然要写颜色值）
  const patches = rules(src).filter(r => /^:root\.dark\s+\S/.test(r.selector));
  const suspicious = [];
  for (const r of patches) {
    const hex = r.body.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
    if (hex.length) suspicious.push(r.selector + ' → ' + hex.join(','));
  }
  assert.deepStrictEqual(suspicious, [], '深色补丁里仍有硬编码颜色：\n' + suspicious.join('\n'));
});

test('语义化令牌在浅色与深色下取值不同（否则等于没适配）', () => {
  const pick = (block, name) => {
    const m = new RegExp(name.replace(/[-]/g, '\\-') + '\\s*:\\s*([^;]+);').exec(block);
    return m ? m[1].trim() : null;
  };
  for (const t of ['--greet-bg', '--toast-bg', '--tag-warn-bg', '--tag-warn-fg', '--overlay-chrome']) {
    const l = pick(rootMatch[1], t);
    const d = pick(darkMatch[1], t);
    assert.ok(l && d, t + ' 在两套主题下都要有值');
    assert.notStrictEqual(l, d, t + ' 浅色与深色取值相同，等于没有适配');
  }
});
