# WPS Batch Rename & Download

WPS 表格附件批量改名和下载助手 —— Chrome 扩展（Manifest V3）。

在 WPS / KDocs 在线表格页面中，自动识别表格数据、匹配附件、批量重命名并下载，告别手动逐个操作。

---

## 适用场景

- 你在 WPS 在线表格中管理大量带附件的订单/货件数据
- 需要按规则批量重命名附件（如 `外箱标-货件号-箱数.pdf`、`预约信-货件号-时间.pdf`）
- 需要一次性下载多个附件，且文件名符合业务规范

---

## 安装

### 方式一：开发者模式加载（推荐）

1. 下载本仓库代码并解压到本地文件夹
2. 打开 Chrome/Edge，地址栏输入 `chrome://extensions/`
3. 右上角开启「开发者模式」
4. 点击「加载已解压的扩展程序」，选择项目根目录
5. 扩展图标出现在工具栏，点击即可使用

### 方式二：拖放安装

1. 将项目文件夹压缩为 `.zip`
2. 在 `chrome://extensions/` 页面开启开发者模式
3. 直接将 `.zip` 文件拖放到扩展管理页面

> 目前未上架 Chrome Web Store，仅限本地安装使用。

---

## 使用流程

1. **打开 WPS 表格页面** — 进入 `https://www.kdocs.cn/` 中的目标表格
2. **点击扩展图标** — 打开 Side Panel 或 Popup
3. **检查页面** — 确认页面环境正常（WPS APP 已加载）
4. **扫描表格** — 读取表格数据，识别货件号、时间、箱数等列
5. **预览结果** — 查看生成的目标文件名、附件匹配状态
6. **执行操作** — 确认后执行：修改表格显示名、修改附件对象名、下载文件

---

## 功能说明

### Popup（点击扩展图标）

- **检查页面** — 检测当前页面是否为 WPS 表格、WPS APP 是否就绪
- **扫描** — 读取表格，生成改名计划
- **匹配附件** — 解析单元格中的附件链接，匹配附件 ID
- **执行** — 批量修改表格显示名、附件对象名，并触发下载
- **复制报告** — 导出执行结果和诊断信息

### Side Panel（侧边栏）

Side Panel 提供更丰富的操作界面：

- **列浏览** — 按列查看表格数据，快速定位
- **批量重命名附件** — 选择单元格范围，按模板批量重命名
- **批量下载附件** — 选择单元格范围，批量下载并自动命名
- **批量查询** — 按关键词搜索单元格内容
- **诊断工具** — 检查选中单元格的附件 API 状态

---

## 项目结构

```
kdocs-plugin/
├── manifest.json              # 扩展配置（Manifest V3）
├── src/
│   ├── background.js          # Service Worker — 下载队列、Side Panel 入口
│   ├── content-script.js      # Content Script — 脚本注入、消息桥接
│   ├── page-bridge.js         # 页面注入脚本 — 暴露 WPSBatch API 给扩展
│   ├── wps-batch-rename-download.js  # 核心逻辑 — 表格读取、附件解析、命名规则
│   ├── popup.html / popup.js / popup.css     # Popup UI
│   └── sidepanel.html / sidepanel.js / sidepanel.css  # Side Panel UI
├── icons/                     # 扩展图标
├── fonts/                     # 字体文件
├── dist/                      # 打包输出
└── docs/                      # 文档
```

---

## 架构

```
Popup / Side Panel UI
        |
        |  用户操作：扫描、预览、执行
        v
Content Script
        |
        |  消息转发、脚本注入
        v
Injected Page Script (page-bridge.js + wps-batch-rename-download.js)
        |
        |  访问 window.APP、sheetData、WPS 内部 API
        v
WPS Page Runtime

Service Worker
        |
        |  chrome.downloads、配置保存、下载队列
        v
Browser APIs
```

---

## 配置

插件支持以下配置项（通过 Side Panel 设置）：

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| 外箱标命名模板 | 外箱标附件的目标文件名格式 | `外箱标-货件号-箱数箱` |
| 预约信命名模板 | 预约信附件的目标文件名格式 | `预约信-货件号-时间` |
| 默认扩展名 | 下载文件的扩展名 | `.pdf` |
| 最大扫描行数 | 表格扫描上限 | `10000` |
| 最大扫描列数 | 列扫描上限 | `60` |
| 下载间隔 | 文件下载间隔（防浏览器限制） | `700ms` |
| 表头别名 | 支持自定义列名识别 | — |

---

## 技术栈

- **Manifest V3** — Chrome 扩展最新规范
- **原生 JavaScript** — 无构建工具，无框架依赖
- **chrome.scripting** — 运行时脚本注入
- **chrome.downloads** — 程序化下载管理
- **chrome.sidePanel** — 侧边栏面板
- **postMessage** — 跨层通信（Content Script ↔ Page Script）

---

## 常见问题

**Q: 为什么需要注入页面脚本？**
> WPS 内部 API（如 `window.APP.getActiveSheet()`、`getTextLinkRuns`）只能在页面主世界访问，Content Script 运行在隔离环境无法直接调用，因此需要通过 `chrome.scripting` 注入脚本到页面主世界。

**Q: 下载的文件名不对？**
> 扩展通过 `chrome.downloads.onDeterminingFilename` 强制覆盖文件名。如果仍不对，请检查浏览器下载设置是否允许扩展控制文件名。

**Q: 附件匹配失败？**
> 可能是表格列位置变化或附件链接格式不同。使用 Side Panel 的「诊断工具」检查单元格附件状态，或在配置中调整表头别名。

**Q: 支持 Firefox 吗？**
> 当前仅支持 Chrome / Edge（Chromium 内核）。Firefox 需要适配 Manifest V2/V3 差异。

---

## 更新日志

### v0.2.0
- 新增 Side Panel 界面，支持列浏览、批量查询、诊断工具
- 优化下载队列，600ms 间隔节流
- 支持通过 `onDeterminingFilename` 强制覆盖下载文件名
- 新增配置化命名模板和表头别名

### v0.1.0
- 初始版本：控制台脚本插件化
- 支持 Popup 扫描、预览、执行、报告

---

## 许可

内部自用项目，暂不对外发布。
