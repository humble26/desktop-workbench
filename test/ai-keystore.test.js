'use strict';

/* ===========================================================================
   AI 密钥库单测
   ---------------------------------------------------------------------------
   这一组测试守的是「密钥不能明文落盘、也不能回到渲染层」这两条：
     · 文件里出现明文密钥 → 失败
     · safeStorage 不可用时仍然把密钥写下去 → 失败
     · list()（渲染层唯一能读到的形状）里出现明文 → 失败
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createKeyStore } = require('../lib/ai/keystore.js');

const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz012345';

/* 替身 safeStorage：与真实实现一样是「可逆加密」，
   但刻意让密文里不出现明文子串（base64 之后不会包含原始字符序列），
   这样「文件里不得含明文」这条断言才有意义。 */
function fakeSafeStorage(available) {
  return {
    isEncryptionAvailable: () => available !== false,
    encryptString: (s) => Buffer.from('ENC1:' + Buffer.from(s, 'utf8').toString('base64'), 'utf8'),
    decryptString: (buf) => {
      const t = buf.toString('utf8');
      if (!t.startsWith('ENC1:')) throw new Error('坏密文');
      return Buffer.from(t.slice(5), 'base64').toString('utf8');
    }
  };
}

function env(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-keys-'));
  const file = path.join(dir, 'ai-keys.json');
  const store = createKeyStore({
    filePath: () => file,
    safeStorage: o.safeStorage === undefined ? fakeSafeStorage(true) : o.safeStorage,
    logE: () => {}
  });
  return { dir, file, store };
}

test('保存后能取回，且掩码只露头尾', () => {
  const e = env();
  const r = e.store.set('deepseek', SECRET);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.masked, 'sk-****2345');
  assert.strictEqual(e.store.get('deepseek'), SECRET);
  assert.strictEqual(e.store.has('deepseek'), true);
});

test('密钥文件里不得出现明文密钥（本功能的核心安全承诺）', () => {
  const e = env();
  e.store.set('deepseek', SECRET);
  const raw = fs.readFileSync(e.file, 'utf8');
  assert.ok(raw.indexOf(SECRET) === -1, '文件里出现了明文密钥！');
  assert.ok(raw.indexOf('abcdefghijklmnop') === -1, '文件里出现了密钥片段！');
  const parsed = JSON.parse(raw);
  assert.strictEqual(parsed.version, 1);
  assert.ok(parsed.keys.deepseek.enc, '应该是密文字段');
  assert.ok(parsed.keys.deepseek.at > 0, '应记录保存时间');
});

test('list() 是渲染层唯一读得到的形状，里面绝不能有明文', () => {
  const e = env();
  e.store.set('deepseek', SECRET);
  e.store.set('custom', 'another-secret-value-123456');
  const json = JSON.stringify(e.store.list());
  assert.ok(json.indexOf(SECRET) === -1, 'list() 泄露了明文');
  assert.ok(json.indexOf('another-secret-value') === -1, 'list() 泄露了明文');
  assert.strictEqual(e.store.list().deepseek.masked, 'sk-****2345');
  assert.strictEqual(e.store.list().deepseek.readable, true);
});

test('safeStorage 不可用时拒绝保存，并且不产生任何文件', () => {
  const e = env({ safeStorage: fakeSafeStorage(false) });
  const r = e.store.set('deepseek', SECRET);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /安全存储|明文/);
  assert.strictEqual(fs.existsSync(e.file), false, '拒绝保存时不该留下文件');
  assert.strictEqual(e.store.get('deepseek'), '');
});

test('换机器 / 换用户后解不开：get 返回空、list 标记为不可读，且不抛异常', () => {
  const e = env();
  e.store.set('deepseek', SECRET);
  // 模拟「密文无法用当前用户解开」：直接把密文换成一段无效数据
  const parsed = JSON.parse(fs.readFileSync(e.file, 'utf8'));
  parsed.keys.deepseek.enc = Buffer.from('NOT-OUR-FORMAT', 'utf8').toString('base64');
  fs.writeFileSync(e.file, JSON.stringify(parsed), 'utf8');

  const fresh = createKeyStore({ filePath: () => e.file, safeStorage: fakeSafeStorage(true), logE: () => {} });
  assert.strictEqual(fresh.get('deepseek'), '');
  assert.strictEqual(fresh.list().deepseek.readable, false);
  assert.strictEqual(fresh.list().deepseek.masked, '****');
  assert.strictEqual(fresh.has('deepseek'), true, '密文还在，只是解不开');
});

test('空密钥、超长密钥、缺平台标识都被拒绝', () => {
  const e = env();
  assert.match(e.store.set('deepseek', '').error, /密钥为空/);
  assert.match(e.store.set('deepseek', '   ').error, /密钥为空/);
  assert.match(e.store.set('', SECRET).error, /缺少平台标识/);
  assert.match(e.store.set('deepseek', 'x'.repeat(600)).error, /过长/);
  assert.strictEqual(fs.existsSync(e.file), false);
});

test('保存时清洗首尾空白与引号（用户往往是复制粘贴进来的）', () => {
  const e = env();
  e.store.set('deepseek', '  "' + SECRET + '"  ');
  assert.strictEqual(e.store.get('deepseek'), SECRET);
});

test('删除与清空', () => {
  const e = env();
  e.store.set('deepseek', SECRET);
  e.store.set('moonshot', 'sk-moonshot-1234567890');
  assert.strictEqual(e.store.remove('deepseek').removed, true);
  assert.strictEqual(e.store.remove('deepseek').removed, false, '重复删除应报告未删除');
  assert.strictEqual(e.store.has('deepseek'), false);
  assert.strictEqual(e.store.has('moonshot'), true);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(e.file, 'utf8')).keys), ['moonshot']);
  e.store.clear();
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(e.file, 'utf8')).keys), []);
});

test('文件损坏时不抛异常，按「没有配置过密钥」处理', () => {
  const e = env();
  fs.writeFileSync(e.file, '{ 这不是 JSON', 'utf8');
  const fresh = createKeyStore({ filePath: () => e.file, safeStorage: fakeSafeStorage(true), logE: () => {} });
  assert.doesNotThrow(() => fresh.list());
  assert.deepStrictEqual(fresh.list(), {});
  assert.strictEqual(fresh.has('deepseek'), false);
  assert.ok(fresh.lastError(), '解析失败应留下可诊断的记录');
});

test('后端名称会如实反映是否可用（界面据此提示，而不是静默降级）', () => {
  assert.match(env().store.backendName(), /DPAPI|钥匙串|密钥环/);
  const off = env({ safeStorage: fakeSafeStorage(false) });
  assert.strictEqual(off.store.backendName(), '不可用');
  assert.strictEqual(off.store.encryptionAvailable(), false);
});
