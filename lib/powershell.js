'use strict';

/* ===========================================================================
   PowerShell 能力探测与统一调用入口
   ---------------------------------------------------------------------------
   本应用有 4 处依赖 PowerShell：
     · 剪贴板文件条目：补全完整文件列表（Get-Clipboard -Format FileDropList）
     · 剪贴板文件写回（Set-Clipboard -Path）
     · .lnk 目标解析兜底（WScript.Shell，Electron readShortcutLink 失败的场景）
     · 图标提取兜底（GDI+ ExtractAssociatedIcon）
     · 时间统计常驻采样进程（Add-Type P/Invoke 取前台窗口）
   旧实现里这些调用失败一律静默忽略，用户看到的现象只是「功能没反应」，
   完全无从排查。现在改为：
     · 启动时（与首次使用时）跑一次能力探测，结果随 app:diagnostics 暴露给界面
     · powershell.exe 不可用时自动回退 pwsh.exe（PowerShell 7）
     · 每个降级点记录原因，界面在设置页集中展示
   =========================================================================== */

const { execFile, spawn } = require('child_process');

// 单行探测脚本：版本 / 语言模式 / Add-Type 是否可用 / 剪贴板 cmdlet 是否可用
// 注意：探测类不能是空类 —— Add-Type 对「没有公共成员的类」会打印一条本地化警告
// （例如中文系统的「警告: 所生成的类型未定义公共方法或属性。」），混进 stdout 会破坏解析。
// 即便如此，解析侧仍按「容忍噪音」实现（见 parseProbeOutput），因为其它策略/本地化
// 信息同样可能出现在输出里。
const PROBE_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue'",
  "[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)",
  "$lang=[string]$ExecutionContext.SessionState.LanguageMode",
  "$at='no'",
  "try{Add-Type -TypeDefinition 'public class WBProbe{public static int Ready=1;}' -ErrorAction Stop; $at='yes'}catch{$at='no'}",
  "$cmds=@()",
  "foreach($c in @('Get-Clipboard','Set-Clipboard')){if(Get-Command $c -ErrorAction SilentlyContinue){$cmds+=$c}}",
  "$o=[ordered]@{ok=$true;ps=[string]$PSVersionTable.PSVersion;lang=$lang;addType=$at;cmds=($cmds -join ',')}",
  "$o|ConvertTo-Json -Compress"
].join('; ');

/* 从 PowerShell 输出里取出探测结果 JSON。
   PowerShell 可能在结果前后混入警告 / 进度 / 本地化提示，因此不能直接 JSON.parse。 */
function parseProbeOutput(stdout) {
  const text = String(stdout == null ? '' : stdout).replace(/^\uFEFF/, '');
  const direct = text.trim();
  if (direct) {
    try {
      const parsed = JSON.parse(direct);
      if (parsed && parsed.ok) return parsed;
    } catch (e) { /* 有噪音，走下面的兜底 */ }
  }
  // 兜底 1：取最后一段看起来像对象的 {...}（探测结果是最后一行输出）
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    const start = line.indexOf('{');
    const end = line.lastIndexOf('}');
    if (start === -1 || end <= start) continue;
    try {
      const parsed = JSON.parse(line.slice(start, end + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { /* 继续找上一条 */ }
  }
  // 兜底 2：JSON 被格式化到多行（例如 ConvertTo-Json 没加 -Compress）时，
  // 取整段输出里第一个 { 到最后一个 } 之间的内容再试一次
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      const parsed = JSON.parse(text.slice(first, last + 1));
      if (parsed && typeof parsed === 'object') return parsed;
    } catch (e) { /* 放弃 */ }
  }
  return null;
}

/* 取输出的最后一行非空内容：用于 Get-Clipboard / WScript.Shell 这类「结果即一行」的调用，
   同样要容忍前面混入的警告行。 */
function lastMeaningfulLine(stdout) {
  const lines = String(stdout == null ? '' : stdout).replace(/^\uFEFF/, '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t) return t;
  }
  return '';
}

