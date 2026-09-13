'use strict';

/* ===========================================================================
   时间统计采集器（自 main.js 拆出 · 整改 #12 第一刀）
   ---------------------------------------------------------------------------
   职责：驱动 PowerShell 采样进程读取前台窗口，按采样间隔把活跃秒数归因到
   应用，落盘到 <userData>/usage-data.json，并对外提供按天汇总。

   边界约定：
     · usage-data.json 是本模块的「自有数据源」（与 iconcache.js 的图标缓存
       同类），contract.test.js 的写入者白名单已注明；主数据文件
       workbench-data.json 依然只有 lib/store.js 可写；
     · 设置读取（ttSettings）与主数据读取（readStoreData）由 main.js 注入，
       本模块不直接依赖 store；
     · 锁屏/解锁事件由 main.js 监听 powerMonitor 后经 setPaused() 转交；
     · 聚合/合并/分类等纯逻辑仍在 lib/usage.js（有单测）。
   =========================================================================== */

const fs = require('fs');
const path = require('path');
const usageDomain = require('./usage.js');

const USAGE_SAMPLE_MS = 5000;    // 采样间隔
const USAGE_FLUSH_MS = 30000;    // 落盘间隔
const USAGE_KEEP_DAYS = 90;      // 明细保留天数

/**
 * @param {object} deps
 * @param {() => string} deps.storePath        usage-data.json 的绝对路径
 * @param {object} deps.ps                     lib/powershell.js 实例（spawn/诊断）
 * @param {object} deps.powerMonitor           electron.powerMonitor（取系统空闲时间）
 * @param {() => object} deps.ttSettings       归一化后的时间统计设置
 * @param {(d?: Date) => string} deps.dateKey  'YYYY-MM-DD'
 * @param {() => object} deps.readStoreData    读主数据（汇总时取 pomoDone）
 * @param {(where: string, e: unknown) => void} [deps.logE]
 */
