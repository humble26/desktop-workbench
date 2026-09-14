'use strict';

/* ===========================================================================
   AI 平台余额监测：平台注册表与响应归一化
   ---------------------------------------------------------------------------
   纯函数模块：不做网络请求、不读写文件、不 require electron —— 因此可以被单测
   用「录下来的真实响应」直接跑。网络在 lib/ai/http.js，落盘在 lib/ai/monitor.js。

   安全上的两条硬约束（见 test/ai-providers.test.js）：

   1. 【密钥只去官方域名】内置平台（DeepSeek / OpenRouter / Moonshot / SiliconFlow）
      的请求地址**写死在本文件里**，不接受来自设置的覆盖。原因：设置是可以由渲染层
      提交的（见 lib/patchguard.js 的立场：渲染层即用户输入），若允许它改 baseUrl，
      一个被污染的渲染层就能把 API Key 转发到任意域名。
      需要走代理 / 中转站（one-api、new-api 等）时，请在「自定义平台」里单独填地址与
      该地址专属的密钥 —— 那是一个用户明确知道自己在给谁授权的动作。

   2. 【归一化必须容忍未知结构】平台随时可能改字段。所有取值都经过 parseAmount /
      getPath 这类安全读取，结构不符时返回 { ok:false, error } 而不是抛异常，
      界面会把原始响应片段显示出来供排查。
   =========================================================================== */

const AMOUNT_LIMIT = 1e12;        // 金额上限：脏数据/异常响应不应写出天文数字
const CURRENCIES = ['CNY', 'USD'];

/* 把响应里的金额字段读成有限数字。
   平台有的返回字符串（DeepSeek 的 "110.00"），有的返回数字（Moonshot 的 12.5），
   还有的带货币符号或千分位，因此统一清洗后再判定。 */
function parseAmount(v) {
  let n = null;
  if (typeof v === 'number') n = v;
  else if (typeof v === 'string') {
    const s = v.replace(/[,\s¥￥$]/g, '');
    if (!s) return null;
    n = Number(s);
  } else return null;
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) > AMOUNT_LIMIT) return null;
  return n;
}

