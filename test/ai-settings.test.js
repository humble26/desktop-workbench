'use strict';

/* ===========================================================================
   AI 监测设置归一化单测
   ---------------------------------------------------------------------------
   这一份实现被 defaults / migrate / main 三处共用，所以两件事必须钉死：
     · 幂等 —— 否则每次启动都会被判成「结构有改动」，反复重写数据文件
     · 不删未知字段 —— 否则降级回旧版本会丢用户配置
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const s = require('../lib/ai/settings.js');
const p = require('../lib/ai/providers.js');
const { defaultData } = require('../lib/defaults.js');
const { migrate } = require('../lib/migrate.js');

test('默认值本身已经是归一化过的（migrate 不会把它当成一次改动）', () => {
  const d = s.defaultAiSettings();
  assert.deepStrictEqual(s.normalizeAiSettings(d), d);
  assert.strictEqual(s.normalizeAiSettings(d).enabled, false, 'AI 监测必须默认关闭');
  assert.strictEqual(s.normalizeAiSettings(d).intervalMinutes, 30);
  assert.strictEqual(s.normalizeAiSettings(d).lowBalance, 0);
});

test('全新数据文件的结构已经包含 aiMonitor，且不需要迁移', () => {
  const d = defaultData();
  assert.ok(d.settings.aiMonitor, 'defaultData 应包含 aiMonitor');
  const r = migrate(d);
  assert.strictEqual(r.changed, false, '默认结构不应触发迁移：' + JSON.stringify(r.steps));
  assert.strictEqual(migrate(d).changed, false);
});

test('老数据文件（没有 aiMonitor）会被补上，且只补一次', () => {
  const old = defaultData();
  delete old.settings.aiMonitor;
  old.settings.theme = 'dark';                       // 顺手确认用户设置没被动
  const first = migrate(old);
  assert.strictEqual(first.changed, true, '缺 aiMonitor 应判定为需要归一化');
  assert.ok(old.settings.aiMonitor, '应补上 aiMonitor');
  assert.strictEqual(old.settings.aiMonitor.enabled, false);
  assert.strictEqual(old.settings.theme, 'dark', '不应动用户已有设置');
  assert.strictEqual(migrate(old).changed, false, '第二次不应再改动');
});

test('值归一化：非法间隔 / 阈值 / 单价回退到安全默认', () => {
  const n = s.normalizeAiSettings({
    enabled: 'yes',
    intervalMinutes: 0,
    lowBalance: -5,
    providers: {
      deepseek: { enabled: 1, price: -1 },
      openrouter: { price: 'abc' },
      moonshot: { price: 1e9 }
    }
  });
  assert.strictEqual(n.enabled, false, '非布尔值应回退为默认关闭');
  assert.strictEqual(n.intervalMinutes, 30, '越界间隔应回退');
  assert.strictEqual(n.lowBalance, 0, '负数阈值应回退');
  assert.strictEqual(n.providers.deepseek.enabled, true,
    '非布尔值回退为「该平台的默认值」（内置平台默认开启；真正会不会发请求还要看有没有密钥）');
  assert.strictEqual(n.providers.custom.enabled, false, '自定义平台默认关闭');
  assert.strictEqual(n.providers.deepseek.price, 4, '负数单价回退为平台默认');
  assert.strictEqual(n.providers.openrouter.price, 5);
  assert.strictEqual(n.providers.moonshot.price, 12, '超上限的单价回退');
});

test('合法的自定义值会被保留（包括自定义平台的地址与路径）', () => {
  const n = s.normalizeAiSettings({
    enabled: true,
    intervalMinutes: 60,
    lowBalance: 20,
    providers: {
      deepseek: { enabled: false, price: 2.5 },
      custom: {
        enabled: true, price: 1, name: '我的中转站',
        url: 'https://gw.example.com/api/balance',
        balancePath: 'data.balance', currency: 'USD'
      }
    }
  });
  assert.strictEqual(n.enabled, true);
  assert.strictEqual(n.intervalMinutes, 60);
  assert.strictEqual(n.lowBalance, 20);
  assert.strictEqual(n.providers.deepseek.enabled, false);
  assert.strictEqual(n.providers.deepseek.price, 2.5);
  assert.strictEqual(n.providers.custom.url, 'https://gw.example.com/api/balance');
  assert.strictEqual(n.providers.custom.balancePath, 'data.balance');
  assert.strictEqual(n.providers.custom.currency, 'USD');
  assert.strictEqual(n.providers.custom.name, '我的中转站');
});

test('自定义平台的非 https 地址会被清空（宁可提示「还没填」，也不留下不合法的串）', () => {
  assert.strictEqual(s.normalizeAiSettings({ providers: { custom: { url: 'http://evil.example.com/x' } } }).providers.custom.url, '');
  assert.strictEqual(s.normalizeAiSettings({ providers: { custom: { url: 'ftp://x/y' } } }).providers.custom.url, '');
  assert.strictEqual(
    s.normalizeAiSettings({ providers: { custom: { url: 'http://127.0.0.1:8080/api' } } }).providers.custom.url,
    'http://127.0.0.1:8080/api', '本机 http 应被接受');
});

test('未知字段一律保留（降级回旧版本不该丢配置）', () => {
  const n = s.normalizeAiSettings({
    enabled: true,
    futureOption: { a: 1 },
    providers: {
      deepseek: { price: 3, futureFlag: true },
      someNewPlatform: { enabled: true, url: 'https://x.example.com' }
    }
  });
  assert.deepStrictEqual(n.futureOption, { a: 1 }, '顶层未知字段应保留');
  assert.strictEqual(n.providers.deepseek.futureFlag, true, '平台内未知字段应保留');
  assert.deepStrictEqual(n.providers.someNewPlatform, { enabled: true, url: 'https://x.example.com' }, '未知平台应原样保留');
});

test('五个内置平台都会被补齐（含自定义）', () => {
  const n = s.normalizeAiSettings({});
  assert.deepStrictEqual(Object.keys(n.providers).sort(), p.PROVIDER_IDS.slice().sort());
  for (const id of p.PROVIDER_IDS) {
    assert.ok(Object.prototype.hasOwnProperty.call(n.providers[id], 'enabled'), id + ' 缺少 enabled');
    assert.ok(Object.prototype.hasOwnProperty.call(n.providers[id], 'price'), id + ' 缺少 price');
  }
});

test('归一化是幂等的（反复跑不会产生新差异）', () => {
  const raw = {
    enabled: true, intervalMinutes: 15, lowBalance: 3,
    providers: { deepseek: { enabled: true, price: 2 }, custom: { url: 'https://a.example.com/b', balancePath: 'x.y' } }
  };
  const once = s.normalizeAiSettings(raw);
  const twice = s.normalizeAiSettings(JSON.parse(JSON.stringify(once)));
  assert.deepStrictEqual(twice, once);
});
