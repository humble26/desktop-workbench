'use strict';

/* IPC 来源校验单测：只放行本应用 renderer 目录下的顶层本地页面 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createTrustedSenderChecker } = require('../lib/security.js');

const RENDERER = path.resolve('C:\\app\\resources\\app\\renderer');
const check = createTrustedSenderChecker({ rendererDir: RENDERER, caseInsensitive: true });

// 构造一个最小 event：主框架的 parent 为 null（新实现用 parent 判断是否顶层，
// 不再依赖 senderFrame 与 sender.mainFrame 的对象同一性 —— 那正是 v1.8.2 空白界面的成因）
function event(url, opts) {
  const o = opts || {};
  const mainFrame = { url: url, detached: false, parent: null };
  const frame = o.iframe
    ? { url: url, detached: false, parent: { url: url } }   // 子框架：有 parent
    : { url: url, detached: false, parent: null };
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

test('detached 不再作为拒绝理由（不可靠的辅助信号，真正的边界是路径）', () => {
  // 早期实现用 frame.detached === true 拒绝请求。该字段在正常使用中也可能出现，
  // 一旦误判就是「所有 IPC 全被拒 → 界面空白」，而它并不构成安全边界。
  const e = event(fileUrl(path.join(RENDERER, 'index.html')));
  e.senderFrame.detached = true;
  assert.strictEqual(check(e), true, 'detached 不应导致拒绝');
});

test('大小写不敏感平台：大小写混写仍放行', () => {
  const upper = createTrustedSenderChecker({ rendererDir: 'C:\\App\\Renderer', caseInsensitive: true });
  assert.strictEqual(upper(event('file:///c:/app/renderer/index.html')), true);
});

test('回归：senderFrame 与 sender.mainFrame 不是同一对象时也必须放行', () => {
  // v1.8.2 界面空白的真正原因：曾用 `senderFrame !== sender.mainFrame` 判断顶层框架，
  // 而 Electron 不保证两者是同一个 JS 对象 —— 打包环境下两者是不同实例，
  // 于是所有 IPC 被拒，页面拿不到数据、启动中断、整屏空白。
  // 这个用例把「不同实例」这一形态固定下来，任何重新引入对象同一性判断的改动都会失败。
  const url = fileUrl(path.join(RENDERER, 'index.html'));
  const senderFrame = { url: url, detached: false };
  const mainFrame = { url: url, detached: false };      // 内容相同但不同对象
  const ev = { senderFrame: senderFrame, sender: { mainFrame: mainFrame } };
  assert.notStrictEqual(senderFrame, mainFrame, '前提：两者是不同对象');
  assert.strictEqual(check(ev), true, '不同实例的顶层框架必须放行');
});

test('顶层框架判断改用 parent：拿不到 parent 时放行，有 parent（iframe）时拒绝', () => {
  const url = fileUrl(path.join(RENDERER, 'index.html'));
  // 主框架：parent 为 null
  assert.strictEqual(check({ senderFrame: { url: url, parent: null }, sender: {} }), true);
  // parent 不可读（未提供）：不因此拒绝（纵深防御而非安全边界）
  assert.strictEqual(check({ senderFrame: { url: url }, sender: {} }), true);
  // 子框架：parent 是对象
  assert.strictEqual(check({ senderFrame: { url: url, parent: { url: url } }, sender: {} }), false);
});

test('打包环境：asar 路径 + 中文安装目录 + 百分号编码都应放行', () => {
  // 打包后 __dirname 形如 ...\resources\app.asar，安装目录还可能含中文
  const asarRoot = path.resolve('C:\\Users\\me\\AppData\\Local\\Programs\\桌面工作台\\resources\\app.asar');
  const c = createTrustedSenderChecker({ rendererDir: path.join(asarRoot, 'renderer'), caseInsensitive: true });
  const page = path.join(asarRoot, 'renderer', 'index.html');
  const ev = { senderFrame: { url: fileUrl(page), parent: null }, sender: { mainFrame: {} } };
  assert.strictEqual(c(ev), true, 'asar + 中文路径必须放行：' + fileUrl(page));
  // 非 asar 情况下同一套逻辑也应成立
  assert.strictEqual(c({ senderFrame: { url: fileUrl(path.join(asarRoot, 'evil.html')), parent: null } }), false);
});

test('拒绝原因可查（便于诊断，不再静默失败）', () => {
  const url = fileUrl(path.join(RENDERER, 'index.html'));
  const c = createTrustedSenderChecker({ rendererDir: RENDERER, caseInsensitive: true });
  assert.strictEqual(c({ senderFrame: { url: 'https://example.com/', parent: null } }), false);
  const r = c.lastRejection();
  assert.ok(r && r.reason, '应记录拒绝原因');
  assert.match(String(r.reason), /file:/);
  assert.strictEqual(r.url, 'https://example.com/');
});

test('放行时不写拒绝记录', () => {
  const c = createTrustedSenderChecker({ rendererDir: RENDERER, caseInsensitive: true });
  assert.strictEqual(c({ senderFrame: { url: fileUrl(path.join(RENDERER, 'index.html')), parent: null } }), true);
  assert.strictEqual(c.lastRejection(), null);
});

test('回归：拿不到 senderFrame 时回退用 WebContents.getURL()，不得全量拒绝', () => {
  // 另一种可能导致「所有 IPC 被拒 → 界面空白」的情形：Electron 未提供 senderFrame。
  // 回退到 sender.getURL()（官方 API）后仍能正常校验来源。
  const url = fileUrl(path.join(RENDERER, 'index.html'));
  const ev = {
    senderFrame: null,
    sender: { mainFrame: null, getURL: () => url }
  };
  assert.strictEqual(check(ev), true, 'senderFrame 缺失时应回退 getURL 并通过');

  // 回退路径同样要能拒绝外部页面
  const evil = { senderFrame: null, sender: { getURL: () => 'https://example.com/' } };
  assert.strictEqual(check(evil), false);
  const outside = { senderFrame: null, sender: { getURL: () => fileUrl('C:\\Windows\\Temp\\x.html') } };
  assert.strictEqual(check(outside), false);

  // 两条路都拿不到 → 拒绝（无法确定来源）
  const none = { senderFrame: null, sender: {} };
  assert.strictEqual(check(none), false);
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
