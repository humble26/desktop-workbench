'use strict';

/* ===========================================================================
   全局快速添加的文本解析（纯函数，无 Electron / fs 依赖，可单测）
   ---------------------------------------------------------------------------
   支持写法（与设置页帮助文案一致）：
     今天 / 明天 / 后天 / 昨天 / 2026-09-07 / 2026/9/7 / 9月7日   → 截止日期
     15:30 / 9:05                                              → 截止时间
   解析后把识别到的时间片段从正文里摘掉，剩余部分作为待办内容。
   =========================================================================== */

const DATE_WORDS = {
  '今天': 0, '明日': 1, '明天': 1, '后天': 2, '昨天': -1, '昨日': -1, '前天': -2
};

function pad2(n) { return String(n).padStart(2, '0'); }

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(base, n) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + n);
  return d;
}

/**
 * @param {string} raw 用户输入
 * @param {Date}   [now] 当前时间（注入以便测试）
 * @returns {{text:string, due:string, dueTime:string}}
 */
function parseQuickTodo(raw, now) {
  const tk = now instanceof Date ? now : new Date();
  let text = String(raw == null ? '' : raw).trim();
  let due = '';
  let dueTime = '';

  // 日期：中文相对词 / YYYY-MM-DD / YYYY/M/D / M月D日
  const dateMatcher = /(今天|明天|明日|后天|前天|昨(?:天|日)|\d{4}\s*[-\/]\s*\d{1,2}\s*[-\/]\s*\d{1,2}|\d{1,2}\s*月\s*\d{1,2}\s*日)/;
  const dm = text.match(dateMatcher);
  if (dm) {
    const w = dm[1];
    if (Object.prototype.hasOwnProperty.call(DATE_WORDS, w)) {
      due = dateKey(addDays(tk, DATE_WORDS[w]));
    } else if (/^\d{1,2}\s*月\s*\d{1,2}\s*日$/.test(w)) {
      const mm = w.match(/(\d{1,2})\s*月\s*(\d{1,2})/);
      const mon = +mm[1], day = +mm[2];
      if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) due = `${tk.getFullYear()}-${pad2(mon)}-${pad2(day)}`;
    } else {
      const p = w.split(/[-\/]/).map(x => +String(x).trim());
      if (p.length === 3 && p[1] >= 1 && p[1] <= 12 && p[2] >= 1 && p[2] <= 31) {
        due = `${p[0]}-${pad2(p[1])}-${pad2(p[2])}`;
      }
    }
    if (due) text = text.replace(dm[1], ' ').trim();
  }

  // 时间：HH:MM（只认合法区间，避免把 "3:7" 之类当时间）
  const tm = text.match(/(\d{1,2}):(\d{2})/);
  if (tm) {
    const h = +tm[1], m = +tm[2];
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59 && tm[1].length <= 2) {
      dueTime = `${pad2(h)}:${pad2(m)}`;
      text = text.replace(tm[0], ' ').trim();
    }
  }

  // 收尾：合并空白、去掉孤立的尾部标点
  text = text.replace(/\s+/g, ' ').replace(/[，。！？,.\s；;、]+$/g, '').trim();
  return { text, due, dueTime };
}

// 新待办对象（与渲染层创建待办的结构保持一致）
function buildQuickTodo(parsed, opts) {
  const o = opts || {};
  const now = o.now instanceof Date ? o.now : new Date();
  return {
    id: o.id || (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)),
    text: parsed.text,
    level: 'mid',
    done: false,
    date: o.date || dateKey(now),
    due: parsed.due || '',
    dueTime: parsed.dueTime || '',
    repeat: 'none',
    note: '',
    subtasks: [],
    doneHistory: [],
    remind: 0
  };
}

module.exports = { parseQuickTodo, buildQuickTodo, dateKey };
