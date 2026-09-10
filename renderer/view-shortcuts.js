'use strict';

/* view-shortcuts.js —— 快捷入口
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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

