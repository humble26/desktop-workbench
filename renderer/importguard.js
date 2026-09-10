'use strict';

/* ===========================================================================
   导入数据守卫（UMD：渲染层 <script> 后取 WB.importguard，测试直接 require）
   ---------------------------------------------------------------------------
   导入的 JSON 是外部文件，可能是手改的、别的版本导出的、甚至完全不是本应用的
   数据。旧实现只做 JSON.parse 就整份赋给 state，于是：
     · groups[].items 不是数组 → 文件整理页直接崩
     · 设置里塞进任意键值 → 覆盖掉当前配置
     · autoOrganize 的 watch / to 指向相对路径或非法路径 → 自动整理乱搬文件
   这里按「白名单 + 类型校验 + 危险项回退」处理，宁可少导入也不要导入脏数据。
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.WB = root.WB || {}; root.WB.importguard = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {

  const COLLECTIONS = ['todos', 'notes', 'checkins', 'shortcuts', 'groups'];

  // Windows 绝对路径（含 UNC）；用于拒绝自动整理规则里的相对路径
  function isAbsPath(p) {
    return typeof p === 'string' && (/^[a-zA-Z]:[\\/]/.test(p) || p.indexOf('\\\\') === 0);
  }

  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* 集合与 settings/profile 的结构化清洗。
     传入任意 JSON，返回「结构可信」的导入对象（不修改入参）。 */
  function sanitizeImported(imp) {
    const s = isObj(imp) ? imp : {};
    const arr = (v) => (Array.isArray(v) ? v : []);
    const obj = (v) => (isObj(v) ? v : {});

    const out = {
      todos: arr(s.todos).filter(t => isObj(t)),
      notes: arr(s.notes).filter(n => isObj(n)),
      checkins: arr(s.checkins).filter(c => isObj(c)),
      shortcuts: arr(s.shortcuts).filter(x => isObj(x)),
      groups: arr(s.groups).filter(g => isObj(g)),
      settings: obj(s.settings),
      profile: obj(s.profile)
    };

    out.todos.forEach(t => {
      if (!Array.isArray(t.subtasks)) t.subtasks = [];
      if (!Array.isArray(t.doneHistory)) t.doneHistory = [];
    });
    out.groups.forEach(g => {
      if (!Array.isArray(g.items)) g.items = [];
      else g.items = g.items.filter(it => isObj(it));
    });
    // 快捷方式的图标引用只接受本应用缓存产物，避免导入外部 data: 大字符串把数据文件撑大
    out.shortcuts.forEach(x => {
      if (typeof x.icon === 'string' && x.icon.indexOf('data:') === 0) x.icon = null;
    });
    return out;
  }

  /* 设置合并：逐键覆盖当前设置，但 autoOrganize 必须整体校验（路径要绝对、规则要合法），
     否则保留原设置 —— 这是唯一会「动磁盘上的文件」的配置，不能让它被脏数据带偏。 */
  function sanitizeSettingsMerge(prev, imp) {
    const base = isObj(prev) ? prev : {};
    const incoming = isObj(imp) ? imp : {};
    const next = Object.assign({}, base, incoming);

    if (Object.prototype.hasOwnProperty.call(incoming, 'autoOrganize')) {
      const ao = incoming.autoOrganize;
      const validWatch = isObj(ao) && typeof ao.watch === 'string' && isAbsPath(ao.watch.trim());
      const rules = (isObj(ao) && Array.isArray(ao.rules)) ? ao.rules : [];
      const validRules = rules.every(r => isObj(r) && typeof r.value === 'string' && r.value.trim() && isAbsPath(r.to));
      if (validWatch && rules.length > 0 && validRules) {
        next.autoOrganize = {
          enabled: ao.enabled === true,
          watch: ao.watch.trim(),
          rules: rules.map(r => ({ id: r.id, enabled: r.enabled === true, type: r.type === 'kw' ? 'kw' : 'ext', value: r.value.trim(), to: r.to }))
        };
      } else {
        next.autoOrganize = base.autoOrganize || { enabled: false, watch: '', rules: [] };
      }
    }
    // 剪贴板敏感过滤等布尔开关强制归一化
    if (Object.prototype.hasOwnProperty.call(next, 'clipboardSensitive')) next.clipboardSensitive = next.clipboardSensitive !== false;
    if (Object.prototype.hasOwnProperty.call(next, 'clipboardHistory')) next.clipboardHistory = next.clipboardHistory !== false;
    return next;
  }

  return {
    COLLECTIONS: COLLECTIONS,
    isAbsPath: isAbsPath,
    sanitizeImported: sanitizeImported,
    sanitizeSettingsMerge: sanitizeSettingsMerge
  };
});
