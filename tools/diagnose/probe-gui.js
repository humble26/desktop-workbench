'use strict';
/* 探测：Electron 能否以 GUI 模式启动（而不是被强制成 Node 模式）
   写法上不依赖 stdout —— 直接把结果写进文件，因为 electron.exe 是 GUI 子系统程序，
   PowerShell/cmd 不会等待它、也拿不到它的输出。 */
const fs = require('fs');
const path = require('path');

const out = path.join(__dirname, '..', '..', 'probe-result.json');
let e = null;
try { e = require('electron'); } catch (err) { /* ignore */ }

const info = {
  at: new Date().toISOString(),
  execPath: process.execPath,
  versions: { electron: process.versions.electron || null, chrome: process.versions.chrome || null, node: process.versions.node },
  electronModuleType: typeof e,
  hasApp: !!(e && e.app),
  envRunAsNode: process.env.ELECTRON_RUN_AS_NODE === undefined ? '(未设置)' : JSON.stringify(process.env.ELECTRON_RUN_AS_NODE),
  isGuiMode: !!(e && e.app)
};

try {
  fs.writeFileSync(out, JSON.stringify(info, null, 2), 'utf8');
} catch (err) { /* ignore */ }

// GUI 模式下额外做一件事：创建一个隐藏窗口加载渲染层页面并回报结果
if (e && e.app) {
  const { app, BrowserWindow } = e;
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    const lines = [];
    try {
      const win = new BrowserWindow({
        show: false,
        width: 1280, height: 800,
        webPreferences: {
          preload: path.join(__dirname, '..', '..', 'preload.js'),
          contextIsolation: true, nodeIntegration: false, sandbox: true
        }
      });
      win.webContents.on('console-message', (ev, level, message, line, sourceId) => {
        lines.push('[' + level + '] ' + (sourceId || '').split(/[\\/]/).pop() + ':' + line + ' ' + message);
      });
      await win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'index.html'));
      await new Promise(r => setTimeout(r, 2500));
      const probe = await win.webContents.executeJavaScript(`(function(){
        return JSON.stringify({
          hasApi: typeof window.api === 'object',
          hasProto: !!(window.WB && window.WB.proto),
          stage: String(window.__wbStage || ''),
          booted: window.__wbBooted === true,
          navLen: (document.querySelector('#nav') ? document.querySelector('#nav').innerHTML.length : -1),
          viewLen: (document.querySelector('#view') ? document.querySelector('#view').innerHTML.length : -1)
        });
      })()`, true);
      info.guiProbe = JSON.parse(probe);
    } catch (err) {
      info.guiError = String((err && err.stack) || err);
    }
    info.consoleMessages = lines.slice(0, 40);
    try { fs.writeFileSync(out, JSON.stringify(info, null, 2), 'utf8'); } catch (err) { /* ignore */ }
    app.exit(0);
  }).catch((err) => {
    info.whenReadyError = String(err);
    try { fs.writeFileSync(out, JSON.stringify(info, null, 2), 'utf8'); } catch (e2) { /* ignore */ }
    process.exit(1);
  });
}
