'use strict';

/* ===========================================================================
   AI 平台密钥：独立文件 + 系统级加密
   ---------------------------------------------------------------------------
   为什么不能把 API Key 塞进 workbench-data.json：
     · 那份数据会被「导出数据」写成明文 JSON 交给用户，也会进自动备份目录；
     · 它是渲染层提交补丁的目标，密钥会因此穿过进程边界来回搬。
   所以密钥单独存在 <userData>/ai-keys.json，与主数据、导出、备份完全隔离，
   并且**用 Electron safeStorage 加密后再落盘**（Windows 下由 DPAPI 保护，
   密文绑定当前 Windows 用户，拷到别的机器/别的用户下解不开）。

   两条硬规则：
     1. safeStorage 不可用时**拒绝写入**，而不是退回明文 —— 宁可功能不可用，
        也不能悄悄把密钥明文留在磁盘上。
     2. 渲染层只能「写入」和「看到掩码」，永远拿不到明文：
        本模块的 get() 只在主进程内部使用，IPC 只暴露 list()（掩码）。
   =========================================================================== */

const fs = require('fs');
const path = require('path');

const KEYFILE_VERSION = 1;

/**
 * @param {object} deps
 * @param {() => string} deps.filePath    ai-keys.json 的绝对路径
 * @param {object} deps.safeStorage       electron.safeStorage
 * @param {(where: string, e: unknown) => void} [deps.logE]
 */
function createKeyStore(deps) {
  const o = deps || {};
  const filePath = o.filePath;
  const safeStorage = o.safeStorage;
  const logE = o.logE || (() => {});

  let cache = null;          // { version, keys: { id: { enc, at } } }
  let loadError = null;

  function encryptionAvailable() {
    try { return !!(safeStorage && safeStorage.isEncryptionAvailable && safeStorage.isEncryptionAvailable()); }
    catch (e) { return false; }
  }

  // 仅用于把「这串数据是不是密文」讲清楚；不参与任何安全判断
  function backendName() {
    if (!encryptionAvailable()) return '不可用';
    if (process.platform === 'win32') return 'DPAPI（当前 Windows 用户）';
    if (process.platform === 'darwin') return '钥匙串';
    return '系统密钥环';
  }

  function empty() { return { version: KEYFILE_VERSION, keys: {} }; }

  function load() {
    if (cache) return cache;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath(), 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.keys && typeof parsed.keys === 'object') {
        cache = {
          version: typeof parsed.version === 'number' ? parsed.version : KEYFILE_VERSION,
          keys: parsed.keys
        };
      } else {
        cache = empty();
      }
      loadError = null;
    } catch (e) {
      cache = empty();
      // 文件不存在是正常的（还没配过任何密钥），只有解析失败才值得记一笔
      if (e && e.code !== 'ENOENT') loadError = String((e && e.message) || e);
    }
    return cache;
  }

  function persist() {
    const f = filePath();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(load()), 'utf8');
    fs.renameSync(tmp, f);
  }

  /**
   * 保存一个平台的密钥（覆盖同名）。
   * @returns {{ok:boolean, masked?:string, error?:string}}
   */
  function set(id, plainKey) {
    const pid = String(id || '').toLowerCase();
    const key = String(plainKey == null ? '' : plainKey).replace(/^[\s"']+|[\s"']+$/g, '');
    if (!pid) return { ok: false, error: '缺少平台标识' };
    if (!key) return { ok: false, error: '密钥为空' };
    if (key.length > 512) return { ok: false, error: '密钥过长（超过 512 字符）' };
    if (!encryptionAvailable()) {
      return {
        ok: false,
        error: '当前系统的安全存储不可用（safeStorage），为避免把密钥明文写进磁盘，已拒绝保存'
      };
    }
    try {
      const enc = safeStorage.encryptString(key).toString('base64');
      const d = load();
      d.keys[pid] = { enc: enc, at: Date.now() };
      persist();
      return { ok: true, masked: maskOf(key) };
    } catch (e) {
      logE('ai.keystore.set', e);
      return { ok: false, error: '加密保存失败：' + String((e && e.message) || e) };
    }
  }

  /** 主进程内部使用：取明文密钥。渲染层永远不该拿到这个返回值。 */
  function get(id) {
    const pid = String(id || '').toLowerCase();
    const rec = load().keys[pid];
    if (!rec || !rec.enc) return '';
    if (!encryptionAvailable()) return '';
    try {
      return safeStorage.decryptString(Buffer.from(rec.enc, 'base64'));
    } catch (e) {
      // 换机器 / 换 Windows 用户 / 系统凭据被重置后解不开，这是预期内的情况
      logE('ai.keystore.get', e);
      return '';
    }
  }

  // 只用于回显的掩码。这里刻意不调用 safeStorage：掩码不该依赖能否解密成功。
  function maskOf(key) {
    const s = String(key || '');
    if (!s) return '';
    if (s.length <= 8) return '****';
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  /**
   * 给界面看的清单：只有掩码与时间，没有明文。
   * 掩码需要解密才能算出来 —— 解不开时给出 '****' 而不是暴露密文。
   * @returns {Record<string, {masked:string, at:number, readable:boolean}>}
   */
  function list() {
    const out = {};
    const d = load();
    for (const id of Object.keys(d.keys)) {
      const rec = d.keys[id] || {};
      const plain = get(id);
      out[id] = {
        masked: plain ? maskOf(plain) : '****',
        at: Number(rec.at) || 0,
        readable: !!plain
      };
    }
    return out;
  }

  function has(id) {
    const rec = load().keys[String(id || '').toLowerCase()];
    return !!(rec && rec.enc);
  }

  /** @returns {{ok:boolean, removed:boolean}} */
  function remove(id) {
    const pid = String(id || '').toLowerCase();
    const d = load();
    if (!d.keys[pid]) return { ok: true, removed: false };
    delete d.keys[pid];
    try { persist(); } catch (e) { logE('ai.keystore.remove', e); return { ok: false, removed: false }; }
    return { ok: true, removed: true };
  }

  function clear() {
    cache = empty();
    try { persist(); } catch (e) { logE('ai.keystore.clear', e); }
    return { ok: true };
  }

  return {
    set,
    get,
    list,
    has,
    remove,
    clear,
    encryptionAvailable,
    backendName,
    lastError: () => loadError
  };
}

module.exports = { createKeyStore, KEYFILE_VERSION };
