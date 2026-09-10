'use strict';
/* 用真实用户数据跑一遍主进程的数据装载链路：createStore → load → migrate → 字段类型检查
   目的：确认「1.8.2 启动后界面空白」是否由数据装载阶段抛异常导致
   用法：node tools/diagnose/replay-real-data.js  [数据文件路径] */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../../lib/store.js');
const { migrate } = require('../../lib/migrate.js');
const { defaultData } = require('../../lib/defaults.js');
const proto = require('../../renderer/storeproto.js');

const real = process.argv[2] || path.join(process.env.APPDATA || '', '桌面工作台', 'workbench-data.json');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-realdata-'));
const copy = path.join(tmp, 'workbench-data.json');

if (!fs.existsSync(real)) { console.log('未找到数据文件：' + real); process.exit(0); }
fs.copyFileSync(real, copy);
console.log('数据文件：' + real);
console.log('大小：' + fs.statSync(copy).size + ' 字节');

let failed = false;
function step(name, fn) {
  try {
    const r = fn();
    console.log('  OK   ' + name + (r === undefined ? '' : '  -> ' + r));
    return r;
  } catch (e) {
    failed = true;
    const detail = e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n      ') : String(e);
    console.log('  FAIL ' + name + ' 抛异常：\n      ' + detail);
    return null;
  }
}

console.log('\n=== 1) migrate() 作用在真实数据上 ===');
const raw = JSON.parse(fs.readFileSync(copy, 'utf8'));
step('migrate()', () => {
  const r = migrate(raw);
  return 'changed=' + r.changed + ' steps=' + JSON.stringify(r.steps);
});

console.log('\n=== 2) createStore().read()（buildInitial + migrate + 落盘）===');
const store = createStore({
  filePath: copy,
  backupDir: path.join(tmp, 'backups'),
  defaults: defaultData,
  migrate: migrate,
  log: (m) => console.log('      [store] ' + m)
});
const data = step('store.read()', () => store.read());
step('store.diagnostics()', () => JSON.stringify(store.diagnostics()));

console.log('\n=== 3) 渲染层会遍历的字段类型（类型错会让视图函数直接抛异常）===');
if (data) {
  const need = {
    todos: 'array', notes: 'array', checkins: 'array', shortcuts: 'array', groups: 'array',
    profile: 'object', settings: 'object', pomoDone: 'object'
  };
  for (const k of Object.keys(need)) {
    const v = data[k];
    const ok = need[k] === 'array' ? Array.isArray(v) : (!!v && typeof v === 'object' && !Array.isArray(v));
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' ' + k + ' = ' + (ok ? need[k] : typeof v + ' ' + JSON.stringify(v).slice(0, 60)));
    if (!ok) failed = true;
  }
  console.log('  计数：todos=' + (data.todos || []).length + ' notes=' + (data.notes || []).length +
    ' checkins=' + (data.checkins || []).length + ' shortcuts=' + (data.shortcuts || []).length +
    ' groups=' + (data.groups || []).length);
  for (const g of (data.groups || [])) {
    if (!Array.isArray(g.items)) { console.log('  FAIL 分组「' + g.name + '」的 items 不是数组'); failed = true; }
  }
  for (const t of (data.todos || [])) {
    if (!Array.isArray(t.subtasks) || !Array.isArray(t.doneHistory)) { console.log('  FAIL 待办字段异常：' + t.text); failed = true; }
  }
  const s = data.settings || {};
  for (const k of ['autoOrganize', 'timeTrack', 'widgets']) {
    const v = s[k];
    const ok = !!v && typeof v === 'object' && !Array.isArray(v);
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + ' settings.' + k + ' = ' + (ok ? 'object' : JSON.stringify(v)));
    if (!ok) failed = true;
  }

  console.log('\n=== 4) 渲染层提交补丁往返（boot 里 await save(true) 会走这条路径）===');
  step('diffPatch(snapshot, stripEphemeral(state))', () => {
    const snap = proto.snapshot(data);
    const patch = proto.diffPatch(snap, proto.stripEphemeral(data));
    if (patch === null) return '无差异（boot 时不写盘）';
    return '有差异：collections=' + JSON.stringify(Object.keys(patch.collections || {})) +
      ' settings=' + JSON.stringify(Object.keys(patch.settings || {})) +
      ' top=' + JSON.stringify(Object.keys(patch.top || {}));
  });

  console.log('\n=== 5) 界面状态字段应从数据文件中移除（迁移后）===');
  for (const k of proto.EPHEMERAL_KEYS) {
    const has = Object.prototype.hasOwnProperty.call(data, k);
    console.log('  ' + (has ? 'FAIL 仍存在' : 'OK   已移除') + ' ' + k);
    if (has) failed = true;
  }
}

console.log('\n' + (failed ? '结论：发现异常（FAIL）' : '结论：数据装载链路无异常（OK）'));
console.log('临时副本：' + copy);
