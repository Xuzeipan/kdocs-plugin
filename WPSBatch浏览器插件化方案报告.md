# WPSBatch 浏览器插件化方案报告

## 结论

建议把现在的控制台脚本改造成一个 Chrome Manifest V3 扩展。不要简单做成“点按钮后把整段脚本塞进页面”的一次性工具，而是拆成四层：页面注入层、内容脚本层、后台服务层、弹窗 UI 层。

这个方向最稳。原因是现有脚本必须访问 WPS 页面里的 `window.APP`、`WPSOpenApi`、`sheetData`、`getTextLinkRuns` 等页面主世界对象；普通 content script 默认跑在隔离环境里，拿不到这些对象。扩展需要在页面主世界注入业务内核，同时把下载、配置、状态保存、用户确认放到扩展侧。

## 现有脚本能力

当前文件：

`/Users/xuzepeng/Documents/Codex/2026-05-06/https-www-kdocs-cn-l-cserfttnvd3m/wps-batch-rename-download.js`

脚本规模约 4493 行，已经包含完整闭环：

- 从 WPS 表格读取数据，生成改名计划。
- 按表头定位列，不再固定 C 列和 F 列。
- 支持较大表格扫描，默认 `10000` 行、`60` 列，连续空行后停止。
- 通过 WPS 内部 cell/link API 读取附件 ID。
- 通过 `range.setFormula` 更新表格内附件显示名。
- 通过 WPS 附件接口修改附件对象名称。
- 通过附件下载接口拿 `download_url`，再触发下载。
- 提供多组诊断报告，比如表格识别、附件 API、link run、probe hooks。
- 用 `localStorage` 保存 probe 和附件映射状态。

最关键的工作路径是：

1. `buildPlanDirectlyFromPage()` 读取表格，生成任务计划。
2. `makeAutoAttachmentMap()` 为每个任务匹配附件 ID。
3. `updateSheetAttachmentCellsByAttachmentMap()` 更新单元格显示名。
4. `renameByAttachmentMap()` 修改 WPS 附件对象名。
5. `downloadByAttachmentMap()` 下载文件。
6. `renameAndDownloadAuto()` 串起完整流程。

## 插件化目标

要做的是一个“WPS 表格附件批量改名和下载助手”，不是一个泛用网页下载器。

插件进入 WPS/KDocs 表格页面后，用户可以点扩展图标，看到当前表格的识别结果：行数、附件数、目标文件名、异常项。用户确认后，插件执行批量改名、附件对象改名和下载。执行前要有预览，执行后要有结果报告。

## 不做什么

第一版不建议做这些：

- 不做账号系统。
- 不做云端任务队列。
- 不做跨浏览器兼容，先做 Chrome/Edge Chromium。
- 不做任意表格格式的智能推断，只支持配置过的列名和命名规则。
- 不绕过 WPS 权限，用户在页面里没有编辑或下载权限时，插件只提示失败原因。
- 不把 WPS 内部 API 包装成长期稳定 SDK，因为这些接口不是公开契约。

## 推荐架构

建议拆成四层。

```text
Popup UI
   |
   |  用户点击：扫描、预览、执行、导出报告
   v
Content Script
   |
   |  和页面注入脚本通信，转发状态给后台
   v
Injected Page Script
   |
   |  访问 window.APP、sheetData、getTextLinkRuns、execCommand
   v
WPS Page Runtime

Service Worker
   |
   |  chrome.downloads、配置保存、长期状态、错误日志
   v
Browser APIs
```

### 页面注入层

把现有 `WPSBatch` 的核心逻辑迁移到页面注入脚本里。它必须运行在页面主世界，因为只有这里能访问：

- `window.APP`
- `window.APP.getActiveSheet()`
- `activeSheet.getTextLinkRuns(row, col)`
- `activeSheet.getCoreHyperlinks().getCellLinkRuns(row, col)`
- `window.APP.execCommand("range.setFormula", param)`

这一层只负责读 WPS 状态和调用 WPS 内部命令。它不直接操作扩展下载 API，也不负责 UI。

### Content Script

content script 负责连接页面注入脚本和扩展。它做三件事：

