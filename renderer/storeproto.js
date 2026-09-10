'use strict';

/* ===========================================================================
   工作台数据协议（持久化结构 + 补丁差分/应用）
   ---------------------------------------------------------------------------
   被两侧共用：主进程 require()，渲染进程 <script src="storeproto.js">。
   故用 UMD 包装，不依赖任何 Electron / Node / 浏览器 API。

   位置说明：刻意与 index.html 同目录（而不是放进子目录），因为页面 CSP 是
   script-src 'self'，file:// 下跨目录脚本能否命中 'self' 并不可靠
   （本项目 CSS 为图片显式放行 file: 正说明这类坑）。同目录 = 与现有 app.js
   完全同一种加载方式，零新增风险。

   为什么要有补丁协议：
     旧实现里渲染层每次都把「整份 state」写回文件，而主进程也会写同一个文件
     （快速添加待办、重复待办逾期顺延、到期提醒打标记、小组件开关）。
     两个写者 + 整份覆盖 = 后写者必然丢掉前者的改动。
     现在改成：渲染层只提交「相对上一次已知服务端状态的差异」（补丁），
     由主进程把补丁应用到权威副本上，因此主进程的并发写入不会被覆盖。
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.WB = root.WB || {}; root.WB.proto = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {

  // 按 id 做增删改的集合型数据
  const COLLECTIONS = ['todos', 'notes', 'checkins', 'shortcuts', 'groups'];

  // 纯界面状态：只活在渲染进程内存里，绝不写入数据文件。
  // （历史上这些字段被整份 state 一起落盘，导致数据文件里混着 UI 状态）
  const EPHEMERAL_KEYS = [
    'view', '_calSel', '_calCursor', '_todoLv', '_todoFilter', '_pomo', '_exportedAt'
  ];

  // 旧版本写进数据文件的临时字段 → 新字段名（由 lib/migrate.js 迁移）
  const RENAMED = {
    '_pomoDone': 'pomoDone',
    '_remindedToday': 'remindedOn',
    '_dailyRemindDate': 'dailyRemindOn'
  };

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  // 结构化深比较（数据全部来自 JSON，因此只处理 JSON 能表达的类型）
  function deepEqual(a, b) {
    if (a === b) return true;
    if (a === null || b === null || a === undefined || b === undefined) return false;
    const ta = typeof a, tb = typeof b;
    if (ta !== tb) return false;
    if (ta !== 'object') return false;
    const aArr = Array.isArray(a), bArr = Array.isArray(b);
    if (aArr !== bArr) return false;
    if (aArr) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
      return true;
    }
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (let i = 0; i < ka.length; i++) {
      const k = ka[i];
      if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }

  // JSON 往返深拷贝：与 IPC 实际发生的序列化语义保持一致
  function clone(v) {
    if (v === undefined) return undefined;
    return JSON.parse(JSON.stringify(v));
  }

  // 去掉顶层界面状态（浅拷贝即可：只丢顶层键，不深改嵌套值）
  function stripEphemeral(data) {
    if (!isPlainObject(data)) return {};
    const out = {};
    for (const k of Object.keys(data)) {
      if (EPHEMERAL_KEYS.indexOf(k) !== -1) continue;
      out[k] = data[k];
    }
    return out;
  }

  // 服务端状态基线：必须是深拷贝，否则后续对 state 的就地修改会同时改到基线，
  // 差分就再也看不出变化，改动会被静默丢弃。
  function snapshot(data) {
    return clone(stripEphemeral(data));
  }

  function idOf(item) {
    if (!isPlainObject(item)) return null;
    return item.id === undefined || item.id === null ? null : item.id;
  }

  // 单个集合的差分：upsert 有变化的条目、remove 消失的条目、order 记录顺序
  function diffCollection(baseArr, nextArr) {
    const b = Array.isArray(baseArr) ? baseArr : [];
    const n = Array.isArray(nextArr) ? nextArr : [];
    const bMap = new Map();
    for (const it of b) {
      const id = idOf(it);
      if (id !== null) bMap.set(String(id), it);
    }
    const seen = new Set();
    const order = [];
    const upsert = [];
    for (const it of n) {
      const id = idOf(it);
      if (id === null) continue;              // 无 id 的脏数据不进集合
      seen.add(String(id));
      order.push(id);
      const prev = bMap.get(String(id));
      if (!prev || !deepEqual(prev, it)) upsert.push(it);
    }
    const remove = [];
    for (const it of b) {
      const id = idOf(it);
      if (id !== null && !seen.has(String(id))) remove.push(id);
    }
    // 顺序变化（含长度变化）也要同步，否则重排操作会丢
    let orderChanged = b.length !== order.length;
    if (!orderChanged) {
      for (let i = 0; i < order.length; i++) {
        const id = idOf(b[i]);
        if (id === null || String(id) !== String(order[i])) { orderChanged = true; break; }
      }
    }
    if (!upsert.length && !remove.length && !orderChanged) return null;
    return { order: order, upsert: upsert, remove: remove };
  }

  /* 计算补丁：base = 已知服务端状态，next = 当前本地状态（均已剥离界面状态）。
     返回 null 表示没有需要落盘的改动。 */
  function diffPatch(base, next) {
    const b = isPlainObject(base) ? base : {};
    const n = isPlainObject(next) ? next : {};
    const patch = { collections: {}, settings: null, top: null };
    let changed = false;

    for (const name of COLLECTIONS) {
      const ops = diffCollection(b[name], n[name]);
      if (ops) { patch.collections[name] = ops; changed = true; }
    }

    if (!deepEqual(b.settings, n.settings)) {
      const bs = isPlainObject(b.settings) ? b.settings : {};
      const ns = isPlainObject(n.settings) ? n.settings : {};
      const keys = new Set(Object.keys(bs).concat(Object.keys(ns)));
      const s = {};
      for (const k of keys) if (!deepEqual(bs[k], ns[k])) s[k] = ns[k];
      if (Object.keys(s).length) { patch.settings = s; changed = true; }
    }

    const skip = new Set(COLLECTIONS.concat(['settings']).concat(EPHEMERAL_KEYS));
    const top = {};
    const keys = new Set(Object.keys(b).concat(Object.keys(n)));
    for (const k of keys) {
      if (skip.has(k)) continue;
      if (!deepEqual(b[k], n[k])) top[k] = n[k];
    }
    if (Object.keys(top).length) { patch.top = top; changed = true; }

    return changed ? patch : null;
  }

  /* 应用补丁到权威副本。返回新对象，不修改入参。
     并发新增（主进程写进来、渲染层这次补丁里没有的条目）会被保留。 */
  function applyPatch(base, patch) {
    const out = Object.assign({}, isPlainObject(base) ? base : {});
    const cols = isPlainObject(patch) && isPlainObject(patch.collections) ? patch.collections : {};

    for (const name of Object.keys(cols)) {
      if (COLLECTIONS.indexOf(name) === -1) continue;   // 只接受已知集合，防脏补丁
      const ops = cols[name] || {};
      const current = Array.isArray(out[name]) ? out[name] : [];
      const byId = new Map();
      for (const it of current) {
        const id = idOf(it);
        if (id !== null) byId.set(String(id), it);
      }
      const removed = new Set((ops.remove || []).map(String));
      for (const id of removed) byId.delete(id);
      for (const it of (ops.upsert || [])) {
        const id = idOf(it);
        if (id === null) continue;
        byId.set(String(id), it);
      }
      const ordered = [];
      for (const id of (ops.order || [])) {
        const key = String(id);
        if (byId.has(key)) { ordered.push(byId.get(key)); byId.delete(key); }
      }
      /* 剩下的 = 渲染层这次没提到、但服务端已有的条目（主进程并发写入，例如
         全局快速添加的待办）。按它在服务端数组里的原始下标插回，
         这样「快速添加排在最前」这类语义不会被补丁打乱。 */
      const serverOnly = [];
      for (let i = 0; i < current.length; i++) {
        const id = idOf(current[i]);
        if (id === null) continue;
        if (byId.has(String(id))) serverOnly.push({ item: current[i], index: i });
      }
      for (const so of serverOnly) {
        const at = Math.min(Math.max(0, so.index), ordered.length);
        ordered.splice(at, 0, so.item);
      }
      out[name] = ordered;
    }

    if (isPlainObject(patch) && isPlainObject(patch.settings)) {
      out.settings = Object.assign({}, isPlainObject(out.settings) ? out.settings : {}, patch.settings);
    }
    if (isPlainObject(patch) && isPlainObject(patch.top)) {
      Object.assign(out, patch.top);
    }
    return out;
  }

  return {
    COLLECTIONS: COLLECTIONS,
    EPHEMERAL_KEYS: EPHEMERAL_KEYS,
    RENAMED: RENAMED,
    deepEqual: deepEqual,
    clone: clone,
    stripEphemeral: stripEphemeral,
    snapshot: snapshot,
    diffPatch: diffPatch,
    applyPatch: applyPatch
  };
});
