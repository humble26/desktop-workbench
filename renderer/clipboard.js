'use strict';

(function () {
  const api = window.api;
  if (!api) return;
  const $ = (s, r = document) => r.querySelector(s);

  const ICONS = {
    text: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-4-4-8 8"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    pin: '<path d="M12 17v5"/><path d="M9 4h6l1 7 2 2H6l2-2z"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14"/>',
    ocr: '<path d="M4 8V6a2 2 0 0 1 2-2h2"/><path d="M16 4h2a2 2 0 0 1 2 2v2"/><path d="M20 16v2a2 2 0 0 1-2 2h-2"/><path d="M8 20H6a2 2 0 0 1-2-2v-2"/><path d="M8 10h8"/><path d="M8 14h5"/>',
    check: '<path d="m4 12 5 5L20 6"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'
  };
  function icon(name, size = 15) {
    const p = ICONS[name] || ICONS.text;
    return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  }

  // 跟随应用主题
  try {
    api.load().then((st) => {
      const th = (st && st.settings && st.settings.theme) || 'light';
      const dark = th === 'dark' || (th === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
    }).catch(() => { /* ignore */ });
  } catch (e) { /* ignore */ }

  const listEl = $('#cbList');
  const searchEl = $('#cbSearch');
  const ovl = $('#cbOvl');
  const TYPE_NAME = { text: '文本', image: '图片', file: '文件' };

  let items = [];
  let filter = 'all';
  let sel = 0;
  let confirmClearUntil = 0;
  const ocrBusy = new Set();

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function pad(n) { return String(n).padStart(2, '0'); }
  function timeStr(ts) {
    const d = new Date(ts || Date.now());
    const now = new Date();
    const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
    return sameDay ? `${pad(d.getHours())}:${pad(d.getMinutes())}` : `${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  function fileBase(p) { return String(p || '').split(/[\\/]/).pop() || p || ''; }

  function titleSubOf(it) {
    if (it.type === 'text') {
      const lines = String(it.text || '').split('\n');
      return { t: lines[0] || '(空白)', s: lines.length > 1 ? `${lines.length} 行` : '' };
    }
    if (it.type === 'image') {
      const size = it.width && it.height ? ` ${it.width}×${it.height}` : '';
      return { t: `图片${size}`, s: it.ocrText ? String(it.ocrText).split('\n')[0] : '' };
    }
    const files = Array.isArray(it.files) ? it.files : [];
    const names = files.map(fileBase);
    return { t: names[0] || '(空)', s: files.length > 1 ? `等 ${files.length} 个文件 · ${names.slice(1, 3).join('、')}${files.length > 3 ? '…' : ''}` : '文件' };
  }

  async function refresh(keepSel) {
    try {
      items = await api.clipList({ query: searchEl.value.trim(), type: filter });
    } catch (e) {
      items = [];
    }
    if (sel >= items.length) sel = Math.max(0, items.length - 1);
    if (!keepSel) sel = 0;
    paint();
  }

  function paint() {
    if (!items.length) {
      const q = searchEl.value.trim();
      listEl.innerHTML = `<div class="cb-empty">${q ? '没有匹配的记录' : '剪贴板还是空的，复制点东西试试'}</div>`;
      return;
    }
    listEl.innerHTML = items.map((it, i) => {
      const ts = titleSubOf(it);
      const busy = ocrBusy.has(it.id);
      return `<div class="cb-item ${i === sel ? 'on' : ''} ${it.pinned ? 'ispin' : ''}" data-ci="${it.id}" title="${esc(it.type === 'file' ? (it.files || []).join('\n') : (it.text || '图片'))}">
        <div class="cb-ic ${it.type}">${it.type === 'image' && it.thumb
          ? `<img src="${it.thumb}" alt="" draggable="false" />`
          : icon(it.type === 'file' ? 'file' : 'text', 18)}</div>
        <div class="cb-b">
          <div class="cb-t">${esc(ts.t)}</div>
          <div class="cb-s">${it.pinned ? `<span class="cb-pinflag">${icon('pin', 10)} 置顶</span>` : ''}${esc(ts.s || TYPE_NAME[it.type] || '')}</div>
        </div>
        <span class="cb-tag ${it.type}">${TYPE_NAME[it.type] || ''}</span>
        <span class="cb-time">${timeStr(it.time)}</span>
        <div class="cb-acts">
          ${it.type === 'image' ? `<button data-ca="ocr" title="OCR 提字">${icon('ocr', 15)}</button>` : ''}
          <button data-ca="pin" title="${it.pinned ? '取消置顶' : '置顶'}">${icon('pin', 15)}</button>
          <button data-ca="copy" title="复制">${icon('copy', 15)}</button>
          <button data-ca="del" title="删除">${icon('trash', 15)}</button>
        </div>
        ${busy ? '<div class="cb-busy">识别中…</div>' : ''}
      </div>`;
    }).join('');
    const on = listEl.querySelector('.cb-item.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }

  function closeOvl() { ovl.innerHTML = ''; }

  function openImagePreview(it) {
    if (!it.imagePath) return;
    const src = encodeURI('file:///' + String(it.imagePath).replace(/\\/g, '/'));
    ovl.innerHTML = `<div class="overlay" id="cbOvlBox"><div class="modal cb-modal">
      <h3>图片预览 <span class="dim" style="font-size:12px;font-weight:600">${it.width || '?'}×${it.height || '?'}</span></h3>
      <div class="cb-preview"><img src="${src}" alt="" draggable="false" /></div>
      <div class="modal-actions">
        <button class="btn" id="cbPvCopy">${icon('copy', 14)} 复制图片</button>
        <button class="btn ghost" id="cbPvOcr">${icon('ocr', 14)} OCR 提字</button>
        <div class="spacer"></div>
        <button class="btn ghost" id="cbPvClose">关闭</button>
      </div>
    </div></div>`;
    const box = $('#cbOvlBox');
    box.addEventListener('mousedown', e => { if (e.target === box) closeOvl(); });
    $('#cbPvClose').onclick = closeOvl;
    $('#cbPvCopy').onclick = async () => { await api.clipCopy(it.id); api.hideClip(); };
    $('#cbPvOcr').onclick = () => { closeOvl(); runOcr(it); };
  }

  function openOcrPanel(it, text) {
    ovl.innerHTML = `<div class="overlay" id="cbOvlBox"><div class="modal cb-modal">
      <h3>OCR 提字结果 <span class="dim" style="font-size:12px;font-weight:600">内置 chi_sim+eng 离线识别</span></h3>
      <div class="cb-ocr-text">${esc(text || '（未识别出文字）')}</div>
      <div class="modal-actions">
        <button class="btn" id="cbOcrCopy">${icon('copy', 14)} 复制文字</button>
        <div class="spacer"></div>
        <button class="btn ghost" id="cbOcrClose">关闭</button>
      </div>
    </div></div>`;
    const box = $('#cbOvlBox');
    box.addEventListener('mousedown', e => { if (e.target === box) closeOvl(); });
    $('#cbOcrClose').onclick = closeOvl;
    $('#cbOcrCopy').onclick = async () => {
      await navigator.clipboard.writeText(text || '').catch(() => { });
      closeOvl();
    };
  }

  async function runOcr(it) {
    if (ocrBusy.has(it.id)) return;
    ocrBusy.add(it.id);
    paint();
    try {
      const r = await api.clipOcr(it.id);
      ocrBusy.delete(it.id);
      if (!r || !r.ok) {
        openOcrPanel(it, '识别失败：' + ((r && r.msg) || '未知错误'));
      } else {
        const fresh = items.find(x => x.id === it.id);
        if (fresh) fresh.ocrText = r.text;
        openOcrPanel(it, r.text);
      }
    } catch (e) {
      ocrBusy.delete(it.id);
      openOcrPanel(it, '识别失败：' + (e && e.message || e));
    }
    paint();
  }

  listEl.addEventListener('click', async (e) => {
    const row = e.target.closest('.cb-item[data-ci]');
    if (!row) return;
    const id = row.dataset.ci;
    const it = items.find(x => x.id === id);
    if (!it) return;
    const act = e.target.closest('[data-ca]');
    if (act) {
      const a = act.dataset.ca;
      if (a === 'copy') { await api.clipCopy(id); api.hideClip(); }
      else if (a === 'del') { await api.clipDelete(id); await refresh(true); }
      else if (a === 'pin') { await api.clipPin(id); await refresh(true); }
      else if (a === 'ocr') { if (it.type === 'image') runOcr(it); }
      return;
    }
    if (it.type === 'image') { openImagePreview(it); return; }
    await api.clipCopy(id);
    api.hideClip();
  });

  listEl.addEventListener('dblclick', async (e) => {
    const row = e.target.closest('.cb-item[data-ci]');
    if (!row || e.target.closest('[data-ca]')) return;
    const it = items.find(x => x.id === row.dataset.ci);
    if (it && it.type !== 'image') { await api.clipCopy(it.id); api.hideClip(); }
  });

  // 过滤切换
  $('#cbFilters').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-cbf]');
    if (!chip) return;
    filter = chip.dataset.cbf;
    document.querySelectorAll('#cbFilters .opt').forEach(x => x.classList.toggle('on', x === chip));
    refresh();
  });

  // 搜索（防抖）
  let searchTimer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => refresh(), 150);
  });

  // 清空未置顶（二次确认）
  const clearBtn = $('#cbClear');
  let clearArmed = false;
  clearBtn.addEventListener('click', async () => {
    if (!clearArmed) {
      clearArmed = true;
      clearBtn.textContent = '确认清空？';
      clearBtn.classList.add('danger');
      setTimeout(() => {
        clearArmed = false;
        clearBtn.textContent = '清空未置顶';
        clearBtn.classList.remove('danger');
      }, 3000);
      return;
    }
    clearArmed = false;
    clearBtn.textContent = '清空未置顶';
    clearBtn.classList.remove('danger');
    await api.clipClear();
    refresh();
  });

  // 键盘操作
  searchEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (items.length) { sel = (sel + 1) % items.length; paint(); } }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (items.length) { sel = (sel - 1 + items.length) % items.length; paint(); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[sel];
      if (it) { api.clipCopy(it.id); api.hideClip(); }
    }
    else if (e.key === 'Delete') {
      e.preventDefault();
      const it = items[sel];
      if (it) { api.clipDelete(it.id).then(() => refresh(true)); }
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (ovl.innerHTML) closeOvl();
      else api.hideClip();
    }
  });

  // 弹窗每次唤出：重置搜索并刷新
  api.onClipReset && api.onClipReset(() => {
    searchEl.value = '';
    sel = 0;
    closeOvl();
    refresh();
    setTimeout(() => { searchEl.focus(); searchEl.select(); }, 30);
  });
  // 采集到新内容时刷新列表（保持当前选择）
  let updTimer = null;
  api.onClipUpdated && api.onClipUpdated(() => {
    clearTimeout(updTimer);
    updTimer = setTimeout(() => refresh(true), 120);
  });

  refresh();
  setTimeout(() => { searchEl.focus(); }, 40);
})();
