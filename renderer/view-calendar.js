'use strict';

/* view-calendar.js —— 日历视图
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

