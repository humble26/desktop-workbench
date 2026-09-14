'use strict';

/* ===========================================================================
   余额监测单测：消耗推算、跨天均摊、汇总与保留策略
   ---------------------------------------------------------------------------
   核心被验证的算法：消耗 = 上一次余额 − 这一次余额（余额上升视为充值，不计负消耗）。
   它是整个「用量监测」的地基 —— 平台没有公开用量接口，所有消耗数字都由它得来，
   所以这里把边界掰开测：充值、跨天、换币种、失败、多平台互不影响。
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAiMonitor } = require('../lib/ai/monitor.js');

const CLOCK_START = new Date('2026-09-10T10:00:00').getTime();

function dateKeyOf(d) {
  const x = d || new Date(clock.t);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${x.getFullYear()}-${p2(x.getMonth() + 1)}-${p2(x.getDate())}`;
}

let clock = { t: CLOCK_START };

function shiftDays(n) { clock.t = CLOCK_START + n * 86400000; }

/* 所有创建过的监测器都登记在这里，由文件末尾的 test.after 统一 dispose。
   为什么需要：reconcile() 会建一个 30 分钟的 setInterval，而它不会阻止进程退出
   的前提是测试真的走到了 dispose()。一旦某条断言在 dispose() 之前失败，
   这个定时器就把 Node 进程一直吊着 —— 表现是**整轮测试超时**，而不是那条断言失败。
   吃过一次亏：一个明确的失败伪装成了「超时」，极难定位。 */
const liveMonitors = [];
test.after(() => {
  for (const m of liveMonitors) { try { m.dispose(); } catch (e) { /* ignore */ } }
  liveMonitors.length = 0;
});

/** 一个可控的测试环境：伪造密钥库、HTTP 与设置 */
function makeEnv(opts) {
  const o = opts || {};
  clock.t = o.startAt || CLOCK_START;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ai-'));
  const file = path.join(dir, 'ai-usage.json');

  const keys = o.keys || { deepseek: 'sk-test-1234567890' };
  const keyStore = {
    get: (id) => keys[id] || '',
    has: (id) => !!keys[id],
    list: () => {
      const out = {};
      for (const k of Object.keys(keys)) out[k] = { masked: 'sk-****' + String(keys[k]).slice(-4), at: 0, readable: true };
      return out;
    },
    backendName: () => '测试替身',
    encryptionAvailable: () => true
  };

  // 按 URL 排队返回响应：每次调用取走一条，队列用完后重复最后一条
  // （实现要小心：不能在「队列有多条」时才 shift —— 那会把最旧的一条
  //  一直喂给后续请求，测试会以为监控算错了，其实是替身发错了响应）
  const queues = {};
  const lastOf = {};
  const calls = [];
  const httpGet = {
    getJson: async (url, cfg2) => {
      calls.push({ url, headers: (cfg2 && cfg2.headers) || {} });
      const q = queues[url] || [];
      if (q.length) lastOf[url] = q.shift();
      if (lastOf[url]) return lastOf[url];
      return { ok: false, status: 0, json: null, text: '', error: '未安排的请求：' + url };
    }
  };
  function push(url, res) { (queues[url] = queues[url] || []).push(res); }

  const settingsObj = Object.assign({
    enabled: true,
    intervalMinutes: 30,
    lowBalance: 0,
    providers: {
      deepseek: { enabled: true, price: 4 },
      openrouter: { enabled: false, price: 5 },
      moonshot: { enabled: false, price: 12 },
      siliconflow: { enabled: false, price: 4 },
      custom: { enabled: false, price: 0 }
    }
  }, o.settings || {});

  const updates = [];
  const monitor = createAiMonitor({
    httpGet,
    keyStore,
    storePath: () => file,
    settings: () => settingsObj,
    dateKey: dateKeyOf,
    now: () => clock.t,
    logE: () => {},
    onUpdate: (s) => updates.push(s),
    kickDelayMs: o.kickDelayMs
  });
  liveMonitors.push(monitor);

  return { dir, file, monitor, keys, keyStore, push, calls, settingsObj, updates };
}

const DS = 'https://api.deepseek.com/user/balance';
const ds = (balance, extra) => ({
  ok: true, status: 200, error: '', text: '',
  json: Object.assign({
    is_available: true,
    balance_infos: [{ currency: 'CNY', total_balance: String(balance), granted_balance: '0', topped_up_balance: String(balance) }]
  }, extra || {})
});

function deepseekState(monitor) {
  return monitor.summary().providers.find(x => x.id === 'deepseek');
}

