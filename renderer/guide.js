'use strict';

/* guide.js —— 首次使用引导与危险操作确认
   由 renderer/app.js 按章节拆分而来（见 tools/refactor/split-app.js）。
   加载方式：普通 <script>，顶层声明在同一页面的全局作用域内跨文件共享，
   因此调用点与拆分前完全一致；新增顶层声明不得与其他文件重名
   （由 test/contract.test.js 校验）。 */
// ---------------------------------------------------------------
// 引导
// ---------------------------------------------------------------
function showGuide() {
  if (state.settings.seenGuide) return;
  modal(`
    <h3>欢迎使用桌面工作台 👋</h3>
    <div class="sub">一个覆盖桌面、把文件 / 应用 / 待办收纳到一起的轻量工作台</div>
    <div class="set-tip" style="line-height:1.9">
      · <b>Win+Alt+Space</b> 随时显示 / 隐藏工作台<br />
      · 点右上角 <b>图钉</b> 可置顶；<b>收缩</b> 图标可切换窗口模式<br />
      · 按 <b>Ctrl+K</b> 或点右上角 <b>搜索</b> 图标，全局搜索所有内容<br />
      · 窗口模式下可拖动、缩放、最小化到任务栏<br />
      · <b>Win+Alt+T</b> 快速添加待办；<b>Win+Alt+V</b> 唤出剪贴板历史；<b>Win+Alt+S</b> 截图取字<br />
      · 「文件整理」支持直接拖拽文件 / 文件夹进分组，双击打开，右键更多操作<br />
      · 关闭窗口不会退出，常驻系统托盘；工作台不遮挡 Windows 任务栏
    </div>
    <div class="modal-actions"><div class="spacer"></div><button class="btn" id="gOk">开始使用</button></div>`);
  $('#gOk').onclick = async () => { closeModal(); state.settings.seenGuide = true; await save(); };
}

function importConfirm() {
  return new Promise(res => {
    modal(`
      <h3>确认导入数据？</h3>
      <div class="sub">导入将<b>覆盖</b>当前所有待办、便签、打卡、快捷方式与文件分组。建议先导出一份备份。</div>
      <div class="modal-actions">
        <button class="btn" id="imOk">覆盖导入</button>
        <button class="btn ghost" id="imCancel">取消</button>
      </div>`);
    $('#imCancel').onclick = () => { closeModal(); res(false); };
    $('#imOk').onclick = () => { closeModal(); res(true); };
  });
}

function confirmDanger() {
  return new Promise(res => {
    modal(`
      <h3>确定清空所有数据？</h3>
      <div class="sub">此操作不可撤销，将删除全部待办、便签、打卡、快捷方式与文件分组。</div>
      <div class="modal-actions">
        <button class="btn danger" id="cfOk">确定清空</button>
        <button class="btn ghost" id="cfCancel">取消</button>
      </div>`);
    $('#cfCancel').onclick = () => { closeModal(); res(false); };
    $('#cfOk').onclick = () => { closeModal(); res(true); };
  });
}

