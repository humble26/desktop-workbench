'use strict';

/* ===========================================================================
   补丁守卫：校验渲染层提交的补丁形状、体积与字段白名单
   ---------------------------------------------------------------------------
   渲染层是本应用的「用户输入」，进程边界不因为它是自家代码就免检：
   · 只允许 collections / settings / top 三个顶层字段
   · 只允许 todos/notes/checkins/shortcuts/groups 五个集合与 order/upsert/remove 三种操作
   · 拒绝借 top 写入界面状态字段（那些字段不该出现在数据文件里）
   · 限制单次提交的体积与条数，避免异常状态下写爆内存/磁盘
   纯函数、无依赖，可单测。
   =========================================================================== */

const KNOWN_TOP = ['collections', 'settings', 'top'];
const KNOWN_OPS = ['order', 'upsert', 'remove'];

const DEFAULT_LIMITS = {
  maxBytes: 4 * 1024 * 1024,   // 补丁序列化后的上限
  maxUpserts: 5000,            // 单个集合单次提交的条目数上限
  maxOrder: 20000,             // 顺序数组长度上限
  maxRemoves: 20000            // 删除条数上限
};

/**
 * @returns {string|null} 出错原因；null 表示通过
 */
function validatePatch(patch, opts) {
  const o = opts || {};
  const collections = o.collections || ['todos', 'notes', 'checkins', 'shortcuts', 'groups'];
  const ephemeral = o.ephemeralKeys || [];
  const limits = Object.assign({}, DEFAULT_LIMITS, o.limits || {});

  if (patch === null || patch === undefined) return null;         // 空提交是合法的（无改动）
  if (typeof patch !== 'object' || Array.isArray(patch)) return '补丁必须是对象';

  for (const k of Object.keys(patch)) {
    if (KNOWN_TOP.indexOf(k) === -1) return '补丁含未知字段：' + k;
  }

  if (patch.collections !== undefined && patch.collections !== null) {
    if (typeof patch.collections !== 'object' || Array.isArray(patch.collections)) return 'collections 必须是对象';
    for (const name of Object.keys(patch.collections)) {
      if (collections.indexOf(name) === -1) return '未知集合：' + name;
      const ops = patch.collections[name];
      if (!ops || typeof ops !== 'object' || Array.isArray(ops)) return name + ' 的操作必须是对象';
      for (const k of Object.keys(ops)) {
        if (KNOWN_OPS.indexOf(k) === -1) return name + ' 含未知操作：' + k;
      }
      if (ops.upsert !== undefined) {
        if (!Array.isArray(ops.upsert)) return name + ' upsert 必须是数组';
        if (ops.upsert.length > limits.maxUpserts) return name + ' 单次提交条目过多（' + ops.upsert.length + '）';
        for (const it of ops.upsert) {
          if (!it || typeof it !== 'object' || Array.isArray(it)) return name + ' upsert 条目必须是对象';
          if (it.id === undefined || it.id === null) return name + ' upsert 条目缺少 id';
        }
      }
      if (ops.remove !== undefined) {
        if (!Array.isArray(ops.remove)) return name + ' remove 必须是数组';
        if (ops.remove.length > limits.maxRemoves) return name + ' 单次删除过多（' + ops.remove.length + '）';
      }
      if (ops.order !== undefined) {
        if (!Array.isArray(ops.order)) return name + ' order 必须是数组';
        if (ops.order.length > limits.maxOrder) return name + ' 顺序数组过长（' + ops.order.length + '）';
      }
    }
  }

  if (patch.settings !== undefined && patch.settings !== null) {
    if (typeof patch.settings !== 'object' || Array.isArray(patch.settings)) return 'settings 必须是对象';
  }

  if (patch.top !== undefined && patch.top !== null) {
    if (typeof patch.top !== 'object' || Array.isArray(patch.top)) return 'top 必须是对象';
    for (const k of Object.keys(patch.top)) {
      if (ephemeral.indexOf(k) !== -1) return '不允许写入界面状态字段：' + k;
      if (KNOWN_TOP.indexOf(k) !== -1 || k === 'settings') return 'top 不允许覆盖：' + k;
    }
  }

  let size = 0;
  try {
    size = Buffer.byteLength(JSON.stringify(patch), 'utf8');
  } catch (e) {
    return '补丁无法序列化';
  }
  if (size > limits.maxBytes) return '补丁过大（' + size + ' 字节，上限 ' + limits.maxBytes + '）';

  return null;
}

module.exports = { validatePatch, DEFAULT_LIMITS, KNOWN_TOP, KNOWN_OPS };
