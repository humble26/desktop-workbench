'use strict';
/* 渲染层无浏览器诊断：按 index.html 顺序装载全部渲染脚本并打印启动链状态。
   定位「界面空白 / 启动失败」这类问题时用这个工具。

   装载逻辑与 test/renderer-boot.test.js 共用同一份 harness，避免两套实现不一致
   （曾经因为工具里少了一个 window.addEventListener 桩而误报启动失败）。

   用法：node tools/diagnose/run-renderer-headless.js */
const path = require('path');
const { createRendererHarness } = require('../../test/helpers/renderer-harness.js');

(async () => {
  const h = createRendererHarness();
  let result;
  try {
    result = await h.boot(500);

    console.log('index.html 声明脚本 ' + result.scripts.length + ' 个：');
    console.log('  ' + result.scripts.join(' → '));
    console.log('');

    if (result.loadErrors.length) {
      console.log('脚本加载失败：');
      for (const e of result.loadErrors) {
        console.log('  ✖ ' + e.script + ' → ' + e.message);
        if (e.stack) console.log('     ' + String(e.stack).split('\n').slice(1, 4).join('\n     '));
      }
    } else {
      console.log('全部脚本加载成功 ✔');
    }

    console.log('\n=== app.js 里那次 boot() ===');
    console.log('成功：' + (result.bootOk ? '是' : '否'));
    if (result.bootErr) {
      console.log('失败原因：');
      console.log(String(result.bootErr).split('\n').slice(0, 8).map(l => '  ' + l).join('\n'));
    }

    console.log('\n=== 渲染结果 ===');
    console.log('#nav 已渲染：' + (result.navHtml ? '是（' + result.navHtml.length + ' 字符）' : '否'));
    console.log('#view 已渲染：' + (result.viewHtml ? '是（' + result.viewHtml.length + ' 字符）' : '否'));
    if (result.viewHtml) console.log('#view 开头：' + result.viewHtml.replace(/\s+/g, ' ').slice(0, 120));

    if (result.bodyChildren.length) {
      console.log('\n=== 页面上的提示/错误面板 ===');
      for (const html of result.bodyChildren) console.log('  ' + html.replace(/\s+/g, ' ').slice(0, 300));
    }

    if (result.errors.length) {
      console.log('\n=== 捕获到的错误 ===');
      for (const e of result.errors) console.log('  - (' + e.where + ') ' + String(e.message).slice(0, 300));
    }

    const ok = !result.loadErrors.length && result.bootOk && !!result.navHtml && !!result.viewHtml;
    console.log('\n' + (ok ? '结论：渲染层能完成启动并渲染 ✔' : '结论：渲染层启动失败 ✖'));
    if (ok) console.log('（提示：这只能证明脚本与渲染逻辑正常；真实 Electron 下的 CSP、preload、IPC 仍需 npm run test:smoke 或实机验证）');
    h.dispose();
    process.exit(ok ? 0 : 1);
  } catch (e) {
    console.error('诊断工具自身出错：' + (e && e.stack ? e.stack : e));
    try { h.dispose(); } catch (e2) { /* ignore */ }
    process.exit(2);
  }
})();
