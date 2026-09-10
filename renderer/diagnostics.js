'use strict';

/* diagnostics.js —— 运行环境诊断（设置页）
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 运行环境诊断（设置页）：把主进程侧的能力探测与降级原因显示出来，
// 取代过去「功能没反应但毫无提示」的静默降级
// ---------------------------------------------------------------
const FEATURE_LABEL = {
  'clipboard-file-list': '剪贴板多文件识别',
  'clipboard-file-writeback': '剪贴板文件写回',
  'lnk-resolve': '快捷方式目标解析',
  'icon-extract': '图标提取兜底',
  'usage-helper': '时间统计采样'
};
const warnedFeatures = {};   // 每个降级功能只提醒一次

// 预留：诊断行渲染格式统一入口（当前由 paintDiagnostics 直接拼装）

async function paintDiagnostics() {
  let d = null;
  try { d = await api.diagnostics(); } catch (e) { d = null; }
  const set = (id, text) => { const el = $(id); if (el) el.textContent = text; };
  if (!d) {
    set('#diagPs', '无法读取诊断信息');
    set('#diagStore', '无法读取诊断信息');
    set('#diagUsage', '无法读取诊断信息');
    set('#diagClip', '无法读取诊断信息');
    set('#diagHotkey', '无法读取诊断信息');
    return;
  }
  const p = d.powershell || {};
  if (!p.checked) set('#diagPs', '检测中…');
  else if (p.available) set('#diagPs', `${p.exe} · ${p.version || '?'} · ${p.languageMode || '?'}` + (p.canAddType ? '' : '（不支持 Add-Type）'));
  else set('#diagPs', '不可用：' + (p.reason === 'not-windows' ? '当前系统不是 Windows' : (p.reason || '未知原因')));

  const st = d.store || {};
  set('#diagStore', `schema v${(d.store && d.store.migrated && d.store.migrated.to) || 2} · 修订号 ${st.rev || 0} · ${st.dirty ? '待落盘' : '已落盘'}` +
    (st.recoveredFrom ? ` · 曾从备份恢复（${st.recoveredFrom}）` : '') +
    (st.lastError ? ` · 写入异常：${st.lastError}` : ''));

  const u = d.usage || {};
  set('#diagUsage', u.enabled ? (u.sampling ? '运行中（每 5 秒采样）' : '已开启但采样进程未运行') : '未开启');

  const c = d.clipboard || {};
  set('#diagClip', c.historyEnabled ? `已开启 · 现有 ${c.items} 条` : '已关闭');

  // 全局快捷键：注册失败（被其他程序占用）过去完全静默，这里明确列出
  const keys = Array.isArray(d.hotkeys) ? d.hotkeys : [];
  if (!keys.length) set('#diagHotkey', d.platform === 'win32' ? '未注册' : '当前系统未注册全局快捷键');
  else {
    const bad = keys.filter(k => !k.ok);
    set('#diagHotkey', keys.map(k => k.label + (k.ok ? ' ✓' : ' ✗')).join(' · ') +
      (bad.length ? `（${bad.length} 个被占用，可在系统里换个组合或关闭冲突程序）` : ''));
  }

  // 图标缓存体积：数据文件不该再被 base64 图标撑大
  const ic = d.icons || {};
  const icEl = $('#diagIcons');
  if (icEl) {
    const kb = Math.round((ic.bytes || 0) / 1024);
    icEl.textContent = ic.files ? `${ic.files} 个 · ${kb} KB（独立存放，不占数据文件）` : '暂无缓存';
  }

  // 功能级降级清单
  const box = $('#diagFeatures');
  if (box) {
    const feats = Object.keys(p.features || {}).filter(k => p.features[k] && p.features[k].ok === false);
    if (!feats.length) { box.style.display = 'none'; box.innerHTML = ''; }
    else {
      box.style.display = '';
      box.innerHTML = '<b>降级中的功能</b><br />' + feats.map(k =>
        '· ' + esc(FEATURE_LABEL[k] || k) + '：' + esc(p.features[k].msg || '不可用')).join('<br />');
    }
  }
}

