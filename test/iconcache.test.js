'use strict';

/* 图标缓存单测：落盘、短引用、路径安全、清理 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createIconCache, dataUrlToBuffer } = require('../lib/iconcache.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-icon-'));
}

// 生成一个足够大的合法 PNG data URL（内容不同 → 哈希不同）
function pngDataUrl(seed) {
  const body = Buffer.alloc(400);
  for (let i = 0; i < body.length; i++) body[i] = (i * 7 + seed * 31) % 256;
  return 'data:image/png;base64,' + body.toString('base64');
}

test('落盘后返回 file:// URL，同名内容复用同一文件', () => {
  const dir = tmpDir();
  const c = createIconCache({ dir: dir });
  const a = c.store(pngDataUrl(1));
  assert.ok(a && a.ref && a.url);
  assert.strictEqual(a.ref.indexOf('icon:'), 0);
  assert.strictEqual(/^icon:[0-9a-f]{8,64}\.png$/.test(a.ref), true);
  assert.ok(fs.existsSync(path.join(dir, a.name)), 'PNG 应已落盘');
  assert.ok(a.url.indexOf('file://') === 0);
  assert.strictEqual(c.urlOf(a.ref), a.url);

  const b = c.store(pngDataUrl(1));            // 同样内容
  assert.strictEqual(b.name, a.name, '相同图标应复用同一文件');
  assert.strictEqual(fs.readdirSync(dir).length, 1);

  const d = c.store(pngDataUrl(2));            // 不同内容
  assert.notStrictEqual(d.name, a.name);
  assert.strictEqual(fs.readdirSync(dir).length, 2);
});

test('拒绝非法输入（非图片 data URL、过小内容）', () => {
  const c = createIconCache({ dir: tmpDir() });
  assert.strictEqual(c.store('data:text/plain;base64,aGVsbG8='), null);
  assert.strictEqual(c.store('data:image/png;base64,AAA='), null, '内容过小视为无效');
  assert.strictEqual(c.store(''), null);
  assert.strictEqual(c.store(null), null);
  assert.strictEqual(c.store('file:///etc/passwd'), null);
  assert.strictEqual(dataUrlToBuffer('data:image/png;base64,' + Buffer.alloc(200).toString('base64')).length, 200);
});

test('引用与 URL 解析都拒绝路径穿越', () => {
  const dir = tmpDir();
  const c = createIconCache({ dir: dir });
  const evil = [
    'icon:../../evil.png',
    'icon:..\\..\\evil.png',
    'icon:evil.png',
    'icon:/absolute.png',
    'file:///C:/Windows/System32/evil.png',
    'file://' + path.join(dir, '..', 'evil.png'),
    'file://' + path.join(dir, 'notahash.png')
  ];
  for (const v of evil) {
    assert.strictEqual(c.nameOf(v), null, v + ' 不应解析出文件名');
    assert.strictEqual(c.resolveRef(v), null);
    assert.strictEqual(c.urlOf(v), null);
  }
  // 合法 URL 形式（数据文件里存的就是这个）必须能解析回来，供清理时对账
  const saved = c.store(pngDataUrl(3));
  assert.strictEqual(c.nameOf(saved.url), saved.name);
  assert.strictEqual(c.isRef(saved.ref), true);
  assert.strictEqual(c.isRef(saved.url), false);
});

test('清理：被引用的图标永不删除，其余按最近使用保留上限数量', () => {
  const dir = tmpDir();
  const c = createIconCache({ dir: dir, maxFiles: 2 });
  const keep = c.store(pngDataUrl(100));            // 最先创建（最旧），但被引用
  for (let i = 0; i < 4; i++) c.store(pngDataUrl(200 + i));
  assert.strictEqual(fs.readdirSync(dir).length, 5);

  const r = c.prune([keep.url]);
  assert.ok(r.removed >= 1, '超出上限的未引用图标应被清理，实际删除 ' + r.removed);
  assert.ok(fs.existsSync(path.join(dir, keep.name)), '被引用的图标必须保留（即使是最旧的）');
  const left = fs.readdirSync(dir).length;
  assert.strictEqual(left, 3, '应保留 2 个最近 + 1 个被引用的，实际 ' + left);
  assert.strictEqual(c.stats().files, 3);

  // 二次清理是幂等的
  assert.strictEqual(c.prune([keep.url]).removed, 0);
});

test('清理时也能识别数据文件里存的 file:// URL 形式', () => {
  const dir = tmpDir();
  const c = createIconCache({ dir: dir, maxFiles: 1 });
  const a = c.store(pngDataUrl(300));
  c.store(pngDataUrl(301));
  c.store(pngDataUrl(302));
  // 数据文件里存的就是 URL，清理对账必须认这种形式
  c.prune([a.url]);
  assert.ok(fs.existsSync(path.join(dir, a.name)));
});

test('清理在目录不存在时不报错，统计可用', () => {
  const dir = path.join(tmpDir(), 'not-created-yet');
  const c = createIconCache({ dir: dir });
  assert.deepStrictEqual(c.prune([]), { removed: 0, kept: 0 });
  assert.deepStrictEqual(c.stats(), { files: 0, bytes: 0 });
  c.store(pngDataUrl(4));
  const s = c.stats();
  assert.strictEqual(s.files, 1);
  assert.ok(s.bytes > 100);
});

test('写盘失败时返回 null（调用方退回内联 data URL，功能不中断）', () => {
  const dir = tmpDir();
  const c = createIconCache({ dir: path.join(dir, 'file-not-dir') });
  // 用文件占住路径，使 mkdir 必然失败
  fs.writeFileSync(path.join(dir, 'file-not-dir'), 'x');
  assert.strictEqual(c.store(pngDataUrl(5)), null);
});
