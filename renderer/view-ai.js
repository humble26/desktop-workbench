'use strict';

/* view-ai.js —— AI 平台余额监测
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */

/* 关于「消耗」这件事必须先说清楚（界面底部也会再讲一遍）：
   各平台只公开**当前余额**，没有公开的 token 用量接口。所以这里的消耗是
   用「余额差值」推算的 —— 两次采样之间余额降了多少，就是花掉的钱。
   再由消耗金额 ÷ 参考单价估个 token 量级，界面上一律标注为「估算」，
   绝不冒充平台给的精确用量。 */

let aiLastSummary = null;          // 主进程推送/最近一次拉取的快照
const AI_SYMBOL = { CNY: '¥', USD: '$' };
const AI_INTERVAL_CHOICES = [[5, '5 分钟'], [15, '15 分钟'], [30, '30 分钟'], [60, '1 小时'], [180, '3 小时']];

function aiSymbol(cur) { return AI_SYMBOL[cur] || ''; }

// 金额：大额保留 2 位，小额保留 4 位（分币级消耗显示成 0.00 就没意义了）
function aiNum(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const digits = abs >= 1 || abs === 0 ? 2 : 4;
  const s = abs.toFixed(digits);
  const [int, dec] = s.split('.');
  return (n < 0 ? '-' : '') + int.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (dec ? '.' + dec : '');
}
function aiMoney(v, cur) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return aiSymbol(cur) + aiNum(n);
}
// token 量级：用「万 / 亿」更直观（估算值本身只有量级意义）
function aiTokens(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e8) return (n / 1e8).toFixed(2) + ' 亿';
  if (n >= 1e4) return (n / 1e4).toFixed(2) + ' 万';
  return String(Math.round(n));
}
function aiTime(ts) {
  if (!ts) return '还没有刷新过';
  const d = new Date(ts);
  const diff = Date.now() - ts;
  if (diff < 60000) return '刚刚';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' 小时前';
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
// 多币种不能相加：按币种分组显示
function aiMoneyByCurrency(list, pick) {
  const byCur = {};
  for (const p of list) {
    const v = Number(pick(p));
    if (!Number.isFinite(v) || v === 0) continue;
    byCur[p.currency || 'CNY'] = (byCur[p.currency || 'CNY'] || 0) + v;
  }
  const keys = Object.keys(byCur);
  if (!keys.length) return null;
  return keys.map(c => aiMoney(byCur[c], c)).join(' · ');
}

function renderAiEmpty(v, title, desc, showSettings) {
  v.innerHTML = `${header('ai')}
    <div class="empty card" style="padding:56px 20px"><div class="e">${icon('coins', 26)}</div>
    <div>${esc(title)}</div><div class="dim" style="font-size:12px;margin-top:6px;line-height:1.7">${esc(desc)}</div>
    ${showSettings ? `<div style="margin-top:16px"><button class="btn" data-act="goto-settings">去设置开启</button></div>` : ''}</div>`;
}

async function renderAi(v) {
  let sum = aiLastSummary;
  try { sum = await api.aiList(); } catch (e) { sum = sum || null; }
  aiLastSummary = sum;
  if (!sum || !Array.isArray(sum.providers)) {
    renderAiEmpty(v, '读不到监测状态', '主进程没有返回数据，请重试或查看启动日志。', false);
    return;
  }

  // 密钥存储不可用：这是「功能不可用但不该悄悄降级」的情况，必须显式说清
  if (sum.keyStorageAvailable === false) {
    renderAiEmpty(v, '系统的安全存储不可用',
      '当前系统的 safeStorage 不可用，本功能拒绝把 API Key 明文写入磁盘，因此无法保存密钥。', false);
    return;
  }
  if (sum.enabled !== true) {
    renderAiEmpty(v, 'AI 余额监测未开启',
      '开启后可定期读取各平台的余额接口，并用余额差值推算消耗。密钥会加密保存在本机，只发送给对应平台。', true);
    return;
  }

  const active = sum.providers.filter(p => p.enabled);
  const histories = {};
  await Promise.all(active.map(async (p) => {
    try { histories[p.id] = await api.aiHistory({ id: p.id, days: 14 }); } catch (e) { histories[p.id] = null; }
  }));

  const totalBalance = aiMoneyByCurrency(active, p => (p.ok ? p.balance : null));
  const today = aiMoneyByCurrency(active, p => p.spend.today);
  const last7 = aiMoneyByCurrency(active, p => p.spend.last7);
  const okCount = active.filter(p => p.ok).length;
  const errCount = active.filter(p => p.enabled && !p.ok).length;

  const cards = `
    <div class="stats">
      <div class="stat">${chip('coins', '可用余额')}<div class="v ai-v-sm">${esc(totalBalance || '—')}</div>
        <div class="l">可用余额 · ${okCount}/${active.length} 个平台正常${errCount ? '，' + errCount + ' 个异常' : ''}</div></div>
      <div class="stat">${chip('bar', '今日消耗')}<div class="v ai-v-sm">${esc(today || '—')}</div>
        <div class="l">今日消耗${active.length === 1 && active[0].spend.yesterday > 0 ? ' · 昨日 ' + esc(aiMoney(active[0].spend.yesterday, active[0].currency)) : ''}</div></div>
      <div class="stat">${chip('calendar', '近七天消耗')}<div class="v ai-v-sm">${esc(last7 || '—')}</div>
        <div class="l">近 7 天消耗${active.length === 1 ? ' · 平均 ' + esc(aiMoney(active[0].spend.avgPerDay, active[0].currency)) + '/天' : ''}</div></div>
      <div class="stat">${chip('refresh', '数据与刷新')}<div class="v ai-v-sm">${esc(sum.intervalMinutes + ' 分钟')}</div>
        <div class="l">轮询间隔 · 上次刷新 ${esc(aiTime(sum.lastRefreshAt))}</div></div>
    </div>`;

  const providerCards = sum.providers.map(p => aiProviderCard(p, histories[p.id])).join('');

  v.innerHTML = `${header('ai', `
      <span class="usage-flag">${icon('key', 13)} 密钥存储：${esc(sum.keyStorage)}</span>
      <button class="btn sm" data-act="ai-refresh">${icon('refresh', 14)} 全部刷新</button>`)}
    ${cards}
    ${providerCards}
    <div class="card insight-card" style="margin-top:16px">
      <div class="insight-t">这些数字是怎么来的<span class="insight-sub">请务必看一眼</span></div>
      <div class="insight-note" style="line-height:1.9">
        · <b>余额</b>是各平台官方接口返回的真实数字（DeepSeek 的 <code>/user/balance</code> 等），每次刷新都重新读取。<br />
        · <b>消耗</b>是用<b>余额差值推算</b>的：两次采样之间余额降了多少就算花了多少，充值（余额上升）不计为消耗。
          应用关着的那几天，这段消耗会<b>均摊</b>到相隔的每一天，而不是全记在回来的那天。<br />
        · <b>token 数是估算</b>：平台不公开用量接口，只能用「消耗金额 ÷ 你在设置里填的参考单价」换算量级。
          不同模型输入/输出单价差好几倍、缓存命中还有折扣，所以它只适合看趋势，不适合对账。<br />
        · 请求只发往各平台官方域名（自定义平台发往你填的地址）；本功能<b>默认关闭</b>，
          历史保存在 <code>ai-usage.json</code>，密钥加密保存在 <code>ai-keys.json</code>，
          两者都<b>不参与导出 / 备份</b>。
      </div>
    </div>`;
}

// 单个平台卡片：余额 + 消耗 + 估算 token + 14 天柱状图 + 错误信息
function aiProviderCard(p, hist) {
  // 状态必须说准原因：没开开关 vs 没填密钥 vs 请求失败，是三件不同的事
  const statusCls = !p.enabled ? 'idle' : (p.ok ? 'ok' : (p.hasKey ? 'err' : 'idle'));
  const statusText = !p.enabled ? '未启用'
    : (!p.hasKey ? '未配置密钥' : (p.ok ? '正常' : '异常'));
  // 关掉的平台不提供刷新入口 —— 否则等于绕开开关打了一次平台接口
  const actions = !p.enabled ? ''
    : `${p.consoleUrl ? `<button class="btn ghost sm" data-act="ai-open-console" data-id="${esc(p.id)}">${icon('external', 13)} 平台控制台</button>` : ''}
       <button class="btn ghost sm" data-act="ai-refresh" data-id="${esc(p.id)}">${icon('refresh', 13)} 刷新</button>`;
  const spend = p.spend || {};
  const tokensToday = aiTokens(spend.tokensToday);
  const tokens7 = aiTokens(spend.tokensLast7);

  const breakdown = [];
  if (Number.isFinite(p.granted)) breakdown.push('赠送 ' + aiMoney(p.granted, p.currency));
  if (Number.isFinite(p.toppedUp)) breakdown.push('充值 ' + aiMoney(p.toppedUp, p.currency));
  if (Number.isFinite(p.used)) breakdown.push('已用 ' + aiMoney(p.used, p.currency));
  if (Number.isFinite(p.limit)) breakdown.push('额度 ' + aiMoney(p.limit, p.currency));

  const days = (hist && Array.isArray(hist.days)) ? hist.days : [];
  const maxDay = Math.max(1e-9, ...days.map(d => d.amount));
  const cols = days.map(d => `
    <div class="u-col" title="${esc(d.date)}：${esc(aiMoney(d.amount, p.currency))}">
      <div class="u-col-track"><div class="u-col-fill" style="height:${d.amount > 0 ? Math.max(3, Math.round(d.amount / maxDay * 100)) : 0}%"></div></div>
      <div class="u-col-l">${d.date === dateKey() ? '今天' : esc(d.date.slice(5))}</div>
    </div>`).join('');

  const kv = [];
  kv.push(['今日消耗', aiMoney(spend.today, p.currency) + (tokensToday ? ' <span class="dim">≈ ' + esc(tokensToday) + ' token</span>' : '')]);
  kv.push(['近 7 天消耗', aiMoney(spend.last7, p.currency) + (tokens7 ? ' <span class="dim">≈ ' + esc(tokens7) + ' token</span>' : '')]);
  kv.push(['日均消耗', spend.avgPerDay > 0 ? aiMoney(spend.avgPerDay, p.currency) + ' <span class="dim">（按 ' + spend.observedDays + ' 天）</span>' : '—']);
  // 注意用 Number.isFinite 而不是 !== null：字段缺失时 undefined !== null 会让这里渲染出「约 undefined 天」
  kv.push(['预计可用', Number.isFinite(spend.daysLeft) ? '约 ' + spend.daysLeft + ' 天' : (spend.avgPerDay > 0 ? '余额不足一天' : '还不够数据')]);
  const kvHtml = kv.map(([k, val]) => `<div class="ai-kv-row"><span class="ai-kv-k">${esc(k)}</span><span class="ai-kv-v">${val}</span></div>`).join('');

  return `
    <div class="card ai-card">
      <div class="ai-head">
        <span class="ai-dot ${statusCls}"></span>
        <span class="ai-name">${esc(p.name)}</span>
        <span class="ai-status">${esc(statusText)}</span>
        ${p.at ? `<span class="ai-at">${esc(aiTime(p.at))}</span>` : ''}
        <span class="spacer"></span>
        ${actions}
      </div>
      <div class="ai-body">
        <div class="ai-left">
          <div class="ai-amt">${p.ok ? esc(aiMoney(p.balance, p.currency)) : '<span class="ai-amt-na">—</span>'}</div>
          <div class="ai-sub">可用余额${p.currency ? ' · ' + esc(p.currency) : ''}${p.note ? ' · ' + esc(p.note) : ''}</div>
          ${breakdown.length ? `<div class="ai-sub dim">${esc(breakdown.join(' · '))}</div>` : ''}
          ${p.masked ? `<div class="ai-sub dim">密钥 ${esc(p.masked)}</div>` : ''}
          ${!p.enabled ? '<div class="ai-sub dim">在「设置 · AI 余额监测」里打开这个平台的开关后才会读取</div>' : ''}
          ${p.ok && p.available === false ? '<div class="ai-warn">该平台标记为「余额不足」，调用会被拒绝</div>' : ''}
          ${p.enabled && !p.ok && p.error ? `<div class="ai-err">${esc(p.error)}</div>` : ''}
          ${p.ok ? kvHtml : ''}
        </div>
        <div class="ai-right">
          <div class="ai-chart-t">近 14 天消耗${spend.price > 0 ? `（参考单价 ${esc(aiMoney(spend.price, p.currency))}/百万 token）` : '（未填参考单价，不做 token 估算）'}</div>
          <div class="u-cols" style="height:110px">${cols || '<div class="empty" style="padding:20px">还没有历史数据</div>'}</div>
        </div>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------------------
   设置页里的「AI 余额监测」区块。
   放在 view-ai.js 里而不是 view-settings.js：这一整块的状态与渲染细节只在这里
   出现一次，设置页只负责把它插进去（见 view-settings.js 的 group 调用）。
   --------------------------------------------------------------------------- */
function aiMonitorSettingsGroup() {
  const s = state.settings || {};
  const ai = s.aiMonitor || {};
  const providers = ai.providers || {};
  const sum = aiLastSummary;
  const stateOf = {};
  if (sum && Array.isArray(sum.providers)) for (const p of sum.providers) stateOf[p.id] = p;

  const sw = (act, on, id) => `<div class="switch ${on ? 'on' : ''}" data-act="${act}"${id ? ` data-id="${esc(id)}"` : ''}></div>`;
  const ctl = (html) => `<div class="set-ctl">${html}</div>`;
  const row = (ic, cls, t, d, control, sub) => `
    <div class="set-row${sub ? ' col' : ''}">
      <div class="set-line"><div class="set-ic ${cls}">${icon(ic, 15)}</div>
        <div class="k"><div class="t">${esc(t)}</div><div class="d">${d}</div></div>${control || ''}</div>
      ${sub ? `<div class="set-sub">${sub}</div>` : ''}
    </div>`;

  const available = sum ? sum.keyStorageAvailable !== false : true;
  const storage = sum ? sum.keyStorage : '读取中…';

  const rows = [];
  rows.push(row('coins', 'c2', 'AI 余额监测',
    '定期读取各平台官方余额接口，并用<b>余额差值推算消耗</b>。这是本应用<b>唯一会主动访问外部服务</b>的功能，'
    + '默认关闭；关闭后不会有任何相关网络请求。密钥用系统安全存储加密，历史与密钥都<b>不参与导出 / 备份</b>。',
    sw('ai-toggle', ai.enabled === true)));

  if (ai.enabled === true) {
    rows.push(row('refresh', 'c3', '轮询间隔',
      '离线或休眠期间不会轮询；重新打开后会立刻补一次，跨天的消耗会均摊到相隔的每一天',
      `<div class="seg" style="flex:0 0 auto">${AI_INTERVAL_CHOICES.map(([v, lb]) =>
        `<div class="opt ${ai.intervalMinutes === v ? 'on' : ''}" data-act="ai-interval" data-value="${v}">${lb}</div>`).join('')}</div>`));

    rows.push(row('bell', 'c4', '低余额提醒',
      '余额低于该值时发一次系统通知（同一天同一平台只提醒一次）；填 0 表示不提醒。'
      + '注意阈值是<b>各平台按自己币种的数字直接比较</b>的 —— 同时用人民币和美元平台时，'
      + '请按较小的那个币种来设，或者干脆按「低于这个数字就提醒」理解。',
      ctl(`<input type="number" id="aiLow" min="0" step="1" value="${esc(ai.lowBalance || 0)}" style="width:110px" />`)));
  }

  // 密钥相关内容不随总开关收起：填密钥、看存储后端、清历史，都是「准备阶段」的动作，
  // 先配好再打开开关才顺手（打开开关后才多出上面那两条调优项）
  rows.push(row('key', 'c5', '密钥存储',
    '密钥单独加密存放在 <code>ai-keys.json</code>（与主数据分离，不会随导出 / 备份外流）；'
    + '渲染层只能写入与看到掩码，读不到明文。当前后端：<b>' + esc(storage) + '</b>'
    + (available ? '' : ' <span style="color:var(--danger)">（不可用，已拒绝保存密钥）</span>'), ''));

  // 每个平台一行：开关 + 密钥 + 单价
  for (const st of (sum ? sum.providers : [])) {
    if (!st || st.custom) continue;
    const cfg = providers[st.id] || {};
    rows.push(row(st.ok ? 'check' : 'coins', st.ok ? 'c1' : 'c2', st.name,
      (st.keyHint ? '密钥形如 <code>' + esc(st.keyHint) + '</code>；' : '')
      + '参考单价用于把消耗金额换算成 token 量级（' + esc(st.currency) + '/百万 token）'
      + (st.priceNote ? ' —— ' + esc(st.priceNote) : ''),
      sw('ai-toggle-provider', cfg.enabled === true, st.id),
      `<div class="ai-keyrow">
        <input type="password" id="aiKey-${esc(st.id)}" placeholder="${st.hasKey ? '已保存 ' + esc(st.masked) + '，填空则不改动' : '粘贴 API Key'}" autocomplete="off" spellcheck="false" />
        <button class="btn sm" data-act="ai-save-key" data-id="${esc(st.id)}">${icon('check', 13)} 保存</button>
        ${st.hasKey ? `<button class="btn ghost sm danger-ic" data-act="ai-clear-key" data-id="${esc(st.id)}">${icon('trash', 13)} 清除密钥</button>` : ''}
        <span class="ai-pricerow">单价 <input type="number" id="aiPrice-${esc(st.id)}" min="0" step="0.1" value="${esc(cfg.price === undefined ? st.price : cfg.price)}" style="width:90px" /></span>
      </div>
      ${st.hasKey && st.keyReadable === false ? '<div class="ai-err" style="padding-left:0">密钥文件存在但解不开（换了 Windows 用户或机器），请重新填写</div>' : ''}
      ${st.hasKey && !st.ok && st.error ? `<div class="ai-err" style="padding-left:0">${esc(st.error)}</div>` : ''}
      ${st.ok ? `<div class="dim" style="font-size:12px;padding-left:0">最近一次读取：${esc(aiTime(st.at))} · 可用余额 ${esc(aiMoney(st.balance, st.currency))}</div>` : ''}
      <div class="ai-keylinks">${st.keyUrl ? `<span class="ai-link" data-act="ai-open-url" data-url="${esc(st.keyUrl)}">获取 API Key</span>` : ''}${st.consoleUrl ? `<span class="ai-link" data-act="ai-open-url" data-url="${esc(st.consoleUrl)}">用量控制台</span>` : ''}${st.hasKey ? `<span class="ai-link danger" data-act="ai-clear-provider" data-id="${esc(st.id)}">清空该平台历史</span>` : ''}</div>`));
  }

  // 自定义平台
  const cu = providers.custom || {};
  const cuState = stateOf.custom || null;
  rows.push(row('external', 'c3', '自定义平台',
    '任何返回余额 JSON 的接口都能接。地址必须是 <b>https</b>（或本机 http），'
    + '请求只会发往你填的这个地址，密钥也只属于它。',
    sw('ai-toggle-provider', cu.enabled === true, 'custom'),
    `<div class="ai-keyrow">
      <input type="text" id="aiCustomName" placeholder="平台名称（如 我的中转站）" value="${esc(cu.name || '')}" />
      <input type="text" id="aiCustomUrl" placeholder="https://example.com/api/balance" value="${esc(cu.url || '')}" style="min-width:260px" />
    </div>
    <div class="ai-keyrow">
      <input type="text" id="aiCustomPath" placeholder="余额字段路径，如 data.balance（可用 | 分隔多个）" value="${esc(cu.balancePath || '')}" style="min-width:260px" />
      <select id="aiCustomCurrency" style="width:90px"><option value="CNY"${cu.currency !== 'USD' ? ' selected' : ''}>CNY</option><option value="USD"${cu.currency === 'USD' ? ' selected' : ''}>USD</option></select>
      <input type="password" id="aiKey-custom" placeholder="${cuState && cuState.hasKey ? '已保存 ' + esc(cuState.masked) : '粘贴该地址的 API Key'}" autocomplete="off" spellcheck="false" />
      <button class="btn sm" data-act="ai-save-custom">${icon('check', 13)} 保存配置</button>
    </div>
    <div class="dim" style="font-size:12px;padding-left:0">路径支持 <code>a.b[0].c</code> 写法；也可以填 <code>usedPath</code> 之类的可选字段，但只有余额路径是必填的。</div>`));

  rows.push(row('trash', 'danger', '清空监测历史',
    '删除全部余额采样与消耗记录（<code>ai-usage.json</code>）。<b>不影响</b>已保存的密钥与设置。',
    ctl(`<button class="btn danger sm" data-act="ai-clear-history">清空历史</button>`)));

  return `
    <div class="set-group">
      <div class="set-group-t">AI 余额监测</div>
      <div class="card set-card">${rows.join('')}</div>
    </div>`;
}

/* 设置页渲染完成后调用：把输入框的保存动作接上（与 #updaterUrl 的做法一致）。
   写成「填完即存」而不是「填完点保存」，是因为这里没有统一的表单提交时机。 */
function wireAiSettingsInputs() {
  const low = $('#aiLow');
  if (low) low.onchange = async () => {
    const n = Number(low.value);
    aiMutate(d => { d.lowBalance = Number.isFinite(n) && n >= 0 ? n : 0; });
    await save(); toast('已保存低余额提醒阈值');
  };
  for (const p of (aiLastSummary && aiLastSummary.providers) || []) {
    const price = $(`#aiPrice-${p.id}`);
    if (price) price.onchange = async () => {
      const n = Number(price.value);
      aiMutate(d => { d.providers[p.id].price = Number.isFinite(n) && n >= 0 ? n : 0; });
      await save(); toast('已保存参考单价');
    };
  }
}

