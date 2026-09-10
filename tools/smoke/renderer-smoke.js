'use strict';

/* ===========================================================================
   渲染层集成冒烟测试（真实 Electron + 真实页面 + 真实数据仓库）
   ---------------------------------------------------------------------------
   用真实 main 进程的数据层（lib/store.js）和真实渲染页面（renderer/index.html、
   app.js、shared/storeproto.js）跑一遍，验证：
     1. 页面能启动（含 CSP 是否放行子目录脚本 shared/storeproto.js）
     2. 渲染层的改动确实通过补丁协议落到磁盘
     3. 主进程并发写入不会被渲染层的提交覆盖（本次修复的核心回归）
     4. 界面状态不会写进数据文件
   窗口全程隐藏，使用独立的临时 userData，不影响用户正在运行的实例。

   运行： npm run test:smoke
   =========================================================================== */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', '..');
const { createStore } = require(path.join(ROOT, 'lib', 'store.js'));
const { migrate } = require(path.join(ROOT, 'lib', 'migrate.js'));
const { defaultData } = require(path.join(ROOT, 'lib', 'defaults.js'));

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-smoke-'));
app.setPath('userData', tmpDir);
const storeFile = path.join(tmpDir, 'workbench-data.json');

const store = createStore({
  filePath: storeFile,
  backupDir: path.join(tmpDir, 'backups'),
  defaults: defaultData,
  migrate: migrate,
  debounceMs: 20
});
store.load();

