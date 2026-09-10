'use strict';

/* 快速添加文本解析单测（重点是中文相对日期、绝对日期与时间的边界） */

const test = require('node:test');
const assert = require('node:assert');
const { parseQuickTodo, buildQuickTodo } = require('../lib/quickadd.js');

const NOW = new Date('2026-09-07T10:20:00');

test('中文相对日期', () => {
  assert.strictEqual(parseQuickTodo('今天 交报告', NOW).due, '2026-09-07');
  assert.strictEqual(parseQuickTodo('明天 交报告', NOW).due, '2026-09-08');
  assert.strictEqual(parseQuickTodo('明日 交报告', NOW).due, '2026-09-08');
  assert.strictEqual(parseQuickTodo('后天 交报告', NOW).due, '2026-09-09');
  assert.strictEqual(parseQuickTodo('昨天 交报告', NOW).due, '2026-09-06');
  assert.strictEqual(parseQuickTodo('前天 交报告', NOW).due, '2026-09-05');
});

test('相对日期跨月/跨年', () => {
  assert.strictEqual(parseQuickTodo('明天 交报告', new Date('2026-09-30T08:00:00')).due, '2026-10-01');
  assert.strictEqual(parseQuickTodo('明天 交报告', new Date('2026-12-31T08:00:00')).due, '2027-01-01');
  assert.strictEqual(parseQuickTodo('后天 交报告', new Date('2026-02-27T08:00:00')).due, '2026-03-01');
});

test('绝对日期：YYYY-MM-DD / YYYY/M/D / M月D日', () => {
  assert.strictEqual(parseQuickTodo('2026-09-20 交报告', NOW).due, '2026-09-20');
  assert.strictEqual(parseQuickTodo('2026/9/7 交报告', NOW).due, '2026-09-07');
  assert.strictEqual(parseQuickTodo('9月20日 交报告', NOW).due, '2026-09-20');
  assert.strictEqual(parseQuickTodo('12月1日 交报告', NOW).due, '2026-12-01');
  // 非法月日不应被当成日期（保留在正文里）
  assert.strictEqual(parseQuickTodo('13月40日 交报告', NOW).due, '');
});

test('时间：合法与非法', () => {
  assert.strictEqual(parseQuickTodo('15:30 开会', NOW).dueTime, '15:30');
  assert.strictEqual(parseQuickTodo('9:05 开会', NOW).dueTime, '09:05');
  assert.strictEqual(parseQuickTodo('00:00 开会', NOW).dueTime, '00:00');
  assert.strictEqual(parseQuickTodo('23:59 开会', NOW).dueTime, '23:59');
  assert.strictEqual(parseQuickTodo('25:00 开会', NOW).dueTime, '', '25 点不是合法时间');
  assert.strictEqual(parseQuickTodo('12:99 开会', NOW).dueTime, '', '99 分不是合法时间');
});

test('日期 + 时间同时识别，正文被清理干净', () => {
  const r = parseQuickTodo('明天 15:30 和客户开会', NOW);
  assert.strictEqual(r.due, '2026-09-08');
  assert.strictEqual(r.dueTime, '15:30');
  assert.strictEqual(r.text, '和客户开会');
});

test('正文里的多余空白与尾部标点被清理', () => {
  assert.strictEqual(parseQuickTodo('  今天   写周报，。！  ', NOW).text, '写周报');
  assert.strictEqual(parseQuickTodo('今天', NOW).text, '', '只有日期时正文为空（调用方据此提示）');
});

test('纯文本不产生日期时间', () => {
  const r = parseQuickTodo('买牛奶', NOW);
  assert.deepStrictEqual(r, { text: '买牛奶', due: '', dueTime: '' });
});

test('空输入与异常输入不抛异常', () => {
  assert.strictEqual(parseQuickTodo('', NOW).text, '');
  assert.strictEqual(parseQuickTodo(null, NOW).text, '');
  assert.strictEqual(parseQuickTodo(undefined, NOW).text, '');
  assert.strictEqual(parseQuickTodo('   ', NOW).text, '');
  assert.strictEqual(parseQuickTodo(12345, NOW).text, '12345');
});

test('buildQuickTodo 产出与渲染层一致的待办结构', () => {
  const t = buildQuickTodo(parseQuickTodo('明天 15:30 开会', NOW), { date: '2026-09-07', id: 'fixed', now: NOW });
  assert.deepStrictEqual(t, {
    id: 'fixed', text: '开会', level: 'mid', done: false, date: '2026-09-07',
    due: '2026-09-08', dueTime: '15:30', repeat: 'none', note: '',
    subtasks: [], doneHistory: [], remind: 0
  });
});

test('buildQuickTodo 自动生成不重复 id', () => {
  const a = buildQuickTodo({ text: 'a', due: '', dueTime: '' }, { now: NOW });
  const b = buildQuickTodo({ text: 'b', due: '', dueTime: '' }, { now: NOW });
  assert.ok(a.id && b.id && a.id !== b.id);
});
