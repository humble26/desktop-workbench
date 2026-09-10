'use strict';
/* 无浏览器地执行渲染层：把 index.html 里声明的脚本按顺序 runInContext，
   忠实复现「多个 <script> 共享同一页面全局作用域」的语义（这正是拆分所改变的东西）。
   用宽松的 DOM 代理替身，让代码能跑到渲染逻辑而不需要真实 DOM。

   目的：在无法启动 Chromium 的环境里定位「页面空白」这类启动期错误。
   用法：node tools/diagnose/run-renderer-headless.js */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'renderer');

/* ---------------- 宽松 DOM 替身 ---------------- */
const record = { listeners: 0, errors: [], logs: [] };

function makeClassList() {
  const set = new Set();
  return {
    add: (...c) => c.forEach(x => set.add(x)),
    remove: (...c) => c.forEach(x => set.delete(x)),
    toggle: (c, on) => {
      if (on === undefined) { if (set.has(c)) set.delete(c); else set.add(c); }
      else if (on) set.add(c); else set.delete(c);
      return set.has(c);
    },
    contains: (c) => set.has(c)
  };
}

function makeEl(tag) {
  const el = {
    tagName: String(tag || 'div').toUpperCase(),
    style: {
      setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; }
    },
    classList: makeClassList(),
    dataset: {},
    children: [],
    value: '', checked: false, disabled: false,
    textContent: '', innerText: '', title: '', src: '', href: '',
    id: '', className: '', type: '', min: '', max: '', step: '', placeholder: '', alt: '',
    focus() {}, blur() {}, click() {}, remove() {},
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.push(c); return c; },
    removeChild() {}, setAttribute() {}, getAttribute() { return null; },
    hasAttribute() { return false; }, removeAttribute() {},
    addEventListener() { record.listeners++; },
    removeEventListener() {},
    querySelector() { return makeEl('div'); },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 100, height: 20 }; },
    scrollIntoView() {}, select() {},
    parentNode: null, firstChild: null,
    _html: '', _htmlSet: false
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) { el._html = String(v); el._htmlSet = true; }
  });
  return el;
}

const elementCache = new Map();
function getEl(sel) {
  if (!elementCache.has(sel)) {
    const el = makeEl(sel.replace(/^[#.]/, ''));
    el.id = sel.startsWith('#') ? sel.slice(1) : '';
    elementCache.set(sel, el);
  }
  return elementCache.get(sel);
}

const body = makeEl('body');
const doc = {
  documentElement: makeEl('html'),
  body: body,
  head: makeEl('head'),
  querySelector: (s) => getEl(s),
  querySelectorAll: () => [],
  createElement: (t) => makeEl(t),
  getElementById: (id) => getEl('#' + id),
  addEventListener() { record.listeners++; },
  removeEventListener() {},
  hidden: false,
  title: '',
  readyState: 'complete'
};

/* ---------------- 真实 store 支撑的 api 替身 ---------------- */
const { createStore } = require('../../lib/store.js');
const { migrate } = require('../../lib/migrate.js');
const { defaultData } = require('../../lib/defaults.js');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-headless-'));
const store = createStore({
  filePath: path.join(tmpDir, 'workbench-data.json'),
  backupDir: path.join(tmpDir, 'backups'),
  defaults: defaultData,
  migrate: migrate,
  debounceMs: 1
});
store.load();

const noop = () => Promise.resolve(null);
const apiBase = {
  load: () => Promise.resolve({ rev: store.getRev(), data: store.read() }),
  commit: (p) => Promise.resolve(store.commit(p && p.patch)),
  appInfo: () => Promise.resolve({ version: '1.8.2-headless', platform: 'win32', userData: tmpDir, hotkey: 'Win+Alt+Space' }),
  diagnostics: () => Promise.resolve({
    version: '1.8.2-headless', platform: 'win32', userData: tmpDir,
    powershell: { checked: true, available: true, exe: 'powershell.exe', version: '5.1', languageMode: 'FullLanguage', canAddType: true, features: {} },
    store: store.diagnostics(), usage: { enabled: false, sampling: false, paused: false },
    clipboard: { historyEnabled: true, items: 0 }, hotkeys: [], icons: { files: 0, bytes: 0 }
  }),
  listBackups: () => Promise.resolve([]),
  getUsageSummary: () => Promise.resolve({
    supported: true, enabled: false, dayCount: 0,
    today: { total: 0, categories: [], topApps: [] },
    daily: [], topApps: [], categories: [], topTitles: [], pomodoros: { today: 0, week: 0 }
  }),
  onChanged: () => {}, onDiagnostics: () => {}, onMode: () => {}, onLayout: () => {}, onMaximized: () => {},
  onVisibility: () => {}, onQuickReset: () => {}, onClipReset: () => {}, onClipUpdated: () => {},
  onShotInit: () => {}, onShotResult: () => {}
};
const api = new Proxy(apiBase, {
  get(t, k) { return (k in t) ? t[k] : noop; },
  has() { return true; }
});

/* ---------------- 建立 vm 上下文（= 页面全局作用域） ---------------- */
const sandbox = {};
vm.createContext(sandbox);
Object.assign(sandbox, {
  document: doc,
  navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'headless' },
  location: { search: '', href: 'file:///renderer/index.html', hash: '' },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  requestAnimationFrame: (cb) => setTimeout(cb, 0),
  cancelAnimationFrame: () => {},
  alert: () => {},
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  innerWidth: 1280,
  innerHeight: 800,
  devicePixelRatio: 1,
  setTimeout, setInterval, clearTimeout, clearInterval, queueMicrotask,
  api: api,
  console: {
    log: (...a) => record.logs.push(['log', a.join(' ')]),
    warn: (...a) => { record.logs.push(['warn', a.join(' ')]); record.errors.push({ where: 'console.warn', error: new Error(a.join(' ')) }); },
    error: (...a) => { record.logs.push(['error', a.join(' ')]); record.errors.push({ where: 'console.error', error: new Error(a.join(' ')) }); },
    info: () => {}, debug: () => {}
  }
});
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;

/* ---------------- 按 index.html 顺序加载 ---------------- */
const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
const scripts = [];
{
  const re = /<script src="([^"]+)"><\/script>/g;
  let m;
  while ((m = re.exec(html)) !== null) scripts.push(m[1]);
}
console.log('index.html 声明脚本 ' + scripts.length + ' 个：');
console.log('  ' + scripts.join(' → '));
console.log('');