// 现在保存密钥会不会真的触发一次验证？只有总开关与平台开关都开着才会。
// 主进程侧有同样的判断（两处都拦：这里决定提示语，那里才是真正的防线）。
function aiWillVerifyNow(providerId) {
  const d = (state.settings && state.settings.aiMonitor) || {};
  if (d.enabled !== true) return false;
  const c = (d.providers || {})[String(providerId).toLowerCase()] || {};
  return c.enabled === true;
}

// 统一的设置写入：保证 aiMonitor 结构存在
function aiMutate(fn) {
  if (!state.settings.aiMonitor || typeof state.settings.aiMonitor !== 'object') {
    state.settings.aiMonitor = { enabled: false, intervalMinutes: 30, lowBalance: 0, providers: {} };
  }
  const d = state.settings.aiMonitor;
  if (!d.providers || typeof d.providers !== 'object') d.providers = {};
  fn(d);
}

/* 重新拉一次整份状态。
   主进程侧的「保存密钥后顺手验证」是异步的，所以这里拿到的是当前已知状态，
   验证结果会通过 ai:updated 推送过来（停在余额页时会自动重绘）。 */
async function aiReloadSummary() {
  try { aiLastSummary = await api.aiList(); } catch (e) { /* 保留旧快照，界面会显示上次的结果 */ }
  return aiLastSummary;
}

// 清空监测历史的二次确认（与时间统计的确认框保持同一形态）
function aiClearConfirm() {
  return new Promise(res => {
    modal(`
      <h3>清空 AI 监测历史？</h3>
      <div class="sub">将删除全部余额采样与消耗记录，<b>不影响</b>已保存的密钥与平台设置。此操作不可撤销。</div>
      <div class="modal-actions">
        <button class="btn danger" id="aiOk">确定清空</button>
        <button class="btn ghost" id="aiCancel">取消</button>
      </div>`);
    $('#aiCancel').onclick = () => { closeModal(); res(false); };
    $('#aiOk').onclick = () => { closeModal(); res(true); };
  });
}
