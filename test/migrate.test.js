'use strict';

/* 数据迁移单测：v1 → v2 升级、界面状态剥离、未知字段保留、幂等性 */

const test = require('node:test');
const assert = require('node:assert');
const { migrate, SCHEMA_VERSION } = require('../lib/migrate.js');

// 贴近真实用户数据（取自实际数据文件结构，含历史遗留键）
function v1Data() {
  return {
    version: 1,
    profile: { name: '我的工作台', greeting: '' },
    todos: [{
      id: 't1', text: '交报告', level: 'mid', done: false, date: '2026-09-07',
      due: '2026-09-07', dueTime: '15:30', repeat: 'none', note: '', subtasks: [],
      doneHistory: [], remind: 0, _remindedToday: '2026-09-07'
    }],
    notes: [],
    checkins: [{ id: 'c1', name: '跑步', emoji: '🏃', done: true, streak: 3, last: '2026-09-07' }],
    shortcuts: [{ id: 's1', name: 'VSCode', path: 'C:\\vscode.exe', icon: null }],
    groups: [{ id: 'g1', name: '文档', color: '#6f8f6a', items: [] }],
    settings: {
      mode: 'top', layout: 'overlay', theme: 'dark', accent: '#2f2e2b',
      _dailyRemindDate: '2026-09-07',
      clipboardSensitive: true,                       // 本版本不认识的键，必须保留
      someFutureSetting: { a: 1 },
      timeTrack: { enabled: true, idleSeconds: 300, recordTitles: false, rules: [{ match: 'exe', value: 'code', category: '开发' }] },
      autoOrganize: { enabled: false, watch: '', rules: [] },
      widgets: { clock: true, todos: false, notes: false },
      pomodoro: { mode: 'focus' },
      winBounds: { x: 100, y: 100, width: 1120, height: 740 }
    },
    pomoDone: undefined,
    _pomoDone: { '2026-09-06': 4 },
    view: 'shortcuts',
    _todoLv: 'mid',
    _todoFilter: 'all',
    _pomo: { total: 1500, remaining: 1500, running: false, _last: null }
  };
}

test('v1 → v2：界面状态移出数据文件', () => {
  const d = v1Data();
  const r = migrate(d);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(d.version, SCHEMA_VERSION);
  for (const k of ['view', '_todoLv', '_todoFilter', '_pomo']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(d, k), false, k + ' 应被移除');
  }
  // 界面状态之外的业务数据保持原样
  assert.strictEqual(d.todos.length, 1);
  assert.strictEqual(d.settings.mode, 'top');
  assert.strictEqual(d.settings.theme, 'dark');
});

test('v1 → v2：下划线私有字段改名为正式字段且保留取值', () => {
  const d = v1Data();
  migrate(d);
  assert.deepStrictEqual(d.pomoDone, { '2026-09-06': 4 });
  assert.strictEqual(d.todos[0].remindedOn, '2026-09-07');
  assert.strictEqual(d.settings.dailyRemindOn, '2026-09-07');
  assert.strictEqual(Object.prototype.hasOwnProperty.call(d.todos[0], '_remindedToday'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(d, '_pomoDone'), false);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(d.settings, '_dailyRemindDate'), false);
});

test('未知字段一律保留（升级不能丢用户配置）', () => {
  const d = v1Data();
  migrate(d);
  assert.strictEqual(d.settings.clipboardSensitive, true);
  assert.deepStrictEqual(d.settings.someFutureSetting, { a: 1 });
  assert.deepStrictEqual(d.shortcuts[0], { id: 's1', name: 'VSCode', path: 'C:\\vscode.exe', icon: null });
});

test('迁移是幂等的：第二次执行不再报告改动', () => {
  const d = v1Data();
  const first = migrate(d);
  assert.strictEqual(first.changed, true);
  const snapshot = JSON.stringify(d);
  const second = migrate(d);
  assert.strictEqual(second.changed, false, '重复启动不应触发重写与迁移前备份');
  assert.strictEqual(JSON.stringify(d), snapshot);
});

test('字段归一化：补默认值、清无到期日的重复标记、修结构异常', () => {
  const d = {
    version: 2,
    todos: [
      { id: 'x', text: 'a', repeat: 'daily' },                       // 无 due 的重复 → repeat=none
      { id: 'y', text: 'b', level: 'weird', subtasks: 'oops' },
      { text: '没有 id' }
    ],
    notes: 'not-an-array',
    settings: { timeTrack: { idleSeconds: 7, rules: 'bad' } }
  };
  const r = migrate(d);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(d.todos[0].repeat, 'none');
  assert.strictEqual(d.todos[1].level, 'mid');
  assert.deepStrictEqual(d.todos[1].subtasks, []);
  assert.ok(d.todos[2].id, '缺失 id 应补齐');
  assert.deepStrictEqual(d.notes, [], '结构异常集合应重置');
  assert.strictEqual(d.settings.timeTrack.idleSeconds, 300);
  assert.deepStrictEqual(d.settings.timeTrack.rules, []);
  assert.strictEqual(d.settings.layout, 'overlay');
  assert.strictEqual(d.settings.theme, 'light');
});

test('默认结构本身必须是「已归一化」的（否则首次启动会被当成一次结构升级）', () => {
  const { defaultData } = require('../lib/defaults.js');
  const d = defaultData();
  const r = migrate(d);
  assert.strictEqual(r.changed, false, '全新默认数据不应触发任何归一化改动：' + JSON.stringify(r.steps));
  assert.strictEqual(d.version, SCHEMA_VERSION);
  // 归一化后再跑一次依然稳定
  assert.strictEqual(migrate(d).changed, false);
});

test('损坏/空数据不抛异常', () => {
  const d = {};
  const r = migrate(d);
  assert.strictEqual(r.changed, true);
  assert.strictEqual(d.version, 2);
  assert.deepStrictEqual(d.todos, []);
  assert.strictEqual(d.profile.name, '我的工作台');
  assert.strictEqual(migrate(null).changed, false);
});
