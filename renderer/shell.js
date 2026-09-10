'use strict';

/* shell.js —— 外壳：导航、主题与外观、窗口控制、视图分发
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

