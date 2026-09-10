'use strict';

/* ===========================================================================
   IPC 来源校验
   ---------------------------------------------------------------------------
   旧实现只判断 `url.startsWith('file://')`，等于「本机任意 file:// 页面都可信」。
   实际可利用性不高（窗口不会导航到别处、window.open 一律拒绝），但校验放宽
   没有必要。收紧为：
     · 必须是 file:// 且能解析成本机路径
     · 路径必须位于本应用 renderer 目录之内（解析 .. 之后仍然在内）
     · 必须是顶层框架（不接受 iframe）
   Windows 路径大小写不敏感，比较时统一小写。
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

  return function isTrustedSender(event) {
    try {
      if (!event || !event.senderFrame) return false;
      const frame = event.senderFrame;
      // 顶层框架才可信：渲染层没有任何合法 iframe
      if (event.sender && event.sender.mainFrame && frame !== event.sender.mainFrame) return false;
      if (frame.detached === true) return false;
      const url = frame.url || '';
      if (typeof url !== 'string' || url.indexOf('file://') !== 0) return false;
      let filePath = '';
      try { filePath = fileURLToPath(url); } catch (e) { return false; }
      if (!filePath) return false;
      const resolved = path.resolve(filePath);
      const comparable = caseInsensitive ? resolved.toLowerCase() : resolved;
      return comparable.indexOf(prefix) === 0;
    } catch (e) {
      return false;
    }
  };
}

module.exports = { createTrustedSenderChecker };
