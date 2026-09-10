'use strict';

/* ===========================================================================
   IPC 来源校验
   ---------------------------------------------------------------------------
   校验的目标：只接受来自「本应用 renderer 目录下的本地页面」的 IPC 请求。
   旧实现只判断 `url.startsWith('file://')`，等于「本机任意 file:// 页面都可信」，
   收紧后的规则：
     1. 必须能拿到发送方框架，且 URL 是 file://
     2. URL 能解析成本机路径，且位于本应用 renderer 目录之内（解析 .. 之后仍在内）
     3. 必须是顶层框架（不接受 iframe）
   Windows 路径大小写不敏感，比较时统一小写。

   ⚠️ 踩过的坑（v1.8.2 界面空白的真正原因）：
   早期版本用 `event.senderFrame !== event.sender.mainFrame` 判断「是否顶层框架」。
   但 Electron **不保证** `senderFrame` 与 `sender.mainFrame` 是同一个 JS 对象 ——
   一旦两者是不同实例（打包环境下就是如此），这个判断会把**所有** IPC 都拒掉，
   页面请求数据失败 → 启动中断 → 界面全空白。
   因此：
     · 不再用对象同一性做判断（不再依赖 Electron 内部实现细节）
     · 顶层框架改用 `frame.parent`（主框架为 null/undefined）判断，且该检查是
       纵深防御而非安全边界 —— 拿不到 parent 时不因此拒绝
     · 真正的边界是「路径必须落在 renderer 目录内」，这一条保持不变
   =========================================================================== */

const path = require('path');
const { fileURLToPath } = require('url');

function createTrustedSenderChecker(opts) {
  const options = opts || {};
  const rendererDir = path.resolve(options.rendererDir);
  const caseInsensitive = options.caseInsensitive === undefined
    ? process.platform === 'win32'
    : !!options.caseInsensitive;
  const prefix = (caseInsensitive ? rendererDir.toLowerCase() : rendererDir) + path.sep;

  // 最近一次被拒的原因（供诊断页展示；被拒时界面会给出可见提示，不再静默失败）
  let lastRejection = null;

  function reject(reason, event) {
    let url = '';
    try { url = (event && event.senderFrame && event.senderFrame.url) || ''; } catch (e) { url = ''; }
    lastRejection = { reason: reason, url: url, at: Date.now() };
    return false;
  }

  function isTrustedSender(event) {
    try {
      if (!event) return reject('事件对象缺失', event);

      /* 取发送方 URL。优先用 senderFrame.url；拿不到框架时回退到 WebContents.getURL()。
         这样即使 Electron 在某些调用里没有提供 senderFrame，也不会把正常请求全部拒掉
         （曾因为校验过严导致所有 IPC 被拒 → 界面全空白）。
         两条路径都只用于「确认这是本应用页面」，真正的边界仍是下面的路径检查。 */
      let url = '';
      let source = '';
      try {
        const frame = event.senderFrame;
        if (frame && typeof frame.url === 'string' && frame.url) { url = frame.url; source = 'senderFrame'; }
      } catch (e) { /* 取不到就走回退 */ }
      if (!url) {
        try {
          const sender = event.sender;
          if (sender && typeof sender.getURL === 'function') { url = String(sender.getURL() || ''); source = 'webContents.getURL'; }
        } catch (e) { /* ignore */ }
      }
      if (!url) return reject('无法确定发送方页面地址', event);
      if (url.indexOf('file://') !== 0) return reject('不是 file:// 页面', event);

      let filePath = '';
      try { filePath = fileURLToPath(url); } catch (e) { return reject('URL 无法解析为本地路径', event); }
      if (!filePath) return reject('URL 解析结果为空', event);

      // 顶层框架检查（纵深防御）：主框架没有 parent。
      // 仅在确实读到 senderFrame 时判断；判断不了就不拦 —— 这条不是安全边界。
      if (source === 'senderFrame') {
        try {
          const frame = event.senderFrame;
          if (frame && frame.parent && typeof frame.parent === 'object') return reject('来自子框架（iframe）', event);
        } catch (e) { /* parent 不可读则跳过 */ }
      }

      const resolved = path.resolve(filePath);
      const comparable = caseInsensitive ? resolved.toLowerCase() : resolved;
      if (comparable.indexOf(prefix) !== 0) return reject('路径不在应用 renderer 目录内：' + resolved, event);
      return true;
    } catch (e) {
      return reject('校验过程异常：' + ((e && e.message) || e), event);
    }
  }

  isTrustedSender.lastRejection = function () { return lastRejection; };
  return isTrustedSender;
}

module.exports = { createTrustedSenderChecker };
