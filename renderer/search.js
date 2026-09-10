'use strict';

/* search.js —— 全局搜索与命令面板
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

