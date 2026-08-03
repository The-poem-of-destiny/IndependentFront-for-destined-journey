# 工坊正则兼容性语料审查（2026-08-02）

> 创作者应先读[世界书 EJS 与输出美化正则创作指南](../reference/worldbook-ejs-regex-authoring-guide.md)。本文是语料与安全边界证据，不是作者 API 的唯一入口。

## 结论

公共工坊现有美化规则不是「少量 HTML 模板」，而是一套完整的浏览器内容面：99 条正则中，90 条输出 HTML、82 条带 `<style>`、35 条带 `<script>`、37 条输出完整 HTML 文档。99 条 pattern 全部可编译；按现行元数据映射有 94 条可落地，其余 5 条因 `promptOnly` 或 placement 不含 AI 输出位置而不导入。以 parent DOM 白名单消毒会直接破坏主要语料，因此现行实现保留 replacement 原文，把每条已提交消息的全部富匹配放进同一个无 same-origin、`credentialless`、`no-referrer` 的 `sandbox="allow-scripts"` iframe。外部 HTTP(S) 资源与原生网络 API 为兼容现有语料刻意放行。

该边界隔离应用 DOM、应用 storage/Dexie 存档和 API Key；form、popup、download、top navigation 与嵌套 frame 也仍被阻断，应用自有 `/api` 拒绝 `Origin: null`。正则唯一可持久化的能力是 Dexie v16 `regexStorage` 代表的共享不可信命名空间，不是任意 IndexedDB 或应用表访问。父页面 DOM 与任意宿主 API 依赖会被显式报告为降级；外部来源则不再视为降级。规则向远程/本地网络发请求，以及外传它可见的正文与 regex-namespace 数据，是当前威胁模型明确接受的暴露。

## 一次性快照

抓取只使用匿名公共 API，不发送 token、cookie、API Key，也不访问草稿或账户接口。
这是为本轮兼容性审查保留的本地一次性证据，不提供持续抓取或分析工具。完整响应、manifest、SHA-256、逐项目正则与分析结果放在 `reference/workshop-reference/`，该目录已 gitignore，避免把 41.6 MB 动态外部语料提交进仓库。

快照完整性：

| 项目                          |    结果 |
| ----------------------------- | ------: |
| API 报告的公开项目            |     303 |
| 唯一项目 ID                   |     303 |
| approved 项目                 |     303 |
| 详情响应                      | 303/303 |
| payload 响应                  | 303/303 |
| 有效 JSON payload             | 302/303 |
| 含正则的项目                  |      51 |
| 正则总数                      |      99 |
| 按现行 delimiter 规则编译失败 |       0 |

唯一无效 payload 是服务端真实返回的 HTTP 200 零字节文件；其详情与正则预览仍完整保存。

## 正则与 replacement 事实

| 能力                               |    规则数 |
| ---------------------------------- | --------: |
| HTML                               |        90 |
| replacement 捕获引用               |        82 |
| `<style>`                          |        82 |
| 外部来源                           |        60 |
| CSS `url(...)`                     |        54 |
| 完整 HTML 文档                     |        37 |
| 外层 Markdown HTML 围栏            |        36 |
| `<script>`                         |        35 |
| CSS `@import`                      |        32 |
| 表单控件/details 等交互元素        |        26 |
| 图片/音频/视频                     |        24 |
| data URL 资源                      |        19 |
| parent/top/opener                  |        16 |
| inline event handler               |        14 |
| 酒馆/宿主 API                      |        14 |
| SVG                                |        13 |
| local/session storage 或 IndexedDB | 8（词法） |
| `{{...}}` 宏                       |         5 |
| EJS 式宏                           |         1 |
| 显式 network API                   |         1 |
| Web Worker                         |         1 |

83 条 `findRegex` 使用 `/pattern/flags`，16 条是裸 pattern；裸 pattern 不能擅自补 `g`。82 条 replacement 使用捕获引用，最高到 `$39`，因此兼容器必须保持 JavaScript 的 `$1..$99`、`$&`、`$$`、前后缀与命名组语义。

replacement 总计约 407.6 万字符，中位 6,412 字符，p90 为 52,933，最大单条约 112 万字符。大规则含内嵌 data URL，不能在流式每个 token 上反复创建或执行。

表中的 storage 数字来自不剥注释的词法扫描。逐条审查后，准确结果是 **5 个项目、6 条 active 规则**，另有 2 条 Vera 规则只在注释/占位块里出现 `localStorage`。6 条 active 规则全部只调用同步的 `localStorage.getItem` / `setItem` / `removeItem`，没有 active `sessionStorage` 或 IndexedDB 用法；其值是字号/主题/悬浮位置、播放列表、修改器快照历史与素材可见性/缓存版本，均有跨 frame 或重载持久化需求。

## 已实现兼容契约

