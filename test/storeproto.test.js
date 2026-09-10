'use strict';

/* 数据协议单测：差分 / 应用 / 界面状态剥离
   重点覆盖「主进程并发写入不被渲染层补丁覆盖」这一核心回归。 */

const test = require('node:test');
const assert = require('node:assert');
const proto = require('../renderer/storeproto.js');

function baseState() {
  return {
    version: 2,
    profile: { name: '我的工作台' },
    todos: [
      { id: 'a', text: '买牛奶', done: false, level: 'mid', subtasks: [], doneHistory: [] },
      { id: 'b', text: '写周报', done: false, level: 'high', subtasks: [], doneHistory: [] }
    ],
    notes: [{ id: 'n1', title: '灵感', body: '', date: '2026-09-07' }],
    checkins: [],
    shortcuts: [],
    groups: [],
    pomoDone: {},
    settings: { mode: 'normal', layout: 'overlay', theme: 'light', clipboardSensitive: true }
  };
}

test('无改动时 diffPatch 返回 null', () => {
  const s = baseState();
  assert.strictEqual(proto.diffPatch(s, proto.clone(s)), null);
});

test('只改动一个待办时，补丁只带上该待办', () => {
  const base = baseState();
  const next = proto.clone(base);
  next.todos[1].done = true;
  const patch = proto.diffPatch(base, next);
  assert.ok(patch, '应有补丁');
  assert.deepStrictEqual(patch.collections.todos.upsert.map(t => t.id), ['b']);
  assert.deepStrictEqual(patch.collections.todos.remove, []);
  assert.deepStrictEqual(patch.collections.todos.order, ['a', 'b']);
  assert.strictEqual(patch.settings, null);
  assert.strictEqual(patch.top, null);
});

test('删除条目走 remove，重排只带 order', () => {
  const base = baseState();
  const next = proto.clone(base);
  next.todos = [next.todos[1], next.todos[0]];
  const patch = proto.diffPatch(base, next);
  assert.deepStrictEqual(patch.collections.todos.order, ['b', 'a']);
  assert.deepStrictEqual(patch.collections.todos.upsert, []);
  assert.deepStrictEqual(patch.collections.todos.remove, []);

  const next2 = proto.clone(base);
  next2.todos = [next2.todos[0]];
  const patch2 = proto.diffPatch(base, next2);
  assert.deepStrictEqual(patch2.collections.todos.remove, ['b']);
});

test('settings 只差量提交，未改动的键（含未知键）不进补丁', () => {
  const base = baseState();
  const next = proto.clone(base);
  next.settings.theme = 'dark';
  const patch = proto.diffPatch(base, next);
  assert.deepStrictEqual(patch.settings, { theme: 'dark' });
  assert.strictEqual(Object.prototype.hasOwnProperty.call(patch.settings, 'clipboardSensitive'), false);
});

test('顶层标量（pomoDone）变化进 top', () => {
  const base = baseState();
  const next = proto.clone(base);
  next.pomoDone = { '2026-09-07': 2 };
  const patch = proto.diffPatch(base, next);
  assert.deepStrictEqual(patch.top, { pomoDone: { '2026-09-07': 2 } });
});

test('核心回归：主进程并发新增的条目不会被渲染层补丁覆盖', () => {
  const base = baseState();
  // 渲染层基于 base 编辑了 a
  const local = proto.clone(base);
  local.todos[0].text = '买牛奶（改）';
  const patch = proto.diffPatch(base, local);
  // 与此同时主进程在权威副本里 unshift 了快速添加的待办 c
  const server = proto.clone(base);
  server.todos.unshift({ id: 'c', text: '快速添加', done: false, level: 'mid', subtasks: [], doneHistory: [] });
  const merged = proto.applyPatch(server, patch);
  assert.deepStrictEqual(merged.todos.map(t => t.id), ['c', 'a', 'b'], '主进程新增的 c 必须保留');
  assert.strictEqual(merged.todos.find(t => t.id === 'a').text, '买牛奶（改）', '渲染层的编辑必须生效');
});

test('核心回归：主进程改了另一个字段，也不会被渲染层补丁回退', () => {
  const base = baseState();
  const local = proto.clone(base);
  local.notes.push({ id: 'n2', title: '第二条', body: '', date: '2026-09-07' });
  const patch = proto.diffPatch(base, local);
  const server = proto.clone(base);
  server.settings.winBounds = { x: 1, y: 2, width: 800, height: 600 };  // 主进程记了窗口位置
  server.pomoDone = { '2026-09-07': 1 };
  const merged = proto.applyPatch(server, patch);
  assert.deepStrictEqual(merged.settings.winBounds, { x: 1, y: 2, width: 800, height: 600 });
  assert.deepStrictEqual(merged.pomoDone, { '2026-09-07': 1 });
  assert.deepStrictEqual(merged.notes.map(n => n.id), ['n1', 'n2']);
});

test('applyPatch 不修改入参，且忽略未知集合', () => {
  const base = baseState();
  const before = JSON.stringify(base);
  const merged = proto.applyPatch(base, {
    collections: { todos: { order: ['a'], upsert: [], remove: ['b'] }, evil: { order: [], upsert: [{ id: 'x' }], remove: [] } },
    settings: { theme: 'dark' },
    top: { profile: { name: 'X' } }
  });
  assert.strictEqual(JSON.stringify(base), before, '入参不应被就地修改');
  assert.deepStrictEqual(merged.todos.map(t => t.id), ['a']);
  assert.strictEqual(merged.evil, undefined, '未知集合应被忽略');
  assert.strictEqual(merged.settings.theme, 'dark');
  assert.strictEqual(merged.settings.clipboardSensitive, true, '浅合并需保留未知设置键');
  assert.deepStrictEqual(merged.profile, { name: 'X' });
});

test('stripEphemeral 去掉界面状态，snapshot 是深拷贝', () => {
  const s = baseState();
  s.view = 'todos';
  s._todoLv = 'high';
  s._pomo = { total: 1500, remaining: 1499, running: true };
  s._calSel = '2026-09-07';
  const stripped = proto.stripEphemeral(s);
  for (const k of proto.EPHEMERAL_KEYS) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(stripped, k), false, k + ' 不应被持久化');
  }
  assert.strictEqual(stripped.todos.length, 2);

  const snap = proto.snapshot(s);
  s.todos[0].text = '改过了';
  s.settings.theme = 'dark';
  assert.strictEqual(snap.todos[0].text, '买牛奶', '基线必须是深拷贝，否则改动会被静默丢弃');
  assert.strictEqual(snap.settings.theme, 'light');
});

test('脏数据不会进入集合（无 id 条目被忽略）', () => {
  const next = { todos: [{ id: 'a', text: 'ok' }, { text: '没有 id' }, null] };
  const patch = proto.diffPatch({ todos: [] }, next);
  assert.deepStrictEqual(patch.collections.todos.order, ['a']);
  const merged = proto.applyPatch({ todos: [] }, patch);
  assert.deepStrictEqual(merged.todos.map(t => t.id), ['a']);
});
