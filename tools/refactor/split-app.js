'use strict';

/* 开发工具：把巨大的 renderer/app.js 按原有章节边界拆成多个同目录脚本。
   ---------------------------------------------------------------------------
   为什么是「按行区间切」而不是「按函数搬运」：
     切点全部落在原有 `// ----` 章节边界上，这些边界必然是语句边界，
     因此不存在「漏搬/重复搬」的可能，拆分前后可逐行核对覆盖完整性。

   为什么拆出来的文件不用 IIFE 包裹：
     本项目的渲染层没有构建步骤，脚本以普通 <script> 顺序加载。
     普通脚本的顶层 `function` 声明会挂到全局对象、顶层 `const/let` 进入
     全局词法环境，两者在同一页面内是跨文件共享的，因此**所有调用点都不用改**。
     代价：新增的顶层声明不能与其他文件重名 —— 由 test/contract.test.js 兜底校验。

   运行： node tools/refactor/split-app.js        （先跑 --dry 只看覆盖报告）
   =========================================================================== */

const fs = require('fs');
const path = require('path');

const RENDERER = path.join(__dirname, '..', '..', 'renderer');
const SRC = path.join(RENDERER, 'app.js');

// file → 源文件行区间（1-based，含两端）
// 注意：行号必须用 Node 的换行语义（split('\n')）确定，不能照抄 PowerShell 的
// Get-Content 编号 —— 两者对同一文件会给出不同的行号，照抄会导致切点错位。
const MAP = [
  { file: 'core.js', from: 4, to: 7, title: '基础设施：DOM 助手、全局 API 引用' },
  { file: 'icons.js', from: 8, to: 63, title: '图标集（Lucide 风格 stroke，24×24）' },
  { file: 'core.js+', from: 64, to: 220, title: '状态与工具 · 持久化 · Toast/Modal/右键菜单 · 文件图标缓存' },
  { file: 'shell.js', from: 221, to: 332, title: '外壳：导航、主题与外观、窗口控制、视图分发' },
  { file: 'view-dashboard.js', from: 333, to: 388, title: '首页' },
  { file: 'view-shortcuts.js', from: 389, to: 431, title: '快捷入口' },
  { file: 'view-files.js', from: 432, to: 497, title: '文件整理' },
  { file: 'view-todos.js', from: 498, to: 656, title: '待办' },
  { file: 'view-calendar.js', from: 657, to: 867, title: '日历视图' },
  { file: 'view-notes.js', from: 868, to: 912, title: '便签' },
  { file: 'view-checkins.js', from: 913, to: 967, title: '打卡' },
  { file: 'view-stats.js', from: 968, to: 1045, title: '数据洞察' },
  { file: 'view-usage.js', from: 1046, to: 1157, title: '自动时间统计' },
  { file: 'view-pomodoro.js', from: 1158, to: 1236, title: '番茄钟' },
  { file: 'view-settings.js', from: 1237, to: 1377, title: '设置' },
  { file: 'diagnostics.js', from: 1378, to: 1432, title: '运行环境诊断（设置页）' },
  { file: 'dialogs.js', from: 1433, to: 1586, title: '输入提示与规则编辑弹窗、确认框' },
  { file: 'search.js', from: 1587, to: 1746, title: '全局搜索与命令面板' },
  { file: 'actions.js', from: 1747, to: 2158, title: '事件委托（控制器）：所有 data-act 动作分发' },
  { file: 'guide.js', from: 2159, to: 2207, title: '首次使用引导与危险操作确认' },
  { file: 'app.js', from: 2208, to: 2271, title: '启动' }
];

// 加载顺序（index.html 用）
const ORDER = MAP.map(m => m.file.replace(/\+$/, '')).filter((f, i, a) => a.indexOf(f) === i);

function build() {
  const src = fs.readFileSync(SRC, 'utf8').split('\n');
  const total = src.length;

  // 覆盖校验：区间必须连续、不重叠、恰好覆盖 4..2271（1-3 行是包装头，2272-2274 是包装尾）
  const ranges = MAP.map(m => ({ file: m.file.replace(/\+$/, ''), from: m.from, to: m.to, title: m.title }));
  let expect = 4;
  const problems = [];
  for (const r of ranges) {
    if (r.from !== expect) problems.push(`区间不连续：${r.file} 期望从 ${expect} 开始，实际 ${r.from}`);
    if (r.to < r.from) problems.push(`区间非法：${r.file} ${r.from}-${r.to}`);
    expect = r.to + 1;
  }
  if (expect !== total - 2) problems.push(`覆盖不足/超出：结束于 ${expect - 1}，应为 ${total - 3}（共 ${total} 行）`);
  if (problems.length) return { ok: false, problems };

  // 合并同一目标文件的多个区间
  const byFile = new Map();
  for (const r of ranges) {
    if (!byFile.has(r.file)) byFile.set(r.file, { chunks: [], title: r.title });
    byFile.get(r.file).chunks.push({ from: r.from, to: r.to, title: r.title });
  }

  const outputs = [];
  for (const [file, info] of byFile) {
    const body = [];
    for (const c of info.chunks) {
      const head = [
        '// ---------------------------------------------------------------',
        '// ' + c.title,
        '// ---------------------------------------------------------------'
      ];
      // 若源区间本身已以章节注释开头，就不再补标题，避免重复
      const firstLine = src[c.from - 1] || '';
      const chunk = src.slice(c.from - 1, c.to).map(l => l.replace(/^ {2}/, ''));
      const alreadyTitled = /^\s*\/\/ -{5,}/.test(firstLine);
      body.push((alreadyTitled ? [] : head).concat(chunk).join('\n'));
    }
    const header = [
      "'use strict';",
      '',
      '/* ' + file + ' —— ' + info.title,
      '   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。',
      '   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，',
      '   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名',
      '   （由 test/contract.test.js 校验）。 */',
      ''
    ].join('\n');
    outputs.push({ file, content: header + body.join('\n') + '\n', lines: body.join('\n').split('\n').length });
  }

  return { ok: true, outputs, total };
}

if (require.main === module) {
  const dry = process.argv.indexOf('--dry') !== -1;
  const res = build();
  if (!res.ok) {
    console.error('拆分区间校验失败：');
    for (const p of res.problems) console.error('  - ' + p);
    process.exit(1);
  }
  let sum = 0;
  for (const o of res.outputs) {
    sum += o.lines;
    console.log(String(o.lines).padStart(5) + ' 行  renderer/' + o.file);
  }
  console.log('---');
  console.log('源文件正文行数（不含包装）：' + (res.total - 5) + '，拆分后行数合计：' + sum);
  console.log('加载顺序：' + ORDER.join(' → '));
  if (dry) { console.log('（--dry：未写入任何文件）'); process.exit(0); }

  for (const o of res.outputs) {
    fs.writeFileSync(path.join(RENDERER, o.file), o.content, 'utf8');
    console.log('已写入 renderer/' + o.file);
  }
}

module.exports = { build, MAP, ORDER };
