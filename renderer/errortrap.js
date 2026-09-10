'use strict';

/* ===========================================================================
   errortrap.js —— 最先加载的错误兜底（不依赖任何其它脚本）
   ---------------------------------------------------------------------------
   由来（两次真实事故）：
     1. 界面空白却没有任何提示，因为**错误提示代码本身也挂掉了** ——
        showFatalError 原本写在 core.js 里，而 core.js 正因为
        `const api = window.api` 与 preload 注入的不可配置全局同名而抛 SyntaxError，
        整个文件失效，于是"报错的面板"根本不存在。
     2. 因此：错误兜底必须放在**最早加载、且不依赖任何其它文件**的脚本里。

   约束（很重要）：
     · 只用最基础的浏览器 API，不引用任何本项目的其它全局（不用 esc/$/api 等）
     · 自己实现转义，不依赖 core.js
     · 只做"让失败看得见"，不做业务逻辑
   =========================================================================== */

window.__wbStage = window.__wbStage || 'scripts-loading';
window.__wbRendered = false;

function markStage(stage) {
  try { window.__wbStage = String(stage); } catch (e) { /* ignore */ }
}
function markRendered() {
  try { window.__wbRendered = true; } catch (e) { /* ignore */ }
}

var __wbFatalShown = false;

function __wbEscape(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 在页面上显示致命错误（不依赖任何其它脚本；样式全部内联，CSS 挂了也能看） */
function showFatalError(title, detail) {
  try {
    if (__wbFatalShown) return;
    __wbFatalShown = true;
    var text = String(title || '出错了') + '\n\n' + String(detail || '（无详细信息）');
    var box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;background:rgba(20,22,28,.78);padding:24px';
    box.innerHTML =
      '<div style="max-width:760px;width:100%;background:#fff;border-radius:16px;padding:24px 26px;box-shadow:0 24px 52px -18px rgba(0,0,0,.4);font-family:system-ui,-apple-system,\'Microsoft YaHei\',sans-serif;color:#1b1e26">' +
        '<div style="font-size:16px;font-weight:800;margin-bottom:10px">' + __wbEscape(title || '出错了') + '</div>' +
        '<div style="font-size:13px;line-height:1.7;white-space:pre-wrap;word-break:break-word;max-height:42vh;overflow:auto;background:#f3f4f7;border-radius:10px;padding:12px 14px;color:#4b5563">' + __wbEscape(detail || '（无详细信息）') + '</div>' +
        '<div style="display:flex;gap:10px;margin-top:16px">' +
          '<button id="__wbRetry" style="border:none;border-radius:9px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;background:#262a33;color:#fff">重试</button>' +
          '<button id="__wbCopy" style="border:1px solid #e8eaee;border-radius:9px;padding:10px 18px;font-size:13px;font-weight:600;cursor:pointer;background:transparent;color:#1b1e26">复制详情</button>' +
        '</div>' +
        '<div style="margin-top:12px;font-size:12px;color:#9aa1ac">反复出现时请把上面的文字反馈给维护者。此提示不会修改你的数据。</div>' +
      '</div>';
    document.body.appendChild(box);
    var retry = document.getElementById('__wbRetry');
    if (retry) retry.onclick = function () { try { location.reload(); } catch (e) { /* ignore */ } };
    var copy = document.getElementById('__wbCopy');
    if (copy) copy.onclick = function () {
      try {
        navigator.clipboard.writeText(text).then(function () { copy.textContent = '已复制'; }, function () { copy.textContent = '复制失败'; });
      } catch (e) { copy.textContent = '复制失败'; }
    };
  } catch (e) {
    try { document.body.innerHTML = '<pre style="padding:24px;white-space:pre-wrap">' + __wbEscape(title + '\n' + detail) + '</pre>'; } catch (e2) { /* ignore */ }
  }
}

/* 启动期（尚未渲染）的错误一律弹面板；已渲染后的偶发错误降级为控制台 + 提示 */
function reportError(title, detail) {
  try {
    markStage('error: ' + title);
    if (!window.__wbRendered) {
      showFatalError(title, detail);
    } else {
      try { console.error(title, detail); } catch (e) { /* ignore */ }
      try { if (typeof toast === 'function') toast(title); } catch (e) { /* ignore */ }
    }
  } catch (e) { /* ignore */ }
}

window.addEventListener('error', function (e) {
  var where = (e && e.filename ? String(e.filename).split(/[\\/]/).pop() + ':' + e.lineno : '未知位置');
  var msg = (e && e.error && e.error.stack) ? e.error.stack : ((e && e.message) || String(e));
  reportError('页面脚本出错（' + where + '）', msg);
});
window.addEventListener('unhandledrejection', function (e) {
  var reason = e && e.reason;
  var msg = (reason && reason.stack) ? reason.stack : String(reason);
  reportError('启动过程中出现未处理的错误', msg);
});
