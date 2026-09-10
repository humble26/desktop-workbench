'use strict';
/* 确认根因：preload 通过 contextBridge 暴露的 window.api 是否是「不可配置」属性。
   若不可配置，则后续脚本里的顶层 `const api = ...` 会与它冲突 →
   SyntaxError: Identifier 'api' has already been declared → 整个脚本失效。

   顺带对比几种写法在真实 Electron 里的表现。 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const ROOT = path.join(__dirname, '..', '..');
const out = path.join(ROOT, 'probe-api-descriptor.json');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const info = {};
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(ROOT, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  // 用一个最小页面探测属性描述符与各种声明方式
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'">
    </head><body>
    <script>
      window.__r = {};
      try {
        const d = Object.getOwnPropertyDescriptor(window, 'api');
        window.__r.descriptor = d ? { configurable: d.configurable, writable: d.writable, enumerable: d.enumerable, hasGet: !!d.get } : null;
      } catch (e) { window.__r.descriptorError = String(e); }
      try { window.__r.bareTypeof = typeof api; } catch (e) { window.__r.bareTypeofError = String(e); }
    </script>
    <script>
      // 关键：顶层 const 与已有全局属性同名时会发生什么
      try { eval('const api = window.api;'); window.__r.constDecl = 'ok'; }
      catch (e) { window.__r.constDecl = 'ERROR: ' + String(e && e.message || e); }
    </script>
    </body></html>`;
  const tmpHtml = path.join(ROOT, 'probe-api.html');
  fs.writeFileSync(tmpHtml, html, 'utf8');

  try {
    await win.loadFile(tmpHtml);
    const r = await win.webContents.executeJavaScript('JSON.stringify(window.__r)', true);
    info.browser = JSON.parse(r);
  } catch (e) {
    info.error = String((e && e.stack) || e);
  }
  try { fs.rmSync(tmpHtml, { force: true }); } catch (e) { /* ignore */ }
  fs.writeFileSync(out, JSON.stringify(info, null, 2), 'utf8');
  app.exit(0);
}).catch((err) => {
  fs.writeFileSync(out, JSON.stringify({ fatal: String(err) }, null, 2), 'utf8');
  process.exit(1);
});
