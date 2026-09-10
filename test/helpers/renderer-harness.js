'use strict';

/* ===========================================================================
   渲染层无浏览器装载器（测试用）
   ---------------------------------------------------------------------------
   按 index.html 声明的顺序，把渲染脚本逐个 runInContext 到一个共享的 vm 全局
   作用域里 —— 忠实复现「多个 <script> 共用同一页面作用域」的语义。
   这样就能在没有 Chromium 的环境（CI / 沙箱 / 无桌面会话）里验证：

     · 每个脚本都能加载
     · app.js 自己那次 boot() 真的成功了（页面能起来）
     · 各个视图都能渲染出来

   为什么必须有它：v1.8.2 曾因为拆分脚本时把末尾的 `boot();` 入口调用当成
   「包装行」丢掉，导致安装后界面全空白 —— 而当时的测试全部通过，
   因为没有任何一项检查「页面到底能不能启动」。

   用法：
     const r = createRendererHarness();
     await r.boot();                 // 加载脚本 + 等启动完成
     r.eval('state.view = "todos"; render();');
     r.result();                     // { navRendered, viewRendered, errors, ... }
     r.dispose();                    // 清掉渲染层注册的定时器
   =========================================================================== */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const RENDERER = path.join(ROOT, 'renderer');

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
    style: { setProperty() {}, removeProperty() {}, getPropertyValue() { return ''; } },
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
    addEventListener() {}, removeEventListener() {},
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

