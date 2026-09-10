'use strict';

/* ===========================================================================
   图标缓存：把快捷方式/文件图标落成独立 PNG 文件，数据文件里只存短引用
   ---------------------------------------------------------------------------
   背景：旧实现把图标以 base64 data URL 直接塞进 state.shortcuts[].icon，
   每个图标 5–20KB，几十个快捷方式就让 workbench-data.json 膨胀到几百 KB，
   而渲染层每次改动都会重新序列化整个数据文件。
   现在：图标写到 <userData>/icons/<sha1>.png，数据文件里只留 `icon:<sha1>.png`，
   渲染层拿到的仍是可直接用于 <img src> 的 file:// URL（CSP img-src 已放行 file:）。

   本模块不依赖 electron（目录由调用方注入），便于单测。
   =========================================================================== */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');

const REF_PREFIX = 'icon:';
const REF_RE = /^icon:[0-9a-f]{8,64}\.png$/;          // 只接受本模块生成的引用，杜绝路径穿越

function dataUrlToBuffer(dataUrl) {
  const m = /^data:image\/(png|jpeg|webp|gif|x-icon|vnd\.microsoft\.icon);base64,([A-Za-z0-9+/=\s]+)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  try {
    return Buffer.from(m[2].replace(/\s/g, ''), 'base64');
  } catch (e) {
    return null;
  }
}

function createIconCache(opts) {
  const options = opts || {};
  const dir = options.dir;
  const maxFiles = Number.isFinite(options.maxFiles) ? options.maxFiles : 300;
  const log = typeof options.log === 'function' ? options.log : () => {};

  function ensureDir() {
    try { fs.mkdirSync(dir, { recursive: true }); return true; } catch (e) { return false; }
  }

  // 存一个图标（data URL）→ { ref, url }；失败返回 null（调用方退回内联 data URL）
  function store(dataUrl) {
    const buf = dataUrlToBuffer(dataUrl);
    if (!buf || buf.length < 60) return null;
    if (!ensureDir()) return null;
    try {
      const hash = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 40);
      const name = hash + '.png';
      const full = path.join(dir, name);
      if (!fs.existsSync(full)) fs.writeFileSync(full, buf);
      return { ref: REF_PREFIX + name, url: pathToFileURL(full).href, name: name };
    } catch (e) {
      log('图标写盘失败：' + String((e && e.message) || e));
      return null;
    }
  }

  /* 从「引用」或「本缓存目录的 file:// URL」解析出文件名；
     其它任何形式（含 ../ 路径穿越、外部 URL）一律返回 null。 */
  function nameOf(value) {
    const s = String(value || '');
    if (REF_RE.test(s)) return s.slice(REF_PREFIX.length);
    if (/^file:/i.test(s)) {
      try {
        const p = path.resolve(fileURLToPath(s));
        if (path.dirname(p) !== path.resolve(dir)) return null;
        const base = path.basename(p);
        return /^[0-9a-f]{8,64}\.png$/.test(base) ? base : null;
      } catch (e) {
        return null;
      }
    }
    return null;
  }

  function resolveRef(ref) {
    const name = nameOf(ref);
    if (!name) return null;
    const full = path.join(dir, name);
    // 双保险：解析结果必须仍在缓存目录内
    if (path.dirname(path.resolve(full)) !== path.resolve(dir)) return null;
    return full;
  }

  function urlOf(ref) {
    const full = resolveRef(ref);
    return full ? pathToFileURL(full).href : null;
  }

  function isRef(v) { return REF_RE.test(String(v || '')); }

  // 清理：保留 keepRefs 里被引用的文件；再按修改时间保留最近 maxFiles 个
  function prune(keepRefs) {
    const keep = new Set();
    for (const r of (keepRefs || [])) {
      const n = nameOf(r);
      if (n) keep.add(n);
    }
    let removed = 0;
    try {
      if (!fs.existsSync(dir)) return { removed: 0, kept: 0 };
      const files = fs.readdirSync(dir).filter(f => /\.png$/.test(f));
      const stats = files.map(f => {
        let mtime = 0;
        try { mtime = fs.statSync(path.join(dir, f)).mtimeMs; } catch (e) { /* ignore */ }
        return { f: f, mtime: mtime };
      }).sort((a, b) => b.mtime - a.mtime);

      stats.forEach((s, i) => {
        const needed = keep.has(s.f) || i < maxFiles;
        if (needed) return;
        try { fs.unlinkSync(path.join(dir, s.f)); removed++; } catch (e) { /* ignore */ }
      });
      return { removed: removed, kept: stats.length - removed };
    } catch (e) {
      return { removed: removed, kept: 0 };
    }
  }

  // 统计：用于诊断页展示
  function stats() {
    try {
      if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
      const files = fs.readdirSync(dir).filter(f => /\.png$/.test(f));
      let bytes = 0;
      for (const f of files) {
        try { bytes += fs.statSync(path.join(dir, f)).size; } catch (e) { /* ignore */ }
      }
      return { files: files.length, bytes: bytes };
    } catch (e) {
      return { files: 0, bytes: 0 };
    }
  }

  return {
    dir: dir,
    store: store,
    urlOf: urlOf,
    resolveRef: resolveRef,
    isRef: isRef,
    nameOf: nameOf,
    prune: prune,
    stats: stats
  };
}

module.exports = { createIconCache, REF_PREFIX, REF_RE, dataUrlToBuffer };
