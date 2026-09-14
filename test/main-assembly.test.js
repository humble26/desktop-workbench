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
    // AI 密钥库依赖 safeStorage。替身要能真的往返，否则「保存密钥」这条路
    // 在测试里永远走不通，只有真机上才第一次被执行。
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (s) => Buffer.from('WBSTUB:' + Buffer.from(String(s), 'utf8').toString('base64'), 'utf8'),
      decryptString: (buf) => Buffer.from(String(buf.toString('utf8')).slice(7), 'base64').toString('utf8')
    },
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

/* ---------------------------------------------------------------------------
   打包环境模拟：把应用放进名为 app.asar 的目录里再 require 主进程。
   这是 v1.8.2「界面空白」的针对性防线 —— 当时的成因是 IPC 来源校验里
   依赖了 `senderFrame === sender.mainFrame` 这一 Electron 内部实现细节，
   在打包环境下两者是不同实例，于是所有 IPC 被拒、渲染层拿不到数据、启动中断。
   这里用「不同实例 + asar 路径 + 中文安装目录」的 event 形态调用真实 handler，
   要求它正常返回数据。
   --------------------------------------------------------------------------- */
test('打包环境（app.asar + 中文路径 + 框架实例不同）下 IPC 必须可用', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asar-'));
  const asarDir = path.join(root, '安装目录 测试', 'resources', 'app.asar');
  fs.mkdirSync(asarDir, { recursive: true });
  // 只复制运行期需要的部分（不复制 node_modules / test / tools / dist）
  for (const f of ['main.js', 'preload.js', 'package.json']) {
    fs.copyFileSync(path.join(ROOT, f), path.join(asarDir, f));
  }
  // 必须**递归**复制：真实的打包白名单是 lib/**/*（package.json build.files），
  // 只拷一层的话，lib/ai/ 这样的子目录不会进模拟包，
  // 于是 require('./lib/ai/…') 失败 —— 那是模拟失真，不是应用的问题。
  function copyTree(from, to) {
    fs.mkdirSync(to, { recursive: true });
    for (const f of fs.readdirSync(from)) {
      const s = path.join(from, f);
      if (fs.statSync(s).isDirectory()) copyTree(s, path.join(to, f));
      else fs.copyFileSync(s, path.join(to, f));
    }
  }
  for (const d of ['lib', 'renderer']) copyTree(path.join(ROOT, d), path.join(asarDir, d));

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-asar-user-'));
  const stub = makeElectronStub(tmpDir);
  const mainPath = path.join(asarDir, 'main.js');
  delete require.cache[require.resolve(mainPath)];
  assert.doesNotThrow(() => withElectronStub(stub, () => require(mainPath)), '打包路径下 require(main.js) 不应失败');
  await new Promise(r => setTimeout(r, 200));

  const { handlers } = stub.__internals;
  const load = handlers.get('store:load');
  assert.ok(load, '主进程应注册 store:load');

  const pageUrl = require('node:url').pathToFileURL(path.join(asarDir, 'renderer', 'index.html')).href;
  // 关键：senderFrame 与 sender.mainFrame 是不同对象（Electron 不保证同一性）
  const senderFrame = { url: pageUrl, parent: null, detached: false };
  const mainFrame = { url: pageUrl, parent: null, detached: false };
  const ev = {
    senderFrame: senderFrame,
    sender: { mainFrame: mainFrame, getURL: () => pageUrl }
  };
  assert.notStrictEqual(senderFrame, mainFrame, '前提：两者不同对象');

  let out = null;
  assert.doesNotThrow(() => { out = load(ev); }, '打包环境下 store:load 不应抛 forbidden');
  assert.ok(out && out.data, '应返回 { rev, data }');
  assert.strictEqual(typeof out.rev, 'number');
  assert.deepStrictEqual(out.data.todos, []);

  // 同时验证写回通道在打包路径下也可用
  const commit = handlers.get('store:commit');
  const r = commit(ev, { patch: { collections: { todos: { order: ['t1'], upsert: [{ id: 't1', text: '打包环境测试' }], remove: [] } } } });
  assert.strictEqual(r.ok, true, '打包环境下 store:commit 应可用');
  assert.strictEqual(out && null, null);
});

