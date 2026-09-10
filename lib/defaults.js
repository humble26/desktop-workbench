'use strict';

/* ===========================================================================
   默认数据结构（主进程与测试共用；仅注入 lib/store.js，不依赖 electron）
   =========================================================================== */

// 时间统计的默认分类规则（可在设置里增删改）
const TIME_TRACK_RULES = [
  { match: 'exe', value: 'chrome', category: '浏览' },
  { match: 'exe', value: 'msedge', category: '浏览' },
  { match: 'exe', value: 'firefox', category: '浏览' },
  { match: 'exe', value: 'code', category: '开发' },
  { match: 'exe', value: 'devenv', category: '开发' },
  { match: 'exe', value: 'wechat', category: '沟通' },
  { match: 'exe', value: 'weixin', category: '沟通' },
  { match: 'exe', value: 'qq', category: '沟通' },
  { match: 'exe', value: 'dingtalk', category: '沟通' },
  { match: 'exe', value: 'wemeet', category: '沟通' }
];

const TIME_TRACK_DEFAULTS = { enabled: false, idleSeconds: 300, recordTitles: false, rules: TIME_TRACK_RULES };

// 全新数据文件的结构（version 与 lib/migrate.js 的 SCHEMA_VERSION 对应）
// 注意：这里的默认值必须已经「归一化完毕」——即 migrate(defaultData()).changed === false，
// 否则首次启动会被当成一次结构升级（写盘 + 生成迁移前备份 + 误导性日志）。
// 有 test/migrate.test.js 的用例守着这一点。
function defaultData() {
  return {
    version: 2,
    profile: { name: '我的工作台', greeting: '' },
    todos: [],
    notes: [],
    checkins: [],
    shortcuts: [],
    groups: [],
    pomoDone: {},
    settings: {
      mode: 'normal',
      autostart: false,
      accent: '#2f2e2b',
      layout: 'overlay',
      theme: 'light',
      glass: false,
      seenGuide: false,
      autoOverdueAdvance: false,
      autoBackup: true,
      clipboardHistory: true,
      clipboardSensitive: true,                        // 敏感内容（JWT/私钥/口令/API Key）默认不写入历史
      updaterUrl: '',
      dailyRemind: false,
      dailyRemindTime: '08:30',
      autoOrganize: { enabled: false, watch: '', rules: [] },
      widgets: { clock: false, todos: false, notes: false },
      pomodoro: { mode: 'focus' },
      timeTrack: JSON.parse(JSON.stringify(TIME_TRACK_DEFAULTS))   // 深拷贝，避免调用方污染共享规则
    }
  };
}

module.exports = { defaultData, TIME_TRACK_RULES, TIME_TRACK_DEFAULTS };