let passed = 0;
const failures = [];
function check(name, ok, extra) {
  if (ok) { passed++; console.log('  \u2714 ' + name); }
  else { failures.push(name + (extra ? ' → ' + extra : '')); console.log('  \u2716 ' + name + (extra ? '  → ' + extra : '')); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function readDisk() {
  store.flush();
  return JSON.parse(fs.readFileSync(storeFile, 'utf8'));
}

function registerIpc() {
  ipcMain.handle('store:load', () => ({ rev: store.getRev(), data: store.read() }));
  ipcMain.handle('store:commit', (event, payload) => store.commit(payload && payload.patch));
  ipcMain.handle('app:info', () => ({ version: '1.8.2-smoke', platform: process.platform, userData: tmpDir, hotkey: 'Win+Alt+Space' }));
  ipcMain.handle('data:listBackups', () => store.listBackups());
  ipcMain.handle('usage:getSummary', () => ({
    supported: true, enabled: false, dayCount: 0,
    today: { total: 0, categories: [], topApps: [] },
    daily: [], topApps: [], categories: [], topTitles: [], pomodoros: { today: 0, week: 0 }
  }));
  // 其余通道给一个不会抛异常的空实现（本测试不校验 OS 集成）
  const benign = {
    'fs:resolveItem': null, 'fs:getIcon': null, 'fs:open': '', 'fs:reveal': '',
    'dialog:pickFiles': [], 'dialog:pickFolder': null, 'dialog:pickApp': null,
    'clip:list': [], 'clip:copy': { ok: true }, 'clip:pin': { ok: true }, 'clip:delete': { ok: true },
    'clip:clearUnpinned': { ok: true }, 'clip:ocr': { ok: false }, 'clip:toggle': true,
    'auto:pickWatch': null, 'auto:pickTarget': null, 'auto:run': { moved: [], errors: [] },
    'notify:show': true, 'win:mode': 'normal', 'win:autostart': false, 'win:layout': 'overlay',
    'win:glass': true, 'win:theme': null, 'win:minimize': null, 'win:maximizeToggle': false,
    'win:hide': null, 'win:quit': null, 'qa:close': null, 'todo:quickAdd': { ok: true, msg: '' },
    'data:backupNow': null, 'data:openBackupDir': null, 'data:export': { ok: false, path: null },
    'data:import': { ok: false, canceled: true, content: null }, 'usage:clear': { ok: true },
    'app:checkUpdate': { ok: false, hasUpdate: false, reason: 'no-src' }, 'app:openExternal': null,
    'shot:start': true, 'shot:ready': true, 'shot:submitCrop': { ok: false }, 'shot:cancel': true,
    'shot:copy': true, 'shot:close': true, 'widgets:close': true, 'widgets:openMain': true
  };
  for (const ch of Object.keys(benign)) ipcMain.handle(ch, () => benign[ch]);
}

async function main() {
  registerIpc();
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      spellcheck: false, devTools: false
    }
  });

  const consoleErrors = [];
  win.webContents.on('console-message', (_e, level, message) => {
    // level 3 = error
    if (level >= 2) consoleErrors.push(message);
  });

  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await sleep(600);   // 等 boot() 里的异步装载完成

  const js = (code) => win.webContents.executeJavaScript(code, true);

  // ---- 1. 页面与脚本装载 ----
  check('CSP 放行子目录脚本 shared/storeproto.js', await js('!!(window.WB && window.WB.proto && window.WB.proto.diffPatch)'));
  check('侧栏 11 个导航项已渲染（boot 完成）', (await js('document.querySelectorAll("#nav .navi").length')) === 11,
    '实际 ' + (await js('document.querySelectorAll("#nav .navi").length')));
  check('首页仪表盘已渲染', (await js('!!document.querySelector(".greet") && !!document.querySelector(".stats")')));
  check('版本号已从主进程取回', (await js('(document.getElementById("ver")||{}).textContent || ""')).includes('1.8.2-smoke'));
  check('渲染层没有 error 级控制台输出', consoleErrors.length === 0, consoleErrors.join(' | '));

  // ---- 2. 界面状态不落盘 ----
  let disk = readDisk();
  check('初始数据文件已建立且 schema 版本为 2', disk.version === 2, 'version=' + disk.version);
  for (const k of ['view', '_todoLv', '_todoFilter', '_pomo']) {
    check('数据文件不含界面状态 ' + k, !Object.prototype.hasOwnProperty.call(disk, k));
  }

  // ---- 3. 通过真实 UI 路径添加待办 → 落盘 ----
  await js('document.querySelector(\'[data-nav="todos"]\').click()');
  await sleep(150);
  check('切到待办页成功', await js('!!document.getElementById("todoInput")'));
  await js(`(() => {
    const i = document.getElementById('todoInput');
    i.value = '冒烟测试待办';
    document.querySelector('[data-act="add-todo"]').click();
  })()`);
  await sleep(300);
  disk = readDisk();
  check('UI 添加的待办已写入数据文件', disk.todos.some(t => t.text === '冒烟测试待办'),
    JSON.stringify(disk.todos.map(t => t.text)));
  check('渲染层视图状态未被持久化（此时数据文件仍无 view 键）', !Object.prototype.hasOwnProperty.call(disk, 'view'));

  // ---- 4. 核心回归：主进程并发写入 + 渲染层提交 ----
  store.mutate(d => {
    d.todos.unshift({ id: 'quickAdd1', text: '主进程快速添加', level: 'mid', done: false, date: '2026-01-01', due: '', dueTime: '', repeat: 'none', note: '', subtasks: [], doneHistory: [] });
  });
  await sleep(200);                      // 渲染层收到 data:changed 后回灌
  // 渲染层再做一次改动（勾选完成一个待办）
  await js(`(() => {
    const box = document.querySelector('[data-act="toggle-todo"]');
    if (box) box.click();
  })()`);
  await sleep(300);
  disk = readDisk();
  const texts = disk.todos.map(t => t.text);
  check('主进程并发新增的待办未被渲染层覆盖', texts.includes('主进程快速添加'), texts.join(' | '));
  check('渲染层的改动同时生效（勾选完成）', disk.todos.filter(t => t.done).length >= 1,
    JSON.stringify(disk.todos.map(t => ({ t: t.text, done: t.done }))));
  check('主进程新增的待办仍排在首位', texts[0] === '主进程快速添加', texts.join(' | '));

  // ---- 5. 设置改动落盘且保留未知键 ----
  store.mutate(d => { d.settings.clipboardSensitive = true; });   // 模拟历史遗留键
  await js('document.querySelector(\'[data-nav="settings"]\').click()');
  await sleep(200);
  await js(`(() => { const o = document.querySelector('[data-act="set-theme"][data-theme="dark"]'); if (o) o.click(); })()`);
  await sleep(300);
  disk = readDisk();
  check('设置改动已落盘（主题切深色）', disk.settings.theme === 'dark', 'theme=' + disk.settings.theme);
  check('未知设置键被保留', disk.settings.clipboardSensitive === true);

  // ---- 6. 隐藏的 write 合并：文件始终是合法 JSON ----
  check('数据文件始终是合法 JSON', (() => { try { JSON.parse(fs.readFileSync(storeFile, 'utf8')); return true; } catch (e) { return false; } })());
  check('没有遗留 .tmp 临时文件', !fs.existsSync(storeFile + '.tmp'));

  console.log('\n通过 ' + passed + ' 项' + (failures.length ? '，失败 ' + failures.length + ' 项' : '，全部通过'));
  if (failures.length) { console.log('失败项：\n - ' + failures.join('\n - ')); }
  console.log('临时数据目录：' + tmpDir);
  return failures.length === 0 ? 0 : 1;
}

app.whenReady().then(async () => {
  let code = 1;
  try {
    code = await main();
  } catch (e) {
    console.error('冒烟测试异常：', e);
    code = 1;
  }
  try { store.flush(); } catch (e) { /* ignore */ }
  app.exit(code);
});
