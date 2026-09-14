'use strict';

/* ===========================================================================
   AI 平台注册表与响应归一化单测
   ---------------------------------------------------------------------------
   用「录下来的真实响应」跑纯函数。重点覆盖两类东西：
     1. 归一化：平台随时会改字段，取值必须容错，结构不符时要给出**可读**的原因
     2. 安全边界：内置平台的请求地址不接受设置覆盖（防止把 API Key 转发到别处）
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const p = require('../lib/ai/providers.js');

const ok = (json) => ({ ok: true, status: 200, json: json, text: '', error: '' });
const http = (status, json) => ({ ok: false, status: status, json: json || null, text: '', error: '' });
const boom = (msg) => ({ ok: false, status: 0, json: null, text: '', error: msg });

// ---- DeepSeek：GET /user/balance ------------------------------------------
const DEEPSEEK_OK = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }]
};

test('DeepSeek：解析余额、赠送与充值三部分', () => {
  const r = p.normalizeDeepSeek([ok(DEEPSEEK_OK)]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.currency, 'CNY');
  assert.strictEqual(r.balance, 110);
  assert.strictEqual(r.granted, 10);
  assert.strictEqual(r.toppedUp, 100);
  assert.strictEqual(r.available, true);
});

test('DeepSeek：多币种时优先取 CNY；没有 CNY 则退回第一项', () => {
  const both = {
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '5.00' },
      { currency: 'CNY', total_balance: '36.00' }
    ]
  };
  assert.strictEqual(p.normalizeDeepSeek([ok(both)]).balance, 36);
  assert.strictEqual(p.normalizeDeepSeek([ok(both)]).currency, 'CNY');

  const usdOnly = { is_available: false, balance_infos: [{ currency: 'USD', total_balance: '5.00' }] };
  const r = p.normalizeDeepSeek([ok(usdOnly)]);
  assert.strictEqual(r.balance, 5);
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.available, false);
});

test('DeepSeek：结构不符时给出可读原因，而不是抛异常', () => {
  assert.match(p.normalizeDeepSeek([ok({ is_available: true })]).error, /balance_infos/);
  assert.match(p.normalizeDeepSeek([ok({ balance_infos: [{ currency: 'CNY' }] })]).error, /total_balance/);
  assert.match(p.normalizeDeepSeek([ok(null)]).error, /不是 JSON 对象/);
  assert.match(p.normalizeDeepSeek([boom('网络错误：ECONNRESET')]).error, /网络错误/);
  assert.match(p.normalizeDeepSeek([http(401, {})]).error, /密钥无效/);
  assert.match(p.normalizeDeepSeek([http(429, {})]).error, /限流/);
});

test('金额清洗：字符串/千分位/货币符号都能读，异常值一律拒绝', () => {
  assert.strictEqual(p.parseAmount('110.00'), 110);
  assert.strictEqual(p.parseAmount('1,234.5'), 1234.5);
  assert.strictEqual(p.parseAmount('¥ 8.80'), 8.8);
  assert.strictEqual(p.parseAmount(12.5), 12.5);
  assert.strictEqual(p.parseAmount('abc'), null);
  assert.strictEqual(p.parseAmount(''), null);
  assert.strictEqual(p.parseAmount(null), null);
  assert.strictEqual(p.parseAmount('1e15'), null, '超出上限的天文数字应被拒绝');
  assert.strictEqual(p.parseAmount(Infinity), null);
});

// ---- OpenRouter：/api/v1/key 与 /api/v1/credits ---------------------------
test('OpenRouter：有额度上限时用 limit_remaining', () => {
  const r = p.normalizeOpenRouter([ok({ data: { label: 'k', limit: 20, limit_remaining: 7.5, usage: 12.5, is_free_tier: false } })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.balance, 7.5);
  assert.strictEqual(r.limit, 20);
  assert.strictEqual(r.used, 12.5);
});

test('OpenRouter：limit 为 null（按量付费）时回退到 credits 计算余额', () => {
  const r = p.normalizeOpenRouter([
    ok({ data: { label: 'k', limit: null, limit_remaining: null, usage: 3, is_free_tier: false } }),
    ok({ data: { total_credits: 25, total_usage: 3 } })
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.balance, 22);
  assert.strictEqual(r.limit, 25);
  assert.match(r.note, /未设额度上限/);
});

test('OpenRouter：两个接口都给不出余额时明确报错，不瞎猜一个 0', () => {
  const r = p.normalizeOpenRouter([
    ok({ data: { label: 'k', limit: null, limit_remaining: null, usage: 3 } }),
    http(500, null)
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /limit_remaining|credits/);
});

test('OpenRouter：免费层会有标注', () => {
  const r = p.normalizeOpenRouter([ok({ data: { limit: 0, limit_remaining: 0, usage: 0, is_free_tier: true } })]);
  assert.strictEqual(r.ok, true);
  assert.match(r.note, /免费层/);
  assert.strictEqual(r.available, false, '余额为 0 时应标记为不可用');
});

// ---- Moonshot / SiliconFlow ----------------------------------------------
test('Moonshot：可用 / 代金券 / 现金三部分', () => {
  const r = p.normalizeMoonshot([ok({ code: 0, status: true, data: { available_balance: 88.5, voucher_balance: 8.5, cash_balance: 80 } })]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.currency, 'CNY');
  assert.strictEqual(r.balance, 88.5);
  assert.strictEqual(r.granted, 8.5);
  assert.strictEqual(r.toppedUp, 80);
});

test('Moonshot：status=false 时标记为不可用', () => {
  const r = p.normalizeMoonshot([ok({ status: false, data: { available_balance: 1 } })]);
  assert.strictEqual(r.available, false);
});

test('硅基流动：totalBalance 优先，缺失时退回 balance', () => {
  assert.strictEqual(p.normalizeSiliconFlow([ok({ code: 20000, data: { totalBalance: '42.00', chargeBalance: '42.00' } })]).balance, 42);
  assert.strictEqual(p.normalizeSiliconFlow([ok({ code: 20000, data: { balance: 9 } })]).balance, 9);
  assert.match(p.normalizeSiliconFlow([ok({ code: 20000, data: {} })]).error, /totalBalance/);
});

// ---- 自定义平台 -----------------------------------------------------------
test('自定义平台：按 JSON 路径取余额，支持多路径回退与数组下标', () => {
  const cfg = { balancePath: 'data.wallet.balance|data.balance', currency: 'USD', usedPath: 'data.used' };
  const r = p.normalizeCustom([ok({ data: { wallet: { balance: 3.25 }, used: 1.75 } })], cfg);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.balance, 3.25);
  assert.strictEqual(r.currency, 'USD');
  assert.strictEqual(r.used, 1.75);

  const arr = p.normalizeCustom([ok({ items: [{ amount: 7 }] })], { balancePath: 'items[0].amount' });
  assert.strictEqual(arr.balance, 7);
});

test('自定义平台：取不到金额时把响应的顶层字段列出来（否则无从排查）', () => {
  const r = p.normalizeCustom([ok({ code: 0, result: { money: 1 } })], { balancePath: 'data.balance' });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /code, result/, '应把实际的顶层字段名回显出来');
});

test('自定义平台：没填余额路径时明确报错', () => {
  assert.match(p.normalizeCustom([ok({ a: 1 })], {}).error, /余额字段路径/);
});

test('自定义平台：非法币种回退成 CNY', () => {
  const r = p.normalizeCustom([ok({ b: 1 })], { balancePath: 'b', currency: 'XYZ' });
  assert.strictEqual(r.currency, 'CNY');
});

// ---- 密钥处理 -------------------------------------------------------------
test('密钥掩码：只露头尾，短密钥一律打码', () => {
  assert.strictEqual(p.maskKey('sk-1234567890abcdef'), 'sk-****cdef');
  assert.strictEqual(p.maskKey('short'), '****');
  assert.strictEqual(p.maskKey(''), '');
  assert.ok(p.maskKey('sk-1234567890abcdef').indexOf('4567890') === -1, '掩码里不应出现中段字符');
});

test('密钥清洗：去掉复制粘贴带进来的空白与引号', () => {
  assert.strictEqual(p.cleanKey('  "sk-abc"  '), 'sk-abc');
  assert.strictEqual(p.cleanKey("'sk-abc'"), 'sk-abc');
  assert.strictEqual(p.cleanKey('sk-abc\n'), 'sk-abc');
});

test('token 估算：没填单价时返回 null 而不是编一个数', () => {
  assert.strictEqual(p.estimateTokens(4, 4), 1000000);
  assert.strictEqual(p.estimateTokens(2, 0), null);
  assert.strictEqual(p.estimateTokens(0, 4), 0);
  assert.strictEqual(p.estimateTokens(-1, 4), 0);
});

// ---- 地址与请求构造（安全边界） -------------------------------------------
test('只接受 https；http 仅放行本机回环', () => {
  assert.strictEqual(p.isAcceptableUrl('https://api.deepseek.com/user/balance'), true);
  assert.strictEqual(p.isAcceptableUrl('http://localhost:3000/api'), true);
  assert.strictEqual(p.isAcceptableUrl('http://127.0.0.1:3000/api'), true);
  assert.strictEqual(p.isAcceptableUrl('http://evil.example.com/steal'), false, '明文 http 到外网必须拒绝');
  assert.strictEqual(p.isAcceptableUrl('ftp://x/y'), false);
  assert.strictEqual(p.isAcceptableUrl('file:///C:/x'), false);
  assert.strictEqual(p.isAcceptableUrl('not a url'), false);
  assert.strictEqual(p.isAcceptableUrl(''), false);
});

test('内置平台的请求地址写死在注册表里，不接受设置覆盖（防止密钥被转发）', () => {
  // 这是本功能最重要的一条安全断言：设置是可以由渲染层提交的，
  // 一旦允许它改 baseUrl，被污染的渲染层就能把 API Key 送到任意域名。
  for (const id of ['deepseek', 'openrouter', 'moonshot', 'siliconflow']) {
    const def = p.providerById(id);
    const probes = p.buildProbes(id, { url: 'https://evil.example.com/collect' });
    assert.deepStrictEqual(probes, def.probes, id + ' 的请求地址不应受设置影响');
    const host = new URL(def.probes[0].url).hostname;
    for (const probe of probes) {
      assert.strictEqual(new URL(probe.url).hostname, host, id + ' 的探针不应指向别的域名');
    }
  }
});

test('自定义平台：地址必须由设置提供且合法', () => {
  assert.strictEqual(p.buildProbes('custom', {}), null);
  assert.strictEqual(p.buildProbes('custom', { url: 'http://evil.example.com/x' }), null, '外网 http 不接受');
  const ok2 = p.buildProbes('custom', { url: 'https://my-gateway.example.com/api/balance' });
  assert.strictEqual(ok2.length, 1);
  assert.strictEqual(ok2[0].url, 'https://my-gateway.example.com/api/balance');
});

test('认证头：空密钥不发请求，非空一律用 Bearer', () => {
  assert.strictEqual(p.authHeader('deepseek', ''), null);
  assert.deepStrictEqual(p.authHeader('deepseek', ' sk-x '), { name: 'Authorization', value: 'Bearer sk-x' });
});

test('未知平台返回 null，不会静默当成 deepseek', () => {
  assert.strictEqual(p.providerById('nope'), null);
  assert.strictEqual(p.buildProbes('nope', {}), null);
});

test('DeepSeek 的探针地址与官方文档一致（防止被误改）', () => {
  assert.strictEqual(p.providerById('deepseek').probes[0].url, 'https://api.deepseek.com/user/balance');
  assert.strictEqual(p.providerById('openrouter').probes[0].url, 'https://openrouter.ai/api/v1/key');
  assert.strictEqual(p.providerById('moonshot').probes[0].url, 'https://api.moonshot.cn/v1/users/me/balance');
  assert.strictEqual(p.providerById('siliconflow').probes[0].url, 'https://api.siliconflow.cn/v1/user/info');
});

test('getPath：点号路径与数组下标；缺环返回 undefined 而不是抛错', () => {
  const o = { a: { b: [{ c: 1 }] } };
  assert.strictEqual(p.getPath(o, 'a.b[0].c'), 1);
  assert.strictEqual(p.getPath(o, 'a.b[1].c'), undefined);
  assert.strictEqual(p.getPath(o, 'a.x.y'), undefined);
  assert.strictEqual(p.getPath(null, 'a'), undefined);
  assert.strictEqual(p.getPath(o, ''), undefined);
});