- 把 popup 的请求转给页面注入脚本。
- 把页面注入脚本的结果转给 service worker 或 popup。
- 在页面上放一个可选的轻量状态提示，比如“正在扫描”“已完成”“有 3 个附件未匹配”。

content script 默认隔离环境拿不到页面变量，所以不能把主逻辑放在这里。

### Service Worker

service worker 负责扩展侧能力：

- 调用浏览器下载 API，指定下载文件名和目录。
- 保存用户配置，比如表头别名、命名规则、默认下载目录。
- 记录执行历史和错误报告。
- 管理下载队列，避免一次性触发太多下载。

下载建议放到 service worker 里，而不是继续用页面里的 `<a download>`。原因是扩展的下载 API 更适合控制文件名、监听失败和处理重名。

### Popup UI

popup 是用户操作入口。第一版需要这些功能：

- 当前页面状态：是否是 WPS 表格、是否检测到 `window.APP`。
- 扫描按钮：读取表格并生成计划。
- 预览表：原文件名、目标文件名、类型、货件号、行号、状态。
- 执行按钮：改表格显示名、改附件名、下载。
- 配置入口：列名别名、命名模板、扫描行列上限。
- 报告入口：复制诊断报告、导出 JSON。

UI 不需要复杂，重点是执行前让用户看清楚计划。

## Manifest V3 设计

建议使用 Manifest V3。Chrome 官方文档里，`chrome.scripting` 用于运行时注入脚本，需要 `scripting` 权限和 host permissions 或 `activeTab`。content scripts 默认在隔离环境运行，manifest 支持指定 `world: "MAIN"`，但直接在主世界运行有风险，建议只把必要的页面访问逻辑放进去。下载文件要用 `chrome.downloads`，并在 manifest 里声明 `downloads` 权限。

建议权限：

- `scripting`，注入页面脚本。
- `activeTab`，只在用户点击插件时临时获得当前页权限。
- `downloads`，批量下载并指定文件名。
- `storage`，保存配置和执行历史。
- host permissions 限制在 `https://www.kdocs.cn/*` 和必要的 WPS 静态域名，先不要申请全站权限。

## 模块拆分建议

现有脚本应该拆成这些模块：

- `core/table-reader`：表格读取、表头识别、任务计划生成。
- `core/name-rules`：命名规则、文件名清洗、日期/箱数/货件号解析。
- `core/attachment-resolver`：附件 ID 读取、link runs 解析、候选匹配。
- `core/wps-mutator`：更新单元格显示名、修改附件对象名。
- `core/reporting`：诊断报告、执行结果、错误结构化。
- `page-bridge`：页面主世界脚本，暴露受控命令。
- `content-bridge`：content script 消息桥。
- `background-downloads`：下载队列和浏览器下载 API。
- `popup`：操作界面。

不要把 4493 行脚本原封不动塞进 content script。那样短期能跑，后期很难维护。

## 数据流

完整执行流程建议这样走：

1. 用户打开 WPS 表格页面。
2. 用户点击扩展图标。
3. popup 请求 content script 检查页面环境。
4. content script 注入或唤醒 page script。
5. page script 读取表格，返回 plan。
6. popup 展示预览，用户确认。
7. page script 读取附件 ID，返回 attachment map。
8. popup 二次展示异常项，用户确认执行。
9. page script 更新表格显示名和 WPS 附件名。
10. service worker 根据 attachment map 拉取下载 URL，并调用浏览器下载 API。
11. popup 显示结果，可复制报告。

## 配置设计

第一版需要支持这些配置：

- 表头别名：货件号、时间、箱数、外箱标附件、预约信附件。
- 命名模板：外箱标和预约信各一条。
- 扫描范围：最大行数、最大列数、连续空行停止阈值。
- 下载节流：每个文件之间的间隔。
- 失败策略：遇到未匹配附件时停止，还是跳过继续。
- 是否修改表格显示名。
- 是否修改 WPS 附件对象名。
- 是否下载。

默认配置沿用当前脚本：

- 外箱标：`外箱标-货件号-箱数箱`
- 预约信：`预约信-货件号-时间`
- 默认扩展名：`.pdf`
- 最大扫描行数：`10000`
- 最大扫描列数：`60`
- 下载间隔：`700ms`

