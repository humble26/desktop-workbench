'use strict';

/* view-todos.js —— 待办
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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
function advanceRepeat(t) {
  const next = new Date(t.due + 'T00:00:00');
  switch (t.repeat) {
    case 'daily': next.setDate(next.getDate() + 1); break;
    case 'weekly': next.setDate(next.getDate() + 7); break;
    // 按月必须走钳制算法：1/31 直接 setMonth(+1) 会滚到 3/3
    case 'monthly': WB.dateutil.advanceMonthClamped(next); break;
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

