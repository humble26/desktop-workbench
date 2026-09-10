'use strict';

/* view-settings.js —— 设置
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 设置
// ---------------------------------------------------------------
async function renderSettings(v) {
  const s = state.settings;
  const org = state.settings.autoOrganize || {};
  const tt = state.settings.timeTrack || {};
  const ws = state.settings.widgets || {};
  let info = { version: '1.0.0', hotkey: 'Win+Alt+Space' };
  try { info = await api.appInfo(); } catch (e) { /* ignore */ }

  const sw = (act, on) => `<div class="switch ${on ? 'on' : ''}" data-act="${act}"></div>`;
  const ctl = (html) => `<div class="set-ctl">${html}</div>`;
  const group = (title, rows) => `
    <div class="set-group">
      <div class="set-group-t">${esc(title)}</div>
      <div class="card set-card">${rows}</div>
    </div>`;
  const row = (ic, cls, t, d, control, sub) => `
    <div class="set-row${sub ? ' col' : ''}">
      <div class="set-line"><div class="set-ic ${cls}">${icon(ic, 15)}</div>
        <div class="k"><div class="t">${esc(t)}</div><div class="d">${d}</div></div>${control || ''}</div>
      ${sub ? `<div class="set-sub">${sub}</div>` : ''}
    </div>`;

  v.innerHTML = `
    ${header('settings')}
    ${group('窗口 · 外观', `
      ${row('pin', 'c2', '置顶显示', '让工作台始终悬浮在其他窗口之上', sw('toggle-mode', s.mode === 'top'))}
      ${row('expand', 'c4', '窗口模式', '以普通窗口运行（可拖动、缩放、最小化），关闭后回到覆盖桌面', sw('toggle-layout', s.layout === 'window'))}
      ${row('droplet', 'c3', '主题色', '按钮与选中态的高亮颜色', `<div class="swatches">${ACCENTS.map(a => `<div class="sw ${s.accent === a.hex ? 'on' : ''}" data-act="set-accent" data-accent="${a.hex}" style="background:${a.hex}" title="${esc(a.name)}"></div>`).join('')}</div>`)}
      ${row('moon', 'c5', '外观模式', '深色 / 浅色，或跟随系统', `<div class="seg" style="flex:0 0 auto">${[['light', '浅色'], ['dark', '深色'], ['auto', '自动']].map(([k, lb]) =>
        `<div class="opt ${(s.theme || 'light') === k ? 'on' : ''}" data-act="set-theme" data-theme="${k}">${lb}</div>`).join('')}</div>`)}
      ${row('layers', 'c1', '毛玻璃背景', '覆盖桌面模式下使用 Windows 11 亚克力半透明效果（应用为深石墨主题时更明显）', sw('toggle-glass', !!s.glass))}
    `)}
    ${group('功能', `
      ${row('power', 'c2', '开机自启', '登录 Windows 后自动启动工作台', sw('toggle-autostart', !!s.autostart))}
      ${row('repeat', 'c3', '重复待办逾期自动顺延', '重复任务过期未完成时，自动顺延到下一周期，避免堆积在昨天', sw('toggle-overdue', s.autoOverdueAdvance === true))}
      ${row('clipboard', 'c4', '剪贴板历史', '自动记录复制的文本 / 图片 / 文件，按 <b>Win+Alt+V</b> 唤出，支持搜索、置顶、类型过滤与图片 OCR 提字（最多保留 200 条）', sw('toggle-clipboard', s.clipboardHistory !== false), `
        <div class="set-sub-row"><label class="set-sub-lb">敏感内容过滤</label><div class="switch ${s.clipboardSensitive !== false ? 'on' : ''}" data-act="toggle-clipboard-sensitive"></div><span style="font-size:12px;color:var(--text-tertiary);padding-left:10px">JWT / 私钥 / 口令 / API Key 等敏感内容不录入历史</span></div>`)}
      ${row('bell', 'c5', '每日提醒', '每天定时汇总当天到期的待办，并系统通知', sw('toggle-dailyremind', !!s.dailyRemind), s.dailyRemind ? `
        <div class="set-sub-row"><label class="set-sub-lb">提醒时间</label><input type="time" id="dailyRemindTime" value="${esc(s.dailyRemindTime || '08:30')}" style="width:150px;flex:0 0 auto" /></div>` : null)}
      ${row('folder-open', 'c1', '自动文件整理', '监控一个文件夹，按规则自动移动文件；<b>规则或文件夹改动后会对已有文件立即重扫</b>（过去曾扫过但不匹配的文件也会重新判断）', sw('toggle-autoorganize', !!org.enabled), `
        <div class="set-sub-row">
          <div class="set-watch" id="autoWatchInfo">${esc(org.watch || '选择后，新放入的文件会自动按规则整理到对应文件夹')}</div>
          <button class="btn ghost sm" data-act="pick-auto-watch">${icon('folder', 14)} 选择</button>
        </div>
        <div class="org-rules" id="orgRules">
          ${(org.rules || []).map(r => `
            <div class="org-rule" data-rid="${esc(r.id)}">
              <span class="org-tag ${r.type === 'ext' ? 'ext' : 'kw'}">${r.type === 'ext' ? '扩展名' : '关键词'}</span>
              <span class="org-val">${esc(r.value)}</span>
              <span class="org-arrow">→</span>
              <span class="org-to" title="${esc(r.to)}">${esc(fileBase(r.to) || r.to)}</span>
              <div class="org-ops">
                <button class="btn ghost sm" data-act="edit-auto-rule" data-id="${esc(r.id)}">${icon('edit', 12)}</button>
                <button class="btn ghost sm danger-ic" data-act="del-auto-rule" data-id="${esc(r.id)}">${icon('trash', 12)}</button>
              </div>
            </div>`).join('')}
        </div>
        ${(org.rules || []).length ? '' : '<div class="org-empty">还没有整理规则，点下方「添加规则」创建。例如：{ 扩展名 pdf } 移动下载的 PDF 到「文档」文件夹。</div>'}
        <div class="org-add">
          <button class="btn sm" data-act="add-auto-rule">${icon('plus', 14)} 添加规则</button>
          <button class="btn ghost sm" data-act="run-auto-organize">${icon('folder-open', 14)} 立即整理</button>
        </div>`)}
      ${row('refresh', 'c2', '检查更新', '从更新源清单读取最新版本；地址留空则不检查', '', `
        <div class="set-sub-row" style="align-items:center">
          <input type="text" id="updaterUrl" value="${esc(s.updaterUrl || '')}" placeholder="https://example.com/version.json" style="flex:1;min-width:180px" />
          <button class="btn sm" data-act="check-update">${icon('refresh', 14)} 检查更新</button>
          <span id="updResult" style="font-size:12.5px;color:var(--text-secondary)"></span>
        </div>`)}
    `)}
    ${group('时间统计', `
      ${row('clock', 'c2', '自动时间统计', (info.platform || 'win32') === 'win32' ? '在后台记录各应用的活跃时长并自动归类；只记录应用名与窗口标题，不上传、不截屏、不记录键鼠内容' : '此功能仅支持 Windows 系统', sw('toggle-timetrack', tt && tt.enabled === true))}
      ${row('clock', 'c3', '空闲阈值', '系统空闲超过该时长后停止计时（锁屏会立即暂停）', `<div class="seg" style="flex:0 0 auto">${[[120, '2 分钟'], [300, '5 分钟'], [600, '10 分钟']].map(([v, lb]) =>
        `<div class="opt ${tt && tt.idleSeconds === v ? 'on' : ''}" data-act="tt-idle" data-value="${v}">${lb}</div>`).join('')}</div>`)}
      ${row('list', 'c4', '记录窗口标题', '开启后窗口标题才会写入统计数据并展示标题排行；关闭时标题只用于规则匹配、不落盘（默认关闭，更隐私）', sw('toggle-tt-titles', !!(tt && tt.recordTitles)))}
      ${row('sort', 'c5', '分类规则', '按顺序匹配：命中应用进程名（不分大小写）或窗口标题（包含匹配），未命中归入「其他」', '', `
        <div class="org-rules" id="ttRules">
          ${((tt && tt.rules) || []).map((r, i) => `
            <div class="org-rule">
              <span class="org-tag ${r.match === 'title' ? 'kw' : 'ext'}">${r.match === 'title' ? '标题' : '进程'}</span>
              <span class="org-val">${esc(r.value)}</span>
              <span class="org-arrow">→</span>
              <span class="org-to">${esc(r.category)}</span>
              <div class="org-ops">
                <button class="btn ghost sm" data-act="edit-tt-rule" data-ridx="${i}">${icon('edit', 12)}</button>
                <button class="btn ghost sm danger-ic" data-act="del-tt-rule" data-ridx="${i}">${icon('trash', 12)}</button>
              </div>
            </div>`).join('')}
        </div>
        ${((tt && tt.rules) || []).length ? '' : '<div class="org-empty">还没有分类规则，点下方「添加规则」创建。例如：{ 进程 chrome } 归入「浏览」。</div>'}
        <div class="org-add">
          <button class="btn sm" data-act="add-tt-rule">${icon('plus', 14)} 添加规则</button>
        </div>`)}
      ${row('trash', 'danger', '清空统计数据', '删除全部应用时长记录（不影响待办、便签等其他数据，也不包含在导出/备份中）', ctl(`<button class="btn danger sm" data-act="clear-usage">清空</button>`))}
    `)}
    ${group('桌面小组件', `
      ${row('clock', 'c3', '时钟', '在桌面固定显示时间与日期的小窗', sw('toggle-widget-clock', ws.clock === true))}
      ${row('check-square', 'c1', '今日待办', '在桌面固定显示今天与逾期的待办', sw('toggle-widget-todos', ws.todos === true))}
      ${row('note', 'c4', '便签', '在桌面固定展示便签列表', sw('toggle-widget-notes', ws.notes === true))}
    `)}
    ${group('数据', `
      ${row('database', 'c3', '自动备份', '每 6 小时自动备份数据；若主数据损坏会自动从最近备份恢复', sw('toggle-autobackup', s.autoBackup !== false))}
      ${row('archive', 'c4', '本地备份', `<span id="bkInfo">读取中…</span>`, ctl(`<button class="btn ghost sm" data-act="backup-now">${icon('database', 14)} 立即备份</button><button class="btn ghost sm" data-act="open-backup">打开文件夹</button>`))}
      ${row('download', 'c5', '导出 / 导入', '导出为 JSON 文件，可在换设备或重装后导入恢复', ctl(`<button class="btn ghost sm" data-act="export-data">${icon('download', 14)} 导出</button><button class="btn ghost sm" data-act="import-data">${icon('upload', 14)} 导入</button>`))}
      ${row('trash', 'danger', '清空所有数据', '删除全部待办、便签、打卡、快捷方式和文件分组，此操作不可撤销', ctl(`<button class="btn danger sm" data-act="reset-all">清空数据</button>`))}
    `)}
    ${group('运行环境 · 诊断', `
      ${row('refresh', 'c2', 'PowerShell 环境', '<span id="diagPs">检测中…</span>', ctl(`<button class="btn ghost sm" data-act="probe-ps">${icon('refresh', 14)} 重新检测</button>`))}
      ${row('database', 'c1', '数据仓库', '<span id="diagStore">读取中…</span>', '')}
      ${row('clock', 'c4', '时间统计采样', '<span id="diagUsage">读取中…</span>', '')}
      ${row('clipboard', 'c5', '剪贴板记录', '<span id="diagClip">读取中…</span>', '')}
      ${row('layers', 'c3', '全局快捷键', '<span id="diagHotkey">读取中…</span>', '')}
      ${row('archive', 'c1', '图标缓存', '<span id="diagIcons">读取中…</span>', '')}
      <div class="set-sub" id="diagFeatures" style="display:none"></div>
    `)}
    <div class="set-tip">
      <b>使用说明</b><br />
      · 全局快捷键 <b>${esc(info.hotkey)}</b> 可随时显示 / 隐藏工作台<br />
      · <b>Win+Alt+T</b> 可在任意界面弹出小窗快速添加待办（支持「今天 / 明天 / 后天 / 15:30」快捷写法）<br />
      · <b>Win+Alt+V</b> 唤出剪贴板历史，可搜索、置顶、按类型过滤，图片支持 OCR 提字<br />
      · <b>Win+Alt+S</b> 截图取字：框选屏幕任意区域，识别文字并自动复制（仅 Windows）<br />
      · <b>Ctrl+K</b> 打开命令面板：搜索内容，或直接执行新建待办、切换主题等动作<br />
      · 「窗口模式」可让工作台以普通窗口运行（可拖动、缩放、最小化到任务栏）<br />
      · 「文件整理」支持直接把文件 / 文件夹拖拽进分组收纳；「自动文件整理」可监控一个文件夹按规则自动归类（改规则后会对已有文件立即重扫）<br />
      · 「桌面小组件」可把时钟 / 今日待办 / 便签钉在桌面上（设置中开启）<br />
      · 待办支持<b>重复任务</b>（每天/每周/每月）、<b>到期系统通知</b>、备注与子任务<br />
      · 关闭窗口会最小化到系统托盘，不会退出；在托盘菜单里选择「退出」才会结束<br />
      · 工作台覆盖在整个桌面上，不遮挡 Windows 任务栏；点托盘或按快捷键可暂时隐藏以查看原始桌面<br />
      · <b>数据范围</b>：导出 / 备份只包含待办、便签、打卡、快捷入口、文件分组与设置；
        时间统计（usage-data.json）与剪贴板历史（clipboard-history.json + 图片）独立存放，
        <b>不参与导出 / 备份</b>，可在本页单独清空<br />
      · <b>检查更新</b>：只读取你填写的清单地址并比较版本号，<b>不会自动下载或安装</b>，
        发现新版本后由你自行获取安装包<br />
      · 当前版本 <b>v${esc(info.version)}</b> · 数据保存在 <b>${esc(info.userData)}</b>
    </div>`;
  const drt = $('#dailyRemindTime');
  if (drt) drt.onchange = async () => { state.settings.dailyRemindTime = drt.value || '08:30'; await save(); toast('已保存每日提醒时间'); };
  const upUrl = $('#updaterUrl');
  if (upUrl) upUrl.onchange = async () => { state.settings.updaterUrl = (upUrl.value || '').trim(); await save(); };
  try {
    const bks = await api.listBackups();
    const bi = $('#bkInfo');
    if (bi) bi.textContent = bks.length ? `最近 ${bks.length} 份 · 最新 ${esc(bks[0].name)}` : '暂无本地备份';
  } catch (e) { /* ignore */ }
  paintDiagnostics();
}

