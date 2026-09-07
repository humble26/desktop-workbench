(function () {
  const api = window.api;
  if (!api) return;
  const inp = document.getElementById('qaInput');
  if (!inp) return;

  // 跟随应用主题，避免深色模式下小窗仍显示浅色样式
  try {
    api.load().then((st) => {
      const th = (st && st.settings && st.settings.theme) || 'light';
      const dark = th === 'dark' || (th === 'auto' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.classList.toggle('dark', dark);
    }).catch(() => { /* ignore */ });
  } catch (e) { /* ignore */ }

  function submit() {
    const v = (inp.value || '').trim();
    if (!v) return;
    api.addQuick(v).then(() => api.closeQuick()).catch(() => api.closeQuick());
  }

  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { e.preventDefault(); api.closeQuick(); }
  });

  function focusInput() { inp.value = ''; inp.focus(); }
  api.onQuickReset && api.onQuickReset(focusInput);
  setTimeout(focusInput, 40);
})();