/* ---- 消耗推算 ---------------------------------------------------------- */

test('消耗 = 两次余额之差，记在当天', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 0, '第一次采样没有前值，不该凭空产生消耗');

  e.push(DS, ds(97));
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 3);
  assert.strictEqual(deepseekState(e.monitor).balance, 97);
});

test('余额上升视为充值，不能被算成负消耗', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(150));
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 0);
  assert.strictEqual(deepseekState(e.monitor).spend.tracked, 0);
  assert.strictEqual(deepseekState(e.monitor).balance, 150);
});

test('充值后再消耗：只算充值之后掉下来的那部分', async () => {
  const e = makeEnv();
  e.push(DS, ds(10));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(110));            // 充值 100
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(108));            // 用掉 2
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 2);
});

test('应用关了好几天：这段消耗均摊到相隔的每一天，而不是全压在回来的那天', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);   // 9/10 采样

  shiftDays(3);                            // 9/13 才又打开
  e.push(DS, ds(94));                      // 三天共花 6
  await e.monitor.refresh(['deepseek']);

  const h = e.monitor.history('deepseek', 14);
  const byDay = {};
  for (const d of h.days) byDay[d.date] = d.amount;
  // 消耗发生在两次采样之间，因此摊到「上次采样日的次日 ~ 本次采样日」
  assert.strictEqual(byDay['2026-09-10'], 0, '上次采样当天不该被回溯记账');
  assert.strictEqual(byDay['2026-09-11'], 2);
  assert.strictEqual(byDay['2026-09-12'], 2);
  assert.strictEqual(byDay['2026-09-13'], 2);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 2);
  assert.strictEqual(deepseekState(e.monitor).spend.tracked, 6, '总额必须与余额下降量一致');
});

test('同一天多次采样：消耗累加到同一天', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(99));
  await e.monitor.refresh(['deepseek']);
  clock.t += 3600000;
  e.push(DS, ds(98.5));
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 1.5);
});

test('币种变了就不做差值（否则会把汇率差当成消耗）', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  // 同样的数字，但币种换成 USD
  e.push(DS, {
    ok: true, status: 200, error: '', text: '',
    json: { is_available: true, balance_infos: [{ currency: 'USD', total_balance: '50' }] }
  });
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.tracked, 0, '币种变化不应产生消耗');
  assert.strictEqual(deepseekState(e.monitor).currency, 'USD');
});

/* ---- 失败与降级 -------------------------------------------------------- */

test('没填密钥时给出明确原因，且不发任何请求', async () => {
  const e = makeEnv({ keys: {} });
  await e.monitor.refresh(['deepseek']);
  const st = deepseekState(e.monitor);
  assert.strictEqual(st.ok, false);
  assert.match(st.error, /还没有填写/);
  assert.strictEqual(e.calls.length, 0, '没有密钥就不该发起请求');
});

test('401 被翻译成人话，并保留最后一次成功的余额', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, { ok: false, status: 401, json: { error: { message: 'Authentication Fails' } }, text: '', error: '' });
  const r = await e.monitor.refresh(['deepseek']);
  assert.strictEqual(r.ok, true, '刷新流程本身不应失败');
  const st = deepseekState(e.monitor);
  assert.strictEqual(st.ok, false);
  assert.match(st.error, /密钥无效/);
  assert.match(st.error, /Authentication Fails/, '应带上平台给的原因');
});

test('网络异常不会打断其他平台，也不会让整个刷新失败', async () => {
  const e = makeEnv({ keys: { deepseek: 'sk-a-1234567890', moonshot: 'sk-b-1234567890' } });
  e.settingsObj.providers.moonshot.enabled = true;
  e.push(DS, { ok: false, status: 0, json: null, text: '', error: '网络错误：ECONNRESET' });
  e.push('https://api.moonshot.cn/v1/users/me/balance', { ok: true, status: 200, error: '', text: '', json: { status: true, data: { available_balance: 20 } } });

  const r = await e.monitor.refresh();
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.refreshed, 2);
  const sum = e.monitor.summary();
  assert.strictEqual(sum.providers.find(x => x.id === 'deepseek').ok, false);
  assert.strictEqual(sum.providers.find(x => x.id === 'moonshot').ok, true);
  assert.strictEqual(sum.providers.find(x => x.id === 'moonshot').balance, 20);
});

