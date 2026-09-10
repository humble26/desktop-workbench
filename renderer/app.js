'use strict';

/* app.js —— 启动
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 启动
// ---------------------------------------------------------------
async function boot() {
  if (!api) { document.body.innerHTML = '<div style="padding:40px;font-family:monospace">preload 未加载</div>'; return; }
  if (!proto) { document.body.innerHTML = '<div style="padding:40px;font-family:monospace">storeproto.js 未加载：数据协议缺失，已停止启动（改动不会被保存）</div>'; return; }
  const loaded = await api.load();
  state = (loaded && loaded.data) ? loaded.data : loaded;   // 主进程返回 { rev, data }
  baseRev = (loaded && loaded.rev) || 0;
  // 结构与老数据归一化统一由主进程 lib/migrate.js 负责，这里只补界面状态
  state.profile = Object.assign({ name: '我的工作台' }, state.profile || {});
  state.settings = Object.assign({ accent: '#2f2e2b', theme: 'light', layout: 'overlay', mode: 'normal' }, state.settings || {});
  if (!state.view) state.view = 'dashboard';
  if (state._todoLv == null) state._todoLv = 'mid';
  if (state._todoFilter == null) state._todoFilter = 'all';
  // 迁移：旧版本对 readShortcutLink 失败的 .lnk 会存下通用文档占位图标（体积很小），清除后按新逻辑重新获取；
  // 另外旧版本把图标以 base64 内联写进数据文件（几十个快捷方式能撑到几百 KB），
  // 现在改为落盘到图标缓存、数据文件只存 file:// 短引用，故这里一次性清掉 data: 形式的内联图标。
  (state.shortcuts || []).forEach(s => {
    if (s.icon && (s.icon.length < 2500 || /^data:/i.test(s.icon))) s.icon = null;
  });
  serverSnap = proto.snapshot(state);   // 建立差分基线（不含界面状态）
  applyAccent();
  syncLayout();
  initWinControls();
  render();
  // 番茄钟计时刷新：无论停在哪个页面都持续走表，回到番茄钟页时时间保持正确
  setInterval(() => { try { pomoTick(); } catch (e) { /* ignore */ } }, 500);
  try { const info = await api.appInfo(); const v = $('#ver'); if (v && info.version) v.textContent = 'v' + info.version; } catch (e) { /* ignore */ }
  await save(true); // 归一化后回写一次（只提交真实差异）
  showGuide();
  // 运行环境诊断推送：功能降级时不再「毫无提示」
  api.onDiagnostics && api.onDiagnostics((d) => {
    const feats = (d && d.powershell && d.powershell.features) || {};
    for (const k of Object.keys(feats)) {
      if (feats[k] && feats[k].ok === false && !warnedFeatures[k]) {
        warnedFeatures[k] = true;
        toast('功能降级：' + (FEATURE_LABEL[k] || k) + '（详见 设置 · 运行环境 · 诊断）');
      }
    }
    if (state && state.view === 'settings') paintDiagnostics();
  });
  // 主进程改写了数据（快速添加 / 逾期顺延 / 提醒标记 / 小组件开关）时回灌刷新；
  // 自己提交的补丁不再回灌，避免打断正在进行的操作
  api.onChanged && api.onChanged(async (info) => {
    if (!state) return;
    if (info && info.origin === 'renderer') { if (info.rev) baseRev = info.rev; return; }
    try {
      const fresh = await api.load();
      const data = (fresh && fresh.data) ? fresh.data : fresh;
      if (!data) return;
      // 保留界面状态（不参与持久化的那部分）
      const keep = {
        view: state.view, _calSel: state._calSel, _calCursor: state._calCursor,
        _todoLv: state._todoLv, _todoFilter: state._todoFilter,
        _pomo: state._pomo, pomoDone: state.pomoDone
      };
      state = data;
      baseRev = (fresh && fresh.rev) || baseRev;
      state.profile = Object.assign({ name: '我的工作台' }, state.profile || {});
      Object.assign(state, keep);
      serverSnap = proto.snapshot(state);
      render();
    } catch (e) { /* ignore */ }
  });
}

// 启动入口。注意：这一行是页面真正跑起来的唯一触发点，
// 拆分脚本时必须保留（曾因它被当作「包装行」丢弃导致界面全空白）。
boot();
