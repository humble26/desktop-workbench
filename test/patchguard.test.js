'use strict';

/* 补丁守卫单测：形状、白名单、体积限制、界面状态拦截 */

const test = require('node:test');
const assert = require('node:assert');
const { validatePatch, DEFAULT_LIMITS } = require('../lib/patchguard.js');
const proto = require('../renderer/storeproto.js');

const OPTS = { collections: proto.COLLECTIONS, ephemeralKeys: proto.EPHEMERAL_KEYS };

test('合法补丁通过（含空提交）', () => {
  assert.strictEqual(validatePatch(null, OPTS), null);
  assert.strictEqual(validatePatch(undefined, OPTS), null);
  assert.strictEqual(validatePatch({}, OPTS), null);
  assert.strictEqual(validatePatch({
    collections: { todos: { order: ['a'], upsert: [{ id: 'a', text: 'x' }], remove: [] } },
    settings: { theme: 'dark' },
    top: { pomoDone: { '2026-09-07': 1 } }
  }, OPTS), null);
});

test('真实 diffPatch 产出的补丁一定合法（协议与守卫不脱节）', () => {
  const base = { todos: [{ id: 'a', text: 'x' }], settings: { theme: 'light' }, pomoDone: {} };
  const next = { todos: [{ id: 'a', text: 'y' }, { id: 'b', text: 'z' }], settings: { theme: 'dark' }, pomoDone: { '2026-09-07': 2 } };
  const patch = proto.diffPatch(base, next);
  assert.strictEqual(validatePatch(patch, OPTS), null, '协议产出的补丁必须通过守卫：' + validatePatch(patch, OPTS));
});

test('拒绝未知顶层字段与未知集合/操作', () => {
  assert.match(validatePatch({ evil: 1 }, OPTS), /未知字段/);
  assert.match(validatePatch({ collections: { secrets: {} } }, OPTS), /未知集合/);
  assert.match(validatePatch({ collections: { todos: { wipe: true } } }, OPTS), /未知操作/);
});

test('拒绝借 top 写入界面状态（这些字段不属于数据文件）', () => {
  for (const k of proto.EPHEMERAL_KEYS) {
    const reason = validatePatch({ top: { [k]: 1 } }, OPTS);
    assert.match(String(reason), /界面状态/, k + ' 应被拒绝');
  }
  assert.match(validatePatch({ top: { settings: {} } }, OPTS), /不允许覆盖/);
  assert.match(validatePatch({ top: { collections: {} } }, OPTS), /不允许覆盖/);
});

test('拒绝结构性错误', () => {
  assert.match(validatePatch([], OPTS), /必须是对象/);
  assert.match(validatePatch({ collections: [] }, OPTS), /collections 必须是对象/);
  assert.match(validatePatch({ collections: { todos: [] } }, OPTS), /操作必须是对象/);
  assert.match(validatePatch({ collections: { todos: { upsert: 'nope' } } }, OPTS), /upsert 必须是数组/);
  assert.match(validatePatch({ collections: { todos: { upsert: [{ text: '无 id' }] } } }, OPTS), /缺少 id/);
  assert.match(validatePatch({ collections: { todos: { upsert: [null] } } }, OPTS), /必须是对象/);
  assert.match(validatePatch({ collections: { todos: { remove: 'x' } } }, OPTS), /remove 必须是数组/);
  assert.match(validatePatch({ collections: { todos: { order: 'x' } } }, OPTS), /order 必须是数组/);
  assert.match(validatePatch({ settings: [] }, OPTS), /settings 必须是对象/);
  assert.match(validatePatch({ top: [] }, OPTS), /top 必须是对象/);
});

test('限制单次提交规模（防异常状态写爆内存/磁盘）', () => {
  const many = new Array(DEFAULT_LIMITS.maxUpserts + 1).fill(0).map((_, i) => ({ id: 'i' + i }));
  assert.match(validatePatch({ collections: { todos: { upsert: many } } }, OPTS), /条目过多/);

  const huge = new Array(DEFAULT_LIMITS.maxOrder + 1).fill('x');
  assert.match(validatePatch({ collections: { todos: { order: huge } } }, OPTS), /顺序数组过长/);

  const big = 'x'.repeat(DEFAULT_LIMITS.maxBytes + 10);
  assert.match(validatePatch({ settings: { note: big } }, OPTS), /补丁过大/);

  // 自定义上限可收紧（设置页/测试用）
  assert.match(validatePatch({ collections: { todos: { upsert: [{ id: 'a' }, { id: 'b' }] } } }, Object.assign({ limits: { maxUpserts: 1 } }, OPTS)), /条目过多/);
});

test('无法序列化的补丁被拒绝（循环引用）', () => {
  const cyc = {};
  cyc.self = cyc;
  assert.match(validatePatch({ settings: cyc }, OPTS), /无法序列化/);
});
