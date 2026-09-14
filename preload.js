'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// 白名单化的安全 API：渲染进程无法直接访问 Node / 文件系统 / shell
contextBridge.exposeInMainWorld('api', {
  // 数据读写：load 返回 { rev, data }；commit 只提交「补丁」，由主进程独占落盘
  load: () => ipcRenderer.invoke('store:load'),
  commit: (payload) => ipcRenderer.invoke('store:commit', payload),

  pickFiles: () => ipcRenderer.invoke('dialog:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickApp: () => ipcRenderer.invoke('dialog:pickApp'),

  resolveItem: (p) => ipcRenderer.invoke('fs:resolveItem', p),
  getIcon: (p) => ipcRenderer.invoke('fs:getIcon', p),
  openPath: (p) => ipcRenderer.invoke('fs:open', p),
  revealPath: (p) => ipcRenderer.invoke('fs:reveal', p),

  setMode: (mode) => ipcRenderer.invoke('win:mode', mode),
  setAutostart: (enable) => ipcRenderer.invoke('win:autostart', enable),
  setLayout: (layout) => ipcRenderer.invoke('win:layout', layout),
  applyTheme: (theme) => ipcRenderer.invoke('win:theme', theme),
  setGlass: (on) => ipcRenderer.invoke('win:glass', on),
  notify: (title, body, silent) => ipcRenderer.invoke('notify:show', { title, body, silent }),
  checkUpdate: () => ipcRenderer.invoke('app:checkUpdate'),
  openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
  addQuick: (text) => ipcRenderer.invoke('todo:quickAdd', text),
  closeQuick: () => ipcRenderer.invoke('qa:close'),
  minimize: () => ipcRenderer.invoke('win:minimize'),
  maximizeToggle: () => ipcRenderer.invoke('win:maximizeToggle'),
  getPathForFile: (file) => {
    try { return webUtils.getPathForFile(file); } catch (e) { return ''; }
  },
  hideWindow: () => ipcRenderer.invoke('win:hide'),
  quit: () => ipcRenderer.invoke('win:quit'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  diagnostics: () => ipcRenderer.invoke('app:diagnostics'),
  probePowershell: () => ipcRenderer.invoke('app:probePowershell'),
  onDiagnostics: (cb) => ipcRenderer.on('app:diagnostics', (_e, d) => cb(d)),

  backupNow: () => ipcRenderer.invoke('data:backupNow'),
  listBackups: () => ipcRenderer.invoke('data:listBackups'),
  openBackupDir: () => ipcRenderer.invoke('data:openBackupDir'),
  exportData: (jsonStr) => ipcRenderer.invoke('data:export', jsonStr),
  importData: () => ipcRenderer.invoke('data:import'),

  onMode: (cb) => ipcRenderer.on('win:mode', (_e, d) => cb(d)),
  onVisibility: (cb) => ipcRenderer.on('win:visibility', (_e, d) => cb(d)),
  onLayout: (cb) => ipcRenderer.on('win:layout', (_e, d) => cb(d)),
  onMaximized: (cb) => ipcRenderer.on('win:maximized', (_e, d) => cb(d)),
  // 载荷 {rev, origin} 必须转发：渲染层靠 origin==='renderer' 跳过自己提交引发的回灌
  onChanged: (cb) => ipcRenderer.on('data:changed', (_e, payload) => cb(payload)),
  pickAutoWatch: () => ipcRenderer.invoke('auto:pickWatch'),
  pickAutoTarget: () => ipcRenderer.invoke('auto:pickTarget'),
  runAutoOrganize: () => ipcRenderer.invoke('auto:run'),
  onQuickReset: (cb) => ipcRenderer.on('qa:reset', () => cb()),

  // 剪贴板历史（剪贴板弹窗使用）
  clipList: (opts) => ipcRenderer.invoke('clip:list', opts),
  clipCopy: (id) => ipcRenderer.invoke('clip:copy', id),
  clipPin: (id) => ipcRenderer.invoke('clip:pin', id),
  clipDelete: (id) => ipcRenderer.invoke('clip:delete', id),
  clipClear: () => ipcRenderer.invoke('clip:clearUnpinned'),
  clipOcr: (id) => ipcRenderer.invoke('clip:ocr', id),
  hideClip: () => ipcRenderer.invoke('clip:hide'),
  onClipReset: (cb) => ipcRenderer.on('clip:reset', () => cb()),
  onClipUpdated: (cb) => ipcRenderer.on('clip:updated', () => cb()),

  // 自动时间统计
  getUsageSummary: (opts) => ipcRenderer.invoke('usage:getSummary', opts),
  clearUsage: () => ipcRenderer.invoke('usage:clear'),

  // AI 平台余额监测
  // 注意：密钥是「只写」的 —— 渲染层能 setKey / clearKey 并读到掩码，
  // 但主进程从不把明文密钥回传（见 lib/ai/keystore.js 的说明）。
  aiList: () => ipcRenderer.invoke('ai:list'),
  aiRefresh: (ids) => ipcRenderer.invoke('ai:refresh', ids),
  aiSetKey: (id, key, verify) => ipcRenderer.invoke('ai:setKey', { id, key, verify: verify === true }),
  aiClearKey: (id) => ipcRenderer.invoke('ai:clearKey', id),
  aiHistory: (opts) => ipcRenderer.invoke('ai:history', opts),
  aiClearHistory: () => ipcRenderer.invoke('ai:clearHistory'),
  aiClearProvider: (id) => ipcRenderer.invoke('ai:clearProvider', id),
  onAiUpdated: (cb) => ipcRenderer.on('ai:updated', (_e, d) => cb(d)),

  // 截图 OCR 取字
  startScreenshot: () => ipcRenderer.invoke('shot:start'),
  shotReady: () => ipcRenderer.invoke('shot:ready'),
  onShotInit: (cb) => ipcRenderer.on('shot:init', (_e, d) => cb(d)),
  shotSubmitCrop: (dataUrl) => ipcRenderer.invoke('shot:submitCrop', dataUrl),
  shotCancel: () => ipcRenderer.invoke('shot:cancel'),
  onShotResult: (cb) => ipcRenderer.on('shot:result', (_e, d) => cb(d)),
  shotCopy: () => ipcRenderer.invoke('shot:copy'),
  shotClose: () => ipcRenderer.invoke('shot:close'),

  // 桌面小组件 / 面板动作
  widgetsClose: (name) => ipcRenderer.invoke('widgets:close', name),
  widgetsOpenMain: () => ipcRenderer.invoke('widgets:openMain'),
  toggleClipboard: () => ipcRenderer.invoke('clip:toggle')
});