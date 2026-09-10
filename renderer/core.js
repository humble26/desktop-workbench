'use strict';

/* core.js —— 基础设施：DOM 助手、全局 API 引用
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 基础设施：DOM 助手、全局 API 引用
// ---------------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const api = window.api;

// ---------------------------------------------------------------
// 状态与工具
// ---------------------------------------------------------------
let state = null;
let baseRev = 0;              // 已知的服务端修订号
let serverSnap = null;        // 已知的服务端持久化状态（深拷贝基线，用于差分）
let savePending = false;      // 有未提交的改动
let saveChain = Promise.resolve();
let protoWarned = false;
const proto = (window.WB && window.WB.proto) || null;
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
// 持久化：把「相对服务端快照的差异」作为补丁提交给主进程
// 主进程是唯一的落盘者，因此主进程的并发写入（快速添加待办 / 逾期顺延 /
// 提醒标记 / 小组件开关）不会被这里的整份快照覆盖。
// ---------------------------------------------------------------
function save(silent) {
  if (!state || !proto) return Promise.resolve(false);
  savePending = true;
  // 串行化：连续调用会合并成一次提交（提交前重新差分，天然合并中间状态）
  saveChain = saveChain.then(() => drainSave(silent), () => drainSave(silent));
  return saveChain;
}

async function drainSave(silent) {
  while (savePending) {
    savePending = false;
    const patch = proto.diffPatch(serverSnap, proto.stripEphemeral(state));
    if (!patch) return true;                 // 与服务端一致，无需落盘
    let res = null;
    try { res = await api.commit({ rev: baseRev, patch: patch }); } catch (e) { res = null; }
    if (res && res.ok) {
      baseRev = res.rev;
      serverSnap = proto.snapshot(res.data);
    } else {
      // 主进程会拒绝形状非法的补丁（见 lib/patchguard.js）；把原因说出来，不要只报「失败」
      const why = res && res.error ? '：' + res.error : '';
      if (!silent) toast('保存失败' + why);
      try { console.warn('[save] 提交被拒绝', res); } catch (e) { /* ignore */ }
      return false;
    }
  }
  return true;
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

