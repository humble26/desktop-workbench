'use strict';

/* 进程边界契约测试
   ---------------------------------------------------------------------------
   本项目没有构建步骤，主进程 / preload / 渲染层之间全靠字符串通道名与
   window.api 方法名约定。重构时最容易犯的错就是「改了名字忘了另一边」，
   而这类错误在无浏览器环境下跑不出来。这里用静态提取 + 断言把契约固定住：
     1. preload 暴露的 API 方法名 ↔ 渲染层实际调用的方法名
     2. preload invoke 的通道 ↔ 主进程 ipcMain.handle 的通道
     3. preload 监听的通道 ↔ 主进程实际发送的通道
     4. 页面脚本装载顺序（storeproto.js 必须在 app.js 之前）
     5. 历史遗留通道（store:save 整份快照）已彻底移除
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');

function read(p) { return fs.readFileSync(p, 'utf8'); }

const preloadSrc = read(path.join(ROOT, 'preload.js'));
const mainSrc = read(path.join(ROOT, 'main.js'));
const libFiles = fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js'));
const backSrc = mainSrc + '\n' + libFiles.map(f => read(path.join(ROOT, 'lib', f))).join('\n');
const rendererFiles = fs.readdirSync(RENDERER).filter(f => f.endsWith('.js'));

function matchAll(src, re) {
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

// ---- 提取 ----
const exposedApi = [...new Set(matchAll(preloadSrc, /^ {2}([A-Za-z_$][\w$]*)\s*:/gm))];
const invoked = [...new Set(matchAll(preloadSrc, /ipcRenderer\.invoke\('([^']+)'/g))];
const listened = [...new Set(matchAll(preloadSrc, /ipcRenderer\.on\('([^']+)'/g))];
const handled = [...new Set(matchAll(backSrc, /ipcMain\.handle\('([^']+)'/g))];

test('preload 暴露的 API 与主进程 handler 数量合理（防止提取正则失效）', () => {
  assert.ok(exposedApi.length > 40, 'preload API 方法数异常：' + exposedApi.length);
  assert.ok(handled.length > 30, '主进程 handler 数异常：' + handled.length);
  assert.ok(invoked.length > 30, 'preload invoke 通道数异常：' + invoked.length);
});

test('preload 调用的每个 invoke 通道都在主进程注册', () => {
  const missing = invoked.filter(ch => handled.indexOf(ch) === -1);
  assert.deepStrictEqual(missing, [], '缺少 ipcMain.handle：' + missing.join(', '));
});

test('preload 监听的每个通道都确实由主进程发送', () => {
  const missing = listened.filter(ch => backSrc.indexOf("'" + ch + "'") === -1);
  assert.deepStrictEqual(missing, [], '主进程从未发送：' + missing.join(', '));
});

test('渲染层调用的每个 api 方法都在 preload 白名单里', () => {
  const problems = [];
  for (const f of rendererFiles) {
    const src = read(path.join(RENDERER, f));
    for (const name of matchAll(src, /api\.([A-Za-z_$][\w$]*)\s*(?:\?\.)?\(/g)) {
      if (exposedApi.indexOf(name) === -1) problems.push(f + ' → api.' + name);
    }
  }
  assert.deepStrictEqual(problems, [], '调用了未暴露的 API：' + problems.join(', '));
});

test('渲染层不再整份提交快照（旧 store:save 通道已移除）', () => {
  assert.strictEqual(/ipcRenderer\.invoke\('store:save'/.test(preloadSrc), false, 'preload 仍暴露 store:save');
  assert.strictEqual(/ipcMain\.handle\('store:save'/.test(backSrc), false, '主进程仍注册 store:save');
  assert.strictEqual(/\bapi\.save\s*\(/.test(rendererFiles.map(f => read(path.join(RENDERER, f))).join('\n')), false, '渲染层仍调用 api.save');
  for (const ch of ['store:load', 'store:commit']) {
    assert.ok(invoked.indexOf(ch) !== -1, 'preload 未暴露 ' + ch);
    assert.ok(handled.indexOf(ch) !== -1, '主进程未注册 ' + ch);
  }
});

test('页面脚本顺序：数据协议在最前，业务脚本齐全且启动脚本在最后', () => {
  const html = read(path.join(RENDERER, 'index.html'));
  const scripts = matchAll(html, /<script src="([^"]+)"><\/script>/g);
  assert.ok(scripts.length >= 3, '页面脚本数量异常：' + scripts.length);
  assert.strictEqual(scripts[0], 'storeproto.js', '数据协议必须最先加载（core.js 读取 window.WB.proto）');
  assert.strictEqual(scripts[scripts.length - 1], 'app.js', 'app.js 负责启动，必须最后加载');

  // 目录里所有「同页面共享作用域」的脚本都必须被 index.html 加载（独立小窗脚本除外）
  const standalone = ['clipboard.js', 'quickadd.js', 'shot.js', 'widget.js'];
  const shared = fs.readdirSync(RENDERER)
    .filter(f => f.endsWith('.js'))
    .filter(f => standalone.indexOf(f) === -1);
  const missing = shared.filter(f => scripts.indexOf(f) === -1);
  const ghost = scripts.filter(s => shared.indexOf(s) === -1);
  assert.deepStrictEqual(missing, [], '这些脚本没有被 index.html 加载：' + missing.join(', '));
  assert.deepStrictEqual(ghost, [], 'index.html 引用了不存在的脚本：' + ghost.join(', '));

  // 不能重复加载（顶层 const 会重复声明报错）
  const dupes = scripts.filter((s, i) => scripts.indexOf(s) !== i);
  assert.deepStrictEqual(dupes, [], '脚本被重复加载：' + dupes.join(', '));
});

test('渲染层资源不跨目录引用（CSP 为 script-src self，跨目录不可靠）', () => {
  const pages = fs.readdirSync(RENDERER).filter(f => f.endsWith('.html'));
  const problems = [];
  for (const p of pages) {
    const html = read(path.join(RENDERER, p));
    for (const m of matchAll(html, /<(?:script|link)[^>]*(?:src|href)="([^"]+)"/g)) {
      if (/^(https?:|data:|\/)/.test(m)) continue;
      if (m.indexOf('/') !== -1 || m.indexOf('\\') !== -1) problems.push(p + ' → ' + m);
    }
  }
  assert.deepStrictEqual(problems, [], '页面引用了子目录资源：' + problems.join(', '));
});

test('拆分后的脚本没有重复的顶层声明（全局作用域共享，重名会直接报错）', () => {
  const standalone = ['clipboard.js', 'quickadd.js', 'shot.js', 'widget.js'];
  const files = fs.readdirSync(RENDERER)
    .filter(f => f.endsWith('.js'))
    .filter(f => standalone.indexOf(f) === -1);
  const seen = new Map();
  const declRe = /^(?:(?:async\s+)?function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=)/gm;
  for (const f of files) {
    const src = read(path.join(RENDERER, f));
    let m;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(src)) !== null) {
      const n = m[1] || m[2];
      if (!n) continue;
      if (seen.has(n)) seen.get(n).push(f);
      else seen.set(n, [f]);
    }
  }
  const dupes = [...seen.entries()].filter(([, fs2]) => fs2.length > 1);
  assert.deepStrictEqual(dupes.map(([n, f2]) => n + '(' + f2.join('+') + ')'), [], '顶层声明重名');
  // storeproto.js 用 UMD 包装，故它自己的声明不算在内
  assert.ok(seen.size > 100, '提取到的声明数偏少，正则可能失效：' + seen.size);
});

test('独立小窗脚本仍然自成体系（各自 IIFE，不与主页共享作用域）', () => {
  for (const f of ['clipboard.js', 'quickadd.js', 'shot.js', 'widget.js']) {
    const src = read(path.join(RENDERER, f));
    assert.ok(/\(function \(\) \{/.test(src), f + ' 应保持 IIFE 包裹');
    // 这些页面是独立入口，不参与 index.html 的共享作用域，因此不要求拆分风格一致
    assert.strictEqual(/^(?:async\s+)?function\s+/m.test(src), false, f + ' 不应有全局函数声明');
  }
});

test('主数据文件只能由 lib/store.js 写入（其他模块各自管理自己的数据源）', () => {
  // 允许自带落盘的模块：store.js 管主数据，iconcache.js 管图标缓存目录。
  // 但它们都不允许碰 workbench-data.json —— 那个文件名只出现在 main.js 传给 store 的参数里。
  const selfOwned = ['store.js', 'iconcache.js'];
  const writers = libFiles.filter(f => selfOwned.indexOf(f) === -1)
    .filter(f => /writeFileSync|renameSync|unlinkSync/.test(read(path.join(ROOT, 'lib', f))));
  assert.deepStrictEqual(writers, [], '这些模块不应直接写文件：' + writers.join(', '));

  for (const f of libFiles) {
    // 只看代码里的字符串字面量，注释里提到文件名是正常的
    assert.strictEqual(/['"]workbench-data\.json['"]/.test(read(path.join(ROOT, 'lib', f))), false,
      'lib/' + f + ' 不应硬编码主数据文件名（应由调用方注入路径）');
  }

  // main.js 只能通过 store 写主数据；usage-data.json / clipboard-history.json / 图标缓存
  // 是各自独立的子数据源，允许自带原子写。
  assert.strictEqual(/writeFileSync\(\s*storePath\(\)/.test(mainSrc), false, 'main.js 仍在直接写主数据文件');
  assert.strictEqual(/storePath\(\)\s*\+\s*'\.tmp'/.test(mainSrc), false, 'main.js 仍有旧的原子写实现');
  assert.ok(/createStore\(\{/.test(mainSrc), 'main.js 应通过 createStore 装配数据仓库');
});

test('打包白名单覆盖所有运行期文件（拆出来的 lib/ 与 renderer 脚本不能漏打）', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const globs = (pkg.build && pkg.build.files) || [];
  assert.ok(globs.length > 0, 'package.json 未配置 build.files');

  // 极简 glob 匹配：支持 "dir/**/*"、"dir/**"、"*.js" 与精确文件名
  const matches = (rel) => globs.some(g => {
    if (g === rel) return true;
    if (g.endsWith('/**/*') || g.endsWith('/**')) {
      const base = g.replace(/\/\*\*(\/\*)?$/, '');
      return rel === base || rel.startsWith(base + '/');
    }
    if (g.indexOf('*') === -1) return false;
    const re = new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    return re.test(rel);
  });

  const required = [
    'main.js',
    'preload.js',
    'renderer/index.html',
    'renderer/style.css',
    'renderer/storeproto.js',
    'renderer/core.js',
    'renderer/actions.js',
    'renderer/app.js',
    'renderer/widget.html',
    'renderer/clipboard.html',
    'renderer/quickadd.html',
    'renderer/shot.html',
    'ocr-data/chi_sim.traineddata'
  ];
  // lib/ 与 renderer/ 下的所有实际文件都必须被打进去
  for (const f of fs.readdirSync(path.join(ROOT, 'lib')).filter(f => f.endsWith('.js'))) required.push('lib/' + f);
  for (const f of fs.readdirSync(RENDERER).filter(f => /\.(js|html|css)$/.test(f))) required.push('renderer/' + f);

  const missing = required.filter(rel => !matches(rel));
  assert.deepStrictEqual(missing, [], '这些运行期文件不会被打包：' + missing.join(', '));

  // asarUnpack 必须包含 OCR 模型与 tesseract，否则打包后 OCR 失效
  const unpack = (pkg.build && pkg.build.asarUnpack) || [];
  assert.ok(unpack.some(g => g.indexOf('ocr-data') !== -1), 'asarUnpack 缺少 ocr-data');
  assert.ok(unpack.some(g => g.indexOf('tesseract.js') !== -1), 'asarUnpack 缺少 tesseract.js');
});

test('测试与开发工具不参与打包（避免体积与信息暴露）', () => {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const globs = (pkg.build && pkg.build.files) || [];
  for (const g of globs) {
    assert.strictEqual(/^test\//.test(g) || /^tools\//.test(g), false, 'test/tools 不应出现在打包白名单：' + g);
  }
  assert.ok(pkg.scripts && pkg.scripts.test, '缺少 npm test 脚本');
});

test('界面状态字段不再被任何渲染层代码提交（仅允许出现在 storeproto 的清单里）', () => {
  const protoSrc = read(path.join(RENDERER, 'storeproto.js'));
  const ephemeral = matchAll(protoSrc, /'(_[A-Za-z]+|view|_exportedAt)'/g);
  assert.ok(ephemeral.length > 0);
  // 拆分后提交逻辑在 core.js，视图在 view-*.js / actions.js —— 整个共享作用域一起检查
  const shared = fs.readdirSync(RENDERER)
    .filter(f => f.endsWith('.js') && ['storeproto.js', 'clipboard.js', 'quickadd.js', 'shot.js', 'widget.js'].indexOf(f) === -1)
    .map(f => read(path.join(RENDERER, f)))
    .join('\n');
  assert.strictEqual(/api\.commit\(\s*state\s*\)/.test(shared), false, '直接提交整份 state');
  assert.ok(/proto\.stripEphemeral\(state\)/.test(shared), '提交前必须剥离界面状态');
  assert.ok(/proto\.diffPatch\(/.test(shared), '必须提交差分补丁');
});