test('打包环境：renderer/app.js 必须带启动入口调用', () => {
  const appJs = fs.readFileSync(path.join(ROOT, 'renderer', 'app.js'), 'utf8');
  assert.match(appJs, /^\s*boot\(\);\s*$/m, 'app.js 缺少 boot(); 入口调用，页面将不会启动');
});

/* ---------------------------------------------------------------------------
   AI 余额监测：主进程侧的「不发请求」承诺
   这是文档里写死的一条：功能默认关闭时不产生任何相关网络请求。
   保存密钥后「顺手验证」看着无害，但它正是最容易把这条承诺悄悄破坏掉的路径，
   所以必须在这里用真实的 handler + 真实的 net 替身把它钉住。
   --------------------------------------------------------------------------- */
/* 让替身 net 真的给出一次响应。
   只记录调用而不回包的话，lib/ai/http.js 的 Promise 永远不会 settle，
   调用它的 handler 就会一直挂着 —— 测试表现是「超时」，而不是「失败」，
   非常难查。这里回一个 401（模拟密钥无效），足够让整条链路走完。 */
function stubNetWith401(stub, netCalls) {
  stub.net.request = (opts) => {
    netCalls.push(opts);
    const h = {};
    const resH = {};
    const req = {
      on: (ev, cb) => { h[ev] = cb; return req; },
      setHeader: () => req,
      setTimeout: () => req,
      abort: () => {},
      end: () => {
        setImmediate(() => {
          const res = { statusCode: 401, on: (ev, cb) => { resH[ev] = cb; return res; } };
          if (h.response) h.response(res);
          if (resH.data) resH.data(Buffer.from(JSON.stringify({ error: { message: 'Authentication Fails' } }), 'utf8'));
          if (resH.end) resH.end();
        });
      }
    };
    return req;
  };
}

test('AI 监测：功能关闭时保存密钥与手动刷新都不发任何请求', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-main-ai-'));
  const stub = makeElectronStub(tmpDir);
  const netCalls = [];
  stubNetWith401(stub, netCalls);
  freshMain(stub);
  await new Promise(r => setTimeout(r, 150));

  const { handlers } = stub.__internals;
  const ev = {
    senderFrame: { url: require('node:url').pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href },
    sender: {}
  };
  ev.sender.mainFrame = ev.senderFrame;

  // 1) 功能默认关闭（默认值就是 enabled:false）
  const setKey = handlers.get('ai:setKey');
  assert.ok(setKey, '主进程应注册 ai:setKey');
  const r1 = setKey(ev, { id: 'deepseek', key: 'sk-test-key-0123456789', verify: true });
  assert.strictEqual(r1.ok, true, '替身 safeStorage 可用时应能保存密钥：' + JSON.stringify(r1));
  await new Promise(r => setTimeout(r, 150));
  assert.strictEqual(netCalls.length, 0, '功能关闭时「保存密钥顺手验证」不该发起请求');

  const refresh = handlers.get('ai:refresh');
  const r2 = await refresh(ev, null);
  assert.strictEqual(r2.ok, false);
  assert.strictEqual(r2.reason, 'disabled', '功能关闭时刷新应被明确拒绝');
  assert.strictEqual(netCalls.length, 0, '被拒绝时更不该有请求');

  // 2) 打开功能后再刷新 —— 证明这条路不是死的（否则上面的「0 次」毫无意义）
  const commit = handlers.get('store:commit');
  const pc = commit(ev, {
    patch: {
      settings: {
        aiMonitor: {
          enabled: true, intervalMinutes: 30, lowBalance: 0,
          providers: { deepseek: { enabled: true, price: 4 } }
        }
      }
    }
  });
  assert.strictEqual(pc.ok, true, '开关应能通过补丁落盘：' + JSON.stringify(pc));

  const r3 = await refresh(ev, ['deepseek']);
  assert.strictEqual(r3.ok, true, '功能打开后应接受刷新');
  assert.strictEqual(r3.refreshed, 1);
  assert.ok(netCalls.length >= 1, '功能打开后应真的发起请求');
  assert.match(String(netCalls[0].url), /deepseek/, '请求应发往 DeepSeek 官方地址');
  assert.strictEqual(netCalls[0].redirect, 'manual', '请求必须设 redirect=manual（防止密钥被带到跳转目标）');
  assert.ok(/Bearer sk-test-key/.test(String((netCalls[0].headers || {}).Authorization)),
    '应带上 Authorization 头');

  // 密钥无效时应把原因记下来，而不是静默成功
  const sum = handlers.get('ai:list')(ev);
  const ds = sum.providers.find(x => x.id === 'deepseek');
  assert.strictEqual(ds.ok, false);
  assert.match(ds.error, /密钥无效/);
});

