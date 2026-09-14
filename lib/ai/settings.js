'use strict';

/* ===========================================================================
   AI 余额监测的设置归一化（纯函数，无依赖，可单测）
   ---------------------------------------------------------------------------
   为什么单独一个模块：这些默认值被三处用到 ——
     · lib/defaults.js   全新数据文件的初始结构
     · lib/migrate.js    启动时把老数据补成合法结构
     · main.js           运行期读取设置
   三处各写一份归一化必然走岔（时间统计的分批归一化就吃过这个亏：
   默认值与迁移逻辑不一致，导致每次启动都被当成一次结构升级）。
   因此这里只留一份实现，migrate 与 defaults 共用。

   两条约定：
     1. 幂等：normalize(normalize(x)) 与 normalize(x) 完全相同 ——
        test/migrate.test.js 会用「全新默认数据不得判定为发生改动」守住这一点。
     2. 不删未知字段：只修正认识的字段，其余原样保留（与项目既有的迁移约定一致）。
   =========================================================================== */

const providers = require('./providers.js');

const INTERVAL_MIN_MINUTES = 5;
const INTERVAL_MAX_MINUTES = 24 * 60;
const PRICE_MAX = 1e6;

function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function boolOf(v, dflt) {
  if (v === true || v === false) return v;
  return dflt;
}

function numberIn(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  if (n < min || n > max) return dflt;
  return n;
}

function str(v, dflt) {
  return typeof v === 'string' ? v : (dflt || '');
}

/** 每个平台的默认值（全新安装时的样子） */
function defaultProviderConfig(id) {
  const def = providers.providerById(id);
  const base = {
    enabled: true,
    price: def ? Number(def.price) || 0 : 0
  };
  if (def && def.custom) {
    base.enabled = false;              // 自定义平台没有默认地址，默认关着
    base.url = '';
    base.balancePath = '';
    base.grantedPath = '';
    base.usedPath = '';
    base.currency = 'CNY';
    base.name = '';
  }
  return base;
}

function defaultAiSettings() {
  const out = {
    enabled: false,
    intervalMinutes: 30,
    lowBalance: 0,
    providers: {}
  };
  for (const id of providers.PROVIDER_IDS) out.providers[id] = defaultProviderConfig(id);
  return out;
}

/** 归一化单个平台的配置。保留未知字段。 */
function normalizeProviderConfig(id, raw) {
  const d = defaultProviderConfig(id);
  const src = isObj(raw) ? raw : {};
  const out = Object.assign({}, src);        // 先把未知字段原样留下
  out.enabled = boolOf(src.enabled, d.enabled);
  out.price = numberIn(src.price, 0, PRICE_MAX, d.price);
  if (d.name !== undefined) {
    out.name = str(src.name, '').slice(0, 40);
    out.currency = providers.CURRENCIES.indexOf(String(src.currency || '').toUpperCase()) !== -1
      ? String(src.currency).toUpperCase() : 'CNY';
    // 地址只接受可接受的协议；不合法就清空（宁可让界面提示「还没填」，
    // 也不要留一个会被 http.js 拒绝的字符串在设置里）
    const url = str(src.url, '').trim();
    out.url = (!url || providers.isAcceptableUrl(url)) ? url : '';
    out.balancePath = str(src.balancePath, '').slice(0, 120);
    out.grantedPath = str(src.grantedPath, '').slice(0, 120);
    out.usedPath = str(src.usedPath, '').slice(0, 120);
  }
  return out;
}

/**
 * 归一化整个 aiMonitor 设置块。幂等、保留未知字段。
 * @param {any} raw
 * @returns {object}
 */
function normalizeAiSettings(raw) {
  const d = defaultAiSettings();
  const src = isObj(raw) ? raw : {};
  const out = Object.assign({}, src);
  out.enabled = boolOf(src.enabled, d.enabled);
  out.intervalMinutes = numberIn(src.intervalMinutes, INTERVAL_MIN_MINUTES, INTERVAL_MAX_MINUTES, d.intervalMinutes);
  out.lowBalance = numberIn(src.lowBalance, 0, providers.AMOUNT_LIMIT, d.lowBalance);
  const srcProviders = isObj(src.providers) ? src.providers : {};
  const merged = {};
  for (const id of providers.PROVIDER_IDS) {
    merged[id] = normalizeProviderConfig(id, srcProviders[id]);
  }
  // 不认识的平台配置原样保留（例如用户从更高版本降级回来）
  for (const k of Object.keys(srcProviders)) {
    if (!merged[k]) merged[k] = srcProviders[k];
  }
  out.providers = merged;
  return out;
}

module.exports = {
  normalizeAiSettings,
  defaultAiSettings,
  defaultProviderConfig,
  INTERVAL_MIN_MINUTES,
  INTERVAL_MAX_MINUTES,
  PRICE_MAX
};
