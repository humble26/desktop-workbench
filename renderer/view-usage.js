'use strict';

/* view-usage.js —— 自动时间统计
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 自动时间统计
// ---------------------------------------------------------------
function fmtDur(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (h) return h + ' 小时' + (m ? ' ' + m + ' 分' : '');
  if (m) return m + ' 分钟';
  return sec + ' 秒';
}
const USAGE_COLORS = { '工作': '#5f7a99', '开发': '#6f8f6a', '浏览': '#bd8a4e', '沟通': '#b5715a', '娱乐': '#7d7195', '其他': '#9aa1ac', '桌面工作台': '#2563eb' };
function usageColor(name) {
  if (USAGE_COLORS[name]) return USAGE_COLORS[name];
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ['#6f8f6a', '#5f7a99', '#bd8a4e', '#b5715a', '#7d7195'][h % 5];
}
function usageBarRows(list, colorOf) {
  if (!list.length) return '<div class="empty" style="padding:26px 10px">还没有记录</div>';
  const max = Math.max(1, ...list.map(x => x.seconds));
  return list.map(x => `
    <div class="u-bar-row" title="${esc(x.name)}：${esc(fmtDur(x.seconds))}">
      <span class="u-bar-name">${colorOf ? `<span class="u-dot" style="background:${colorOf(x.name)}"></span>` : ''}${esc(x.name)}</span>
      <div class="u-bar-track"><div class="u-bar-fill" style="width:${Math.max(2, Math.round(x.seconds / max * 100))}%;background:${colorOf ? colorOf(x.name) : 'var(--module-2)'}"></div></div>
      <span class="u-bar-val">${esc(fmtDur(x.seconds))}</span>
    </div>`).join('');
}
function usageEmptyState(v, title, desc, btn) {
  v.innerHTML = `${header('usage')}
    <div class="empty card" style="padding:56px 20px"><div class="e">${icon('clock', 26)}</div>
    <div>${esc(title)}</div><div class="dim" style="font-size:12px;margin-top:6px">${esc(desc)}</div>
    ${btn ? `<div style="margin-top:16px"><button class="btn" data-act="goto-settings">去设置开启</button></div>` : ''}</div>`;
}

async function renderUsage(v) {
  const tt = state.settings.timeTrack || {};
  let sum = null;
  try { sum = await api.getUsageSummary({ days: 7 }); } catch (e) { sum = null; }
  if (!sum) sum = emptyUsageShape();

  if (sum.supported === false) {
    usageEmptyState(v, '时间统计仅支持 Windows 系统', '其他平台不采集任何数据。', false);
    return;
  }
  if (tt.enabled !== true) {
    usageEmptyState(v, '时间统计未开启', '开启后会在后台记录各应用的活跃时长并按规则自动分类，数据仅保存在本机。', true);
    return;
  }

  const todayTotal = sum.today.total || 0;
  const yd = sum.daily.length >= 2 ? sum.daily[sum.daily.length - 2] : null;
  let delta = '';
  if (yd && yd.total > 0) {
    const pct = Math.round((todayTotal - yd.total) / yd.total * 100);
    delta = (pct >= 0 ? '+' : '') + pct + '%';
  } else if (todayTotal > 0) {
    delta = '昨日未记录';
  }
  const topApp = (sum.today.topApps && sum.today.topApps[0]) || null;
  const catRows = usageBarRows(sum.today.categories, usageColor);
  const appRows = usageBarRows(sum.topApps, null);
  const maxDay = Math.max(1, ...(sum.daily || []).map(d => d.total));
  const cols = (sum.daily || []).map(d => `
    <div class="u-col" title="${esc(d.date)}：${esc(fmtDur(d.total))}">
      <div class="u-col-track"><div class="u-col-fill" style="height:${Math.max(3, Math.round(d.total / maxDay * 100))}%"></div></div>
      <div class="u-col-l">${d.date === dateKey() ? '今天' : esc(d.date.slice(5))}</div>
    </div>`).join('');
  const titleRows = (sum.topTitles || []).map(t => `
    <div class="u-title-row" title="${esc(t.app)} | ${esc(t.title)}">
      <span class="u-title-app">${esc(t.app)}</span>
      <span class="u-title-t">${esc(t.title)}</span>
      <span class="u-bar-val">${esc(fmtDur(t.seconds))}</span>
    </div>`).join('');

  v.innerHTML = `
    ${header('usage', `<span class="usage-flag">${icon('clock', 13)} 采样中 · 每 5 秒</span>`)}
    <div class="stats">
      <div class="stat">${chip('clock', '快捷入口')}<div class="v">${esc(fmtDur(todayTotal))}</div><div class="l">今日活跃时长${delta ? ' · 较昨日 ' + esc(delta) : ''}</div></div>
      <div class="stat">${chip('grid', '待办')}<div class="v" style="font-size:16px;line-height:34px">${esc(topApp ? topApp.name : '—')}</div><div class="l">今日最常用应用${topApp ? ' · ' + esc(fmtDur(topApp.seconds)) : ''}</div></div>
      <div class="stat">${chip('calendar', '数据洞察')}<div class="v">${sum.dayCount || 0}</div><div class="l">已记录天数 · 自动保留 90 天</div></div>
      <div class="stat">${chip('timer', '打卡')}<div class="v">${sum.pomodoros.today || 0}</div><div class="l">今日番茄 · 本周 ${sum.pomodoros.week || 0} 个</div></div>
    </div>
    <div class="insight-grid">
      <div class="card insight-card">
        <div class="insight-t">今日分类占比<span class="insight-sub">按分类规则自动归类</span></div>
        ${catRows}
      </div>
      <div class="card insight-card">
        <div class="insight-t">应用时长 Top 10<span class="insight-sub">近 7 天</span></div>
        ${appRows}
      </div>
    </div>
    <div class="card insight-card" style="margin-top:16px">
      <div class="insight-t">近 7 天每日活跃<span class="insight-sub">每天合计</span></div>
      <div class="u-cols">${cols}</div>
      <div class="insight-note">番茄钟专注时段已计入对应应用；今日专注 ${sum.pomodoros.today || 0} 个番茄 · 近 7 天 ${sum.pomodoros.week || 0} 个</div>
    </div>
    ${tt.recordTitles === true ? `<div class="card insight-card" style="margin-top:16px">
      <div class="insight-t">窗口标题 Top 10<span class="insight-sub">近 7 天 · 需开启「记录窗口标题」</span></div>
      ${titleRows || '<div class="empty" style="padding:26px 10px">还没有标题记录</div>'}
    </div>` : ''}`;
}
function emptyUsageShape() {
  return {
    supported: true, enabled: false, dayCount: 0,
    today: { total: 0, categories: [], topApps: [] },
    daily: [], topApps: [], categories: [], topTitles: [],
    pomodoros: { today: 0, week: 0 }
  };
}

