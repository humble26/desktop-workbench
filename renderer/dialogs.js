'use strict';

/* dialogs.js —— 输入提示与规则编辑弹窗、确认框
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 提示输入
// ---------------------------------------------------------------
// 规则/监控目录改动后立刻对已有文件生效（主进程会在配置变化时清空尝试记录）
async function applyAutoRulesNow(prefix) {
  const org = state.settings.autoOrganize || {};
  if (org.enabled !== true) { toast(prefix + '，开启「自动文件整理」后生效'); return; }
  if (!org.watch || !(org.rules || []).length) { toast(prefix + '，还需要选择监控文件夹并至少有一条规则'); return; }
  let r = null;
  try { r = await api.runAutoOrganize(); } catch (e) { r = null; }
  const n = (r && r.moved && r.moved.length) || 0;
  const err = (r && r.errors && r.errors.length) || 0;
  toast(prefix + '：' + (n ? '已整理 ' + n + ' 个已有文件' : '没有需要整理的文件') + (err ? '，' + err + ' 个失败' : ''));
  if (n) render();
}

function promptText(title, label, def) {
  return new Promise(res => {
    modal(`
      <h3>${esc(title)}</h3>
      <div class="field" style="margin-top:18px"><label>${esc(label)}</label><input type="text" id="ptInput" value="${esc(def)}" /></div>
      <div class="modal-actions">
        <button class="btn" id="ptOk">确定</button>
        <button class="btn ghost" id="ptCancel">取消</button>
      </div>`);
    const inp = $('#ptInput'); inp.focus(); inp.select();
    $('#ptCancel').onclick = () => { closeModal(); res(null); };
    $('#ptOk').onclick = () => { const v = inp.value.trim(); closeModal(); res(v || def); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { const v = inp.value.trim(); closeModal(); res(v || def); } });
  });
}

// 整理规则编辑弹窗
function autoRuleModal(rule) {
  return new Promise(res => {
    rule = rule || {};
    let t = rule.type === 'ext' ? 'ext' : 'kw';
    const value = esc(rule.value || '');
    const to = esc(rule.to || '');
    const holder = t === 'ext' ? '例如 pdf · jpg · xlsx' : '例如 发票 · 截图';
    const lab = t === 'ext' ? '匹配扩展名' : '匹配关键词';
    modal(`
      <h3>${esc(rule.id ? '编辑整理规则' : '添加整理规则')}</h3>
      <div class="field" style="margin-top:16px">
        <label>匹配方式</label>
        <div class="seg" style="width:100%">
          <div class="opt ${t === 'ext' ? 'on' : ''}" id="artTypeExt">扩展名</div>
          <div class="opt ${t === 'kw' ? 'on' : ''}" id="artTypeKw">关键词</div>
        </div>
      </div>
      <div class="field" style="margin-top:14px">
        <label id="artLab">${lab}</label>
        <input type="text" id="artValue" value="${value}" placeholder="${holder}" />
      </div>
      <div class="field" style="margin-top:14px">
        <label>整理到的文件夹</label>
        <div style="display:flex;gap:8px;align-items:center">
          <input type="text" id="artTo" value="${to}" readonly placeholder="选择目标文件夹" style="flex:1" />
          <button class="btn ghost sm" id="artPick">选择</button>
        </div>
      </div>
      <div class="modal-actions">
        <button class="btn" id="artOk">保存</button>
        <button class="btn ghost" id="artCancel">取消</button>
      </div>`);
    const segSet = () => {
      $('#artTypeExt').classList.toggle('on', t === 'ext');
      $('#artTypeKw').classList.toggle('on', t === 'kw');
      const l = $('#artLab'); if (l) l.textContent = t === 'ext' ? '匹配扩展名' : '匹配关键词';
      $('#artValue').placeholder = t === 'ext' ? '例如 pdf · jpg · xlsx' : '例如 发票 · 截图';
    };
    $('#artTypeExt').onclick = () => { t = 'ext'; segSet(); };
    $('#artTypeKw').onclick = () => { t = 'kw'; segSet(); };
    $('#artPick').onclick = async () => { const p = await api.pickAutoTarget(); if (p) $('#artTo').value = p; };
    $('#artCancel').onclick = () => { closeModal(); res(null); };
    $('#artOk').onclick = () => {
      const v = $('#artValue').value.trim();
      const d = $('#artTo').value.trim();
      closeModal();
      if (!v) { toast('请输入匹配内容'); res(null); return; }
      if (!d) { toast('请选择整理到的文件夹'); res(null); return; }
      res({ type: t, value: v, to: d });
    };
    const inp = $('#artValue'); inp.focus(); inp.select();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#artOk').click(); } });
  });
}

// 时间统计分类规则弹窗（交互对齐自动文件整理规则弹窗）
function ttRuleModal(rule) {
  return new Promise(res => {
    rule = rule || {};
    let t = rule.match === 'title' ? 'title' : 'exe';
    const value = esc(rule.value || '');
    const cats = ['工作', '开发', '浏览', '沟通', '娱乐', '其他'];
    const curCat = cats.indexOf(rule.category) !== -1 ? rule.category : '其他';
    modal(`
      <h3>${esc(rule.value ? '编辑分类规则' : '添加分类规则')}</h3>
      <div class="sub">按顺序匹配，先命中先归类</div>
      <div class="field" style="margin-top:16px">
        <label>匹配方式</label>
        <div class="seg" style="width:100%">
          <div class="opt ${t === 'exe' ? 'on' : ''}" id="ttTypeExe">应用进程</div>
          <div class="opt ${t === 'title' ? 'on' : ''}" id="ttTypeTitle">窗口标题</div>
        </div>
      </div>
      <div class="field" style="margin-top:14px">
        <label id="ttLab">进程名包含（不分大小写）</label>
        <input type="text" id="ttValue" value="${value}" placeholder="例如 chrome · wechat · code" />
      </div>
      <div class="field" style="margin-top:14px">
        <label>归类到</label>
        <select id="ttCat" class="torepeat" style="width:100%;height:40px;flex:none">${cats.map(c => `<option ${c === curCat ? 'selected' : ''}>${c}</option>`).join('')}</select>
      </div>
      <div class="modal-actions">
        <button class="btn" id="ttOk">保存</button>
        <button class="btn ghost" id="ttCancel">取消</button>
      </div>`);
    const segSet = () => {
      $('#ttTypeExe').classList.toggle('on', t === 'exe');
      $('#ttTypeTitle').classList.toggle('on', t === 'title');
      const l = $('#ttLab');
      if (l) l.textContent = t === 'exe' ? '进程名包含（不分大小写）' : '窗口标题包含';
      $('#ttValue').placeholder = t === 'exe' ? '例如 chrome · wechat · code' : '例如 会议 · 文档';
    };
    $('#ttTypeExe').onclick = () => { t = 'exe'; segSet(); };
    $('#ttTypeTitle').onclick = () => { t = 'title'; segSet(); };
    $('#ttCancel').onclick = () => { closeModal(); res(null); };
    $('#ttOk').onclick = () => {
      const v = $('#ttValue').value.trim();
      const cat = $('#ttCat').value;
      closeModal();
      if (!v) { toast('请输入匹配内容'); res(null); return; }
      res({ match: t, value: v, category: cat });
    };
    const inp = $('#ttValue'); inp.focus(); inp.select();
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#ttOk').click(); } });
  });
}

function usageClearConfirm() {
  return new Promise(res => {
    modal(`
      <h3>清空时间统计数据？</h3>
      <div class="sub">将删除全部应用时长记录，不影响待办、便签等其他数据。此操作不可撤销。</div>
      <div class="modal-actions">
        <button class="btn danger" id="ucOk">确定清空</button>
        <button class="btn ghost" id="ucCancel">取消</button>
      </div>`);
    $('#ucCancel').onclick = () => { closeModal(); res(false); };
    $('#ucOk').onclick = () => { closeModal(); res(true); };
  });
}

