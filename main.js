'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, screen, nativeImage, Notification, nativeTheme, clipboard, powerMonitor, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { createStore } = require('./lib/store.js');
const { migrate } = require('./lib/migrate.js');
const { defaultData, TIME_TRACK_DEFAULTS } = require('./lib/defaults.js');
const { createTrustedSenderChecker } = require('./lib/security.js');
const { createPowerShell, lastMeaningfulLine } = require('./lib/powershell.js');
const { isSensitiveText } = require('./lib/sensitive.js');
const dateutil = require('./renderer/dateutil.js');

// 出错时把上下文写进控制台：静默 catch 会让问题无从排查（OCR / PowerShell / 数据导入等）
function logE(where, e) {
  try {
    console.warn('[workbench]', where, '::', (e && e.stack) || (e && e.message) || e);
  } catch (_) { /* ignore */ }
} 
const { parseQuickTodo, buildQuickTodo } = require('./lib/quickadd.js');
const usageDomain = require('./lib/usage.js');
const { createIconCache } = require('./lib/iconcache.js');
const { createRendererWatchdog } = require('./lib/renderer-watchdog.js');
const { validatePatch } = require('./lib/patchguard.js');
const proto = require('./renderer/storeproto.js');

// ---------------------------------------------------------------------------
// 单实例锁：防止重复启动
// ---------------------------------------------------------------------------
// 这里额外做了「谁在运行」的诊断：应用关闭窗口只是最小化到托盘，
// 因此升级后如果旧实例还在托盘里，点新版本只会把旧窗口叫出来 ——
// 现象就是「装了新版本但界面还是老样子」，极易误判为修复无效。
// 本次未能取得锁时，把「运行中的版本」与「本次版本」写进启动日志，便于一眼看出。
const runningInfoPath = () => path.join(app.getPath('userData'), 'running.json');

function readRunningInfo() {
  try { return JSON.parse(fs.readFileSync(runningInfoPath(), 'utf8')); } catch (e) { return null; }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  try {
    const other = readRunningInfo();
    const myVersion = app.getVersion();
    const lines = [
      '==== 桌面工作台启动日志（未创建窗口）====',
      '时间: ' + new Date().toISOString(),
      '本次启动版本: ' + myVersion,
      '本次可执行文件: ' + process.execPath,
      '资源目录: ' + __dirname,
      '结果: 已有实例正在运行，本次启动直接退出（单实例锁）',
      other ? ('运行中的实例版本: ' + other.version + '（pid ' + other.pid + '，启动于 ' + other.startedAt + '）') : '运行中的实例: 未记录到版本信息（可能是更早的版本）',
      other && other.version !== myVersion
        ? '⚠️ 版本不一致：你看到的窗口属于运行中的旧实例 ' + other.version + '，不是本次安装的 ' + myVersion + '。\n   请先在系统托盘图标上右键 →「退出」，再重新启动本版本。'
        : '版本一致，本次只是重复启动。'
    ];
    fs.mkdirSync(path.dirname(runningInfoPath()), { recursive: true });
    fs.writeFileSync(path.join(app.getPath('userData'), 'startup.log'), lines.join('\n'), 'utf8');
  } catch (e) { /* 诊断失败不影响退出 */ }
  app.quit();
} else {
  main();
}