## 风险点

最大风险是 WPS 内部 API 不是公开接口，未来页面版本变动可能导致 `getTextLinkRuns`、`range.setFormula` 或附件接口变化。

第二个风险是下载量很大时，浏览器可能限制多文件下载，或者用户设置里需要允许网站/扩展批量下载。插件要做下载队列，不要一次性触发全部下载。

第三个风险是附件 ID 匹配错误。当前脚本有顺序兜底匹配，插件里要把它降级为“需要用户确认”的高风险状态，不应该默认无提示执行。

第四个风险是权限体验。插件如果一开始申请过宽权限，会让用户不放心。建议用 `activeTab` 加有限 host permissions，用户点插件后再工作。

## 回滚与安全

下载本身不改远端数据，不需要回滚。

修改表格显示名和 WPS 附件对象名会改远端数据。执行前必须生成执行计划，保存旧值：

- 原单元格文本。
- 原 `kw:annex` 地址。
- 原附件对象名。
- 新目标名。
- 执行状态。

如果只改了一半，插件可以提供“按上次执行记录恢复名称”的入口。第一版至少要导出 JSON 报告，让用户能手动追踪。

## 测试路径

最低测试集：

- 当前已跑通的测试表。
- 列位置变化：附件列不在 C/F。
- 大表：至少 500 行、1000 个附件任务。
- 缺失附件：某行只有外箱标或只有预约信。
- 表头别名：比如“箱标附件”“预约文件”。
- 名称已有多余文字：比如带“测试的”。
- 权限不足：只读页面、禁止下载页面。
- WPS 页面加载未完成：用户刚打开就点插件。
- 执行中断：刷新页面或网络失败。

手动验收标准：

- 扫描结果和表格行数一致。
- 每条任务的 source、target、row、colIndex 正确。
- 所有附件 ID 都能匹配，不能匹配时不会执行。
- 表格里的附件显示名被更新。
- WPS 附件对象名被更新。
- 下载文件名和 target 一致。
- 执行报告能解释每个失败项。

## 推荐开发阶段

第一阶段，先把控制台脚本改成“页面内核模块”。目标是保留现有功能，但把全局 `WPSBatch` 拆出清晰 API：扫描、预览、匹配、执行、报告。

第二阶段，做最小 Chrome 扩展。popup 只有三个按钮：扫描、执行、复制报告。下载仍可先沿用现有页面下载逻辑，先证明注入和通信可行。

第三阶段，把下载迁移到 service worker 和 `chrome.downloads`。这一步解决文件名、失败监听和批量下载体验。

第四阶段，做配置界面和执行历史。支持不同表格模板，降低换文档后的手动改脚本成本。

第五阶段，打包发布。先内部使用，不建议一开始上 Chrome Web Store，因为 WPS 内部 API 变动风险较高。

## 需要确认的问题

在开始实现前，需要你确认三件事：

1. 插件只做 Chrome/Edge Chromium，还是也要支持 Firefox？
2. 下载文件是否需要固定到某个子目录，比如 `WPSBatch/文档名/日期/`？
3. 遇到部分附件未匹配时，默认是停止全部执行，还是跳过异常项继续？

## 建议

我建议第一版做“内部自用版 Chrome 扩展”，不追求商店发布。核心目标是把当前脚本从控制台搬到插件里，让它可重复、可配置、可预览、可回滚。

这个计划假设 WPS 当前的 link-runs 和附件接口在近期不会完全改掉。如果这个假设不成立，插件仍然能通过诊断报告告诉用户哪里断了，但不能保证无需维护。

## 参考

- Chrome 官方文档：`chrome.scripting` API，说明运行时注入需要 `scripting` 权限和 host permissions 或 `activeTab`。
- Chrome 官方文档：content scripts 默认在隔离环境运行，manifest 可指定 `world: "MAIN"`，但主世界脚本有被页面干扰的风险。
- Chrome 官方文档：content scripts 不能直接访问所有扩展 API，需要通过消息和扩展其他部分通信。
- Chrome 官方文档：`chrome.downloads` API 需要 `downloads` 权限，用于程序化发起和管理下载。
