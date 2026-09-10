'use strict';

/* app.js —— 启动
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 启动
// ---------------------------------------------------------------
// 启动阶段标记：主进程会在窗口加载后检查 __wbBooted，
// 若为 false 就弹出原生错误框并把 __wbStage 一并显示出来 ——
// 这样即使页面完全没起来（脚本报错、IPC 全被拒），也能知道卡在哪一步。
function markStage(stage) {
  try { window.__wbStage = String(stage); } catch (e) { /* ignore */ }
}
markStage('app-loaded');

async function boot() {
  markStage('boot-started');
  if (!api) { markStage('failed: preload 未加载'); showFatalError('preload 未加载', '窗口未能注入 preload.js，因此拿不到数据与系统能力接口。\n请确认安装完整（重装一次通常可解决）。'); return; }
  if (!proto) { markStage('failed: storeproto 未加载'); showFatalError('storeproto.js 未加载', '数据协议脚本缺失，已停止启动（继续运行会丢失改动）。\n请确认安装完整（重装一次通常可解决）。'); return; }
  let loaded = null;
  try {
    loaded = await api.load();
  } catch (e) {
    // 关键：请求数据失败时必须**看得见**，不能像 v1.8.2 那样整屏空白
    markStage('failed: api.load 被拒绝 — ' + ((e && (e.message || e)) || e));
    showFatalError('读取本地数据失败', '主进程拒绝了这次请求或读取过程出错：\n\n' +
      ((e && (e.stack || e.message)) || String(e)) +
      '\n\n可能原因：安装不完整、主进程启动异常、或权限问题。\n数据文件未被修改，可安全地重试或重装。');
    return;
  }
  markStage('data-loaded');
  if (!loaded || (!loaded.data && !loaded.todos)) {
    markStage('failed: 数据结构异常');
    showFatalError('读取本地数据失败', '主进程返回的数据为空或格式不正确：\n\n' + JSON.stringify(loaded).slice(0, 400));
    return;
  }
  state = loaded.data ? loaded.data : loaded;   // 主进程返回 { rev, data }
  baseRev = loaded.rev || 0;
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
  try {
    serverSnap = proto.snapshot(state);   // 建立差分基线（不含界面状态）
    applyAccent();
    syncLayout();
    initWinControls();
    render();
    appRendered = true;                   // 之后的偶发错误降级为 toast，不再弹面板
  } catch (e) {
    markStage('failed: 渲染异常 — ' + ((e && (e.message || e)) || e));
    showFatalError('界面渲染失败', ((e && (e.stack || e.message)) || String(e)) +
      '\n\n数据文件未被修改。可按「重试」，若反复出现请把上面的文字反馈给我。');
    return;
  }
  // 走到这里说明界面已经起来了：主进程据此判定启动成功
  markStage('rendered');
  try { window.__wbBooted = true; } catch (e) { /* ignore */ }
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
