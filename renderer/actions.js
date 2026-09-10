'use strict';

/* actions.js —— 事件委托（控制器）：所有 data-act 动作分发
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
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
      await applyAutoRulesNow('监控文件夹已更新');
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
      await applyAutoRulesNow('规则已添加');
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
      await applyAutoRulesNow('规则已更新');
      break;
    }
    case 'del-auto-rule': {
      const rid = t.dataset.id;
      state.settings.autoOrganize.rules = (state.settings.autoOrganize.rules || []).filter(x => x.id !== rid);
      await save(); render();
      await applyAutoRulesNow('规则已删除');
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
    case 'probe-ps': {
      toast('正在重新检测运行环境…');
      try { await api.probePowershell(); } catch (e) { /* ignore */ }
      if (state.view === 'settings') render();
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
        // 导入的是外部 JSON：先做结构与危险项清洗（见 renderer/importguard.js），
        // 否则脏数据会让文件整理页直接崩、或被自动整理规则乱搬文件
        const san = WB.importguard.sanitizeImported(imp);
        const sure = await importConfirm();
        if (!sure) break;
        state.todos = san.todos; state.notes = san.notes;
        state.checkins = san.checkins; state.shortcuts = san.shortcuts;
        state.groups = san.groups;
        state.settings = WB.importguard.sanitizeSettingsMerge(state.settings, san.settings);
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

