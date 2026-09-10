'use strict';

/* ===========================================================================
   敏感内容识别（纯函数，可单测）
   ---------------------------------------------------------------------------
   剪贴板历史会把复制过的文本明文落盘。复制凭据是很常见的操作（部署脚本、
   配置文件、CI 日志），因此默认开启过滤：命中以下模式的内容不写入历史。
   用户可在「设置 · 剪贴板历史 · 敏感内容过滤」关闭。
   注意：这是「降低误存风险」而不是「安全边界」——模式总有漏网，
   不要把剪贴板历史当成保险箱。
   =========================================================================== */

const PATTERNS = [
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{4,}\.eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/ },
  { name: '私钥', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  /* 键值对形式的凭据。三个细节都是踩过的坑：
       1) 左边界用 (?:^|[^\w]) 而不是 \b —— \b 基于 ASCII 单词字符，
          在「登录口令：xxx」这种以中文开头的内容里不成立，会直接漏检；
       2) 值串限定为「不含括号的连续 token」，并用 (?![\w(]) 阻断回溯，
          这样 `const token = getToken();` 这种代码不会被误判成凭据；
       3) 值长度 ≥8，避免 `password=short` 之类的普通词被误伤。 */
  { name: '键值对凭据', re: /(?:^|[^\w])(?:password|passwd|pwd|secret|api[-_]?key|apikey|token|access[-_]?key|client[-_]?secret|登录口令|密码|口令)\s*[=:：]\s*['"]?[A-Za-z0-9+/=_.\-]{8,}['"]?(?![\w(])/i },
  { name: 'GitHub Token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: 'GitHub 细粒度 Token', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { name: 'Slack Token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: 'AWS Access Key', re: /\bAKIA[A-Z0-9]{16}\b/ },
  { name: 'Google API Key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: 'Stripe Key', re: /\b[sr]k_(?:live|test)_[0-9a-zA-Z]{16,}\b/ },
  { name: 'Bearer 头', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/ }
];

/**
 * @param {string} text 待检测文本
 * @returns {boolean} true 表示疑似敏感内容，不应写入剪贴板历史
 */
function isSensitiveText(text) {
  if (!text) return false;
  const s = String(text);
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].re.test(s)) return true;
  }
  return false;
}

// 命中的模式名（诊断/测试用；不返回原文，避免把敏感内容带进日志）
function sensitiveKind(text) {
  if (!text) return null;
  const s = String(text);
  for (let i = 0; i < PATTERNS.length; i++) {
    if (PATTERNS[i].re.test(s)) return PATTERNS[i].name;
  }
  return null;
}

module.exports = { isSensitiveText, sensitiveKind, PATTERNS };
