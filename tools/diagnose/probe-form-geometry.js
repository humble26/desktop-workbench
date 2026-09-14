'use strict';

/* ===========================================================================
   表单控件几何探针（真实 Electron）
   ---------------------------------------------------------------------------
   用途：v1.9.0 把 `input[type=number] / input[type=password] / select` 加进了
   全局输入样式选择器（它们此前完全没有边框与内边距）。这类「全局选择器」最容易
   造成**交叉回归** —— 老页面里那些本来就靠 inline 样式或别的类摆位的控件，
   可能因为多了一条 width:100% / padding 而变形。

   推理再多也不如量一遍：这个脚本把关键控件的实际几何与计算样式打印出来，
   改动前后各跑一次，diff 一下就知道有没有踩到别人。

   运行（需要桌面会话）：
     node_modules\electron\dist\electron.exe tools\diagnose\probe-form-geometry.js
   结果同时写入 probe-form-geometry.json（GUI 程序的标准输出在部分环境拿不到）。
   =========================================================================== */

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const { createStore } = require(path.join(ROOT, 'lib', 'store.js'));
const { migrate } = require(path.join(ROOT, 'lib', 'migrate.js'));
const { defaultData } = require(path.join(ROOT, 'lib', 'defaults.js'));

const os = require('os');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-geom-'));
app.setPath('userData', tmpDir);

const store = createStore({
  filePath: path.join(tmpDir, 'workbench-data.json'),
  backupDir: path.join(tmpDir, 'backups'),
  defaults: defaultData, migrate: migrate, debounceMs: 5
});
store.load();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function registerIpc() {
  const benign = {
    'store:load': () => ({ rev: store.getRev(), data: store.read() }),
    'store:commit': (_e, p) => store.commit(p && p.patch),
    'app:info': () => ({ version: 'geom-probe', platform: process.platform, userData: tmpDir, hotkey: 'Win+Alt+Space' }),
    'app:diagnostics': () => ({
      version: 'geom-probe', platform: process.platform, userData: tmpDir,
      powershell: { checked: true, available: true, features: {} }, store: store.diagnostics(),
      usage: { enabled: false, sampling: false, paused: false }, clipboard: { historyEnabled: true, items: 0 },
      hotkeys: [], icons: { files: 0, bytes: 0 }
    }),
    'data:listBackups': () => [],
    'usage:getSummary': () => ({
      supported: true, enabled: false, dayCount: 0, today: { total: 0, categories: [], topApps: [] },
      daily: [], topApps: [], categories: [], topTitles: [], pomodoros: { today: 0, week: 0 }
    }),
    'ai:list': () => ({
      supported: true, enabled: true, intervalMinutes: 30, lowBalance: 0,
      keyStorage: 'geom', keyStorageAvailable: true, refreshing: false, lastRefreshAt: Date.now(), lastRefreshError: null,
      providers: [
        {
          id: 'deepseek', name: 'DeepSeek', custom: false, currency: 'CNY', enabled: true,
          hasKey: true, masked: 'sk-****geom', keyReadable: true, keyAt: Date.now(), ok: true, at: Date.now(),
          balance: 100, granted: 0, toppedUp: 100, limit: null, used: null, available: true, note: '', error: '', price: 4,
          spend: { today: 1, yesterday: 1, last7: 7, last14: 14, avgPerDay: 1, observedDays: 7, daysLeft: 100, tracked: 14, price: 4, tokensToday: 250000, tokensLast7: 1750000, tokensTracked: 3500000 },
          consoleUrl: 'https://platform.deepseek.com/usage', keyUrl: 'https://platform.deepseek.com/api_keys',
          keyHint: 'sk-…', priceNote: 'geom', url: '', balancePath: '', grantedPath: '', usedPath: ''
        },
        {
          id: 'custom', name: '自定义平台', custom: true, currency: 'CNY', enabled: true,
          hasKey: true, masked: 'sk-****cust', keyReadable: true, keyAt: Date.now(), ok: false, at: 0,
          balance: null, granted: null, toppedUp: null, limit: null, used: null, available: null, note: '', error: '测试错误', price: 0,
          spend: { today: 0, yesterday: 0, last7: 0, last14: 0, avgPerDay: 0, observedDays: 7, daysLeft: null, tracked: 0, price: 0, tokensToday: null, tokensLast7: null, tokensTracked: null },
          consoleUrl: '', keyUrl: '', keyHint: '', priceNote: '', url: 'https://gw.example.com/api', balancePath: 'data.balance', grantedPath: '', usedPath: ''
        }
      ]
    }),
    'ai:history': () => ({ provider: 'deepseek', currency: 'CNY', price: 4, days: [{ date: '2026-09-13', amount: 1 }] }),
    'ai:refresh': () => ({ ok: true, refreshed: 1 }),
    'ai:setKey': () => ({ ok: true }), 'ai:clearKey': () => ({ ok: true }),
    'ai:clearHistory': () => ({ ok: true }), 'ai:clearProvider': () => ({ ok: true })
  };
  for (const ch of Object.keys(benign)) ipcMain.handle(ch, benign[ch]);
}

