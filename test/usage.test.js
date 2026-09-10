'use strict';

/* 时间统计领域逻辑单测：设置归一化、分类规则、时长累计与汇总 */

const test = require('node:test');
const assert = require('node:assert');
const u = require('../lib/usage.js');
const { TIME_TRACK_DEFAULTS } = require('../lib/defaults.js');

test('设置归一化：缺省与非法值回退默认，规则过滤脏数据', () => {
  const d = u.normalizeTrackSettings(undefined, TIME_TRACK_DEFAULTS);
  assert.strictEqual(d.enabled, false);
  assert.strictEqual(d.idleSeconds, 300);
  assert.strictEqual(d.recordTitles, false);
  assert.deepStrictEqual(d.rules, TIME_TRACK_DEFAULTS.rules);

  const bad = u.normalizeTrackSettings({ enabled: 'yes', idleSeconds: 999, recordTitles: 1, rules: [{ value: 'x' }, { value: 'code', category: '开发' }] }, TIME_TRACK_DEFAULTS);
  assert.strictEqual(bad.enabled, false, '非布尔值不算开启');
  assert.strictEqual(bad.idleSeconds, 300, '非法空闲阈值回退默认');
  assert.strictEqual(bad.recordTitles, false);
  assert.deepStrictEqual(bad.rules, [{ value: 'code', category: '开发' }]);

  const ok = u.normalizeTrackSettings({ enabled: true, idleSeconds: 120, recordTitles: true, rules: [] }, TIME_TRACK_DEFAULTS);
  assert.strictEqual(ok.enabled, true);
  assert.strictEqual(ok.idleSeconds, 120);
  assert.strictEqual(ok.recordTitles, true);
  assert.deepStrictEqual(ok.rules, [], '显式空规则应保留（用户清空过）');
});

test('分类：规则顺序优先、进程名不分大小写、标题规则匹配友好名', () => {
  const rules = [
    { match: 'exe', value: 'code', category: '开发' },
    { match: 'title', value: 'github', category: '开发' },
    { match: 'exe', value: 'chrome', category: '浏览' }
  ];
  assert.strictEqual(u.categoryOf('Code', 'Visual Studio Code', rules), '开发');
  assert.strictEqual(u.categoryOf('chrome', 'GitHub - Chrome', rules), '开发', '标题规则先于后面的进程规则命中');
  assert.strictEqual(u.categoryOf('chrome', '某个网页', rules), '浏览');
  assert.strictEqual(u.categoryOf('notepad', '无标题', rules), '其他', '未命中归其他');
  assert.strictEqual(u.categoryOf('桌面工作台', '桌面工作台', rules), '桌面工作台', '本应用自身单独归类');
  assert.strictEqual(u.categoryOf('x', 'y', null), '其他', '规则缺失不抛异常');
  assert.strictEqual(u.categoryOf('x', 'y', [{ match: 'exe', value: '  ' }]), '其他', '空规则值被跳过');
});

test('时长累计：按进程名归并、保留友好名、可选用标题', () => {
  const data = { days: {} };
  u.addSeconds(data, '2026-09-07', { exe: 'Code', app: 'Visual Studio Code', title: 'app.js' }, 5, false);
  u.addSeconds(data, '2026-09-07', { exe: 'code', app: 'Visual Studio Code', title: 'store.js' }, 7, false);
  const day = data.days['2026-09-07'];
  assert.deepStrictEqual(Object.keys(day.apps), ['code'], '不同大小写应归并到同一条');
  assert.strictEqual(day.apps.code.seconds, 12);
  assert.strictEqual(day.apps.code.name, 'Visual Studio Code');
  assert.deepStrictEqual(day.titles, {}, '未开启标题记录时不落盘');

  u.addSeconds(data, '2026-09-07', { exe: 'code', app: 'Visual Studio Code', title: 'app.js' }, 3, true);
  assert.strictEqual(day.titles['Visual Studio Code|app.js'], 3);

  assert.strictEqual(u.addSeconds(data, '2026-09-07', { exe: '' }, 5, false), false, '无进程名不计数');
  assert.strictEqual(u.addSeconds(data, '2026-09-07', { exe: 'x' }, 0, false), false, '非正时长不计数');
  assert.strictEqual(u.addSeconds(data, '2026-09-07', null, 5, false), false);
});

