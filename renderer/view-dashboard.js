'use strict';

/* view-dashboard.js —— 首页
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 首页
// ---------------------------------------------------------------
const CHIP = { 待办: 'c1', 待办清单: 'c1', 打卡: 'c4', 习惯打卡: 'c4', 快捷入口: 'c2', 文件整理: 'c5', 便签: 'c3', 番茄钟: 'c2', 数据洞察: 'c5', 设置: 'c2', 今日已完成待办: 'c1', 今日打卡: 'c4', 累计便签: 'c5' };
function chip(ic, key, size) {
  const cls = CHIP[key] || 'c2';
  return `<div class="ic chip ${cls}"${size ? ` style="width:${size}px;height:${size}px"` : ''}>${icon(ic, 18)}</div>`;
}
function renderDashboard(v) {
  const open = state.todos.filter(t => !t.done).length;
  const doneToday = state.checkins.filter(c => c.done).length;
  const fileCount = state.groups.reduce((s, g) => s + g.items.length, 0);
  v.innerHTML = `
    <div class="greet">
      <span class="hi">${esc(greetingText())}，${esc(state.profile.name || '朋友')}</span>
      <div class="sub">今天也要把生活和工作安排得井井有条。按 <b>Win+Alt+Space</b> 可随时显示 / 隐藏工作台。</div>
      <div class="clock"><div class="t" id="clock">--:--</div><div class="d" id="clockd"></div></div>
    </div>
    <div class="stats">
      <div class="stat" data-nav="todos">${chip('check-square', '待办')}<div class="v">${open}</div><div class="l">待办未完成</div></div>
      <div class="stat" data-nav="checkins">${chip('flame', '打卡')}<div class="v">${doneToday}</div><div class="l">今日已打卡</div></div>
      <div class="stat" data-nav="shortcuts">${chip('grid', '快捷入口')}<div class="v">${state.shortcuts.length}</div><div class="l">快捷入口</div></div>
      <div class="stat" data-nav="files">${chip('folder', '文件整理')}<div class="v">${fileCount}</div><div class="l">已整理文件</div></div>
    </div>
    <div class="sec-title">快速开始<span class="plus" data-act="quick" title="更多"></span></div>
    <div class="mod-grid">
      ${quickCard('shortcuts', '快捷入口', '常用应用一键启动')}
      ${quickCard('files', '文件整理', '把文件按分组收纳')}
      ${quickCard('todos', '待办清单', '记录今天要完成的事')}
      ${quickCard('notes', '便签灵感', '随手记下想法')}
      ${quickCard('checkins', '习惯打卡', '坚持就是胜利')}
      ${quickCard('pomodoro', '番茄钟', '专注 25 分钟')}
      ${quickCard('stats', '数据洞察', '看看你的进度')}
      ${quickCard('settings', '设置', '外观与启动项')}
    </div>`;
  updateClock();
}
function quickCard(id, name, desc) {
  return `<div class="modcard" data-nav="${id}"><div class="mh">${chip(name === '便签灵感' ? 'note' : (NAV.find(n => n.id === id) || {}).icon || 'grid', name === '便签灵感' ? '便签' : name, 38)}<div class="mt"><div class="mn">${esc(name)}</div><div class="md">${esc(desc)}</div></div></div></div>`;
}
let clockTimer = null;
function updateClock() {
  if (clockTimer) clearInterval(clockTimer);
  function tick() {
    const d = new Date();
    const t = $('#clock'); if (t) t.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const dd = $('#clockd');
    if (dd) {
      const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
      dd.textContent = `${d.getMonth() + 1}月${d.getDate()}日 星期${wk}`;
    }
  }
  tick();
  clockTimer = setInterval(tick, 1000 * 10);
}