- `compileBeautifierSegments()` 在原文上按顺序匹配；先命中的 replacement 保持 opaque，后续规则只消费尚未命中的文本。
- 没有富命中时，原文通过 Vue 文本节点渲染；有富命中时，未命中原文先转义再进入共享 message iframe。模型原文 HTML 不进入 parent DOM。
- replacement 与捕获内容不消毒、不转义；同一条已提交消息的全部匹配共享一个 `sandbox="allow-scripts"` iframe，未命中原文先转义再组装，从而保留跨命中脚本与 inline replacement 的上游语义。
- iframe 不带 `allow-same-origin`，并使用 `credentialless` + `no-referrer`；CSP 放行 HTTP(S) 样式、图片、字体、媒体、脚本与 `fetch`/XHR/WebSocket/EventSource/`sendBeacon` 等原生网络路径，data/blob 资源与 blob worker 也可用。
- sandbox/CSP 仍不放行 form、popup、download、top navigation 与嵌套 frame；应用自有 `/api` 在路由前拒绝 sandboxed srcdoc 携带的 `Origin: null`。
- HTML/CSS/script、inline handler、SVG、控件、fragment、完整文档和外层 HTML 围栏均保留。
- Dexie v16 `regexStorage` 整张表是所有正则、信任级别和规则预览共享的一个不可信命名空间；工坊更新/卸载不删除它，并随 `FullBackup` 导出/导入。pre-v16 备份缺字段时保留当前表。
- 宿主先从 `regexStorage` 取快照，再组装 iframe；因此同步 `localStorage` 镜像与 `window.regexStorage` 别名会在 authored `<head>` script 执行前完成 hydration。写入先同步更新镜像，再异步落库并广播到其它 frame。
- 共享命名空间限制为 5 MiB、1024 keys、单 key 4096 UTF-8 bytes；`sessionStorage` 仍是每个 frame 的临时内存。正则不能访问 IndexedDB、应用 storage/Dexie、存档或 API Key。常见宿主全局仍只有空数据/no-op 兼容面。
- 流式阶段只画原生文本；提交后才创建 frame，防止脚本随 token 重跑。
- 规则预览、普通正文与战斗正文走同一 renderer；frame 通过只含高度、主题和右键坐标的消息协议与宿主通信。
- 工坊项目规则按当前存档的安装/启用信号 gating；默认关闭的内置规则现在可以从设置页真正启用。

## 有证据的降级与剩余缺口

1. **联网暴露（已接受）**：60/99 条引用 18 个外部 origin，现行边界允许这些资源与原生网络 API。它们不再产生 `degraded` note，已持久化的旧「隔离框禁止联网」提示在读取时过滤。远程端点仍可按自身 CORS/协议约束拒绝请求；这不是本应用的兼容降级。任意规则也可尝试访问本地网络或外传正文/regex-namespace 数据，应用只额外封堵自有 `/api` 的 `Origin: null`。
2. **宿主耦合**：16 条访问 parent/top/opener，14 条引用 SillyTavern 式 API。当前只提供空数据/no-op shim，不开放 parent DOM、存档、模型调用或任意状态对象。未来桥接只能是校验过的语义消息，不得恢复 same-origin。
3. **存储（已收口）**：词法扫描的 8 条中只有 6 条 active，且全是 `localStorage` 三个基本方法；共享持久镜像已覆盖它们。`sessionStorage` 仍只活在当前 frame，IndexedDB 保持不可用；这两项在现有语料中都没有 active 调用。
4. **replacement 宏**：5 条 `{{...}}` 与 1 条 EJS 式内容尚无 replacement 求值阶段，会按字面显示。
5. **上游元数据**：AI-output `placement=2` 已接入；不含 2 的 user-only 规则不会误投到 assistant 正文。`minDepth`/`maxDepth` 以最新 user/assistant 消息为深度 0、忽略 system event、含边界执行。现有 99 条语料的非零 `substituteRegex` 都没有 findRegex 宏，因此运行上惰性；`runOnEdit` 在没有消息编辑入口时不可达。prompt/history 改写、user-side 显示与 `trimStrings` 仍未接线。
6. **执行预算**：iframe 的权限隔离不等于 CPU 隔离。灾难性回溯与无限脚本循环仍可能阻塞渲染线程，工坊入口在完成预算方案和更广泛视觉走查前保持关闭。
7. **交互边界**：联网不等于授予浏览器宿主能力。form、popup、download、top navigation 与嵌套 frame 仍被 sandbox/CSP 阻断；这些边界不阻止规则使用已放行的资源与网络 API。
8. **纯正则项目不可启用**：存档启用信号要求项目至少有一个世界书条目，`entryUids=[]` 恒为未启用。语料中两个纯正则项目可以安装规则，但当前在任何存档都不可达。
9. **modal 不保证**：sandbox 没有 `allow-modals`；`alert/confirm/prompt` 不属于作者兼容面。语料中有 6 条词法命中，需另做 Chromium 真机确认。

旧版已经安装进 Dexie 的规则没有保留深度字段，且本地项目记录不含原 payload，无法从本地记录安全复原；对应项目需刷新或重装后才会获得精确深度行为。

## 验证门

本轮验证门覆盖：99/99 pattern 编译；双位数捕获与特殊 replacement token；完整文档/围栏拆装；HTML/CSS/script/inline handler 原样保留；共享 `localStorage` 的执行前 hydration、同步镜像、持久化、跨 frame 广播、配额与 FullBackup 往返；frame-ephemeral `sessionStorage`；CSP 放行远程资源与原生网络 API；opaque sandbox 不授予 IndexedDB、应用 storage、form/popup/download/top-navigation/nested-frame 能力；应用 `/api` 拒绝 `Origin: null`；自动高度；规则预览与生产 renderer 共路；API Key 迁移写入、回读、失败保留与应用 localStorage 清理。

后续解封工坊入口前，至少还应对 51 个含正则项目做截图基线，区分「外部资源兼容」「宿主 API 降级」「宏未求值」，并为正则与脚本增加可终止的执行预算。