test('只刷新「已启用且有密钥」的平台', async () => {
  const e = makeEnv({ keys: { deepseek: 'sk-a-1234567890', moonshot: 'sk-b-1234567890' } });
  e.settingsObj.providers.moonshot.enabled = false;   // 有密钥但没启用
  e.push(DS, ds(50));
  const r = await e.monitor.refresh();
  assert.strictEqual(r.refreshed, 1);
  assert.strictEqual(e.calls.length, 1);
  assert.match(e.calls[0].url, /deepseek/);
});

test('显式点名也要看平台开关：关掉的平台不该被任何路径偷偷请求', async () => {
  const e = makeEnv({ keys: { deepseek: 'sk-a-1234567890', moonshot: 'sk-b-1234567890' } });
  e.settingsObj.providers.moonshot.enabled = false;
  const r = await e.monitor.refresh(['moonshot']);
  assert.strictEqual(r.refreshed, 0, '关掉的平台不该被刷新');
  assert.strictEqual(r.skipped, 1, '应如实报告跳过了几个');
  assert.strictEqual(e.calls.length, 0, '一个请求都不该发出去');
  // 复现真实入口：保存密钥后主进程会「顺手验证」一次 —— 那条路径同样要拦住
  const r2 = await e.monitor.refresh(['moonshot', 'deepseek']);
  assert.strictEqual(r2.refreshed, 1, '只刷新开着的那一个');
  assert.strictEqual(e.calls.length, 1);
  assert.match(e.calls[0].url, /deepseek/);
});

test('刷新进行中再次刷新会被拒绝（避免重复请求与重复记账）', async () => {
  const e = makeEnv();
  let release = null;
  const gate = new Promise(r => { release = r; });
  const slow = {
    getJson: async () => { await gate; return ds(100); }
  };
  const monitor2 = createAiMonitor({
    httpGet: slow, keyStore: e.keyStore, storePath: () => e.file, settings: () => e.settingsObj,
    dateKey: dateKeyOf, now: () => clock.t, logE: () => {}, onUpdate: () => {}
  });
  liveMonitors.push(monitor2);
  const first = monitor2.refresh(['deepseek']);
  const second = await monitor2.refresh(['deepseek']);
  assert.strictEqual(second.ok, false);
  assert.strictEqual(second.reason, 'busy');
  release();
  await first;
});

/* ---- 汇总与派生指标 ---------------------------------------------------- */

test('汇总里不得出现明文密钥（只有掩码）', async () => {
  const e = makeEnv({ keys: { deepseek: 'sk-super-secret-value-9876' } });
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  const json = JSON.stringify(e.monitor.summary());
  assert.ok(json.indexOf('sk-super-secret-value-9876') === -1, '汇总里泄露了明文密钥');
  assert.ok(json.indexOf('****9876') !== -1, '应该给出掩码');
});

test('燃烧速率的分母是「有记录的天数」，不是固定的 7 天', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);        // 第 1 天
  shiftDays(1);
  e.push(DS, ds(97));
  await e.monitor.refresh(['deepseek']);        // 第 2 天，两天共花 3
  const sp = deepseekState(e.monitor).spend;
  assert.strictEqual(sp.observedDays, 2, '才记录两天，分母就该是 2');
  assert.strictEqual(sp.avgPerDay, 1.5);
  assert.strictEqual(sp.daysLeft, Math.floor(97 / 1.5));
});

test('还没有任何消耗时不编造预计天数', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  const sp = deepseekState(e.monitor).spend;
  assert.strictEqual(sp.avgPerDay, 0);
  assert.strictEqual(sp.daysLeft, null);
});

test('token 估算：填了单价才算，没填就返回 null（界面据此不显示）', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(96));                            // 花 4 元
  await e.monitor.refresh(['deepseek']);
  const sp = deepseekState(e.monitor).spend;
  assert.strictEqual(sp.tokensToday, 1000000, '4 元 ÷ 4 元/百万 = 100 万 token');

  e.settingsObj.providers.deepseek.price = 0;
  assert.strictEqual(deepseekState(e.monitor).spend.tokensToday, null);
});

test('history 会把没有记录的日子补成 0（否则图表会断层）', async () => {
  const e = makeEnv();
  const h = e.monitor.history('deepseek', 5);
  assert.strictEqual(h.days.length, 5);
  assert.deepStrictEqual(h.days.map(d => d.amount), [0, 0, 0, 0, 0]);
  assert.strictEqual(h.days[4].date, dateKeyOf());
});