// 取出某个元素的实际几何 + 关键计算样式
const MEASURE = `(sel) => {
  const el = document.querySelector(sel);
  if (!el) return { missing: true };
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  const p = el.parentElement;
  const pr = p ? p.getBoundingClientRect() : null;
  const ps = p ? getComputedStyle(p) : null;
  return {
    w: Math.round(r.width * 100) / 100,
    h: Math.round(r.height * 100) / 100,
    x: Math.round(r.x),
    y: Math.round(r.y),
    tag: el.tagName.toLowerCase(),
    type: el.type || null,
    width: s.width, height: s.height, padding: s.padding, borderWidth: s.borderWidth,
    fontSize: s.fontSize, boxSizing: s.boxSizing, flex: s.flexBasis,
    parentClass: p ? (p.className || p.tagName) : null,
    parentDisplay: ps ? ps.display : null,
    parentW: pr ? Math.round(pr.width * 100) / 100 : null,
    // 是否溢出父容器
    overflowParent: pr ? (r.right > pr.right + 0.5 || r.left < pr.left - 0.5) : null
  };
}`;

// 遍历当前 DOM 里的所有表单控件，给每个一条可对比的「签名」。
// 用具名选择器只能证明「我想到的那几个没问题」，扫一遍才能证明「没有漏网的」。
const SWEEP = `() => {
  const out = [];
  document.querySelectorAll('#view select, #view input, #view textarea, #modalRoot select, #modalRoot input, #modalRoot textarea').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;              // 未渲染的跳过
    const s = getComputedStyle(el);
    const p = el.parentElement;
    const pr = p ? p.getBoundingClientRect() : null;
    out.push({
      key: (el.id ? '#' + el.id : el.tagName.toLowerCase() + '.' + (el.className || '?')) + '[' + (el.type || '') + ']',
      w: Math.round(r.width * 100) / 100,
      h: Math.round(r.height * 100) / 100,
      padding: s.padding,
      borderWidth: s.borderWidth,
      fontSize: s.fontSize,
      overflow: pr ? (r.right > pr.right + 0.5 || r.left < pr.left - 0.5 || r.bottom > pr.bottom + 0.5) : null,
      clipped: el.scrollHeight > el.clientHeight + 1
    });
  });
  return out;
}`;

async function main() {
  registerIpc();
  const win = new BrowserWindow({
    width: 1280, height: 860, show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, devTools: false
    }
  });
  await win.loadFile(path.join(ROOT, 'renderer', 'index.html'));
  await sleep(600);
  const js = (code) => win.webContents.executeJavaScript(code, true);
  const measure = async (sel) => js(`(${MEASURE})(${JSON.stringify(sel)})`);

  const report = { electron: process.versions.electron, chrome: process.versions.chrome, views: {}, sweep: {} };

  // ---- 全视图扫描：每个视图渲染后把该页所有表单控件量一遍 ----
  const VIEWS = ['dashboard', 'shortcuts', 'files', 'todos', 'calendar', 'notes',
    'checkins', 'pomodoro', 'stats', 'usage', 'ai', 'settings'];
  for (const v of VIEWS) {
    await js(`(async function () { state.view = ${JSON.stringify(v)}; await render(); })()`);
    await sleep(260);
    report.sweep[v] = await js(`(${SWEEP})()`);
  }
  // 弹窗里的控件（时间统计规则、日历某天编辑）
  await js(`(async function () { state.view = 'settings'; await render(); })()`);
  await sleep(260);
  await js(`(() => { const b = document.querySelector('[data-act="add-tt-rule"]'); if (b) b.click(); })()`);
  await sleep(320);
  report.sweep['dialog:ttRule'] = await js(`(${SWEEP})()`);
  await js('closeModal()');
  await sleep(120);

  // ---- 关键控件的详细几何（含父容器信息）----
  await js(`(async function () { state.view = 'todos'; await render(); })()`);
  await sleep(260);
  report.views.todos = {
    '#todoRepeat': await measure('#todoRepeat'),
    '#todoInput': await measure('#todoInput'),
    '#todoDue': await measure('#todoDue'),
    '.todo-add': await measure('.todo-add')
  };

  await js(`(async function () { state.view = 'pomodoro'; await render(); })()`);
  await sleep(260);
  await js(`(() => { const o = Array.from(document.querySelectorAll('[data-act="pomo-set"]')).find(x => x.textContent.indexOf('自定义') !== -1); if (o) o.click(); })()`);
  await sleep(260);
  report.views.pomodoro = { '#pomoCustom': await measure('#pomoCustom') };

  // 设置页：AI 区块要处于「已开启」才会渲染出间隔/阈值两项 ——
  // 这里直接改渲染层的设置对象（真实运行里它来自主进程的同一份数据）
  await js(`(async function () {
    state.settings.aiMonitor = state.settings.aiMonitor || { providers: {} };
    state.settings.aiMonitor.enabled = true;
    state.view = 'settings';
    await render();
  })()`);
  await sleep(320);
  report.views.settings = {
    '#aiLow': await measure('#aiLow'),
    '#aiKey-deepseek': await measure('#aiKey-deepseek'),
    '#aiPrice-deepseek': await measure('#aiPrice-deepseek'),
    '#aiCustomCurrency': await measure('#aiCustomCurrency'),
    '#aiCustomUrl': await measure('#aiCustomUrl'),
    '#aiKey-custom': await measure('#aiKey-custom'),
    '.ai-keyrow(first)': await measure('.ai-keyrow')
  };

  await js('(async function () { state.view = "ai"; await render(); })()');
  await sleep(320);
  report.views.ai = {
    '.ai-card': await measure('.ai-card'),
    '.ai-left': await measure('.ai-left'),
    '.ai-right': await measure('.ai-right'),
    '.u-cols': await measure('.u-cols')
  };

  const out = path.join(ROOT, 'probe-form-geometry.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));
  console.log('已写入：' + out);
  return 0;
}

app.whenReady().then(async () => {
  let code = 1;
  try { code = await main(); } catch (e) { console.error('探针异常：', e); }
  app.exit(code);
});
