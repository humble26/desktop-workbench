'use strict';
/* 诊断：模拟「打包后」的 IPC 来源校验。
   打包后 __dirname 形如 ...\resources\app.asar，页面 URL 也带 app.asar。
   这里穷举几种 Electron 可能给出的 event 形态，看哪种会被误拒。 */
const path = require('path');
const { pathToFileURL } = require('url');
const { createTrustedSenderChecker } = require('../../lib/security.js');

// 模拟安装目录（含中文，与真实安装路径一致）
const installRoot = 'C:\\Users\\g1507\\AppData\\Local\\Programs\\桌面工作台\\resources\\app.asar';
const rendererDir = path.join(installRoot, 'renderer');
const pageFile = path.join(rendererDir, 'index.html');
const pageUrl = pathToFileURL(pageFile).href;

const check = createTrustedSenderChecker({ rendererDir: rendererDir });

console.log('rendererDir = ' + rendererDir);
console.log('页面 URL    = ' + pageUrl);
console.log('');

function makeEvent(shape) {
  const frame = { url: pageUrl, detached: false };
  const mainFrame = shape.sameInstance ? frame : { url: pageUrl, detached: false };
  const ev = { senderFrame: frame, sender: { mainFrame: mainFrame } };

  if (shape.noSenderFrame) ev.senderFrame = null;
  if (shape.noMainFrame) delete ev.sender.mainFrame;
  if (shape.detached) frame.detached = true;
  if (shape.noSender) delete ev.sender;
  if (shape.percentUpper) frame.url = pageUrl.toUpperCase();
  if (shape.noQuery) { /* 本就无查询串 */ }
  return ev;
}

const shapes = [
  { name: 'senderFrame 与 sender.mainFrame 同一实例（我测试里用的假设）', sameInstance: true },
  { name: 'senderFrame 与 sender.mainFrame 是不同对象（Electron 可能如此）', sameInstance: false },
  { name: 'event.senderFrame 为 null', noSenderFrame: true },
  { name: 'sender 没有 mainFrame 属性', noMainFrame: true },
  { name: '没有 sender 对象', noSender: true },
  { name: 'frame 标记 detached', detached: true }
];

let bad = 0;
for (const s of shapes) {
  let r;
  try { r = check(makeEvent(s)); } catch (e) { r = 'throw: ' + e.message; }
  const ok = r === true;
  if (!ok) bad++;
  console.log((ok ? '  通过  ' : '  拒绝  ') + s.name + '  → ' + r);
}
console.log('\n被误拒的形态数：' + bad);
