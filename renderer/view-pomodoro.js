'use strict';

/* view-pomodoro.js —— 番茄钟
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 番茄钟
// ---------------------------------------------------------------
const POMO_MODES = [
  { key: 'focus', label: '专注', min: 25, color: 'var(--module-3)' },
  { key: 'short', label: '短休', min: 5, color: 'var(--module-1)' },
  { key: 'long', label: '长休', min: 15, color: 'var(--module-2)' }
];
function pomoPreset(k) { return POMO_MODES.find(x => x.key === (k || 'focus')) || POMO_MODES[0]; }
function pomoModeLabel(cfg) { return cfg.mode === 'custom' ? (cfg.minutes || 25) + ' 分钟' : pomoPreset(cfg.mode).label; }
function fmtP(s) { s = Math.max(0, Math.round(s)); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }
function initPomo() {
  const cfg = state.settings.pomodoro = (state.settings.pomodoro && typeof state.settings.pomodoro === 'object') ? state.settings.pomodoro : {};
  const min = (cfg.minutes && cfg.minutes > 0) ? cfg.minutes : pomoPreset(cfg.mode).min;
  state._pomo = { total: min * 60, remaining: min * 60, running: false, _last: null };
}
function onPomoComplete() {
  const cfg = state.settings.pomodoro || {};
  const isFocus = (cfg.mode || 'focus') === 'focus';
  const label = pomoModeLabel(cfg);
  toast(label + '结束');
  try { api.notify(label + '结束', isFocus ? '刚完成一个番茄，起来休息一下吧' : '休息结束，可以继续专注了', true).catch(() => { }); } catch (e) { /* ignore */ }
  if (isFocus) {
    const tk = dateKey();
    state.pomoDone = state.pomoDone || {};
    state.pomoDone[tk] = (state.pomoDone[tk] || 0) + 1;
    save(true);
  }
}
function pomoTick() {
  if (!state || !state._pomo) return;
  const p = state._pomo;
  if (p.running) {
    const now = Date.now();
    const step = Math.round((now - (p._last || now)) / 1000);
    p._last = now;
    if (step > 0) p.remaining = Math.max(0, p.remaining - step);
    if (p.remaining === 0) { p.running = false; p._last = null; if (!p._firedComplete) { p._firedComplete = true; onPomoComplete(); } }
  }
  const dT = $('#pomoTime'); if (dT) dT.textContent = fmtP(p.remaining);
  const dBar = $('#pomoBar'); if (dBar && p.total) dBar.style.width = Math.max(0, Math.min(100, Math.round((p.total - p.remaining) / p.total * 100))) + '%';
  const dMode = $('#pomoModeName'); if (dMode) dMode.textContent = pomoModeLabel(state.settings.pomodoro || {});
  const dCount = $('#pomoCount'); if (dCount) dCount.textContent = '今日完成 ' + ((state.pomoDone && state.pomoDone[dateKey()]) || 0) + ' 个番茄';
  const runBtn = $('#pomoRun'); if (runBtn) runBtn.innerHTML = p.running ? icon('pause', 15) + ' 暂停' : icon('play', 15) + ' 开始';
}
function renderPomodoro(v) {
  const cfg = state.settings.pomodoro = (state.settings.pomodoro && typeof state.settings.pomodoro === 'object') ? state.settings.pomodoro : {};
  if (!state._pomo || !state._pomo.total) initPomo();
  const p = state._pomo;
  v.innerHTML = `
    ${header('pomodoro', `<div class="pomo-count">${icon('timer', 14)} <span id="pomoCount">今日完成 ${((state.pomoDone && state.pomoDone[dateKey()]) || 0)} 个番茄</span></div>`)}
    <div class="pomo-wrap">
      <div class="card pomo-main">
        <div class="pomo-mode" id="pomoModeName">${esc(pomoModeLabel(cfg))}</div>
        <div class="pomo-time" id="pomoTime">${fmtP(p.remaining)}</div>
        <div class="pomo-track"><div class="pomo-fill" id="pomoBar" style="width:${Math.round((p.total - p.remaining) / p.total * 100)}%"></div></div>
        <div class="pomo-actions">
          <button class="btn pomo-run" id="pomoRun">${icon('play', 15)} 开始</button>
          <button class="btn ghost" data-act="pomo-reset" title="重置">${icon('repeat', 16)} 重置</button>
        </div>
      </div>
      <div class="card pomo-side">
        <div class="drawer-title">时长</div>
        <div class="seg" style="display:flex;flex-wrap:wrap;gap:8px">
          ${POMO_MODES.map(md => `<div class="opt ${(cfg.mode || 'focus') === md.key ? 'on' : ''}" data-act="pomo-mode" data-mode="${md.key}" style="flex:0 0 auto">${esc(md.label)} · ${md.min}分钟</div>`).join('')}
        </div>
        <div style="height:16px"></div>
        <div class="drawer-title">自定义时长（分钟）</div>
        <div class="due-row">
          <input type="number" id="pomoCustom" min="1" max="180" value="${cfg.minutes || pomoPreset(cfg.mode).min}" style="flex:0 0 120px;width:120px" />
          <button class="btn ghost sm" data-act="pomo-apply">应用</button>
        </div>
        <div class="due-hint" style="margin-top:12px">计时结束会弹出系统通知；专注完成会自动累计今天的番茄数。</div>
      </div>
    </div>`;
  const run = $('#pomoRun');
  if (run) run.onclick = () => { if (p.running) { p.running = false; p._last = null; } else { p._last = Date.now(); p.running = true; p._firedComplete = false; } render(); };
}