function createRendererHarness(opts) {
  const options = opts || {};
  const { createStore } = require('../../lib/store.js');
  const { migrate } = require('../../lib/migrate.js');
  const { defaultData } = require('../../lib/defaults.js');
  const proto = require('../../renderer/storeproto.js');

  const record = { errors: [], logs: [], listeners: 0 };
  const timers = new Set();
  const elementCache = new Map();
  const body = makeEl('body');

  function getEl(sel) {
    if (!elementCache.has(sel)) {
      const el = makeEl(sel.replace(/^[#.]/, ''));
      el.id = sel.startsWith('#') ? sel.slice(1) : '';
      elementCache.set(sel, el);
    }
    return elementCache.get(sel);
  }

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

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-harness-'));
  const storeFile = path.join(tmpDir, 'workbench-data.json');
  // options.dataFile：把「已有的数据文件」直接喂给渲染层 ——
  // 用于复现「渲染层 + 真实用户数据」这一组合（曾漏测：只测过全新数据）
  if (options.dataFile && fs.existsSync(options.dataFile)) {
    fs.copyFileSync(options.dataFile, storeFile);
  }
  const store = createStore({
    filePath: storeFile,
    backupDir: path.join(tmpDir, 'backups'),
    defaults: defaultData,
    migrate: migrate,
    debounceMs: 1
  });
  store.load();
  if (options.seed) {
    store.mutate(d => { Object.assign(d, options.seed(d)); });
    store.flush();
  }

  const noop = () => Promise.resolve(null);
  const apiBase = {
    load: () => Promise.resolve({ rev: store.getRev(), data: store.read() }),
    commit: (p) => Promise.resolve(store.commit(p && p.patch)),
    appInfo: () => Promise.resolve({ version: 'test', platform: 'win32', userData: tmpDir, hotkey: 'Win+Alt+Space' }),
    diagnostics: () => Promise.resolve({
      version: 'test', platform: 'win32', userData: tmpDir,
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
  const api = new Proxy(apiBase, { get(t, k) { return (k in t) ? t[k] : noop; }, has() { return true; } });
  // 允许测试覆盖个别 api 方法（例如让 load() 失败，验证界面会给出可见提示而不是空白）
  if (options.apiOverrides) Object.assign(apiBase, options.apiOverrides);

  const sandbox = {};
  vm.createContext(sandbox);
  Object.assign(sandbox, {
    document: doc,
    navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'harness' },
    location: { search: '', href: 'file:///renderer/index.html', hash: '' },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    requestAnimationFrame: (cb) => { const h = setTimeout(cb, 0); timers.add(h); return h; },
    cancelAnimationFrame: (h) => { clearTimeout(h); timers.delete(h); },
    alert: () => {},
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    innerWidth: 1280,
    innerHeight: 800,
    devicePixelRatio: 1,
    setTimeout: (fn, ms) => { const h = setTimeout(fn, ms); timers.add(h); return h; },
    setInterval: (fn, ms) => { const h = setInterval(fn, ms); timers.add(h); return h; },
    clearTimeout: (h) => { clearTimeout(h); timers.delete(h); },
    clearInterval: (h) => { clearInterval(h); timers.delete(h); },
    queueMicrotask,
    addEventListener: (type) => { record.logs.push(['window.addEventListener', String(type)]); },
    removeEventListener: () => {},
    dispatchEvent: () => true,
    console: {
      log: (...a) => record.logs.push(['log', a.join(' ')]),
      info: () => {}, debug: () => {},
      warn: (...a) => record.logs.push(['warn', a.join(' ')]),
      error: (...a) => { record.logs.push(['error', a.join(' ')]); record.errors.push({ where: 'console.error', message: a.join(' ') }); }
    }
  });
  /* window.api 按真实 Electron 的形态定义：contextBridge 暴露的是
     「不可配置、不可写」属性（实测 { configurable:false, writable:false }）。
     注意：Node 的 vm 并不实现「顶层 const/let 与不可配置全局属性同名即 SyntaxError」
     这条规范检查（Chromium 会抛），所以这个桩**拦不住** `const api = window.api` 那类写法。
     该问题的防线是：
       · test/contract.test.js 的静态检查（已实测能抓出旧写法）
       · npm run test:smoke —— 真实 Electron 里跑真实页面 */
  Object.defineProperty(sandbox, 'api', {
    value: api,
    writable: false,
    configurable: false,
    enumerable: true
  });
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;

  const html = fs.readFileSync(path.join(RENDERER, 'index.html'), 'utf8');
  const scripts = [];
  {
    const re = /<script src="([^"]+)"><\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) scripts.push(m[1]);
  }

  const loadErrors = [];

  function loadScripts() {
    for (const s of scripts) {
      const full = path.join(RENDERER, s);
      if (!fs.existsSync(full)) { loadErrors.push({ script: s, message: '文件不存在' }); continue; }
      let code = fs.readFileSync(full, 'utf8');
      if (s === 'app.js') {
        // 把 app.js 自己那次 boot() 包一层，以便捕获在 vm 上下文里不冒泡的 Promise 拒绝，
        // 同时断言「页面能自己启动」——而不是靠外部再调一次 boot()
        code = code.replace(/\bboot\(\);\s*$/,
          'window.__bootP = (function(){ try { return boot().then(function(){ window.__bootOk = true; }, function(e){ window.__bootErr = (e && e.stack) || String(e); }); } catch (e) { window.__bootErr = (e && e.stack) || String(e); return null; } })();');
      }
      try {
        vm.runInContext(code, sandbox, { filename: s });
      } catch (e) {
        loadErrors.push({ script: s, message: (e && e.message) || String(e), stack: e && e.stack });
        break;
      }
    }
  }

  function evalIn(code) { return vm.runInContext(code, sandbox, { filename: 'eval' }); }

  async function boot(waitMs) {
    loadScripts();
    await new Promise(r => setTimeout(r, waitMs === undefined ? 120 : waitMs));
    return result();
  }

  function result() {
    const navEl = elementCache.get('#nav');
    const viewEl = elementCache.get('#view');
    return {
      scripts: scripts,
      loadErrors: loadErrors,
      errors: record.errors.concat(loadErrors.map(e => ({ where: 'script:' + e.script, message: e.message }))),
      logs: record.logs,
      bootOk: sandbox.__bootOk === true,
      bootErr: sandbox.__bootErr || null,
      navHtml: (navEl && navEl._htmlSet) ? navEl.innerHTML : null,
      viewHtml: (viewEl && viewEl._htmlSet) ? viewEl.innerHTML : null,
      listeners: record.listeners,
      storeRev: store.getRev(),
      // 追加到 body 上的内容（用于断言「失败时显示了可见的错误面板」）
      bodyChildren: body.children.map(c => c.innerHTML || ''),
      bodyHtml: body.innerHTML || '',
      store: store,
      evalIn: evalIn,
      dispose: dispose
    };
  }

  function dispose() {
    for (const h of timers) {
      try { clearTimeout(h); } catch (e) { /* ignore */ }
      try { clearInterval(h); } catch (e) { /* ignore */ }
    }
    timers.clear();
    try { store.flush(); } catch (e) { /* ignore */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }

  return { boot, result, dispose, evalIn, scripts, store, proto };
}

module.exports = { createRendererHarness };