test('AI 监测：拉黑开关的平台即使被显式点名也不发请求', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-main-ai2-'));
  const stub = makeElectronStub(tmpDir);
  const netCalls = [];
  stubNetWith401(stub, netCalls);
  freshMain(stub);
  await new Promise(r => setTimeout(r, 150));
  const { handlers } = stub.__internals;
  const ev = {
    senderFrame: { url: require('node:url').pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href },
    sender: {}
  };
  ev.sender.mainFrame = ev.senderFrame;

  handlers.get('store:commit')(ev, {
    patch: {
      settings: {
        aiMonitor: {
          enabled: true, intervalMinutes: 30, lowBalance: 0,
          providers: { deepseek: { enabled: false, price: 4 } }
        }
      }
    }
  });
  handlers.get('ai:setKey')(ev, { id: 'deepseek', key: 'sk-test-key-0123456789', verify: false });

  const r = await handlers.get('ai:refresh')(ev, ['deepseek']);
  assert.strictEqual(r.refreshed, 0, '平台开关关着时不该刷新');
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(netCalls.length, 0, '关掉的平台不该被任何路径请求');
});

test('AI 监测：密钥文件里不得出现明文，且主数据与渲染层都拿不到明文', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-main-aikey-'));
  const stub = makeElectronStub(tmpDir);
  const netCalls = [];
  stubNetWith401(stub, netCalls);
  freshMain(stub);
  await new Promise(r => setTimeout(r, 150));

  const ev = {
    senderFrame: { url: require('node:url').pathToFileURL(path.join(ROOT, 'renderer', 'index.html')).href },
    sender: {}
  };
  ev.sender.mainFrame = ev.senderFrame;

  const secret = 'sk-plaintext-must-not-appear-987654321';
  const r = stub.__internals.handlers.get('ai:setKey')(ev, { id: 'deepseek', key: secret, verify: false });
  assert.strictEqual(r.ok, true);

  const keyFile = path.join(tmpDir, 'ai-keys.json');
  assert.ok(fs.existsSync(keyFile), '应建立 ai-keys.json');
  const raw = fs.readFileSync(keyFile, 'utf8');
  assert.ok(raw.indexOf(secret) === -1, '密钥文件里出现了明文！');
  assert.ok(raw.indexOf('plaintext-must-not-appear') === -1, '密钥文件里出现了明文片段！');

  // 密钥不该出现在主数据文件里（它必须与 workbench-data.json 隔离）
  const data = fs.readFileSync(path.join(tmpDir, 'workbench-data.json'), 'utf8');
  assert.ok(data.indexOf(secret) === -1, '主数据文件里出现了明文密钥！');
  assert.ok(data.indexOf('aiMonitor') !== -1, '主数据里应只保存 aiMonitor 配置（不含密钥）');

  // 渲染层能读到的形状里也不能有明文
  const summary = stub.__internals.handlers.get('ai:list')(ev);
  assert.ok(JSON.stringify(summary).indexOf(secret) === -1, 'ai:list 泄露了明文密钥');
  assert.ok(JSON.stringify(summary).indexOf('****4321') !== -1, 'ai:list 应给出掩码');
});
