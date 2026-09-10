# 桌面工作台（desktop-workbench）

一个集成 **待办 / 便签 / 打卡 / 番茄钟 / 剪贴板历史 / 截图 OCR / 时间统计 / 文件自动整理 / 桌面小组件** 的 Windows 桌面效率应用。基于 Electron，界面简约，**数据全部本地存储、不联网**。

> 当前版本：**v1.8.2** · [更新日志](CHANGELOG.md) · [下载 Releases](https://github.com/humble26/desktop-workbench/releases)

---

## ✨ 功能一览

| 模块 | 说明 |
| --- | --- |
| 📋 待办 & 重复任务 | 快速添加、优先级、子任务、截止日期、每 30 秒到期提醒、逾期自动顺延、**月度任务月末安全顺延**（1/31 → 2/28，不会跳到 3 月） |
| 📝 便签 | 灵感速记，支持分组 |
| ✅ 习惯打卡 | 每日打卡与连续天数统计 |
| 📎 剪贴板历史（Win+Alt+V） | 自动记录复制的 文本 / 图片 / 文件；搜索、置顶、按类型过滤；图片内置离线 OCR 提字；可开启「**敏感内容过滤**」，JWT / 私钥 / 口令 / API Key 等不录入历史 |
| 🖼️ 截图 OCR 取字（Win+Alt+S） | 框选屏幕任意区域，离线识别并自动复制，裁剪带边界与大小限制 |
| ⏱️ 时间统计 | 后台自动采样前台应用，记录使用时长并自动分类（工作 / 开发 / 浏览 / 沟通 / 娱乐 / 其他），含番茄钟标注 |
| 🍅 番茄钟 | 专注 / 短休 / 长休，支持自定义时长 |
| 📊 数据洞察 | 完成率、近 14 天活动强度、当日概况 |
| 📁 自动文件整理 | 监控文件夹，按扩展名 / 关键词自动归类（目标路径仅接受**绝对路径**）；改规则后对已有文件立即重扫 |
| 📦 桌面小组件 | 时钟 / 今日待办 / 便签可固定为桌面小窗 |
| 🧭 命令面板（Ctrl+K） | 搜索内容之外可直接执行动作：新建待办/便签、打开剪贴板、截图、开始番茄钟、切换置顶/主题、立即备份 |
| 🩺 运行环境诊断 | 设置页集中展示 PowerShell 环境、数据仓库状态、快捷键注册结果、降级中的功能 |

**快捷键**：`Win+Alt+Space` 显示/隐藏 · `Win+Alt+V` 剪贴板历史 · `Win+Alt+S` 截图取字 · `Win+Alt+T` 全局快速添加 · `Ctrl+K` 命令面板

---

## 🚀 安装

- 从 **Releases** 下载安装程序（`desktop-workbench-setup-x.x.x.exe`），双击运行即可安装 / 升级：
  <https://github.com/humble26/desktop-workbench/releases>
- 如需留档，可下载对应的源码包 `desktop-workbench-x.x.x-source.zip`（与仓库一致，已排除 `node_modules` / `dist`）。
- 关闭窗口只是最小化到系统托盘，退出请用托盘菜单。

### 数据存在哪、备份包含什么

用户数据都在 `%APPDATA%\桌面工作台`：

| 内容 | 文件 | 是否参与导出 / 备份 |
| --- | --- | --- |
| 待办 / 便签 / 打卡 / 快捷入口 / 文件分组 / 设置 | `workbench-data.json` | ✅ 参与 |
| 自动备份（保留最近 12 份） | `backups/workbench-*.json` | ✅ 参与 |
| 时间统计 | `usage-data.json`（自动保留 90 天） | ❌ 不参与，可单独清空 |
| 剪贴板历史 | `clipboard-history.json` + `clipboard/*.png` | ❌ 不参与，可单独清空 |
| 图标缓存 | `icons/*.png`（启动时清理未引用项） | ❌ 不参与 |
| 桌面小组件位置 | `widget-positions.json` | ❌ 不参与 |

- 主数据文件损坏或缺失时，启动会**自动从最近备份恢复**并弹通知。
- v1.8.2 首次启动会把数据结构从 schema v1 升级到 v2，升级前自动留一份不会被轮转清理的 `workbench-premigrate-*.json`。

---

## 🧱 项目结构

仓库根目录 **就是** Electron 应用（`package.json` 在根目录）。发布用的源码压缩包里它位于 `source\`。

```
desktop-workbench/
├── main.js                 # 主进程入口：窗口 / 托盘 / 快捷键 / IPC / 定时任务装配
├── preload.js              # 上下文隔离桥接（白名单 API，无 Node 暴露）
├── lib/                    # 主进程领域逻辑（不依赖 Electron，可单测）
│   ├── store.js            #   数据仓库：唯一落盘者、修订号、写合并、备份与自愈
│   ├── migrate.js          #   结构迁移与归一化（schema v1 → v2）
│   ├── defaults.js         #   默认数据结构与时间统计默认规则
│   ├── security.js         #   IPC 来源校验（本应用 renderer 目录 + 顶层框架）
│   ├── patchguard.js       #   渲染层补丁的形状 / 体积 / 白名单校验
│   ├── powershell.js       #   PowerShell 能力探测（含 pwsh 回退）与统一调用
│   ├── quickadd.js         #   「明天 15:30 开会」这类中文日期时间解析
│   ├── usage.js            #   时间统计：分类规则、时长累计、汇总
│   ├── iconcache.js        #   图标落盘缓存（替代内联 base64）
│   └── sensitive.js        #   敏感内容识别（JWT / 私钥 / 口令 / API Key）
├── renderer/               # 渲染进程（无构建步骤，普通 <script> 顺序加载）
│   ├── index.html          #   主界面（脚本清单即加载顺序）
│   ├── storeproto.js       #   数据补丁协议（主进程与渲染层共用，UMD）
│   ├── dateutil.js         #   日期工具（含月末安全顺延，UMD）
│   ├── importguard.js      #   导入数据守卫（UMD）
│   ├── core.js icons.js shell.js app.js
│   ├── view-*.js           #   11 个视图：首页/快捷入口/文件整理/待办/日历/便签/打卡/番茄钟/数据洞察/时间统计/设置
│   ├── dialogs.js search.js diagnostics.js actions.js guide.js
│   ├── style.css           #   设计令牌 + 深色主题（同一套令牌给两套值）
│   └── clipboard.* quickadd.* shot.* widget.*   # 四个独立小窗
├── test/                   # 119 项回归测试（node:test，无需 Electron）
├── tools/                  # 开发工具：语法检查、渲染层冒烟测试、拆分与打包校验脚本
├── ocr-data/               # 离线 OCR 语言模型（chi_sim + eng）
├── build/                  # 应用图标
└── scripts/                # 图标生成脚本
```

### 架构要点

- **单一写者**：`workbench-data.json` 只由主进程通过 `lib/store.js` 写入。渲染层不提交整份快照，而是提交「相对上次已知服务端状态的**差异补丁**」，因此主进程的并发写入（全局快速添加待办、逾期顺延、到期提醒标记、小组件开关）不会被渲染层覆盖。
- **界面状态不落盘**：当前页面、日历选择、待办筛选、番茄钟计时等只存在于内存（清单见 `storeproto.js` 的 `EPHEMERAL_KEYS`）。
- **渲染层在同一页面作用域内跨文件共享顶层声明**（无打包器）：`index.html` 里的 `<script>` 顺序即依赖顺序，新增顶层声明不得重名 —— 由 `test/contract.test.js` 守住。
- **所有渲染层脚本与页面同目录**：页面 CSP 是 `script-src 'self'`，`file://` 下跨目录脚本能否命中 `'self'` 并不可靠，因此不使用子目录。
- **进程边界有契约测试**：preload 暴露的 API ↔ 渲染层调用、IPC 通道 ↔ 主进程 handler、页面脚本清单 ↔ 实际文件，全部静态校验。

---

## 🛠️ 开发 / 测试 / 打包

```bash
npm install            # 安装依赖（node_modules 不进入版本库）
npm start              # 本地运行

npm test               # 119 项回归测试：协议/迁移/仓库/安全/解析/统计/缓存/样式/契约/主进程装配
npm run test:smoke     # 渲染层集成冒烟测试（真实 Electron + 真实页面，窗口隐藏）
npm run check          # 语法检查（遍历所有 JS）
npm run dist           # 生成 Windows 安装包（产物在 dist\）
```

- `npm test` 不需要图形环境，可直接在 CI 里跑。
- `test:smoke` 会启动真实 Electron `BrowserWindow`（`show: false`，使用独立临时 userData，不影响正在运行的实例），验证页面能否启动、渲染层改动是否真的落盘、以及并发写入是否会被覆盖；**需要桌面会话**。
- 依赖安全审计：`source\.npmrc` 使用了镜像源（不提供 audit 端点），请指定官方源：

```bash
npm audit --registry=https://registry.npmjs.org
```

---

## 📦 Release 资产说明

| 资产 | 说明 |
| --- | --- |
| `desktop-workbench-setup-<version>.exe` | Windows 安装程序（NSIS，可选安装目录，升级不丢数据） |
| `desktop-workbench-<version>-source.zip` | 与仓库一致的干净源码包（已排除 `node_modules` / `dist`） |

---

## 🔐 隐私与安全

- 应用**不发起任何业务网络请求**。唯一的联网行为是「检查更新」：只读取你在设置里填写的清单地址并比较版本号，**不会自动下载或安装**。
- 剪贴板历史默认开启**敏感内容过滤**（JWT / 私钥 / 口令 / API Key / GitHub / Slack / AWS / Google / Stripe Token 等）。注意这是「降低误存风险」，不是安全边界 —— 剪贴板历史文件是明文存储的。
- 渲染层开启 `contextIsolation` + `sandbox`，无 `nodeIntegration`；每个页面都有严格 CSP（`default-src 'none'`）；IPC 只接受来自本应用 `renderer` 目录的顶层页面。
- 自动文件整理会真实移动文件：规则目标必须是绝对路径，导入数据里的相关设置也会校验后才接受。

---

## 📜 更新日志

完整历史见 [CHANGELOG.md](CHANGELOG.md)。

### v1.8.2
- **修复数据丢失隐患**：主数据改为「单一写者 + 差异补丁提交」，渲染层不再整份覆盖（此前会覆盖掉主进程同时写入的快速待办 / 逾期顺延 / 提醒标记 / 小组件开关）
- **界面状态移出数据文件**（当前页面、日历选择、筛选、番茄钟计时等），并自动迁移旧数据（schema v1 → v2，未知字段一律保留，升级前留备份）
- 数据读取改为内存缓存 + 写合并，剪贴板 / 时间统计的高频轮询不再反复读盘
- IPC 来源校验收紧到本应用渲染目录；补丁提交增加形状 / 体积 / 白名单校验
- PowerShell 环境显式探测（含 `pwsh` 回退）：不可用时不再静默降级，设置页可见原因
- 代码结构重整：`main.js` 抽出 10 个 `lib/` 模块，`renderer/app.js`（2200 行）按视图拆成 20 个脚本
- 自动整理规则改动后对已有文件立即重扫；图标改为落盘缓存，数据文件不再被 base64 撑大
- 新增 **119 项回归测试** + 主进程装配测试 + 渲染层冒烟测试；修复 PowerShell 探测在中文系统被本地化警告破坏、导致功能被误判不可用的问题

### v1.8.1
- 修复：部分快捷方式（如 ZCode）图标显示为通用占位图的问题（GDI+ ExtractAssociatedIcon 兜底 + 内置占位图检测）
- 安全 / 稳定性加固：数据导入结构校验、剪贴板敏感内容过滤、截图裁剪边界与大小限制、月末重复任务日期安全顺延、自动整理失败重试、保存失败提示等

### v1.8.0
- 截图 OCR 取字（Win+Alt+S）、命令面板（Ctrl+K 升级，可执行动作）、桌面小组件

### v1.7.0
- 自动时间统计、分类规则自动归类、时间统计页、数据洞察增强、空闲自动暂停、状态独立存放

### v1.6.x
- 剪贴板历史（Win+Alt+V）、图片 OCR 提字、设置页重构

### v1.5.0
- 数据洞察、番茄钟、全局快速添加（Win+Alt+T）、重复待办自动顺延、毛玻璃背景、自动文件整理、内置检查更新

---

## 📄 许可证

本项目遵循 **MIT License**，详见 [LICENSE](LICENSE)。如需使用或二次开发，请保留版权声明。
