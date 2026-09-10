'use strict';

/* view-notes.js —— 便签
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

