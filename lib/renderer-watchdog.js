'use strict';

/* ===========================================================================
   渲染层启动看门狗
   ---------------------------------------------------------------------------
   由来：v1.8.2 / v1.8.3 / v1.8.4 发布后都出现过「装上去界面一片空白」，
   而当时**拿不到任何错误信息** —— 渲染层没起来，界面上没有提示，
   主进程侧也看不到渲染进程里发生了什么，只能靠猜。

   这个模块让失败自己说话，而且**不依赖渲染层存活**：
     · 捕获渲染进程的控制台错误 / preload 报错 / 加载失败 / 进程崩溃
     · 页面加载后主动检查 window.__wbBooted 与 window.__wbStage
       （executeJavaScript 在脚本几乎全挂的情况下依然可用）
     · 判定启动失败时：弹**原生对话框**（不依赖页面样式）+ 写日志文件
     · 日志写到 <userData>/startup.log，可随时查看或发给维护者

   主进程与渲染层的分工：
     renderer/app.js 负责打点 __wbStage（boot-started / data-loaded / rendered /
     failed: 原因），主进程负责收集与呈现。
   =========================================================================== */

const fs = require('fs');
const path = require('path');

const MAX_MESSAGES = 40;

function createRendererWatchdog(opts) {
  const options = opts || {};
  const logPath = options.logPath;                       // <userData>/startup.log
  const appVersion = options.appVersion || '?';
  const checkDelayMs = Number.isFinite(options.checkDelayMs) ? options.checkDelayMs : 3000;
  const onFailed = typeof options.onFailed === 'function' ? options.onFailed : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const showDialog = typeof options.showDialog === 'function' ? options.showDialog : null;

  const messages = [];   // { at, source, level, text }

  function record(source, text, level) {
    const entry = { at: new Date().toISOString(), source: source, level: level || 'info', text: String(text).slice(0, 800) };
    messages.push(entry);
    if (messages.length > MAX_MESSAGES) messages.shift();
    log('[renderer:' + source + '] ' + entry.text);
    return entry;
  }

  function writeLog(extra) {
    try {
      const lines = [];
      lines.push('==== 桌面工作台启动日志 ====');
      lines.push('时间: ' + new Date().toISOString());
      lines.push('版本: ' + appVersion);
      lines.push('平台: ' + process.platform + ' / Electron ' + (process.versions.electron || '?') + ' / Chromium ' + (process.versions.chrome || '?'));
      lines.push('资源目录: ' + (options.appPath || ''));
      if (options.userData) lines.push('用户数据: ' + options.userData);
      if (extra) for (const k of Object.keys(extra)) lines.push(k + ': ' + extra[k]);
      lines.push('---- 渲染进程消息（最多 ' + MAX_MESSAGES + ' 条）----');
      if (!messages.length) lines.push('（无）');
      for (const m of messages) lines.push(m.at + ' [' + m.source + '/' + m.level + '] ' + m.text);
      lines.push('');
      // 覆盖写入：日志反映「最近一次启动」，便于直接发给维护者
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, lines.join('\n'), 'utf8');
      return lines.join('\n');
    } catch (e) {
      return null;
    }
  }

  /* 不依赖窗口对象的独立记录（例如单实例锁导致本次启动直接退出时使用） */
  function writeStandalone(extra) {
    try {
      const lines = [];
      lines.push('==== 桌面工作台启动日志（未创建窗口）====');
      lines.push('时间: ' + new Date().toISOString());
      lines.push('版本: ' + appVersion);
      lines.push('资源目录: ' + (options.appPath || ''));
      lines.push('可执行文件: ' + (process.execPath || ''));
      if (extra) for (const k of Object.keys(extra)) lines.push(k + ': ' + extra[k]);
      lines.push('');
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.writeFileSync(logPath, lines.join('\n'), 'utf8');
      return true;
    } catch (e) {
      return false;
    }
  }

  /* 给一个 BrowserWindow 装上监听与启动检查 */
  function attach(win) {
    if (!win || !win.webContents) return;
    const wc = win.webContents;

    try {
      wc.on('console-message', (event, level, message, line, sourceId) => {
        // level: 0=verbose 1=info 2=warning 3=error
        const lv = level >= 3 ? 'error' : (level === 2 ? 'warn' : 'info');
        const src = sourceId ? String(sourceId).split(/[\\/]/).pop() + (line ? ':' + line : '') : '';
        record('console', (src ? src + ' ' : '') + message, lv);
      });
    } catch (e) { /* 老版本 Electron 用不同签名，忽略 */ }

    try {
      wc.on('preload-error', (event, preloadPath, error) => {
        record('preload', (preloadPath || '') + ' → ' + ((error && error.stack) || error), 'error');
      });
    } catch (e) { /* ignore */ }

    try {
      wc.on('did-fail-load', (event, code, desc, url, isMainFrame) => {
        record('did-fail-load', 'code=' + code + ' ' + desc + ' url=' + url + ' mainFrame=' + isMainFrame, 'error');
      });
    } catch (e) { /* ignore */ }

    try {
      wc.on('render-process-gone', (event, details) => {
        record('render-process-gone', JSON.stringify(details), 'error');
        writeLog({ 结果: '渲染进程崩溃' });
        if (showDialog) {
          showDialog('桌面工作台渲染进程崩溃',
            '渲染进程异常退出：' + JSON.stringify(details) +
            '\n\n日志已写入：\n' + logPath);
        }
      });
    } catch (e) { /* ignore */ }

    // 页面加载完成后主动确认「界面是否真的起来了」
    try {
      wc.once('did-finish-load', () => {
        setTimeout(async () => {
          let booted = false;
          let stage = '';
          let probeError = '';
          try {
            booted = await wc.executeJavaScript('window.__wbBooted === true', true);
            stage = await wc.executeJavaScript('String(window.__wbStage || "")', true);
          } catch (e) {
            probeError = (e && (e.message || e)) || String(e);
          }
          const result = {
            booted: booted === true,
            stage: stage,
            probeError: probeError,
            version: appVersion
          };
          onFailed; // no-op 占位，保持接口可读
          if (result.booted) {
            record('watchdog', '启动成功（stage=' + stage + '）', 'info');
            // 成功也留一份日志：用户报「界面空白」时，先看这里的版本与阶段就能判断
            // 他看到的是不是当前版本（历史上曾因托盘里旧实例未退出而误判）
            writeLog({ 结果: '启动成功', 阶段: stage || '(未打点)' });
            return;
          }
          // 启动失败：写日志 + 原生提示（不依赖页面样式/脚本）
          const summary = writeLog({
            结果: '启动失败',
            阶段: stage || '(未打点)',
            探测错误: probeError || '(无)',
            说明: '页面没有完成启动，界面可能一片空白'
          });
          const detail =
            '版本：' + appVersion + '\n' +
            '卡在阶段：' + (stage || '(未打点，可能是脚本未加载)') + '\n' +
            (probeError ? '探测错误：' + probeError + '\n' : '') +
            '\n最近的渲染进程消息：\n' +
            (messages.slice(-8).map(m => '· [' + m.level + '] ' + m.text.slice(0, 200)).join('\n') || '（无）') +
            '\n\n完整日志：\n' + logPath;
          if (showDialog) showDialog('桌面工作台启动失败', detail);
          else log('启动失败：' + detail);
        }, checkDelayMs);
      });
    } catch (e) { /* ignore */ }

    return { record: record, writeLog: writeLog, messages: messages };
  }

  return { attach: attach, writeLog: writeLog, writeStandalone: writeStandalone, record: record, messages: messages, logPath: logPath };
}

module.exports = { createRendererWatchdog };
