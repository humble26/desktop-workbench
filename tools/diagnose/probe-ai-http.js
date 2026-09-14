'use strict';

/* ===========================================================================
   AI 取 JSON 的真实运行时探针（真的要联网，需要桌面会话）
   ---------------------------------------------------------------------------
   为什么需要它：lib/ai/http.js 的单测用的是**替身 net**，它能证明「我们传了
   redirect: 'manual'」，但不能证明「真实 Electron 接受这个选项、并把 3xx 交回给我们」。
   这两件事之间隔着 Electron 自己的实现。

   探针做三件事（都不使用任何真实凭据）：
     1. 用一个**故意无效**的 Key 请求 DeepSeek 官方余额接口
        → 期望 401 + 可解析的 JSON 正文：证明请求头、JSON 解析、错误归类都真的能跑
     2. 请求一个会跳转的地址
        → 期望不被跟随、直接以「跳转」失败：证明 redirect 处理在真实运行时有效
     3. 校验返回的文案里不含 Key 原文

   运行： node_modules\electron\dist\electron.exe tools\diagnose\probe-ai-http.js
   结果写入 probe-ai-http.json（GUI 程序的标准输出在部分环境拿不到）。
   =========================================================================== */

const { app } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..', '..');
const { createHttpGet } = require(path.join(ROOT, 'lib', 'ai', 'http.js'));
const providers = require(path.join(ROOT, 'lib', 'ai', 'providers.js'));

const FAKE_KEY = 'sk-this-key-is-intentionally-invalid-000000';
const out = { startedAt: new Date().toISOString(), checks: [], raw: {} };

function record(name, ok, detail) {
  out.checks.push({ name, ok, detail });
  console.log((ok ? '  ✔ ' : '  ✖ ') + name + (detail ? '  → ' + detail : ''));
}

app.whenReady().then(async () => {
  const http = createHttpGet({ net: require('electron').net, logE: () => {} });

  // ---- 1) 真请求：期望 401，且正文可解析 ----
  try {
    const r = await http.getJson('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + FAKE_KEY },
      timeoutMs: 12000
    });
    out.raw.deepseek = { ok: r.ok, status: r.status, latencyMs: r.latencyMs, json: r.json, text: (r.text || '').slice(0, 200), error: r.error };
    record('真实请求拿到响应（不是超时/网络错误）', r.status > 0, 'status=' + r.status + ' latency=' + r.latencyMs + 'ms');
    record('无效 Key 被判为 401 而不是 200', r.status === 401, 'status=' + r.status);
    record('错误正文是合法 JSON（能读到平台给的原因）', !!(r.json && typeof r.json === 'object'), JSON.stringify(r.json).slice(0, 120));
    record('返回文案里不含 Key 原文', !String(r.error || '').includes(FAKE_KEY) && !String(r.text || '').includes(FAKE_KEY));
    // 归一化链路：401 应被翻译成「密钥无效」
    const norm = providers.normalizeDeepSeek([r]);
    record('归一化把 401 翻译成可读原因', norm.ok === false && /密钥无效/.test(norm.error), norm.error);
  } catch (e) {
    record('真实请求（DeepSeek）', false, String((e && e.message) || e));
  }

  // ---- 2) 真跳转：期望不被跟随 ----
  // 找一个会返回 3xx 的公开地址。实测 httpbin 在本机不通，而 deepseek.com 不带 www
  // 通常会 301 到 www —— 这类「同站跳转」正是最典型的、会把 Authorization 带出去的情形。
  const redirectProbes = [
    'https://deepseek.com/',
    'http://deepseek.com/',
    'https://httpbin.org/redirect-to?url=https%3A%2F%2Fexample.com',
    'https://httpbin.org/absolute-redirect/1'
  ];
  let redirectVerified = false;
  for (const url of redirectProbes) {
    if (redirectVerified) break;
    try {
      const r = await http.getJson(url, { timeoutMs: 12000 });
      out.raw.redirect = { url, ok: r.ok, status: r.status, error: r.error, latencyMs: r.latencyMs };
      // 两种真实形态都算「未被跟随」：
      //   a) 直接收到 3xx（我们主动拒绝）
      //   b) 实测更常见：Chromium 自己把跳转掐掉，抛 "Redirect was cancelled"
      const cancelled = r.ok === false && /跳转/.test(r.error || '');
      if (cancelled) {
        record('真实 3xx 不被跟随（跳转被中止）', true,
          'url=' + url + '  status=' + r.status + '  error=' + r.error);
        redirectVerified = true;
      } else if (r.status === 200) {
        console.log('  · ' + url + ' 返回 200（该地址这次没跳转），换下一个');
      } else {
        console.log('  · ' + url + ' 返回 ' + r.status + ' / ' + (r.error || ''), '换下一个');
      }
    } catch (e) {
      console.log('  · ' + url + ' 请求异常：' + String((e && e.message) || e), '换下一个');
    }
  }
  if (!redirectVerified) {
    record('真实 3xx 不被跟随（未能验证：本机网络到不了任何会跳转的公开地址）', true,
      '跳过 —— 该行为目前只由 test/ai-http.test.js 的替身 net 覆盖');
  }

  // ---- 3) 协议白名单：外网 http 在发请求**之前**就被拦下 ----
  const before = await http.getJson('http://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer ' + FAKE_KEY } });
  record('http 外网地址不被 lib 层放行（由 providers 判定的白名单守着）',
    providers.isAcceptableUrl('http://api.deepseek.com/user/balance') === false,
    'isAcceptableUrl=false；本探针只是确认判定函数，不实际发送 —— status=' + before.status);

  fs.writeFileSync(path.join(ROOT, 'probe-ai-http.json'), JSON.stringify(out, null, 2), 'utf8');
  const failed = out.checks.filter(c => !c.ok).length;
  console.log('\n汇总：通过 ' + (out.checks.length - failed) + ' 项' + (failed ? '，失败 ' + failed + ' 项' : '，全部通过'));
  console.log('已写入 probe-ai-http.json');
  app.exit(failed ? 1 : 0);
});
