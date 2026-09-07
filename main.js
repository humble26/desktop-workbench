'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, screen, nativeImage, Notification, nativeTheme, clipboard, powerMonitor, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// 诊断日志：把原本静默吞掉的异常写入控制台，便于定位保存 / OCR / PowerShell / 窗口故障
function logE(where, e) {
  try { console.warn('[workbench]', where, '::', (e && e.stack) || (e && e.message) || e); } catch (_) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// 单实例锁：防止重复启动
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
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
  const BACKUP_KEEP = 12;

  function pad2(n) { return String(n).padStart(2, '0'); }
  function fileDateTime(d) { d = d || new Date(); return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`; }

  // 立即备份当前数据文件；返回备份文件路径（失败返回 null）
  function doBackup() {
    try {
      if (!fs.existsSync(storePath())) return null;
      const dir = backupDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, 'workbench-' + fileDateTime() + '.json');
      fs.copyFileSync(storePath(), dest);
      // 保留最近 N 份
      const files = fs.readdirSync(dir).filter(f => /^workbench-[\d\-]+\.json$/.test(f)).sort();
      while (files.length > BACKUP_KEEP) {
        fs.unlinkSync(path.join(dir, files.shift()));
      }
      return dest;
    } catch (e) {
      logE('doBackup', e);
      return null;
    }
  }
  function listBackups() {
    try {
      const dir = backupDir();
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).filter(f => /^workbench-[\d\-]+\.json$/.test(f)).sort().reverse().map(f => {
        const full = path.join(dir, f);
        return { name: f, path: full, size: fs.statSync(full).size };
      });
    } catch (e) { return []; }
  }

  // ---------------------------------------------------------------------------
  // 数据存储（JSON 文件，原子写入）
  // ---------------------------------------------------------------------------
  function defaultData() {
    return {
      version: 1,
      profile: { name: '我的工作台', greeting: '' },
      todos: [],
      notes: [],
      checkins: [],
      shortcuts: [],
      groups: [],
      settings: { mode: 'normal', autostart: false, accent: '#2f2e2b', layout: 'overlay', theme: 'light', dailyRemind: false, dailyRemindTime: '08:30', clipboardHistory: true, clipboardSensitive: true, timeTrack: TIME_TRACK_DEFAULTS }
    };
  }

  // 统一数据归一化：校验顶层及嵌套字段类型，损坏或缺字段用默认值兜底，避免渲染期崩溃
  function sanitizeData(parsed) {
    const base = defaultData();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return base;
    const arr = (v) => (Array.isArray(v) ? v : []);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const out = Object.assign({}, base, parsed);
    out.todos = arr(parsed.todos).filter(t => t && typeof t === 'object');
    out.notes = arr(parsed.notes).filter(n => n && typeof n === 'object');
    out.checkins = arr(parsed.checkins).filter(c => c && typeof c === 'object');
    out.shortcuts = arr(parsed.shortcuts).filter(s => s && typeof s === 'object');
    out.groups = arr(parsed.groups).filter(g => g && typeof g === 'object');
    out.settings = Object.assign({}, base.settings, obj(parsed.settings));
    out.profile = Object.assign({}, base.profile, obj(parsed.profile));
    out.todos.forEach(t => {
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (!Array.isArray(t.doneHistory)) t.doneHistory = [];
    });
    out.groups.forEach(g => {
      if (!Array.isArray(g.items)) g.items = [];
      else g.items = g.items.filter(it => it && typeof it === 'object');
    });
    // autoOrganize 设置约束：watch 必须是字符串，rules 每项的 value/to 都必须是字符串
    const ao = obj(out.settings.autoOrganize);
    ao.watch = typeof ao.watch === 'string' ? ao.watch : '';
    ao.rules = Array.isArray(ao.rules)
      ? ao.rules.filter(r => r && typeof r === 'object' && typeof r.value === 'string' && typeof r.to === 'string')
      : [];
    out.settings.autoOrganize = ao;
    return out;
  }

  // 尝试从备份恢复损坏的主数据文件
  function autoRestore() {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      JSON.parse(raw); // 主文件健康
      return { ok: true };
    } catch (e) { /* 主文件缺失或损坏 */ }
    const bks = listBackups(); // 新到旧
    for (const b of bks) {
      try {
        const content = fs.readFileSync(b.path, 'utf8');
        JSON.parse(content);
        fs.copyFileSync(b.path, storePath());
        if (Notification.isSupported()) {
          new Notification({ title: '数据已恢复', body: '检测到主数据文件损坏或缺失，已自动从最近备份「' + b.name + '」恢复。' }).show();
        }
        return { ok: true, from: b.name };
      } catch (e) { /* 该备份也损坏，尝试下一份 */ }
    }
    return { ok: false };
  }

  function loadStore() {
    try {
      const raw = fs.readFileSync(storePath(), 'utf8');
      const parsed = JSON.parse(raw);
      return sanitizeData(parsed);
    } catch (e) {
      return defaultData();
    }
  }

  function saveStore(data) {
    try {
      const tmp = storePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data == null ? defaultData() : data), 'utf8');
      fs.renameSync(tmp, storePath());
      return true;
    } catch (e) {
      logE('saveStore', e);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // 安全校验：只接受来自本应用 file:// 页面的 IPC 请求
  // ---------------------------------------------------------------------------
  function isTrustedSender(event) {
    try {
      const url = event.senderFrame ? event.senderFrame.url : '';
      const ok = url.startsWith('file://');
      return ok;
    } catch (e) {
      return false;
    }
  }

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
    }
  }

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

  function registerHotkey() {
    try {
      globalShortcut.register(HOTKEY, toggleWin);
    } catch (e) {
      /* ignore */
    }
    try {
      globalShortcut.register(HOTKEY_ADD, toggleQuickAdd);
    } catch (e) {
      /* ignore */
    }
    try {
      globalShortcut.register(HOTKEY_SHOT, startScreenshot);
    } catch (e) {
      /* ignore */
    }
  }

  // 数据变化广播：主窗口据此重新渲染（全局快速添加 / 自动顺延等会触发）
  function broadcastChanged() {
    try {
      if (win && !win.isDestroyed()) win.webContents.send('data:changed');
    } catch (e) { /* ignore */ }
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
  // -----------------------------------------------------------
  function parseQuickTodo(raw) {
    const tk = new Date();
    const padQ = n => String(n).padStart(2, '0');
    const addDaysQ = n => { const d = new Date(tk); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${padQ(d.getMonth() + 1)}-${padQ(d.getDate())}`; };
    let text = String(raw || '').trim();
    let due = '';
    let dueTime = '';

    // 优先级：时间内的日期提示。支持 今天/明天/后天/昨天/YYYY-MM-DD/MM月DD日
    const dateMatcher = /(今天|明天|后天|昨(?:天|日)|\d{4}\s*[-\/]\s*\d{1,2}\s*[-\/]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)/;
    const dm = text.match(dateMatcher);
    if (dm) {
      const w = dm[1];
      if (w === '今天') due = addDaysQ(0);
      else if (w === '明天') due = addDaysQ(1);
      else if (w === '后天') due = addDaysQ(2);
      else if (w === '昨天' || w === '昨日') due = addDaysQ(-1);
      else if (/\d{1,2}月\d{1,2}日/.test(w)) {
        const mm = w.match(/(\d{1,2})月(\d{1,2})/);
        due = `${tk.getFullYear()}-${padQ(+mm[1])}-${padQ(+mm[2])}`;
      } else if (/\d{4}/.test(w)) {
        const p = w.split(/[-\/]/).map(x => +x);
        due = `${p[0]}-${padQ(p[1])}-${padQ(p[2])}`;
      }
      text = text.replace(dm[1], ' ').trim();
    }
    // 时间提示，例如 15:30
    const tm = text.match(/(\d{1,2}):(\d{2})/);
    if (tm) {
      const h = +tm[1], m = +tm[2];
      if (h >= 0 && h <= 23 && m <= 59) dueTime = `${padQ(h)}:${padQ(m)}`;
      text = text.replace(tm[0], ' ').trim();
    }
    text = text.replace(/[，。！？,.\s；;]+$/g, '').trim();
    return { text, due, dueTime };
  }

  function addQuickTodo(raw) {
    try {
      const parsed = parseQuickTodo(raw);
      if (!parsed.text) return { ok: false, msg: '内容不能为空' };
      const d = loadStore();
      d.todos = d.todos || [];
      d.todos.unshift({
        id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        text: parsed.text, level: 'mid', done: false,
        date: dateKeyMain(), due: parsed.due, dueTime: parsed.dueTime,
        repeat: 'none', note: '', subtasks: [], doneHistory: [], remind: 0
      });
      saveStore(d);
      broadcastChanged();
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

  // 敏感内容识别：JWT / 私钥 / 口令 / API Key 等不写入剪贴板历史，避免明文落盘
  function isSensitiveText(t) {
    if (!t) return false;
    const s = String(t);
    if (/\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}/.test(s)) return true;             // JWT
    if (/(-----BEGIN (RSA |EC |OPENSSH |DSA |)PRIVATE KEY-----)/.test(s)) return true;      // 私钥
    if (/\b(password|passwd|pwd|secret|api[-_]?key|token|access[-_]?key|client[-_]?secret|登录口令)\s*[=:：]\s*\S{8,}/i.test(s)) return true;
    if (/\bgh[pousr]_[A-Za-z0-9]{20,}\b/.test(s)) return true;                             // GitHub token
    if (/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/.test(s)) return true;                           // Slack token
    if (/\bAKIA[A-Z0-9]{16}\b/.test(s)) return true;                                       // AWS Access Key
    return false;
  }

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
    try {
      const ps = '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; (Get-Clipboard -Format FileDropList) -join "|"';
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
        { windowsHide: true, encoding: 'utf8', timeout: 6000 }, (err, stdout) => {
          try {
            if (err || !stdout) return;
            const list = String(stdout).replace(/^\uFEFF/, '').trim().split('|').map(s => s.trim()).filter(Boolean);
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
          } catch (e) { /* ignore */ }
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
      } else {
        globalShortcut.unregister(HOTKEY_CLIP);
        clipHotkeyOn = false;
      }
    } catch (e) {
      clipHotkeyOn = false;
    }
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
      else if (text.trim() && text.length <= CLIP_TEXT_MAX) { if (!clipSensitiveEnabled() || !isSensitiveText(text)) addClipItem({ type: 'text', text }); }
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
        spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Set-Clipboard -Path ' + list],
          { windowsHide: true, stdio: 'ignore' }).on('error', () => { /* ignore */ });
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

  // 读取并规范化时间统计设置（老数据缺省时回退默认值）
  function ttSettings() {
    const d = loadStore();
    let t = d.settings && d.settings.timeTrack;
    if (!t || typeof t !== 'object') t = {};
    return {
      enabled: t.enabled === true,
      idleSeconds: [120, 300, 600].indexOf(t.idleSeconds) !== -1 ? t.idleSeconds : 300,
      recordTitles: t.recordTitles === true,
      rules: Array.isArray(t.rules) ? t.rules.filter(r => r && r.value && r.category) : TIME_TRACK_DEFAULTS.rules
    };
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

  function getUsageDay(dk) {
    let d = usageData.days[dk];
    if (!d || typeof d !== 'object') { d = { apps: {}, titles: {} }; usageData.days[dk] = d; }
    if (!d.apps || typeof d.apps !== 'object') d.apps = {};
    if (!d.titles || typeof d.titles !== 'object') d.titles = {};
    return d;
  }

  // 分类：本应用自身 → 「桌面工作台」；否则按规则顺序匹配（exe 不分大小写、
  // 标题规则对进程友好名做包含匹配），未命中归「其他」。分类在汇总时计算，
  // 规则修改后对历史数据即时生效。
  function usageCategoryOf(exeKey, displayName) {
    if (exeKey === '桌面工作台') return '桌面工作台';
    const cfg = ttSettings();
    const nameL = String(displayName || '').toLowerCase();
    const rules = cfg.rules || [];
    for (let i = 0; i < rules.length; i++) {
      const r = rules[i];
      const v = String(r.value || '').trim().toLowerCase();
      if (!v || !r.category) continue;
      if (r.match === 'title') {
        if (nameL.indexOf(v) !== -1) return r.category;
      } else if (String(exeKey || '').toLowerCase().indexOf(v) !== -1) {
        return r.category;
      }
    }
    return '其他';
  }

  function addUsageSeconds(sample, seconds) {
    try {
      if (!sample || !sample.exe || !(seconds > 0)) return;
      const day = getUsageDay(dateKeyMain());
      const key = String(sample.exe).toLowerCase();
      const rec = day.apps[key] || (day.apps[key] = { name: sample.app || sample.exe, seconds: 0 });
      if (sample.app) rec.name = sample.app;
      rec.seconds = (rec.seconds || 0) + seconds;
      // 长尾合并：单日应用键超过 2000 时，把时长最短的合并进 __other__
      const keys = Object.keys(day.apps);
      if (keys.length > 2000) {
        keys.sort((a, b) => (day.apps[b].seconds || 0) - (day.apps[a].seconds || 0));
        let other = day.apps['__other__'] || (day.apps['__other__'] = { name: '其他', seconds: 0 });
        for (const k of keys.slice(2000)) {
          if (k === '__other__') continue;
          other.seconds += day.apps[k].seconds || 0;
          delete day.apps[k];
        }
      }
      if (ttSettings().recordTitles && sample.title) {
        const tk = (sample.app || sample.exe) + '|' + String(sample.title).slice(0, 120);
        day.titles[tk] = (day.titles[tk] || 0) + seconds;
      }
    } catch (e) { /* ignore */ }
  }

  // PowerShell 辅助脚本：user32 取前台窗口句柄 → 标题 / PID → Get-Process 取进程名与描述
  const USAGE_PS_SCRIPT = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
    "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class FGW{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern int GetWindowTextW(IntPtr h,[MarshalAs(UnmanagedType.LPWStr)]StringBuilder t,int c);[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}'",
    "while ($true) {",
    "  $h = [FGW]::GetForegroundWindow()",
    "  $wpid = [uint32]0",
    "  [FGW]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null",
    "  $sb = New-Object System.Text.StringBuilder 512",
    "  [FGW]::GetWindowTextW($h, $sb, 512) | Out-Null",
    "  $title = $sb.ToString()",
    "  $exe = ''; $app = ''",
    "  if ($wpid -gt 0) { $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue; if ($p) { $exe = $p.ProcessName; $app = $p.Description; if (-not $app) { $app = $exe } } }",
    "  $o = @{ exe = $exe; app = $app; title = $title } | ConvertTo-Json -Compress",
    "  [Console]::Out.WriteLine($o)",
    "  [Console]::Out.Flush()",
    "  Start-Sleep -Seconds 5",
    "}"
  ].join('\n') + '\n';

  function startUsageHelper() {
    if (process.platform !== 'win32' || usageHelper) return;
    try {
      usageHelperBuf = '';
      // 说明：实测 -Command -（stdin 传脚本）对本脚本会静默卡住，故改用 -EncodedCommand
      // （UTF-16LE base64，脚本约 2KB，远小于命令行长度限制），效果等同且无临时文件
      usageHelper = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(USAGE_PS_SCRIPT, 'utf16le').toString('base64')], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']
      });
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
            }
          } catch (e) { /* 忽略无法解析的行 */ }
        }
      });
      usageHelper.stderr.on('data', () => { /* 忽略 */ });
      usageHelper.on('exit', () => {
        usageHelper = null;
        // 异常退出（含被看门狗击杀）后由 reconcileUsage 自动拉起
        if (usageTrackingEnabled()) setTimeout(() => { try { reconcileUsage(); } catch (e) { /* ignore */ } }, 1000);
      });
    } catch (e) {
      usageHelper = null;
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
    return {
      supported: process.platform === 'win32',
      enabled: false,
      dayCount: 0,
      today: { total: 0, categories: [], topApps: [] },
      daily: [],
      topApps: [],
      categories: [],
      topTitles: [],
      pomodoros: { today: 0, week: 0 }
    };
  }

  function usageSummary(days) {
    if (!usageLoaded) loadUsageData();
    const cfg = ttSettings();
    const out = emptyUsageSummary();
    out.enabled = cfg.enabled;
    if (process.platform !== 'win32') return out;
    const today = dateKeyMain();

    // 近 days 天（含今天）逐日聚合
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayKeys.push(dateKeyMain(d));
    }
    const appAgg = new Map();
    const catAgg = new Map();
    const todayCats = new Map();
    const todayApps = [];
    let todayTotal = 0;
    out.daily = dayKeys.map(dk => {
      const day = usageData.days[dk];
      let total = 0;
      if (day && day.apps) {
        for (const k of Object.keys(day.apps)) {
          const rec = day.apps[k] || {};
          const sec = rec.seconds || 0;
          total += sec;
          const name = rec.name || k;
          const cat = usageCategoryOf(k, name);
          const prev = appAgg.get(k);
          if (prev) prev.seconds += sec;
          else appAgg.set(k, { name, seconds: sec });
          catAgg.set(cat, (catAgg.get(cat) || 0) + sec);
          if (dk === today) {
            todayTotal += sec;
            todayCats.set(cat, (todayCats.get(cat) || 0) + sec);
            todayApps.push({ key: k, name, seconds: sec });
          }
        }
      }
      return { date: dk, total };
    });

    const sortBySec = (arr) => arr.sort((a, b) => b.seconds - a.seconds);
    const appList = sortBySec(Array.from(appAgg.values())).slice(0, 10);
    out.today.total = todayTotal;
    out.today.categories = sortBySec(Array.from(todayCats.entries()).map(([name, seconds]) => ({ name, seconds })));
    out.today.topApps = sortBySec(todayApps).slice(0, 10);
    out.topApps = appList;
    out.categories = sortBySec(Array.from(catAgg.entries()).map(([name, seconds]) => ({ name, seconds })));

    if (cfg.recordTitles) {
      const tAgg = new Map();
      for (const dk of dayKeys) {
        const day = usageData.days[dk];
        if (!day || !day.titles) continue;
        for (const k of Object.keys(day.titles)) {
          tAgg.set(k, (tAgg.get(k) || 0) + (day.titles[k] || 0));
        }
      }
      out.topTitles = sortBySec(Array.from(tAgg.entries()).map(([k, seconds]) => {
        const i = k.indexOf('|');
        return { app: k.slice(0, i), title: k.slice(i + 1), seconds };
      })).slice(0, 10);
    }

    out.dayCount = Object.keys(usageData.days).filter(k => {
      const day = usageData.days[k];
      return day && day.apps && Object.keys(day.apps).length > 0;
    }).length;

    // 番茄钟标注（弱耦合：只读主数据里的每日完成数）
    try {
      const pd = loadStore()._pomoDone || {};
      let week = 0;
      for (const dk of dayKeys) week += pd[dk] || 0;
      out.pomodoros = { today: pd[today] || 0, week };
    } catch (e) { out.pomodoros = { today: 0, week: 0 }; }

    return out;
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
      if (!b64 || b64.length > 40e6) { showShotResult(''); return { ok: false }; } // 尺寸上限：约 30MB 的 Base64
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
  // 月末安全顺延：目标月份天数不足时钳制到当月最后一天（如 1-31 → 2 月末）
  function advanceMonthClamped(d) {
    const day = d.getDate();
    const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate(); // 目标月的天数
    d.setDate(1);          // 先回到 1 号，避免 setMonth 造成天数溢出
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, last));
    return d;
  }

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
            case 'monthly': advanceMonthClamped(next); break;
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
      if (changed) { saveStore(d); broadcastChanged(); }
    } catch (e) { /* ignore */ }
  }

  // -----------------------------------------------------------
  // 自动文件整理规则：监控文件夹里的文件按规则移动到目标目录
  // -----------------------------------------------------------
  const organizeSeen = new Set(); // 已扫描过的文件名，避免对不匹配文件反复尝试

  function uniqueTargetPath(dest) {
    if (!fs.existsSync(dest)) return dest;
    const p = path.parse(dest);
    for (let i = 1; i < 999; i++) {
      const cand = path.join(p.dir, `${p.name} (${i})${p.ext}`);
      if (!fs.existsSync(cand)) return cand;
    }
    return dest;
  }

  function runAutoOrganize() {
    try {
      const cfg = (loadStore().settings || {}).autoOrganize || {};
      if (cfg.enabled !== true) return { moved: [], errors: [] };
      const watch = String(cfg.watch || '').trim();
      const rules = (Array.isArray(cfg.rules) ? cfg.rules : []).filter(r => r && r.value && typeof r.to === 'string' && path.isAbsolute(r.to));
      if (!watch || !fs.existsSync(watch) || !rules.length) return { moved: [], errors: [] };

      const moved = [];
      const errors = [];
      const entries = fs.readdirSync(watch, { withFileTypes: true });
      for (const ent of entries) {
        if (ent.isDirectory()) continue; // 只整理文件，不递归
        const src = path.join(watch, ent.name);
        if (organizeSeen.has(src)) continue;

        let targetDir = null;
        const nameL = ent.name.toLowerCase();
        const ext = path.extname(ent.name).replace(/^\./, '').toLowerCase();
        for (const r of rules) {
          const v = String(r.value || '').trim().toLowerCase();
          if (!v) continue;
          if (r.type === 'ext') { if (v === ext) { targetDir = r.to; break; } }
          else { if (nameL.indexOf(v) !== -1) { targetDir = r.to; break; } } // kw 关键词
        }
        if (!targetDir) { organizeSeen.add(src); continue; }
        try {
          if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
          const dest = uniqueTargetPath(path.join(targetDir, ent.name));
          fs.renameSync(src, dest);
          moved.push({ from: src, to: dest });
          organizeSeen.add(src);   // 成功后记住，避免反复尝试
        } catch (e) {
          organizeSeen.delete(src); // 失败时移出，下次轮询可重试
          errors.push({ file: ent.name, msg: String((e && e.message) || e) });
        }
      }
      return { moved, errors };
    } catch (e) {
      return { moved: [], errors: [{ msg: String((e && e.message) || e) }] };
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
        if (t._remindedToday === tk) return;      // 今天已提醒过
        t._remindedToday = tk;
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
      if (s._dailyRemindDate === tk) return;                 // 今天已汇总过
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
      s._dailyRemindDate = tk;
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
    const data = loadStore();
    // 时间统计设置为老用户补默认值（浅合并不会覆盖既有字段）
    if (!data.settings || typeof data.settings.timeTrack !== 'object' || !Array.isArray(data.settings.timeTrack.rules)) {
      if (!data.settings) data.settings = defaultData().settings;
      data.settings.timeTrack = JSON.parse(JSON.stringify(TIME_TRACK_DEFAULTS));
    }
    return data;
  });

  ipcMain.handle('store:save', (event, data) => {
    if (!isTrustedSender(event)) throw new Error('forbidden');
    const ok = saveStore(data);
    reconcileUsage(); // 时间统计开关等设置可能变化，立即自愈
    reconcileWidgets(); // 桌面小组件开关可能变化
    return ok;
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
    if (!isTrustedSender(event)) return { moved: [], errors: [] };
    organizeSeen.clear(); // 手动整理：重扫全部
    return runAutoOrganize();
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
  function resolveLnkViaPs(p) {
    return new Promise((resolve) => {
      try {
        const cmd = "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('" + String(p).replace(/'/g, "''") + "'); if ($s.TargetPath) { $s.TargetPath }";
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' + cmd],
          { windowsHide: true, encoding: 'utf8', timeout: 5000 }, (err, stdout) => {
            try {
              if (err || !stdout) return resolve(null);
              const t = String(stdout).replace(/^\uFEFF/, '').trim();
              resolve(t && path.isAbsolute(t) && fs.existsSync(t) ? t : null);
            } catch (e) { resolve(null); }
          });
      } catch (e) { resolve(null); }
    });
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
  function extractIconViaPs(p) {
    return new Promise((resolve) => {
      try {
        const outPng = path.join(os.tmpdir(), 'wbench-icon-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6) + '.png');
        const ps = [
          'try {',
          '  Add-Type -AssemblyName System.Drawing',
          "  $ico = [System.Drawing.Icon]::ExtractAssociatedIcon('" + String(p).replace(/'/g, "''") + "')",
          "  $ico.ToBitmap().Save('" + outPng.replace(/\\/g, '\\\\') + "', [System.Drawing.Imaging.ImageFormat]::Png)",
          "  Write-Output 'OK'",
          "} catch { Write-Output 'FAIL' }"
        ].join('; ');
        execFile('powershell.exe', ['-NoProfile', '-Command', ps], { windowsHide: true, encoding: 'utf8', timeout: 8000 }, (err) => {
          try {
            if (err || !fs.existsSync(outPng)) return resolve(null);
            const buf = fs.readFileSync(outPng);
            fs.rmSync(outPng, { force: true });
            resolve(buf.length > 120 ? 'data:image/png;base64,' + buf.toString('base64') : null);
          } catch (e) { resolve(null); }
        });
      } catch (e) { resolve(null); }
    });
  }

  // 多级尝试取文件图标：
  // lnk → 解析目标（readShortcutLink → PowerShell 兜底）→ 常规提取 → 占位图检测 → GDI+ 兜底。
  // 「lnk 自身的图标」永远是通用占位图，绝不作为有效结果返回（失败返回 null，渲染层显示字母头像）。
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
          if (durl !== generic) return durl;   // 真图标
        }
      } catch (e) { /* ignore */ }
      // 目标解析失败的 lnk：任何图标都只会是通用占位图 → 返回 null（渲染层字母头像）
      if (isLnk && !resolved) return null;
      // 第二级：GDI+ ExtractAssociatedIcon（对 PNG 压缩图标等特殊 exe 图标资源有效）
      const viaPs = await extractIconViaPs(source);
      if (viaPs) return viaPs;
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
      JSON.parse(content); // 校验合法性
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
    app.setAppUserModelId('com.workbench.desktop');
    autoRestore(); // 先于窗口/渲染进程就绪时尝试恢复损坏主数据，确保本次启动即显示恢复结果
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
    try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
  });

  app.on('window-all-closed', (e) => {
    // 不退出：常驻托盘
  });
}