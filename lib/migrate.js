'use strict';

/* ===========================================================================
   数据迁移与归一化（主进程启动时执行一次，纯逻辑、无 Electron 依赖，可单测）
   ---------------------------------------------------------------------------
   约定：
   - 迁移只做「结构升级 + 字段归一化」，绝不删除未知字段。
     数据文件里可能存在本版本不认识的键（例如历史版本留下的 clipboardSensitive），
     一律原样保留，避免升级时丢用户配置。
   - 只在真的改动了东西时才回报 changed=true，否则每次启动都会重写文件、
     并堆出一份「迁移前备份」。
   =========================================================================== */

const proto = require('../renderer/storeproto.js');

const SCHEMA_VERSION = 2;

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

// 归一化辅助：只在值真的变化时计数
function makeMark() {
  const m = { n: 0 };
  m.set = function (obj, key, value) {
    if (obj[key] !== value) { obj[key] = value; m.n++; }
  };
  m.drop = function (obj, key) {
    if (Object.prototype.hasOwnProperty.call(obj, key)) { delete obj[key]; m.n++; }
  };
  return m;
}

// v1 → v2：
//   1) 顶层 UI 状态（view / _todoLv / _todoFilter / _pomo / _calSel / _calCursor / _exportedAt）移出数据文件
//   2) 下划线私有字段改名为正式字段：_pomoDone→pomoDone、todos[]._remindedToday→remindedOn、
//      settings._dailyRemindDate→dailyRemindOn（保留原值，不丢提醒/统计记录）
function migrateV1toV2(data, steps, mark) {
  for (const k of proto.EPHEMERAL_KEYS) mark.drop(data, k);
  if (Object.prototype.hasOwnProperty.call(data, '_pomoDone')) {
    // 注意：默认结构里已有 pomoDone:{}，不能只看「目标是否为空对象就跳过」，
    // 否则历史番茄统计会被空默认值顶掉。这里做合并，两边都不丢。
    const legacy = isObj(data._pomoDone) ? data._pomoDone : {};
    const current = isObj(data.pomoDone) ? data.pomoDone : {};
    data.pomoDone = Object.assign({}, legacy, current);
    mark.drop(data, '_pomoDone');
  }
  if (Array.isArray(data.todos)) {
    for (const t of data.todos) {
      if (!isObj(t)) continue;
      if (t._remindedToday !== undefined) {
        if (t.remindedOn === undefined) t.remindedOn = t._remindedToday;
        mark.drop(t, '_remindedToday');
      }    }
  }
  if (isObj(data.settings) && data.settings._dailyRemindDate !== undefined) {
    if (data.settings.dailyRemindOn === undefined) data.settings.dailyRemindOn = data.settings._dailyRemindDate;
    mark.drop(data.settings, '_dailyRemindDate');
  }
  steps.push('schema v1 → v' + SCHEMA_VERSION);
}

// 集合字段归一化：补齐缺失字段、清掉结构异常的数据
function normalizeCollections(data, mark) {
  for (const name of proto.COLLECTIONS) {
    if (!Array.isArray(data[name])) { data[name] = []; mark.n++; }
  }
  const ids = new Set();
  data.todos = data.todos.filter(t => {
    if (!isObj(t)) { mark.n++; return false; }
    return true;
  });
  for (const t of data.todos) {
    if (t.id === undefined || t.id === null || ids.has(String(t.id))) {
      t.id = 'fix' + Math.random().toString(36).slice(2, 9) + mark.n;
      mark.n++;
    }
    ids.add(String(t.id));
    if (t.due === undefined || t.due === null) mark.set(t, 'due', '');
    if (t.dueTime === undefined || t.dueTime === null) mark.set(t, 'dueTime', '');
    if (['high', 'mid', 'low'].indexOf(t.level) === -1) mark.set(t, 'level', 'mid');
    if (['none', 'daily', 'weekly', 'monthly', 'yearly'].indexOf(t.repeat) === -1) mark.set(t, 'repeat', 'none');
    if (typeof t.note !== 'string') mark.set(t, 'note', '');
    if (typeof t.text !== 'string') mark.set(t, 'text', '');
    if (!Number.isFinite(Number(t.remind))) mark.set(t, 'remind', 0);
    if (!Array.isArray(t.subtasks)) mark.set(t, 'subtasks', []);
    if (!Array.isArray(t.doneHistory)) mark.set(t, 'doneHistory', []);
    if (t.repeat !== 'none' && !t.due) mark.set(t, 'repeat', 'none');   // 没有到期日的重复任务无意义
    if (t.done !== true) mark.set(t, 'done', false);
  }
  for (const name of ['notes', 'checkins', 'shortcuts', 'groups']) {
    data[name] = data[name].filter(x => isObj(x));
  }
  // 文件分组的 items 必须是数组且只含对象：脏数据会让文件整理页渲染时直接抛异常
  for (const g of data.groups) {
    if (!Array.isArray(g.items)) mark.set(g, 'items', []);
    else {
      const kept = g.items.filter(it => isObj(it));
      if (kept.length !== g.items.length) mark.set(g, 'items', kept);
    }
  }
  for (const s of data.shortcuts) {
    // 图标引用只接受本应用缓存产物（file:// 短引用）；内联 data: 会撑大数据文件
    if (typeof s.icon === 'string' && s.icon.indexOf('data:') === 0) mark.set(s, 'icon', null);
  }
}

