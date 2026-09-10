'use strict';

/* view-stats.js —— 数据洞察
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 数据洞察
// ---------------------------------------------------------------
function kvRow(k, val, warn) {
  return `<div class="kv-row"><span class="kv-k">${esc(k)}</span><span class="kv-v${warn ? ' warn' : ''}">${val}</span></div>`;
}
async function renderStats(v) {
  const tk = dateKey();
  const todos = state.todos;
  const total = todos.length;
  const done = todos.filter(t => t.done).length;
  const open = total - done;
  const pct = total ? Math.round(done / total * 100) : 0;
  const doneToday = todos.filter(t => t.done && t.doneAt === tk).length;
  const monthKey = tk.slice(0, 7);
  const doneMonth = todos.filter(t => t.done && t.doneAt && t.doneAt.slice(0, 7) === monthKey).length;
  const overdue = todos.filter(t => !t.done && t.due && t.due < tk).length;
  const upcoming = todos.filter(t => !t.done && t.due === tk).length;
  const maxStreak = Math.max(0, ...state.checkins.map(c => c.streak || 0));
  const doneCkToday = state.checkins.filter(c => c.done).length;
  const notesN = state.notes.length;
  const filesN = state.groups.reduce((s, g) => s + g.items.length, 0);

  // 近 14 天活动强度
  const bars = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(tk + 'T00:00:00'); d.setDate(d.getDate() - i);
    const k = dateKey(d);
    const n = todos.filter(t => t.done && t.doneAt === k).length
      + state.notes.filter(x => x.date === k).length
      + state.checkins.filter(c => c.last === k).length;
    bars.push({ k, n });
  }
  const maxN = Math.max(1, ...bars.map(b => b.n));
  const barLabelAt = (k) => [0, 3, 6, 9].includes(new Date(k + 'T00:00:00').getDay()) ? k.slice(8) : '';

  // 自动时间统计（未开启/非 Windows 时优雅降级展示）
  let u = null;
  try { u = await api.getUsageSummary({ days: 7 }); } catch (e) { u = null; }
  const ttOn = !!(u && u.supported && state.settings.timeTrack && state.settings.timeTrack.enabled === true);
  const uTop = ttOn ? ((u.today.topApps && u.today.topApps[0]) || null) : null;
  const uTotalLabel = !u ? '—' : (u.supported === false ? '仅支持 Windows' : (ttOn ? fmtDur(u.today.total || 0) : '未开启'));
  const uTopLabel = !u ? '—' : (u.supported === false ? '仅支持 Windows' : (ttOn ? (uTop ? uTop.name + ' · ' + fmtDur(uTop.seconds) : '—') : '未开启'));

  v.innerHTML = `
    ${header('stats')}
    <div class="stats">
      <div class="stat">${chip('check-square', '待办')}<div class="v">${pct}%</div><div class="l">待办完成率（${done}/${total}）</div></div>
      <div class="stat">${chip('check', '今日已完成待办')}<div class="v">${doneToday}</div><div class="l">今日已完成待办</div></div>
      <div class="stat">${chip('flame', '今日打卡')}<div class="v">${doneCkToday}</div><div class="l">今日打卡 · 最高连续 ${maxStreak} 天</div></div>
      <div class="stat">${chip('note', '累计便签')}<div class="v">${notesN}</div><div class="l">累计便签 · ${doneMonth} 待办本月完成</div></div>
    </div>
    <div class="insight-grid">
      <div class="card insight-card">
        <div class="insight-t">近 14 天活动强度<span class="insight-sub">完成待办 · 便签 · 打卡</span></div>
        <div class="bars">${bars.map(b => `
          <div class="bar-col" title="${esc(b.k)}：${b.n}">
            <div class="bar-area"><div class="bar-fill" style="height:${Math.max(3, Math.round(b.n / maxN * 100))}%"></div></div>
            <div class="bar-l">${esc(barLabelAt(b.k) || '')}</div>
          </div>`).join('')}
        </div>
        <div class="insight-note">近 14 天共记录 ${bars.reduce((s, b) => s + b.n, 0)} 次活动 · 活跃峰值 ${maxN} / 天</div>
      </div>
      <div class="card insight-card">
        <div class="insight-t">当前情况一览</div>
        ${kvRow('待办总数', total)}
        ${kvRow('未完成待办', open)}
        ${kvRow('今日到期待办', upcoming)}
        ${kvRow('已逾期未完成', overdue, overdue > 0)}
        ${kvRow('本月已完成待办', doneMonth)}
        ${kvRow('已整理文件', filesN)}
        ${kvRow('习惯数', state.checkins.length)}
        ${kvRow('今日活跃时长', uTotalLabel)}
        ${kvRow('最常用应用', uTopLabel)}
      </div>
    </div>`;
}

