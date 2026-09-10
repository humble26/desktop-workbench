'use strict';
/* 用真实用户数据跑渲染层：复现「渲染层 + 真实数据」这一组合。
   之前只测过「渲染层 + 全新数据」和「主进程 + 真实数据」，两者交叉的情况漏测。
   用法：node tools/diagnose/render-real-data.js [数据文件] */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createRendererHarness } = require('../../test/helpers/renderer-harness.js');

const dataFile = process.argv[2] || path.join(process.env.APPDATA || '', '桌面工作台', 'workbench-data.json');
if (!fs.existsSync(dataFile)) { console.log('未找到数据文件：' + dataFile); process.exit(0); }
console.log('数据文件：' + dataFile + '（' + fs.statSync(dataFile).size + ' 字节）');
console.log('数据摘要：' + JSON.stringify(Object.keys(JSON.parse(fs.readFileSync(dataFile, 'utf8')))));

(async () => {
  const h = createRendererHarness({ dataFile: dataFile });
  try {
    const r = await h.boot(500);
    console.log('\n=== 启动结果 ===');
    console.log('脚本加载错误：' + (r.loadErrors.length ? JSON.stringify(r.loadErrors) : '无'));
    console.log('boot() 成功：' + r.bootOk);
    if (r.bootErr) console.log('boot() 失败原因：\n' + String(r.bootErr).split('\n').slice(0, 10).map(l => '  ' + l).join('\n'));
    console.log('#nav 渲染：' + (r.navHtml ? r.navHtml.length + ' 字符' : '否'));
    console.log('#view 渲染：' + (r.viewHtml ? r.viewHtml.length + ' 字符' : '否'));
    if (r.bodyChildren.length) console.log('页面提示面板：' + JSON.stringify(r.bodyChildren).slice(0, 300));
    if (r.errors.length) {
      console.log('捕获到的错误：');
      for (const e of r.errors) console.log('  - (' + e.where + ') ' + String(e.message).slice(0, 400));
    }
    // 逐个视图在真实数据上渲染
    const views = ['dashboard', 'shortcuts', 'files', 'todos', 'calendar', 'notes', 'checkins', 'pomodoro', 'stats', 'usage', 'settings'];
    const failed = [];
    for (const v of views) {
      try {
        const out = r.evalIn(`(function(){ state.view = ${JSON.stringify(v)}; render(); return String(document.querySelector('#view').innerHTML || ''); })()`);
        if (!out || out.length < 50) failed.push(v + '(内容过少)');
      } catch (e) {
        failed.push(v + ' → ' + ((e && e.message) || e));
      }
    }
    console.log('\n=== 各视图在真实数据上的渲染 ===');
    console.log(failed.length ? '失败：\n  ' + failed.join('\n  ') : '全部 11 个视图渲染正常 ✔');
    const ok = !r.loadErrors.length && r.bootOk && failed.length === 0;
    console.log('\n' + (ok ? '结论：渲染层 + 真实数据 正常 ✔' : '结论：复现出问题 ✖'));
    h.dispose();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('诊断工具出错：' + (e && e.stack ? e.stack : e));
    try { h.dispose(); } catch (e2) { /* ignore */ }
    process.exit(2);
  }
})();
