'use strict';

/* 主进程装配测试（不需要真实 Electron）
   ---------------------------------------------------------------------------
   本项目的 main.js 只在 Electron 里跑，因此在没有图形环境时最容易出问题的
   「require 拼错、初始化路径抛异常、IPC 少注册」这类错误没人能发现。
   这里用一个最小 electron 替身把 main.js 真正 require 进来并跑完启动流程，
   断言：模块全部解析、启动不抛异常、IPC 数量合理、数据仓库真的落盘。
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const ROOT = path.join(__dirname, '..');

function makeElectronStub(tmpDir) {
  const handlers = new Map();
  const sent = [];
  const registeredShortcuts = new Set();
  const windows = [];

  const workArea = { x: 0, y: 0, width: 1920, height: 1040 };

  function makeWebContents() {
    return {
      send: (ch, payload) => sent.push({ ch: ch, payload: payload }),
      on: () => {},
      once: () => {},
      setWindowOpenHandler: () => {},
      executeJavaScript: () => Promise.resolve(null)
    };
  }

  class BrowserWindow {
    constructor(opts) {
      this.opts = opts || {};
      this.webContents = makeWebContents();
      this._bounds = { x: 0, y: 0, width: 1280, height: 800 };
      this._visible = false;
      this._destroyed = false;
      windows.push(this);
    }
    loadFile() { return Promise.resolve(); }
    loadURL() { return Promise.resolve(); }
    on() { return this; }
    once(ev, cb) { if (ev === 'ready-to-show' && typeof cb === 'function') this._readyCb = cb; return this; }
    show() { this._visible = true; if (this._readyCb) { const cb = this._readyCb; this._readyCb = null; } }
    hide() { this._visible = false; }
    focus() {}
    isVisible() { return this._visible; }
    isDestroyed() { return this._destroyed; }
    isMaximized() { return false; }
    isMinimized() { return false; }
    maximize() {}
    unmaximize() {}
    minimize() {}
    setBounds(b) { this._bounds = Object.assign({}, this._bounds, b); }
    getBounds() { return Object.assign({}, this._bounds); }
    setPosition(x, y) { this._bounds.x = x; this._bounds.y = y; }
    setSkipTaskbar() {}
    setResizable() {}
    setMovable() {}
    setMinimizable() {}
    setMaximizable() {}
    setMinimumSize() {}
    setAlwaysOnTop() {}
    setMenuBarVisibility() {}
    setBackgroundColor() {}
    setBackgroundMaterial() {}
    destroy() { this._destroyed = true; }
    static getAllWindows() { return windows.slice(); }
  }

  const app = {
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    quit: () => {},
    exit: () => {},
    on: () => {},
    once: () => {},
    getPath: (name) => (name === 'userData' ? tmpDir : tmpDir),
    getVersion: () => '1.8.2-test',
    setAppUserModelId: () => {},
    setLoginItemSettings: () => {},
    setPath: () => {},
    getFileIcon: () => Promise.resolve({ isEmpty: () => true, toDataURL: () => '' })
  };

  const electron = {
    app: app,
    BrowserWindow: BrowserWindow,
    ipcMain: {
      handle: (ch, fn) => handlers.set(ch, fn),
      on: (ch, fn) => handlers.set(ch, fn)
    },
    dialog: {
      showOpenDialog: () => Promise.resolve({ canceled: true, filePaths: [] }),
      showSaveDialog: () => Promise.resolve({ canceled: true, filePath: null })
    },
    shell: {
      openPath: () => Promise.resolve(''),
      showItemInFolder: () => {},
      openExternal: () => {},
      readShortcutLink: () => { throw new Error('not a lnk'); }
    },
    Tray: class { constructor() {} setToolTip() {} setContextMenu() {} on() {} },
    Menu: { buildFromTemplate: (t) => ({ items: t }) },
    globalShortcut: {
      register: (accel) => { registeredShortcuts.add(accel); return true; },
      unregister: (accel) => { registeredShortcuts.delete(accel); },
      isRegistered: (accel) => registeredShortcuts.has(accel),
      unregisterAll: () => registeredShortcuts.clear()
    },
    screen: {
      getPrimaryDisplay: () => ({ id: 1, workArea: workArea, size: { width: 1920, height: 1080 }, scaleFactor: 1 }),
      on: () => {}
    },
    nativeImage: {
      createFromPath: () => ({ isEmpty: () => true, resize: () => ({ isEmpty: () => true }) }),
      createEmpty: () => ({ isEmpty: () => true })
    },
    Notification: class { constructor() {} show() {} static isSupported() { return false; } },
    nativeTheme: { shouldUseDarkColors: false, on: () => {} },
    clipboard: {
      has: () => false,
      availableFormats: () => [],
      readText: () => '',
      readBuffer: () => Buffer.alloc(0),
      readImage: () => ({ isEmpty: () => true }),
      writeText: () => {},
      writeImage: () => {}
    },
    powerMonitor: { getSystemIdleTime: () => 0, on: () => {} },
    desktopCapturer: { getSources: () => Promise.resolve([]) },
    net: { request: () => ({ on: () => {}, end: () => {}, setHeader: () => {}, setTimeout: () => {} }) },
    __internals: { handlers, sent, registeredShortcuts, windows }
  };
  return electron;
}

/* main.js 会创建长驻定时器（剪贴板轮询 1.2s、时间统计 5s、提醒 30s、备份 6h），
   而且这些定时器是在 whenReady 的异步续体里创建的 —— 只在 require 期间包一层没用。
   这里在整个测试文件执行期间生效：对「≥1s 的定时器」做 unref（不阻止进程退出，
   但进程活着时照常触发）。短定时器保持原样，避免影响同进程的其他测试文件。 */
