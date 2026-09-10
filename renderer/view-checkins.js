'use strict';

/* view-checkins.js —— 打卡
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

