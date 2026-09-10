'use strict';

/* IPC 来源校验单测：只放行本应用 renderer 目录下的顶层本地页面 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTrustedSenderChecker } = require('../lib/security.js');

const RENDERER = path.resolve('C:\\app\\resources\\app\\renderer');
const check = createTrustedSenderChecker({ rendererDir: RENDERER, caseInsensitive: true });

// 构造一个最小 event：sender.mainFrame 与 senderFrame 同引用 = 顶层框架
function event(url, opts) {
  const o = opts || {};
  const mainFrame = { url: url, detached: false };
  const frame = o.iframe ? { url: url, detached: false } : mainFrame;
  return {
    senderFrame: o.noFrame ? null : frame,
    sender: { mainFrame: mainFrame }
  };
}
function fileUrl(p) { return pathToFileURL(p).href; }

test('放行 renderer 目录下的本应用页面', () => {
  for (const page of ['index.html', 'widget.html', 'clipboard.html', 'quickadd.html', 'shot.html']) {
    assert.strictEqual(check(event(fileUrl(path.join(RENDERER, page)))), true, page + ' 应放行');
  }
});

test('放行带查询串的小组件页面（widget.html?type=clock）', () => {
  assert.strictEqual(check(event(fileUrl(path.join(RENDERER, 'widget.html')) + '?type=todos')), true);
});

test('放行百分号编码的中文路径', () => {
  const dir = path.resolve('C:\\Users\\\u7528\u6237\\AppData\\app\\renderer');
  const c2 = createTrustedSenderChecker({ rendererDir: dir, caseInsensitive: true });
  assert.strictEqual(c2(event(fileUrl(path.join(dir, 'index.html')))), true);
});

test('拒绝 renderer 目录之外的本机页面（旧实现会放行）', () => {
  const outside = [
    fileUrl('C:\\Users\\Public\\evil.html'),
    fileUrl(path.join(RENDERER, '..', 'main.js')),
    fileUrl(path.join(RENDERER, '..', '..', 'index.html')),
    'file:///C:/Windows/Temp/attack.html'
  ];
  for (const u of outside) {
    assert.strictEqual(check(event(u)), false, u + ' 必须拒绝');
  }
});

test('拒绝目录穿越（renderer/../renderer-evil/x.html 这类前缀陷阱）', () => {
  const sibling = path.resolve(RENDERER + '-evil');
  assert.strictEqual(check(event(fileUrl(path.join(sibling, 'x.html')))), false);
});

test('拒绝非 file 协议与畸形输入', () => {
  assert.strictEqual(check(event('https://example.com/')), false);
  assert.strictEqual(check(event('about:blank')), false);
  assert.strictEqual(check(event('')), false);
  assert.strictEqual(check(event(fileUrl(path.join(RENDERER, 'index.html')), { noFrame: true })), false);
  assert.strictEqual(check(null), false);
  assert.strictEqual(check({}), false);
});

test('拒绝 iframe（非顶层框架）', () => {
  assert.strictEqual(check(event(fileUrl(path.join(RENDERER, 'index.html')), { iframe: true })), false);
});

test('拒绝已 detach 的框架', () => {
  const e = event(fileUrl(path.join(RENDERER, 'index.html')));
  e.senderFrame.detached = true;
  assert.strictEqual(check(e), false);
});

test('大小写不敏感平台：大小写混写仍放行', () => {
  const upper = createTrustedSenderChecker({ rendererDir: 'C:\\App\\Renderer', caseInsensitive: true });
  assert.strictEqual(upper(event('file:///c:/app/renderer/index.html')), true);
});

test('大小写敏感开关：关闭时大小写不同即拒绝（不依赖宿主平台）', () => {
  // 注：路径解析使用宿主平台规则，故这里用宿主风格的路径（Windows 下即 C:\...）
  const dir = path.resolve('C:\\App\\Renderer');
  const sensitive = createTrustedSenderChecker({ rendererDir: dir, caseInsensitive: false });
  const same = createTrustedSenderChecker({ rendererDir: dir, caseInsensitive: true });
  assert.strictEqual(sensitive(event(fileUrl(path.join(dir, 'index.html')))), true, '大小写一致应放行');
  const flipped = dir.replace(/Renderer$/, 'renderer');
  if (flipped !== dir) {
    assert.strictEqual(sensitive(event(fileUrl(path.join(flipped, 'index.html')))), false, '大小写敏感时不应放行');
    assert.strictEqual(same(event(fileUrl(path.join(flipped, 'index.html')))), true, '关闭大小写敏感时应放行');
  }
});