test('长尾合并：单日应用键过多时最短的并入 __other__', () => {
  const data = { days: {} };
  const day = u.ensureDay(data, '2026-09-07');
  for (let i = 0; i < u.MAX_APPS_PER_DAY + 50; i++) {
    day.apps['app' + i] = { name: 'app' + i, seconds: i + 1 };
  }
  u.addSeconds(data, '2026-09-07', { exe: 'newapp', app: 'newapp' }, 10, false);
  const keys = Object.keys(day.apps);
  assert.ok(keys.length <= u.MAX_APPS_PER_DAY + 1, '应用键数应被限制，实际 ' + keys.length);
  assert.ok(day.apps.__other__, '应生成 __other__ 汇总桶');
  assert.ok(day.apps.__other__.seconds > 0);
  assert.strictEqual(day.apps.__other__.name, '其他');
});

test('汇总：今日合计、分类占比、应用与标题 Top10、番茄标注', () => {
  const data = {
    days: {
      '2026-09-06': { apps: { code: { name: 'VS Code', seconds: 3600 } }, titles: {} },
      '2026-09-07': {
        apps: {
          code: { name: 'VS Code', seconds: 1800 },
          chrome: { name: 'Chrome', seconds: 900 },
          notepad: { name: 'Notepad', seconds: 60 }
        },
        titles: { 'Chrome|GitHub': 900 }
      }
    }
  };
  const rules = [{ match: 'exe', value: 'code', category: '开发' }, { match: 'exe', value: 'chrome', category: '浏览' }];
  const out = u.summarize(data, {
    dayKeys: ['2026-09-06', '2026-09-07'],
    today: '2026-09-07',
    enabled: true,
    recordTitles: true,
    pomoDone: { '2026-09-07': 3, '2026-09-06': 2 },
    categoryOf: (k, n) => u.categoryOf(k, n, rules)
  });

  assert.strictEqual(out.supported, true);
  assert.strictEqual(out.enabled, true);
  assert.strictEqual(out.dayCount, 2);
  assert.deepStrictEqual(out.daily, [{ date: '2026-09-06', total: 3600 }, { date: '2026-09-07', total: 2760 }]);
  assert.strictEqual(out.today.total, 2760);
  assert.deepStrictEqual(out.today.categories, [{ name: '开发', seconds: 1800 }, { name: '浏览', seconds: 900 }, { name: '其他', seconds: 60 }]);
  assert.deepStrictEqual(out.today.topApps.map(a => a.key), ['code', 'chrome', 'notepad']);
  assert.deepStrictEqual(out.topApps.map(a => a.name), ['VS Code', 'Chrome', 'Notepad']);
  assert.deepStrictEqual(out.categories, [{ name: '开发', seconds: 5400 }, { name: '浏览', seconds: 900 }, { name: '其他', seconds: 60 }]);
  assert.deepStrictEqual(out.topTitles, [{ app: 'Chrome', title: 'GitHub', seconds: 900 }]);
  assert.deepStrictEqual(out.pomodoros, { today: 3, week: 5 });
});

test('汇总：未开启标题记录时不返回标题排行；空数据不抛异常', () => {
  const out = u.summarize({ days: {} }, {
    dayKeys: ['2026-09-07'], today: '2026-09-07', recordTitles: false, pomoDone: {},
    categoryOf: () => '其他'
  });
  assert.deepStrictEqual(out.topTitles, []);
  assert.strictEqual(out.dayCount, 0);
  assert.strictEqual(out.today.total, 0);
  assert.deepStrictEqual(out.pomodoros, { today: 0, week: 0 });
  // 聚合结果不得修改原始数据
  const data = { days: { '2026-09-07': { apps: { a: { name: 'A', seconds: 5 } }, titles: {} } } };
  const before = JSON.stringify(data);
  u.summarize(data, { dayKeys: ['2026-09-07'], today: '2026-09-07', categoryOf: () => '其他' });
  assert.strictEqual(JSON.stringify(data), before);
});

test('emptySummary 形状与渲染层约定一致', () => {
  const s = u.emptySummary(true);
  assert.deepStrictEqual(Object.keys(s).sort(), ['categories', 'daily', 'dayCount', 'enabled', 'pomodoros', 'supported', 'today', 'topApps', 'topTitles']);
  assert.deepStrictEqual(s.today, { total: 0, categories: [], topApps: [] });
  assert.strictEqual(u.emptySummary(false).supported, false);
});

test('采样脚本包含前台窗口 API 与 5 秒间隔（防止被误改）', () => {
  assert.ok(u.USAGE_PS_SCRIPT.indexOf('GetForegroundWindow') !== -1);
  assert.ok(u.USAGE_PS_SCRIPT.indexOf('GetWindowThreadProcessId') !== -1);
  assert.ok(u.USAGE_PS_SCRIPT.indexOf('Start-Sleep -Seconds 5') !== -1);
  assert.ok(u.USAGE_PS_SCRIPT.indexOf('ConvertTo-Json -Compress') !== -1);
});
