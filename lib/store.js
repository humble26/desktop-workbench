'use strict';

/* ===========================================================================
   数据仓库：workbench-data.json 的唯一写入者
   ---------------------------------------------------------------------------
   职责：
     · 内存缓存（read() 不再每次读盘 + JSON.parse）
     · 修订号（rev）：每次内容变化 +1，渲染层据此判断要不要回灌
     · 补丁提交：渲染层只提交差异，由这里应用到权威副本上
     · 原子落盘 + 写合并（默认 150ms 合并窗口，退出/备份前 flush）
     · 损坏自愈：主文件读不出来或非法 JSON 时，从 backups/ 由新到旧回溯恢复
     · 结构升级前的自动备份（一次性，不会被常规备份清理掉）

   本模块不依赖 electron，构造参数全部注入，便于单元测试。
   =========================================================================== */

const fs = require('fs');
const path = require('path');
const proto = require('../renderer/storeproto.js');

const BACKUP_RE = /^workbench-[\d-]+\.json$/;
const PREMIGRATE_RE = /^workbench-premigrate-[\d-]+\.json$/;

function pad2(n) { return String(n).padStart(2, '0'); }
function stamp(d) {
  d = d || new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}` +
    `-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}
function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

function createStore(opts) {
  const options = opts || {};
  const filePath = options.filePath;
  const backupDir = options.backupDir || path.join(path.dirname(filePath), 'backups');
  const defaults = typeof options.defaults === 'function' ? options.defaults : () => ({});
  const migrate = typeof options.migrate === 'function' ? options.migrate : (d) => ({ changed: false, steps: [] });
  const debounceMs = Number.isFinite(options.debounceMs) ? options.debounceMs : 150;
  const keepBackups = Number.isFinite(options.keepBackups) ? options.keepBackups : 12;
  const log = typeof options.log === 'function' ? options.log : () => {};

  let data = null;              // 权威副本（内存缓存）
  let rev = 0;
  let loaded = false;
  let writeTimer = null;
  let dirty = false;
  let lastError = null;
  let lastRecovery = null;      // { name } / null
  let lastMigration = null;     // { from, to, steps }
  const listeners = [];

  // ---------------------------------------------------------------- 事件
  function emit(info) {
    for (const cb of listeners.slice()) {
      try { cb(info); } catch (e) { /* 单个监听器异常不影响落盘 */ }
    }
  }

  // ---------------------------------------------------------------- 落盘
  function atomicWrite(payload) {
    const tmp = filePath + '.tmp';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, filePath);   // 同目录 rename 覆盖，避免半截文件
  }

  function writeNow() {
    if (!loaded) return false;
    try {
      atomicWrite(data);
      dirty = false;
      lastError = null;
      return true;
    } catch (e) {
      lastError = String((e && e.message) || e);
      log('写入失败: ' + lastError);
      return false;
    }
  }

  function scheduleWrite() {
    dirty = true;
    if (writeTimer) return;
    writeTimer = setTimeout(() => { writeTimer = null; writeNow(); }, debounceMs);
    if (writeTimer.unref) writeTimer.unref();
  }

  function flush() {
    if (writeTimer) { clearTimeout(writeTimer); writeTimer = null; }
    if (!dirty) return true;
    return writeNow();
  }

  // ---------------------------------------------------------------- 备份
  function backupPath(prefix) {
    fs.mkdirSync(backupDir, { recursive: true });
    return path.join(backupDir, prefix + stamp() + '.json');
  }

  function pruneBackups() {
    try {
      const files = fs.readdirSync(backupDir).filter(f => BACKUP_RE.test(f)).sort();
      while (files.length > keepBackups) {
        try { fs.unlinkSync(path.join(backupDir, files.shift())); } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  // 立即备份当前数据文件；返回备份路径（无数据/失败返回 null）
  function backup() {
    try {
      flush();                                     // 保证备份到的是最新内容
      if (!fs.existsSync(filePath)) return null;
      const dest = backupPath('workbench-');
      fs.copyFileSync(filePath, dest);
      pruneBackups();
      return dest;
    } catch (e) {
      log('备份失败: ' + String((e && e.message) || e));
      return null;
    }
  }

  function listBackups() {
    try {
      if (!fs.existsSync(backupDir)) return [];
      return fs.readdirSync(backupDir)
        .filter(f => BACKUP_RE.test(f))
        .sort()
        .reverse()
        .map(f => {
          const full = path.join(backupDir, f);
          let size = 0;
          try { size = fs.statSync(full).size; } catch (e) { /* ignore */ }
          return { name: f, path: full, size: size };
        });
    } catch (e) {
      return [];
    }
  }

  // 结构升级前的一次性备份：文件名不匹配常规备份规则，因此不会被轮转清理
  function preMigrationBackup() {
    try {
      if (!fs.existsSync(filePath)) return null;
      const dest = backupPath('workbench-premigrate-');
      fs.copyFileSync(filePath, dest);
      return dest;
    } catch (e) {
      return null;
    }
  }

  // ---------------------------------------------------------------- 读取与自愈
  function readPrimary() {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!isObj(parsed)) throw new Error('数据文件根结构不是对象');
    return parsed;
  }

  function buildInitial(parsed) {
    const def = defaults();
    const out = Object.assign({}, def, isObj(parsed) ? parsed : {});
    out.settings = Object.assign({}, isObj(def.settings) ? def.settings : {}, isObj(out.settings) ? out.settings : {});
    return out;
  }

  // 主文件损坏时的自愈：从 backups/ 由新到旧找第一份可解析的备份
  function recoverFromBackups() {
    for (const b of listBackups()) {
      try {
        const parsed = JSON.parse(fs.readFileSync(b.path, 'utf8'));
        if (!isObj(parsed)) continue;
        lastRecovery = { name: b.name };
        log('主数据损坏，已从备份恢复: ' + b.name);
        return parsed;
      } catch (e) { /* 该备份也坏了，继续往前找 */ }
    }
    return null;
  }

  function load() {
    if (loaded) return data;
    let parsed = null;
    let existed = false;
    try {
      existed = fs.existsSync(filePath);
      parsed = readPrimary();
    } catch (e) {
      parsed = null;
    }
    if (!parsed) {
      // 与旧行为保持一致：主文件损坏或缺失时都尝试从备份自愈（全新安装无备份则走默认值）
      parsed = recoverFromBackups();
    }
    data = buildInitial(parsed || {});
    loaded = true;
    const isNewFile = !existed;

    const result = migrate(data) || {};
    if (result.changed) {
      lastMigration = { from: result.from, to: result.to, steps: result.steps || [] };
      if (existed) preMigrationBackup();
      if (result.from !== result.to) log('数据结构已升级: v' + result.from + ' → v' + result.to);
      else log('数据归一化: ' + (result.steps || []).join('；'));
    }
    /* 只在「确实需要」时落盘：首次运行建立文件、从备份恢复、或结构有改动。
       内容没变就不写，避免每次启动都重写数据文件。 */
    if (isNewFile || lastRecovery || result.changed) {
      dirty = true;
      writeNow();
    }
    return data;
  }

  function read() {
    return loaded ? data : load();
  }

  // ---------------------------------------------------------------- 变更入口
  function bump(origin, changed) {
    if (!changed) return { ok: true, rev: rev, changed: false };
    rev++;
    scheduleWrite();
    emit({ rev: rev, origin: origin || 'main' });
    return { ok: true, rev: rev, changed: true };
  }

  /* 应用渲染层提交的补丁。patch 只描述差异，因此主进程的并发写入不会被覆盖。
     渲染层的提交是离散的用户操作（保存即用户预期已落盘），所以这里立即落盘，
     不做写合并；写合并只留给主进程内部的高频路径（mutate/adopt）。 */
  function commit(patch) {
    const before = read();
    if (!isObj(patch)) return { ok: true, rev: rev, changed: false, data: before };
    const next = proto.applyPatch(before, patch);
    if (proto.deepEqual(before, next)) return { ok: true, rev: rev, changed: false, data: before };
    data = next;
    const r = bump('renderer', true);
    flush();
    return { ok: true, rev: r.rev, changed: true, data: data };
  }

  /* 主进程自有写入：fn 就地修改权威副本；返回 false 表示无需落盘。 */
  function mutate(fn, opts2) {
    const d = read();
    let changed = true;
    try {
      changed = fn(d) !== false;
    } catch (e) {
      log('变更失败: ' + String((e && e.message) || e));
      return { ok: false, rev: rev, changed: false };
    }
    const r = bump((opts2 && opts2.origin) || 'main', changed);
    if (r.changed && opts2 && opts2.now) flush();
    return r;
  }

  /* 接受调用方持有并已就地修改过的权威对象（历史 saveStore(data) 写法）。
     传入对象与内部权威副本不同引用时，以传入对象为准。 */
  function adopt(next) {
    const d = read();
    if (isObj(next) && next !== d) data = next;
    return bump('main', true);
  }

  function replace(next) {
    data = buildInitial(next);
    loaded = true;
    const result = migrate(data) || {};
    if (result.changed) lastMigration = { from: result.from, to: result.to, steps: result.steps || [] };
    return bump('main', true);
  }

  function diagnostics() {
    return {
      file: filePath,
      rev: rev,
      loaded: loaded,
      dirty: dirty,
      lastError: lastError,
      recoveredFrom: lastRecovery ? lastRecovery.name : null,
      migrated: lastMigration
    };
  }

  return {
    read: read,
    load: load,
    getRev: () => rev,
    snapshot: () => proto.snapshot(read()),
    commit: commit,
    mutate: mutate,
    adopt: adopt,
    replace: replace,
    flush: flush,
    backup: backup,
    listBackups: listBackups,
    diagnostics: diagnostics,
    on: (cb) => { if (typeof cb === 'function') listeners.push(cb); },
    isDirty: () => dirty
  };
}

module.exports = { createStore: createStore, BACKUP_RE: BACKUP_RE, PREMIGRATE_RE: PREMIGRATE_RE };
