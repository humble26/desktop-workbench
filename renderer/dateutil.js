'use strict';

/* ===========================================================================
   日期工具（UMD：主进程 require，渲染层 <script> 后取 WB.dateutil）
   ---------------------------------------------------------------------------
   放这里的唯一理由：重复待办的「按月顺延」在两侧都要用，而这套算法有坑 ——
   1 月 31 日直接 setMonth(+1) 会滚到 3 月 3 日（2 月没有 31 号），
   用户看到的现象是「每月的待办跳到了下下个月」。因此统一用钳制算法。
   =========================================================================== */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.WB = root.WB || {}; root.WB.dateutil = factory(); }
})(typeof self !== 'undefined' ? self : this, function () {

  function pad2(n) { return String(n).padStart(2, '0'); }

  function dateKey(d) {
    d = d || new Date();
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function addDays(d, n) {
    const out = new Date(d.getTime());
    out.setDate(out.getDate() + n);
    return out;
  }

  function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate();
  }

  /* 顺延一个月并钳制日期：1/31 → 2/28（闰年 2/29），5/31 → 6/30，1/15 → 2/15。
     必须先把「日」置为 1 再改月份，否则 setMonth 会因目标月天数不足而溢出。 */
  function advanceMonthClamped(d) {
    const day = d.getDate();
    const last = daysInMonth(d.getFullYear(), d.getMonth() + 1);
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, last));
    return d;
  }

  return { dateKey: dateKey, addDays: addDays, daysInMonth: daysInMonth, advanceMonthClamped: advanceMonthClamped };
});