function createUsageTracker(deps) {
  const o = deps || {};
  const storePath = o.storePath;
  const ps = o.ps;
  const powerMonitor = o.powerMonitor;
  const ttSettings = o.ttSettings;
  const dateKey = o.dateKey;
  const readStoreData = o.readStoreData;
  const logE = o.logE || (() => {});

  let usageData = { days: {} };
  let usageLoaded = false;
  let usageTimer = null;
  let usageFlushTimer = null;
  let usageHelper = null;         // PowerShell 辅助子进程
  let usageHelperBuf = '';        // stdout 行缓冲
  let usageHelperLastOut = 0;     // 看门狗：最后收到输出的时间
  let usageHelperStartedAt = 0;   // 看门狗宽限：刚启动时给足 Add-Type 编译时间
  let usageLatest = null;         // 辅助进程最新一次前台采样 { exe, app, title }
  let usageCurrent = null;        // 当前归因对象（上一次 tick 时的前台采样）
  let usageLastTick = 0;
  let usagePaused = false;        // 锁屏期间暂停

  function loadUsageData() {
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        usageData = { days: parsed.days };
      } else {
        usageData = { days: {} };
      }
    } catch (e) {
      usageData = { days: {} };
    }
    usageLoaded = true;
  }

  function saveUsageData() {
    try {
      // 清理 90 天前的数据
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - USAGE_KEEP_DAYS);
      const cutKey = dateKey(cutoff);
      for (const k of Object.keys(usageData.days)) {
        if (k < cutKey) delete usageData.days[k];
      }
      fs.mkdirSync(path.dirname(storePath()), { recursive: true });
      const tmp = storePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(usageData), 'utf8');
      fs.renameSync(tmp, storePath());
    } catch (e) { /* ignore */ }
  }

  function getUsageDay(dk) { return usageDomain.ensureDay(usageData, dk); }

  // 分类：本应用自身 → 「桌面工作台」；否则按规则顺序匹配（实现见 lib/usage.js）。
  // 分类在汇总时计算，规则修改后对历史数据即时生效。
  function usageCategoryOf(exeKey, displayName) {
    return usageDomain.categoryOf(exeKey, displayName, ttSettings().rules);
  }

  function addUsageSeconds(sample, seconds) {
    try {
      // 长尾合并等细节在 lib/usage.js；标题是否落盘由设置决定
      usageDomain.addSeconds(usageData, dateKey(), sample, seconds, ttSettings().recordTitles);
    } catch (e) { logE('usage.addSeconds', e); }
  }

  function startUsageHelper() {
    if (process.platform !== 'win32' || usageHelper) return;
    // PowerShell 不可用（被策略禁用/未探测完成）时显式降级，并把原因暴露给界面，
    // 而不是让采样进程反复拉起失败、用户只看到「没有数据」。
    if (!ps.isAvailable()) {
      ps.noteFeature('usage-helper', false, ps.isChecked()
        ? 'PowerShell 不可用（' + (ps.diagnostics().reason || '未知原因') + '），时间统计无法采样'
        : '正在检测 PowerShell 环境…');
      return;
    }
    if (!ps.diagnostics().canAddType) {
      ps.noteFeature('usage-helper', false, '当前 PowerShell 语言模式为 ' + ps.diagnostics().languageMode + '，不允许 Add-Type，无法读取前台窗口');
      return;
    }
    try {
      usageHelperBuf = '';
      // 说明：实测 -Command -（stdin 传脚本）对本脚本会静默卡住，故改用 -EncodedCommand
      // （UTF-16LE base64，脚本约 2KB，远小于命令行长度限制），效果等同且无临时文件
      usageHelper = ps.spawn(['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
        Buffer.from(usageDomain.USAGE_PS_SCRIPT, 'utf16le').toString('base64')]);
      if (!usageHelper) return;
      usageHelperLastOut = Date.now();
      usageHelperStartedAt = Date.now();
      usageHelper.stdout.on('data', (chunk) => {
        usageHelperLastOut = Date.now();
        usageHelperBuf += chunk.toString('utf8');
        let idx;
        while ((idx = usageHelperBuf.indexOf('\n')) !== -1) {
          const line = usageHelperBuf.slice(0, idx).trim();
          usageHelperBuf = usageHelperBuf.slice(idx + 1);
          if (!line) continue;
          try {
            const json = JSON.parse(line);
            if (json && typeof json.exe === 'string') {
              usageLatest = {
                exe: String(json.exe || ''),
                app: String(json.app || '') || String(json.exe || ''),
                title: String(json.title || '')
              };
              ps.noteFeature('usage-helper', true);
            }
          } catch (e) { /* 忽略无法解析的行 */ }
        }
      });
      usageHelper.stderr.on('data', () => { /* 忽略 */ });
      usageHelper.on('error', (err) => {
        ps.noteFeature('usage-helper', false, '采样进程启动失败：' + String((err && err.message) || err));
      });
      usageHelper.on('exit', () => {
        usageHelper = null;
        // 异常退出（含被看门狗击杀）后由 reconcileUsage 自动拉起
        if (usageTrackingEnabled()) setTimeout(() => { try { reconcileUsage(); } catch (e) { /* ignore */ } }, 1000);
      });
    } catch (e) {
      usageHelper = null;
      ps.noteFeature('usage-helper', false, String((e && e.message) || e));
    }
  }

  function usageTrackingEnabled() {
    return process.platform === 'win32' && ttSettings().enabled;
  }

  // 按开关启停采集与落盘定时器；每次 tick 与设置保存后都会调用，保证自愈
  function reconcileUsage() {
    if (!usageLoaded) loadUsageData();
    if (usageTrackingEnabled()) {
      if (!usageTimer) {
        usageLastTick = Date.now();
        usageTimer = setInterval(usageTick, USAGE_SAMPLE_MS);
      }
      if (!usageFlushTimer) usageFlushTimer = setInterval(saveUsageData, USAGE_FLUSH_MS);
      if (!usageHelper) startUsageHelper();
    } else {
      if (usageTimer || usageFlushTimer) saveUsageData(); // 停止前把内存里的增量落盘
      if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
      if (usageFlushTimer) { clearInterval(usageFlushTimer); usageFlushTimer = null; }
      if (usageHelper) { try { usageHelper.kill(); } catch (e) { /* ignore */ } usageHelper = null; }
      usageLatest = null;
      usageCurrent = null;
    }
  }

  function usageTick() {
    try {
      const now = Date.now();
      const cfg = ttSettings();
      // 看门狗：辅助进程未启动则拉起；运行中 10 秒无输出则重启（启动后 15 秒宽限，等 Add-Type 编译）
      if (cfg.enabled && process.platform === 'win32') {
        if (!usageHelper) startUsageHelper();
        else if (now - usageHelperStartedAt > 15000 && now - usageHelperLastOut > 10000) {
          try { usageHelper.kill(); } catch (e) { /* ignore */ }
          usageHelper = null;
          startUsageHelper();
        }
      }
      if (!cfg.enabled || usagePaused) {
        usageLastTick = now;
        usageCurrent = null;
        return;
      }
      let idleSec = 0;
      try { idleSec = powerMonitor.getSystemIdleTime(); } catch (e) { idleSec = 0; }
      const gap = usageLastTick ? Math.max(0, now - usageLastTick) : 0;
      if (idleSec >= cfg.idleSeconds) {
        // 空闲期间不累计；把归因对象推进到当前前台，避免唤醒后错记
        usageLastTick = now;
        usageCurrent = usageLatest;
        return;
      }
      // 两条采样之间的真实间隔计给前一台应用；单次上限 2×采样间隔（防休眠后错记）
      if (usageCurrent && gap >= 1000 && gap <= 2 * USAGE_SAMPLE_MS) {
        addUsageSeconds(usageCurrent, Math.round(gap / 1000));
      }
      usageCurrent = usageLatest;
      usageLastTick = now;
    } catch (e) { logE('usage.tick', e); }
  }

  function emptyUsageSummary() {
    return usageDomain.emptySummary(process.platform === 'win32');
  }

  /**
   * 汇总最近 N 天的时间统计（设置页/小组件展示）。
   * @param {number} days  统计天数
   * @returns {{supported: boolean, enabled: boolean, dayCount: number,
   *            today: {total: number, categories: Array, topApps: Array}, daily: Array}}
   *    形状由 lib/usage.js 的 emptySummary/summarize 定义
   */
  function usageSummary(days) {
    if (!usageLoaded) loadUsageData();
    const cfg = ttSettings();
    if (process.platform !== 'win32') {
      const out = usageDomain.emptySummary(false);
      out.enabled = cfg.enabled;
      return out;
    }
    const today = dateKey();

    // 近 days 天（含今天）逐日聚合
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dayKeys.push(dateKey(d));
    }

    let pomoDone = {};
    try { pomoDone = readStoreData().pomoDone || {}; } catch (e) { pomoDone = {}; }

    // 聚合逻辑在 lib/usage.js（纯函数，有单测）
    return usageDomain.summarize(usageData, {
      dayKeys: dayKeys,
      today: today,
      enabled: cfg.enabled,
      recordTitles: cfg.recordTitles,
      pomoDone: pomoDone,
      categoryOf: usageCategoryOf
    });
  }

  return {
    load: loadUsageData,
    save: saveUsageData,
    reconcile: reconcileUsage,
    summary: usageSummary,
    emptySummary: emptyUsageSummary,
    /** 清空全部明细（usage:clear IPC） */
    clear() { usageData = { days: {} }; saveUsageData(); },
    /** 退出前调用：停掉采样进程并落盘增量 */
    dispose() {
      try { if (usageHelper) usageHelper.kill(); } catch (e) { /* ignore */ }
      usageHelper = null;
      try { saveUsageData(); } catch (e) { /* ignore */ }
    },
    /** 锁屏暂停（true）；解锁恢复并把归因时钟复位（false） */
    setPaused(p) {
      usagePaused = !!p;
      if (!usagePaused) usageLastTick = Date.now();
    },
    isEnabled: usageTrackingEnabled,
    isSampling: () => !!usageHelper,
    isPaused: () => usagePaused
  };
}

module.exports = { createUsageTracker, USAGE_SAMPLE_MS, USAGE_FLUSH_MS, USAGE_KEEP_DAYS };
