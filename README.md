# 桌面工作台（desktop-workbench）

一个集成 **待办 / 便签 / 打卡 / 长期目标 / 剪贴板历史 / 截图 OCR / 时间统计 / 文件自动整理** 的 Windows 桌面效率应用。基于 Electron，界面简约，数据全部本地存储。

> 当前版本：**v1.8.1**

---

## ✨ 功能一览

| 模块 | 说明 |
| --- | --- |
| 📋 待办 & 重复任务 | 快速添加、优先级、子任务、截止日期、每30秒到期提醒、逾期自动顺延、月度任务月末安全顺延 |
| 📝 便签 | 灵感速记，支持分组 |
| ✅ 习惯打卡 | 每日打卡与连续天数统计 |
| 🎯 长期目标 | 目标跟踪与进度 |
| 📎 剪贴板历史（Win+Alt+V） | 自动记录复制的 文本 / 图片 / 文件；搜索、置顶、按类型过滤；图片内置离线 OCR 提字；可开启「敏感内容过滤」，JWT / 口令 / API Key 等不录入历史 |
| 🖼️ 截图 OCR 取字（Win+Alt+S） | 框选屏幕任意区域，离线识别并自动复制，裁剪带边界与大小限制 |
| ⏱️ 时间统计 | 后台自动采样前台应用，记录使用时长并自动分类（工作 / 开发 / 浏览 / 沟通 / 娱乐 / 其他），含番茄钟标注 |
| 🍅 番茄钟 | 专注 / 短休 / 长休 |
| 📊 数据洞察 | 完成率、近14天活动强度、当日概况 |
| 📁 自动文件整理 | 监控文件夹，按扩展名 / 关键词自动归类（目标路径仅接受绝对路径） |
| 📦 桌面小组件 | 时钟 / 今日待办 / 便签可固定为桌面小窗 |
| 🧭 命令面板（Ctrl+K） | 搜索内容之外可直接执行动作：新建待办/便签、打开剪贴板、截图、开始番茄钟、切换置顶/主题、立即备份 |

**快捷键**：`Win+Alt+V` 剪贴板历史 · `Win+Alt+S` 截图取字 · `Win+Alt+T` 全局快速添加 · `Ctrl+K` 命令面板

---

## 🚀 安装

- 从 **Releases** 下载安装程序（`desktop-workbench-setup-x.x.x.exe`），双击运行即可安装 / 升级：
  <https://github.com/humble26/desktop-workbench/releases>
- 如需留档，可下载对应的源码包 `desktop-workbench-x.x.x-source.zip`。
- 用户数据保存在 `%APPDATA%\桌面工作台`（`settings.json` / `store.json` / `usage-data.json`），自动备份与损坏恢复，升级不会丢失数据。

> ⚠️ 首次安装 / 重新打包时，请勿将 `token.txt` 等凭据文件包含进源码包或发布目录；`.gitignore` 已默认将其排除。

---

## 🧱 项目结构

```
desktop-workbench/
├── source/                 # Electron 应用源码（package.json 位于此）
│   ├── main.js             # 主进程：窗口 / 快捷键 / 数据存储 / 剪贴板 / OCR / 自动整理
│   ├── preload.js          # 上下文隔离桥接
│   ├── renderer/           # 渲染进程（界面）
│   │   ├── index.html      # 主界面
│   │   ├── app.js
│   │   ├── style.css
│   │   ├── quickadd.*      # Win+Alt+T 快速添加小窗
│   │   ├── clipboard.*     # 剪贴板历史小窗
│   │   ├── shot.*          # 截图取字小窗
│   │   └── widget.*        # 桌面小组件
│   ├── ocr-data/           # 剪贴板图片 OCR 离线语言模型（chi_sim + eng）
│   ├── build/              # 应用图标
│   └── scripts/            # 图标生成脚本
├── dyweb-spider/           # 可选：一个 Python 资料下载器（独立于工作台本体）
└── .gitignore
```

---

## 🛠️ 开发 / 重新打包

以下命令需在 `source\` 目录内执行（`package.json` 位于该目录）：

```bash
cd source
npm install        # 安装依赖（node_modules 不进入版本库）
npm start          # 本地运行
npm run check      # 语法检查（校验所有 JS 文件）
npm run dist       # 生成 Windows 安装包（产物在 dist\）
```

依赖安全审计：由于 `source\.npmrc` 使用了镜像源（不提供 audit 端点），执行 `npm audit` 时请指定官方源：

```bash
npm audit --registry=https://registry.npmjs.org
```

---

## 🔌 Python 下载器（可选）

`dyweb-spider/` 是一个独立的命令行下载器，与 Electron 应用本体解耦。令牌按以下优先级读取（避免在源码包中明文保存）：

1. 环境变量 `DYWEB_TOKEN`
2. 命令行参数 `--token`
3. `token.txt`

```bash
cd dyweb-spider
python dyweb_spider.py --help
```

---

## 📦 Release 资产说明

- `desktop-workbench-<version>-source.zip`：干净的源码包（与仓库一致，已排除 `node_modules` / `dist` / 凭据等）
- `桌面工作台 Setup <version>.exe`：Windows 安装程序

---

## 📜 更新日志

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

本项目遵循 **MIT License**。如需使用或二次开发，请保留版权声明。