function main() {
  let win = null;
  let tray = null;
  let qaWin = null;                       // 全局快速添加：小输入窗
  let isQuitting = false;
  let winBoundsTimer = null;
  const HOTKEY = 'Super+Alt+Space';       // 注册用加速器：Win 键在 Electron 中用 Super 表示
  const HOTKEY_LABEL = 'Win+Alt+Space';   // 展示给用户的文案
  const HOTKEY_ADD = 'Super+Alt+T';       // 全局快速添加待办
  const HOTKEY_ADD_LABEL = 'Win+Alt+T';
  const HOTKEY_SHOT = 'Super+Alt+S';      // 截图 OCR 取字
  const HOTKEY_SHOT_LABEL = 'Win+Alt+S';
  const HOTKEY_CLIP = 'Super+Alt+V';      // 剪贴板历史
  const HOTKEY_CLIP_LABEL = 'Win+Alt+V';

  const storePath = () => path.join(app.getPath('userData'), 'workbench-data.json');
  const backupDir = () => path.join(app.getPath('userData'), 'backups');

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fileDateTime(d) { d = d || new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; }

  // ---------------------------------------------------------------------------
  // 数据仓库：workbench-data.json 的唯一写入者（详见 lib/store.js）
  // 渲染层提交「补丁」，主进程提交「变更」，两边都落在这里，因此并发写入不再互相覆盖。
  // ---------------------------------------------------------------------------
  const store = createStore({
    filePath: storePath(),
    backupDir: backupDir(),
    defaults: defaultData,          // 函数声明已提升，此处仅传引用
    migrate: migrate,
    log: (msg) => { try { console.log('[store] ' + msg); } catch (e) { /* ignore */ } },
    onChange: (info) => broadcastChanged(info)
  });

  function doBackup() { return store.backup(); }
  function listBackups() { return store.listBackups(); }

  // ---------------------------------------------------------------------------
  // PowerShell 能力探测：剪贴板文件读写、快捷方式/图标兜底、时间统计采样都依赖它。
  // 探测结果随 app:diagnostics 暴露给界面，避免「功能没反应但不知道为什么」。
  // ---------------------------------------------------------------------------
  const ps = createPowerShell({
    log: (msg) => { try { console.log('[ps] ' + msg); } catch (e) { /* ignore */ } }
  });
  ps.onUpdate(() => sendDiagnostics());

  // 图标缓存：图标落成独立 PNG，数据文件里只留 `icon:<sha1>.png` 短引用，
  // 避免几十个快捷方式把 workbench-data.json 顶到几百 KB
  const iconCache = createIconCache({
    dir: path.join(app.getPath('userData'), 'icons'),
    log: (msg) => { try { console.log('[icon] ' + msg); } catch (e) { /* ignore */ } }
  });

  // ---------------------------------------------------------------------------
  // 数据存储（读取走内存缓存，落盘由 lib/store.js 独占并做原子写 + 写合并）
  // ---------------------------------------------------------------------------
  // 图标缓存清理：只保留仍被快捷方式/文件分组引用的图标（数据文件里存的是 file:// URL）
  function pruneIconCache() {
    try {
      const d = loadStore();
      const used = [];
      for (const s of (d.shortcuts || [])) if (s && s.icon) used.push(s.icon);
      for (const g of (d.groups || [])) {
        for (const it of ((g && g.items) || [])) if (it && it.icon) used.push(it.icon);
      }
      const r = iconCache.prune(used);
      if (r && r.removed) {
        try { console.log('[icon] 已清理未引用图标 ' + r.removed + ' 个'); } catch (e) { /* ignore */ }
      }
      return r;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // 渲染层启动看门狗：界面没起来时弹原生对话框 + 写启动日志
  // （详见 lib/renderer-watchdog.js；用于把「白屏」变成可读的失败原因）
  // ---------------------------------------------------------------------------
  const watchdog = createRendererWatchdog({
    logPath: path.join(app.getPath('userData'), 'startup.log'),
    appVersion: app.getVersion(),
    appPath: __dirname,
    log: (msg) => { try { console.log('[watchdog] ' + msg); } catch (e) { /* ignore */ } },
    showDialog: (title, detail) => {
      try { dialog.showErrorBox(title, detail); } catch (e) { /* ignore */ }
    }
  });

  // 启动装载：主文件损坏/缺失时由 store 从最近备份自愈，并通知用户
  function loadStoreWithRecovery() {
    store.load();
    const diag = store.diagnostics();
    if (diag.recoveredFrom) {
      try {
        if (Notification.isSupported()) {
          new Notification({ title: '数据已恢复', body: '检测到主数据文件损坏或缺失，已自动从最近备份「' + diag.recoveredFrom + '」恢复。' }).show();
        }
      } catch (e) { /* ignore */ }
    }
    if (diag.migrated && diag.migrated.steps && diag.migrated.steps.length) {
      try { console.log('[store] 迁移明细：' + diag.migrated.steps.join('；')); } catch (e) { /* ignore */ }
    }
    return diag;
  }

  // 权威副本（内存缓存引用）：调用方就地修改后需 saveStore() 落盘
  function loadStore() { return store.read(); }

  // 落盘当前权威副本（兼容历史写法：saveStore(loadStore())）
  function saveStore(data) { return store.adopt(data); }

  // ---------------------------------------------------------------------------
  // 安全校验：只接受来自本应用 renderer 目录下顶层页面的 IPC 请求
  // （旧实现只判断 file:// 前缀，等于信任本机任意本地页面；实现见 lib/security.js）
  // ---------------------------------------------------------------------------
  const isTrustedSender = createTrustedSenderChecker({ rendererDir: path.join(__dirname, 'renderer') });

  // ---------------------------------------------------------------------------
  // 窗口相关
  // ---------------------------------------------------------------------------
  function applyMode(mode) {
    try {
      if (mode === 'top') {
        win.setAlwaysOnTop(true, 'floating');
      } else {
        win.setAlwaysOnTop(false);
      }
    } catch (e) {
      /* ignore */
    }
  }

  function showWin() {
    if (!win) return;
    // 覆盖桌面模式下，显示前重新校正到工作区，避免分辨率/缩放变化后位置漂移
    if (currentLayout() !== 'window') {
      try {
        const wa = screen.getPrimaryDisplay().workArea;
        win.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
      } catch (e) { /* ignore */ }
    }
    win.show();
    win.focus();
  }

  function hideWin() {
    if (!win) return;
    win.hide();
  }

  function toggleWin() {
    if (!win) return;
    if (win.isVisible()) {
      win.hide();
    } else {
      win.show();
      win.focus();
    }
  }

  function currentLayout() {
    return loadStore().settings.layout === 'window' ? 'window' : 'overlay';
  }

  function saveWinBounds() {
    if (!win || currentLayout() !== 'window') return;
    clearTimeout(winBoundsTimer);
    winBoundsTimer = setTimeout(() => {
      try {
        if (win.isDestroyed() || win.isMaximized() || win.isMinimized()) return;
        const b = win.getBounds();
        const d = loadStore();
        const cur = d.settings.winBounds;
        // 位置没变就不落盘：拖动/缩放会频繁触发这里，写合并也架不住每次都推修订号
        if (cur && cur.x === b.x && cur.y === b.y && cur.width === b.width && cur.height === b.height) return;
        d.settings.winBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        saveStore(d);
      } catch (e) { /* ignore */ }
    }, 400);
  }

  function applyLayout(layout) {
    if (!win) return;
    const wa = screen.getPrimaryDisplay().workArea; // 不含任务栏区域
    const isWindow = layout === 'window';
    try {
      if (isWindow) {
        // 先退出最大化，避免 restore 位置覆盖下面的 setBounds
        try { if (win.isMaximized()) win.unmaximize(); } catch (e) { /* ignore */ }
        const saved = loadStore().settings.winBounds;
        const width = Math.min(saved && saved.width ? saved.width : 1120, Math.max(760, wa.width - 40));
        const height = Math.min(saved && saved.height ? saved.height : 740, Math.max(520, wa.height - 40));
        const x = (saved && saved.x != null) ? saved.x : Math.round(wa.x + (wa.width - width) / 2);
        const y = (saved && saved.y != null) ? saved.y : Math.round(wa.y + (wa.height - height) / 2);
        win.setSkipTaskbar(false);
        applyMode(loadStore().settings.mode);
        win.setMinimumSize(760, 520);
        win.setResizable(true);
        win.setMovable(true);
        win.setMinimizable(true);
        win.setMaximizable(true);
        win.setBounds({ x, y, width, height });
      } else {
        // 覆盖桌面：先取消最大化再铺满整个工作区，并用一帧兜底防止 restore 动画覆盖
        try { if (win.isMaximized()) win.unmaximize(); } catch (e) { /* ignore */ }
        win.setResizable(false);
        win.setMovable(false);
        win.setMinimizable(false);
        win.setMaximizable(false);
        win.setSkipTaskbar(true);
        const target = { x: wa.x, y: wa.y, width: wa.width, height: wa.height };
        win.setBounds(target);
        setImmediate(() => {
          try {
            if (!win.isDestroyed() && currentLayout() !== 'window') win.setBounds(target);
          } catch (e) { /* ignore */ }
        });
        applyMode(loadStore().settings.mode);
      }
    } catch (e) {
      /* ignore */
    }
    // 毛玻璃材质跟随布局与设置
    applyGlass(!!loadStore().settings.glass);
  }

  function setLayout(layout) {
    layout = layout === 'window' ? 'window' : 'overlay';
    const d = loadStore();
    d.settings.layout = layout;
    saveStore(d);
    applyLayout(layout);
    sendToRenderer('win:layout', { layout });
    return layout;
  }

  function createWindow() {
    const wa = screen.getPrimaryDisplay().workArea; // 不含任务栏区域
    const theme = (loadStore().settings || {}).theme || 'light';
    const dark = theme === 'dark' || (theme === 'auto' && nativeTheme.shouldUseDarkColors);
    win = new BrowserWindow({
      x: wa.x,
      y: wa.y,
      width: wa.width,
      height: wa.height,
      frame: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      show: false,
      backgroundColor: dark ? '#17181c' : '#f4f5f7',
      hasShadow: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        devTools: !app.isPackaged
      }
    });

    win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

    // 阻止新窗口与跳转到非本地内容
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('file://')) e.preventDefault();
    });

    watchdog.attach(win);
    win.once('ready-to-show', () => {
      applyLayout(currentLayout());
      showWin();
    });

    win.on('move', saveWinBounds);
    win.on('resize', saveWinBounds);
    win.on('maximize', () => sendToRenderer('win:maximized', { maximized: true }));
    win.on('unmaximize', () => sendToRenderer('win:maximized', { maximized: false }));

    // 关闭时最小化到托盘，而不是退出
    win.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault();
        hideWin();
      }
    });

    win.on('show', () => {
      sendToRenderer('win:visibility', { visible: true });
    });
    win.on('hide', () => {
      sendToRenderer('win:visibility', { visible: false });
    });

    applyMode(loadStore().settings.mode);
  }

  function sendToRenderer(channel, payload) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }  }

  function buildTray() {
    const icon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
    tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon.resize({ width: 16, height: 16 }));
    tray.setToolTip('桌面工作台');
    rebuildTrayMenu();
    tray.on('double-click', toggleWin);
  }

  function rebuildTrayMenu() {
    const st = loadStore().settings;
    const menu = Menu.buildFromTemplate([
      { label: '显示 / 隐藏工作台　' + HOTKEY_LABEL, click: toggleWin },
      { label: '剪贴板历史　' + HOTKEY_CLIP_LABEL, click: toggleClipboard },
      { type: 'separator' },
      { label: '置顶显示', type: 'checkbox', checked: st.mode === 'top', click: (i) => setMode(i.checked ? 'top' : 'normal') },
      { type: 'separator' },
      { label: '开机自启', type: 'checkbox', checked: !!st.autostart, click: (i) => setAutostart(i.checked) },
      { type: 'separator' },
      { label: '退出', click: () => { isQuitting = true; app.quit(); } }
    ]);
    tray.setContextMenu(menu);
  }

  function setMode(mode) {
    mode = mode === 'top' ? 'top' : 'normal';
    const d = loadStore();
    d.settings.mode = mode;
    saveStore(d);
    applyMode(mode);
    rebuildTrayMenu();
    sendToRenderer('win:mode', { mode });
    return mode;
  }

  function setAutostart(enable) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!enable, path: process.execPath });
    } catch (e) {
      /* ignore */
    }
    const d = loadStore();
    d.settings.autostart = !!enable;
    saveStore(d);
    rebuildTrayMenu();
    return !!enable;
  }

  // 全局快捷键注册状态：注册失败（被别的程序占用）过去是完全静默的，
  // 用户只会觉得「快捷键没反应」。这里记录实际结果并暴露到诊断页。
  const hotkeyState = {};   // accel → { label, ok, feature }
  function recordHotkey(accel, label, feature) {
    let ok = false;
    try { ok = globalShortcut.isRegistered(accel); } catch (e) { ok = false; }
    hotkeyState[accel] = { label: label, ok: ok, feature: feature };
    if (!ok) {
      try { console.log('[hotkey] 注册失败（可能被其他程序占用）：' + label); } catch (e) { /* ignore */ }
    }
    return ok;
  }
  function hotkeyStatus() {
    return Object.keys(hotkeyState).map(k => ({
      accel: k, label: hotkeyState[k].label, ok: hotkeyState[k].ok, feature: hotkeyState[k].feature
    }));
  }

  function registerHotkey() {
    // 显示/隐藏与快速添加：跨平台可用
    try { globalShortcut.register(HOTKEY, toggleWin); } catch (e) { /* ignore */ }
    recordHotkey(HOTKEY, HOTKEY_LABEL, '显示/隐藏工作台');
    try { globalShortcut.register(HOTKEY_ADD, toggleQuickAdd); } catch (e) { /* ignore */ }
    recordHotkey(HOTKEY_ADD, HOTKEY_ADD_LABEL, '全局快速添加');

    // 截图取字依赖 desktopCapturer + 覆盖层布局，仅 Windows 提供；
    // 非 Windows 平台不注册，避免「按了没反应」
    if (process.platform === 'win32') {
      try { globalShortcut.register(HOTKEY_SHOT, startScreenshot); } catch (e) { /* ignore */ }
      recordHotkey(HOTKEY_SHOT, HOTKEY_SHOT_LABEL, '截图 OCR 取字');
    }
  }

  // 数据变化广播：携带修订号与来源，渲染层据此决定是否回灌
  // origin='renderer' 表示渲染层自己刚提交的补丁，无需再回灌（避免重绘打断输入）
  function broadcastChanged(info) {    try {
      const payload = {
        rev: (info && info.rev) || store.getRev(),
        origin: (info && info.origin) || 'main'
      };
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w || w.isDestroyed()) continue;
        w.webContents.send('data:changed', payload);
      }
    } catch (e) { /* ignore */ }
  }

  // 运行环境诊断（设置页展示；也是出问题时的唯一排查入口）
  function appDiagnostics() {
    return {
      version: app.getVersion(),
      platform: process.platform,
      userData: app.getPath('userData'),
      hotkey: HOTKEY_LABEL,
      powershell: ps.diagnostics(),
      store: store.diagnostics(),
      usage: {
        enabled: usageTrackingEnabled(),
        sampling: !!usageHelper,
        paused: usagePaused
      },
      clipboard: {
        historyEnabled: (loadStore().settings || {}).clipboardHistory !== false,
        items: (clipData.items || []).length
      },
      hotkeys: hotkeyStatus(),
      icons: (function () { try { return iconCache.stats(); } catch (e) { return { files: 0, bytes: 0 }; } })(),
      // 最近一次被拒绝的 IPC 来源：过去这类拒绝是完全静默的，
      // 一旦校验过严（曾导致界面全空白）根本无从排查
      ipc: (function () {
        try { return { lastRejection: typeof isTrustedSender.lastRejection === 'function' ? isTrustedSender.lastRejection() : null }; } catch (e) { return { lastRejection: null }; }
      })()
    };
  }

  function sendDiagnostics() {
    try {
      const payload = appDiagnostics();
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w || w.isDestroyed()) continue;
        w.webContents.send('app:diagnostics', payload);
      }
    } catch (e) { /* 界面还没起来时忽略 */ }
  }

  // 毛玻璃背景（Windows 11 原生亚克力）。仅在覆盖桌面模式生效。
  function applyGlass(on) {
    try {
      if (!win || win.isDestroyed()) return;
      if (typeof win.setBackgroundMaterial !== 'function') return; // 不支持的平台静默降级
      win.setBackgroundMaterial((on && currentLayout() !== 'window') ? 'acrylic' : 'none');
    } catch (e) { /* 不支持则忽略 */ }
  }

  // -----------------------------------------------------------
  // 全局快速添加：Win+Alt+T 弹出小窗，回车即生成待办
  // 文本解析在 lib/quickadd.js（纯函数，有单测）
  // -----------------------------------------------------------
  function addQuickTodo(raw) {
    try {
      const parsed = parseQuickTodo(raw);
      if (!parsed.text) return { ok: false, msg: '内容不能为空' };
      const todo = buildQuickTodo(parsed, { date: dateKeyMain() });
      const res = store.mutate(d => {
        if (!Array.isArray(d.todos)) d.todos = [];
        d.todos.unshift(todo);
      });
      if (!res.ok) return { ok: false, msg: '添加失败' };
      return { ok: true, msg: '已添加待办' };
    } catch (e) {
      return { ok: false, msg: '添加失败' };
    }
  }

  function createQuickAddWindow() {
    if (qaWin && !qaWin.isDestroyed()) return;
    const st = loadStore().settings || {};
    const dark = st.theme === 'dark' || (st.theme === 'auto' && nativeTheme.shouldUseDarkColors);
    qaWin = new BrowserWindow({
      width: 540, height: 158, frame: false, show: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, fullscreenable: false, hasShadow: true,
      backgroundColor: dark ? '#17181c' : '#f4f5f7',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        spellcheck: false, devTools: !app.isPackaged
      }
    });
    qaWin.loadFile(path.join(__dirname, 'renderer', 'quickadd.html'));
    qaWin.setMenuBarVisibility(false);
    qaWin.on('blur', () => { try { if (qaWin && !qaWin.isDestroyed()) qaWin.hide(); } catch (e) { /* ignore */ } });
    qaWin.on('show', () => {
      try { qaWin.webContents.send('qa:reset'); qaWin.focus(); } catch (e) { /* ignore */ }
    });
    qaWin.on('close', (e) => { if (!isQuitting) { e.preventDefault(); try { qaWin.hide(); } catch (er) { /* ignore */ } } });
  }

  function toggleQuickAdd() {
    createQuickAddWindow();
    try {
      if (qaWin.isVisible()) { qaWin.hide(); return; }
      const wa = screen.getPrimaryDisplay().workArea;
      qaWin.setPosition(wa.x + Math.round((wa.width - qaWin.getBounds().width) / 2), wa.y + 40);
      qaWin.show();
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------
  // 剪贴板历史：轮询采集 文本 / 图片 / 文件，Win+Alt+V 唤出弹窗
  // 数据独立存放在 clipboard-history.json，不与主数据混存
  // -----------------------------------------------------------
  const CLIP_MAX = 200;                 // 未置顶保留条数
  const CLIP_TEXT_MAX = 100000;         // 单条文本最大字符数
  const CLIP_PIXELS_MAX = 40e6;         // 单张图片最大像素数（超大量跳过）
  const clipStorePath = () => path.join(app.getPath('userData'), 'clipboard-history.json');
  const clipDir = () => path.join(app.getPath('userData'), 'clipboard');
  let clipData = { items: [] };
  let clipLoaded = false;
  let suppressClipUntil = 0;            // 写回剪贴板后短暂抑制采集，避免把自己复制的再次记录
  let lastClip = { filesKey: '', thumb: '', text: '' };
  let clipHotkeyOn = false;
  let cbWin = null;                     // 剪贴板历史弹窗

  function clipUid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }

  // 剪贴板敏感内容过滤是否开启（默认开启；设置页可关闭）
  function clipSensitiveEnabled() {
    try { return (loadStore().settings || {}).clipboardSensitive !== false; } catch (e) { return true; }
  }

  function loadClipData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(clipStorePath(), 'utf8'));
      clipData = parsed && Array.isArray(parsed.items) ? parsed : { items: [] };
    } catch (e) {
      clipData = { items: [] };
    }
    clipLoaded = true;
  }

  function saveClipData() {
    try {
      fs.mkdirSync(path.dirname(clipStorePath()), { recursive: true });
      const tmp = clipStorePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(clipData));
      fs.renameSync(tmp, clipStorePath());
    } catch (e) { /* ignore */ }
  }

  function deleteClipImage(it) {
    if (it && it.imagePath) { try { fs.unlinkSync(it.imagePath); } catch (e) { /* ignore */ } }
  }

  function sortClipItems() {
    clipData.items.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.time - a.time);
  }

  function pruneClip() {
    const unpinned = clipData.items.filter(x => !x.pinned).sort((a, b) => a.time - b.time);
    if (unpinned.length <= CLIP_MAX) return;
    const drop = new Set(unpinned.slice(0, unpinned.length - CLIP_MAX).map(x => x.id));
    clipData.items = clipData.items.filter(x => {
      if (!drop.has(x.id)) return true;
      deleteClipImage(x);
      return false;
    });
  }

  function notifyClipChanged() {
    try {
      if (cbWin && !cbWin.isDestroyed() && cbWin.isVisible()) cbWin.webContents.send('clip:updated');
    } catch (e) { /* ignore */ }
  }

  // 读取 Windows 资源管理器复制的文件（CF_HDROP）。Electron 暴露的 FileNameW
  // 缓冲区没有 DROPFILES 头，直接是 UTF-16LE、\0 分隔的文件名（通常仅第一个文件），
  // 完整列表由 enrichClipFiles 经 PowerShell FileDropList 异步补全。
  function readClipFiles() {
    try {
      if (!clipboard.has('FileNameW')) return [];
      const buf = clipboard.readBuffer('FileNameW');
      if (!buf || !buf.length) return [];
      return buf.toString('utf16le').split('\0').filter(Boolean);
    } catch (e) {
      return [];
    }
  }

  // Electron 只暴露 CF_HDROP 的第一个文件（FileNameW）；完整列表经 PowerShell FileDropList 异步补全
  function enrichClipFiles(item) {
    if (!ps.isAvailable()) { ps.noteFeature('clipboard-file-list', false, 'PowerShell 不可用，只能记录第一个文件'); return; }
    try {
      const script = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-Clipboard -Format FileDropList) -join "|"';
      ps.run(ps.scriptArgs(script), { timeout: 6000 }).then((r) => {
        try {
          if (!r.ok) { ps.noteFeature('clipboard-file-list', false, r.error || 'Get-Clipboard 调用失败'); return; }
          ps.noteFeature('clipboard-file-list', true);
          const stdout = lastMeaningfulLine(r.stdout);   // 容忍 PowerShell 混入的警告行
          if (!stdout) return;
          const list = String(stdout).split('|').map(s => s.trim()).filter(Boolean);
          if (!list.length || !item.files || String(item.files[0]).toLowerCase() !== String(list[0]).toLowerCase()) return;
          // 剪贴板已变成别的内容时放弃补全
          const cur = readClipFiles();
          if (!cur.length || String(cur[0]).toLowerCase() !== String(list[0]).toLowerCase()) return;
          item.files = list;
          item.text = list.join('\n');
          item._sig = 'f:' + list.join('|').toLowerCase();
          const dup = clipData.items.find(x => x !== item && x._sig === item._sig);
          if (dup) {
            dup.time = Math.max(dup.time, item.time);
            clipData.items = clipData.items.filter(x => x !== item);
          }
          sortClipItems();
          saveClipData();
          notifyClipChanged();
        } catch (e) { /* 单条补全失败不影响其他条目 */ }
      });
    } catch (e) { /* ignore */ }
  }

  function addClipItem(o) {
    try {
      const item = { id: clipUid(), time: Date.now(), pinned: false };
      let sig = '';
      if (o.type === 'text') {
        const t = String(o.text || '');
        sig = 't:' + t;
        item.type = 'text';
        item.text = t;
      } else if (o.type === 'file') {
        const files = (o.files || []).map(String);
        sig = 'f:' + files.join('|').toLowerCase();
        item.type = 'file';
        item.files = files;
        item.text = files.join('\n');
      } else {
        const img = o.img;
        const size = img.getSize();
        if (size.width * size.height > CLIP_PIXELS_MAX) return;
        const png = img.toPNG();
        sig = 'i:' + crypto.createHash('sha1').update(png).digest('hex');
        fs.mkdirSync(clipDir(), { recursive: true });
        item.type = 'image';
        item.imagePath = path.join(clipDir(), item.id + '.png');
        fs.writeFileSync(item.imagePath, png);
        item.width = size.width;
        item.height = size.height;
        item.thumb = img.resize({ width: 160 }).toDataURL();
      }
      const exist = clipData.items.find(x => x._sig === sig);
      if (exist) {
        exist.time = item.time;                  // 重复复制：置顶显示，不生成新条目
        sortClipItems();
        saveClipData();
        notifyClipChanged();
        return exist;
      }
      item._sig = sig;
      clipData.items.unshift(item);
      pruneClip();
      sortClipItems();
      saveClipData();
      notifyClipChanged();
      return item;
    } catch (e) { /* ignore */ }
    return null;
  }

  function reconcileClipboardHotkey(enabled) {
    if (enabled === clipHotkeyOn) return;
    try {
      if (enabled) {
        globalShortcut.register(HOTKEY_CLIP, toggleClipboard);
        clipHotkeyOn = globalShortcut.isRegistered(HOTKEY_CLIP);
        recordHotkey(HOTKEY_CLIP, HOTKEY_CLIP_LABEL, '剪贴板历史');
      } else {
        globalShortcut.unregister(HOTKEY_CLIP);
        clipHotkeyOn = false;
        delete hotkeyState[HOTKEY_CLIP];
      }
    } catch (e) {
      clipHotkeyOn = false;
    }
    sendDiagnostics();
  }

  // 每次轮询：读取当前剪贴板并和上次签名比较，变化才入库
  function captureClipboard() {
    if (isQuitting) return;
    let enabled = true;
    try { enabled = (loadStore().settings || {}).clipboardHistory !== false; } catch (e) { /* ignore */ }
    reconcileClipboardHotkey(enabled);
    if (!enabled) return;
    if (Date.now() < suppressClipUntil) return;
    try {
      let fmts = [];
      try { fmts = clipboard.availableFormats(); } catch (e) { fmts = []; }
      const files = readClipFiles();
      const filesKey = files.length ? files.join('|').toLowerCase() : '';
      let text = '';
      let thumb = '';
      let img = null;
      if (!files.length) {
        text = clipboard.readText() || '';
        if (fmts.some(f => f.startsWith('image/'))) {
          const im = clipboard.readImage();
          if (!im.isEmpty()) {
            img = im;
            try { thumb = im.resize({ width: 48 }).toDataURL(); } catch (e) { thumb = ''; }
          }
        }
      }
      const sig = { filesKey, thumb, text };
      const changed = sig.filesKey !== lastClip.filesKey || sig.thumb !== lastClip.thumb || sig.text !== lastClip.text;
      lastClip = sig;
      if (!changed) return;
      if (files.length) {
        const it = addClipItem({ type: 'file', files });
        if (it) enrichClipFiles(it);             // 异步补全多文件列表
      }
      else if (img) addClipItem({ type: 'image', img });
      else if (text.trim() && text.length <= CLIP_TEXT_MAX) {
        // 敏感内容（JWT / 私钥 / 口令 / API Key 等）默认不写入历史，避免凭据明文落盘
        if (!clipSensitiveEnabled() || !isSensitiveText(text)) addClipItem({ type: 'text', text });
      }
    } catch (e) { /* ignore */ }
  }

  function listClip(opts) {
    if (!clipLoaded) loadClipData();
    opts = opts || {};
    const q = String(opts.query || '').trim().toLowerCase();
    const type = String(opts.type || 'all');
    return clipData.items.filter(it => {
      if (type !== 'all' && it.type !== type) return false;
      if (!q) return true;
      return (it.text || '').toLowerCase().indexOf(q) !== -1
        || (it.ocrText || '').toLowerCase().indexOf(q) !== -1
        || (it.files || []).join('\n').toLowerCase().indexOf(q) !== -1;
    }).map(it => ({
      id: it.id, type: it.type, text: it.text, files: it.files,
      width: it.width, height: it.height, thumb: it.thumb, imagePath: it.imagePath,
      ocrText: it.ocrText, pinned: !!it.pinned, time: it.time
    }));
  }

  function findClipItem(id) {
    if (!clipLoaded) loadClipData();
    return clipData.items.find(x => x.id === id) || null;
  }

  // 把文件选区写回剪贴板（CF_HDROP）。PowerShell 不可用时显式记录降级原因。
  function copyFilesViaPowerShell(script) {
    if (!ps.isAvailable()) {
      ps.noteFeature('clipboard-file-writeback', false, 'PowerShell 不可用，无法把文件写回剪贴板');
      return;
    }
    ps.run(ps.scriptArgs(script), { timeout: 8000 }).then((r) => {
      ps.noteFeature('clipboard-file-writeback', r.ok, r.error || 'Set-Clipboard 调用失败');
    });
  }

  function copyClipItem(id) {
    const it = findClipItem(id);
    if (!it) return { ok: false, msg: '条目不存在' };
    try {
      suppressClipUntil = Date.now() + 1500;
      if (it.type === 'text') {
        clipboard.writeText(String(it.text || ''));
      } else if (it.type === 'image') {
        clipboard.writeImage(nativeImage.createFromPath(it.imagePath));
      } else if (it.type === 'file' && Array.isArray(it.files) && it.files.length) {
        // Electron 无法直接写文件选区，借 PowerShell Set-Clipboard 恢复 CF_HDROP
        const list = it.files.map(f => "'" + String(f).replace(/'/g, "''") + "'").join(',');
        copyFilesViaPowerShell('Set-Clipboard -Path ' + list);
      }
      it.time = Date.now();
      sortClipItems();
      saveClipData();
      notifyClipChanged();
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String((e && e.message) || e) };
    }
  }

  function pinClipItem(id) {
    const it = findClipItem(id);
    if (!it) return { ok: false };
    it.pinned = !it.pinned;
    sortClipItems();
    saveClipData();
    notifyClipChanged();
    return { ok: true, pinned: it.pinned };
  }

  function deleteClipItem(id) {
    if (!clipLoaded) loadClipData();
    const it = findClipItem(id);
    if (!it) return { ok: false };
    deleteClipImage(it);
    clipData.items = clipData.items.filter(x => x.id !== id);
    saveClipData();
    notifyClipChanged();
    return { ok: true };
  }

  function clearUnpinnedClips() {
    if (!clipLoaded) loadClipData();
    clipData.items.forEach(x => { if (!x.pinned) deleteClipImage(x); });
    clipData.items = clipData.items.filter(x => x.pinned);
    saveClipData();
    notifyClipChanged();
    return { ok: true };
  }

  function createClipboardWindow() {
    if (cbWin && !cbWin.isDestroyed()) return;
    const st = loadStore().settings || {};
    const dark = st.theme === 'dark' || (st.theme === 'auto' && nativeTheme.shouldUseDarkColors);
    cbWin = new BrowserWindow({
      width: 640, height: 560, frame: false, show: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true, minimizable: false, maximizable: false,
      fullscreenable: false, hasShadow: true,
      backgroundColor: dark ? '#17181c' : '#f4f5f7',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        spellcheck: false, devTools: !app.isPackaged
      }
    });
    cbWin.loadFile(path.join(__dirname, 'renderer', 'clipboard.html'));
    cbWin.setMenuBarVisibility(false);
    cbWin.on('blur', () => { try { if (cbWin && !cbWin.isDestroyed()) cbWin.hide(); } catch (e) { /* ignore */ } });
    cbWin.on('show', () => {
      try { cbWin.webContents.send('clip:reset'); cbWin.focus(); } catch (e) { /* ignore */ }
    });
    cbWin.on('close', (e) => { if (!isQuitting) { e.preventDefault(); try { cbWin.hide(); } catch (er) { /* ignore */ } } });
  }

  function toggleClipboard() {
    createClipboardWindow();
    try {
      if (cbWin.isVisible()) { cbWin.hide(); return; }
      const wa = screen.getPrimaryDisplay().workArea;
      const b = cbWin.getBounds();
      cbWin.setPosition(wa.x + Math.round((wa.width - b.width) / 2), wa.y + Math.round(wa.height * 0.16));
      cbWin.show();
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------
  // 图片 OCR 提字：tesseract.js + 内置 chi_sim / eng 离线模型
  // -----------------------------------------------------------
  let ocrWorkerPromise = null;
  let ocrChain = Promise.resolve();

  // 打包后运行在 app.asar 内，worker/wasm/语言模型必须用 asarUnpack 后的真实路径
  function unpackedBase() {
    return __dirname.indexOf('app.asar') !== -1 ? __dirname.split('app.asar').join('app.asar.unpacked') : __dirname;
  }

  function getOcrWorker() {
    if (!ocrWorkerPromise) {
      ocrWorkerPromise = (async () => {
        const { createWorker } = require('tesseract.js');
        const opts = { gzip: false, cacheMethod: 'none', logger: () => { } };
        const base = unpackedBase();
        opts.langPath = path.join(base, 'ocr-data');
        if (base !== __dirname) { // 打包环境：worker 脚本与 wasm 核心也指向解包目录
          opts.workerPath = path.join(base, 'node_modules', 'tesseract.js', 'src', 'worker-script', 'node', 'index.js');
          opts.corePath = path.join(base, 'node_modules', 'tesseract.js-core');
        }
        return createWorker('chi_sim+eng', 1, opts);
      })();
      ocrWorkerPromise.catch(() => { ocrWorkerPromise = null; });
    }
    return ocrWorkerPromise;
  }

  function runOcr(id) {
    const it = findClipItem(id);
    if (!it || it.type !== 'image' || !it.imagePath) return Promise.resolve({ ok: false, msg: '没有可识别的图片' });
    if (!fs.existsSync(it.imagePath)) return Promise.resolve({ ok: false, msg: '图片文件已被清理' });
    const job = async () => {
      const worker = await getOcrWorker();
      const { data } = await worker.recognize(it.imagePath);
      it.ocrText = String((data && data.text) || '').trim();
      it.ocrAt = Date.now();
      saveClipData();
      notifyClipChanged();
      return { ok: true, text: it.ocrText };
    };
    const p = ocrChain.then(job, job);
    ocrChain = p.then(() => { }, () => { });
    return p;
  }

  // -----------------------------------------------------------
  // 自动时间统计（仅 Windows）：常驻 PowerShell 辅助进程每 5 秒采样
  // 前台窗口，主进程按采样间隔把真实时长归因到前一台应用。
  // 数据独立存放 usage-data.json，由主进程独占读写，不进主数据。
  // -----------------------------------------------------------
  const USAGE_SAMPLE_MS = 5000;
  const USAGE_FLUSH_MS = 30000;
  const USAGE_KEEP_DAYS = 90;
  const usageStorePath = () => path.join(app.getPath('userData'), 'usage-data.json');
  let usageData = { days: {} };
  let usageLoaded = false;
  let usageTimer = null;
  let usageFlushTimer = null;
  let usageHelper = null;         // PowerShell 辅助子进程
  let usageHelperBuf = '';        // stdout 行缓冲
  let usageHelperLastOut = 0;     // 看门狗：最后收到输出的时间
  let usageHelperStartedAt = 0;   // 看门狗宽限：刚启动时给足 Add-Type 编译时间
  let usageLatest = null;         // 辅助进程最新一次前台采样 { exe, app, title }
  let usageCurrent = null;        // 当前归因对象（上一次 tick 时的前台采样）
  let usageLastTick = 0;
  let usagePaused = false;        // 锁屏期间暂停

  // 读取并规范化时间统计设置（老数据缺省时回退默认值；纯逻辑在 lib/usage.js）
  function ttSettings() {
    const d = loadStore();
    return usageDomain.normalizeTrackSettings(d.settings && d.settings.timeTrack, TIME_TRACK_DEFAULTS);
  }

  function loadUsageData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(usageStorePath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        usageData = { days: parsed.days };
      } else {
        usageData = { days: {} };
      }
    } catch (e) {
      usageData = { days: {} };
    }
    usageLoaded = true;
  }

  function saveUsageData() {
    try {
      // 清理 90 天前的数据
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - USAGE_KEEP_DAYS);
      const cutKey = dateKeyMain(cutoff);
      for (const k of Object.keys(usageData.days)) {
        if (k < cutKey) delete usageData.days[k];
      }
      fs.mkdirSync(path.dirname(usageStorePath()), { recursive: true });
      const tmp = usageStorePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(usageData), 'utf8');
      fs.renameSync(tmp, usageStorePath());
    } catch (e) { /* ignore */ }
  }

  function getUsageDay(dk) { return usageDomain.ensureDay(usageData, dk); }

  // 分类：本应用自身 → 「桌面工作台」；否则按规则顺序匹配（实现见 lib/usage.js）。
  // 分类在汇总时计算，规则修改后对历史数据即时生效。
  function usageCategoryOf(exeKey, displayName) {
    return usageDomain.categoryOf(exeKey, displayName, ttSettings().rules);
  }

  function addUsageSeconds(sample, seconds) {
    try {
      // 长尾合并等细节在 lib/usage.js；标题是否落盘由设置决定
      usageDomain.addSeconds(usageData, dateKeyMain(), sample, seconds, ttSettings().recordTitles);
    } catch (e) { /* ignore */ }
  }

  function startUsageHelper() {
    if (process.platform !== 'win32' || usageHelper) return;
    // PowerShell 不可用（被策略禁用/未探测完成）时显式降级，并把原因暴露给界面，
    // 而不是让采样进程反复拉起失败、用户只看到「没有数据」。
    if (!ps.isAvailable()) {
      ps.noteFeature('usage-helper', false, ps.isChecked()
        ? 'PowerShell 不可用（' + (ps.diagnostics().reason || '未知原因') + '），时间统计无法采样'
        : '正在检测 PowerShell 环境…');
      return;
    }
    if (!ps.diagnostics().canAddType) {
      ps.noteFeature('usage-helper', false, '当前 PowerShell 语言模式为 ' + ps.diagnostics().languageMode + '，不允许 Add-Type，无法读取前台窗口');
      return;
    }
    try {
      usageHelperBuf = '';
      // 说明：实测 -Command -（stdin 传脚本）对本脚本会静默卡住，故改用 -EncodedCommand
      // （UTF-16LE base64，脚本约 2KB，远小于命令行长度限制），效果等同且无临时文件
      usageHelper = ps.spawn(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(usageDomain.USAGE_PS_SCRIPT, 'utf16le').toString('base64')]);
      if (!usageHelper) return;
      usageHelperLastOut = Date.now();
      usageHelperStartedAt = Date.now();
      usageHelper.stdout.on('data', (chunk) => {
        usageHelperLastOut = Date.now();
        usageHelperBuf += chunk.toString('utf8');
        let idx;
        while ((idx = usageHelperBuf.indexOf('\n')) !== -1) {
          const line = usageHelperBuf.slice(0, idx).trim();
          usageHelperBuf = usageHelperBuf.slice(idx + 1);
          if (!line) continue;
          try {
            const o = JSON.parse(line);
            if (o && typeof o.exe === 'string') {
              usageLatest = {
                exe: String(o.exe || ''),
                app: String(o.app || '') || String(o.exe || ''),
                title: String(o.title || '')
              };
              ps.noteFeature('usage-helper', true);
            }
          } catch (e) { /* 忽略无法解析的行 */ }
        }
      });
      usageHelper.stderr.on('data', () => { /* 忽略 */ });
      usageHelper.on('error', (err) => {
        ps.noteFeature('usage-helper', false, '采样进程启动失败：' + String((err && err.message) || err));
      });
      usageHelper.on('exit', () => {
        usageHelper = null;
        // 异常退出（含被看门狗击杀）后由 reconcileUsage 自动拉起
        if (usageTrackingEnabled()) setTimeout(() => { try { reconcileUsage(); } catch (e) { /* ignore */ } }, 1000);
      });
    } catch (e) {
      usageHelper = null;
      ps.noteFeature('usage-helper', false, String((e && e.message) || e));
    }
  }

  function usageTrackingEnabled() {
    return process.platform === 'win32' && ttSettings().enabled;
  }

  // 按开关启停采集与落盘定时器；每次 tick 与设置保存后都会调用，保证自愈
  function reconcileUsage() {
    if (!usageLoaded) loadUsageData();
    if (usageTrackingEnabled()) {
      if (!usageTimer) {
        usageLastTick = Date.now();
        usageTimer = setInterval(usageTick, USAGE_SAMPLE_MS);
      }
      if (!usageFlushTimer) usageFlushTimer = setInterval(saveUsageData, USAGE_FLUSH_MS);
      if (!usageHelper) startUsageHelper();
    } else {
      if (usageTimer || usageFlushTimer) saveUsageData(); // 停止前把内存里的增量落盘
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
      if (usageFlushTimer) { clearInterval(usageFlushTimer); usageFlushTimer = null; }
      if (usageHelper) { try { usageHelper.kill(); } catch (e) { /* ignore */ } usageHelper = null; }
      usageLatest = null;
      usageCurrent = null;
    }
  }

  function usageTick() {
    try {
      const now = Date.now();
      const cfg = ttSettings();
      // 看门狗：辅助进程未启动则拉起；运行中 10 秒无输出则重启（启动后 15 秒宽限，等 Add-Type 编译）
      if (cfg.enabled && process.platform === 'win32') {
        if (!usageHelper) startUsageHelper();
        else if (now - usageHelperStartedAt > 15000 && now - usageHelperLastOut > 10000) {
          try { usageHelper.kill(); } catch (e) { /* ignore */ }
          usageHelper = null;
          startUsageHelper();
        }
      }
      if (!cfg.enabled || usagePaused) {
        usageLastTick = now;
        usageCurrent = null;
        return;
      }
      let idleSec = 0;
      try { idleSec = powerMonitor.getSystemIdleTime(); } catch (e) { idleSec = 0; }
      const gap = usageLastTick ? Math.max(0, now - usageLastTick) : 0;
      if (idleSec >= cfg.idleSeconds) {
        // 空闲期间不累计；把归因对象推进到当前前台，避免唤醒后错记
        usageLastTick = now;
        usageCurrent = usageLatest;
        return;
      }
      // 两条采样之间的真实间隔计给前一台应用；单次上限 2×采样间隔（防休眠后错记）
      if (usageCurrent && gap >= 1000 && gap <= 2 * USAGE_SAMPLE_MS) {
        addUsageSeconds(usageCurrent, Math.round(gap / 1000));
      }
      usageCurrent = usageLatest;
      usageLastTick = now;
    } catch (e) { /* ignore */ }
  }

  function emptyUsageSummary() {
    return usageDomain.emptySummary(process.platform === 'win32');
  }

  function usageSummary(days) {
    if (!usageLoaded) loadUsageData();
    const cfg = ttSettings();
    if (process.platform !== 'win32') {
      const out = usageDomain.emptySummary(false);
      out.enabled = cfg.enabled;
      return out;
    }
    const today = dateKeyMain();

    // 近 days 天（含今天）逐日聚合
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayKeys.push(dateKeyMain(d));
    }

    let pomoDone = {};
    try { pomoDone = loadStore().pomoDone || {}; } catch (e) { pomoDone = {}; }

    // 聚合逻辑在 lib/usage.js（纯函数，有单测）
    return usageDomain.summarize(usageData, {
      dayKeys: dayKeys,
      today: today,
      enabled: cfg.enabled,
      recordTitles: cfg.recordTitles,
      pomoDone: pomoDone,
      categoryOf: usageCategoryOf
    });
  }

  // -----------------------------------------------------------
  // 截图 OCR 取字（Win+Alt+S）：全屏覆盖层框选 → 裁剪 → OCR → 自动复制
  // 覆盖层单窗口双状态：select（框选）/ result（识别结果）
  // -----------------------------------------------------------
  let shotWin = null;
  let shotMode = 'idle';       // idle | select | result
  let shotLastText = '';
  let shotBgDataUrl = null;
  let shotLoaded = false;      // 覆盖层页面是否已加载（窗口复用时需直接下发新截图）

  function createShotWindow() {
    if (shotWin && !shotWin.isDestroyed()) return;
    shotWin = new BrowserWindow({
      show: false, frame: false, transparent: true, hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        spellcheck: false, devTools: !app.isPackaged
      }
    });
    shotWin.setMenuBarVisibility(false);
    shotWin.loadFile(path.join(__dirname, 'renderer', 'shot.html'));
    shotLoaded = false;
    shotWin.on('blur', () => { try { if (shotMode === 'select') cancelShot(); } catch (e) { /* ignore */ } });
    shotWin.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault();
        try { shotWin.hide(); } catch (er) { /* ignore */ }
        shotMode = 'idle';
      }
    });
  }

  function sendToShot(channel, payload) {
    try { if (shotWin && !shotWin.isDestroyed()) shotWin.webContents.send(channel, payload); } catch (e) { /* ignore */ }
  }

  function cancelShot() {
    shotMode = 'idle';
    try { if (shotWin && !shotWin.isDestroyed()) shotWin.hide(); } catch (e) { /* ignore */ }
  }

  async function captureScreenForShot() {
    const display = screen.getPrimaryDisplay();
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(display.size.width * display.scaleFactor),
        height: Math.round(display.size.height * display.scaleFactor)
      }
    });
    const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
    if (!src || src.thumbnail.isEmpty()) return null;
    return src.thumbnail.toDataURL();
  }

  async function startScreenshot() {
    if (process.platform !== 'win32') return;
    try {
      if (shotWin && !shotWin.isDestroyed() && shotWin.isVisible()) { cancelShot(); return; }
      const bg = await captureScreenForShot();
      if (!bg) return;
      shotBgDataUrl = bg;
      createShotWindow();
      const wa = screen.getPrimaryDisplay().workArea;
      shotWin.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
      shotMode = 'select';
      shotWin.show();
      shotWin.focus();
      // 窗口复用（页面已加载）时 ready 不会再次触发，需直接下发新截图
      if (shotLoaded) sendToShot('shot:init', { dataUrl: shotBgDataUrl });
    } catch (e) { /* ignore */ }
  }

  function showShotResult(text) {
    try {
      if (!shotWin || shotWin.isDestroyed()) return;
      shotMode = 'result';
      shotLastText = text || '';
      const wa = screen.getPrimaryDisplay().workArea;
      const w = Math.min(480, wa.width - 40), h = Math.min(360, wa.height - 40);
      shotWin.setBounds({ x: wa.x + wa.width - w - 24, y: wa.y + 24, width: w, height: h });
      sendToShot('shot:result', { text: shotLastText });
      shotWin.show();
      shotWin.focus();
    } catch (e) { /* ignore */ }
  }

  ipcMain.handle('shot:start', (event) => { if (!isTrustedSender(event)) return false; startScreenshot(); return true; });
  ipcMain.handle('shot:ready', (event) => {
    if (!isTrustedSender(event)) return false;
    shotLoaded = true;
    sendToShot('shot:init', { dataUrl: shotBgDataUrl });
    return true;
  });
  ipcMain.handle('shot:submitCrop', async (event, dataUrl) => {
    if (!isTrustedSender(event)) return { ok: false };
    cancelShot();
    try {
      const b64 = String(dataUrl || '').split(',')[1] || '';
      // 边界限制：超大选区（例如整屏 4K 高 DPI）会让 base64 与解码缓冲把内存顶上去，
      // 这里给出明确上限并直接放弃，而不是让 OCR 卡死进程
      if (!b64 || b64.length > 40e6) { showShotResult(''); return { ok: false }; }
      const buf = Buffer.from(b64, 'base64');
      if (!buf.length || buf.length > 30 * 1024 * 1024) { showShotResult(''); return { ok: false }; }
      const tmp = path.join(os.tmpdir(), 'workbench-shot-' + Date.now() + '.png');
      fs.writeFileSync(tmp, buf);
      let text = '';
      try {
        const worker = await getOcrWorker();
        const res = await worker.recognize(tmp);
        text = String((res && res.data && res.data.text) || '').trim();
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
      }
      if (text) clipboard.writeText(text); // 自动复制；剪贴板轮询会把它记入剪贴板历史
      showShotResult(text);
      return { ok: true };
    } catch (e) {
      showShotResult('');
      return { ok: false };
    }
  });
  ipcMain.handle('shot:cancel', (event) => { if (!isTrustedSender(event)) return false; cancelShot(); return true; });
  ipcMain.handle('shot:copy', (event) => { if (!isTrustedSender(event)) return false; if (shotLastText) clipboard.writeText(shotLastText); return true; });
  ipcMain.handle('shot:close', (event) => { if (!isTrustedSender(event)) return false; cancelShot(); return true; });

  // -----------------------------------------------------------
  // 桌面小组件：时钟 / 今日待办 / 便签（独立小窗口，数据只读轮询，
  // 位置存 widget-positions.json 由主进程独占写，避免与主窗口渲染层冲突）
  // -----------------------------------------------------------
  const WIDGET_DEFS = { clock: { w: 280, h: 132 }, todos: { w: 300, h: 400 }, notes: { w: 300, h: 380 } };
  const widgetWins = {};
  const widgetPosFile = () => path.join(app.getPath('userData'), 'widget-positions.json');
  let widgetPosTimer = null;

  function loadWidgetPositions() {
    try { return JSON.parse(fs.readFileSync(widgetPosFile(), 'utf8')) || {}; } catch (e) { return {}; }
  }
  function saveWidgetPositions(pos) {
    try { fs.writeFileSync(widgetPosFile(), JSON.stringify(pos), 'utf8'); } catch (e) { /* ignore */ }
  }
  function widgetSettings() {
    const d = loadStore();
    let w = d.settings && d.settings.widgets;
    if (!w || typeof w !== 'object') w = {};
    return { clock: w.clock === true, todos: w.todos === true, notes: w.notes === true };
  }

  function createWidget(name) {
    if (widgetWins[name] && !widgetWins[name].isDestroyed()) return;
    const def = WIDGET_DEFS[name];
    const pos = loadWidgetPositions()[name] || {};
    const wa = screen.getPrimaryDisplay().workArea;
    const idx = Object.keys(WIDGET_DEFS).indexOf(name);
    // 钳制到当前工作区，防止显示器变更后旧坐标落在屏幕外
    const clamp = (v, min, max) => Math.min(Math.max(Math.round(v), min), Math.max(min, max));
    const defX = wa.x + wa.width - def.w - 28 - idx * 20;
    const defY = wa.y + 48 + idx * 44;
    const x = Number.isFinite(pos.x) ? clamp(pos.x, wa.x, wa.x + wa.width - def.w) : defX;
    const y = Number.isFinite(pos.y) ? clamp(pos.y, wa.y, wa.y + wa.height - 60) : defY;
    const st = loadStore().settings || {};
    const dark = st.theme === 'dark' || (st.theme === 'auto' && nativeTheme.shouldUseDarkColors);
    const win = new BrowserWindow({
      x, y,
      width: def.w, height: def.h,
      frame: false, show: false, skipTaskbar: true, resizable: true,
      minimizable: false, maximizable: false, fullscreenable: false,
      hasShadow: true,
      backgroundColor: dark ? '#1b1d24' : '#ffffff',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        spellcheck: false, devTools: !app.isPackaged
      }
    });
    win.loadFile(path.join(__dirname, 'renderer', 'widget.html'), { query: { type: name } });
    win.setMenuBarVisibility(false);
    win.on('close', (e) => {
      if (!isQuitting) {
        e.preventDefault();
        try { win.hide(); } catch (er) { /* ignore */ }
        const d = loadStore();
        if (!d.settings.widgets || typeof d.settings.widgets !== 'object') d.settings.widgets = {};
        if (d.settings.widgets[name] !== false) {
          d.settings.widgets[name] = false;
          saveStore(d);
          broadcastChanged();
        }
      }
    });
    win.on('moved', () => {
      clearTimeout(widgetPosTimer);
      widgetPosTimer = setTimeout(() => {
        try {
          if (widgetWins[name] && !widgetWins[name].isDestroyed()) {
            const b = widgetWins[name].getBounds();
            const pos = loadWidgetPositions();
            pos[name] = { x: b.x, y: b.y };
            saveWidgetPositions(pos);
          }
        } catch (e) { /* ignore */ }
      }, 400);
    });
    widgetWins[name] = win;
    win.once('ready-to-show', () => win.show());
  }

  function reconcileWidgets() {
    const want = widgetSettings();
    for (const name of Object.keys(WIDGET_DEFS)) {
      if (want[name]) {
        if (widgetWins[name] && !widgetWins[name].isDestroyed()) widgetWins[name].show();
        else createWidget(name);
      } else if (widgetWins[name] && !widgetWins[name].isDestroyed()) {
        widgetWins[name].hide();
      }
    }
  }

  ipcMain.handle('widgets:close', (event, name) => {
    if (!isTrustedSender(event) || !WIDGET_DEFS[name]) return false;
    try { if (widgetWins[name] && !widgetWins[name].isDestroyed()) widgetWins[name].hide(); } catch (e) { /* ignore */ }
    const d = loadStore();
    if (!d.settings.widgets || typeof d.settings.widgets !== 'object') d.settings.widgets = {};
    if (d.settings.widgets[name] !== false) {
      d.settings.widgets[name] = false;
      saveStore(d);
      broadcastChanged();
    }
    return true;
  });

  ipcMain.handle('widgets:openMain', (event) => { if (!isTrustedSender(event)) return false; showWin(); return true; });

  // -----------------------------------------------------------
  // 重复待办逾期自动顺延（设置开启时）
  // -----------------------------------------------------------
  function autoAdvanceOverdue() {
    try {
      const d = loadStore();
      if (!d.settings || d.settings.autoOverdueAdvance !== true) return;
      const tk = dateKeyMain();
      const today = new Date(tk + 'T00:00:00');
      let changed = false;
      (d.todos || []).forEach(t => {
        if (t.done || !t.repeat || t.repeat === 'none' || !t.due || t.due >= tk) return;
        let next = new Date(t.due + 'T00:00:00');
        let guard = 0;
        while (next < today && guard++ < 370) {
          switch (t.repeat) {
            case 'daily': next.setDate(next.getDate() + 1); break;
            case 'weekly': next.setDate(next.getDate() + 7); break;
            case 'monthly': dateutil.advanceMonthClamped(next); break;
            case 'yearly': next.setFullYear(next.getFullYear() + 1); break;
            default: return; // 未知周期，跳过
          }
        }
        if (next < today) return; // 一年仍落后于今天，视为异常数据，不处理
        const ndk = dateKeyMain(next);
        if (ndk !== t.due) {
          if (!Array.isArray(t.doneHistory)) t.doneHistory = [];
          t.doneHistory.push({ done: tk, at: t.dueTime || '', skipped: 'auto' });
          t.due = ndk;
          changed = true;
        }
      });
      if (changed) saveStore(d);   // store 变更事件会自动广播给渲染层
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------
  // 自动文件整理规则：监控文件夹里的文件按规则移动到目标目录
  // -----------------------------------------------------------
  // 旧实现用只增不减的 Set 记住「扫描过的文件」，副作用有两个：
  //   1) 新增/修改规则后，之前扫过的文件永远不会再被整理（除非手动「立即整理」）
  //   2) 长时间运行内存只增不减
  // 现在改成「带时间窗的尝试记录」：只抑制短时间内的重复尝试（失败的文件会被重试），
  // 并且在规则/监控目录变化时立即清空，让新规则对已有文件即时生效。
  const ORGANIZE_RETRY_MS = 10 * 60 * 1000;   // 同一文件 10 分钟内不重复尝试
  const ORGANIZE_MAX_TRACKED = 5000;          // 记录上限，防内存膨胀
  const organizeAttempts = new Map();         // 绝对路径 → 上次尝试时间
  let organizeConfigSig = null;               // 规则指纹，用于侦测配置变化

  function configSignature(cfg) {
    const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).map(r => [r.type || 'ext', String(r.value || ''), String(r.to || '')].join('\u0001'));
    return String(cfg.watch || '') + '\u0002' + rules.join('\u0003');
  }

  function uniqueTargetPath(dest) {
    if (!fs.existsSync(dest)) return dest;
    const p = path.parse(dest);
    for (let i = 1; i < 999; i++) {
      const cand = path.join(p.dir, `${p.name} (${i})${p.ext}`);
      if (!fs.existsSync(cand)) return cand;
    }
    return dest;
  }

  function runAutoOrganize(opts) {
    const force = !!(opts && opts.force);
    try {
      const cfg = (loadStore().settings || {}).autoOrganize || {};
      if (cfg.enabled !== true) return { moved: [], errors: [], scanned: 0, skipped: 0 };
      const watch = String(cfg.watch || '').trim();
      // 规则目标必须是绝对路径：自动整理会真实移动用户文件，
      // 相对路径会以进程工作目录为基准乱搬，直接忽略这类规则
      const rules = (Array.isArray(cfg.rules) ? cfg.rules : [])
        .filter(r => r && typeof r.value === 'string' && r.value && typeof r.to === 'string' && path.isAbsolute(r.to));
      if (!watch || !fs.existsSync(watch) || !rules.length) return { moved: [], errors: [], scanned: 0, skipped: 0 };

      // 规则或监控目录变化 → 清空尝试记录，让新规则对已有文件即时生效
      const sig = configSignature(cfg);
      if (sig !== organizeConfigSig) {
        if (organizeConfigSig !== null) organizeAttempts.clear();
        organizeConfigSig = sig;
      }
      // 清理过期的尝试记录（同时限制内存占用）
      const now = Date.now();
      for (const [p, t] of organizeAttempts) {
        if (now - t > ORGANIZE_RETRY_MS) organizeAttempts.delete(p);
      }
      if (organizeAttempts.size > ORGANIZE_MAX_TRACKED) organizeAttempts.clear();

      const moved = [];
      const skipped = [];
      const errors = [];
      let scanned = 0;
      const entries = fs.readdirSync(watch, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) continue; // 只整理文件，不递归
        const src = path.join(watch, ent.name);
        scanned++;
        const lastTry = organizeAttempts.get(src);
        if (!force && lastTry && now - lastTry < ORGANIZE_RETRY_MS) { skipped.push(ent.name); continue; }

        let targetDir = null;
        const nameL = ent.name.toLowerCase();
        const ext = path.extname(ent.name).replace(/^\./, '').toLowerCase();
        for (const r of rules) {
          const v = String(r.value || '').trim().toLowerCase();
          if (!v) continue;
          if (r.type === 'ext') { if (v === ext) { targetDir = r.to; break; } }
          else { if (nameL.indexOf(v) !== -1) { targetDir = r.to; break; } } // kw 关键词
        }
        // 不匹配任何规则的文件也记一次尝试（短时间内不重复匹配），但过期后会重新判断
        organizeAttempts.set(src, now);
        if (!targetDir) continue;
        try {
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          const dest = uniqueTargetPath(path.join(targetDir, ent.name));
          fs.renameSync(src, dest);
          organizeAttempts.delete(src);       // 已移动：源路径不再需要记录
          moved.push({ from: src, to: dest });
        } catch (e) {
          errors.push({ file: ent.name, msg: String((e && e.message) || e) });
        }
      }
      return { moved, errors, scanned, skipped: skipped.length };
    } catch (e) {
      return { moved: [], errors: [{ msg: String((e && e.message) || e) }], scanned: 0, skipped: 0 };
    }
  }

  // -----------------------------------------------------------
  // 内置检查更新：从可配置的 JSON 清单地址拉取最新版本
  // -----------------------------------------------------------
  function compareSemver(a, b) {
    const pa = String(a || '').split('.').map(x => +x || 0);
    const pb = String(b || '').split('.').map(x => +x || 0);
    for (let i = 0; i < 3; i++) { const x = pa[i] || 0, y = pb[i] || 0; if (x !== y) return x > y ? 1 : -1; }
    return 0;
  }
  async function checkForUpdate() {
    try {
      const { net } = require('electron');
      const st = loadStore().settings || {};
      const url = String(st.updaterUrl || '').trim();
      const cur = app.getVersion();
      if (!url) return { ok: false, hasUpdate: false, reason: 'no-src' };
      const manifest = await new Promise((resolve, reject) => {
        const req = net.request(url);
        let buf = '';
        let settled = false;
        const fail = (msg) => { if (!settled) { settled = true; reject(new Error(msg)); } };
        req.setHeader('Accept', 'application/json');
        req.on('response', (res) => {
          const code = res.statusCode || 0;
          if (code < 200 || code >= 300) { fail('HTTP ' + code); return; }
          res.on('data', c => { buf += c; if (buf.length > 4e6) { try { req.abort(); } catch (e) { /* ignore */ } fail('文件过大'); } });
          res.on('end', () => { if (!settled) { settled = true; try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('JSON 解析失败')); } } });
          res.on('error', () => fail('网络错误'));
        });
        req.on('error', () => fail('网络错误'));
        req.setTimeout(8000, () => { try { req.abort(); } catch (e) { /* ignore */ } fail('请求超时'); });
        req.end();
      });
      const latest = String(manifest.version || '').trim();
      if (!latest) return { ok: false, hasUpdate: false, reason: 'bad-manifest' };
      const dl = String(manifest.url || '').trim();
      return {
        ok: true,
        hasUpdate: compareSemver(latest, cur) > 0,
        cur,
        latest,
        url: /^https?:\/\//i.test(dl) ? dl : null,
        notes: String(manifest.notes || '')
      };
    } catch (e) {
      return { ok: false, hasUpdate: false, reason: 'error', msg: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------------------
  // 待办到期系统通知提醒（每 30 秒检查一次当天已到时间的待办）
  // ---------------------------------------------------------------------------
  function checkReminders() {
    try {
      const d = loadStore();
      const tk = dateKeyMain();
      const now = new Date();
      let changed = false;
      (d.todos || []).forEach(t => {
        if (t.done || !t.due || t.due !== tk) return;
        const hm = String(t.dueTime || '').trim();
        if (!hm) return;
        const parts = hm.split(':').map(Number);
        if (parts.length < 2 || isNaN(parts[0])) return;
        const dueMin = parts[0] * 60 + (parts[1] | 0);
        const remindMin = parseInt(t.remind, 10) || 0;   // 提前 N 分钟（0=准点）
        const fireAt = dueMin - remindMin;
        const nowMin = now.getHours() * 60 + now.getMinutes();
        if (nowMin < fireAt) return;              // 还没到提醒时间
        if (t.remindedOn === tk) return;      // 今天已提醒过（remindedOn 为正式字段，见 lib/migrate.js）
        t.remindedOn = tk;
        changed = true;
        if (Notification.isSupported()) {
          const n = new Notification({
            title: '待办 · ' + String(t.text || ''),
            body: (remindMin ? '提前 ' + remindMin + ' 分钟 · ' : '') + hm + ' 到期' + (t.note ? ' ｜ ' + t.note : ''),
            silent: false
          });
          n.show();
        }
      });
      if (changed) saveStore(d);
    } catch (e) {
      /* ignore */
    }
  }

  // 每日待办汇总提醒：到设定时间后提醒当天（含逾期）待办
  function checkDailySummary() {
    try {
      const d = loadStore();
      const s = d.settings || {};
      if (s.dailyRemind !== true) return;
      const tk = dateKeyMain();
      if (s.dailyRemindOn === tk) return;                    // 今天已汇总过
      const hm = String(s.dailyRemindTime || '08:30').trim();
      const parts = hm.split(':').map(Number);
      if (parts.length < 2 || isNaN(parts[0])) return;
      const target = parts[0] * 60 + (parts[1] | 0);
      const now = new Date();
      const nowMin = now.getHours() * 60 + now.getMinutes();
      if (nowMin < target) return;
      const today = (d.todos || []).filter(t => !t.done && t.due && t.due <= tk);
      if (today.length && Notification.isSupported()) {
        const lines = today.slice(0, 6).map(t => '· ' + (t.dueTime ? t.dueTime + ' ' : '') + String(t.text || '')).join('\n');
        const more = today.length > 6 ? '\n… 另有 ' + (today.length - 6) + ' 项' : '';
        new Notification({ title: '今日待办（' + today.length + ' 项）', body: lines + more }).show();
      }
      s.dailyRemindOn = tk;
      saveStore(d);
    } catch (e) {
      /* ignore */
    }
  }
  function dateKeyMain(d) { d = d || new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }

  // 根据主题设置窗口底色，避免切换/启动时白闪
  function applyThemeBg(theme) {
    try {
      if (!win) return;
      const dark = theme === 'dark' || (theme === 'auto' && nativeTheme.shouldUseDarkColors);
      win.setBackgroundColor(dark ? '#17181c' : '#f4f5f7');
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // IPC handlers
  // ---------------------------------------------------------------------------
  ipcMain.handle('store:load', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    // 结构归一化与老用户补默认值已统一在 lib/migrate.js 处理，这里只回给渲染层
    return { rev: store.getRev(), data: loadStore() };
  });

  // 渲染层落盘通道：只接受「补丁」（差异），不接受整份快照。
  // 整份覆盖会让主进程的并发写入（快速添加待办、逾期顺延、提醒标记、小组件开关）被丢掉。
  // 补丁本身先过 lib/patchguard.js 的形状/体积/字段白名单校验。
  ipcMain.handle('store:commit', (event, payload) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const patch = payload && payload.patch;
    const bad = validatePatch(patch, {
      collections: proto.COLLECTIONS,
      ephemeralKeys: proto.EPHEMERAL_KEYS
    });
    if (bad) {
      try { console.log('[store] 拒绝非法补丁：' + bad); } catch (e) { /* ignore */ }
      return { ok: false, rev: store.getRev(), changed: false, error: bad };
    }
    const r = store.commit(patch);
    reconcileUsage();   // 时间统计开关等设置可能变化，立即自愈
    reconcileWidgets(); // 桌面小组件开关可能变化
    return r;
  });

  ipcMain.handle('win:mode', (event, mode) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return setMode(mode);
  });

  ipcMain.handle('win:autostart', (event, enable) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return setAutostart(enable);
  });

  ipcMain.handle('win:hide', (event) => {
    if (isTrustedSender(event)) hideWin();
  });

  ipcMain.handle('win:layout', (event, layout) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return setLayout(layout);
  });

  ipcMain.handle('win:theme', (event, theme) => {
    if (!isTrustedSender(event) || !['light', 'dark', 'auto'].includes(theme)) throw new Error('forbidden');
    applyThemeBg(theme);
  });

  ipcMain.handle('win:glass', (event, on) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    applyGlass(!!on);
  });

  ipcMain.handle('todo:quickAdd', (event, raw) => {
    if (!isTrustedSender(event)) return { ok: false, msg: 'forbidden' };
    return addQuickTodo(raw);
  });

  ipcMain.handle('qa:close', (event) => {
    if (!isTrustedSender(event)) return;
    try { if (qaWin && !qaWin.isDestroyed()) qaWin.hide(); } catch (e) { /* ignore */ }
  });

  // ----- 剪贴板历史 -----
  ipcMain.handle('clip:list', (event, opts) => {
    if (!isTrustedSender(event)) return [];
    return listClip(opts || {});
  });

  ipcMain.handle('clip:copy', (event, id) => {
    if (!isTrustedSender(event)) return { ok: false, msg: 'forbidden' };
    return copyClipItem(id);
  });

  ipcMain.handle('clip:pin', (event, id) => {
    if (!isTrustedSender(event)) return { ok: false };
    return pinClipItem(id);
  });

  ipcMain.handle('clip:delete', (event, id) => {
    if (!isTrustedSender(event)) return { ok: false };
    return deleteClipItem(id);
  });

  ipcMain.handle('clip:clearUnpinned', (event) => {
    if (!isTrustedSender(event)) return { ok: false };
    return clearUnpinnedClips();
  });

  ipcMain.handle('clip:ocr', (event, id) => {
    if (!isTrustedSender(event)) return { ok: false, msg: 'forbidden' };
    return runOcr(id);
  });

  ipcMain.handle('clip:hide', (event) => {
    if (!isTrustedSender(event)) return;
    try { if (cbWin && !cbWin.isDestroyed()) cbWin.hide(); } catch (e) { /* ignore */ }
  });

  // ----- 自动时间统计 -----
  ipcMain.handle('usage:getSummary', (event, opts) => {
    if (!isTrustedSender(event)) return emptyUsageSummary();
    const days = Math.max(1, Math.min(30, parseInt(opts && opts.days, 10) || 7));
    return usageSummary(days);
  });

  ipcMain.handle('usage:clear', (event) => {
    if (!isTrustedSender(event)) return { ok: false };
    usageData = { days: {} };
    saveUsageData();
    return { ok: true };
  });

  ipcMain.handle('clip:toggle', (event) => {
    if (!isTrustedSender(event)) return false;
    toggleClipboard();
    return true;
  });

  ipcMain.handle('auto:pickWatch', async (event) => {
    if (!isTrustedSender(event)) return null;
    const r = await dialog.showOpenDialog(win, { title: '选择要监控的文件夹', properties: ['openDirectory'] });
    return (r.canceled || !r.filePaths || !r.filePaths[0]) ? null : r.filePaths[0];
  });

  ipcMain.handle('auto:pickTarget', async (event) => {
    if (!isTrustedSender(event)) return null;
    const r = await dialog.showOpenDialog(win, { title: '选择整理目标文件夹', properties: ['openDirectory'] });
    return (r.canceled || !r.filePaths || !r.filePaths[0]) ? null : r.filePaths[0];
  });

  ipcMain.handle('auto:run', (event) => {
    if (!isTrustedSender(event)) return { moved: [], errors: [], scanned: 0, skipped: 0 };
    return runAutoOrganize({ force: true });   // 手动整理：忽略重试时间窗，重扫全部
  });

  ipcMain.handle('notify:show', (event, opts) => {
    if (!isTrustedSender(event)) return;
    try {
      if (!Notification.isSupported()) return;
      const title = opts && opts.title ? String(opts.title) : '桌面工作台';
      const body = opts && opts.body ? String(opts.body) : '';
      new Notification({ title, body, silent: !!(opts && opts.silent) }).show();
    } catch (e) { /* ignore */ }
  });

  ipcMain.handle('app:checkUpdate', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return checkForUpdate();
  });

  ipcMain.handle('app:openExternal', (event, u) => {
    if (!isTrustedSender(event) || typeof u !== 'string') return;
    if (!/^https?:\/\//i.test(u)) return;
    try { shell.openExternal(u); } catch (e) { /* ignore */ }
  });

  ipcMain.handle('win:minimize', (event) => {
    if (!isTrustedSender(event)) return;
    try { if (win) win.minimize(); } catch (e) { /* ignore */ }
  });

  ipcMain.handle('win:maximizeToggle', (event) => {
    if (!isTrustedSender(event)) return false;
    if (!win) return false;
    try {
      if (win.isMaximized()) win.unmaximize(); else win.maximize();
      return win.isMaximized();
    } catch (e) {
      return false;
    }
  });

  ipcMain.handle('win:quit', (event) => {
    if (isTrustedSender(event)) { isQuitting = true; app.quit(); }
  });

  ipcMain.handle('app:info', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return {
      version: app.getVersion(),
      platform: process.platform,
      userData: app.getPath('userData'),
      hotkey: HOTKEY_LABEL
    };
  });

  // 运行环境诊断（设置页展示；也是出问题时的唯一排查入口）
  ipcMain.handle('app:diagnostics', (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    return appDiagnostics();
  });

  // 手动重新探测 PowerShell（设置页「重新检测」）
  ipcMain.handle('app:probePowershell', async (event) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    await ps.probe(true);
    reconcileUsage();      // 环境变化后时间统计可能可以从降级恢复
    return appDiagnostics();
  });

  // ----- 文件/目录选择 -----
  ipcMain.handle('dialog:pickFiles', async (event) => {
    if (!isTrustedSender(event)) return [];
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要整理的文件'
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('dialog:pickFolder', async (event) => {
    if (!isTrustedSender(event)) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择文件夹'
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('dialog:pickApp', async (event) => {
    if (!isTrustedSender(event)) return null;
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择应用程序（.exe 或 .lnk 快捷方式）',
      filters: [
        { name: '应用程序', extensions: ['exe', 'lnk'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    });
    return r.canceled ? null : r.filePaths[0];
  });

  // ----- 文件解析与图标 -----
  function isAbsolute(p) { return typeof p === 'string' && path.isAbsolute(p); }

  function resolvePath(p) {
    // 传入的必须是绝对路径字符串，防止任意读
    if (!isAbsolute(p)) return null;
    if (path.extname(p).toLowerCase() === '.lnk') {
      try {
        const lnk = shell.readShortcutLink(p);
        return lnk && lnk.target ? lnk.target : p;
      } catch (e) {
        return p;
      }
    }
    return p;
  }

  // Electron 的 readShortcutLink 对部分 .lnk（如某些安装器生成的快捷方式）会解析失败，
  // 但 PowerShell 的 WScript.Shell 仍可读出目标；用其兜底，否则 getFileIcon 只会拿到通用文档图标
  async function resolveLnkViaPs(p) {
    if (!ps.isAvailable()) {
      ps.noteFeature('lnk-resolve', false, 'PowerShell 不可用，无法兜底解析快捷方式目标');
      return null;
    }
    try {
      const cmd = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + String(p).replace(/'/g, "''") + "'); if ($s.TargetPath) { $s.TargetPath }";
      const r = await ps.run(ps.scriptArgs('[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + cmd), { timeout: 5000 });
      if (!r.ok || !r.stdout) { ps.noteFeature('lnk-resolve', false, r.error || '未取到目标路径'); return null; }
      // 取最后一行有效输出：PowerShell 可能在结果前打印警告/本地化提示
      const t = lastMeaningfulLine(r.stdout);
      const ok = !!(t && path.isAbsolute(t) && fs.existsSync(t));
      ps.noteFeature('lnk-resolve', ok, ok ? '' : '解析结果不是有效路径');
      return ok ? t : null;
    } catch (e) {
      return null;
    }
  }

  // 识别 SHGetFileInfo 失败时的通用占位图：对一个必然不存在的文件采基准图，
  // 与之相同的图标说明 Windows 没能提取出真图标
  let genericIconSigCache = null;
  async function genericIconSig() {
    if (genericIconSigCache !== null) return genericIconSigCache;
    try {
      const img = await app.getFileIcon('C:\\__wbench_missing__.exe', { size: 'large' });
      genericIconSigCache = img && !img.isEmpty() ? img.toDataURL() : '';
    } catch (e) {
      genericIconSigCache = '';
    }
    return genericIconSigCache;
  }

  // SHGetFileInfo 失败时用 GDI+ ExtractAssociatedIcon 兜底（对 PNG 压缩图标等特殊 exe 有效）
  async function extractIconViaPs(p) {
    if (!ps.isAvailable()) return null;                 // 只是兜底手段，不可用就交给字母头像
    try {
      const outPng = path.join(os.tmpdir(), 'wbench-icon-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.png');
      const script = [
        'try {',
        '  Add-Type -AssemblyName System.Drawing',
        "  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('" + String(p).replace(/'/g, "''") + "')",
        "  $ico.ToBitmap().Save('" + outPng.replace(/\\/g, '\\\\') + "', [System.Drawing.Imaging.ImageFormat]::Png)",
        "  Write-Output 'OK'",
        "} catch { Write-Output 'FAIL' }"
      ].join('; ');
      const r = await ps.run(ps.scriptArgs(script), { timeout: 8000 });
      if (!r.ok || !fs.existsSync(outPng)) { ps.noteFeature('icon-extract', false, r.error || 'API 提取图标失败'); return null; }
      const buf = fs.readFileSync(outPng);
      fs.rmSync(outPng, { force: true });
      const dataUrl = buf.length > 120 ? 'data:image/png;base64,' + buf.toString('base64') : null;
      ps.noteFeature('icon-extract', !!dataUrl, dataUrl ? '' : '提取结果为空');
      return dataUrl;
    } catch (e) {
      return null;
    }
  }

  // 多级尝试取文件图标：
  // lnk → 解析目标（readShortcutLink → PowerShell 兜底）→ 常规提取 → 占位图检测 → GDI+ 兜底。
  // 「lnk 自身的图标」永远是通用占位图，绝不作为有效结果返回（失败返回 null，渲染层显示字母头像）。
  // 结果统一走图标缓存：返回 file:// URL（短），数据文件里只存 `icon:<sha1>.png` 引用。
  function cacheIconImage(dataUrl) {
    if (!dataUrl) return null;
    const saved = iconCache.store(dataUrl);
    if (saved) return saved.url;          // 常规路径：落盘成 PNG，返回 file:// URL
    return dataUrl;                       // 落盘失败（如目录只读）：退回内联 data URL，功能不中断
  }

  async function fetchFileIcon(p) {
    try {
      const isLnk = path.extname(p).toLowerCase() === '.lnk';
      let source = p;
      let resolved = !isLnk;
      if (isLnk) {
        try {
          const l = shell.readShortcutLink(p);
          if (l && l.target && path.isAbsolute(l.target) && fs.existsSync(l.target)) {
            source = l.target;
            resolved = true;
          }
        } catch (e) { /* ignore */ }
        if (!resolved) {
          const viaPs = await resolveLnkViaPs(p);
          if (viaPs) { source = viaPs; resolved = true; }
        }
      }
      const generic = await genericIconSig();
      // 第一级：常规提取（SHGetFileInfo 路径）
      try {
        const img = await app.getFileIcon(source, { size: 'large' });
        if (img && !img.isEmpty()) {
          const durl = img.toDataURL();
          if (durl !== generic) return cacheIconImage(durl);   // 真图标
        }
      } catch (e) { /* ignore */ }
      // 目标解析失败的 lnk：任何图标都只会是通用占位图 → 返回 null（渲染层字母头像）
      if (isLnk && !resolved) return null;
      // 第二级：GDI+ ExtractAssociatedIcon（对 PNG 压缩图标等特殊 exe 图标资源有效）
      const viaPs = await extractIconViaPs(source);
      if (viaPs) return cacheIconImage(viaPs);
    } catch (e) { /* ignore */ }
    return null;
  }

  ipcMain.handle('fs:resolveItem', async (event, p) => {
    if (!isTrustedSender(event) || !isAbsolute(p)) throw new Error('forbidden');
    const lower = p.toLowerCase();
    let type = 'file';
    let target = p;
    let name = path.basename(p);
    let icon = null;
    let broken = false;

    try {
      const st = fs.statSync(p);
      type = st.isDirectory() ? 'folder' : 'file';
    } catch (e) {
      broken = true;
    }

    if (lower.endsWith('.lnk')) {
      try {
        const lnk = shell.readShortcutLink(p);
        if (lnk && lnk.target) {
          target = lnk.target;
          if (!path.isAbsolute(target)) {
            target = path.resolve(path.dirname(p), target);
          }
          broken = broken || !fs.existsSync(target);
        }
      } catch (e) {
        // readShortcutLink 失败时用 PowerShell 兜底解析目标，修正常见的「快捷方式只显示通用图标」问题
        const viaPs = await resolveLnkViaPs(p);
        if (viaPs) {
          target = viaPs;
          broken = broken || !fs.existsSync(target);
        }
      }
    }

    icon = await fetchFileIcon(p);

    return { type, target, name, icon, broken, path: p };
  });

  ipcMain.handle('fs:getIcon', async (event, p) => {
    if (!isTrustedSender(event) || !isAbsolute(p)) throw new Error('forbidden');
    return fetchFileIcon(p);
  });

  ipcMain.handle('fs:open', async (event, p) => {
    if (!isTrustedSender(event) || !isAbsolute(p)) throw new Error('forbidden');
    try {
      const err = await shell.openPath(resolvePath(p));
      return err ? err : '';
    } catch (e) {
      return String(e && e.message ? e.message : e);
    }
  });

  ipcMain.handle('fs:reveal', (event, p) => {
    if (!isTrustedSender(event) || !isAbsolute(p)) throw new Error('forbidden');
    try {
      shell.showItemInFolder(resolvePath(p));
      return '';
    } catch (e) {
      return String(e && e.message ? e.message : e);
    }
  });

  // ----- 数据备份 / 导出 / 导入 -----
  ipcMain.handle('data:backupNow', (event) => {
    if (!isTrustedSender(event)) return null;
    return doBackup();
  });
  ipcMain.handle('data:listBackups', (event) => {
    if (!isTrustedSender(event)) return [];
    return listBackups();
  });
  ipcMain.handle('data:openBackupDir', (event) => {
    if (!isTrustedSender(event)) return;
    const dir = backupDir();
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); shell.openPath(dir); } catch (e) { /* ignore */ }
  });
  ipcMain.handle('data:export', async (event, jsonStr) => {
    if (!isTrustedSender(event) || typeof jsonStr !== 'string') throw new Error('forbidden');
    const r = await dialog.showSaveDialog(win, {
      title: '导出工作台数据',
      defaultPath: path.join(app.getPath('documents'), '桌面工作台-备份-' + fileDateTime() + '.json'),
      filters: [{ name: 'JSON 数据', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, path: null };
    try {
      fs.writeFileSync(r.filePath, jsonStr, 'utf8');
      return { ok: true, path: r.filePath };
    } catch (e) {
      return { ok: false, path: null };
    }
  });
  ipcMain.handle('data:import', async (event) => {
    if (!isTrustedSender(event)) return { ok: false, canceled: true, content: null };
    const r = await dialog.showOpenDialog(win, {
      title: '导入工作台数据',
      properties: ['openFile'],
      filters: [{ name: 'JSON 数据', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return { ok: false, canceled: true, content: null };
    try {
      const content = fs.readFileSync(r.filePaths[0], 'utf8');
      JSON.parse(content); // 只校验合法性；结构清洗在渲染层（renderer/importguard.js）
      return { ok: true, canceled: false, content };
    } catch (e) {
      logE('data:import', e);
      return { ok: false, canceled: false, content: null };
    }
  });

  // ----- 应用生命周期 -----
  app.on('second-instance', () => {
    showWin();
  });

  app.whenReady().then(() => {
    // 记录「谁在运行」：单实例锁那一段会读取它来诊断「装了新版还是老界面」
    try {
      fs.mkdirSync(path.dirname(runningInfoPath()), { recursive: true });
      fs.writeFileSync(runningInfoPath(), JSON.stringify({
        version: app.getVersion(),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        exe: process.execPath,
        resources: __dirname
      }), 'utf8');
    } catch (e) { /* ignore */ }

    // 先装载数据（必要时从备份自愈、执行结构迁移并清理图标缓存），再建窗口 ——
    // 这样窗口首次读取设置时数据已就绪，恢复提示也能先于界面出现
    loadStoreWithRecovery();
    pruneIconCache();

    app.setAppUserModelId('com.workbench.desktop');
    createWindow();
    buildTray();
    registerHotkey();
    createQuickAddWindow();
    createClipboardWindow();

    // 剪贴板历史：启动即装载历史 + 注册快捷键 + 首次采集，之后持续轮询
    loadClipData();
    captureClipboard();
    setInterval(captureClipboard, 1200);

    // 自动时间统计：按设置开关自愈启停（仅 Windows 生效）
    loadUsageData();
    reconcileUsage();
    powerMonitor.on('lock', () => { usagePaused = true; });   // 锁屏立即暂停
    powerMonitor.on('unlock', () => { usagePaused = false; usageLastTick = Date.now(); });

    // 桌面小组件：按设置开关启停
    reconcileWidgets();

    // 分辨率 / 缩放 / 显示器变化时，覆盖桌面模式重新铺满
    const handleDisplayChange = () => {
      if (isQuitting) return;
      if (currentLayout() !== 'window') applyLayout('overlay');
    };
    screen.on('display-metrics-changed', handleDisplayChange);
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);

    // PowerShell 能力探测：异步进行，不阻塞启动；探测结果变化会推送给界面
    ps.probe().then(() => { try { reconcileUsage(); } catch (e) { /* ignore */ } }).catch(() => { /* ignore */ });

    // 待办到期提醒 + 每日汇总 + 逾期顺延 + 自动整理：启动后每 30 秒检查一次
    setInterval(() => { checkReminders(); checkDailySummary(); autoAdvanceOverdue(); runAutoOrganize(); }, 30 * 1000);
    checkReminders();
    checkDailySummary();
    autoAdvanceOverdue();
    runAutoOrganize();

    // 自动备份：启动时 + 每 6 小时（若用户未关闭）
    const maybeAutoBackup = () => {
      try { if (loadStore().settings.autoBackup !== false) doBackup(); } catch (e) { /* ignore */ }
    };
    maybeAutoBackup();
    setInterval(maybeAutoBackup, 6 * 60 * 60 * 1000);

    // 系统深浅色变化时，跟进"自动"主题的窗口底色（渲染层由 CSS 媒体查询同步）
    nativeTheme.on('updated', () => {
      const t = (loadStore().settings || {}).theme || 'light';
      if (t === 'auto') applyThemeBg('auto');
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
      else showWin();
    });
  });

  app.on('will-quit', () => {
    try { if (usageHelper) usageHelper.kill(); } catch (e) { /* ignore */ }
    usageHelper = null;
    try { saveUsageData(); } catch (e) { /* ignore */ } // 退出前落盘时间统计增量
    try { store.flush(); } catch (e) { /* ignore */ }   // 退出前把写合并窗口里的主数据落盘
    try { fs.rmSync(runningInfoPath(), { force: true }); } catch (e) { /* ignore */ }
    try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  });

  app.on('window-all-closed', (e) => {
    // 不退出：常驻托盘
  });
}