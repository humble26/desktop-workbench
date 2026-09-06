'use strict';

(function () {
  const api = window.api;
  if (!api) return;
  const $ = (s, r = document) => r.querySelector(s);
  const type = new URLSearchParams(location.search).get('type') || 'clock';
  const TITLES = { clock: '时钟', todos: '今日待办', notes: '便签' };
  const DOTS = { clock: '#5f7a99', todos: '#6f8f6a', notes: '#bd8a4e' };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { d = d || new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

  const body = $('#wgBody');
  $('#wgTitle').textContent = TITLES[type] || '小组件';
  $('#wgDot').style.background = DOTS[type] || '#5f7a99';
  $('#wgClose').onclick = () => api.widgetsClose(type);
  $('#wgOpen').onclick = () => api.widgetsOpenMain();

  // 跟随应用主题
  api.load().then((st) => {
    const th = (st && st.settings && st.settings.theme) || 'light';
    const dark = th === 'dark' || (th === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  }).catch(() => { /* ignore */ });

  // ---------------- 时钟 ----------------
  function renderClock() {
    const d = new Date();
    const wk = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    body.innerHTML = `
      <div class="wgc">
        <div class="wgc-time">${pad(d.getHours())}:${pad(d.getMinutes())}</div>
        <div class="wgc-date">${d.getMonth() + 1}月${d.getDate()}日 星期${wk} · ${d.getFullYear()}</div>
      </div>`;
  }

  // ---------------- 今日待办 / 便签 ----------------
  async function renderFromStore() {
    if (document.hidden) return; // 组件隐藏时跳过无谓轮询
    let st = null;
    try { st = await api.load(); } catch (e) { return; }
    if (!st) return;
    if (type === 'todos') {
      const tk = dateKey();
      const list = (st.todos || []).filter(t => !t.done && t.due && t.due <= tk)
        .sort((a, b) => (a.dueTime || '').localeCompare(b.dueTime || '')).slice(0, 12);
      $('#wgTitle').textContent = `今日待办${list.length ? ' · ' + list.length : ''}`;
      body.innerHTML = list.length ? list.map(t => `
        <div class="wgt ${t.due < tk ? 'over' : ''}" title="${esc(t.text)}">
          <span class="wgt-dot"></span>
          <span class="wgt-txt">${esc(t.text)}</span>
          <span class="wgt-meta">${t.due < tk ? '逾期' : esc(t.dueTime || '')}</span>
        </div>`).join('')
        : '<div class="wg-empty">今天没有待办，享受当下 🎉</div>';
    } else if (type === 'notes') {
      const list = (st.notes || []).slice(0, 10);
      body.innerHTML = list.length ? list.map(n => `
        <div class="wgn" title="${esc(n.title || '无标题')}">
          <div class="wgn-t">${esc(n.title || '无标题')}</div>
          ${n.body ? `<div class="wgn-b">${esc(String(n.body).slice(0, 60))}</div>` : ''}
          <div class="wgn-d">${esc(n.date || '')}</div>
        </div>`).join('')
        : '<div class="wg-empty">还没有便签，去工作台记下第一条灵感</div>';
    }
  }

  if (type === 'clock') {
    renderClock();
    setInterval(renderClock, 1000);
  } else {
    renderFromStore();
    setInterval(renderFromStore, 10000);
    // 隐藏期间跳过了轮询，重新显示时立即刷新一次
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) renderFromStore();
    });
  }
})();