let firstFailure = null;
for (const s of scripts) {
  const full = path.join(RENDERER, s);
  if (!fs.existsSync(full)) {
    console.log('  X 文件不存在：' + s);
    if (!firstFailure) firstFailure = { where: s, error: new Error('文件不存在') };
    continue;
  }
  try {
    let code = fs.readFileSync(full, 'utf8');
    // app.js 末尾会直接 boot()；这里把那次调用包一层，以便抓出在 vm 上下文里
    // 不会冒泡到宿主进程的 Promise 拒绝（这正是「界面空白但看不到报错」的成因）
    if (s === 'app.js') {
      code = code.replace(/\bboot\(\);\s*$/,
        'window.__bootP = (function(){ try { return boot().then(function(){ window.__bootOk = true; }, function(e){ window.__bootErr = (e && e.stack) || String(e); }); } catch (e) { window.__bootErr = (e && e.stack) || String(e); return null; } })();');
    }
    vm.runInContext(code, sandbox, { filename: s });
    console.log('  OK 已加载 ' + s);
  } catch (e) {
    console.log('  X 加载失败 ' + s + ' -> ' + (e && e.message));
    if (e && e.stack) console.log('     ' + e.stack.split('\n').slice(1, 4).join('\n     '));
    if (!firstFailure) firstFailure = { where: s, error: e };
    break;
  }
}

/* 脚本自身的 boot() 若 reject，在 vm 上下文里可能不会冒泡到宿主进程，
   因此这里显式再跑一次 boot() 并把错误抓出来；同时打印关键状态便于定位。 */
process.on('unhandledRejection', (reason) => {
  record.errors.push({ where: 'unhandledRejection(host)', error: reason });
});

setTimeout(() => {
  console.log('\n=== 启动链探测 ===');
  const probe = `
    (function () {
      var out = {
        typeofBoot: typeof boot,
        typeofRender: typeof render,
        typeofRenderDashboard: typeof renderDashboard,
        typeofState: typeof state,
        hasProto: !!(window.WB && window.WB.proto),
        hasApi: !!api,
        hasDateutil: !!(window.WB && window.WB.dateutil),
        hasImportguard: !!(window.WB && window.WB.importguard)
      };
      try {
        out.bootResult = String(boot());
      } catch (e) {
        out.bootThrewSync = (e && e.stack) || String(e);
      }
      return JSON.stringify(out);
    })()
  `;
  let probeOut = null;
  try {
    probeOut = vm.runInContext(probe, sandbox, { filename: 'probe' });
    console.log(probeOut);
  } catch (e) {
    console.log('探测本身失败：' + (e && e.stack ? e.stack.split('\n').slice(0, 5).join('\n  ') : e));
  }
}, 400);

setTimeout(() => {
  const bootErr = sandbox.__bootErr;
  const bootOk = sandbox.__bootOk;
  console.log('\n=== app.js 里那次 boot() 的结果 ===');
  console.log('成功：' + (bootOk ? '是' : '否'));
  if (bootErr) {
    console.log('失败原因：');
    console.log(String(bootErr).split('\n').slice(0, 8).map(l => '  ' + l).join('\n'));
  }

  console.log('\n=== 结果 ===');
  console.log('注册的 DOM 事件监听数：' + record.listeners);

  const navEl = elementCache.get('#nav');
  const viewEl = elementCache.get('#view');
  console.log('#nav 已渲染：' + (navEl && navEl._htmlSet ? '是（' + navEl.innerHTML.length + ' 字符）' : '否'));
  console.log('#view 已渲染：' + (viewEl && viewEl._htmlSet ? '是（' + viewEl.innerHTML.length + ' 字符）' : '否'));
  if (viewEl && viewEl.innerHTML) {
    console.log('#view 内容开头：' + viewEl.innerHTML.replace(/\s+/g, ' ').slice(0, 140));
  }
  const bodyHtml = body.innerHTML || '';
  if (bodyHtml.indexOf('preload') !== -1) console.log('!! body 显示了错误提示：' + bodyHtml.slice(0, 200));

  console.log('数据仓库修订号：' + store.getRev() + '（>0 表示渲染层成功提交过补丁）');

  if (record.logs.length) {
    console.log('\n渲染层日志（最多 15 条）：');
    for (const l of record.logs.slice(0, 15)) console.log('  [' + l[0] + '] ' + l[1].slice(0, 200));
  }
  if (record.errors.length) {
    console.log('\n捕获到的错误：');
    for (const e of record.errors) {
      console.log('  - (' + e.where + ') ' + (e.error && e.error.stack ? e.error.stack.split('\n').slice(0, 4).join('\n    ') : e.error));
    }
  }

  const ok = !firstFailure && !record.errors.length && navEl && navEl._htmlSet && viewEl && viewEl._htmlSet;
  console.log('\n' + (ok ? '结论：渲染层能完成启动并渲染（无浏览器环境）' : '结论：渲染层启动失败'));
  process.exit(ok ? 0 : 1);
}, 800);
