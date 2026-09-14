'use strict';

/* ===========================================================================
   AI 取 JSON 单测（用替身 electron.net，不需要真实网络）
   ---------------------------------------------------------------------------
   这里的每一条几乎都是安全约束，不是功能约束：
     · 不跟随 302 —— 跟随会把 Authorization 头带到跳转目标域，等于把密钥送给第三方
     · 错误信息里不得出现密钥
     · 超时与响应体积必须有硬上限（余额响应只有几百字节）
   =========================================================================== */

const test = require('node:test');
const assert = require('node:assert');
const { createHttpGet, redact } = require('../lib/ai/http.js');

/** 替身 net：把「请求 → 响应事件」的驱动权交回给测试 */
function fakeNet() {
  const requests = [];
  const state = { aborted: 0 };
  const net = {
    request: (opts) => {
      const handlers = {};
      const req = {
        opts: opts,
        on(ev, cb) { handlers[ev] = cb; return req; },
        setTimeout(ms, cb) { req._timeout = { ms, cb }; return req; },
        end() { req._ended = true; },
        abort() { state.aborted++; }
      };
      req._handlers = handlers;
      requests.push(req);
      return req;
    }
  };
  return { net, requests, state };
}

// 手工把一次响应喂给请求对象
function respond(req, status, body, opts) {
  const o = opts || {};
  const h = req._handlers;
  const resHandlers = {};
  const res = {
    statusCode: status,
    on(ev, cb) { resHandlers[ev] = cb; return res; }
  };
  h.response(res);
  if (o.triggerTimeout) { req._timeout.cb(); return; }
  if (o.abortInsteadOfData) { req.abort(); return; }
  // 3xx 之类的分支会在 response 阶段就返回，不会注册 data/end —— 这里要容忍
  if (!resHandlers.data) return;
  const chunks = o.chunks || [Buffer.from(body === undefined ? '' : String(body), 'utf8')];
  for (const c of chunks) resHandlers.data(c);
  if (o.triggerError) { resHandlers.error(new Error(o.triggerError)); return; }
  if (!o.noEnd && resHandlers.end) resHandlers.end();
}

// 让 getJson 的 Promise 与上面的手工驱动对齐：先拿到请求对象，再驱动
async function run(script) {
  const f = fakeNet();
  const http = createHttpGet({ net: f.net, logE: () => {} });
  const p = script(f, http);
  return p;
}

test('正常响应：解析出 JSON 并带上状态码与耗时', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer sk-x' } });
    await Promise.resolve();
    respond(f.requests[0], 200, JSON.stringify({ is_available: true, balance_infos: [] }));
    return p;
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.is_available, true);
  assert.strictEqual(typeof r.latencyMs, 'number');
});

test('必须显式设置 redirect=manual（否则密钥会被带到跳转目标）', async () => {
  await run(async (f, http) => {
    const p = http.getJson('https://x.example.com/a');
    await Promise.resolve();
    respond(f.requests[0], 200, '{}');
    await p;
    return null;
  }).then(() => {});
  const f = fakeNet();
  const http = createHttpGet({ net: f.net, logE: () => {} });
  const p = http.getJson('https://api.deepseek.com/user/balance');
  await Promise.resolve();
  assert.strictEqual(f.requests[0].opts.redirect, 'manual', '未设置 redirect=manual，跳转会把 Authorization 带出去');
  respond(f.requests[0], 200, '{}');
  await p;
});

test('遇到 3xx 一律失败并中断请求（绝不跟随）', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://api.deepseek.com/user/balance', { headers: { Authorization: 'Bearer sk-secret' } });
    await Promise.resolve();
    respond(f.requests[0], 302, '');
    const out = await p;
    out._aborted = f.state.aborted;
    return out;
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 302);
  assert.match(r.error, /跳转/);
  assert.strictEqual(r._aborted, 1, '必须 abort 掉这次请求');
});

test('非 2xx 也把平台给的 JSON 带回来（主进程据此显示原因）', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://api.deepseek.com/user/balance');
    await Promise.resolve();
    respond(f.requests[0], 401, JSON.stringify({ error: { message: 'Authentication Fails' } }));
    return p;
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.json.error.message, 'Authentication Fails');
});

test('2xx 但不是合法 JSON → 明确报错，不返回半个对象', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://x.example.com/a');
    await Promise.resolve();
    respond(f.requests[0], 200, '<html>网关登录页</html>');
    return p;
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /不是合法 JSON/);
  assert.ok(r.text.indexOf('网关登录页') !== -1, '应保留一小段正文供排查');
});

test('响应体积超过上限时中断', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://x.example.com/a', { maxBytes: 100 });
    await Promise.resolve();
    respond(f.requests[0], 200, 'x'.repeat(400));
    const out = await p;
    out._aborted = f.state.aborted;
    return out;
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /过大/);
  assert.ok(r._aborted >= 1);
});

test('超时被当作失败', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://x.example.com/a', { timeoutMs: 5000 });
    await Promise.resolve();
    respond(f.requests[0], 200, '{}', { triggerTimeout: true });
    return p;
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /超时/);
});

test('网络错误被翻译成人话', async () => {
  const r = await run(async (f, http) => {
    const p = http.getJson('https://x.example.com/a');
    await Promise.resolve();
    f.requests[0]._handlers.error(new Error('ECONNRESET'));
    return p;
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /网络错误/);
  assert.match(r.error, /ECONNRESET/);
});

test('网络模块不可用时立刻失败，而不是挂住', async () => {
  const http = createHttpGet({ net: undefined, logE: () => {} });
  const r = await http.getJson('https://x.example.com/a');
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /网络模块不可用/);
});

test('错误信息里不得出现密钥', async () => {
  const secret = 'sk-super-secret-key-0123456789';
  const r = await run(async (f, http) => {
    const p = http.getJson('https://x.example.com/a', { headers: { Authorization: 'Bearer ' + secret } });
    await Promise.resolve();
    // 让底层错误里带上密钥（真实场景里的确可能这样冒出来）
    f.requests[0]._handlers.error(new Error('connect failed with header Bearer ' + secret));
    return p;
  });
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.indexOf(secret) === -1, '错误信息泄露了密钥：' + r.error);
  assert.match(r.error, /\*\*\*\*/);
});

test('redact：密钥与 Bearer 头都会被抹掉', () => {
  const secret = 'sk-abcdefghijklmnop';
  assert.strictEqual(redact('key=' + secret, secret), 'key=****');
  assert.strictEqual(redact('Authorization: Bearer sk-abcdefghijklmnop', ''), 'Authorization: Bearer ****');
  assert.strictEqual(redact('', secret), '');
  assert.strictEqual(redact(null, secret), '');
  // 太短的串不做替换，避免把正常文本误伤成星号
  assert.strictEqual(redact('abc', 'abc'), 'abc');
});

test('请求头如实带上 Accept 与调用方给的头', async () => {
  const f = fakeNet();
  const http = createHttpGet({ net: f.net, logE: () => {} });
  const p = http.getJson('https://x.example.com/a', { headers: { Authorization: 'Bearer k' } });
  await Promise.resolve();
  const h = f.requests[0].opts.headers;
  assert.strictEqual(h.Accept, 'application/json');
  assert.strictEqual(h.Authorization, 'Bearer k');
  respond(f.requests[0], 200, '{}');
  await p;
  assert.strictEqual(f.requests[0]._ended, true, '必须真的 end() 出去');
});
