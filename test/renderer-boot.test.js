'use strict';

/* 渲染层启动与视图渲染测试
   ---------------------------------------------------------------------------
   这一组测试存在的理由：v1.8.2 发布出去的安装包，启动后界面是全空白的 ——
   拆分脚本时把 app.js 末尾的 `boot();` 入口调用当成了「包装行」丢掉，
   页面加载了全部脚本、定义了一切，却永远不会启动。而当时所有测试都是绿的，
   因为没有任何一项检查「页面到底能不能跑起来」。

   覆盖点：
     1. index.html 声明的脚本都能加载
     2. app.js 自己那次 boot() 成功（不靠测试再补一次调用）
     3. 侧栏与首页真的渲染出内容
     4. 11 个视图逐个渲染都不抛异常
     5. 无 console.error / 无未捕获错误
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const { createRendererHarness } = require('./helpers/renderer-harness.js');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

test('app.js 保留启动入口调用（曾经的空白界面就是这一行被丢掉）', () => {
  const src = fs.readFileSync(path.join(RENDERER, 'app.js'), 'utf8');
  assert.match(src, /^\s*boot\(\);\s*$/m, 'app.js 必须以 boot(); 结尾触发启动');
  assert.match(src, /async function boot\s*\(/, 'app.js 应定义 boot()');
});

test('页面能自行启动：脚本全部加载、boot() 成功、首页与侧栏渲染完成', async () => {
  const h = createRendererHarness();
  try {
    const r = await h.boot(300);

    // 1) 脚本加载
    assert.deepStrictEqual(r.loadErrors, [], '脚本加载失败：' + JSON.stringify(r.loadErrors));
    assert.ok(r.scripts.length >= 20, 'index.html 声明的脚本数偏少：' + r.scripts.length);

    // 2) 启动成功（关键断言）
    assert.strictEqual(r.bootErr, null, 'boot() 抛出异常：' + r.bootErr);
    assert.strictEqual(r.bootOk, true, 'app.js 的 boot() 没有完成（页面不会启动）');

    // 3) 真的渲染出内容
    assert.ok(r.navHtml && r.navHtml.length > 100, '侧栏未渲染');
    assert.ok(r.navHtml.indexOf('data-nav="todos"') !== -1, '侧栏缺少导航项');
    assert.ok(r.viewHtml && r.viewHtml.length > 200, '首页视图未渲染');
    assert.ok(r.viewHtml.indexOf('class="greet"') !== -1, '首页视图内容不正确');

    // 4) 没有错误
    assert.deepStrictEqual(r.errors, [], '渲染层报错：' + JSON.stringify(r.errors));
  } finally {
    h.dispose();
  }
});

test('11 个视图逐个渲染都不抛异常', async () => {
  const h = createRendererHarness();
  try {
    const r = await h.boot(300);
    assert.strictEqual(r.bootOk, true, '起点：boot() 必须成功');

    const views = ['dashboard', 'shortcuts', 'files', 'todos', 'calendar', 'notes',
      'checkins', 'pomodoro', 'stats', 'usage', 'settings'];
    const failures = [];
    for (const v of views) {
      try {
        // 直接切视图并重绘（等价于点击侧栏）。
        // 必须 await render()：render() 是 async，某个视图里同步抛出的异常会变成
        // 被拒绝的 Promise —— 不 await 就没人接，测试照旧全绿，
        // 只在测试结束后冒出一个 unhandledRejection（退出码 1）。踩过这个坑。
        const rendered = await r.evalIn(`(async function () {
          state.view = ${JSON.stringify(v)};
          await render();
          return { len: (document.querySelector('#view').innerHTML || '').length };
        })()`);
        if (!rendered || rendered.len < 50) failures.push(v + '(内容过少 ' + (rendered && rendered.len) + ')');
      } catch (e) {
        failures.push(v + '(' + ((e && e.message) || e) + ')');
      }
    }
    assert.deepStrictEqual(failures, [], '以下视图渲染失败：' + failures.join('；'));

    // 空数据分支也要真的跑到：打卡视图在「还没有习惯」时应给出引导文案
    // （这个分支过去因为桩缺 insertAdjacentHTML 而从未跑通过）
    const empty = await r.evalIn(`(async function () {
      state.view = 'checkins'; await render();
      return String(document.querySelector('#view').innerHTML || '');
    })()`);
    assert.ok(empty.indexOf('添加一个想坚持的习惯吧') !== -1,
      '打卡为空时缺少引导文案（空状态分支没渲染）');
    assert.deepStrictEqual(r.errors, [], '渲染层报错：' + JSON.stringify(r.errors));
  } finally {
    h.dispose();
  }
});

test('数据读取失败时，界面必须给出可见提示而不是空白（v1.8.2 空白事故的防线）', async () => {
  const h = createRendererHarness({
    apiOverrides: {
      load: () => Promise.reject(new Error('forbidden'))
    }
  });
  try {
    const r = await h.boot(300);

    // boot() 会「正常结束」（错误已被捕获处理），但页面上必须出现错误面板
    const panels = r.bodyChildren.filter(html => html.indexOf('读取本地数据失败') !== -1);
    assert.strictEqual(panels.length > 0, true,
      '数据读取失败时没有显示任何提示（这就是空白界面的成因）。body 子元素：' + JSON.stringify(r.bodyChildren).slice(0, 200));
    assert.ok(panels[0].indexOf('forbidden') !== -1, '错误面板应包含具体原因');
    assert.ok(panels[0].indexOf('重试') !== -1, '错误面板应提供重试入口');
    // 关键点：失败时页面上必须留有可见内容（而不是像 v1.8.2 那样什么都没有）
    assert.ok(r.bodyChildren.length > 0, '失败时页面上必须留下可见提示');
  } finally {
    h.dispose();
  }
});

test('主进程返回异常结构时也给出可见提示', async () => {
  const h = createRendererHarness({
    apiOverrides: {
      load: () => Promise.resolve({ rev: 0, data: null })
    }
  });
  try {
    const r = await h.boot(300);
    const panels = r.bodyChildren.filter(html => html.indexOf('读取本地数据失败') !== -1);
    assert.strictEqual(panels.length > 0, true, '异常数据结构应触发可见提示');
  } finally {
    h.dispose();
  }
});

test('带数据时视图仍能渲染（待办/便签/打卡/日历/分组都有内容）', async () => {
  const h = createRendererHarness({
    seed: () => ({
      todos: [
        { id: 't1', text: '写周报', level: 'high', done: false, date: '2026-01-01', due: '2026-01-02', dueTime: '15:30', repeat: 'monthly', note: '备注', subtasks: [{ id: 's1', text: '子任务', done: false }], doneHistory: [], remind: 0 },
        { id: 't2', text: '已完成的待办', level: 'low', done: true, doneAt: '2026-01-01', date: '2026-01-01', due: '', dueTime: '', repeat: 'none', note: '', subtasks: [], doneHistory: [], remind: 0 }
      ],
      notes: [{ id: 'n1', title: '灵感', body: '正文', tag: '想法', date: '2026-01-01' }],
      checkins: [{ id: 'c1', name: '跑步', emoji: '🏃', done: true, streak: 3, last: '2026-01-01' }],
      shortcuts: [{ id: 's1', name: '记事本', path: 'C:\\Windows\\notepad.exe', icon: null }],
      groups: [{ id: 'g1', name: '文档', color: '#6f8f6a', items: [{ id: 'i1', type: 'file', path: 'C:\\tmp\\a.pdf', name: 'a.pdf', broken: false }] }],
      pomoDone: { '2026-01-01': 2 }
    })
  });
  try {
    const r = await h.boot(300);
    assert.strictEqual(r.bootOk, true, 'boot() 失败：' + r.bootErr);
    assert.ok(r.viewHtml && r.viewHtml.length > 200, '首页未渲染');

    // 数据必须真的流进各个视图（不只是「没抛异常」）
    const expect = {
      todos: '写周报',
      notes: '灵感',
      checkins: '跑步',
      files: 'a.pdf',
      shortcuts: '记事本'
    };
    const views = ['shortcuts', 'files', 'todos', 'calendar', 'notes', 'checkins', 'pomodoro', 'stats', 'usage', 'settings'];
    const failures = [];
    for (const v of views) {
      try {
        // 同样必须 await render()：视图的异常要落到本测试上，而不是变成测试结束后的 unhandledRejection
        const out = await r.evalIn(`(async function () {
          state.view = ${JSON.stringify(v)};
          await render();
          return { html: String(document.querySelector('#view').innerHTML || '') };
        })()`);
        if (!out || out.html.length < 50) { failures.push(v + '(内容过少)'); continue; }
        const needle = expect[v];
        if (needle && out.html.indexOf(needle) === -1) failures.push(v + '(缺少「' + needle + '」)');
      } catch (e) {
        failures.push(v + '(' + ((e && e.message) || e) + ')');
      }
    }
    assert.deepStrictEqual(failures, [], '带数据时视图渲染失败：' + failures.join('；'));

    // 首页统计应反映数据（2 条待办中 1 条未完成）
    const dash = await r.evalIn('(async function(){ state.view = "dashboard"; await render(); return String(document.querySelector("#view").innerHTML || ""); })()');
    assert.ok(dash.indexOf('待办未完成') !== -1, '首页未渲染统计卡');
    assert.ok(/class="v">1<\/div><div class="l">待办未完成/.test(dash), '首页未完成待办数应为 1');
    assert.deepStrictEqual(r.errors, [], '渲染层报错：' + JSON.stringify(r.errors));
  } finally {
    h.dispose();
  }
});