test('低余额提醒：只有开了阈值且确实低于阈值才命中', async () => {
  const e = makeEnv();
  e.push(DS, ds(8));
  await e.monitor.refresh(['deepseek']);
  assert.deepStrictEqual(e.monitor.lowBalanceHits(), [], '阈值为 0 时不该提醒');

  e.settingsObj.lowBalance = 10;
  const hits = e.monitor.lowBalanceHits();
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(hits[0].id, 'deepseek');
  assert.strictEqual(hits[0].balance, 8);

  e.settingsObj.lowBalance = 5;
  assert.deepStrictEqual(e.monitor.lowBalanceHits(), [], '余额高于阈值时不该提醒');
});

/* ---- 落盘与保留 -------------------------------------------------------- */

test('历史会落盘并在重建后读回（应用重启不丢消耗记录）', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(92));
  await e.monitor.refresh(['deepseek']);
  assert.ok(fs.existsSync(e.file), '应建立 ai-usage.json');

  const fresh = createAiMonitor({
    httpGet: e.httpGet, keyStore: e.keyStore, storePath: () => e.file, settings: () => e.settingsObj,
    dateKey: dateKeyOf, now: () => clock.t, logE: () => {}, onUpdate: () => {}
  });
  assert.strictEqual(deepseekState(fresh).spend.today, 8);
  assert.strictEqual(deepseekState(fresh).balance, 92);
});

test('清空历史不影响密钥与设置', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(90));
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(deepseekState(e.monitor).spend.today, 10);

  e.monitor.clear();
  const st = deepseekState(e.monitor);
  assert.strictEqual(st.spend.today, 0);
  assert.strictEqual(st.balance, null);
  assert.strictEqual(st.hasKey, true, '密钥不该被清掉');
  assert.strictEqual(e.settingsObj.providers.deepseek.enabled, true, '设置不该被清掉');
});

test('单平台清空只影响该平台', async () => {
  const e = makeEnv({ keys: { deepseek: 'sk-a-1234567890', moonshot: 'sk-b-1234567890' } });
  e.settingsObj.providers.moonshot.enabled = true;
  e.push(DS, ds(100));
  e.push('https://api.moonshot.cn/v1/users/me/balance', { ok: true, status: 200, error: '', text: '', json: { status: true, data: { available_balance: 20 } } });
  await e.monitor.refresh();
  e.monitor.clearProvider('deepseek');
  const sum = e.monitor.summary();
  assert.strictEqual(sum.providers.find(x => x.id === 'deepseek').balance, null);
  assert.strictEqual(sum.providers.find(x => x.id === 'moonshot').balance, 20);
});

test('超过保留期的每日消耗会被清掉（文件不会无限膨胀）', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  e.push(DS, ds(99));
  await e.monitor.refresh(['deepseek']);

  // 往前跳 500 天再采样一次，触发 prune
  shiftDays(500);
  e.push(DS, ds(98));
  await e.monitor.refresh(['deepseek']);

  const raw = JSON.parse(fs.readFileSync(e.file, 'utf8'));
  const spendDays = Object.keys(raw.providers.deepseek.spend);
  assert.ok(spendDays.every(d => d >= dateKeyOf(new Date(clock.t - 400 * 86400000))), '超过 400 天的记录应被清理');
  assert.ok(spendDays.length >= 1, '新记录必须保留');
});

test('onUpdate 在每次刷新后回调一次（主进程据此推送与提醒）', async () => {
  const e = makeEnv();
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);
  assert.strictEqual(e.updates.length, 1);
  assert.ok(Array.isArray(e.updates[0].providers));
});

test('summary 的形状稳定（渲染层与设置页都依赖它）', async () => {
  const e = makeEnv();
  const s = e.monitor.summary();
  for (const k of ['supported', 'enabled', 'intervalMinutes', 'lowBalance', 'keyStorage',
    'keyStorageAvailable', 'refreshing', 'lastRefreshAt', 'providers']) {
    assert.ok(Object.prototype.hasOwnProperty.call(s, k), 'summary 缺少字段 ' + k);
  }
  assert.strictEqual(s.providers.length, 5, '五个内置平台都应列出（含自定义）');
  const ds2 = s.providers.find(x => x.id === 'deepseek');
  for (const k of ['id', 'name', 'custom', 'currency', 'enabled', 'hasKey', 'masked', 'ok', 'balance', 'spend', 'consoleUrl']) {
    assert.ok(Object.prototype.hasOwnProperty.call(ds2, k), 'provider 状态缺少字段 ' + k);
  }
});

