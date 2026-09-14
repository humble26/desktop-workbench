'use strict';

/* ===========================================================================
   AI 平台余额监测：极简 HTTPS 取 JSON
   ---------------------------------------------------------------------------
   本应用此前**没有任何业务网络请求**（唯一的联网行为是「检查更新」读用户自己
   填写的清单地址）。引入余额监测后，网络行为必须被限制到最小可信范围，
   因此这里把每一条约束都写成代码而不是注释：

     · 只允许 https（http 仅放行本机回环，自建中转常见于 localhost）
     · redirect = 'manual'：**不跟随跳转**。
       这是本文件最重要的一个决定 —— 一旦跟随 302，Authorization 头会被带到
       跳转目标域，等于把 API Key 送给了第三方。遇到 3xx 直接当失败。
     · 硬超时 + 响应体积上限（余额响应只有几百字节，4MB 上限纯属防御）
     · 错误信息里绝不出现密钥（统一经 redact 处理）

   net 由调用方注入（main.js 传 electron.net），因此本模块可以在没有 Electron 的
   环境里用替身做单测（见 test/ai-http.test.js）。
   =========================================================================== */

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_MAX_BYTES = 256 * 1024;

/* Chromium 在 redirect: 'manual' 下拒掉跳转时，抛的是这个错。
   实测（tools/diagnose/probe-ai-http.js，真实 Electron）走的是 **error 分支**而不是
   「收到 3xx 响应」——也就是说第 3 步的 3xx 判断在真实环境里基本用不上，
   但安全效果相同：请求被中止，Authorization 不会被带到目标域。
   问题是原样显示这句英文对使用者毫无帮助，所以这里翻译成能照着做的中文。 */
const REDIRECT_RE = /redirect/i;

function friendlyNetworkError(raw) {
  const s = String(raw == null ? '' : raw);
  if (REDIRECT_RE.test(s)) {
    return '服务端要求跳转，出于安全考虑已中止（跟随跳转会把密钥交给目标域名）。'
      + '请把这个平台的接口地址改成最终的直连地址。';
  }
  return '网络错误：' + s;
}

// 兜底：任何可能被打进日志/界面的文本都过一遍，确保密钥不会外泄
function redact(text, secret) {
  let s = String(text == null ? '' : text);
  const k = String(secret == null ? '' : secret);
  if (k.length >= 8) s = s.split(k).join('****');
  s = s.replace(/(Bearer\s+)[\w.\-]{6,}/gi, '$1****');
  return s;
}

/**
 * @param {object} deps
 * @param {object} deps.net                electron.net（或测试替身）
 * @param {(where: string, e: unknown) => void} [deps.logE]
 */
function createHttpGet(deps) {
  const o = deps || {};
  const net = o.net;
  const logE = o.logE || (() => {});

  /**
   * 取一个 JSON。**不抛异常**，一切失败都变成 { ok:false, error }。
   * @param {string} url
   * @param {object} [opts]
   * @param {Record<string,string>} [opts.headers]
   * @param {number} [opts.timeoutMs]
   * @param {number} [opts.maxBytes]
   * @returns {Promise<{ok:boolean,status:number,json:any,text:string,error?:string,latencyMs:number}>}
   */
  function getJson(url, opts) {
    const cfg = opts || {};
    const timeoutMs = Number(cfg.timeoutMs) > 0 ? Number(cfg.timeoutMs) : DEFAULT_TIMEOUT_MS;
    const maxBytes = Number(cfg.maxBytes) > 0 ? Number(cfg.maxBytes) : DEFAULT_MAX_BYTES;
    const started = Date.now();
    const secretHint = (cfg.headers && (cfg.headers.Authorization || cfg.headers.authorization)) || '';

    return new Promise((resolve) => {
      const done = (res) => {
        res.latencyMs = Date.now() - started;
        if (res.error) res.error = redact(res.error, secretHint);
        resolve(res);
      };
      const fail = (msg, status) => done({ ok: false, status: status || 0, json: null, text: '', error: msg });

      if (!net || typeof net.request !== 'function') { fail('网络模块不可用'); return; }

      let req;
      try {
        req = net.request({
          url: url,
          method: 'GET',
          redirect: 'manual',                                  // ← 见文件头：绝不跟随跳转
          headers: Object.assign({ Accept: 'application/json' }, cfg.headers || {})
        });
      } catch (e) {
        fail('请求创建失败：' + redact(String((e && e.message) || e), secretHint));
        return;
      }

      let settled = false;
      const settle = (res) => { if (!settled) { settled = true; done(res); } };
      const settleFail = (msg, status) => { if (!settled) { settled = true; fail(msg, status); } };

      try {
        req.on('response', (res) => {
          const status = res.statusCode || 0;
          // 3xx：manual 模式下不会被自动跟随，但必须明确拒绝，
          // 否则「重定向到别处」就成了一个把密钥引出去的手法。
          if (status >= 300 && status < 400) {
            try { req.abort(); } catch (e) { /* ignore */ }
            settleFail('服务端返回了跳转（HTTP ' + status + '），出于安全考虑不跟随', status);
            return;
          }
          const chunks = [];
          let size = 0;
          res.on('data', (c) => {
            size += c.length;
            if (size > maxBytes) {
              try { req.abort(); } catch (e) { /* ignore */ }
              settleFail('响应过大（超过 ' + Math.round(maxBytes / 1024) + ' KB），已中断', status);
              return;
            }
            chunks.push(c);
          });
          res.on('error', (e) => settleFail('读取响应出错：' + String((e && e.message) || e), status));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch (e) { json = null; }
            if (status < 200 || status >= 300) {
              // 非 2xx 也把能解析出来的正文带回去 —— 平台通常在里面写了原因
              settle({ ok: false, status: status, json: json, text: text.slice(0, 4000), error: '' });
              return;
            }
            if (json === null) {
              settle({ ok: false, status: status, json: null, text: text.slice(0, 400), error: '响应不是合法 JSON' });
              return;
            }
            settle({ ok: true, status: status, json: json, text: '', error: '' });
          });
        });
        req.on('error', (e) => settleFail(friendlyNetworkError((e && e.message) || e)));
        if (typeof req.setTimeout === 'function') {
          req.setTimeout(timeoutMs, () => {
            try { req.abort(); } catch (e) { /* ignore */ }
            settleFail('请求超时（' + timeoutMs + ' ms）');
          });
        }
        req.end();
      } catch (e) {
        logE('ai.http', e);
        settleFail('请求发送失败：' + redact(String((e && e.message) || e), secretHint));
      }
    });
  }

  return { getJson };
}

module.exports = { createHttpGet, redact, friendlyNetworkError, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_BYTES };