function normalizeSettings(data, mark) {
  if (!isObj(data.settings)) { data.settings = {}; mark.n++; }
  const s = data.settings;

  // 时间统计
  if (!isObj(s.timeTrack)) { s.timeTrack = {}; mark.n++; }
  const tt = s.timeTrack;
  if (![120, 300, 600].includes(tt.idleSeconds)) mark.set(tt, 'idleSeconds', 300);
  if (tt.enabled !== true && tt.enabled !== false) mark.set(tt, 'enabled', false);
  if (tt.recordTitles !== true && tt.recordTitles !== false) mark.set(tt, 'recordTitles', false);
  if (!Array.isArray(tt.rules)) mark.set(tt, 'rules', []);
  else {
    const kept = tt.rules.filter(r => isObj(r) && r.value && r.category);
    if (kept.length !== tt.rules.length) mark.set(tt, 'rules', kept);
  }

  // 自动文件整理
  if (!isObj(s.autoOrganize)) { s.autoOrganize = {}; mark.n++; }
  const ao = s.autoOrganize;
  if (ao.enabled !== true && ao.enabled !== false) mark.set(ao, 'enabled', false);
  if (typeof ao.watch !== 'string') mark.set(ao, 'watch', '');
  if (!Array.isArray(ao.rules)) mark.set(ao, 'rules', []);
  else {
    // 规则值必须是字符串：数字/对象会让后面的 ext 匹配行为变得不可预测
    const kept = ao.rules.filter(r => isObj(r) && typeof r.value === 'string' && r.value && typeof r.to === 'string' && r.to);
    if (kept.length !== ao.rules.length) mark.set(ao, 'rules', kept);
  }

  // 桌面小组件
  if (!isObj(s.widgets)) { s.widgets = {}; mark.n++; }
  for (const k of ['clock', 'todos', 'notes']) {
    if (s.widgets[k] !== true && s.widgets[k] !== false) s.widgets[k] = false;
  }

  // 番茄钟配置
  if (s.pomodoro !== undefined && !isObj(s.pomodoro)) { s.pomodoro = { mode: 'focus' }; mark.n++; }
  if (isObj(s.pomodoro)) {
    if (['focus', 'short', 'long', 'custom'].indexOf(s.pomodoro.mode) === -1) mark.set(s.pomodoro, 'mode', 'focus');
    if (s.pomodoro.minutes !== undefined) {
      const m = parseInt(s.pomodoro.minutes, 10);
      if (!(m >= 1 && m <= 180)) mark.drop(s.pomodoro, 'minutes');
      else if (m !== s.pomodoro.minutes) mark.set(s.pomodoro, 'minutes', m);
    }
  }

  if (s.mode !== 'top' && s.mode !== 'normal') mark.set(s, 'mode', 'normal');
  if (s.layout !== 'window' && s.layout !== 'overlay') mark.set(s, 'layout', 'overlay');
  if (['light', 'dark', 'auto'].indexOf(s.theme) === -1) mark.set(s, 'theme', 'light');
  if (typeof s.accent !== 'string' || !/^#[0-9a-f]{6}$/i.test(s.accent)) mark.set(s, 'accent', '#2f2e2b');
  for (const k of ['autostart', 'glass', 'autoBackup', 'clipboardHistory', 'clipboardSensitive', 'dailyRemind', 'autoOverdueAdvance', 'seenGuide']) {
    if (s[k] !== undefined && s[k] !== true && s[k] !== false) mark.set(s, k, !!s[k]);
  }
  if (typeof s.dailyRemindTime !== 'string' || !/^\d{1,2}:\d{2}$/.test(s.dailyRemindTime)) mark.set(s, 'dailyRemindTime', '08:30');
  if (s.updaterUrl !== undefined && typeof s.updaterUrl !== 'string') mark.set(s, 'updaterUrl', '');
  if (isObj(s.winBounds)) {
    const b = s.winBounds;
    const ok = ['x', 'y', 'width', 'height'].every(k => Number.isFinite(Number(b[k])));
    if (!ok) mark.drop(s, 'winBounds');
  }
}

function migrate(data) {
  if (!isObj(data)) return { changed: false, steps: [], from: 1, to: SCHEMA_VERSION };
  const steps = [];
  const mark = makeMark();
  const from = typeof data.version === 'number' ? data.version : 1;

  if (from < SCHEMA_VERSION) migrateV1toV2(data, steps, mark);
  if (data.version !== SCHEMA_VERSION) { data.version = SCHEMA_VERSION; mark.n++; }

  normalizeCollections(data, mark);
  normalizeSettings(data, mark);

  if (!isObj(data.profile)) { data.profile = { name: '我的工作台', greeting: '' }; mark.n++; }
  if (typeof data.profile.name !== 'string' || !data.profile.name) { data.profile.name = '我的工作台'; mark.n++; }

  // 番茄完成记录：只保留可解析的日期键，避免历史脏数据堆积
  if (data.pomoDone !== undefined && !isObj(data.pomoDone)) { data.pomoDone = {}; mark.n++; }
  if (isObj(data.pomoDone)) {
    const out = {};
    for (const k of Object.keys(data.pomoDone)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && Number.isFinite(Number(data.pomoDone[k]))) out[k] = Number(data.pomoDone[k]);
    }
    if (Object.keys(out).length !== Object.keys(data.pomoDone).length) { data.pomoDone = out; mark.n++; }
  }

  if (mark.n > 0) steps.push('归一化改动 ' + mark.n + ' 处');
  return { changed: mark.n > 0, steps: steps, from: from, to: SCHEMA_VERSION, changes: mark.n };
}

module.exports = { migrate, SCHEMA_VERSION };