// 按点号路径取值，支持 a.b[0].c 这种写法；任何一环缺失都返回 undefined
function getPath(obj, pathStr) {
  if (!pathStr || obj === null || obj === undefined) return undefined;
  const parts = String(pathStr).replace(/\[(\d+)\]/g, '.$1').split('.').filter(s => s !== '');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

// 从若干候选路径里取第一个能解析成金额的值
function pickAmount(obj, paths) {
  for (const p of paths) {
    const n = parseAmount(getPath(obj, p));
    if (n !== null) return n;
  }
  return null;
}

/* 密钥脱敏：只保留前 3 后 4，中间的星号数量固定。
   注意这是**给人看**的字符串，任何地方都不该把它还原成密钥。 */
function maskKey(key) {
  const s = String(key == null ? '' : key);
  if (!s) return '';
  if (s.length <= 8) return '****';
  return s.slice(0, 3) + '****' + s.slice(-4);
}

// 首尾空白与引号常来自用户复制粘贴，统一清掉
function cleanKey(key) {
  return String(key == null ? '' : key).replace(/^[\s"']+|[\s"']+$/g, '');
}

/* 由「消耗金额」估算 token 数。
   pricePerMillion 的单位是「每百万 token 的货币金额」。
   这只是量级参考：不同模型的输入/输出价格差好几倍，缓存命中另有折扣，
   所以界面上一律标注为「估算」，不冒充真实用量。 */
function estimateTokens(amount, pricePerMillion) {
  const a = Number(amount);
  const p = Number(pricePerMillion);
  if (!Number.isFinite(a) || a <= 0) return 0;
  if (!Number.isFinite(p) || p <= 0) return null;   // 未填单价 → 不估算
  return Math.round(a / p * 1e6);
}

/* 只允许 https；http 仅放行本机回环地址（自建中转常见于 localhost）。
   明文 http 会把密钥暴露在链路上，所以非本机一律拒绝。 */
function isAcceptableUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch (e) { return false; }
  if (u.protocol === 'https:') return true;
  if (u.protocol === 'http:') {
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]';
  }
  return false;
}

/* ---------------------------------------------------------------------------
   各平台的归一化函数
   入参 results：与 definition.probes 一一对应的取回结果
     { ok: boolean, status: number, json: any, error?: string }
   出参：统一形状（失败时 { ok:false, error }）
   ------------------------------------------------------------------------- */

// DeepSeek：GET /user/balance
// { is_available, balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
function normalizeDeepSeek(results, cfg) {
  const r = results[0];
  if (!r || !r.ok) return fail(r, 'DeepSeek');
  const j = r.json;
  if (!j || typeof j !== 'object') return { ok: false, error: '响应不是 JSON 对象' };
  const infos = Array.isArray(j.balance_infos) ? j.balance_infos.filter(x => x && typeof x === 'object') : [];
  if (!infos.length) return { ok: false, error: '响应里没有 balance_infos（接口结构可能已变更）' };
  const want = String((cfg && cfg.currency) || 'CNY').toUpperCase();
  const info = infos.find(x => String(x.currency || '').toUpperCase() === want) || infos[0];
  const balance = parseAmount(info.total_balance);
  if (balance === null) return { ok: false, error: '无法从 total_balance 解析出金额' };
  return {
    ok: true,
    currency: String(info.currency || want).toUpperCase(),
    balance: balance,
    granted: parseAmount(info.granted_balance),
    toppedUp: parseAmount(info.topped_up_balance),
    available: j.is_available === true ? true : (j.is_available === false ? false : null),
    limit: null,
    used: null,
    note: ''
  };
}

// OpenRouter：/api/v1/key 为主，/api/v1/credits 为补充
// key:     { data: { label, limit, limit_remaining, usage, is_free_tier } }
// credits: { data: { total_credits, total_usage } }
// 说明：按量付费账号的 key 往往 limit=null，此时余额要靠 credits 才算得出来，
// 所以第二个探针是「可选但重要」的。
function normalizeOpenRouter(results) {
  const keyRes = results[0];
  if (!keyRes || !keyRes.ok) return fail(keyRes, 'OpenRouter');
  const kd = getPath(keyRes.json, 'data');
  if (!kd || typeof kd !== 'object') return { ok: false, error: '响应里没有 data 字段' };
  const creditRes = results[1];
  const cd = (creditRes && creditRes.ok) ? getPath(creditRes.json, 'data') : null;

  const limit = parseAmount(kd.limit);
  const used = parseAmount(kd.usage);
  let balance = parseAmount(kd.limit_remaining);
  let totalCredits = null;
  if (cd && typeof cd === 'object') {
    totalCredits = parseAmount(cd.total_credits);
    const totalUsage = parseAmount(cd.total_usage);
    if (balance === null && totalCredits !== null && totalUsage !== null) balance = totalCredits - totalUsage;
  }
  if (balance === null && limit !== null && used !== null) balance = limit - used;
  if (balance === null) {
    return { ok: false, error: '既没有 limit_remaining，也没有 credits 记录（未充值或响应结构已变更）' };
  }
  const notes = [];
  if (kd.is_free_tier === true) notes.push('免费层');
  if (limit === null) notes.push('未设额度上限');
  return {
    ok: true,
    currency: 'USD',
    balance: balance,
    granted: null,
    toppedUp: totalCredits,
    available: balance > 0,
    limit: limit !== null ? limit : totalCredits,
    used: used,
    note: notes.join(' · ')
  };
}

// Moonshot / Kimi：GET /v1/users/me/balance
// { code, status, data: { available_balance, voucher_balance, cash_balance } }
function normalizeMoonshot(results) {
  const r = results[0];
  if (!r || !r.ok) return fail(r, 'Moonshot');
  const d = getPath(r.json, 'data') || r.json;
  const balance = pickAmount(d, ['available_balance', 'availableBalance', 'balance']);
  if (balance === null) return { ok: false, error: '无法从 available_balance 解析出金额' };
  return {
    ok: true,
    currency: 'CNY',
    balance: balance,
    granted: pickAmount(d, ['voucher_balance', 'voucherBalance']),
    toppedUp: pickAmount(d, ['cash_balance', 'cashBalance']),
    available: r.json && r.json.status === false ? false : null,
    limit: null,
    used: null,
    note: ''
  };
}

// 硅基流动：GET /v1/user/info
// { code, status, data: { balance, chargeBalance, totalBalance } }
function normalizeSiliconFlow(results) {
  const r = results[0];
  if (!r || !r.ok) return fail(r, 'SiliconFlow');
  const d = getPath(r.json, 'data') || r.json;
  const balance = pickAmount(d, ['totalBalance', 'total_balance', 'balance']);
  if (balance === null) return { ok: false, error: '无法从 totalBalance 解析出金额' };
  return {
    ok: true,
    currency: 'CNY',
    balance: balance,
    granted: null,
    toppedUp: pickAmount(d, ['chargeBalance', 'charge_balance']),
    available: r.json && r.json.status === false ? false : null,
    limit: null,
    used: null,
    note: ''
  };
}

/* 自定义平台：用户给地址 + 用 JSON 路径说明金额在响应的哪个位置。
   余额路径必填；其余可留空。currency 由用户选定。 */
function normalizeCustom(results, cfg) {
  const c = cfg || {};
  const r = results[0];
  if (!r || !r.ok) return fail(r, '自定义平台');
  const paths = String(c.balancePath || '').split('|').map(s => s.trim()).filter(Boolean);
  if (!paths.length) return { ok: false, error: '未配置「余额字段路径」（例如 data.balance）' };
  const balance = pickAmount(r.json, paths);
  if (balance === null) {
    return {
      ok: false,
      error: '按路径 ' + paths.join(' / ') + ' 没取到金额；实际响应的顶层字段：' + topKeys(r.json)
    };
  }
  const grantedPath = String(c.grantedPath || '').trim();
  const usedPath = String(c.usedPath || '').trim();
  return {
    ok: true,
    currency: CURRENCIES.indexOf(String(c.currency || '').toUpperCase()) !== -1
      ? String(c.currency).toUpperCase() : 'CNY',
    balance: balance,
    granted: grantedPath ? pickAmount(r.json, [grantedPath]) : null,
    toppedUp: null,
    available: null,
    limit: null,
    used: usedPath ? pickAmount(r.json, [usedPath]) : null,
    note: ''
  };
}

// 失败时的统一出口：把 HTTP 状态或网络错误变成一句人话。
// 平台自己给的原因（密钥错误 / 余额不足 / 参数不对）往往最有用，所以一律附上。
function fail(res, name) {
  if (!res) return { ok: false, error: name + '：没有收到响应' };
  if (res.error) return { ok: false, error: name + '：' + res.error };
  const code = res.status || 0;
  if (code === 401 || code === 403) return { ok: false, error: '密钥无效或没有权限（HTTP ' + code + '）' + hintOf(res) };
  if (code === 404) return { ok: false, error: '接口地址不存在（HTTP 404，平台可能已改版）' + hintOf(res) };
  if (code === 429) return { ok: false, error: '请求被限流（HTTP 429），稍后再试' + hintOf(res) };
  if (code) return { ok: false, error: 'HTTP ' + code + hintOf(res) };
  return { ok: false, error: name + '：请求失败' };
}

// 平台返回的错误正文往往直接说明原因（余额不足/密钥错误），带一小段出来很有用
function hintOf(res) {
  const body = res && res.json;
  if (body && typeof body === 'object') {
    const msg = body.error || body.message || body.msg;
    if (typeof msg === 'string' && msg) return '：' + msg.slice(0, 120);
    if (msg && typeof msg === 'object' && typeof msg.message === 'string') return '：' + msg.message.slice(0, 120);
  }
  return '';
}

function topKeys(json) {
  if (!json || typeof json !== 'object') return String(json).slice(0, 80);
  return Object.keys(json).slice(0, 8).join(', ') || '（空对象）';
}

/* ---------------------------------------------------------------------------
   平台注册表
   · url 写死在此，不接受设置覆盖（见文件头第 1 条）
   · price 是「参考单价/百万 token」，仅用于把消耗金额换算成 token 量级，
     用户可在设置里改；0 表示不估算
   ------------------------------------------------------------------------- */
const PROVIDERS = [
  {
    id: 'deepseek',
    name: 'DeepSeek',
    currency: 'CNY',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    consoleUrl: 'https://platform.deepseek.com/usage',
    price: 4,
    priceNote: 'deepseek-chat 输入（未命中缓存）约 ¥2/百万，输出约 ¥8/百万；此处填一个综合参考值即可',
    probes: [{ url: 'https://api.deepseek.com/user/balance' }],
    normalize: normalizeDeepSeek
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    currency: 'USD',
    keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/settings/keys',
    consoleUrl: 'https://openrouter.ai/settings/credits',
    price: 5,
    priceNote: '单位是「美元/百万 token」，各模型差异很大，仅作量级参考',
    probes: [
      { url: 'https://openrouter.ai/api/v1/key' },
      { url: 'https://openrouter.ai/api/v1/credits', optional: true }
    ],
    normalize: normalizeOpenRouter
  },
  {
    id: 'moonshot',
    name: 'Moonshot / Kimi',
    currency: 'CNY',
    keyHint: 'sk-…',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    consoleUrl: 'https://platform.moonshot.cn/console/info',
    price: 12,
    priceNote: 'kimi 系列按模型与上下文长度分档计价，请按你常用的模型填一个参考值',
    probes: [{ url: 'https://api.moonshot.cn/v1/users/me/balance' }],
    normalize: normalizeMoonshot
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    currency: 'CNY',
    keyHint: 'sk-…',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    consoleUrl: 'https://cloud.siliconflow.cn/account/charge',
    price: 4,
    priceNote: '模型广场各模型单价不同，请按常用模型填参考值',
    probes: [{ url: 'https://api.siliconflow.cn/v1/user/info' }],
    normalize: normalizeSiliconFlow
  },
  {
    id: 'custom',
    name: '自定义平台',
    currency: 'CNY',
    keyHint: '按你的服务填写',
    keyUrl: '',
    consoleUrl: '',
    price: 0,
    priceNote: '如果这个平台的接口也返回「已用额度」，填了单价就能估算 token 量级',
    probes: [],              // 地址由用户在设置里填
    normalize: normalizeCustom,
    custom: true
  }
];

const PROVIDER_IDS = PROVIDERS.map(p => p.id);

function providerById(id) {
  const key = String(id == null ? '' : id).toLowerCase();
  for (const p of PROVIDERS) if (p.id === key) return p;
  return null;
}

/* 组装一次刷新要发起的请求清单。
   内置平台用注册表里写死的地址；自定义平台用设置里的地址。
   返回 null 表示配置不完整（例如自定义平台还没填地址）。 */
function buildProbes(providerId, cfg) {
  const def = providerById(providerId);
  if (!def) return null;
  if (!def.custom) return def.probes.slice();
  const url = String((cfg && cfg.url) || '').trim();
  if (!url) return null;
  if (!isAcceptableUrl(url)) return null;
  return [{ url: url }];
}

// 该平台的密钥该以什么形式发出（自定义平台允许改头名与前缀）
function authHeader(providerId, key) {
  const def = providerById(providerId);
  const k = cleanKey(key);
  if (!k) return null;
  if (def && def.custom) return { name: 'Authorization', value: 'Bearer ' + k };
  return { name: 'Authorization', value: 'Bearer ' + k };
}

module.exports = {
  PROVIDERS,
  PROVIDER_IDS,
  CURRENCIES,
  AMOUNT_LIMIT,
  providerById,
  buildProbes,
  authHeader,
  parseAmount,
  getPath,
  pickAmount,
  maskKey,
  cleanKey,
  estimateTokens,
  isAcceptableUrl,
  normalizeDeepSeek,
  normalizeOpenRouter,
  normalizeMoonshot,
  normalizeSiliconFlow,
  normalizeCustom
};
