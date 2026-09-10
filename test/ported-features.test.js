'use strict';

/* 敏感内容过滤 + 导入守卫 + 按月顺延 单测
   这三块都是「从上游仓库合并过来的既有功能」，本次重构后必须有测试守着，
   否则下次重构很容易在搬迁中丢掉它们。 */

const test = require('node:test');
const assert = require('node:assert');
const { isSensitiveText, sensitiveKind } = require('../lib/sensitive.js');
const guard = require('../renderer/importguard.js');
const dateutil = require('../renderer/dateutil.js');

// ---------------------------------------------------------------- 敏感内容
test('敏感内容：JWT 被识别', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.strictEqual(isSensitiveText(jwt), true);
  assert.strictEqual(sensitiveKind(jwt), 'JWT');
});

test('敏感内容：私钥（含各类头）被识别', () => {
  for (const head of ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY', 'OPENSSH PRIVATE KEY']) {
    const text = '-----BEGIN ' + head + '-----\nMIIEvQIBADANBg...\n-----END ' + head + '-----';
    assert.strictEqual(isSensitiveText(text), true, head);
  }
});

test('敏感内容：键值对形式的凭据被识别', () => {
  const samples = [
    'password=SuperSecret123',
    'passwd: hunter2hunter2',
    'pwd = abcdefgh',
    'secret: 0123456789abcdef',
    'api_key=sk-abcdefghijklmn',
    'API-KEY: ZZZZZZZZZZZZ',
    'token=eyJhbGciOiJIUzI1NiJ9',
    'access_key: ABCD1234EFGH5678',
    'client_secret=qqqqqqqqqqqq',
    '登录口令：mypassword123',
    '密码: 1234567890'
  ];
  for (const s of samples) assert.strictEqual(isSensitiveText(s), true, s);
});

test('敏感内容：云厂商 Token 被识别', () => {
  assert.strictEqual(isSensitiveText('ghp_' + 'a'.repeat(36)), true, 'GitHub PAT');
  assert.strictEqual(isSensitiveText('github_pat_' + 'A1b2'.repeat(8)), true, 'GitHub fine-grained');
  assert.strictEqual(isSensitiveText('xoxb-123456789012-abcdefghijkl'), true, 'Slack');
  assert.strictEqual(isSensitiveText('AKIAIOSFODNN7EXAMPLE'), true, 'AWS');
  assert.strictEqual(isSensitiveText('AIza' + 'B'.repeat(35)), true, 'Google API Key');
  assert.strictEqual(isSensitiveText('sk_live_' + 'c'.repeat(24)), true, 'Stripe');
  assert.strictEqual(isSensitiveText('Authorization: Bearer ' + 'd'.repeat(30)), true, 'Bearer');
});

test('敏感内容：普通文本不误判（避免把正常复制内容全过滤掉）', () => {
  const normal = [
    '今天下午三点开会',
    'npm run build && npm test',
    'const token = getToken();',                       // 代码里出现 token 但不是赋值凭据
    'password',                                        // 只有关键词、没有值
    'password=short',                                   // 值太短（<8）
    'https://example.com/docs?page=2',
    'function isSensitiveText(text) { return false; }',
    '订单号：1234567890',
    'eyJhbGciOiJIUzI1NiJ9',                            // 只有一段，不是完整 JWT
    ''
  ];
  for (const s of normal) assert.strictEqual(isSensitiveText(s), false, JSON.stringify(s));
});

test('敏感内容：空值与异常输入不抛异常', () => {
  assert.strictEqual(isSensitiveText(''), false);
  assert.strictEqual(isSensitiveText(null), false);
  assert.strictEqual(isSensitiveText(undefined), false);
  assert.strictEqual(isSensitiveText(12345), false);
  assert.strictEqual(sensitiveKind(null), null);
});

// ---------------------------------------------------------------- 导入守卫
test('导入守卫：脏集合被清洗（非对象项、缺失 items）', () => {
  const san = guard.sanitizeImported({
    todos: [{ id: 'a', text: 'x' }, null, 'string', 42],
    notes: 'not-an-array',
    checkins: [{ id: 'c' }],
    shortcuts: [{ id: 's', icon: 'data:image/png;base64,' + 'A'.repeat(5000) }],
    groups: [{ id: 'g', items: [{ id: 'i' }, null] }, { id: 'g2' }],
    settings: { theme: 'dark' },
    profile: { name: 'X' }
  });
  assert.deepStrictEqual(san.todos.map(t => t.id), ['a']);
  assert.deepStrictEqual(san.notes, []);
  assert.strictEqual(san.groups[0].items.length, 1, '分组里非对象条目应被剔除');
  assert.deepStrictEqual(san.groups[1].items, [], '缺失 items 应补空数组');
  assert.strictEqual(san.shortcuts[0].icon, null, '导入的内联 base64 图标应被丢弃（避免数据文件膨胀）');
  assert.strictEqual(san.settings.theme, 'dark');
});

test('导入守卫：todos 的子任务/历史字段被补齐', () => {
  const san = guard.sanitizeImported({ todos: [{ id: 'a' }] });
  assert.deepStrictEqual(san.todos[0].subtasks, []);
  assert.deepStrictEqual(san.todos[0].doneHistory, []);
});