function createPowerShell(opts) {
  const options = opts || {};
  const candidates = options.candidates || ['powershell.exe', 'pwsh.exe'];
  const platform = options.platform || process.platform;
  const probeTimeout = options.probeTimeout || 12000;
  const log = typeof options.log === 'function' ? options.log : () => {};
  // 允许注入 exec：测试里用来模拟各种真实输出（含被警告污染的 stdout）
  const execImpl = typeof options.exec === 'function' ? options.exec : null;

  const state = {
    probing: null,
    checked: false,
    available: false,
    exe: null,
    version: null,
    languageMode: null,
    canAddType: false,
    clipboardCmdlets: false,
    reason: null
  };
  const features = {};            // 功能级降级记录： name → { ok, msg, at }
  const listeners = [];

  function notify() {
    const diag = diagnostics();
    for (const cb of listeners.slice()) {
      try { cb(diag); } catch (e) { /* ignore */ }
    }
  }

  function exec(exe, args, o) {
    const cfg = o || {};
    if (execImpl) return Promise.resolve(execImpl(exe, args, cfg));
    return new Promise((resolve) => {
      try {
        execFile(exe, args, {
          windowsHide: true,
          timeout: cfg.timeout || 8000,
          encoding: 'utf8',
          maxBuffer: cfg.maxBuffer || 4 * 1024 * 1024
        }, (err, stdout, stderr) => {
          resolve({
            ok: !err,
            err: err || null,
            stdout: typeof stdout === 'string' ? stdout : '',
            stderr: typeof stderr === 'string' ? stderr : '',
            error: err ? String((err && err.message) || err) : ''
          });
        });
      } catch (e) {
        resolve({ ok: false, err: e, stdout: '', stderr: '', error: String((e && e.message) || e) });
      }
    });
  }

  // 探测一次并缓存；force=true 用于设置页「重新检测」
  function probe(force) {
    if (state.checked && !force) return Promise.resolve(diagnostics());
    if (state.probing) return state.probing;
    if (platform !== 'win32') {
      state.checked = true;
      state.available = false;
      state.reason = 'not-windows';
      notify();
      return Promise.resolve(diagnostics());
    }
    state.probing = (async () => {
      let lastError = '';
      for (const exe of candidates) {
        const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROBE_SCRIPT];
        const r = await exec(exe, args, { timeout: probeTimeout });
        if (r.ok && r.stdout) {
          const parsed = parseProbeOutput(r.stdout);
          if (parsed && parsed.ok) {
            state.checked = true;
            state.available = true;
            state.exe = exe;
            state.version = parsed.ps || '';
            state.languageMode = parsed.lang || '';
            state.canAddType = parsed.addType === 'yes';
            state.clipboardCmdlets = String(parsed.cmds || '').indexOf('Get-Clipboard') !== -1
              && String(parsed.cmds || '').indexOf('Set-Clipboard') !== -1;
            state.reason = null;
            log('PowerShell 可用：' + exe + ' ' + state.version + ' (' + state.languageMode + ')');
            state.probing = null;
            notify();
            return diagnostics();
          }
          lastError = '探测输出无法解析（' + String(r.stdout).replace(/\s+/g, ' ').trim().slice(0, 120) + '）';
        } else {
          lastError = r.error || 'exec 失败';
        }
        log('PowerShell 候选不可用 ' + exe + '：' + lastError);
      }
      state.checked = true;
      state.available = false;
      state.exe = null;
      state.reason = lastError || 'not-found';
      state.probing = null;
      notify();
      return diagnostics();
    })();
    return state.probing;
  }

  // 统一脚本调用入口；PowerShell 不可用时立刻返回失败（不再静默等待）
  function run(args, o) {
    if (!state.available || !state.exe) {
      return Promise.resolve({
        ok: false, stdout: '', stderr: '',
        error: 'PowerShell 不可用（' + (state.reason || '未探测') + '）',
        unavailable: true
      });
    }
    return exec(state.exe, args, o);
  }

  // 构造调用脚本的参数（-EncodedCommand 用于长脚本，避免命令行长度与转义问题）
  function scriptArgs(script, o) {
    const cfg = o || {};
    if (cfg.encoded || String(script).length > 1200) {
      return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-EncodedCommand', Buffer.from(String(script), 'utf16le').toString('base64')];
    }
    return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', String(script)];
  }

  // 常驻子进程（时间统计采样）：PowerShell 不可用时返回 null，调用方据此显式降级
  function spawnProcess(args, spawnOpts) {
    if (!state.available || !state.exe) return null;
    try {
      return spawn(state.exe, args, spawnOpts || { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      noteFeature('usage-helper', false, String((e && e.message) || e));
      return null;
    }
  }

  // 记录某个功能点的降级状态，供诊断页展示
  function noteFeature(name, ok, msg) {
    const prev = features[name];
    const next = { ok: !!ok, msg: ok ? '' : String(msg || ''), at: Date.now() };
    if (prev && prev.ok === next.ok && prev.msg === next.msg) return;   // 避免重复刷屏
    features[name] = next;
    if (!ok) log('功能降级 ' + name + '：' + next.msg);
    notify();
  }

  function diagnostics() {
    return {
      platform: platform,
      checked: state.checked,
      available: state.available,
      exe: state.exe,
      version: state.version,
      languageMode: state.languageMode,
      canAddType: state.canAddType,
      clipboardCmdlets: state.clipboardCmdlets,
      reason: state.reason,
      features: JSON.parse(JSON.stringify(features))
    };
  }

  return {
    probe: probe,
    run: run,
    scriptArgs: scriptArgs,
    spawn: spawnProcess,
    exePath: () => state.exe,
    isAvailable: () => state.available,
    isChecked: () => state.checked,
    noteFeature: noteFeature,
    diagnostics: diagnostics,
    onUpdate: (cb) => { if (typeof cb === 'function') listeners.push(cb); }
  };
}

module.exports = { createPowerShell, PROBE_SCRIPT, parseProbeOutput, lastMeaningfulLine };
