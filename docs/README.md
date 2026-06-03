# WPS Batch Rename & Download

WPS 表格附件批量改名和下载助手 —— 一个 Chrome 扩展（Manifest V3），把原先的控制台脚本插件化，提供 UI 面板、预览确认、批量下载能力。

---

## 目录

- [功能特性](#功能特性)
- [安装](#安装)
- [使用流程](#使用流程)
- [项目结构](#项目结构)
- [架构设计](#架构设计)
- [配置说明](#配置说明)
- [常见问题](#常见问题)
- [更新日志](#更新日志)

---

## 功能特性

- **智能扫描** — 自动识别 WPS 表格中的附件列，支持自定义表头别名
- **批量改名** — 按命名模板批量修改附件显示名和 WPS 附件对象名
- **批量下载** — 通过 `chrome.downloads` API 控制文件名，支持下载队列节流
- **预览确认** — 执行前展示改名计划，异常项高亮提示
- **双面板** — Popup 弹窗 + Side Panel 侧边栏，适应不同使用场景
- **执行报告** — 生成结构化报告，支持复制和 JSON 导出

---

## 安装

### 方式一：开发者模式加载（推荐）

1. 下载本仓库并解压到本地文件夹
2. 打开 Chrome/Edge，进入 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」，选择项目根目录
5. 扩展图标出现在工具栏，即可使用

### 方式二：Chrome Web Store

> 暂未发布。如需商店版本，请关注后续更新。

---

## 使用流程

1. **打开 WPS 表格** — 进入 `kdocs.cn` 的表格编辑页面
2. **点击扩展图标** — 打开 Popup 或 Side Panel
3. **扫描表格** — 点击「扫描」按钮，插件读取表格数据并生成任务计划
4. **预览确认** — 查看改名计划、匹配状态、异常项
5. **执行操作** — 确认后执行批量改名和下载
6. **查看报告** — 执行完成后生成结果报告

---

## 项目结构

```
kdocs-plugin/
├── manifest.json              # Chrome 扩展配置（Manifest V3）
├── src/
│   ├── background.js          # Service Worker — 下载队列、Side Panel 行为
│   ├── content-script.js      # Content Script — 消息桥接、脚本注入
│   ├── page-bridge.js         # 页面注入脚本 — 与 WPS 页面主世界通信
│   ├── wps-batch-rename-download.js  # 核心逻辑 — 表格读取、改名、下载
│   ├── popup.html / popup.js / popup.css      # Popup 弹窗 UI
│   └── sidepanel.html / sidepanel.js / sidepanel.css  # Side Panel 侧边栏 UI
├── icons/                     # 扩展图标（16x16 / 48x48 / 128x128）
├── fonts/                     # 自定义字体资源
├── dist/                      # 构建输出（如有）
└── docs/                      # 文档
```

### 各文件职责

| 文件 | 职责 |
|------|------|
| `manifest.json` | 扩展配置：权限、入口、host 匹配规则 |
| `background.js` | Service Worker：管理下载队列（600ms 间隔）、Side Panel 行为 |
| `content-script.js` | 隔离环境运行，负责注入 page-bridge 和消息转发 |
| `page-bridge.js` | 页面主世界运行，通过 postMessage 与 content script 通信 |
| `wps-batch-rename-download.js` | 核心业务逻辑：表格扫描、附件匹配、改名、下载 |
| `popup.*` | 弹窗 UI：扫描、预览、匹配、执行、报告 |
| `sidepanel.*` | 侧边栏 UI：列探索器、模板批量改名 |

---

## 架构设计

本项目采用四层架构，解决 Content Script 隔离环境无法直接访问 WPS 页面对象的问题：

```
┌─────────────────────────────────────────┐
│  Popup UI / Side Panel                  │
│  用户交互入口：扫描、预览、执行、报告      │
└─────────────────┬───────────────────────┘
                  │  chrome.runtime.sendMessage
┌─────────────────▼───────────────────────┐
│  Content Script                         │
│  隔离环境：脚本注入、消息桥接            │
└─────────────────┬───────────────────────┘
                  │  postMessage
┌─────────────────▼───────────────────────┐
│  Injected Page Script                   │
│  页面主世界：访问 window.APP、sheetData  │
└─────────────────┬───────────────────────┘
                  │  WPS 内部 API
┌─────────────────▼───────────────────────┐
│  WPS Page Runtime                       │
│  表格数据、附件对象、下载接口            │
└─────────────────────────────────────────┘
         │
         │  chrome.runtime.sendMessage
         ▼
┌─────────────────────────────────────────┐
│  Service Worker (background.js)         │
│  chrome.downloads、配置保存、下载队列    │
└─────────────────────────────────────────┘
```

### 关键设计决策

- **页面注入层必须运行在页面主世界** — 只有这里能访问 `window.APP`、`getTextLinkRuns`、`range.setFormula` 等 WPS 内部 API
- **下载由 Service Worker 管理** — 使用 `chrome.downloads` 替代页面内的 `<a download>`，更好地控制文件名、监听失败、处理重名
- **下载队列节流** — 600ms 间隔，避免一次性触发过多下载被浏览器限制

---

## 配置说明

插件支持以下配置项（通过 UI 或修改源码调整）：

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| 外箱标命名模板 | `外箱标-货件号-箱数箱` | 外箱标附件的命名规则 |
| 预约信命名模板 | `预约信-货件号-时间` | 预约信附件的命名规则 |
| 默认扩展名 | `.pdf` | 下载文件的默认后缀 |
| 最大扫描行数 | `10000` | 表格扫描上限 |
| 最大扫描列数 | `60` | 列扫描上限 |
| 下载间隔 | `700ms` | 文件间下载间隔 |
| 表头别名 | 可配置 | 支持自定义列名识别，如「箱标附件」「预约文件」 |

---

## 常见问题

**Q: 为什么需要页面注入脚本？不能直接放在 Content Script 里吗？**

A: Content Script 运行在隔离环境（isolated world），无法访问页面主世界的 `window.APP` 等对象。必须通过注入脚本才能在页面主世界执行 WPS 相关操作。

**Q: 插件支持 Firefox 吗？**

A: 当前版本基于 Chrome Manifest V3，主要支持 Chrome/Edge。Firefox 支持需要额外适配。

**Q: 下载的文件名不对怎么办？**

A: 插件通过 `chrome.downloads.onDeterminingFilename` 强制覆盖服务器返回的文件名。如果仍有问题，请检查命名模板配置是否正确。

**Q: 遇到「附件未匹配」怎么办？**

A: 插件会在预览阶段高亮显示未匹配项。你可以选择：① 跳过异常项继续执行；② 停止执行并检查表格数据。

**Q: WPS 页面更新后插件失效了？**

A: WPS 内部 API 不是公开接口，页面结构变动可能导致插件失效。请检查控制台错误信息，或提交 Issue 反馈。

---

## 更新日志

### v0.2.0
- 完成四层架构拆分（Page Script → Content Script → Service Worker → Popup/Side Panel）
- 新增 Side Panel 侧边栏 UI
- 下载迁移到 Service Worker，使用 `chrome.downloads` API
- 支持下载队列节流（600ms 间隔）
- 新增执行报告和 JSON 导出

### v0.1.0
- 初始版本：控制台脚本插件化
- 支持表格扫描、附件匹配、批量改名和下载
- 提供 Popup 弹窗 UI

---

## 技术栈

- **Manifest V3** — Chrome 扩展最新版本
- **原生 JavaScript** — 无构建工具，直接运行
- **Chrome Extension APIs** — `chrome.scripting`、`chrome.downloads`、`chrome.sidePanel`、`chrome.storage`

---

## 许可证

MIT
