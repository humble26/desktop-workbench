'use strict';

/* view-files.js —— 文件整理
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