/* ---- 轮询节流 -----------------------------------------------------------
   reconcile() 会在**每一次数据提交**之后被主进程调用（好让开关改动立即生效），
   而每一次调用都可能变成一次真实的平台接口请求。下面的断言就是守这件事：
   设置保存不该变成对别人服务器的骚扰。 */

test('reconcile 被反复调用时不会反复重建定时器（否则周期刷新永远轮不到）', () => {
  const e = makeEnv();
  e.settingsObj.enabled = true;
  const first = e.monitor.reconcile();
  assert.strictEqual(first.enabled, true);
  assert.strictEqual(first.intervalChanged, true, '第一次应建立定时器');

  // 模拟用户连续保存设置（加待办、切主题…）
  for (let i = 0; i < 5; i++) {
    const r = e.monitor.reconcile();
    assert.strictEqual(r.intervalChanged, false, '间隔没变就不该重建定时器');
  }
  // 改间隔才重建
  e.settingsObj.intervalMinutes = 60;
  assert.strictEqual(e.monitor.reconcile().intervalChanged, true, '间隔变化应重建');
  e.monitor.dispose();
});

test('reconcile 只在刚打开时补一次刷新，之后短时间内不再打接口', async () => {
  const e = makeEnv();
  e.settingsObj.enabled = false;
  assert.strictEqual(e.monitor.reconcile().enabled, false, '关闭时不该启动');

  e.settingsObj.enabled = true;
  assert.strictEqual(e.monitor.reconcile().kicked, true, '刚打开应补一次');

  // 等这次「踢一脚」真的跑完（1.5 秒的延迟在测试里等不起，直接手动刷一次来推进时间基准）
  e.push(DS, ds(100));
  await e.monitor.refresh(['deepseek']);

  for (let i = 0; i < 3; i++) {
    const r = e.monitor.reconcile();
    assert.strictEqual(r.kicked, false, '刚刷过就不该再补，否则每次保存设置都会打一次接口');
  }
  e.monitor.dispose();
});

test('关闭开关后定时器与待执行的刷新都会被清掉', () => {
  const e = makeEnv();
  e.settingsObj.enabled = true;
  e.monitor.reconcile();
  e.settingsObj.enabled = false;
  const r = e.monitor.reconcile();
  assert.strictEqual(r.enabled, false);
  assert.strictEqual(r.intervalChanged, true, '关闭时应清掉定时器');
  // 再打开一次仍然是干净的
  e.settingsObj.enabled = true;
  assert.strictEqual(e.monitor.reconcile().intervalChanged, true);
  e.monitor.dispose();
});

test('dispose 之后不再有新的刷新被触发', async () => {
  const e = makeEnv();
  e.settingsObj.enabled = true;
  e.push(DS, ds(100));
  e.monitor.reconcile();
  e.monitor.dispose();
  e.settingsObj.enabled = true;
  // dispose 只负责停机；再次 reconcile 会重新启动（由主进程在退出时不再调用）
  const calls = e.calls.length;
  assert.strictEqual(calls, 0, 'dispose 之前那次「踢一脚」应已被取消，不该发出请求');
});

/* 打开开关的真实时序：渲染层 save() 提交设置 → 主进程 store:commit 里 reconcile()
   排一个「1.5 秒后补一次」→ 渲染层紧接着自己又调了 aiRefresh()。
   如果补一次的动作不在触发时复核新鲜度，就会在 1.5 秒后再打一次平台接口。 */
test('延迟期间已经手动刷过了，就不再补第二次请求', async () => {
  const e = makeEnv({ kickDelayMs: 40 });
  e.settingsObj.enabled = true;
  const first = e.monitor.reconcile();
  assert.strictEqual(first.kicked, true, '刚打开时应该排一次补刷');

  // 渲染层紧接着的手动刷新
  e.push(DS, ds(100));
  await e.monitor.refresh();
  const afterManual = e.calls.length;
  assert.strictEqual(afterManual, 1);

  await new Promise(r => setTimeout(r, 120));   // 等排好的那次「补刷」到点
  assert.strictEqual(e.calls.length, afterManual, '补刷到点时发现刚刚刷过，就不该再打一次接口');
  e.monitor.dispose();
});

test('真的很久没刷过时，补刷仍然会执行（不是被上面那条规则一并废掉）', async () => {
  const e = makeEnv({ kickDelayMs: 30 });
  e.settingsObj.enabled = true;
  e.push(DS, ds(100));
  e.monitor.reconcile();
  await new Promise(r => setTimeout(r, 120));
  assert.strictEqual(e.calls.length, 1, '从未刷过时应完成这一次补刷');
  e.monitor.dispose();
});
