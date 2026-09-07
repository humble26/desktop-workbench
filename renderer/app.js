'use strict';

(function () {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const api = window.api;

  // Windows 绝对路径判断（渲染进程无 Node path 模块）
  function isAbsPath(p) { return typeof p === 'string' && (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\')); }

  // 导入数据做结构清洗：损坏字段用空数组兜底，避免渲染期 forEach/filter 崩溃
  function sanitizeImported(imp) {
    const s = (imp && typeof imp === 'object' && !Array.isArray(imp)) ? imp : {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
    const out = {
      todos: arr(s.todos).filter(t => t && typeof t === 'object'),
      notes: arr(s.notes).filter(n => n && typeof n === 'object'),
      checkins: arr(s.checkins).filter(c => c && typeof c === 'object'),
      shortcuts: arr(s.shortcuts).filter(x => x && typeof x === 'object'),
      groups: arr(s.groups).filter(g => g && typeof g === 'object'),
      settings: obj(s.settings),
      profile: obj(s.profile)
    };
    out.todos.forEach(t => { if (!Array.isArray(t.subtasks)) t.subtasks = []; if (!Array.isArray(t.doneHistory)) t.doneHistory = []; });
    out.groups.forEach(g => { if (!Array.isArray(g.items)) g.items = []; else g.items = g.items.filter(it => it && typeof it === 'object'); });
    return out;
  }

  // 合并导入设置：autoOrganize 仅当给出合法绝对路径 + 规则数组时采纳，否则保留现有，防误写作任意文件移动
  function sanitizeSettingsMerge(prev, imp) {
    const next = Object.assign({}, prev, imp);
    const ao = imp.autoOrganize;
    if (ao && typeof ao === 'object') {
      const validWatch = typeof ao.watch === 'string' && ao.watch.trim() && isAbsPath(ao.watch);
      const validRules = Array.isArray(ao.rules) && ao.rules.every(r => r && typeof r.value === 'string' && r.value && isAbsPath(r.to));
      if (validWatch && validRules) {
        next.autoOrganize = { enabled: !!ao.enabled, watch: ao.watch.trim(), rules: ao.rules.map(r => ({ enabled: !!r.enabled, type: r.type, value: r.value, to: r.to })) };
      } else {
        next.autoOrganize = (prev && prev.autoOrganize) || { enabled: false, watch: '', rules: [] };
      }
    }
    return next;
  }

  // ---------------------------------------------------------------
  // 图标（Lucide 风格 stroke，24×24）
  // ---------------------------------------------------------------
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v2"/><path d="M3 7v11a2 2 0 0 0 2 2h12l3-7H5"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    'check-square': '<rect x="3" y="3" width="18" height="18" rx="4"/><path d="m8 12 3 3 5-6"/>',
    note: '<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    flame: '<path d="M12 3c1 4-4 5.5-4 10a4 4 0 0 0 8 0c0-1.5-.6-2.7-1.5-4C13 11 13 7 12 3z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
    pin: '<path d="M12 17v5"/><path d="M9 4h6l1 7 2 2H6l2-2z"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M20 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h5"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    minimize: '<path d="M5 12h14"/>',
    maximize: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
    restore: '<rect x="5" y="8" width="11" height="11" rx="2"/><path d="M8 5h9a2 2 0 0 1 2 2v9"/>',
    shrink: '<path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/>',
    expand: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    repeat: '<path d="M3 12a9 9 0 0 1 15-6.7L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15 6.7L3 16"/><path d="M3 21v-5h5"/>',
    bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    download: '<path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/>',
    upload: '<path d="M12 21V9"/><path d="m7 13 5-5 5 5"/><path d="M5 3h14"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
    calendar: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M16 2v4M8 2v4M3 9h18"/><path d="M8 14h.01M12 14h.01M16 14h.01M8 18h.01M12 18h.01"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    timer: '<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2"/><path d="M10 2h4"/>',
    bar: '<path d="M4 20h16"/><path d="M6 20v-8M11 20V5M16 20v-6"/>',
    play: '<path d="m7 4 13 8-13 8z"/>',
    pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
    filter: '<path d="M3 5h18l-7 8v5l-4-2v-3z"/>',
    sort: '<path d="M11 5h10M11 9h7M11 13h4"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    power: '<path d="M12 2v10"/><path d="M18.4 6.6a9 9 0 1 1-12.77.04"/>',
    droplet: '<path d="M12 2.7s6.3 6.9 6.3 11.2a6.3 6.3 0 0 1-12.6 0C5.7 9.6 12 2.7 12 2.7z"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
    layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5"/>',
    clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2"/>',
    archive: '<rect x="2" y="4" width="20" height="5" rx="1.5"/><path d="M4 9v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><path d="M10 13h4"/>'
  };
  function icon(name, size = 18) {
    const p = ICONS[name] || ICONS.grid;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  // ---------------------------------------------------------------
  // 状态与工具
  // ---------------------------------------------------------------
  let state = null;
  const iconCache = new Map();

  const NAV = [
    { id: 'dashboard', icon: 'home', label: '首页' },
    { id: 'shortcuts', icon: 'grid', label: '快捷入口' },
    { id: 'files', icon: 'folder', label: '文件整理' },
    { id: 'todos', icon: 'check-square', label: '待办' },
    { id: 'calendar', icon: 'calendar', label: '日历' },
    { id: 'notes', icon: 'note', label: '便签' },
    { id: 'checkins', icon: 'flame', label: '打卡' },
    { id: 'pomodoro', icon: 'timer', label: '番茄钟' },
    { id: 'stats', icon: 'bar', label: '数据洞察' },
    { id: 'usage', icon: 'clock', label: '时间统计' },
    { id: 'settings', icon: 'settings', label: '设置' }
  ];

  const ACCENTS = [
    { name: '墨黑', hex: '#2f2e2b', muted: '#efeee8' },
    { name: '蔚蓝', hex: '#2563eb', muted: '#e8f0ff' },
    { name: '苔绿', hex: '#4f7a52', muted: '#e9f2e9' },
    { name: '雾紫', hex: '#7d7195', muted: '#f0eef5' },
    { name: '陶土', hex: '#b5715a', muted: '#f6ece8' }
  ];
  const GROUP_COLORS = ['#6f8f6a', '#5f7a99', '#bd8a4e', '#b5715a', '#7d7195', '#2563eb'];

  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function yesterdayKey() { const d = new Date(); d.setDate(d.getDate() - 1); return dateKey(d); }
  function greetingText() {
    const h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }
  function fileBase(p) { return String(p || '').split(/[\\/]/).pop() || p || ''; }
  function norm(pathStr) { return String(pathStr || '').replace(/\\/g, '/'); }

  // ---------------------------------------------------------------
  // 持久化
  // ---------------------------------------------------------------
  async function save(silent) {
    try {
      const r = await api.save(state);
      if (r === false) { if (!silent) toast('保存失败：数据未能写入磁盘'); return false; }
      return true;
    } catch (e) { if (!silent) toast('保存失败'); return false; }
  }
  function normalizeCheckins() {
    const tk = dateKey();
    const yk = yesterdayKey();
    state.checkins.forEach(c => {
      if (c.last === tk) { /* keep */ }
      else if (c.last === yk) { c.done = false; }
      else { c.done = false; c.streak = 0; }
    });
  }

  // ---------------------------------------------------------------
  // Toast / Modal / Context menu
  // ---------------------------------------------------------------
  function toast(msg) {
    const w = $('#toasts');
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = msg;
    w.appendChild(t);
    setTimeout(() => { t.remove(); }, 2600);
  }
  function modal(html) {
    const root = $('#modalRoot');
    root.innerHTML = `<div class="overlay" id="ovl"><div class="modal">${html}</div></div>`;
    const ovl = $('#ovl');
    ovl.addEventListener('mousedown', e => { if (e.target === ovl) closeModal(); });
    return ovl;
  }
  function closeModal() { $('#modalRoot').innerHTML = ''; }
  let ctxEl = null;
  function closeCtx() { if (ctxEl) { ctxEl.remove(); ctxEl = null; } }
  function ctxmenu(items, x, y) {
    closeCtx();
    const m = document.createElement('div');
    m.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:90;background:var(--surface-card);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow-overlay);padding:6px;min-width:150px;`;
    items.forEach(it => {
      const b = document.createElement('button');
      b.style.cssText = `display:flex;align-items:center;gap:9px;width:100%;border:none;background:transparent;padding:9px 12px;border-radius:8px;font-size:13px;color:var(--text);text-align:left;`;
      b.innerHTML = it.icon ? (it.icon + esc(it.label)) : esc(it.label);
      b.addEventListener('mouseenter', () => { b.style.background = it.danger ? 'var(--danger-muted)' : 'var(--surface-nested)'; if (it.danger) b.style.color = 'var(--danger)'; });
      b.addEventListener('mouseleave', () => { b.style.background = 'transparent'; b.style.color = it.danger ? 'var(--danger)' : 'var(--text)'; });
      b.addEventListener('click', () => { closeCtx(); it.onClick(); });
      m.appendChild(b);
    });
    document.body.appendChild(m);
    ctxEl = m;
    const r = m.getBoundingClientRect();
    if (r.right > innerWidth) m.style.left = (innerWidth - r.width - 8) + 'px';
    if (r.bottom > innerHeight) m.style.top = (innerHeight - r.height - 8) + 'px';
  }
  document.addEventListener('mousedown', e => { if (ctxEl && !ctxEl.contains(e.target)) closeCtx(); });
  document.addEventListener('contextmenu', e => { e.preventDefault(); });

  // ---------------------------------------------------------------
  // 文件图标（缓存）与字母头像兜底
  // ---------------------------------------------------------------
  async function fileIcon(p, type) {
    if (type === 'folder') return null; // 用 SVG 文件夹图标
    if (iconCache.has(p)) return iconCache.get(p);
    let d = null;
    try { d = await api.getIcon(p); } catch (e) { d = null; }
    if (d) iconCache.set(p, d); // 失败不缓存，下次渲染自动重试
    return d;
  }

  function avaHtml(name) {
    const text = String(name || '').trim();
    const ch = (text.charAt(0).toUpperCase() || '?');
    const palette = ['#6f8f6a', '#5f7a99', '#bd8a4e', '#b5715a', '#7d7195', '#2563eb'];
    let h = 0;
    for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return `<span class="shop-ava" style="background:${palette[h % palette.length]}">${esc(ch)}</span>`;
  }

  // ---------------------------------------------------------------
  // 路由与主渲染
  // ---------------------------------------------------------------
  function renderNav() {
    const nav = $('#nav');
    nav.innerHTML = NAV.map(n => {
      const act = state.view === n.id ? ' active' : '';
      return `<div class="navi${act}" data-nav="${n.id}">${icon(n.icon, 18)}<span>${esc(n.label)}</span></div>`;
    }).join('');
  }

  function titleOf(id) { const n = NAV.find(x => x.id === id); return n ? n.label : ''; }

  async function render() {
    normalizeCheckins();
    applyAccent();
    renderNav();
    const view = $('#view');
    const id = state.view || 'dashboard';
    if (id === 'dashboard') renderDashboard(view);
    else if (id === 'shortcuts') await renderShortcuts(view);
    else if (id === 'files') await renderFiles(view);
    else if (id === 'todos') renderTodos(view);
    else if (id === 'calendar') renderCalendar(view);
    else if (id === 'notes') renderNotes(view);
    else if (id === 'checkins') renderCheckins(view);
    else if (id === 'pomodoro') renderPomodoro(view);
    else if (id === 'stats') await renderStats(view);
    else if (id === 'usage') await renderUsage(view);
    else if (id === 'settings') renderSettings(view);
    syncPin();
    syncGlass();
  }

  function themePref() { return state.settings.theme || 'light'; }
  function prefersDark() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  function isDark() {
    const t = themePref();
    if (t === 'dark') return true;
    if (t === 'auto') return !!prefersDark();
    return false;
  }
  function hexA(hex, a) {
    const h = hex.replace('#', '');
    const n = parseInt(h.slice(0, 6), 16);
    if (isNaN(n)) return hex;
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }
  function applyAccent() {
    const dark = isDark();
    document.documentElement.classList.toggle('dark', dark);
    const chosen = ACCENTS.find(x => x.hex === state.settings.accent);
    const a = chosen || ACCENTS[0];
    const r = document.documentElement.style;
    if (dark && a.hex === '#2f2e2b') {
      // 深色下墨黑主色改为浅中性，保证按钮可见
      r.setProperty('--accent', '#ccd1db');
      r.setProperty('--accent-muted', 'rgba(204,209,219,.14)');
      r.setProperty('--on-accent', '#1b1e26');
    } else {
      r.setProperty('--accent', a.hex);
      r.setProperty('--accent-muted', dark ? hexA(a.hex, 0.16) : a.muted);
      r.setProperty('--on-accent', '#ffffff');
    }
  }
  function syncThemeBg() { try { api.applyTheme?.(themePref()).catch(() => {}); } catch (e) { /* ignore */ } }
  function syncPin() {
    const b = $('#pinBtn');
    if (!b) return;
    const on = state.settings.mode === 'top';
    b.classList.toggle('on', on);
    b.innerHTML = icon('pin', 16);
    b.title = on ? '点击取消置顶' : '置顶显示';
  }
  // 毛玻璃背景：仅覆盖桌面模式生效（材质由主进程设置）
  function syncGlass() {
    const on = !!state.settings.glass && currentLayout() !== 'window';
    document.body.classList.toggle('glass', on);
    try { api.setGlass?.(on).catch(() => { }); } catch (e) { /* ignore */ }
  }

  function currentLayout() { return state.settings.layout === 'window' ? 'window' : 'overlay'; }
  function syncLayout() {
    document.body.classList.toggle('layout-window', currentLayout() === 'window');
    const lb = $('#layoutBtn');
    if (lb) {
      const win = currentLayout() === 'window';
      lb.innerHTML = icon(win ? 'expand' : 'shrink', 16);
      lb.title = win ? '切换为覆盖桌面' : '切换为窗口模式';
    }
  }
  function syncMaximized(max) {
    const b = $('#maxBtn');
    if (!b) return;
    b.innerHTML = icon(max ? 'restore' : 'maximize', 15);
    b.title = max ? '还原' : '最大化';
  }
  function initWinControls() {
    const sb = $('#searchBtn'); if (sb) sb.innerHTML = icon('search', 15);
    const hide = $('#hideBtn'); if (hide) hide.innerHTML = icon('chevron-down', 16);
    const close = $('#closeBtn'); if (close) close.innerHTML = icon('x', 16);
    const min = $('#minBtn'); if (min) min.innerHTML = icon('minimize', 16);
    const max = $('#maxBtn'); if (max) max.innerHTML = icon('maximize', 15);
    syncPin();
    syncLayout();
  }

  function header(id, extra = '') {
    const n = NAV.find(x => x.id === id);
    return `<div class="header"><h2>${esc(n.label)}</h2><div class="spacer"></div>${extra}</div>`;
  }

  // ---------------------------------------------------------------
  // 首页
  // ---------------------------------------------------------------
  const CHIP = { 待办: 'c1', 待办清单: 'c1', 打卡: 'c4', 习惯打卡: 'c4', 快捷入口: 'c2', 文件整理: 'c5', 便签: 'c3', 番茄钟: 'c2', 数据洞察: 'c5', 设置: 'c2', 今日已完成待办: 'c1', 今日打卡: 'c4', 累计便签: 'c5' };
  function chip(ic, key, size) {
    const cls = CHIP[key] || 'c2';
    return `<div class="ic chip ${cls}"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${icon(ic, 18)}</div>`;
  }
  function renderDashboard(v) {
    const open = state.todos.filter(t => !t.done).length;
    const doneToday = state.checkins.filter(c => c.done).length;
    const fileCount = state.groups.reduce((s, g) => s + g.items.length, 0);
    v.innerHTML = `
      <div class="greet">
        <span class="hi">${esc(greetingText())}，${esc(state.profile.name || '朋友')}</span>
        <div class="sub">今天也要把生活和工作安排得井井有条。按 <b>Win+Alt+Space</b> 可随时显示 / 隐藏工作台。</div>
        <div class="clock"><div class="t" id="clock">--:--</div><div class="d" id="clockd"></div></div>
      </div>
      <div class="stats">
        <div class="stat" data-nav="todos">${chip('check-square', '待办')}<div class="v">${open}</div><div class="l">待办未完成</div></div>
        <div class="stat" data-nav="checkins">${chip('flame', '打卡')}<div class="v">${doneToday}</div><div class="l">今日已打卡</div></div>
        <div class="stat" data-nav="shortcuts">${chip('grid', '快捷入口')}<div class="v">${state.shortcuts.length}</div><div class="l">快捷入口</div></div>
        <div class="stat" data-nav="files">${chip('folder', '文件整理')}<div class="v">${fileCount}</div><div class="l">已整理文件</div></div>
      </div>
      <div class="sec-title">快速开始<span class="plus" data-act="quick" title="更多"></span></div>
      <div class="mod-grid">
        ${quickCard('shortcuts', '快捷入口', '常用应用一键启动')}
        ${quickCard('files', '文件整理', '把文件按分组收纳')}
        ${quickCard('todos', '待办清单', '记录今天要完成的事')}
        ${quickCard('notes', '便签灵感', '随手记下想法')}
        ${quickCard('checkins', '习惯打卡', '坚持就是胜利')}
        ${quickCard('pomodoro', '番茄钟', '专注 25 分钟')}
        ${quickCard('stats', '数据洞察', '看看你的进度')}
        ${quickCard('settings', '设置', '外观与启动项')}
      </div>`;
    updateClock();
  }
  function quickCard(id, name, desc) {
    return `<div class="modcard" data-nav="${id}"><div class="mh">${chip(name === '便签灵感' ? 'note' : (NAV.find(n => n.id === id) || {}).icon || 'grid', name === '便签灵感' ? '便签' : name, 38)}<div class="mt"><div class="mn">${esc(name)}</div><div class="md">${esc(desc)}</div></div></div></div>`;
  }
  let clockTimer = null;
  function updateClock() {
    if (clockTimer) clearInterval(clockTimer);
    function tick() {
      const d = new Date();
      const t = $('#clock'); if (t) t.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
      const dd = $('#clockd');
      if (dd) {
        const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
        dd.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${wk}`;
      }
    }
    tick();
    clockTimer = setInterval(tick, 1000 * 10);
  }

  // ---------------------------------------------------------------
  // 快捷入口
  // ---------------------------------------------------------------
  async function renderShortcuts(v) {
    v.innerHTML = `
      ${header('shortcuts', `<button class="btn" data-act="add-shortcut">${icon('plus', 16)} 添加快捷方式</button>`)}
      <div class="shop-grid">
        ${state.shortcuts.map(s => {
          const nm = esc(s.name || fileBase(s.path));
          return `<div class="shop" data-act="open-shortcut" data-id="${s.id}" title="${esc(s.path)}">
            <div class="ic" id="ic-${s.id}"><img alt="" data-id="${s.id}" /></div>
            <div class="nm">${nm}</div>
            <button class="x" data-act="del-shortcut" data-id="${s.id}" title="移除">${icon('x', 14)}</button>
          </div>`;
        }).join('')}
        <div class="shop add" data-act="add-shortcut"><div class="addic">${icon('plus', 24)}</div><div class="nm">添加快捷方式</div></div>
      </div>`;
    for (const s of state.shortcuts) {
      try {
        const img = $(`#ic-${s.id} img`);
        if (!img) continue;
        let d = s.icon;
        if (!d) d = await fileIcon(s.path, 'file');
        if (d) {
          img.src = d;
          if (!s.icon) { s.icon = d; save(true); } // 获取成功后持久化，重启无需重取
        } else {
          img.outerHTML = avaHtml(s.name || fileBase(s.path));
        }
      } catch (e) { /* 单个图标失败不影响其他 */ }
    }
  }

  async function addShortcut() {
    const p = await api.pickApp();
    if (!p) return;
    const info = await api.resolveItem(p);
    const name = info.name ? info.name.replace(/\.(exe|lnk)$/i, '') : fileBase(p);
    state.shortcuts.push({ id: uid(), name, path: p, icon: info.icon || null });
    await save();
    render();
  }

  // ---------------------------------------------------------------
  // 文件整理
  // ---------------------------------------------------------------
  async function renderFiles(v) {
    v.innerHTML = `
      ${header('files', `<button class="btn" data-act="add-group">${icon('plus', 16)} 新建分组</button>`)}
      <div class="drag-hint">${icon('folder', 14)} 可直接将文件或文件夹拖拽到任意分组中收纳</div>
      <div class="fence-grid">
        ${state.groups.map(g => `
          <div class="fence" data-gid="${g.id}">
            <div class="fh">
              <span class="dot" style="background:${esc(g.color)}"></span>
              <span class="nm">${esc(g.name)}</span>
              <button data-act="group-add-file" data-id="${g.id}" title="添加文件">${icon('folder-open', 16)}</button>
              <button data-act="group-add-folder" data-id="${g.id}" title="添加文件夹">${icon('folder', 15)}</button>
              <button class="del" data-act="del-group" data-id="${g.id}" title="删除分组">${icon('trash', 16)}</button>
            </div>
            <div class="items">
              ${g.items.map(it => itemHtml(g, it)).join('')}
            </div>
          </div>`).join('')}
        <div class="fence add" data-act="add-group">${icon('plus', 24)}&nbsp;新建分组</div>
      </div>`;
    // 异步补图标
    for (const g of state.groups) {
      for (const it of g.items) {
        try {
          const img = $(`#fi-${g.id}-${it.id}`);
          if (!img) continue;
          if (it.type === 'folder') { img.outerHTML = `<span class="folder">${icon('folder', 26)}</span>`; continue; }
          const d = await fileIcon(it.path, it.type);
          if (d) img.src = d;
          else img.outerHTML = avaHtml(it.name || fileBase(it.path));
        } catch (e) { /* 单个图标失败不影响其他 */ }
      }
    }
  }
  function itemHtml(g, it) {
    const nm = esc(it.name || fileBase(it.path));
    const broken = it.broken ? ' broken' : '';
    return `<div class="fitem${broken}" data-act="open-item" data-gid="${g.id}" data-id="${it.id}" title="${esc(it.path)}"
      data-context="item">
      <div class="ic"><img id="fi-${g.id}-${it.id}" alt="" /></div>
      <div class="nm">${nm}</div>
      <button class="x" data-act="del-item" data-gid="${g.id}" data-id="${it.id}" title="从分组移除">${icon('x', 12)}</button>
    </div>`;
  }

  async function addGroup() {
    const name = await promptText('新建分组', '分组名称', '新分组');
    if (name === null) return;
    state.groups.push({ id: uid(), name, color: GROUP_COLORS[state.groups.length % GROUP_COLORS.length], items: [] });
    await save();
    render();
  }
  function findGroup(id) { return state.groups.find(g => g.id === id); }
  async function addItemsToGroup(gid, paths) {
    const g = findGroup(gid); if (!g) return;
    for (const p of paths) {
      const info = await api.resolveItem(p);
      g.items.push({ id: uid(), type: info.type, path: p, name: info.name, broken: info.broken });
    }
    await save();
    render();
  }

  // ---------------------------------------------------------------
  // 待办
  // ---------------------------------------------------------------
  function lvName(lv) { return lv === 'high' ? '高' : lv === 'mid' ? '中' : '低'; }
  function prioWeight(lv) { return lv === 'high' ? 0 : lv === 'mid' ? 1 : 2; }
  function filterName(k) { return k === 'done' ? '已完成' : k === 'today' ? '今天' : '全部'; }

  const REPEATS = [
    { key: 'none', label: '不重复' },
    { key: 'daily', label: '每天' },
    { key: 'weekly', label: '每周' },
    { key: 'monthly', label: '每月' },
    { key: 'yearly', label: '每年' }
  ];
  function repeatLabel(k) { const r = REPEATS.find(x => x.key === k); return r ? r.label : ''; }
  const repeatUnits = { daily: '天', weekly: '周', monthly: '月', yearly: '年' };
  function repeatSub(k) { return repeatUnits[k] ? '每' + repeatUnits[k] : ''; }
  function advanceMonthClamped(d) {
    const day = d.getDate();
    const last = new Date(d.getFullYear(), d.getMonth() + 2, 0).getDate(); // 目标月的天数
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, last));
    return d;
  }
  function advanceRepeat(t) {
    const next = new Date(t.due + 'T00:00:00');
    switch (t.repeat) {
      case 'daily': next.setDate(next.getDate() + 1); break;
      case 'weekly': next.setDate(next.getDate() + 7); break;
      case 'monthly': advanceMonthClamped(next); break;
      case 'yearly': next.setFullYear(next.getFullYear() + 1); break;
      default: return;
    }
    t.due = dateKey(next);
    if (!t.doneHistory) t.doneHistory = [];
    t.doneHistory.push({ done: dateKey(), at: t.dueTime || '' });
    t.done = false;
    t.doneAt = null;
  }

  function dueInfo(t) {
    if (!t.due) return null;
    const tk = dateKey();
    const d = new Date(t.due + 'T00:00:00');
    const today = new Date(tk + 'T00:00:00');
    const diff = Math.round((d - today) / 86400000);
    let text, cls;
    if (diff < 0) { text = '已逾期 ' + (-diff) + ' 天'; cls = 'overdue'; }
    else if (diff === 0) { text = '今天'; cls = 'today'; }
    else if (diff === 1) { text = '明天'; cls = 'upcoming'; }
    else {
      const m = d.getMonth() + 1, day = d.getDate();
      text = `${m}月${day}日`;
      if (d.getFullYear() !== today.getFullYear()) text = `${d.getFullYear()}年${text}`;
      cls = diff <= 7 ? 'upcoming' : 'later';
    }
    if (t.dueTime) text += ' ' + t.dueTime;
    return { text, cls };
  }

  function buildTodoGroups(list) {
    const tk = dateKey();
    const buckets = { overdue: [], today: [], upcoming: [], someday: [] };
    list.forEach(t => {
      if (!t.due) { buckets.someday.push(t); return; }
      const diff = Math.round((new Date(t.due + 'T00:00:00') - new Date(tk + 'T00:00:00')) / 86400000);
      if (diff < 0) buckets.overdue.push(t);
      else if (diff === 0) buckets.today.push(t);
      else if (diff <= 7) buckets.upcoming.push(t);
      else buckets.someday.push(t);
    });
    const sortP = arr => arr.sort((a, b) => prioWeight(a.level) - prioWeight(b.level));
    const defs = [
      { key: 'overdue', title: '已逾期', color: 'var(--danger)', items: buckets.overdue },
      { key: 'today', title: '今天', color: 'var(--accent)', items: buckets.today },
      { key: 'upcoming', title: '即将到期', color: 'var(--module-3)', items: buckets.upcoming },
      { key: 'someday', title: '未安排日期', color: 'var(--text-tertiary)', items: buckets.someday }
    ];
    return defs.filter(g => { sortP(g.items); return g.items.length > 0; });
  }

  function todoItemHtml(t) {
    const due = dueInfo(t);
    const dueTag = due ? `<span class="due ${due.cls}" data-act="edit-todo" data-id="${t.id}">${icon('clock', 12)} ${esc(due.text)}</span>` : '';
    const subs = Array.isArray(t.subtasks) ? t.subtasks : [];
    const subDone = subs.filter(s => s.done).length;
    let subTag = '';
    if (subs.length) {
      subTag = subDone === subs.length
        ? `<div class="tb-sub ok" data-act="edit-todo" data-id="${t.id}">${icon('check', 11)} ${subs.length} 项子任务已完成</div>`
        : `<div class="tb-sub" data-act="edit-todo" data-id="${t.id}">${icon('list', 11)} ${subDone}/${subs.length} 项子任务</div>`;
    }
    const repeatTag = t.repeat && t.repeat !== 'none' ? `<span class="due repeat" data-act="edit-todo" data-id="${t.id}">${icon('repeat', 12)} ${esc(repeatLabel(t.repeat))}</span>` : '';
    const noteTag = t.note ? `<div class="tb-note" data-act="edit-todo" data-id="${t.id}">${esc(t.note)}</div>` : '';
    return `<div class="todo ${t.done ? 'isdone' : ''}">
      <div class="chk ${t.done ? 'on' : ''}" data-act="toggle-todo" data-id="${t.id}">${icon('check', 14)}</div>
      <div class="tbd">
        <div class="tb-title ${t.done ? 'done' : ''}" data-act="edit-todo" data-id="${t.id}">${esc(t.text)}</div>
        ${noteTag}
        ${subTag}
      </div>
      ${dueTag}
      ${repeatTag}
      <span class="lv ${esc(t.level)}" data-act="edit-todo" data-id="${t.id}">${esc(lvName(t.level))}</span>
      <button class="del" data-act="del-todo" data-id="${t.id}">${icon('trash', 16)}</button>
    </div>`;
  }

  function renderTodos(v) {
    const total = state.todos.length;
    const doneList = state.todos.filter(t => t.done);
    const openList = state.todos.filter(t => !t.done);
    const doneN = doneList.length;
    const filter = state._todoFilter || 'all';

    let groups = [];
    if (filter === 'done') {
      if (doneList.length) groups = [{ key: 'done', title: '已完成', color: 'var(--module-1)', items: doneList.slice().sort((a, b) => (b.doneAt || '').localeCompare(a.doneAt || '')) }];
    } else {
      let src = openList;
      if (filter === 'today') src = openList.filter(t => t.due && t.due <= dateKey());
      groups = buildTodoGroups(src);
      if (filter === 'all' && doneList.length) groups.push({ key: 'done', title: '已完成', color: 'var(--module-1)', items: doneList });
    }

    const pct = total ? Math.round(doneN / total * 100) : 0;
    v.innerHTML = `
      ${header('todos')}
      <div class="todo-banner">
        <div class="todo-progress">
          <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
          <div class="meta"><b>${doneN}</b> / ${total} 已完成 · ${openList.length} 项待办</div>
        </div>
        <div class="todo-tabs">
          ${['all', 'today', 'done'].map(k => `<button class="ttab ${filter === k ? 'on' : ''}" data-act="todo-filter" data-filter="${k}">${esc(filterName(k))}</button>`).join('')}
          <div class="spacer"></div>
          ${doneList.length ? `<button class="btn ghost sm" data-act="clear-done">清理已完成</button>` : ''}
        </div>
      </div>
      <div class="todo-add">
        <input type="text" id="todoInput" placeholder="输入待办，回车添加…" />
        <div class="seg" id="lvSel" style="flex:0 0 auto;display:flex;">${['high', 'mid', 'low'].map(lv =>
          `<div class="opt ${(state._todoLv || 'mid') === lv ? 'on' : ''}" data-act="todo-lv" data-lv="${lv}" style="flex:0 0 auto;padding:9px 12px;">${esc(lvName(lv))}</div>`).join('')}</div>
        <input type="date" id="todoDue" title="截止日期" />
        <input type="time" id="todoDueTime" title="截止时间" />
        <select id="todoRepeat" title="重复周期" class="torepeat">
          ${REPEATS.map(r => `<option value="${r.key}" ${(state._todoRepeat || 'none') === r.key ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}
        </select>
        <button class="btn" data-act="add-todo">${icon('plus', 16)} 添加</button>
      </div>
      ${total === 0 ? `<div class="empty"><div class="e">${icon('check-square', 26)}</div>还没有待办，先记下第一件事吧，还可以给它加个截止日期。</div>` :
        groups.length === 0 ? `<div class="empty" style="padding:32px 20px"><div class="e">${icon('check', 26)}</div>这个视图下没有待办。</div>` : ''}
      <div class="todo-list">
        ${groups.map(g => `
          <div class="tgroup">
            <div class="tgroup-title"><span class="dot" style="background:${g.color}"></span>${esc(g.title)}<span class="cnt">${g.items.length}</span></div>
            ${g.items.map(todoItemHtml).join('')}
          </div>`).join('')}
      </div>`;
    $('#todoInput').addEventListener('keydown', e => { if (e.key === 'Enter') addTodo(); });
    const repSel = $('#todoRepeat');
    if (repSel) { repSel.value = state._todoRepeat || 'none'; repSel.onchange = () => { state._todoRepeat = repSel.value; }; }
    if (state._todoDuePreset) { const dInp = $('#todoDue'); if (dInp) dInp.value = state._todoDuePreset; state._todoDuePreset = null; }
    $('#todoInput').focus();
  }

  // ---------------------------------------------------------------
  // 日历视图
  // ---------------------------------------------------------------
  function calendarCell(dk, day, sel, isCur, hasItems) {
    const cls = ['cal-cell', dk === dateKey() ? 'today' : '', dk === sel ? 'sel' : '', !isCur ? 'other' : ''].filter(Boolean).join(' ');
    return `<div class="${cls}" data-cald="${dk}" data-calday="${day}">${hasItems ? '<div class="cal-dot"></div>' : ''}<span class="cal-n">${day}</span></div>`;
  }

  function renderCalendar(v) {
    const now = new Date();
    const base = new Date(now.getFullYear(), now.getMonth(), 1);
    const st = state._calCursor || 0;             // 与"今天"的月偏移
    const viewDate = new Date(base.getFullYear(), base.getMonth() + st, 1);
    const y = viewDate.getFullYear(), m = viewDate.getMonth();
    const today = dateKey();
    const sel = state._calSel || today;
    const week = ['一', '二', '三', '四', '五', '六', '日'];

    const cells = [];
    const firstDow = (new Date(y, m, 1).getDay() + 6) % 7; // 周一为一周第一天
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const prevDays = new Date(y, m, 0).getDate();
    const hasOn = dk => state.todos.some(t => !t.done && t.due === dk);
    const hasDoneOn = dk => state.todos.some(t => t.done && t.due === dk && t.doneAt === dk);

    // 上一月的补位单元格：用 Date 推算，跨年时月份/年份自动正确
    for (let i = 0; i < firstDow; i++) {
      const day = prevDays - firstDow + i + 1;
      const d = new Date(y, m - 1, day);
      const dk = dateKey(d);
      cells.push(calendarCell(dk, day, sel, false, hasOn(dk)));
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const dk = `${y}-${pad(m + 1)}-${pad(d)}`;
      cells.push(calendarCell(dk, d, sel, true, hasOn(dk)));
    }
    // 下一月的补位单元格：同样用 Date 推算，避免 12 月跨年时出现 y-13-xx 这样的无效日期
    let k = 0;
    while (cells.length % 7 !== 0) {
      k++;
      const d = new Date(y, m + 1, k);
      const dk = dateKey(d);
      cells.push(calendarCell(dk, k, sel, false, hasOn(dk)));
    }

    // 选中日期的待办
    const dayTodos = state.todos
      .filter(t => t.due === sel)
      .sort((a, b) => {
        if (!!a.done !== !!b.done) return a.done ? 1 : -1;
        return (a.dueTime || '').localeCompare(b.dueTime || '');
      });
    const doneCount = dayTodos.filter(t => t.done).length;
    const undone = dayTodos.filter(t => !t.done);

    v.innerHTML = `
      ${header('calendar', `<div class="cal-nav">
        <button class="btn ghost sm" data-act="cal-prev" title="上个月">${icon('chevron-left', 16)}</button>
        <span class="cal-title">${y} 年 ${m + 1} 月</span>
        <button class="btn ghost sm" data-act="cal-next" title="下个月">${icon('chevron', 16)}</button>
        <button class="btn ghost sm" data-act="cal-today" title="回到今天">今天</button>
      </div>`)}
      <div class="cal-wrap">
        <div class="cal-panel card">
          <div class="cal-week">${week.map(w => `<span>${w}</span>`).join('')}</div>
          <div class="cal-grid">${cells.join('')}</div>
        </div>
        <div class="cal-side card">
          <div class="cal-side-h">${esc(sel)} 的待办
            <span class="cal-side-count">${doneCount}/${dayTodos.length} 完成</span>
          </div>
          ${dayTodos.length === 0
            ? `<div class="empty" style="padding:36px 14px"><div class="e">${icon('calendar', 24)}</div>这一天没有安排，点击右侧 + 添加待办。</div>
               <button class="btn sm cal-add" data-act="cal-add" data-cald="${sel}">${icon('plus', 14)} 添加待办</button>`
            : `<div class="cal-todos">
                 ${dayTodos.map(t => `
                   <div class="cal-todo ${t.done ? 'isdone' : ''}" data-act="toggle-todo" data-id="${t.id}" title="${t.done ? '标记未完成' : '标记完成'}">
                     <span class="chk ${t.done ? 'on' : ''}">${icon('check', 13)}</span>
                     <div class="ct-txt">
                       <div class="ct-t">${esc(t.text)}</div>
                       ${t.dueTime ? `<div class="ct-tm">${icon('clock', 11)} ${esc(t.dueTime)}</div>` : ''}
                     </div>
                     <span class="lv ${esc(t.level)}">${esc(lvName(t.level))}</span>
                     <button class="x" data-act="edit-todo" data-id="${t.id}" title="编辑">${icon('chevron', 14)}</button>
                   </div>`).join('')}
               </div>`
          }
        </div>
      </div>`;
  }

  function addTodo() {
    const inp = $('#todoInput'); if (!inp) return;
    const text = inp.value.trim();
    if (!text) { toast('请输入内容'); return; }
    const due = ($('#todoDue') || {}).value || '';
    const dueTime = ($('#todoDueTime') || {}).value || '';
    const rep = ($('#todoRepeat') || {}).value || state._todoRepeat || 'none';
    state._todoRepeat = rep;
    if (rep !== 'none' && !due) { toast('重复任务需先设置截止日期'); $('#todoDue').focus(); return; }
    state.todos.unshift({ id: uid(), text, level: state._todoLv || 'mid', done: false, date: dateKey(), due, dueTime, repeat: rep, note: '', subtasks: [], doneHistory: [] });
    save();
    render();
  }

  // 从日历"添加待办"跳转到待办页并预填截止日期
  function goToAddTodo(sel) {
    state._todoDuePreset = sel || dateKey();
    state.view = 'todos';
    render();
  }

  function todoModal(t) {
    t = t || { text: '', level: 'mid', due: '', dueTime: '', note: '', repeat: 'none', subtasks: [] };
    const subs = t.subtasks && Array.isArray(t.subtasks) ? t.subtasks.slice() : [];
    let lv = t.level || 'mid';
    let repeat = t.repeat || 'none';
    modal(`
      <h3>${t.id ? '编辑待办' : '新建待办'}</h3>
      <div class="sub">修改内容、优先级、重复、备注或子任务</div>
      <div class="drawer-title"><b>内容</b></div>
      <input type="text" id="tdText" value="${esc(t.text)}" />
      <div class="modal-hr"></div>
      <div class="modal-grid">
        <div class="fg">
          <div class="drawer-title">优先级</div>
          <div class="seg" style="display:flex;gap:8px;">${['high', 'mid', 'low'].map(lv2 =>
            `<div class="opt ${lv === lv2 ? 'on' : ''}" data-tdlv="${lv2}" style="flex:1;text-align:center;padding:9px 8px;">${esc(lvName(lv2))}</div>`).join('')}</div>
        </div>
        <div class="fg">
          <div class="drawer-title">重复</div>
          <div class="seg" style="display:flex;gap:8px;flex-wrap:wrap;">${REPEATS.map(r =>
            `<div class="opt ${repeat === r.key ? 'on' : ''}" data-tdrep="${r.key}" style="flex:1;text-align:center;padding:9px 8px;">${esc(r.label)}</div>`).join('')}</div>
        </div>
      </div>
      <div class="modal-hr"></div>
      <div class="drawer-title">截止</div>
      <div class="due-row"><input type="date" id="tdDue" value="${esc(t.due || '')}" /><input type="time" id="tdDueTime" value="${esc(t.dueTime || '')}" /><button class="btn ghost sm" id="tdClear" style="flex:0 0 auto">清除</button></div>
      <div class="due-row" style="margin-top:8px">
        <select id="tdRemind" class="torepeat" style="flex:0 0 150px;height:38px">
          <option value="0" ${!(t.remind) ? 'selected' : ''}>准点提醒</option>
          <option value="5" ${t.remind === 5 ? 'selected' : ''}>提前 5 分钟</option>
          <option value="15" ${t.remind === 15 ? 'selected' : ''}>提前 15 分钟</option>
          <option value="30" ${t.remind === 30 ? 'selected' : ''}>提前 30 分钟</option>
          <option value="60" ${t.remind === 60 ? 'selected' : ''}>提前 1 小时</option>
        </select>
        <span class="due-hint" style="margin:0">需要先设置截止时间</span>
      </div>
      ${repeat !== 'none' ? `<div class="due-hint">重复待办完成后会自动顺延到下一周期，无需删除。</div>` : ''}
      <div class="modal-hr"></div>
      <div class="drawer-title">备注</div>
      <input type="text" id="tdNote" value="${esc(t.note || '')}" placeholder="可选：补充细节、地点、提醒说明…" />
      <div class="modal-hr"></div>
      <div class="drawer-title">子任务 <span class="dim" id="subCount"></span></div>
      <div id="subList" class="sub-list"></div>
      <div class="sub-add"><input type="text" id="subName" placeholder="添加子任务…" /><button class="btn ghost sm" id="subAdd">${icon('plus', 14)} 添加</button></div>
      <div class="modal-actions">
        <button class="btn" id="tdSave">保存</button>
        <button class="btn ghost" id="tdCancel">取消</button>
        ${t.id ? `<div class="spacer"></div><button class="btn danger sm" id="tdDel">删除</button>` : ''}
      </div>`);

    function paintSubs() {
      const list = $('#subList'); const cnt = $('#subCount');
      if (!list) return;
      if (cnt) cnt.textContent = subs.length ? `（${subs.filter(s => s.done).length}/${subs.length}）` : '';
      list.innerHTML = subs.length === 0
        ? '<div class="dim" style="font-size:12px;color:var(--text-tertiary)">暂无子任务</div>'
        : subs.map(s => `<div class="sub ${s.done ? 'on' : ''}" data-si="${s.id}">
          <span class="sub-chk">${icon('check', 12)}</span>
          <span class="sub-txt">${esc(s.text)}</span>
          <span class="sub-del">${icon('x', 13)}</span></div>`).join('');
    }
    paintSubs();
    $('#subList') && $('#subList').addEventListener('click', (e) => {
      const row = e.target.closest('.sub[data-si]'); if (!row) return;
      const s = subs.find(x => x.id === row.dataset.si); if (!s) return;
      if (e.target.closest('.sub-del')) subs.splice(subs.indexOf(s), 1);
      else s.done = !s.done;
      paintSubs();
    });
    const subInp = $('#subName');
    const doAddSub = () => { const t2 = subInp.value.trim(); if (!t2) return; subs.push({ id: uid(), text: t2, done: false }); subInp.value = ''; paintSubs(); subInp.focus(); };
    $('#subAdd').onclick = doAddSub;
    subInp.addEventListener('keydown', e => { if (e.key === 'Enter') doAddSub(); });

    $$('#ovl [data-tdlv]').forEach(o => o.onclick = () => { $$('#ovl [data-tdlv]').forEach(x => x.classList.remove('on')); o.classList.add('on'); lv = o.dataset.tdlv; });
    $$('#ovl [data-tdrep]').forEach(o => o.onclick = () => { $$('#ovl [data-tdrep]').forEach(x => x.classList.remove('on')); o.classList.add('on'); repeat = o.dataset.tdrep; });
    $('#tdCancel').onclick = closeModal;
    $('#tdClear').onclick = () => { const a = $('#tdDue'); const b = $('#tdDueTime'); if (a) a.value = ''; if (b) b.value = ''; };
    $('#tdSave').onclick = async () => {
      const text = $('#tdText').value.trim();
      if (!text) { toast('内容不能为空'); return; }
      const due = $('#tdDue').value || '';
      const dueTime = $('#tdDueTime').value || '';
      const note = $('#tdNote').value.trim() || '';
      const remind = parseInt(($('#tdRemind') || {}).value || '0', 10) || 0;
      if (repeat !== 'none' && !due) { toast('重复任务需先设置截止日期'); return; }
      if (t.id) {
        const x = state.todos.find(z => z.id === t.id); if (!x) return;
        x.text = text; x.level = lv; x.due = due; x.dueTime = dueTime; x.note = note;
        x.repeat = repeat; x.subtasks = subs; x.remind = remind;
      } else {
        state.todos.unshift({ id: uid(), text, level: lv, done: false, date: dateKey(), due, dueTime, note, repeat, subtasks: subs, doneHistory: [], remind });
      }
      await save(); closeModal(); render();
    };
    if (t.id) $('#tdDel').onclick = async () => { state.todos = state.todos.filter(x => x.id !== t.id); await save(); closeModal(); render(); };
    $('#tdText').focus();
  }

  // ---------------------------------------------------------------
  // 便签
  // ---------------------------------------------------------------
  function renderNotes(v) {
    v.innerHTML = `
      ${header('notes', `<button class="btn" data-act="add-note">${icon('plus', 16)} 新建便签</button>`)}
      ${state.notes.length === 0 ? `<div class="empty"><div class="e">${icon('note', 26)}</div>还没有便签，记录第一个灵感吧。</div>` : ''}
      <div class="note-grid">
        ${state.notes.map(n => `
          <div class="note" data-act="edit-note" data-id="${n.id}">
            <div class="nt">${esc(n.title || '无标题')}</div>
            <div class="nb">${esc(n.body)}</div>
            <div class="nm"><span class="tag">${esc(n.tag || '')}</span><span>${esc(n.date)}</span></div>
            <button class="x" data-act="del-note" data-id="${n.id}">${icon('trash', 14)}</button>
          </div>`).join('')}
      </div>`;
  }
  function noteModal(n) {
    n = n || { title: '', body: '', tag: '' };
    modal(`
      <h3>${n.id ? '编辑便签' : '新建便签'}</h3>
      <div class="sub">记录灵感、摘录或待办备忘</div>
      <div class="field"><label>标题</label><input type="text" id="ntTitle" value="${esc(n.title)}" /></div>
      <div class="field"><label>内容</label><textarea id="ntBody" style="min-height:120px">${esc(n.body)}</textarea></div>
      <div class="field"><label>标签（可选）</label><input type="text" id="ntTag" value="${esc(n.tag)}" /></div>
      <div class="modal-actions">
        <button class="btn" id="ntSave">保存</button>
        <button class="btn ghost" id="ntCancel">取消</button>
      </div>`);
    $('#ntCancel').onclick = closeModal;
    $('#ntSave').onclick = async () => {
      const title = $('#ntTitle').value.trim();
      const body = $('#ntBody').value;
      const tag = $('#ntTag').value.trim();
      if (!title && !body) { toast('内容不能为空'); return; }
      if (n.id) {
        const t = state.notes.find(x => x.id === n.id);
        if (t) { t.title = title; t.body = body; t.tag = tag; }
      } else {
        state.notes.unshift({ id: uid(), title, body, tag, date: dateKey() });
      }
      await save(); closeModal(); render();
    };
  }

  // ---------------------------------------------------------------
  // 打卡
  // ---------------------------------------------------------------
  function renderCheckins(v) {
    v.innerHTML = `
      ${header('checkins', `<button class="btn" data-act="add-checkin">${icon('plus', 16)} 添加习惯</button>`)}
      <div class="checkin-grid">
        ${state.checkins.map(c => `
          <div class="ck ${c.done ? 'on' : ''}" data-act="toggle-checkin" data-id="${c.id}">
            <div class="ce">${esc(c.emoji)}</div>
            <div class="cn">${esc(c.name)}</div>
            <div class="cs">${icon('flame', 13)} 已连续 ${c.streak || 0} 天</div>
            <div class="ball">${icon('check', 14)}</div>
            <button class="x" data-act="del-checkin" data-id="${c.id}">${icon('trash', 14)}</button>
          </div>`).join('')}
        <div class="ck add" data-act="add-checkin">${icon('plus', 24)}<div style="font-size:12.5px;color:var(--text-tertiary)">添加习惯</div></div>
      </div>`;
    if (state.checkins.length === 0) {
      v.insertAdjacentHTML('beforeend', `<div class="empty"><div class="e">${icon('flame', 26)}</div>添加一个想坚持的习惯吧。</div>`);
    }
  }
  function checkinModal() {
    modal(`
      <h3>添加习惯</h3>
      <div class="sub">选个图标，给习惯起个名字</div>
      <div class="field"><label>图标</label>
        <div class="emoji-grid">
          ${['🏃', '📚', '💧', '🧘', '✍️', '💪', '🥗', '🌅'].map((e, i) =>
            `<div class="opt ${i === 0 ? 'on' : ''}" data-em="${e}">${e}</div>`).join('')}
        </div></div>
      <div class="field"><label>习惯名称</label><input type="text" id="ckName" placeholder="例如：晨跑 30 分钟" /></div>
      <div class="modal-actions">
        <button class="btn" id="ckSave">添加</button>
        <button class="btn ghost" id="ckCancel">取消</button>
      </div>`);
    let em = '🏃';
    $$('#ovl [data-em]').forEach(o => o.onclick = () => { $$('#ovl [data-em]').forEach(x => x.classList.remove('on')); o.classList.add('on'); em = o.dataset.em; });
    $('#ckCancel').onclick = closeModal;
    $('#ckSave').onclick = async () => {
      const name = $('#ckName').value.trim();
      if (!name) { toast('请输入习惯名称'); return; }
      state.checkins.push({ id: uid(), name, emoji: em, done: false, streak: 0, last: null });
      await save(); closeModal(); render();
    };
    $('#ckName').focus();
  }
  function toggleCheckin(id) {
    const c = state.checkins.find(x => x.id === id); if (!c) return;
    const tk = dateKey();
    if (c.last === tk) { c.done = false; c.streak = Math.max(0, (c.streak || 0) - 1); c.last = null; }
    else if (c.last === yesterdayKey()) { c.done = true; c.streak = (c.streak || 0) + 1; c.last = tk; }
    else { c.done = true; c.streak = 1; c.last = tk; }
    save(); render();
  }

  // ---------------------------------------------------------------
  // 数据洞察
  // ---------------------------------------------------------------
  function kvRow(k, val, warn) {
    return `<div class="kv-row"><span class="kv-k">${esc(k)}</span><span class="kv-v${warn ? ' warn' : ''}">${val}</span></div>`;
  }
  async function renderStats(v) {
    const tk = dateKey();
    const todos = state.todos;
    const total = todos.length;
    const done = todos.filter(t => t.done).length;
    const open = total - done;
    const pct = total ? Math.round(done / total * 100) : 0;
    const doneToday = todos.filter(t => t.done && t.doneAt === tk).length;
    const monthKey = tk.slice(0, 7);
    const doneMonth = todos.filter(t => t.done && t.doneAt && t.doneAt.slice(0, 7) === monthKey).length;
    const overdue = todos.filter(t => !t.done && t.due && t.due < tk).length;
    const upcoming = todos.filter(t => !t.done && t.due === tk).length;
    const maxStreak = Math.max(0, ...state.checkins.map(c => c.streak || 0));
    const doneCkToday = state.checkins.filter(c => c.done).length;
    const notesN = state.notes.length;
    const filesN = state.groups.reduce((s, g) => s + g.items.length, 0);

    // 近 14 天活动强度
    const bars = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(tk + 'T00:00:00'); d.setDate(d.getDate() - i);
      const k = dateKey(d);
      const n = todos.filter(t => t.done && t.doneAt === k).length
        + state.notes.filter(x => x.date === k).length
        + state.checkins.filter(c => c.last === k).length;
      bars.push({ k, n });
    }
    const maxN = Math.max(1, ...bars.map(b => b.n));
    const barLabelAt = (k) => [0, 3, 6, 9].includes(new Date(k + 'T00:00:00').getDay()) ? k.slice(8) : '';

    // 自动时间统计（未开启/非 Windows 时优雅降级展示）
    let u = null;
    try { u = await api.getUsageSummary({ days: 7 }); } catch (e) { u = null; }
    const ttOn = !!(u && u.supported && state.settings.timeTrack && state.settings.timeTrack.enabled === true);
    const uTop = ttOn ? ((u.today.topApps && u.today.topApps[0]) || null) : null;
    const uTotalLabel = !u ? '—' : (u.supported === false ? '仅支持 Windows' : (ttOn ? fmtDur(u.today.total || 0) : '未开启'));
    const uTopLabel = !u ? '—' : (u.supported === false ? '仅支持 Windows' : (ttOn ? (uTop ? uTop.name + ' · ' + fmtDur(uTop.seconds) : '—') : '未开启'));

    v.innerHTML = `
      ${header('stats')}
      <div class="stats">
        <div class="stat">${chip('check-square', '待办')}<div class="v">${pct}%</div><div class="l">待办完成率（${done}/${total}）</div></div>
        <div class="stat">${chip('check', '今日已完成待办')}<div class="v">${doneToday}</div><div class="l">今日已完成待办</div></div>
        <div class="stat">${chip('flame', '今日打卡')}<div class="v">${doneCkToday}</div><div class="l">今日打卡 · 最高连续 ${maxStreak} 天</div></div>
        <div class="stat">${chip('note', '累计便签')}<div class="v">${notesN}</div><div class="l">累计便签 · ${doneMonth} 待办本月完成</div></div>
      </div>
      <div class="insight-grid">
        <div class="card insight-card">
          <div class="insight-t">近 14 天活动强度<span class="insight-sub">完成待办 · 便签 · 打卡</span></div>
          <div class="bars">${bars.map(b => `
            <div class="bar-col" title="${esc(b.k)}：${b.n}">
              <div class="bar-area"><div class="bar-fill" style="height:${Math.max(3, Math.round(b.n / maxN * 100))}%"></div></div>
              <div class="bar-l">${esc(barLabelAt(b.k) || '')}</div>
            </div>`).join('')}
          </div>
          <div class="insight-note">近 14 天共记录 ${bars.reduce((s, b) => s + b.n, 0)} 次活动 · 活跃峰值 ${maxN} / 天</div>
        </div>
        <div class="card insight-card">
          <div class="insight-t">当前情况一览</div>
          ${kvRow('待办总数', total)}
          ${kvRow('未完成待办', open)}
          ${kvRow('今日到期待办', upcoming)}
          ${kvRow('已逾期未完成', overdue, overdue > 0)}
          ${kvRow('本月已完成待办', doneMonth)}
          ${kvRow('已整理文件', filesN)}
          ${kvRow('习惯数', state.checkins.length)}
          ${kvRow('今日活跃时长', uTotalLabel)}
          ${kvRow('最常用应用', uTopLabel)}
        </div>
      </div>`;
  }

  // ---------------------------------------------------------------
  // 自动时间统计
  // ---------------------------------------------------------------
  function fmtDur(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (h) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
    if (m) return m + ' 分钟';
    return sec + ' 秒';
  }
  const USAGE_COLORS = { '工作': '#5f7a99', '开发': '#6f8f6a', '浏览': '#bd8a4e', '沟通': '#b5715a', '娱乐': '#7d7195', '其他': '#9aa1ac', '桌面工作台': '#2563eb' };
  function usageColor(name) {
    if (USAGE_COLORS[name]) return USAGE_COLORS[name];
    let h = 0;
    for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
    return ['#6f8f6a', '#5f7a99', '#bd8a4e', '#b5715a', '#7d7195'][h % 5];
  }
  function usageBarRows(list, colorOf) {
    if (!list.length) return '<div class="empty" style="padding:26px 10px">还没有记录</div>';
    const max = Math.max(1, ...list.map(x => x.seconds));
    return list.map(x => `
      <div class="u-bar-row" title="${esc(x.name)}：${esc(fmtDur(x.seconds))}">
        <span class="u-bar-name">${colorOf ? `<span class="u-dot" style="background:${colorOf(x.name)}"></span>` : ''}${esc(x.name)}</span>
        <div class="u-bar-track"><div class="u-bar-fill" style="width:${Math.max(2, Math.round(x.seconds / max * 100))}%;background:${colorOf ? colorOf(x.name) : 'var(--module-2)'}"></div></div>
        <span class="u-bar-val">${esc(fmtDur(x.seconds))}</span>
      </div>`).join('');
  }
  function usageEmptyState(v, title, desc, btn) {
    v.innerHTML = `${header('usage')}
      <div class="empty card" style="padding:56px 20px"><div class="e">${icon('clock', 26)}</div>
      <div>${esc(title)}</div><div class="dim" style="font-size:12px;margin-top:6px">${esc(desc)}</div>
      ${btn ? `<div style="margin-top:16px"><button class="btn" data-act="goto-settings">去设置开启</button></div>` : ''}</div>`;
  }

  async function renderUsage(v) {
    const tt = state.settings.timeTrack || {};
    let sum = null;
    try { sum = await api.getUsageSummary({ days: 7 }); } catch (e) { sum = null; }
    if (!sum) sum = emptyUsageShape();

    if (sum.supported === false) {
      usageEmptyState(v, '时间统计仅支持 Windows 系统', '其他平台不采集任何数据。', false);
      return;
    }
    if (tt.enabled !== true) {
      usageEmptyState(v, '时间统计未开启', '开启后会在后台记录各应用的活跃时长并按规则自动分类，数据仅保存在本机。', true);
      return;
    }

    const todayTotal = sum.today.total || 0;
    const yd = sum.daily.length >= 2 ? sum.daily[sum.daily.length - 2] : null;
    let delta = '';
    if (yd && yd.total > 0) {
      const pct = Math.round((todayTotal - yd.total) / yd.total * 100);
      delta = (pct >= 0 ? '+' : '') + pct + '%';
    } else if (todayTotal > 0) {
      delta = '昨日未记录';
    }
    const topApp = (sum.today.topApps && sum.today.topApps[0]) || null;
    const catRows = usageBarRows(sum.today.categories, usageColor);
    const appRows = usageBarRows(sum.topApps, null);
    const maxDay = Math.max(1, ...(sum.daily || []).map(d => d.total));
    const cols = (sum.daily || []).map(d => `
      <div class="u-col" title="${esc(d.date)}：${esc(fmtDur(d.total))}">
        <div class="u-col-track"><div class="u-col-fill" style="height:${Math.max(3, Math.round(d.total / maxDay * 100))}%"></div></div>
        <div class="u-col-l">${d.date === dateKey() ? '今天' : esc(d.date.slice(5))}</div>
      </div>`).join('');
    const titleRows = (sum.topTitles || []).map(t => `
      <div class="u-title-row" title="${esc(t.app)} | ${esc(t.title)}">
        <span class="u-title-app">${esc(t.app)}</span>
        <span class="u-title-t">${esc(t.title)}</span>
        <span class="u-bar-val">${esc(fmtDur(t.seconds))}</span>
      </div>`).join('');

    v.innerHTML = `
      ${header('usage', `<span class="usage-flag">${icon('clock', 13)} 采样中 · 每 5 秒</span>`)}
      <div class="stats">
        <div class="stat">${chip('clock', '快捷入口')}<div class="v">${esc(fmtDur(todayTotal))}</div><div class="l">今日活跃时长${delta ? ' · 较昨日 ' + esc(delta) : ''}</div></div>
        <div class="stat">${chip('grid', '待办')}<div class="v" style="font-size:16px;line-height:34px">${esc(topApp ? topApp.name : '—')}</div><div class="l">今日最常用应用${topApp ? ' · ' + esc(fmtDur(topApp.seconds)) : ''}</div></div>
        <div class="stat">${chip('calendar', '数据洞察')}<div class="v">${sum.dayCount || 0}</div><div class="l">已记录天数 · 自动保留 90 天</div></div>
        <div class="stat">${chip('timer', '打卡')}<div class="v">${sum.pomodoros.today || 0}</div><div class="l">今日番茄 · 本周 ${sum.pomodoros.week || 0} 个</div></div>
      </div>
      <div class="insight-grid">
        <div class="card insight-card">
          <div class="insight-t">今日分类占比<span class="insight-sub">按分类规则自动归类</span></div>
          ${catRows}
        </div>
        <div class="card insight-card">
          <div class="insight-t">应用时长 Top 10<span class="insight-sub">近 7 天</span></div>
          ${appRows}
        </div>
      </div>
      <div class="card insight-card" style="margin-top:16px">
        <div class="insight-t">近 7 天每日活跃<span class="insight-sub">每天合计</span></div>
        <div class="u-cols">${cols}</div>
        <div class="insight-note">番茄钟专注时段已计入对应应用；今日专注 ${sum.pomodoros.today || 0} 个番茄 · 近 7 天 ${sum.pomodoros.week || 0} 个</div>
      </div>
      ${tt.recordTitles === true ? `<div class="card insight-card" style="margin-top:16px">
        <div class="insight-t">窗口标题 Top 10<span class="insight-sub">近 7 天 · 需开启「记录窗口标题」</span></div>
        ${titleRows || '<div class="empty" style="padding:26px 10px">还没有标题记录</div>'}
      </div>` : ''}`;
  }
  function emptyUsageShape() {
    return {
      supported: true, enabled: false, dayCount: 0,
      today: { total: 0, categories: [], topApps: [] },
      daily: [], topApps: [], categories: [], topTitles: [],
      pomodoros: { today: 0, week: 0 }
    };
  }

  // ---------------------------------------------------------------
  // 番茄钟
  // ---------------------------------------------------------------
  const POMO_MODES = [
    { key: 'focus', label: '专注', min: 25, color: 'var(--module-3)' },
    { key: 'short', label: '短休', min: 5, color: 'var(--module-1)' },
    { key: 'long', label: '长休', min: 15, color: 'var(--module-2)' }
  ];
  function pomoPreset(k) { return POMO_MODES.find(x => x.key === (k || 'focus')) || POMO_MODES[0]; }
  function pomoModeLabel(cfg) { return cfg.mode === 'custom' ? (cfg.minutes || 25) + ' 分钟' : pomoPreset(cfg.mode).label; }
  function fmtP(s) { s = Math.max(0, Math.round(s)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }
  function initPomo() {
    const cfg = state.settings.pomodoro = (state.settings.pomodoro && typeof state.settings.pomodoro === 'object') ? state.settings.pomodoro : {};
    const min = (cfg.minutes && cfg.minutes > 0) ? cfg.minutes : pomoPreset(cfg.mode).min;
    state._pomo = { total: min * 60, remaining: min * 60, running: false, _last: null };
  }
  function onPomoComplete() {
    const cfg = state.settings.pomodoro || {};
    const isFocus = (cfg.mode || 'focus') === 'focus';
    const label = pomoModeLabel(cfg);
    toast(label + '结束');
    try { api.notify(label + '结束', isFocus ? '刚完成一个番茄，起来休息一下吧' : '休息结束，可以继续专注了', true).catch(() => { }); } catch (e) { /* ignore */ }
    if (isFocus) {
      const tk = dateKey();
      state._pomoDone = state._pomoDone || {};
      state._pomoDone[tk] = (state._pomoDone[tk] || 0) + 1;
      save(true);
    }
  }
  function pomoTick() {
    if (!state || !state._pomo) return;
    const p = state._pomo;
    if (p.running) {
      const now = Date.now();
      const step = Math.round((now - (p._last || now)) / 1000);
      p._last = now;
      if (step > 0) p.remaining = Math.max(0, p.remaining - step);
      if (p.remaining === 0) { p.running = false; p._last = null; if (!p._firedComplete) { p._firedComplete = true; onPomoComplete(); } }
    }
    const dT = $('#pomoTime'); if (dT) dT.textContent = fmtP(p.remaining);
    const dBar = $('#pomoBar'); if (dBar && p.total) dBar.style.width = Math.max(0, Math.min(100, Math.round((p.total - p.remaining) / p.total * 100))) + '%';
    const dMode = $('#pomoModeName'); if (dMode) dMode.textContent = pomoModeLabel(state.settings.pomodoro || {});
    const dCount = $('#pomoCount'); if (dCount) dCount.textContent = '今日完成 ' + ((state._pomoDone && state._pomoDone[dateKey()]) || 0) + ' 个番茄';
    const runBtn = $('#pomoRun'); if (runBtn) runBtn.innerHTML = p.running ? icon('pause', 15) + ' 暂停' : icon('play', 15) + ' 开始';
  }
  function renderPomodoro(v) {
    const cfg = state.settings.pomodoro = (state.settings.pomodoro && typeof state.settings.pomodoro === 'object') ? state.settings.pomodoro : {};
    if (!state._pomo || !state._pomo.total) initPomo();
    const p = state._pomo;
    v.innerHTML = `
      ${header('pomodoro', `<div class="pomo-count">${icon('timer', 14)} <span id="pomoCount">今日完成 ${((state._pomoDone && state._pomoDone[dateKey()]) || 0)} 个番茄</span></div>`)}
      <div class="pomo-wrap">
        <div class="card pomo-main">
          <div class="pomo-mode" id="pomoModeName">${esc(pomoModeLabel(cfg))}</div>
          <div class="pomo-time" id="pomoTime">${fmtP(p.remaining)}</div>
          <div class="pomo-track"><div class="pomo-fill" id="pomoBar" style="width:${Math.round((p.total - p.remaining) / p.total * 100)}%"></div></div>
          <div class="pomo-actions">
            <button class="btn pomo-run" id="pomoRun">${icon('play', 15)} 开始</button>
            <button class="btn ghost" data-act="pomo-reset" title="重置">${icon('repeat', 16)} 重置</button>
          </div>
        </div>
        <div class="card pomo-side">
          <div class="drawer-title">时长</div>
          <div class="seg" style="display:flex;flex-wrap:wrap;gap:8px">
            ${POMO_MODES.map(md => `<div class="opt ${(cfg.mode || 'focus') === md.key ? 'on' : ''}" data-act="pomo-mode" data-mode="${md.key}" style="flex:0 0 auto">${esc(md.label)} · ${md.min}分钟</div>`).join('')}
          </div>
          <div style="height:16px"></div>
          <div class="drawer-title">自定义时长（分钟）</div>
          <div class="due-row">
            <input type="number" id="pomoCustom" min="1" max="180" value="${cfg.minutes || pomoPreset(cfg.mode).min}" style="flex:0 0 120px;width:120px" />
            <button class="btn ghost sm" data-act="pomo-apply">应用</button>
          </div>
          <div class="due-hint" style="margin-top:12px">计时结束会弹出系统通知；专注完成会自动累计今天的番茄数。</div>
        </div>
      </div>`;
    const run = $('#pomoRun');
    if (run) run.onclick = () => { if (p.running) { p.running = false; p._last = null; } else { p._last = Date.now(); p.running = true; p._firedComplete = false; } render(); };
  }

  // ---------------------------------------------------------------
  // 设置
  // ---------------------------------------------------------------
  async function renderSettings(v) {
    const s = state.settings;
    const org = state.settings.autoOrganize || {};
    const tt = state.settings.timeTrack || {};
    const ws = state.settings.widgets || {};
    let info = { version: '1.0.0', hotkey: 'Win+Alt+Space' };
    try { info = await api.appInfo(); } catch (e) { /* ignore */ }

    const sw = (act, on) => `<div class="switch ${on ? 'on' : ''}" data-act="${act}"></div>`;
    const ctl = (html) => `<div class="set-ctl">${html}</div>`;
    const group = (title, rows) => `
      <div class="set-group">
        <div class="set-group-t">${esc(title)}</div>
        <div class="card set-card">${rows}</div>
      </div>`;
    const row = (ic, cls, t, d, control, sub) => `
      <div class="set-row${sub ? ' col' : ''}">
        <div class="set-line"><div class="set-ic ${cls}">${icon(ic, 15)}</div>
          <div class="k"><div class="t">${esc(t)}</div><div class="d">${d}</div></div>${control || ''}</div>
        ${sub ? `<div class="set-sub">${sub}</div>` : ''}
      </div>`;

    v.innerHTML = `
      ${header('settings')}
      ${group('窗口 · 外观', `
        ${row('pin', 'c2', '置顶显示', '让工作台始终悬浮在其他窗口之上', sw('toggle-mode', s.mode === 'top'))}
        ${row('expand', 'c4', '窗口模式', '以普通窗口运行（可拖动、缩放、最小化），关闭后回到覆盖桌面', sw('toggle-layout', s.layout === 'window'))}
        ${row('droplet', 'c3', '主题色', '按钮与选中态的高亮颜色', `<div class="swatches">${ACCENTS.map(a => `<div class="sw ${s.accent === a.hex ? 'on' : ''}" data-act="set-accent" data-accent="${a.hex}" style="background:${a.hex}" title="${esc(a.name)}"></div>`).join('')}</div>`)}
        ${row('moon', 'c5', '外观模式', '深色 / 浅色，或跟随系统', `<div class="seg" style="flex:0 0 auto">${[['light', '浅色'], ['dark', '深色'], ['auto', '自动']].map(([k, lb]) =>
          `<div class="opt ${(s.theme || 'light') === k ? 'on' : ''}" data-act="set-theme" data-theme="${k}">${lb}</div>`).join('')}</div>`)}
        ${row('layers', 'c1', '毛玻璃背景', '覆盖桌面模式下使用 Windows 11 亚克力半透明效果（应用为深石墨主题时更明显）', sw('toggle-glass', !!s.glass))}
      `)}
      ${group('功能', `
        ${row('power', 'c2', '开机自启', '登录 Windows 后自动启动工作台', sw('toggle-autostart', !!s.autostart))}
        ${row('repeat', 'c3', '重复待办逾期自动顺延', '重复任务过期未完成时，自动顺延到下一周期，避免堆积在昨天', sw('toggle-overdue', s.autoOverdueAdvance === true))}
        ${row('clipboard', 'c4', '剪贴板历史', '自动记录复制的文本 / 图片 / 文件，按 <b>Win+Alt+V</b> 唤出，支持搜索、置顶、类型过滤与图片 OCR 提字（最多保留 200 条）', sw('toggle-clipboard', s.clipboardHistory !== false), `
          <div class="set-sub-row"><label class="set-sub-lb">敏感内容过滤</label><div class="switch ${s.clipboardSensitive !== false ? 'on' : ''}" data-act="toggle-clipboard-sensitive"></div><span style="font-size:12px;color:var(--text-tertiary);padding-left:10px">JWT / 口令 / API Key 等敏感内容不录入历史</span></div>`)}
        ${row('bell', 'c5', '每日提醒', '每天定时汇总当天到期的待办，并系统通知', sw('toggle-dailyremind', !!s.dailyRemind), s.dailyRemind ? `
          <div class="set-sub-row"><label class="set-sub-lb">提醒时间</label><input type="time" id="dailyRemindTime" value="${esc(s.dailyRemindTime || '08:30')}" style="width:150px;flex:0 0 auto" /></div>` : null)}
        ${row('folder-open', 'c1', '自动文件整理', '监控一个文件夹，新放入的文件按规则自动移动到对应目录', sw('toggle-autoorganize', !!org.enabled), `
          <div class="set-sub-row">
            <div class="set-watch" id="autoWatchInfo">${esc(org.watch || '选择后，新放入的文件会自动按规则整理到对应文件夹')}</div>
            <button class="btn ghost sm" data-act="pick-auto-watch">${icon('folder', 14)} 选择</button>
          </div>
          <div class="org-rules" id="orgRules">
            ${(org.rules || []).map(r => `
              <div class="org-rule" data-rid="${esc(r.id)}">
                <span class="org-tag ${r.type === 'ext' ? 'ext' : 'kw'}">${r.type === 'ext' ? '扩展名' : '关键词'}</span>
                <span class="org-val">${esc(r.value)}</span>
                <span class="org-arrow">→</span>
                <span class="org-to" title="${esc(r.to)}">${esc(fileBase(r.to) || r.to)}</span>
                <div class="org-ops">
                  <button class="btn ghost sm" data-act="edit-auto-rule" data-id="${esc(r.id)}">${icon('edit', 12)}</button>
                  <button class="btn ghost sm danger-ic" data-act="del-auto-rule" data-id="${esc(r.id)}">${icon('trash', 12)}</button>
                </div>
              </div>`).join('')}
          </div>
          ${(org.rules || []).length ? '' : '<div class="org-empty">还没有整理规则，点下方「添加规则」创建。例如：{ 扩展名 pdf } 移动下载的 PDF 到「文档」文件夹。</div>'}
          <div class="org-add">
            <button class="btn sm" data-act="add-auto-rule">${icon('plus', 14)} 添加规则</button>
            <button class="btn ghost sm" data-act="run-auto-organize">${icon('folder-open', 14)} 立即整理</button>
          </div>`)}
        ${row('refresh', 'c2', '检查更新', '从更新源清单读取最新版本；地址留空则不检查', '', `
          <div class="set-sub-row" style="align-items:center">
            <input type="text" id="updaterUrl" value="${esc(s.updaterUrl || '')}" placeholder="https://example.com/version.json" style="flex:1;min-width:180px" />
            <button class="btn sm" data-act="check-update">${icon('refresh', 14)} 检查更新</button>
            <span id="updResult" style="font-size:12.5px;color:var(--text-secondary)"></span>
          </div>`)}
      `)}
      ${group('时间统计', `
        ${row('clock', 'c2', '自动时间统计', (info.platform || 'win32') === 'win32' ? '在后台记录各应用的活跃时长并自动归类；只记录应用名与窗口标题，不上传、不截屏、不记录键鼠内容' : '此功能仅支持 Windows 系统', sw('toggle-timetrack', tt && tt.enabled === true))}
        ${row('clock', 'c3', '空闲阈值', '系统空闲超过该时长后停止计时（锁屏会立即暂停）', `<div class="seg" style="flex:0 0 auto">${[[120, '2 分钟'], [300, '5 分钟'], [600, '10 分钟']].map(([v, lb]) =>
          `<div class="opt ${tt && tt.idleSeconds === v ? 'on' : ''}" data-act="tt-idle" data-value="${v}">${lb}</div>`).join('')}</div>`)}
        ${row('list', 'c4', '记录窗口标题', '开启后窗口标题才会写入统计数据并展示标题排行；关闭时标题只用于规则匹配、不落盘（默认关闭，更隐私）', sw('toggle-tt-titles', !!(tt && tt.recordTitles)))}
        ${row('sort', 'c5', '分类规则', '按顺序匹配：命中应用进程名（不分大小写）或窗口标题（包含匹配），未命中归入「其他」', '', `
          <div class="org-rules" id="ttRules">
            ${((tt && tt.rules) || []).map((r, i) => `
              <div class="org-rule">
                <span class="org-tag ${r.match === 'title' ? 'kw' : 'ext'}">${r.match === 'title' ? '标题' : '进程'}</span>
                <span class="org-val">${esc(r.value)}</span>
                <span class="org-arrow">→</span>
                <span class="org-to">${esc(r.category)}</span>
                <div class="org-ops">
                  <button class="btn ghost sm" data-act="edit-tt-rule" data-ridx="${i}">${icon('edit', 12)}</button>
                  <button class="btn ghost sm danger-ic" data-act="del-tt-rule" data-ridx="${i}">${icon('trash', 12)}</button>
                </div>
              </div>`).join('')}
          </div>
          ${((tt && tt.rules) || []).length ? '' : '<div class="org-empty">还没有分类规则，点下方「添加规则」创建。例如：{ 进程 chrome } 归入「浏览」。</div>'}
          <div class="org-add">
            <button class="btn sm" data-act="add-tt-rule">${icon('plus', 14)} 添加规则</button>
          </div>`)}
        ${row('trash', 'danger', '清空统计数据', '删除全部应用时长记录（不影响待办、便签等其他数据，也不包含在导出/备份中）', ctl(`<button class="btn danger sm" data-act="clear-usage">清空</button>`))}
      `)}
      ${group('桌面小组件', `
        ${row('clock', 'c3', '时钟', '在桌面固定显示时间与日期的小窗', sw('toggle-widget-clock', ws.clock === true))}
        ${row('check-square', 'c1', '今日待办', '在桌面固定显示今天与逾期的待办', sw('toggle-widget-todos', ws.todos === true))}
        ${row('note', 'c4', '便签', '在桌面固定展示便签列表', sw('toggle-widget-notes', ws.notes === true))}
      `)}
      ${group('数据', `
        ${row('database', 'c3', '自动备份', '每 6 小时自动备份数据；若主数据损坏会自动从最近备份恢复', sw('toggle-autobackup', s.autoBackup !== false))}
        ${row('archive', 'c4', '本地备份', `<span id="bkInfo">读取中…</span>`, ctl(`<button class="btn ghost sm" data-act="backup-now">${icon('database', 14)} 立即备份</button><button class="btn ghost sm" data-act="open-backup">打开文件夹</button>`))}
        ${row('download', 'c5', '导出 / 导入', '导出为 JSON 文件，可在换设备或重装后导入恢复', ctl(`<button class="btn ghost sm" data-act="export-data">${icon('download', 14)} 导出</button><button class="btn ghost sm" data-act="import-data">${icon('upload', 14)} 导入</button>`))}
        ${row('trash', 'danger', '清空所有数据', '删除全部待办、便签、打卡、快捷方式和文件分组，此操作不可撤销', ctl(`<button class="btn danger sm" data-act="reset-all">清空数据</button>`))}
      `)}
      <div class="set-tip">
        <b>使用说明</b><br />
        · 全局快捷键 <b>${esc(info.hotkey)}</b> 可随时显示 / 隐藏工作台<br />
        · <b>Win+Alt+T</b> 可在任意界面弹出小窗快速添加待办（支持「今天 / 明天 / 15:30」快捷写法）<br />
        · <b>Win+Alt+V</b> 唤出剪贴板历史，可搜索、置顶、按类型过滤，图片支持 OCR 提字<br />
        · <b>Win+Alt+S</b> 截图取字：框选屏幕任意区域，识别文字并自动复制<br />
        · <b>Ctrl+K</b> 打开命令面板：搜索内容，或直接执行新建待办、切换主题等动作<br />
        · 「窗口模式」可让工作台以普通窗口运行（可拖动、缩放、最小化到任务栏）<br />
        · 「文件整理」支持直接把文件 / 文件夹拖拽进分组收纳；「自动文件整理」可监控一个文件夹按规则自动归类<br />
        · 「桌面小组件」可把时钟 / 今日待办 / 便签钉在桌面上（设置中开启）<br />
        · 待办支持<b>重复任务</b>（每天/每周/每月）、<b>到期系统通知</b>、备注与子任务<br />
        · 关闭窗口会最小化到系统托盘，不会退出；在托盘菜单里选择「退出」才会结束<br />
        · 工作台覆盖在整个桌面上，不遮挡 Windows 任务栏；点托盘或按快捷键可暂时隐藏以查看原始桌面<br />
        · 当前版本 <b>v${esc(info.version)}</b> · 数据保存在 <b>${esc(info.userData)}</b>
      </div>`;
    const drt = $('#dailyRemindTime');
    if (drt) drt.onchange = async () => { state.settings.dailyRemindTime = drt.value || '08:30'; await save(); toast('已保存每日提醒时间'); };
    const upUrl = $('#updaterUrl');
    if (upUrl) upUrl.onchange = async () => { state.settings.updaterUrl = (upUrl.value || '').trim(); await save(); };
    try {
      const bks = await api.listBackups();
      const bi = $('#bkInfo');
      if (bi) bi.textContent = bks.length ? `最近 ${bks.length} 份 · 最新 ${esc(bks[0].name)}` : '暂无本地备份';
    } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------
  // 提示输入
  // ---------------------------------------------------------------
  function promptText(title, label, def) {
    return new Promise(res => {
      modal(`
        <h3>${esc(title)}</h3>
        <div class="field" style="margin-top:18px"><label>${esc(label)}</label><input type="text" id="ptInput" value="${esc(def)}" /></div>
        <div class="modal-actions">
          <button class="btn" id="ptOk">确定</button>
          <button class="btn ghost" id="ptCancel">取消</button>
        </div>`);
      const inp = $('#ptInput'); inp.focus(); inp.select();
      $('#ptCancel').onclick = () => { closeModal(); res(null); };
      $('#ptOk').onclick = () => { const v = inp.value.trim(); closeModal(); res(v || def); };
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = inp.value.trim(); closeModal(); res(v || def); } });
    });
  }

  // 整理规则编辑弹窗
  function autoRuleModal(rule) {
    return new Promise(res => {
      rule = rule || {};
      let t = rule.type === 'ext' ? 'ext' : 'kw';
      const value = esc(rule.value || '');
      const to = esc(rule.to || '');
      const holder = t === 'ext' ? '例如 pdf · jpg · xlsx' : '例如 发票 · 截图';
      const lab = t === 'ext' ? '匹配扩展名' : '匹配关键词';
      modal(`
        <h3>${esc(rule.id ? '编辑整理规则' : '添加整理规则')}</h3>
        <div class="field" style="margin-top:16px">
          <label>匹配方式</label>
          <div class="seg" style="width:100%">
            <div class="opt ${t === 'ext' ? 'on' : ''}" id="artTypeExt">扩展名</div>
            <div class="opt ${t === 'kw' ? 'on' : ''}" id="artTypeKw">关键词</div>
          </div>
        </div>
        <div class="field" style="margin-top:14px">
          <label id="artLab">${lab}</label>
          <input type="text" id="artValue" value="${value}" placeholder="${holder}" />
        </div>
        <div class="field" style="margin-top:14px">
          <label>整理到的文件夹</label>
          <div style="display:flex;gap:8px;align-items:center">
            <input type="text" id="artTo" value="${to}" readonly placeholder="选择目标文件夹" style="flex:1" />
            <button class="btn ghost sm" id="artPick">选择</button>
          </div>
        </div>
        <div class="modal-actions">
          <button class="btn" id="artOk">保存</button>
          <button class="btn ghost" id="artCancel">取消</button>
        </div>`);
      const segSet = () => {
        $('#artTypeExt').classList.toggle('on', t === 'ext');
        $('#artTypeKw').classList.toggle('on', t === 'kw');
        const l = $('#artLab'); if (l) l.textContent = t === 'ext' ? '匹配扩展名' : '匹配关键词';
        $('#artValue').placeholder = t === 'ext' ? '例如 pdf · jpg · xlsx' : '例如 发票 · 截图';
      };
      $('#artTypeExt').onclick = () => { t = 'ext'; segSet(); };
      $('#artTypeKw').onclick = () => { t = 'kw'; segSet(); };
      $('#artPick').onclick = async () => { const p = await api.pickAutoTarget(); if (p) $('#artTo').value = p; };
      $('#artCancel').onclick = () => { closeModal(); res(null); };
      $('#artOk').onclick = () => {
        const v = $('#artValue').value.trim();
        const d = $('#artTo').value.trim();
        closeModal();
        if (!v) { toast('请输入匹配内容'); res(null); return; }
        if (!d) { toast('请选择整理到的文件夹'); res(null); return; }
        res({ type: t, value: v, to: d });
      };
      const inp = $('#artValue'); inp.focus(); inp.select();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#artOk').click(); } });
    });
  }

  // 时间统计分类规则弹窗（交互对齐自动文件整理规则弹窗）
  function ttRuleModal(rule) {
    return new Promise(res => {
      rule = rule || {};
      let t = rule.match === 'title' ? 'title' : 'exe';
      const value = esc(rule.value || '');
      const cats = ['工作', '开发', '浏览', '沟通', '娱乐', '其他'];
      const curCat = cats.indexOf(rule.category) !== -1 ? rule.category : '其他';
      modal(`
        <h3>${esc(rule.value ? '编辑分类规则' : '添加分类规则')}</h3>
        <div class="sub">按顺序匹配，先命中先归类</div>
        <div class="field" style="margin-top:16px">
          <label>匹配方式</label>
          <div class="seg" style="width:100%">
            <div class="opt ${t === 'exe' ? 'on' : ''}" id="ttTypeExe">应用进程</div>
            <div class="opt ${t === 'title' ? 'on' : ''}" id="ttTypeTitle">窗口标题</div>
          </div>
        </div>
        <div class="field" style="margin-top:14px">
          <label id="ttLab">进程名包含（不分大小写）</label>
          <input type="text" id="ttValue" value="${value}" placeholder="例如 chrome · wechat · code" />
        </div>
        <div class="field" style="margin-top:14px">
          <label>归类到</label>
          <select id="ttCat" class="torepeat" style="width:100%;height:40px;flex:none">${cats.map(c => `<option ${c === curCat ? 'selected' : ''}>${c}</option>`).join('')}</select>
        </div>
        <div class="modal-actions">
          <button class="btn" id="ttOk">保存</button>
          <button class="btn ghost" id="ttCancel">取消</button>
        </div>`);
      const segSet = () => {
        $('#ttTypeExe').classList.toggle('on', t === 'exe');
        $('#ttTypeTitle').classList.toggle('on', t === 'title');
        const l = $('#ttLab');
        if (l) l.textContent = t === 'exe' ? '进程名包含（不分大小写）' : '窗口标题包含';
        $('#ttValue').placeholder = t === 'exe' ? '例如 chrome · wechat · code' : '例如 会议 · 文档';
      };
      $('#ttTypeExe').onclick = () => { t = 'exe'; segSet(); };
      $('#ttTypeTitle').onclick = () => { t = 'title'; segSet(); };
      $('#ttCancel').onclick = () => { closeModal(); res(null); };
      $('#ttOk').onclick = () => {
        const v = $('#ttValue').value.trim();
        const cat = $('#ttCat').value;
        closeModal();
        if (!v) { toast('请输入匹配内容'); res(null); return; }
        res({ match: t, value: v, category: cat });
      };
      const inp = $('#ttValue'); inp.focus(); inp.select();
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#ttOk').click(); } });
    });
  }

  function usageClearConfirm() {
    return new Promise(res => {
      modal(`
        <h3>清空时间统计数据？</h3>
        <div class="sub">将删除全部应用时长记录，不影响待办、便签等其他数据。此操作不可撤销。</div>
        <div class="modal-actions">
          <button class="btn danger" id="ucOk">确定清空</button>
          <button class="btn ghost" id="ucCancel">取消</button>
        </div>`);
      $('#ucCancel').onclick = () => { closeModal(); res(false); };
      $('#ucOk').onclick = () => { closeModal(); res(true); };
    });
  }

  // ---------------------------------------------------------------
  // 全局搜索
  // ---------------------------------------------------------------
  const SEARCH_ICON = {
    todos: 'check-square', notes: 'note', shortcuts: 'grid', files: 'folder', checkins: 'flame'
  };
  const SEARCH_CAT = { todos: '待办', notes: '便签', shortcuts: '快捷', files: '文件', checkins: '打卡' };

  function searchItems(q) {
    q = (q || '').trim().toLowerCase();
    const out = [];
    if (!q) return out;
    const hit = txt => String(txt == null ? '' : txt).toLowerCase().indexOf(q) !== -1;

    state.todos.forEach(t => {
      if (hit(t.text) || hit(t.note))
        out.push({ view: 'todos', label: t.text, sub: (t.done ? '已完成' : '进行中') + (t.due ? ' · ' + t.due : ''), id: t.id });
    });
    state.notes.forEach(n => {
      if (hit(n.title) || hit(n.body) || hit(n.tag))
        out.push({ view: 'notes', label: n.title || '无标题', sub: ((n.tag ? '#' + n.tag + ' ' : '') + (n.body || '')).slice(0, 46), id: n.id });
    });
    state.shortcuts.forEach(s => {
      if (hit(s.name) || hit(s.path))
        out.push({ view: 'shortcuts', label: s.name || fileBase(s.path), sub: s.path || '', id: s.id });
    });
    state.groups.forEach(g => {
      g.items.forEach(it => {
        if (hit(it.name) || hit(it.path))
          out.push({ view: 'files', label: it.name, sub: (g.name || '') + ' · ' + (it.path || ''), id: it.id });
      });
    });
    state.checkins.forEach(c => {
      if (hit(c.name))
        out.push({ view: 'checkins', label: c.name, sub: '已连续 ' + (c.streak || 0) + ' 天', id: c.id });
    });
    return out;
  }

  function goSearchResult(it) {
    closeModal();
    state.view = it.view;
    render();
    if (it.view === 'todos') {
      const td = state.todos.find(x => x.id === it.id);
      if (td) todoModal(td);
    } else if (it.view === 'notes') {
      const n = state.notes.find(x => x.id === it.id);
      if (n) noteModal(n);
    } else if (it.view === 'shortcuts') {
      const s = state.shortcuts.find(x => x.id === it.id);
      if (s) api.openPath(s.path);
    }
  }

  // 命令面板动作：与内容搜索共用选择模型，cmd 项回车即执行
  function commandItems(q) {
    const q2 = (q || '').trim().toLowerCase();
    const out = [];
    const add = (label, sub, ic, run) => out.push({ cmd: true, ic, label, sub, run });
    if (q.trim()) {
      add('新建待办：' + q.trim(), '回车创建到待办清单', 'check', () => {
        state.todos.unshift({ id: uid(), text: q.trim(), level: state._todoLv || 'mid', done: false, date: dateKey(), due: '', dueTime: '', repeat: 'none', note: '', subtasks: [], doneHistory: [], remind: 0 });
        save(true); toast('已创建待办'); render();
      });
      add('新建便签：' + q.trim(), '回车创建到便签', 'note', () => {
        state.notes.unshift({ id: uid(), title: q.trim().slice(0, 40), body: '', tag: '', date: dateKey() });
        save(true); toast('已创建便签'); render();
      });
    }
    add('打开剪贴板历史', 'Win+Alt+V · 文本 / 图片 / 文件', 'clipboard', () => { api.toggleClipboard(); });
    add('截图 OCR 取字', 'Win+Alt+S · 框选屏幕区域识别文字', 'search', () => { api.startScreenshot(); });
    add('开始番茄钟（25 分钟）', '进入番茄钟并开始专注', 'timer', () => {
      state.view = 'pomodoro';
      if (!state._pomo || !state._pomo.total) initPomo();
      state._pomo.running = true;
      state._pomo._last = Date.now();
      state._pomo._firedComplete = false;
      render();
    });
    add('切换置顶显示', '让工作台始终悬浮在其他窗口之上', 'pin', async () => {
      const next = state.settings.mode === 'top' ? 'normal' : 'top';
      state.settings.mode = next;
      await api.setMode(next);
      await save(true); syncPin();
    });
    add('切换深色 / 浅色主题', '当前：' + (themePref() === 'dark' ? '深色' : '浅色'), 'moon', async () => {
      state.settings.theme = themePref() === 'dark' ? 'light' : 'dark';
      applyAccent(); syncThemeBg(); await save(true); render();
    });
    add('立即备份数据', '备份到本地 backups 目录', 'database', async () => {
      const p = await api.backupNow();
      toast(p ? '已备份到 ' + String(p).split(/[\\/]/).pop() : '备份失败');
    });
    NAV.forEach(n => add('前往「' + n.label + '」', '页面', n.icon, () => { state.view = n.id; render(); }));
    return !q2 ? out : out.filter(c => c.label.toLowerCase().indexOf(q2) !== -1);
  }

  function activateSearchItem(it) {
    if (it.cmd) { closeModal(); it.run(); } else { goSearchResult(it); }
  }

  function openSearch() {
    const root = modal(`
      <div class="search-box">
        ${icon('search', 18)}
        <input type="text" id="searchInput" placeholder="搜索内容，或输入命令（如：新建待办）…" autocomplete="off" spellcheck="false" />
        <span class="search-esc">Esc</span>
      </div>
      <div class="search-res" id="searchRes"></div>
      <div class="search-foot">Enter 打开 / 执行 · ↑ ↓ 选择 · Esc 关闭</div>`);
    root.querySelector('.modal').classList.add('search-modal');
    const inp = $('#searchInput');
    const res = $('#searchRes');
    let items = [];
    let sel = 0;

    function paint() {
      const q = inp.value.trim();
      items = commandItems(q).concat(searchItems(q));
      sel = 0;
      if (!items.length) {
        res.innerHTML = '<div class="search-empty">没有匹配的结果或命令</div>';
        return;
      }
      res.innerHTML = items.map((it, i) => `
        <div class="search-it ${i === sel ? 'on' : ''}" data-si="${i}">
          <span class="si-ic">${icon(it.cmd ? it.ic : (SEARCH_ICON[it.view] || 'grid'), 14)}</span>
          <div class="si-b">
            <div class="si-t">${esc(it.label)}</div>
            <div class="si-s">${esc(it.sub || '')}</div>
          </div>
          <span class="si-cat">${esc(it.cmd ? '命令' : (SEARCH_CAT[it.view] || ''))}</span>
        </div>`).join('');
      const on = res.querySelector('.search-it.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }

    inp.addEventListener('input', paint);
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; paintSel(); } }
      else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; paintSel(); } }
      else if (e.key === 'Enter') { if (items[sel]) activateSearchItem(items[sel]); }
      else if (e.key === 'Escape') { closeModal(); }
    });
    res.addEventListener('mousedown', (e) => {
      const row = e.target.closest('.search-it[data-si]'); if (!row) return;
      const it = items[+row.dataset.si]; if (it) activateSearchItem(it);
    });

    function paintSel() {
      $$('#searchRes .search-it').forEach((el, i) => el.classList.toggle('on', i === sel));
      const on = res.querySelector('.search-it.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
    }

    paint();
    inp.focus();
  }

  // ---------------------------------------------------------------
  // 事件委托
  // ---------------------------------------------------------------
  $('#view').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-nav], [data-act], [data-cald]');
    if (!t) return;
    if (t.dataset.nav && t !== null) {
      if (t.dataset.nav !== state.view) { state.view = t.dataset.nav; render(); }
      return;
    }
    // 点选日历中的某一天（仅当该元素没有其它操作）
    if (t.dataset.cald && !t.dataset.act) {
      state._calSel = t.dataset.cald;
      render();
      return;
    }
    const act = t.dataset.act;
    const id = t.dataset.id;
    switch (act) {
      case 'add-shortcut': await addShortcut(); break;
      case 'open-shortcut': {
        if (e.target.closest('.x')) break;
        const s = state.shortcuts.find(x => x.id === id);
        if (s) { const err = await api.openPath(s.path); if (err) toast('打开失败：' + err); }
        break;
      }
      case 'del-shortcut': state.shortcuts = state.shortcuts.filter(x => x.id !== id); await save(); render(); break;

      case 'add-group': await addGroup(); break;
      case 'del-group': closeCtx(); { const g = findGroup(id); if (g) { state.groups = state.groups.filter(x => x.id !== id); await save(); render(); toast('已删除分组'); } } break;
      case 'group-add-file': {
        const paths = await api.pickFiles();
        if (paths && paths.length) await addItemsToGroup(id, paths);
        break;
      }
      case 'group-add-folder': {
        const p = await api.pickFolder();
        if (p) await addItemsToGroup(id, [p]);
        break;
      }
      case 'open-item': {
        if (e.target.closest('.x')) break;
        const g = findGroup(t.dataset.gid); const it = g && g.items.find(x => x.id === t.dataset.id);
        if (it) { const err = await api.openPath(it.path); if (err) toast('打开失败'); }
        break;
      }
      case 'del-item': {
        const g = findGroup(t.dataset.gid);
        if (g) { g.items = g.items.filter(x => x.id !== t.dataset.id); await save(); render(); }
        break;
      }

      case 'add-todo': addTodo(); break;
      case 'toggle-todo': {
        const td = state.todos.find(x => x.id === id);
        if (td) {
          if (!td.done && td.repeat && td.repeat !== 'none' && td.due) {
            // 完成一次重复任务：顺延到下一周期
            advanceRepeat(td);
          } else if (!td.done) {
            td.done = true; td.doneAt = dateKey();
          } else {
            td.done = false; td.doneAt = null;
          }
          await save(); render();
        }
        break;
      }
      case 'edit-todo': {
        const td = state.todos.find(x => x.id === id);
        if (td) todoModal(td);
        break;
      }
      case 'del-todo': state.todos = state.todos.filter(x => x.id !== id); await save(); render(); break;
      case 'clear-done': state.todos = state.todos.filter(x => !x.done); await save(); render(); break;
      case 'todo-lv': state._todoLv = t.dataset.lv; render(); break;
      case 'todo-filter': state._todoFilter = t.dataset.filter; render(); break;

      case 'cal-prev': state._calCursor = (state._calCursor || 0) - 1; render(); break;
      case 'cal-next': state._calCursor = (state._calCursor || 0) + 1; render(); break;
      case 'cal-today': state._calCursor = 0; state._calSel = dateKey(); render(); break;
      case 'cal-add': goToAddTodo(t.dataset.cald || dateKey()); break;

      case 'pomo-mode': {
        state.settings.pomodoro = state.settings.pomodoro || {};
        state.settings.pomodoro.mode = t.dataset.mode;
        delete state.settings.pomodoro.minutes; // 回到预设时长
        initPomo(); save(); render();
        break;
      }
      case 'pomo-reset': initPomo(); render(); break;
      case 'pomo-apply': {
        const v = parseInt(($('#pomoCustom') || {}).value, 10);
        state.settings.pomodoro = state.settings.pomodoro || {};
        state.settings.pomodoro.mode = 'custom';
        state.settings.pomodoro.minutes = Math.max(1, Math.min(180, isNaN(v) ? 25 : v));
        initPomo(); save(); render();
        break;
      }

      case 'add-note': noteModal(); break;
      case 'edit-note':
        if (!e.target.closest('.x')) { const n = state.notes.find(x => x.id === id); if (n) noteModal(n); }
        break;
      case 'del-note': state.notes = state.notes.filter(x => x.id !== id); await save(); render(); break;

      case 'add-checkin': checkinModal(); break;
      case 'toggle-checkin': if (!e.target.closest('.x')) toggleCheckin(id); break;
      case 'del-checkin': state.checkins = state.checkins.filter(x => x.id !== id); await save(); render(); break;

      case 'toggle-mode': await api.setMode(state.settings.mode === 'top' ? 'normal' : 'top'); state.settings.mode = state.settings.mode === 'top' ? 'normal' : 'top'; await save(); syncPin(); render(); break;
      case 'toggle-layout': {
        const next = currentLayout() === 'window' ? 'overlay' : 'window';
        state.settings.layout = next;
        await api.setLayout(next);
        await save(true); syncLayout(); render();
        break;
      }
      case 'toggle-autostart': { state.settings.autostart = !state.settings.autostart; const r = await api.setAutostart(state.settings.autostart); state.settings.autostart = r; await save(); render(); break; }
      case 'set-accent': state.settings.accent = t.dataset.accent; await save(); render(); break;
      case 'set-theme': {
        state.settings.theme = ['light', 'dark', 'auto'].includes(t.dataset.theme) ? t.dataset.theme : 'light';
        applyAccent();
        syncThemeBg();
        await save();
        render();
        break;
      }
      case 'toggle-dailyremind': state.settings.dailyRemind = !state.settings.dailyRemind; await save(); render(); break;
      case 'toggle-autobackup': { state.settings.autoBackup = state.settings.autoBackup === false ? true : false; await save(); render(); break; }
      case 'toggle-glass': { state.settings.glass = !state.settings.glass; await api.setGlass(state.settings.glass); await save(); render(); break; }
      case 'toggle-overdue': { state.settings.autoOverdueAdvance = !(state.settings.autoOverdueAdvance === true); await save(); render(); break; }
      case 'toggle-clipboard': { state.settings.clipboardHistory = state.settings.clipboardHistory === false; await save(); render(); break; }
      case 'toggle-clipboard-sensitive': { state.settings.clipboardSensitive = state.settings.clipboardSensitive === false; await save(); render(); break; }
      case 'toggle-timetrack': {
        state.settings.timeTrack = state.settings.timeTrack || {};
        state.settings.timeTrack.enabled = !(state.settings.timeTrack.enabled === true);
        await save(); render(); break;
      }
      case 'tt-idle': {
        state.settings.timeTrack = state.settings.timeTrack || {};
        state.settings.timeTrack.idleSeconds = parseInt(t.dataset.value, 10) || 300;
        await save(); render(); break;
      }
      case 'toggle-tt-titles': {
        state.settings.timeTrack = state.settings.timeTrack || {};
        state.settings.timeTrack.recordTitles = !(state.settings.timeTrack.recordTitles === true);
        await save(); render(); break;
      }
      case 'add-tt-rule': {
        const r = await ttRuleModal();
        if (!r) break;
        state.settings.timeTrack = state.settings.timeTrack || {};
        const rules = state.settings.timeTrack.rules = state.settings.timeTrack.rules || [];
        rules.push(r);
        await save(); render(); break;
      }
      case 'edit-tt-rule': {
        const idx = parseInt(t.dataset.ridx, 10);
        const rules = (state.settings.timeTrack || {}).rules || [];
        if (!(idx >= 0 && idx < rules.length)) break;
        const r = await ttRuleModal(rules[idx]);
        if (!r) break;
        rules[idx] = r;
        await save(); render(); break;
      }
      case 'del-tt-rule': {
        const idx = parseInt(t.dataset.ridx, 10);
        const rules = (state.settings.timeTrack || {}).rules || [];
        if (!(idx >= 0 && idx < rules.length)) break;
        rules.splice(idx, 1);
        await save(); render(); break;
      }
      case 'clear-usage': {
        if (!(await usageClearConfirm())) break;
        try { await api.clearUsage(); toast('统计数据已清空'); } catch (e) { toast('清空失败'); }
        break;
      }
      case 'goto-settings': state.view = 'settings'; render(); break;
      case 'toggle-widget-clock':
      case 'toggle-widget-todos':
      case 'toggle-widget-notes': {
        const name = act.replace('toggle-widget-', '');
        state.settings.widgets = state.settings.widgets || {};
        state.settings.widgets[name] = !(state.settings.widgets[name] === true);
        await save(); render(); break;
      }
      case 'toggle-autoorganize': {
        state.settings.autoOrganize = state.settings.autoOrganize || { enabled: false, watch: '', rules: [] };
        state.settings.autoOrganize.enabled = !state.settings.autoOrganize.enabled;
        await save();
        if (state.settings.autoOrganize.enabled) { const r = await api.runAutoOrganize(); if (r && r.moved && r.moved.length) toast('自动整理已启用：移动 ' + r.moved.length + ' 个文件'); }
        render(); break;
      }
      case 'pick-auto-watch': {
        const p = await api.pickAutoWatch();
        if (!p) break;
        state.settings.autoOrganize = state.settings.autoOrganize || { enabled: false, watch: '', rules: [] };
        state.settings.autoOrganize.watch = p;
        await save(); render();
        break;
      }
      case 'run-auto-organize': {
        const r = await api.runAutoOrganize();
        if (!r) { toast('整理完成'); break; }
        const n = (r.moved && r.moved.length) || 0;
        const err = (r.errors && r.errors.length) || 0;
        toast(n ? '已整理 ' + n + ' 个文件' + (err ? '，' + err + ' 个失败' : '') : '没有需要整理的文件' + (err ? '（' + err + ' 个失败）' : ''));
        if (n) render();
        break;
      }
      case 'add-auto-rule': {
        const r = await autoRuleModal();
        if (!r) break;
        state.settings.autoOrganize = state.settings.autoOrganize || { enabled: false, watch: '', rules: [] };
        const rules = state.settings.autoOrganize.rules = state.settings.autoOrganize.rules || [];
        rules.push(Object.assign({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) }, r));
        await save(); render();
        break;
      }
      case 'edit-auto-rule': {
        const rid = t.dataset.id;
        const rules = state.settings.autoOrganize.rules || [];
        const idx = rules.findIndex(x => x.id === rid);
        if (idx < 0) break;
        const r = await autoRuleModal(rules[idx]);
        if (!r) break;
        rules[idx] = Object.assign({}, rules[idx], r);
        await save(); render();
        break;
      }
      case 'del-auto-rule': {
        const rid = t.dataset.id;
        state.settings.autoOrganize.rules = (state.settings.autoOrganize.rules || []).filter(x => x.id !== rid);
        await save(); render();
        break;
      }
      case 'check-update': {
        const el = $('#updResult');
        const set = (t) => { if (el) el.textContent = t; };
        set('检查中…');
        const r = await api.checkUpdate();
        if (!r || !r.ok) { set(r && r.reason === 'no-src' ? '未设置更新源，自动生成安装包后填入清单地址即可' : '检查失败（' + (r && r.msg ? r.msg : '未知错误') + '）'); break; }
        if (r.hasUpdate) {
          set('发现新版本 v' + r.latest + '，当前 v' + r.cur);
          modal(`
            <h3>发现新版本 v${esc(r.latest)}</h3>
            <p style="color:var(--text-secondary);margin-top:10px;line-height:1.7">当前版本 v${esc(r.cur)}。${esc(r.notes || '')}</p>
            ${r.url ? `<p style="margin-top:14px"><button class="btn" id="uGo">前往下载</button></p>` : '<p style="margin-top:14px;color:var(--text-tertiary);font-size:12.5px">更新包地址为空，请通过你的发布渠道获取。</p>'}
            <div class="modal-actions"><button class="btn ghost" id="uCancel">以后再说</button></div>`);
          const go = $('#uGo'); if (go) go.onclick = () => { closeModal(); api.openExternal(r.url); };
          $('#uCancel').onclick = () => closeModal();
        } else { set('已是最新版本 v' + r.cur); }
        break;
      }
      case 'backup-now': {
        const p = await api.backupNow();
        if (p) { toast('已备份到 ' + p.split(/[\\/]/).pop()); render(); }
        else toast('备份失败');
        break;
      }
      case 'open-backup': api.openBackupDir(); break;
      case 'export-data': {
        if (!state.todos.length && !state.notes.length && !state.checkins.length && !state.shortcuts.length && !state.groups.length) {
          toast('当前没有可导出的数据');
          break;
        }
        state._exportedAt = new Date().toISOString();
        const r = await api.exportData(JSON.stringify(state, null, 2));
        if (r && r.ok) toast('已导出：' + r.path.split(/[\\/]/).pop());
        else if (r && !r.ok) toast('导出失败');
        delete state._exportedAt;
        break;
      }
      case 'import-data': {
        const r = await api.importData();
        if (!r) break;
        if (r.canceled) break;
        if (!r.ok) { toast('导入失败：文件不是有效的工作台数据'); break; }
        try {
          const imp = JSON.parse(r.content);
          const san = sanitizeImported(imp);
          const sure = await importConfirm();
          if (!sure) break;
          state.todos = san.todos; state.notes = san.notes;
          state.checkins = san.checkins; state.shortcuts = san.shortcuts;
          state.groups = san.groups;
          state.settings = sanitizeSettingsMerge(state.settings, san.settings);
          state.profile = Object.assign({ name: '我的工作台' }, san.profile);
          render();
          await save(true);
          toast('已导入数据');
        } catch (e) {
          toast('导入失败：数据解析错误');
        }
        break;
      }
      case 'reset-all': {
        if (await confirmDanger()) {
          state.todos = []; state.notes = []; state.checkins = []; state.shortcuts = []; state.groups = [];
          await save(); toast('已清空'); render();
        }
        break;
      }
      case 'quick': state.view = 'shortcuts'; render(); break;
    }
  });

  // 侧栏导航
  $('#nav').addEventListener('click', async (e) => {
    const t = e.target.closest('[data-nav]');
    if (t && t.dataset.nav !== state.view) { state.view = t.dataset.nav; render(); }
  });

  // 拖拽文件/文件夹进分组收纳
  const viewEl = $('#view');
  viewEl.addEventListener('dragover', (e) => {
    const fence = e.target.closest('.fence[data-gid]');
    if (!fence) return;
    if (!Array.from(e.dataTransfer.types).includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    fence.classList.add('drag-over');
  });
  viewEl.addEventListener('dragleave', (e) => {
    const fence = e.target.closest('.fence[data-gid]');
    if (!fence) return;
    if (!fence.contains(e.relatedTarget)) fence.classList.remove('drag-over');
  });
  viewEl.addEventListener('drop', async (e) => {
    const fence = e.target.closest('.fence[data-gid]');
    if (!fence) return;
    e.preventDefault();
    fence.classList.remove('drag-over');
    const gid = fence.dataset.gid;
    const files = Array.from(e.dataTransfer.files || []);
    const paths = [];
    for (const f of files) {
      const p = await api.getPathForFile(f);
      if (p) paths.push(p);
    }
    if (paths.length) await addItemsToGroup(gid, paths);
    else if (files.length) toast('无法识别拖入的内容');
  });

  // 文件夹 / 文件右键菜单
  $('#view').addEventListener('contextmenu', (e) => {
    const fitem = e.target.closest('.fitem[data-gid][data-id]');
    const fence = e.target.closest('.fence[data-gid]');
    if (fitem) {
      e.preventDefault();
      e.stopPropagation();
      const g = findGroup(fitem.dataset.gid);
      const it = g && g.items.find(x => x.id === fitem.dataset.id);
      if (!it) return;
      ctxmenu([
        { icon: icon('external', 15) + ' <span style="margin-right:6px"></span>', label: '打开', onClick: async () => { const err = await api.openPath(it.path); if (err) toast('打开失败'); } },
        { icon: icon('folder', 15) + ' <span style="margin-right:6px"></span>', label: '在资源管理器中显示', onClick: () => api.revealPath(it.path) },
        { icon: icon('trash', 15) + ' <span style="margin-right:6px"></span>', label: '从分组移除', danger: true, onClick: async () => { if (g) { g.items = g.items.filter(x => x.id !== it.id); await save(); render(); } } }
      ], e.clientX, e.clientY);
    } else if (fence) {
      e.preventDefault();
      e.stopPropagation();
      const gid = fence.dataset.gid;
      ctxmenu([
        { icon: icon('folder-open', 15) + ' <span style="margin-right:6px"></span>', label: '添加文件', onClick: async () => { const p = await api.pickFiles(); if (p && p.length) await addItemsToGroup(gid, p); } },
        { icon: icon('folder', 15) + ' <span style="margin-right:6px"></span>', label: '添加文件夹', onClick: async () => { const p = await api.pickFolder(); if (p) await addItemsToGroup(gid, [p]); } },
        { icon: icon('trash', 15) + ' <span style="margin-right:6px"></span>', label: '删除分组', danger: true, onClick: async () => { state.groups = state.groups.filter(x => x.id !== gid); await save(); render(); toast('已删除分组'); } }
      ], e.clientX, e.clientY);
    }
  });

  // 窗口控制
  $('#pinBtn').addEventListener('click', async () => {
    const next = state.settings.mode === 'top' ? 'normal' : 'top';
    state.settings.mode = next;
    await api.setMode(next);
    await save(); syncPin();
  });
  $('#layoutBtn').addEventListener('click', async () => {
    const next = currentLayout() === 'window' ? 'overlay' : 'window';
    state.settings.layout = next;
    await api.setLayout(next);
    await save(true); syncLayout();
  });
  $('#hideBtn').addEventListener('click', () => api.hideWindow());
  $('#minBtn').addEventListener('click', () => api.minimize());
  $('#maxBtn').addEventListener('click', async () => { const m = await api.maximizeToggle(); syncMaximized(!!m); });
  $('#closeBtn').addEventListener('click', () => api.quit());
  $('#quitBtn').addEventListener('click', () => api.quit());
  $('#searchBtn').addEventListener('click', () => openSearch());
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      openSearch();
    }
  });
  const tbDrag = $('#tbDrag');
  if (tbDrag) tbDrag.addEventListener('dblclick', async () => { if (currentLayout() !== 'window') return; const m = await api.maximizeToggle(); syncMaximized(!!m); });

  api.onMode?.((d) => { if (d && d.mode && state) { state.settings.mode = d.mode; syncPin(); } });
  api.onLayout?.((d) => { if (d && d.layout && state) { state.settings.layout = d.layout; syncLayout(); } });
  api.onMaximized?.((d) => { if (d && state) syncMaximized(!!d.maximized); });

  // ---------------------------------------------------------------
  // 引导
  // ---------------------------------------------------------------
  function showGuide() {
    if (state.settings.seenGuide) return;
    modal(`
      <h3>欢迎使用桌面工作台 👋</h3>
      <div class="sub">一个覆盖桌面、把文件 / 应用 / 待办收纳到一起的轻量工作台</div>
      <div class="set-tip" style="line-height:1.9">
        · <b>Win+Alt+Space</b> 随时显示 / 隐藏工作台<br />
        · 点右上角 <b>图钉</b> 可置顶；<b>收缩</b> 图标可切换窗口模式<br />
        · 按 <b>Ctrl+K</b> 或点右上角 <b>搜索</b> 图标，全局搜索所有内容<br />
        · 窗口模式下可拖动、缩放、最小化到任务栏<br />
        · <b>Win+Alt+T</b> 快速添加待办；<b>Win+Alt+V</b> 唤出剪贴板历史；<b>Win+Alt+S</b> 截图取字<br />
        · 「文件整理」支持直接拖拽文件 / 文件夹进分组，双击打开，右键更多操作<br />
        · 关闭窗口不会退出，常驻系统托盘；工作台不遮挡 Windows 任务栏
      </div>
      <div class="modal-actions"><div class="spacer"></div><button class="btn" id="gOk">开始使用</button></div>`);
    $('#gOk').onclick = async () => { closeModal(); state.settings.seenGuide = true; await save(); };
  }

  function importConfirm() {
    return new Promise(res => {
      modal(`
        <h3>确认导入数据？</h3>
        <div class="sub">导入将<b>覆盖</b>当前所有待办、便签、打卡、快捷方式与文件分组。建议先导出一份备份。</div>
        <div class="modal-actions">
          <button class="btn" id="imOk">覆盖导入</button>
          <button class="btn ghost" id="imCancel">取消</button>
        </div>`);
      $('#imCancel').onclick = () => { closeModal(); res(false); };
      $('#imOk').onclick = () => { closeModal(); res(true); };
    });
  }

  function confirmDanger() {
    return new Promise(res => {
      modal(`
        <h3>确定清空所有数据？</h3>
        <div class="sub">此操作不可撤销，将删除全部待办、便签、打卡、快捷方式与文件分组。</div>
        <div class="modal-actions">
          <button class="btn danger" id="cfOk">确定清空</button>
          <button class="btn ghost" id="cfCancel">取消</button>
        </div>`);
      $('#cfCancel').onclick = () => { closeModal(); res(false); };
      $('#cfOk').onclick = () => { closeModal(); res(true); };
    });
  }

  // ---------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------
  async function boot() {
    if (!api) { document.body.innerHTML = '<div style="padding:40px;font-family:monospace">preload 未加载</div>'; return; }
    state = await api.load();
    state.profile = Object.assign({ name: '我的工作台' }, state.profile || {});
    state.settings = Object.assign({ mode: 'normal', autostart: false, accent: '#2f2e2b', seenGuide: false, layout: 'overlay', glass: false, autoOverdueAdvance: false, updaterUrl: '', autoOrganize: { enabled: false, watch: '', rules: [] }, dailyRemind: false, dailyRemindTime: '08:30', autoBackup: true, clipboardHistory: true, clipboardSensitive: true, widgets: { clock: false, todos: false, notes: false }, theme: 'light' }, state.settings || {});
    if (!state.settings.autoOrganize || typeof state.settings.autoOrganize !== 'object') state.settings.autoOrganize = { enabled: false, watch: '', rules: [] };
    if (!Array.isArray(state.settings.autoOrganize.rules)) state.settings.autoOrganize.rules = [];
    if (!state.settings.timeTrack || typeof state.settings.timeTrack !== 'object') state.settings.timeTrack = { enabled: false, idleSeconds: 300, recordTitles: false, rules: [] };
    if (!Array.isArray(state.settings.timeTrack.rules)) state.settings.timeTrack.rules = [];
    if (!state.view) state.view = 'dashboard';
    if (state._todoLv == null) state._todoLv = 'mid';
    if (state._todoFilter == null) state._todoFilter = 'all';
    (state.todos || []).forEach(t => {
      if (t.due == null) t.due = '';
      if (t.dueTime == null) t.dueTime = '';
      if (t.level == null) t.level = 'mid';
      if (t.repeat == null) t.repeat = 'none';
      if (t.note == null) t.note = '';
      if (t.remind == null) t.remind = 0;
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (!Array.isArray(t.doneHistory)) t.doneHistory = [];
      if (t.repeat !== 'none' && !t.due) t.repeat = 'none';
    });
    // 迁移：旧版本对 readShortcutLink 失败的 .lnk 会存下通用文档占位图标（体积很小），清除后按新逻辑重新获取
    (state.shortcuts || []).forEach(s => {
      if (s.icon && s.icon.length < 2500) s.icon = null;
    });
    applyAccent();
    syncLayout();
    initWinControls();
    render();
    // 番茄钟计时刷新：无论停在哪个页面都持续走表，回到番茄钟页时时间保持正确
    setInterval(() => { try { pomoTick(); } catch (e) { /* ignore */ } }, 500);
    try { const info = await api.appInfo(); const v = $('#ver'); if (v && info.version) v.textContent = 'v' + info.version; } catch (e) { /* ignore */ }
    await save(true); // 归一化后回写一次
    showGuide();
    // 全局快速添加 / 逾期顺延等由主进程改写了数据时，重新拉取并刷新
    api.onChanged && api.onChanged(async () => {
      if (!state) return;
      try {
        const fresh = await api.load();
        const keep = {
          view: state.view, _calSel: state._calSel, _calCursor: state._calCursor,
          _todoLv: state._todoLv, _todoFilter: state._todoFilter,
          _pomo: state._pomo, _pomoDone: state._pomoDone
        };
        state = fresh;
        state.profile = Object.assign({ name: '我的工作台' }, state.profile || {});
        Object.assign(state, keep);
        render();
      } catch (e) { /* ignore */ }
    });
  }

  boot();
})();