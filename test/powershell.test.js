'use strict';

/* PowerShell 探测与输出解析单测
   背景（真实踩过的坑）：Add-Type 一个空类会在中文系统上打印
   「警告: 所生成的类型未定义公共方法或属性。」，混进 stdout 后
   直接 JSON.parse 必然失败 —— 结果就是所有中文 Windows 用户都被误判成
   「PowerShell 不可用」，时间统计与剪贴板文件功能被静默关闭。
   这里用真实输出样本把解析行为固定住。 */

const test = require('node:test');
const assert = require('node:assert');
const { createPowerShell, parseProbeOutput, lastMeaningfulLine, PROBE_SCRIPT } = require('../lib/powershell.js');

const GOOD_JSON = '{"ok":true,"ps":"5.1.26100.9444","lang":"FullLanguage","addType":"yes","cmds":"Get-Clipboard,Set-Clipboard"}';

test('解析：干净的 JSON 输出', () => {
  const r = parseProbeOutput(GOOD_JSON);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.ps, '5.1.26100.9444');
  assert.strictEqual(r.addType, 'yes');
});

test('解析：带中文警告行 + CRLF（真实样本）', () => {
  const stdout = '警告: 所生成的类型未定义公共方法或属性。\n' + GOOD_JSON + '\r\n';
  const r = parseProbeOutput(stdout);
  assert.ok(r, '必须能从噪音里取出 JSON');
  assert.strictEqual(r.ps, '5.1.26100.9444');
});

test('解析：带 BOM、前后空行、多行警告', () => {
  const stdout = '\uFEFF警告: 无法加载模块\n警告: 语言模式受限\n\n' + GOOD_JSON + '\n\n';
  const r = parseProbeOutput(stdout);
  assert.ok(r);
  assert.strictEqual(r.lang, 'FullLanguage');
});

test('解析：结果被格式化在多行（ConvertTo-Json 默认行为）', () => {
  const stdout = '警告: something\n{\n  "ok": true,\n  "ps": "7.4.0",\n  "addType": "no",\n  "cmds": ""\n}\n';
  const r = parseProbeOutput(stdout);
  assert.ok(r, '多行 JSON 也要能取出（取最后一段 {…}）');
  assert.strictEqual(r.ps, '7.4.0');
});

test('解析：无有效输出时返回 null（不抛异常）', () => {
  assert.strictEqual(parseProbeOutput(''), null);
  assert.strictEqual(parseProbeOutput(null), null);
  assert.strictEqual(parseProbeOutput('纯粹的文字输出'), null);
  assert.strictEqual(parseProbeOutput('{坏掉的 json'), null);
});

test('lastMeaningfulLine：取最后一行非空内容（用于单行结果）', () => {
  assert.strictEqual(lastMeaningfulLine('C:\\app\\x.exe\r\n'), 'C:\\app\\x.exe');
  assert.strictEqual(lastMeaningfulLine('警告: 提示\nC:\\app\\x.exe\n'), 'C:\\app\\x.exe');
  assert.strictEqual(lastMeaningfulLine('\uFEFFD:\\a b\\c.lnk\n\n'), 'D:\\a b\\c.lnk');
  assert.strictEqual(lastMeaningfulLine('a|b|c'), 'a|b|c');
  assert.strictEqual(lastMeaningfulLine(''), '');
  assert.strictEqual(lastMeaningfulLine(null), '');
});

test('探测脚本本身不再触发「空类」警告（类含公共成员）', () => {
  assert.ok(PROBE_SCRIPT.indexOf('public class WBProbe{') !== -1);
  assert.ok(/public class WBProbe\{[^}]*public/.test(PROBE_SCRIPT), '探测类必须含公共成员，避免 Add-Type 警告');
});

test('probe：中文警告污染输出时仍判定为可用（回归）', async () => {
  const ps = createPowerShell({
    platform: 'win32',
    candidates: ['powershell.exe'],
    exec: () => Promise.resolve({
      ok: true,
      stdout: '警告: 所生成的类型未定义公共方法或属性。\n' + GOOD_JSON + '\r\n',
      stderr: '', error: ''
    })
  });
  const d = await ps.probe();
  assert.strictEqual(d.available, true, '不能被警告行误判为不可用');
  assert.strictEqual(d.exe, 'powershell.exe');
  assert.strictEqual(d.languageMode, 'FullLanguage');
  assert.strictEqual(d.canAddType, true);
  assert.strictEqual(d.clipboardCmdlets, true);
});

test('probe：powershell.exe 不可用时回退 pwsh.exe', async () => {
  const calls = [];
  const ps = createPowerShell({
    platform: 'win32',
    candidates: ['powershell.exe', 'pwsh.exe'],
    exec: (exe) => {
      calls.push(exe);
      if (exe === 'powershell.exe') return Promise.resolve({ ok: false, stdout: '', stderr: '', error: 'ENOENT' });
      return Promise.resolve({ ok: true, stdout: '{"ok":true,"ps":"7.4.2","lang":"FullLanguage","addType":"yes","cmds":"Get-Clipboard,Set-Clipboard"}', stderr: '', error: '' });
    }
  });
  const d = await ps.probe();
  assert.strictEqual(d.available, true);
  assert.strictEqual(d.exe, 'pwsh.exe');
  assert.deepStrictEqual(calls, ['powershell.exe', 'pwsh.exe']);
});

test('probe：全部候选失败时给出原因，且结果被缓存', async () => {
  let calls = 0;
  const ps = createPowerShell({
    platform: 'win32',
    candidates: ['powershell.exe', 'pwsh.exe'],
    exec: () => { calls++; return Promise.resolve({ ok: false, stdout: '', stderr: '', error: '被策略阻止' }); }
  });
  const d1 = await ps.probe();
  assert.strictEqual(d1.available, false);
  assert.match(String(d1.reason), /被策略阻止/);
  const d2 = await ps.probe();                 // 第二次应命中缓存
  assert.strictEqual(d2.available, false);
  assert.strictEqual(calls, 2, '缓存生效时不应重复探测两个候选');
});

test('probe：非 Windows 平台直接判定不可用（不执行任何命令）', async () => {
  let calls = 0;
  const ps = createPowerShell({ platform: 'linux', exec: () => { calls++; return Promise.resolve({ ok: true, stdout: GOOD_JSON }); } });
  const d = await ps.probe();
  assert.strictEqual(d.available, false);
  assert.strictEqual(d.reason, 'not-windows');
  assert.strictEqual(calls, 0);
});

test('run：不可用时立即返回失败并带原因（调用方无需等待超时）', async () => {
  const ps = createPowerShell({ platform: 'win32', exec: () => Promise.resolve({ ok: false, stdout: '', error: 'x' }) });
  await ps.probe();
  const r = await ps.run(['-Command', 'whatever']);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.unavailable, true);
  assert.match(String(r.error), /PowerShell 不可用/);
});

test('功能降级记录：同一原因只通知一次，状态可查', async () => {
  const ps = createPowerShell({ platform: 'win32', candidates: ['powershell.exe'], exec: () => Promise.resolve({ ok: true, stdout: GOOD_JSON, error: '' }) });
  let updates = 0;
  ps.onUpdate(() => updates++);
  await ps.probe();
  const after = updates;
  ps.noteFeature('icon-extract', false, '失败 A');
  ps.noteFeature('icon-extract', false, '失败 A');   // 重复不应再通知
  assert.strictEqual(updates, after + 1, '相同状态的降级不应反复通知');
  ps.noteFeature('icon-extract', true);
  assert.strictEqual(ps.diagnostics().features['icon-extract'].ok, true);
});
