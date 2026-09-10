'use strict';

/* 数据仓库单测：缓存 / 原子落盘 / 写合并 / 备份自愈 / 补丁提交 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createStore } = require('../lib/store.js');
const { migrate } = require('../lib/migrate.js');
const proto = require('../renderer/storeproto.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-store-'));
}

function defaults() {
  return {
    version: 2,
    profile: { name: '我的工作台', greeting: '' },
    todos: [], notes: [], checkins: [], shortcuts: [], groups: [], pomoDone: {},
    settings: { mode: 'normal', layout: 'overlay', theme: 'light', widgets: { clock: false, todos: false, notes: false } }
  };
}

function newStore(dir, opts) {
  return createStore(Object.assign({
    filePath: path.join(dir, 'workbench-data.json'),
    backupDir: path.join(dir, 'backups'),
    defaults: defaults,
    migrate: migrate,
    debounceMs: 5
  }, opts || {}));
}

test('首次读取返回默认结构，落盘后可再次读回', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  const d = s.read();
  assert.strictEqual(d.version, 2);
  assert.deepStrictEqual(d.todos, []);
  s.mutate(x => { x.todos.push({ id: 'a', text: 'hello' }); });
  assert.strictEqual(s.flush(), true);
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'workbench-data.json'), 'utf8'));
  assert.strictEqual(onDisk.todos[0].text, 'hello');
  assert.ok(s.getRev() > 0);
});

test('read() 走内存缓存：外部改文件不影响已装载的副本', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  s.mutate(x => { x.todos.push({ id: 'a', text: 'cached' }); });
  s.flush();
  const file = path.join(dir, 'workbench-data.json');
  fs.writeFileSync(file, JSON.stringify({ version: 2, todos: [{ id: 'z', text: '外部写入' }], settings: {} }), 'utf8');
  assert.strictEqual(s.read().todos[0].text, 'cached', '不应每次重新读盘');
});

test('写合并：多次变更只落盘一次，flush 立即生效', async () => {
  const dir = tmpDir();
  const s = newStore(dir, { debounceMs: 50 });
  s.read();                       // 首次装载（会同步建立初始文件，不计入下面的合并统计）
  let writes = 0;
  const origWrite = fs.writeFileSync;
  fs.writeFileSync = (...args) => { if (String(args[0]).includes('workbench-data')) writes++; return origWrite.apply(fs, args); };
  try {
    for (let i = 0; i < 5; i++) s.mutate(x => { x.todos.push({ id: 'i' + i, text: 'x' }); });
    assert.strictEqual(writes, 0, '合并窗口内不应反复写盘');
    await new Promise(r => setTimeout(r, 120));
    assert.strictEqual(writes, 1, '合并窗口结束后只写一次');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'workbench-data.json'), 'utf8')).todos.length, 5, '合并不能丢改动');
    // flush 立即落盘
    s.mutate(x => { x.todos.push({ id: 'z', text: 'z' }); });
    assert.strictEqual(s.flush(), true);
    assert.strictEqual(writes, 2);
  } finally {
    fs.writeFileSync = origWrite;
  }
});

test('原子写：不留下半截文件（写临时文件后 rename）', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  s.mutate(x => { x.todos.push({ id: 'a' }); });
  s.flush();
  assert.strictEqual(fs.existsSync(path.join(dir, 'workbench-data.json.tmp')), false);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(path.join(dir, 'workbench-data.json'), 'utf8')));
});

test('补丁提交：只应用差异，主进程并发写入不丢', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  s.mutate(x => { x.todos.push({ id: 'a', text: 'A', done: false }); });
  s.flush();
  // 渲染层基于当前状态做了一次编辑，并算出补丁
  const base = s.snapshot();
  const local = proto.clone(base);
  local.todos[0].done = true;
  const patch = proto.diffPatch(base, local);
  // 提交之前，主进程又加了一条（模拟全局快速添加）
  s.mutate(x => { x.todos.unshift({ id: 'quick', text: '快速添加', done: false }); });
  const res = s.commit(patch);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.changed, true);
  const ids = s.read().todos.map(t => t.id);
  assert.deepStrictEqual(ids, ['quick', 'a'], '并发新增的条目必须保留');
  assert.strictEqual(s.read().todos.find(t => t.id === 'a').done, true, '渲染层的编辑必须生效');
});

test('空补丁与无差异补丁不产生修订号变化', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  const rev0 = s.getRev();
  assert.strictEqual(s.commit(null).changed, false);
  const same = proto.diffPatch(s.snapshot(), s.snapshot());
  assert.strictEqual(same, null);
  assert.strictEqual(s.getRev(), rev0);
});

test('主文件损坏时从最近备份自愈', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'workbench-data.json');
  const backupDir = path.join(dir, 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(file, '{ 这不是 JSON', 'utf8');
  fs.writeFileSync(path.join(backupDir, 'workbench-20260101-000000.json'),
    JSON.stringify({ version: 2, todos: [{ id: 'bk', text: '来自备份' }], settings: {} }), 'utf8');
  const s = newStore(dir);
  const d = s.read();
  assert.strictEqual(d.todos[0].text, '来自备份');
  const diag = s.diagnostics();
  assert.strictEqual(diag.recoveredFrom, 'workbench-20260101-000000.json');
  // 自愈后应把恢复结果写回主文件
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
});

test('备份：写入合并窗口内的改动也会被 flush 后再备份，并只保留最近 N 份', () => {
  const dir = tmpDir();
  const s = newStore(dir, { keepBackups: 3, debounceMs: 5000 });
  fs.writeFileSync(path.join(dir, 'workbench-data.json'), JSON.stringify({ version: 2, todos: [{ id: 'a' }], settings: {} }), 'utf8');
  const p1 = s.backup();
  assert.ok(p1 && fs.existsSync(p1));
  assert.strictEqual(JSON.parse(fs.readFileSync(p1, 'utf8')).todos[0].id, 'a');
  // 造出多于上限的备份，验证轮转
  for (let i = 0; i < 6; i++) {
    fs.writeFileSync(path.join(dir, 'backups', 'workbench-2026010' + i + '-000000.json'), '{}', 'utf8');
  }
  s.backup();
  const list = s.listBackups();
  assert.ok(list.length <= 3, '备份份数应受 keepBackups 限制，实际 ' + list.length);
});

test('结构升级前会留一份不会被轮转清理的迁移前备份', () => {
  const dir = tmpDir();
  const file = path.join(dir, 'workbench-data.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1, todos: [], notes: [], checkins: [], shortcuts: [], groups: [],
    settings: {}, view: 'todos', _pomoDone: { '2026-09-01': 2 }
  }), 'utf8');
  const s = newStore(dir);
  const d = s.read();
  assert.strictEqual(d.version, 2);
  assert.deepStrictEqual(d.pomoDone, { '2026-09-01': 2 });
  assert.strictEqual(d.view, undefined);
  const files = fs.readdirSync(path.join(dir, 'backups'));
  assert.ok(files.some(f => f.startsWith('workbench-premigrate-')), '应留下迁移前备份：' + files.join(','));
  assert.deepStrictEqual(s.listBackups(), [], '迁移前备份不参与常规备份列表/轮转');
  // 原文件已被升级后的结构覆盖
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('变更事件带来源与修订号', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  const events = [];
  s.on(e => events.push(e));
  s.mutate(x => { x.todos.push({ id: 'a' }); });
  const base = s.snapshot();
  const local = proto.clone(base);
  local.todos[0].text = 'x';
  s.commit(proto.diffPatch(base, local));
  assert.strictEqual(events.length, 2);
  assert.strictEqual(events[0].origin, 'main');
  assert.strictEqual(events[1].origin, 'renderer');
  assert.ok(events[1].rev > events[0].rev);
});

test('mutate 返回 false 表示无改动，不产生修订号', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  const rev0 = s.getRev();
  s.mutate(() => false);
  assert.strictEqual(s.getRev(), rev0);
});

test('replace（导入数据）会重新归一化并落盘', () => {
  const dir = tmpDir();
  const s = newStore(dir);
  s.replace({ version: 1, todos: [{ id: 'i', text: '导入', repeat: 'daily' }], settings: {}, view: 'notes' });
  const d = s.read();
  assert.strictEqual(d.todos[0].repeat, 'none', '导入的数据也要过归一化');
  assert.strictEqual(d.view, undefined, '导入不该带回界面状态');
  s.flush();
  assert.ok(fs.existsSync(path.join(dir, 'workbench-data.json')));
});
