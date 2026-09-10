'use strict';

/* ===========================================================================
   自动时间统计的领域逻辑（纯函数，无 Electron / fs 依赖，可单测）
   ---------------------------------------------------------------------------
   从 main.js 抽出的部分：
     · 采样设置归一化（老数据缺省回退默认值）
     · 分类规则匹配（进程名不分大小写包含匹配、标题规则对友好名做包含匹配）
     · 时长累计（含 2000 个应用键的长尾合并）
     · 汇总（近 N 天逐日、分类占比、应用 Top10、标题 Top10、番茄标注）
   运行期（采样进程、定时器、落盘）仍留在主进程，因为它们依赖 Electron。
   =========================================================================== */

const SELF_LABEL = '桌面工作台';
const IDLE_CHOICES = [120, 300, 600];
const MAX_APPS_PER_DAY = 2000;          // 超过后把最短尾部的应用合并进 __other__

// 采样用的 PowerShell 脚本（常驻进程，每 5 秒输出一行 JSON）
const USAGE_PS_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;using System.Text;public class FGW{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern int GetWindowTextW(IntPtr h,[MarshalAs(UnmanagedType.LPWStr)]StringBuilder t,int c);[DllImport(\"user32.dll\")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);}'",
  "while ($true) {",
  "  $h = [FGW]::GetForegroundWindow()",
  "  $wpid = [uint32]0",
  "  [FGW]::GetWindowThreadProcessId($h, [ref]$wpid) | Out-Null",
  "  $sb = New-Object System.Text.StringBuilder 512",
  "  [FGW]::GetWindowTextW($h, $sb, 512) | Out-Null",
  "  $title = $sb.ToString()",
  "  $exe = ''; $app = ''",
  "  if ($wpid -gt 0) { $p = Get-Process -Id $wpid -ErrorAction SilentlyContinue; if ($p) { $exe = $p.ProcessName; $app = $p.Description; if (-not $app) { $app = $exe } } }",
  "  $o = @{ exe = $exe; app = $app; title = $title } | ConvertTo-Json -Compress",
  "  [Console]::Out.WriteLine($o)",
  "  [Console]::Out.Flush()",
  "  Start-Sleep -Seconds 5",
  "}"
].join('\n') + '\n';

// 归一化时间统计设置（与 lib/defaults.js 的 TIME_TRACK_DEFAULTS 配合）
function normalizeTrackSettings(raw, defaults) {
  const d = defaults || {};
  const t = (raw && typeof raw === 'object') ? raw : {};
  const rules = Array.isArray(t.rules)
    ? t.rules.filter(r => r && r.value && r.category)
    : (Array.isArray(d.rules) ? d.rules : []);
  return {
    enabled: t.enabled === true,
    idleSeconds: IDLE_CHOICES.indexOf(t.idleSeconds) !== -1 ? t.idleSeconds : (d.idleSeconds || 300),
    recordTitles: t.recordTitles === true,
    rules: rules
  };
}

/* 分类：本应用自身固定为「桌面工作台」；否则按规则顺序匹配 ——
   exe 规则对进程名做不分大小写的包含匹配，title 规则对进程友好名做包含匹配；
   未命中归「其他」。分类在汇总时计算，因此规则改动对历史数据即时生效。 */
function categoryOf(exeKey, displayName, rules, selfLabel) {
  if (String(exeKey) === (selfLabel || SELF_LABEL)) return (selfLabel || SELF_LABEL);
  const nameL = String(displayName == null ? '' : displayName).toLowerCase();
  const exeL = String(exeKey == null ? '' : exeKey).toLowerCase();
  const list = Array.isArray(rules) ? rules : [];
  for (let i = 0; i < list.length; i++) {
    const r = list[i];
    const v = String((r && r.value) || '').trim().toLowerCase();
    if (!v || !(r && r.category)) continue;
    if (r.match === 'title') {
      if (nameL.indexOf(v) !== -1) return r.category;
    } else if (exeL.indexOf(v) !== -1) {
      return r.category;
    }
  }
  return '其他';
}

// 取（或创建）某一天的记录容器
function ensureDay(usageData, dayKey) {
  if (!usageData.days || typeof usageData.days !== 'object') usageData.days = {};
  let day = usageData.days[dayKey];
  if (!day || typeof day !== 'object') { day = { apps: {}, titles: {} }; usageData.days[dayKey] = day; }
  if (!day.apps || typeof day.apps !== 'object') day.apps = {};
  if (!day.titles || typeof day.titles !== 'object') day.titles = {};
  return day;
}

/* 把秒数记到样本所属应用上。sample = { exe, app, title } */
function addSeconds(usageData, dayKey, sample, seconds, recordTitles) {
  if (!sample || !sample.exe || !(seconds > 0)) return false;
  const day = ensureDay(usageData, dayKey);
  const key = String(sample.exe).toLowerCase();
  const rec = day.apps[key] || (day.apps[key] = { name: sample.app || sample.exe, seconds: 0 });
  if (sample.app) rec.name = sample.app;
  rec.seconds = (rec.seconds || 0) + seconds;

  // 长尾合并：单日应用键过多时，把时长最短的并入 __other__，防止文件无限膨胀
  const keys = Object.keys(day.apps);
  if (keys.length > MAX_APPS_PER_DAY) {
    keys.sort((a, b) => (day.apps[b].seconds || 0) - (day.apps[a].seconds || 0));
    const other = day.apps.__other__ || (day.apps.__other__ = { name: '其他', seconds: 0 });
    for (const k of keys.slice(MAX_APPS_PER_DAY)) {
      if (k === '__other__') continue;
      other.seconds += day.apps[k].seconds || 0;
      delete day.apps[k];
    }
  }
  if (recordTitles && sample.title) {
    const tk = (sample.app || sample.exe) + '|' + String(sample.title).slice(0, 120);
    day.titles[tk] = (day.titles[tk] || 0) + seconds;
  }
  return true;
}

function emptySummary(supported) {
  return {
    supported: supported !== false,
    enabled: false,
    dayCount: 0,
    today: { total: 0, categories: [], topApps: [] },
    daily: [],
    topApps: [],
    categories: [],
    topTitles: [],
    pomodoros: { today: 0, week: 0 }
  };
}

/* 汇总：dayKeys 为升序日期键数组（含今天），today 为今天的键 */
function summarize(usageData, opts) {
  const o = opts || {};
  const dayKeys = Array.isArray(o.dayKeys) ? o.dayKeys : [];
  const today = o.today || dayKeys[dayKeys.length - 1] || '';
  const cat = typeof o.categoryOf === 'function' ? o.categoryOf : () => '其他';
  const days = usageData && usageData.days ? usageData.days : {};

  const appAgg = new Map();
  const catAgg = new Map();
  const todayCats = new Map();
  const todayApps = [];
  let todayTotal = 0;

  const daily = dayKeys.map(dk => {
    const day = days[dk];
    let total = 0;
    if (day && day.apps) {
      for (const k of Object.keys(day.apps)) {
        const rec = day.apps[k] || {};
        const sec = rec.seconds || 0;
        total += sec;
        const name = rec.name || k;
        const c = cat(k, name);
        const prev = appAgg.get(k);
        if (prev) prev.seconds += sec;
        else appAgg.set(k, { name: name, seconds: sec });
        catAgg.set(c, (catAgg.get(c) || 0) + sec);
        if (dk === today) {
          todayTotal += sec;
          todayCats.set(c, (todayCats.get(c) || 0) + sec);
          todayApps.push({ key: k, name: name, seconds: sec });
        }
      }
    }
    return { date: dk, total: total };
  });

  const sortBySec = arr => arr.sort((a, b) => b.seconds - a.seconds);
  const out = emptySummary(o.supported);
  out.enabled = o.enabled === true;
  out.daily = daily;
  out.today.total = todayTotal;
  out.today.categories = sortBySec(Array.from(todayCats.entries()).map(([name, seconds]) => ({ name: name, seconds: seconds })));
  out.today.topApps = sortBySec(todayApps).slice(0, 10);
  out.topApps = sortBySec(Array.from(appAgg.values())).slice(0, 10);
  out.categories = sortBySec(Array.from(catAgg.entries()).map(([name, seconds]) => ({ name: name, seconds: seconds })));

  if (o.recordTitles) {
    const tAgg = new Map();
    for (const dk of dayKeys) {
      const day = days[dk];
      if (!day || !day.titles) continue;
      for (const k of Object.keys(day.titles)) tAgg.set(k, (tAgg.get(k) || 0) + (day.titles[k] || 0));
    }
    out.topTitles = sortBySec(Array.from(tAgg.entries()).map(([k, seconds]) => {
      const i = k.indexOf('|');
      return { app: k.slice(0, i), title: k.slice(i + 1), seconds: seconds };
    })).slice(0, 10);
  }

  out.dayCount = Object.keys(days).filter(k => {
    const day = days[k];
    return day && day.apps && Object.keys(day.apps).length > 0;
  }).length;

  // 番茄钟标注（弱耦合：只读主数据里的每日完成数）
  const pd = (o.pomoDone && typeof o.pomoDone === 'object') ? o.pomoDone : {};
  let week = 0;
  for (const dk of dayKeys) week += pd[dk] || 0;
  out.pomodoros = { today: pd[today] || 0, week: week };

  return out;
}

module.exports = {
  SELF_LABEL,
  IDLE_CHOICES,
  MAX_APPS_PER_DAY,
  USAGE_PS_SCRIPT,
  normalizeTrackSettings,
  categoryOf,
  ensureDay,
  addSeconds,
  emptySummary,
  summarize
};
