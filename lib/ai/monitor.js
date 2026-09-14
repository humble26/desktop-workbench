'use strict';

/* ===========================================================================
   AI 平台余额监测：轮询、消耗推算、历史与预测
   ---------------------------------------------------------------------------
   核心思路（也是本功能唯一诚实可行的做法）：
     各平台只公开「当前余额」，没有公开的 token 用量接口。于是用**余额差值**
     推算消耗 —— 两次采样之间余额下降了多少，就是这段时间花掉的钱：

       消耗(元) = 上一次余额 − 这一次余额        （余额上升 = 充值，不计为消耗）

     这套算法与平台无关，因此 DeepSeek、OpenRouter、Moonshot、硅基流动乃至自定义
     平台都能用。再拿「消耗金额 ÷ 参考单价」估个 token 量级 —— 但界面上一律标明
     是**估算**，因为不同模型的输入/输出单价差好几倍，缓存命中还另有折扣。

   跨天补偿：应用可能好几天没开着。若上一份采样与本次相隔 N 天，把这段消耗**均摊**
   到相隔的那几天，而不是全记在回来的那一天 —— 否则重新打开应用的那天会莫名其妙
   出现一个极高的柱状图。

   数据独立存放 <userData>/ai-usage.json（与 usage-data.json 同类的自有数据源），
   不参与导出 / 备份。
   =========================================================================== */

const fs = require('fs');
const path = require('path');
const providers = require('./providers.js');

const AI_HISTORY_VERSION = 1;
const SPEND_KEEP_DAYS = 400;      // 每日消耗保留天数
const SAMPLE_KEEP_DAYS = 60;      // 余额原始采样保留天数
const SAMPLE_KEEP_MAX = 4000;     // 原始采样条数上限
const TREND_DAYS = 7;             // 燃烧速率与预估的观察窗口

/**
 * @param {object} deps
 * @param {{getJson: Function}} deps.httpGet         lib/ai/http.js 实例
 * @param {object} deps.keyStore                     lib/ai/keystore.js 实例
 * @param {() => string} deps.storePath              ai-usage.json 的绝对路径
 * @param {() => object} deps.settings               归一化后的 aiMonitor 设置
 * @param {(d?: Date) => string} deps.dateKey        'YYYY-MM-DD'
 * @param {() => number} [deps.now]                  时间源（测试注入）
 * @param {(where: string, e: unknown) => void} [deps.logE]
 * @param {(summary: object) => void} [deps.onUpdate] 每次刷新完成后的回调
 */