const realSetInterval = global.setInterval;
const realSetTimeout = global.setTimeout;
function wrapLongTimer(real) {
  return function (handler, ms) {
    const h = real(handler, ms);
    if (Number(ms) >= 1000 && h && typeof h.unref === 'function') h.unref();
    return h;
  };
}
global.setInterval = wrapLongTimer(realSetInterval);
global.setTimeout = wrapLongTimer(realSetTimeout);
test.after(() => {
  global.setInterval = realSetInterval;
  global.setTimeout = realSetTimeout;
});

// 拦截 require('electron')，其余模块正常加载
function withElectronStub(stub, fn) {
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return stub;
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return fn();
  } finally {
    Module._load = originalLoad;
  }
}

function freshMain(stub) {
  const mainPath = path.join(ROOT, 'main.js');
  delete require.cache[require.resolve(mainPath)];
  return withElectronStub(stub, () => require(mainPath));
}

test('main.js 能在替身 Electron 下装配成功并注册全部 IPC', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-main-'));
  const stub = makeElectronStub(tmpDir);
  assert.doesNotThrow(() => freshMain(stub), 'require(main.js) 不应抛异常');

  const { handlers, sent, registeredShortcuts, windows } = stub.__internals;
  assert.ok(handlers.size > 40, 'IPC handler 数量异常：' + handlers.size);

  // 关键通道必须都在（重构最容易踩的就是漏注册）
  for (const ch of ['store:load', 'store:commit', 'app:info', 'app:diagnostics', 'app:probePowershell',
    'fs:getIcon', 'fs:resolveItem', 'clip:list', 'usage:getSummary', 'auto:run', 'data:backupNow']) {
    assert.ok(handlers.has(ch), '缺少 IPC 通道：' + ch);
  }
  assert.strictEqual(handlers.has('store:save'), false, '旧的整份写回通道不应存在');

  // 等启动流程（whenReady 的异步续体 + 定时器回调）跑完一轮
  await new Promise(r => setTimeout(r, 250));

  // 主窗口 + 快速添加 + 剪贴板窗口应已创建
  assert.ok(windows.length >= 3, '应至少创建 3 个窗口，实际 ' + windows.length);
  // 快捷键应已注册（Windows 上 4 个；其他平台 3 个）
  assert.ok(registeredShortcuts.size >= 3, '快捷键注册数异常：' + registeredShortcuts.size);
  assert.ok(registeredShortcuts.has('Super+Alt+Space'), '缺少显示/隐藏快捷键');
  // 数据仓库应已建立文件
  assert.ok(fs.existsSync(path.join(tmpDir, 'workbench-data.json')), '启动后应建立数据文件');
  const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'workbench-data.json'), 'utf8'));
  assert.strictEqual(data.version, 2, '新数据文件 schema 版本应为 2');
  assert.deepStrictEqual(data.todos, []);
  for (const k of ['view', '_todoLv', '_todoFilter', '_pomo']) {
    assert.strictEqual(Object.prototype.hasOwnProperty.call(data, k), false, k + ' 不应出现在数据文件');
  }
});

test('store:commit 通道拒绝非法补丁、接受合法补丁', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-main-'));
  const stub = makeElectronStub(tmpDir);
  freshMain(stub);
  await new Promise(r => setTimeout(r, 150));

  const { handlers } = stub.__internals;
  const commit = handlers.get('store:commit');
  // 伪造可信来源（renderer 目录下的页面）
  const event = {
    senderFrame: { url: require('node:url').pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href },
    sender: {}
  };
  event.sender.mainFrame = event.senderFrame;

  const bad = commit(event, { patch: { collections: { secrets: {} } } });
  assert.strictEqual(bad.ok, false, '非法补丁应被拒绝');
  assert.match(String(bad.error), /未知集合/);

  const ok = commit(event, {
    patch: { collections: { todos: { order: ['t1'], upsert: [{ id: 't1', text: '来自渲染层' }], remove: [] } } }
  });
  assert.strictEqual(ok.ok, true, '合法补丁应被接受');
  assert.strictEqual(ok.changed, true);

  const data = JSON.parse(fs.readFileSync(path.join(tmpDir, 'workbench-data.json'), 'utf8'));
  assert.strictEqual(data.todos[0].text, '来自渲染层');
});

test('IPC 来源校验：非本应用页面被拒绝', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-main-'));
  const stub = makeElectronStub(tmpDir);
  freshMain(stub);
  await new Promise(r => setTimeout(r, 150));

  const { handlers } = stub.__internals;
  const load = handlers.get('store:load');
  const foreign = {
    senderFrame: { url: 'file:///C:/Users/Public/evil.html' },
    sender: {}
  };
  foreign.sender.mainFrame = foreign.senderFrame;
  assert.throws(() => load(foreign), /forbidden/, '外部本地页面必须被拒绝');

  const http = { senderFrame: { url: 'https://example.com/' }, sender: {} };
  http.sender.mainFrame = http.senderFrame;
  assert.throws(() => load(http), /forbidden/);
});