test('导入守卫：绝对路径判断', () => {
  assert.strictEqual(guard.isAbsPath('C:\\Users\\me\\Desktop'), true);
  assert.strictEqual(guard.isAbsPath('D:/data/inbox'), true);
  assert.strictEqual(guard.isAbsPath('\\\\server\\share'), true);
  assert.strictEqual(guard.isAbsPath('inbox'), false);
  assert.strictEqual(guard.isAbsPath('../other'), false);
  assert.strictEqual(guard.isAbsPath(''), false);
  assert.strictEqual(guard.isAbsPath(null), false);
});

test('导入守卫：autoOrganize 非法则保留原设置（绝不接受相对路径）', () => {
  const prev = { theme: 'light', autoOrganize: { enabled: true, watch: 'C:\\inbox', rules: [{ type: 'ext', value: 'pdf', to: 'C:\\docs' }] } };
  const bad = guard.sanitizeSettingsMerge(prev, {
    theme: 'dark',
    autoOrganize: { enabled: true, watch: 'inbox', rules: [{ type: 'ext', value: 'pdf', to: 'C:\\docs' }] }
  });
  assert.strictEqual(bad.theme, 'dark', '普通设置应合并');
  assert.deepStrictEqual(bad.autoOrganize, prev.autoOrganize, '监控目录不是绝对路径 → 保留原设置');

  const badRule = guard.sanitizeSettingsMerge(prev, {
    autoOrganize: { enabled: true, watch: 'C:\\inbox2', rules: [{ type: 'ext', value: 'pdf', to: 'docs' }] }
  });
  assert.deepStrictEqual(badRule.autoOrganize, prev.autoOrganize, '规则目标不是绝对路径 → 保留原设置');

  const good = guard.sanitizeSettingsMerge(prev, {
    autoOrganize: { enabled: true, watch: 'C:\\inbox2', rules: [{ type: 'kw', value: '发票', to: 'D:\\票据' }] }
  });
  assert.strictEqual(good.autoOrganize.watch, 'C:\\inbox2');
  assert.strictEqual(good.autoOrganize.rules[0].value, '发票');
  assert.strictEqual(good.autoOrganize.rules[0].type, 'kw');
});

test('导入守卫：布尔开关归一化，且不修改入参', () => {
  const prev = { clipboardSensitive: true };
  const imp = { clipboardSensitive: 'yes', clipboardHistory: 0 };
  const before = JSON.stringify(imp);
  const out = guard.sanitizeSettingsMerge(prev, imp);
  assert.strictEqual(out.clipboardSensitive, true, '非 false 一律视为开启');
  assert.strictEqual(out.clipboardHistory, true);
  assert.strictEqual(JSON.stringify(imp), before, '不应就地修改导入对象');
  assert.strictEqual(guard.sanitizeSettingsMerge(prev, { clipboardSensitive: false }).clipboardSensitive, false);
});

// ---------------------------------------------------------------- 按月顺延
test('按月顺延：日期被钳制到目标月最后一天（不再跳到下下月）', () => {
  const cases = [
    ['2026-01-31', '2026-02-28'],
    ['2024-01-31', '2024-02-29'],   // 闰年
    ['2026-03-31', '2026-04-30'],
    ['2026-05-31', '2026-06-30'],
    ['2026-08-31', '2026-09-30'],
    ['2026-10-31', '2026-11-30'],
    ['2026-12-31', '2027-01-31'],   // 跨年
    ['2026-01-15', '2026-02-15'],   // 普通日期不受影响
    ['2026-09-30', '2026-10-30']
  ];
  for (const [from, expected] of cases) {
    const d = new Date(from + 'T00:00:00');
    dateutil.advanceMonthClamped(d);
    assert.strictEqual(dateutil.dateKey(d), expected, from + ' → ' + expected);
  }
});

test('按月顺延：连续多次顺延仍稳定（1/31 一路走下去）', () => {
  const d = new Date('2026-01-31T00:00:00');
  const seq = [];
  for (let i = 0; i < 4; i++) { dateutil.advanceMonthClamped(d); seq.push(dateutil.dateKey(d)); }
  assert.deepStrictEqual(seq, ['2026-02-28', '2026-03-28', '2026-04-28', '2026-05-28']);
});

test('日期工具：dateKey / addDays / daysInMonth', () => {
  assert.strictEqual(dateutil.dateKey(new Date('2026-09-07T23:59:00')), '2026-09-07');
  assert.strictEqual(dateutil.dateKey(dateutil.addDays(new Date('2026-12-31T00:00:00'), 1)), '2027-01-01');
  assert.strictEqual(dateutil.dateKey(dateutil.addDays(new Date('2026-03-01T00:00:00'), -1)), '2026-02-28');
  assert.strictEqual(dateutil.daysInMonth(2024, 1), 29);
  assert.strictEqual(dateutil.daysInMonth(2026, 1), 28);
  assert.strictEqual(dateutil.daysInMonth(2026, 11), 31);
});