function createAiMonitor(deps) {
  const o = deps || {};
  const httpGet = o.httpGet;
  const keyStore = o.keyStore;
  const storePath = o.storePath;
  const settings = o.settings;
  const dateKey = o.dateKey;
  const now = o.now || (() => Date.now());
  const logE = o.logE || (() => {});
  const onUpdate = o.onUpdate || (() => {});

  let data = emptyData();
  let loaded = false;
  let timer = null;
  let kickTimer = null;
  let currentIntervalMs = 0;
  let refreshing = false;
  let lastRefreshAt = 0;
  let lastRefreshError = null;

  function emptyData() { return { version: AI_HISTORY_VERSION, providers: {} }; }

  function load() {
    if (loaded) return data;
    try {
      const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.providers && typeof parsed.providers === 'object') {
        data = { version: AI_HISTORY_VERSION, providers: parsed.providers };
      } else {
        data = emptyData();
      }
    } catch (e) {
      data = emptyData();
    }
    loaded = true;
    return data;
  }

  function save() {
    try {
      prune();
      fs.mkdirSync(path.dirname(storePath()), { recursive: true });
      const tmp = storePath() + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
      fs.renameSync(tmp, storePath());
      return true;
    } catch (e) {
      logE('ai.save', e);
      return false;
    }
  }

  function dayKeyMinusDays(n) {
    const d = new Date(now());
    d.setDate(d.getDate() - n);
    return dateKey(d);
  }

  function prune() {
    const spendCut = dayKeyMinusDays(SPEND_KEEP_DAYS);
    const sampleCut = now() - SAMPLE_KEEP_DAYS * 86400000;
    for (const id of Object.keys(data.providers)) {
      const p = data.providers[id];
      if (!p || typeof p !== 'object') { delete data.providers[id]; continue; }
      if (p.spend && typeof p.spend === 'object') {
        for (const k of Object.keys(p.spend)) if (k < spendCut) delete p.spend[k];
      }
      if (Array.isArray(p.samples)) {
        p.samples = p.samples.filter(s => s && Number(s.t) >= sampleCut);
        if (p.samples.length > SAMPLE_KEEP_MAX) p.samples = p.samples.slice(-SAMPLE_KEEP_MAX);
      }
    }
  }

  function providerRec(id) {
    const pid = String(id || '').toLowerCase();
    let p = data.providers[pid];
    if (!p || typeof p !== 'object') {
      p = { currency: '', last: null, spend: {}, samples: [] };
      data.providers[pid] = p;
    }
    if (!p.spend || typeof p.spend !== 'object') p.spend = {};
    if (!Array.isArray(p.samples)) p.samples = [];
    return p;
  }

  /* 把一段消耗摊到日期上。
     规则：这段消耗发生在**两次采样之间**，所以只摊到「上次采样日的次日 ~ 本次采样日」
     这一段；同一天内的两次采样（区间为空）则全部记在当天。
     为什么不把上次采样那一天也算进去：采样时刻之后才产生的消耗记到采样当天，
     会把「昨天关掉应用、今天打开」的消耗挪到昨天，反而失真。
     这是估算里唯一带主观判断的地方，所以单独成函数、单独测。 */
  function spreadSpend(rec, fromMs, toMs, amount) {
    if (!(amount > 0)) return;
    const fromDay = dateKey(new Date(fromMs));
    const toDay = dateKey(new Date(toMs));
    const days = [];
    if (fromDay < toDay) {
      const cur = new Date(fromMs);
      cur.setHours(0, 0, 0, 0);
      cur.setDate(cur.getDate() + 1);                   // 从上次采样日的次日开始
      const end = new Date(toMs);
      end.setHours(0, 0, 0, 0);
      let guard = 0;
      while (cur.getTime() <= end.getTime() && guard++ < SPEND_KEEP_DAYS) {
        days.push(dateKey(cur));
        cur.setDate(cur.getDate() + 1);
      }
    }
    if (!days.length) days.push(toDay);
    const per = amount / days.length;
    for (const d of days) rec.spend[d] = round6((rec.spend[d] || 0) + per);
  }

  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  /* 记录一次成功采样：更新余额、扣除出来的消耗、追加采样点。
     余额上升视为充值，不计为负消耗（否则充值当天会把消耗算成负数）。 */
  function recordSuccess(providerId, normalized, atMs) {
    const rec = providerRec(providerId);
    const prev = rec.last;
    rec.currency = normalized.currency || rec.currency || '';
    if (prev && prev.ok === true
      && Number.isFinite(prev.balance) && Number.isFinite(normalized.balance)
      && prev.currency === rec.currency) {
      const delta = prev.balance - normalized.balance;
      if (delta > 0) spreadSpend(rec, Number(prev.t) || atMs, atMs, delta);
    }
    rec.last = {
      ok: true,
      t: atMs,
      balance: normalized.balance,
      granted: normalized.granted,
      toppedUp: normalized.toppedUp,
      limit: normalized.limit,
      used: normalized.used,
      available: normalized.available,
      note: normalized.note || '',
      currency: rec.currency,
      error: ''
    };
    rec.samples.push({ t: atMs, b: normalized.balance });
    if (rec.samples.length > SAMPLE_KEEP_MAX) rec.samples = rec.samples.slice(-SAMPLE_KEEP_MAX);
    return rec.last;
  }

  function recordFailure(providerId, message, atMs) {
    const rec = providerRec(providerId);
    rec.last = Object.assign({}, rec.last || {}, {
      ok: false,
      t: atMs,
      error: String(message || '未知错误')
    });
    return rec.last;
  }

  /* 一次平台刷新：发请求 → 归一化 → 记账。
     任何一步失败都只影响这一个平台，绝不冒泡打断其他平台。 */
  async function refreshProvider(providerId) {
    const def = providers.providerById(providerId);
    const at = now();
    if (!def) return { ok: false, error: '未知平台：' + providerId };
    const cfg = (settings().providers || {})[providerId] || {};
    const key = keyStore.get(providerId);
    if (!key) {
      return recordFailure(providerId, '还没有填写这个平台的密钥', at);
    }
    const probes = providers.buildProbes(providerId, cfg);
    if (!probes) {
      return recordFailure(providerId, def.custom
        ? '自定义平台还没填合法的接口地址（必须是 https，或本机 http）'
        : '平台请求地址不可用', at);
    }
    const auth = providers.authHeader(providerId, key);
    const results = [];
    for (const probe of probes) {
      const res = await httpGet.getJson(probe.url, { headers: { [auth.name]: auth.value } });
      results.push(res);
      // 主探针失败就没必要再问补充接口了
      if (!res.ok && !probe.optional) break;
      if (!res.ok && probe.optional) continue;
    }
    let normalized;
    try {
      normalized = def.normalize(results, cfg);
    } catch (e) {
      normalized = { ok: false, error: '解析响应时出错：' + String((e && e.message) || e) };
    }
    if (!normalized || normalized.ok !== true) {
      return recordFailure(providerId, (normalized && normalized.error) || '未知错误', at);
    }
    return recordSuccess(providerId, normalized, at);
  }

  /**
   * 刷新（全部或指定平台）。
   * 无论走哪条路径，都只刷新**用户开了开关的平台** —— 关掉的平台不该被任何
   * 路径偷偷请求（包括「刚保存完密钥顺手验证」这种看着无害的路径）。
   * @param {string[]} [ids] 省略则刷新全部「已启用且有密钥」的平台
   * @returns {Promise<{ok:boolean, refreshed:number, skipped?:number, summary:object}>}
   */
  async function refresh(ids) {
    load();
    if (refreshing) return { ok: false, refreshed: 0, reason: 'busy', summary: summary() };
    refreshing = true;
    try {
      const s = settings();
      const explicit = Array.isArray(ids) && ids.length
        ? ids.map(x => String(x).toLowerCase()).filter(id => providers.providerById(id))
        : null;
      const list = explicit
        ? explicit.filter(isProviderEnabled)
        : enabledIds(s);
      const skipped = explicit ? explicit.length - list.length : 0;
      for (const id of list) {
        try { await refreshProvider(id); } catch (e) { logE('ai.refresh.' + id, e); recordFailure(id, String((e && e.message) || e), now()); }
      }
      save();
      lastRefreshAt = now();
      lastRefreshError = null;
      const sum = summary();
      try { onUpdate(sum); } catch (e) { logE('ai.onUpdate', e); }
      return { ok: true, refreshed: list.length, skipped: skipped, summary: sum };
    } finally {
      refreshing = false;
    }
  }

  // 平台自身的开关（与总开关分开：总开关在 main.js 的 IPC 入口拦）
  function isProviderEnabled(id) {
    const cfg = (settings().providers || {})[String(id).toLowerCase()] || {};
    return cfg.enabled === true;
  }

  // 「该刷新哪些」：用户开了这个平台，并且确实填了密钥
  function enabledIds(s) {
    const cfg = (s || settings()).providers || {};
    const out = [];
    for (const p of providers.PROVIDERS) {
      const c = cfg[p.id] || {};
      if (c.enabled === true && keyStore.has(p.id)) out.push(p.id);
    }
    return out;
  }

  /* -------------------------------------------------------------------------
     下面都是「读」：把原始数据算成界面要看的形状。全是纯计算，可单独测。
     ------------------------------------------------------------------------- */

  function priceOf(providerId) {
    const cfg = (settings().providers || {})[providerId] || {};
    const def = providers.providerById(providerId);
    const v = Number(cfg.price);
    if (Number.isFinite(v) && v >= 0) return v;
    return def ? Number(def.price) || 0 : 0;
  }

  // 消耗汇总：今天 / 昨天 / 近 7 天 / 近 14 天 / 燃烧速率 / 预计可用天数 / token 估算
  function spendStats(providerId, rec) {
    const today = dateKey(new Date(now()));
    const spend = (rec && rec.spend) || {};
    const daySum = (n) => spend[dayKeyMinusDays(n)] || 0;
    const rangeSum = (from, to) => {
      let sum = 0;
      for (let i = from; i <= to; i++) sum += daySum(i);
      return sum;
    };
    const todaySpend = daySum(0);
    const yesterdaySpend = daySum(1);
    const d7 = rangeSum(0, 6);
    const d14 = rangeSum(0, 13);

    // 燃烧速率：分母取「有记录的天数」（最多 7 天），而不是固定 7 ——
    // 昨天才开始记录的话，除以 7 会把速率低估成实际的 1/7。
    const firstDay = firstSpendDay(rec);
    let observedDays = TREND_DAYS;
    if (firstDay) {
      const diff = Math.round((new Date(today + 'T00:00:00').getTime() - new Date(firstDay + 'T00:00:00').getTime()) / 86400000) + 1;
      observedDays = Math.max(1, Math.min(TREND_DAYS, diff));
    }
    const avgPerDay = observedDays > 0 ? d7 / observedDays : 0;

    const balance = rec && rec.last && rec.last.ok === true ? rec.last.balance : null;
    const daysLeft = (avgPerDay > 0 && Number.isFinite(balance) && balance > 0)
      ? Math.floor(balance / avgPerDay) : null;

    const price = priceOf(providerId);
    const trackedSpend = Object.keys(spend).reduce((a, k) => a + (spend[k] || 0), 0);
    return {
      today: round6(todaySpend),
      yesterday: round6(yesterdaySpend),
      last7: round6(d7),
      last14: round6(d14),
      avgPerDay: round6(avgPerDay),
      observedDays: observedDays,
      daysLeft: daysLeft,
      tracked: round6(trackedSpend),
      price: price,
      tokensToday: providers.estimateTokens(todaySpend, price),
      tokensLast7: providers.estimateTokens(d7, price),
      tokensTracked: providers.estimateTokens(trackedSpend, price)
    };
  }

  // 最早一条有消耗记录的日期（没有则 null）
  function firstSpendDay(rec) {
    const spend = (rec && rec.spend) || {};
    let min = null;
    for (const k of Object.keys(spend)) { if (!min || k < min) min = k; }
    // 有记录不等于有消耗，还要看采样起点，两者取早
    const samples = (rec && rec.samples) || [];
    if (samples.length) {
      const firstSampleDay = dateKey(new Date(samples[0].t));
      if (!min || firstSampleDay < min) min = firstSampleDay;
    }
    return min;
  }

  function providerState(id) {
    const def = providers.providerById(id);
    const cfg = (settings().providers || {})[id] || {};
    const rec = (load().providers || {})[id] || null;
    const keyInfo = keyStore.list()[id] || null;
    const last = rec && rec.last ? rec.last : null;
    return {
      id: id,
      name: def ? def.name : id,
      custom: !!(def && def.custom),
      currency: (last && last.currency) || (def ? def.currency : 'CNY'),
      enabled: cfg.enabled === true,
      hasKey: !!keyInfo,
      masked: keyInfo ? keyInfo.masked : '',
      keyReadable: keyInfo ? keyInfo.readable === true : false,
      keyAt: keyInfo ? keyInfo.at : 0,
      ok: !!(last && last.ok === true),
      at: last ? Number(last.t) || 0 : 0,
      balance: last ? last.balance : null,
      granted: last ? last.granted : null,
      toppedUp: last ? last.toppedUp : null,
      limit: last ? last.limit : null,
      used: last ? last.used : null,
      available: last ? last.available : null,
      note: (last && last.note) || '',
      error: (last && last.error) || '',
      price: priceOf(id),
      spend: spendStats(id, rec),
      consoleUrl: def ? def.consoleUrl : '',
      keyUrl: def ? def.keyUrl : '',
      keyHint: def ? def.keyHint : '',
      priceNote: def ? def.priceNote : '',
      // 自定义平台的配置要回显给设置页（不含密钥）
      url: def && def.custom ? String(cfg.url || '') : '',
      balancePath: def && def.custom ? String(cfg.balancePath || '') : '',
      grantedPath: def && def.custom ? String(cfg.grantedPath || '') : '',
      usedPath: def && def.custom ? String(cfg.usedPath || '') : ''
    };
  }

  /** 界面用的整体快照：只有掩码与统计，没有任何明文密钥。 */
  function summary() {
    load();
    const s = settings();
    const list = providers.PROVIDERS.map(p => providerState(p.id));
    return {
      supported: true,
      enabled: s.enabled === true,
      intervalMinutes: s.intervalMinutes,
      lowBalance: s.lowBalance,
      keyStorage: keyStore.backendName(),
      keyStorageAvailable: keyStore.encryptionAvailable(),
      refreshing: refreshing,
      lastRefreshAt: lastRefreshAt,
      lastRefreshError: lastRefreshError,
      providers: list
    };
  }

  /** 某个平台的每日消耗序列（给柱状图用，最近 N 天，缺的天补 0） */
  function history(id, days) {
    load();
    const n = Math.max(1, Math.min(SPEND_KEEP_DAYS, parseInt(days, 10) || 14));
    const rec = (load().providers || {})[String(id || '').toLowerCase()] || null;
    const spend = (rec && rec.spend) || {};
    const out = [];
    for (let i = n - 1; i >= 0; i--) {
      const k = dayKeyMinusDays(i);
      out.push({ date: k, amount: round6(spend[k] || 0) });
    }
    return {
      provider: String(id || ''),
      currency: (rec && rec.currency) || '',
      price: priceOf(id),
      days: out
    };
  }

  /** 低于阈值需要提醒的平台（main.js 刷新后据此发系统通知） */
  function lowBalanceHits() {
    const s = settings();
    const threshold = Number(s.lowBalance);
    if (!(threshold > 0)) return [];
    const out = [];
    for (const st of summary().providers) {
      if (!st.enabled || !st.ok) continue;
      if (Number.isFinite(st.balance) && st.balance < threshold) {
        out.push({ id: st.id, name: st.name, balance: st.balance, currency: st.currency });
      }
    }
    return out;
  }

  /* -------------------------------------------------------------------------
     定时轮询：按设置启停。
     与 usage-tracker 不同，这里的 reconcile 会被**每一次数据提交**调用
     （main.js 在 store:commit 后调它，好让开关改动立即生效），而每一次调用都
     可能是一次不必要的网络请求。所以有两个必须守住的点：

       1. 间隔没变就不要重建定时器 —— 否则用户频繁保存设置（切主题、加待办）
          会把定时器一次次推后，周期刷新可能永远轮不到
       2. 「打开后立刻拉一次」只在**刚打开**或**距上次刷新超过一个最短窗口**时才做 ——
          否则每保存一次设置就打一次平台接口，纯属骚扰

     返回值把这两个决定暴露出来，供单测断言（纯逻辑，不依赖真实定时器）。
     ------------------------------------------------------------------------- */
  const KICK_MIN_GAP_MS = 60000;      // 两次「立即刷新」之间的最短间隔
  // 「打开后补一次」的延迟；可注入是为了让单测不必真的等 1.5 秒
  const kickDelayMs = Number(o.kickDelayMs) > 0 ? Number(o.kickDelayMs) : 1500;

  function desiredIntervalMs() {
    const m = Number(settings().intervalMinutes);
    const minutes = Number.isFinite(m) && m >= 5 ? Math.min(m, 24 * 60) : 30;
    return minutes * 60000;
  }

  function clearKick() {
    if (kickTimer) { clearTimeout(kickTimer); kickTimer = null; }
  }

  /**
   * 让轮询状态与当前设置对齐（幂等）。
   * @returns {{enabled:boolean, intervalChanged:boolean, kicked:boolean}}
   */
  function reconcile() {
    load();
    const on = settings().enabled === true;
    const out = { enabled: on, intervalChanged: false, kicked: false };
    if (!on) {
      if (timer) { clearInterval(timer); timer = null; currentIntervalMs = 0; out.intervalChanged = true; }
      clearKick();
      return out;
    }
    const want = desiredIntervalMs();
    if (!timer || want !== currentIntervalMs) {
      if (timer) clearInterval(timer);
      currentIntervalMs = want;
      out.intervalChanged = true;
      timer = setInterval(() => {
        // 定时轮询失败不打扰用户（界面会显示上次错误）；手动刷新才提示
        refresh().catch(e => logE('ai.timer', e));
      }, want);
    }
    // 打开功能后立刻来一次，让界面马上有数据；但别每次都来
    const sinceLast = lastRefreshAt ? (now() - lastRefreshAt) : Infinity;
    if ((out.intervalChanged || sinceLast > KICK_MIN_GAP_MS) && !kickTimer && !refreshing) {
      out.kicked = true;
      kickTimer = setTimeout(() => {
        kickTimer = null;
        // 到点了再判一次新鲜度：这 1.5 秒里用户很可能已经手动刷过
        // （渲染层的「打开开关」就是 save() 之后紧接着调用 aiRefresh），
        // 调度时的判断已经过期，不再复核就会白白多打一次平台接口
        if (lastRefreshAt && now() - lastRefreshAt < KICK_MIN_GAP_MS) return;
        refresh().catch(e => logE('ai.timer', e));
      }, kickDelayMs);
    }
    return out;
  }

  return {
    load,
    save,
    refresh,
    summary,
    history,
    lowBalanceHits,
    reconcile,
    isRefreshing: () => refreshing,
    /** 清空全部平台的历史（保留密钥与设置） */
    clear() { data = emptyData(); save(); return { ok: true }; },
    /** 清空单个平台的历史 */
    clearProvider(id) {
      const pid = String(id || '').toLowerCase();
      delete load().providers[pid];
      save();
      return { ok: true };
    },
    dispose() {
      if (timer) { clearInterval(timer); timer = null; }
      clearKick();                       // 别让退出后还有一次刷新在飞
      currentIntervalMs = 0;
    },
    lastRefreshError: () => lastRefreshError
  };
}

module.exports = {
  createAiMonitor,
  AI_HISTORY_VERSION,
  SPEND_KEEP_DAYS,
  SAMPLE_KEEP_DAYS,
  TREND_DAYS
};
