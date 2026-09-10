'use strict';

(function () {
  const api = window.api;
  if (!api) return;
  const $ = (s, r = document) => r.querySelector(s);

  const img = $('#shotImg');
  const rectEl = $('#shotRect');
  let ratioX = 1, ratioY = 1;   // 截图物理像素 / CSS 像素（覆盖层为工作区、截图为全屏，横纵比例可能不同）
  let dragStart = null;
  let dragging = false;

  // 跟随应用主题（结果面板用；主进程 load 返回 { rev, data }）
  api.load().then((r) => {
    const st = (r && r.data) ? r.data : r;
    const th = (st && st.settings && st.settings.theme) || 'light';
    const dark = th === 'dark' || (th === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    document.documentElement.classList.toggle('dark', dark);
  }).catch(() => { /* ignore */ });

  api.shotReady();
  api.onShotInit(({ dataUrl }) => {
    if (!dataUrl) return;
    // 复位到框选态：窗口是复用的，上次可能停在结果态
    document.body.classList.remove('result');
    document.body.classList.add('select');
    rectEl.style.display = 'block';
    $('#shotHint').style.display = '';
    $('#shotResult').style.display = 'none';
    img.onload = () => {
      ratioX = img.naturalWidth / Math.max(1, img.clientWidth);
      ratioY = img.naturalHeight / Math.max(1, img.clientHeight);
    };
    img.src = dataUrl;
  });

  document.addEventListener('mousedown', (e) => {
    if (e.button !== 0 || !document.body.classList.contains('select')) return;
    dragging = true;
    dragStart = { x: e.clientX, y: e.clientY };
    rectEl.style.left = e.clientX + 'px';
    rectEl.style.top = e.clientY + 'px';
    rectEl.style.width = '0px';
    rectEl.style.height = '0px';
  });

  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const x = Math.min(dragStart.x, e.clientX);
    const y = Math.min(dragStart.y, e.clientY);
    rectEl.style.left = x + 'px';
    rectEl.style.top = y + 'px';
    rectEl.style.width = Math.abs(e.clientX - dragStart.x) + 'px';
    rectEl.style.height = Math.abs(e.clientY - dragStart.y) + 'px';
  });

  document.addEventListener('mouseup', (e) => {
    if (!dragging) return;
    dragging = false;
    const x = Math.min(dragStart.x, e.clientX);
    const y = Math.min(dragStart.y, e.clientY);
    const w = Math.abs(e.clientX - dragStart.x);
    const h = Math.abs(e.clientY - dragStart.y);
    if (w < 8 || h < 8) { rectEl.style.width = '0px'; rectEl.style.height = '0px'; return; }
    // CSS 选区换算到截图物理像素后裁剪，保证清晰度（横纵比例独立换算）
    const sx = Math.round(x * ratioX);
    const sy = Math.round(y * ratioY);
    const sw = Math.max(1, Math.round(w * ratioX));
    const sh = Math.max(1, Math.round(h * ratioY));
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = sh;
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    api.shotSubmitCrop(c.toDataURL('image/png'));
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') api.shotCancel();
  });

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  api.onShotResult(({ text }) => {
    document.body.classList.remove('select');
    document.body.classList.add('result');
    rectEl.style.display = 'none';
    $('#shotHint').style.display = 'none';
    const box = $('#srText');
    box.innerHTML = text
      ? esc(text).replace(/\n/g, '<br>')
      : '<span class="dim">未识别出文字，请重试或调整框选区域。</span>';
    $('#shotResult').style.display = 'flex';
    const copyBtn = $('#srCopy');
    copyBtn.disabled = !text;
    copyBtn.onclick = () => {
      api.shotCopy();
      copyBtn.classList.add('done');
      const old = copyBtn.innerHTML;
      copyBtn.textContent = '已复制';
      setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.innerHTML = old; }, 1500);
    };
    $('#srClose').onclick = () => api.shotClose();
  });
})();
