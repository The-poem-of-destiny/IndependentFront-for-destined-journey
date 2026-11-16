# 插件系统设计 v1（ADR-36 暂定）

> 状态：已实施（2026-11-15）：P1a/P1b/P2 自动化部分；人工矩阵未跑；S7 已改为自动判定（见 §4.8 的「📌 2026-11-15 S7 自动判定」注），Chromium 156 真机复跑自检全过。（原状态行：「设计稿（2026-11-15），未实施。」）P3（工坊接入）、P4 与 Q1/Q7/Q11/Q12 未做；实施注记见下方「📌 2026-11-15 实施注记」，创作者文档见 `docs/reference/plugin-authoring-guide.md`。
> 修订 r2（2026-11-15）：浏览器实测推翻了「插件脚本跑在沙盒 iframe 里」的地基（CSP 拦不住 WebRTC）。本版改为「插件代码只跑在 Dedicated Worker，界面由宿主按声明式标记渲染」；启动自检改成带对照组的金丝雀探测；本地目录移出 Vite root；启用插件的存档里美化帧一律断网并停脚本；逐条处理独立审查的 16 条发现。
> 修订 r3（2026-11-15）：处理复审 13 条（R2-1 至 R2-13）：插件存档的美化帧加牢笼帧并剥 `meta` / `link` / `base`；视图帧 nonce 改为运行时哈希；收紧 URL 白名单与 blob MIME；补齐金丝雀的方法、WebSocket、对照组与等待窗口；Web Locks 的安全上下文与接管；D10 改列为设计结论。
> 修订 r4（2026-11-15）：主人改了红线。「不能联网」取消，新增「不得访问本机和局域网上的服务」（红线 D）。插件改回跑在 opaque 沙盒 iframe 里，可以用完整的 JS、DOM 和任意 UI 框架，可以按 manifest 声明的域名联网。删除 Worker 全局白名单、声明式界面协议、清洗器、OffscreenCanvas 通道和「插件存档里美化帧断网」。新增联网域名的校验与 CSP 生成、D 的逐条论证、安装与启用时的风险确认、现有美化帧风险一节。Worker 方案与实测记录压缩进附录 A。
> 修订 r5（2026-11-15）：处理 r4 审查 10 条（R4-1 至 R4-10），把 §11 美化帧修法的前两档改为启用插件的硬前置并进自检，「不联网」改为「未声明联网域名」且三条风险警告对所有插件无条件显示，删除 `remoteCode`，`openExternal` 默认只复制链接，并补齐自检项与 WebRTC 论证。
> 编号约定：D = 已裁定，Q = 待裁定，P = 分期，S = 自检项。路径相对仓库根，行号为 2026-11-15 实读。
> 标注口径：「实测」= 2026-11-15 在 Chromium 156.0.8078.75 上测过；「规范」= 规范明文，未在本项目测过；「未验证」= 推断，由启动自检（§4.8）或人工矩阵证明。
> 关联文档：`docs/planning/2026-07-31-creative-workshop-compat-design.md`（D16、附录 B）、`docs/planning/2026-08-27-timeline-restore-implementation-plan.md`、`docs/planning/2026-08-30-player-persona-editing-design.md`。

## 📌 2026-11-15 实施注记

本节记实施时的裁定与偏离，正文各节不改写，只在对应位置补带日期的短注。

范围：

- 已实施：P1a、P1b、P2 的自动化部分（`npm run gates` 全绿）。
- 未做：P3（工坊入口仍锁）、P4、Q1、Q7、Q11、Q12；P1a 的人工矩阵（§4.8 末段、§9），包括 WebRTC 抓包和插件帧里文件选择器的人工点测。

主人 2026-11-15 的裁定（详见 §10 的短注）：

- Q2 接受 WebRTC 与资源提示的残余，写进风险说明。
- Q5 自检全过即启用，不维护「已测大版本」表；只保留 S7 那张文件选择器的窄表。
- Q6 FullBackup 不带插件包字节。
- Q8 玩家亲手交给插件的文件不算破 C，写进风险说明。
- Q9 默认目录 `../poem-plugins`（仓库上一级）；开发者模式的「跟随文件夹自动重载」默认关，且只在开发者模式打开时生效。
- 新增裁定：浏览器自己就拦下 opaque origin 帧访问 loopback 时（带 `allow-same-origin` 的管线对照组命中、全部 opaque 核心对照组都不命中），S0 判通过并记 `browserBlocksLocal`。此时红线 D 由浏览器执行（§4.8 短注）。

设计之外的实现决定：

- 按存档启用的确认只记在本机（`PluginRecord.saveConsents[saveId]`，该表不进 FullBackup）。生效条件是三者同时成立：存档元数据 `enabledPluginIds` 里有它、本机确认的 `networkHash` 与当前一致、自检通过。导入的存档一律要在本机重新确认（偏离 §3.4「确认记录存在插件行和存档元数据里」）。
- `metadata.pluginHardened` 是粘性标记：第一次在某存档启用插件时置上，进入一个列出了插件的存档时也置上，之后不清除。置上后该存档的两档美化帧走加固模式（§11 前两档）。
- 上限：单条 `ai.note` 2000 字，每存档待告知队列 16 条，常驻提示块 4000 字，存档数据袋每插件 256KB，全局数据每插件 1MB。
- 卸载插件删除它的全局数据（`pluginKv`），各存档里的 `worldFlags.plugins[id]` 保留（§6.4 的「重装后可续用」只对存档数据成立）。
- `memory.add`（P2 开放）：全局写锁在外、存档写锁在内，记忆 id 由引擎在事务里分配；插件只给 `content`、`keywords`、`importance`。
- `character.rename` 必须显式给 `target`，并且从不改主角的名字（主角改名仍走人设编辑）。`character.remove` 同样拒绝主角（按别名解析后在锁内复检）。
- 自检的对照组分「核心」和「可选」两类通道：核心通道没命中判失败；可选通道没命中只记一条说明，不判失败。
- 美化规则帧的探针里没有表单提交一项：规则帧的沙盒没有 `allow-forms`，表单本来就提交不了。
- S5（重定向）是尽力而为：第二个 loopback 主机名不可达时标「跳过」。

真机自检结果（2026-11-15，Claude 浏览器窗格，Chromium 156.0.8078.75，dev server 跑在 localhost）：

- CAGE 通过（内层用 srcdoc）；S0 经 `browserBlocksLocal` 通过；S1–S4、S6 金丝雀零命中；S5 跳过；S7 失败（插件帧里有 `showSaveFilePicker`，`PICKER_VERIFIED_ENGINES` 为空）。
- 所以目前在 Chromium 上插件保持禁用，要等人跑一次人工选择器探针（开发者模式 → 插件管理 → 人工矩阵），确认后把引擎和大版本加进那张表。
- 没测过：Firefox、Safari、真正的 Chrome、preview server、经 Vite upgrade 的 WebSocket 金丝雀、真服务器上的 `/@fs/` 拒绝、两个标签页之间的 Web Locks、界面走查。

已知缺口（缺陷登记在 `docs/known-issue.md`）：

- 主题实时切换不会推给已打开的插件帧。
- `save.leave` 可能到不了帧（帧随离开一起拆掉）。
- 回合快照里可能还留着被该回合消费掉的告知。
- RANDOM_EVENTS 的兜底追加只到 Delta 会话的基线回合（早于插件系统，与插件无关）。
- `session-backup.ts` 分配记忆 id 时没拿全局锁（早于插件系统）。
- `plot` 投影包含隐藏的剧情事件（待裁定）。

## 0. 已裁定

| 号   | 裁定                                                                                                                                                                                                     |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1   | 开放第三方插件；所有插件（含本地文件夹里的）一律按第三方对待                                                                                                                                             |
| D2   | 插件造物、改钱可接受，不设数值上限                                                                                                                                                                       |
| D3   | AI 是否知情由插件作者决定，宿主提供多种手段（§5.8）                                                                                                                                                      |
| D4   | 生成中、战斗中的写请求一律拒绝（`BUSY` / `IN_COMBAT`），不排队                                                                                                                                           |
| D5   | 接受「回退某回合会连带撤销其后的插件写入」                                                                                                                                                               |
| D6   | 商品目录等内容由插件自带                                                                                                                                                                                 |
| D7   | 分发渠道两条：app 本地文件夹、创意工坊（工坊锁定中，本文只写接入点）                                                                                                                                     |
| D8   | 先只做应用内浮动窗，真弹窗延后                                                                                                                                                                           |
| D9   | MVP 全开命令词汇：凡能映射到现有 `StatePatchOp` 的都开。例外：`memory.add` 推迟（§5.3）                                                                                                                  |
| D11  | 2026-11-15 改红线。核心诉求原话：「用户的 API Key 和电脑不能出问题」。插件可以联网。钓鱼、隐私外发、远程代码都不算红线，改为在安装和按存档启用时给出明确的风险警告和免责声明，由玩家自己决定             |
| 红线 | A 不接触任何密钥或凭据。C 不新增、修改、删除本地文件，也不读取本机文件（自己插件包里的除外）。D 不得访问本机（loopback）和局域网（私有地址段、链路本地、`.local`）上的任何服务。红线内权限能给多少给多少 |

D10（r2 的「插件代码只能跑在 Worker」）随红线 B 取消而撤回，见附录 A。

## 1. 背景与目标

玩家与作者需要在不改引擎的前提下加玩法界面：在现有界面上加入口、叠一层 overlay、开一个窗口，并从这些界面改游戏状态。典型例子是商店：买东西，物品进背包，钱被扣。

现状约束：

- 运行形态是纯浏览器 SPA。BFF 是挂在 vite dev/preview 中间件上的零状态转发器（`server/app.ts:74-79`，`vite.config.ts:32,117`）。全部存档在浏览器 IndexedDB（`src/core/persistence/database.ts:232`，v33）。没有桌面壳。
- 状态写入只有 `StateManager` 一个入口，按存档串行（`src/core/state/state-write-queue.ts:30`）。
- 引擎 EventBus 与战斗 v3 内核都已删除（`AGENTS.md:512-519`）。现役战斗是 `src/core/combat/sandbox/`。
- 已有一个不可信内容沙盒先例：输出美化的 opaque iframe（`src/ui/lib/beautifier-frame.ts`）。插件帧沿用它的隔离方式，但网络策略不同（§4.2、§11）。

目标：第三方插件能贡献 UI、读状态投影、经声明式命令写状态、自带按存档的存储、按声明联网。

非目标（v1）：插件改引擎流程或提示装配逻辑；插件改世界书、预设、设置、素材库；真弹窗；防「插件把存档改坏」（D2 已接受）。

## 2. 红线与威胁模型

### 2.1 红线的精确定义

- A：插件代码在任何时刻都拿不到 API Key、图像连接密钥、自定义请求头、Discord 会话令牌、内容包租约、工坊 JWT 的明文或可逆形式。
- C：插件不能造成本机文件系统上任何文件的创建、修改或删除，也不能读取插件包以外的本机文件。玩家亲手选中或拖入的文件怎么算见 Q8。
- D：插件不能向本机和局域网上的服务发出它们能理解的请求。「本机和局域网」指 loopback（`127.0.0.0/8`、`::1`、`localhost`）、私有地址段（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`）、链路本地（`169.254/16`、`fe80::/10`）和 `.local` 等内网名字。典型目标是 ComfyUI（`http://127.0.0.1:8188`，`src/ui/lib/image-client.ts:593`）、Ollama、本应用的 BFF、路由器和 NAS 的管理界面。
- D 的澄清：宿主把受插件影响的提示词发给玩家自己配置的服务（包括本机的 Ollama 或 ComfyUI），不算破 D。插件只影响提示词文本，从不选择端点或工作流（Q1 的条件同此）。

### 2.2 不是红线、靠告知处理的事（D11）

- 钓鱼：插件界面仿冒宿主，索要 API Key 或密码。
- 隐私：插件把存档、聊天内容发到它声明的服务器。
- 远程代码：插件运行时从网上拉代码，行为可以随时变。

这三件事不设技术防线，由安装和启用时的风险确认处理（§3.4）。

### 2.3 攻击者与边界

插件作者控制包内全部文件和它声明的域名，可以同时发布工坊正则规则和世界书条目与插件配合，可以诱导 AI 输出特定文本。攻击者不控制宿主代码和玩家的浏览器扩展。

划在威胁模型之外：Spectre 类推测执行攻击、时序与资源争用隐蔽信道、浏览器自身的漏洞。

### 2.4 密钥与凭据的位置

| 资产                           | 位置                                                                                                                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LLM / Embedding / Reranker Key | Dexie `apiEndpoints`（`database.ts:316`，类型 `types-api.ts:50,97`）；运行期在 `api-source-store` 的 Pinia 内存里                                                                              |
| 图像连接 Key                   | Dexie `imageApiConnections`（`database.ts:319`）                                                                                                                                               |
| 旧版 Key 残留                  | Dexie 死表 `settings`；旧版整库备份文件里的 `apiEndpoints` 字段（`database.ts:930-931`，已弃用但旧文件里还有）；localStorage 设置袋落盘前已清 Key（`src/ui/stores/settings-store.ts:153-166`） |
| Discord 会话令牌、内容包租约   | localStorage（`src/ui/lib/discord-auth-client.ts:128,146`）                                                                                                                                    |
| 工坊 JWT                       | Pinia 内存加 localStorage 投影（`src/ui/stores/workshop-social-store.ts:255`）                                                                                                                 |
| 自定义请求头                   | 随 API 源存 Dexie；发送时经 `X-Custom-Headers` 交 BFF（`server/app.ts:111-112`）                                                                                                               |
| 调试回合                       | Dexie `debugTurns`（`database.ts:395`）；是否含请求头未验证，按「含」处理，不进任何投影                                                                                                        |

## 3. 总体架构

### 3.1 分层

```
插件文档（不可信，opaque origin，完整 JS 与 DOM）                    §4.1
   │ MessagePort（结构化克隆，纯数据）
牢笼帧（宿主脚本，与插件文档同一份 CSP，负责拦导航）                 §4.1
   │ MessagePort
src/ui/lib/plugin-bridge.ts      协议校验、限流、身份绑定、运行态守卫
src/ui/stores/plugin-store.ts    注册表、按存档启用、帧的生命周期、事件派发、风险确认记录
   │ 只调用引擎导出函数
src/core/plugins/                纯函数：清单解析、联网域名校验、命令 → StatePatch[] 翻译、读投影、安装计划
src/core/state/state-manager.ts  commitPluginCommand（写锁 + 单事务 + 前置条件 + 锁内复检）
server/routes/plugins.ts         本地插件文件夹的只读提供 + 自检金丝雀
```

引擎侧不得 import 前端（`AGENTS.md:520`）。`src/core/plugins/` 的纯度约束与 `workshop-install-plan.ts` 相同：无 I/O、无 Dexie、无 Vue。

### 3.2 包格式与 manifest

一个插件是一个目录（本地）或一个 zip（工坊），根部有 `manifest.json`。签名级草图：

```
manifestVersion: 1
id: string            // ^[a-z0-9][a-z0-9._-]{2,63}$，全局唯一键
name, version, author?, description?
pluginApi: string     // 需要的宿主 API 版本范围，如 "^1.0"
contributions: [{ slot, id, label, icon?, surface: 'window' | 'overlay' | 'panel', entry: string, width?, height? }]
background?: string   // 可选的常驻后台页面入口（不可见）
network?: string[]    // 允许联网的域名，可带前导通配子域，如 "api.example.com"、"*.example.com"；缺省 = 未声明联网域名（不等于离线，WebRTC 拦不住，§4.3）
capabilities: { read: string[], commands: string[], events: string[], ai: string[], storage: string[] }
```

- 解析器 `coercePluginManifest` 永不抛，认不出的字段丢弃并记处置记录，口径照 `src/core/workshop/workshop-manifest.ts`。`network` 里任何一项不合规（§4.2），整个插件判为不可安装，不做「丢掉坏项继续装」。
- r4 的 `remoteCode` 字段删除（R4-3）。CSP 含 `'unsafe-eval'` 与 `blob:`，任何联网插件都能取回代码执行，这个开关挡不住什么，留着只会让玩家误以为关掉就没有远程代码。`script-src` 始终含声明的域名（§4.2）。旧 manifest 里的 `remoteCode` 按未知字段丢弃。
- `entry` 是包内的 HTML 文件。插件文档跑在 opaque origin 的 srcdoc 里，相对 URL 取不到包内文件，所以由**帧内**的装载器处理：宿主把包内文件经端口交给帧内引导脚本，引导脚本为它们建帧内的 `blob:` URL，再把入口 HTML 里的相对引用改写过去。宿主页面从不解析插件 HTML。
- 多文件 ES 模块的相对导入不保证可用，建议作者打包成单文件。CSS 里的相对 `url()` 尽力改写。运行期可用 `host.assets.url(path)` 取帧内 URL。

### 3.3 发现与安装

统一的运行时存储是 Dexie（§3.5）。两条渠道都只是「安装来源」，装完之后运行路径相同。

本地文件夹：

- 默认位置是仓库的**上一级**目录下的 `poem-plugins/`，可用环境变量 `POEM_PLUGINS_DIR` 覆盖（先例 `POEM_CONTENT_DIR`，`vite.config.ts:21`）。不放在仓库里的原因见 §4.6。
- 浏览器列不了目录，由 BFF 只读提供。启动时和玩家点「重新扫描」时，宿主调 `GET /api/plugins` 拿清单，逐个比对内容哈希。
- 新增或哈希变了的插件标为「待安装 / 待更新」，玩家过了风险确认才把文件读进 Dexie。不做静默自动更新。开发者模式下提供「跟随文件夹自动重载」开关（`network` 变了仍要重新确认）。

创意工坊（后置，入口仍锁，`src/ui/components/workshop/workshop-lock.ts:15`）：

- 接入点一：`WorkshopPayload`（`src/core/workshop/workshop-types.ts:326`）加可选的插件包字段。
- 接入点二：`planInstall`（`src/core/workshop/workshop-install-plan.ts`）产出里带一份插件安装计划，与本地渠道共用 `planPluginInstall`。
- 接入点三：下载字节只经 `src/ui/lib/workshop-client.ts`。

管理界面放在扩展管理页现有的占位区（`src/ui/components/workshop/ExtensionManagementPage.vue:56-70`）。

### 3.4 风险确认（安装时、按存档启用时）

两处都用模态窗，危险样式，默认焦点在「取消」。「确认」按钮在勾选框全部勾上之前不可点。

安装确认窗的内容：

- 插件名、版本、作者、来源（本地文件夹 / 工坊）、文件数与体积。
- 联网声明。未声明时写「未声明联网域名」，不写「不联网」（WebRTC 拦不住，§4.3）。声明了就逐条列出域名。
- 固定的风险说明，逐条成句。以下各条对每个插件都显示，不看是否声明了 `network`：
  - 这是第三方插件，本项目没有审核过它。
  - 它可以任意修改启用了它的存档。
  - 它可以把你的存档和聊天内容发到网上：声明了域名的发到上面列出的服务器；没声明也能经 WebRTC 发给公网上的对端，浏览器拦不住。
  - 它可能探测到你的电脑和局域网里有哪些设备在线，但无法向它们下达指令（Q2）。
  - 它可能从网上加载代码，行为可能在你不知情时改变。
  - 插件窗口里的内容由插件绘制。本应用绝不会在插件窗口里要你输入 API Key 或密码，看到就是假的。
  - 不要把备份文件或含密钥的文件交给插件（Q8）。
  - 插件给的链接本应用只让你复制，不替你打开（§5.7）。你自己粘贴到浏览器里打开的页面不受插件沙盒约束，能访问你的电脑和局域网上的服务。
- 免责声明一句：使用第三方插件的后果由你自行承担。
- 勾选框：「我已阅读并了解以上风险」。联网插件另有一个：「允许该插件连接以上 N 个域名」。

按存档启用时弹一个短版本：插件名、联网域名、前三条风险、一个勾选框。

记录与重新确认：

- 确认记录存在插件行和存档元数据里，内容是插件 id、版本、内容哈希、`network` 的哈希、时间。
- 更新后 `network` 变了，必须重新确认，新增的域名高亮。
- 导入别人的存档时，里面勾选的插件在本机不自动启用，要在本机重新过一次按存档启用的确认。

文案放在 `src/ui/lib/plugin-risk-messages.ts`（纯函数，先例 `src/ui/lib/session-import-messages.ts`），两个弹窗共用，不在模板里各写一份。

> 📌 2026-11-15 实施偏离：按存档启用的确认**只记在本机**（`PluginRecord.saveConsents[saveId]`，`plugins` 表不进 FullBackup），存档元数据里只有 `enabledPluginIds`，不存确认记录。所以任何导入的存档（含自己导出再导入的）都要在本机重新确认。安装确认记在 `PluginRecord.installConsent`。删除存档时一并清掉对应的本机确认。

### 3.5 存储

| 数据           | 位置                                                                                        | 生命周期                                                     |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 插件清单与文件 | 新表 `plugins`（主键 `id`）、`pluginFiles`（`[pluginId+path]`），Dexie v34                  | 全局；不进 FullBackup（Q6）；卸载即删                        |
| 按存档启用     | `SaveSlot.metadata.enabledPluginIds`（同位先例 `enabledWorldBookEntries`，`types.ts:1651`） | 随存档                                                       |
| 插件的存档数据 | `SaveProfile.worldFlags.plugins[pluginId]`                                                  | 随快照、回退、备份（先例 `AGENTS.md:526,543`）；每插件 256KB |
| 插件的全局数据 | 新表 `pluginKv`（`[pluginId+key]`）                                                         | 跨存档；每插件 1MB；进 FullBackup                            |
| 待告知队列     | `SaveProfile.worldFlags.pluginNotes`                                                        | 随快照；回合接纳后清空（§5.8）                               |

升 v34 时 `DB_VERSION` 必须同步（`src/core/AGENTS.md` database 条）。

### 3.6 权限声明的定位

- `capabilities` 是声明即契约：未声明的命令、投影、事件一律回 `DENIED`。不逐项弹授权。它保证安装页展示的内容是真话，也让作者写错名字时得到明确报错。
- `network` 是真门控：它直接决定帧的 CSP（§4.2），并且要玩家勾选确认（§3.4）。
- `pluginApi` 范围不满足、或声明了宿主不认识的能力时，插件显示为「不兼容」，不能启用。

## 4. 沙盒与隔离

### 4.1 帧结构

每个界面（和后台页面）是两层帧，挂在 shadow tree 里：

- 外层牢笼帧：`<iframe sandbox="allow-scripts allow-forms allow-pointer-lock" srcdoc=… referrerpolicy="no-referrer">`。里面只有宿主脚本。
- 内层插件帧：牢笼帧创建的 srcdoc，不写 `sandbox`（沙盒标志从外层继承）。里面先是宿主注入的 CSP `<meta>` 和引导脚本，然后是插件的入口文档。

两层用同一份 CSP（§4.2）。原因：srcdoc 文档会继承父文档的策略，两份不同的话取交集，牢笼帧的策略会把插件需要的东西也挡掉。

为什么要牢笼帧：沙盒不禁止帧导航自己，而文档自己的 CSP 在 Chromium 里管不到自身导航，子帧导航由**父文档**的 `frame-src` 约束。牢笼帧就是这个父文档。按规范字面理解则是发起方的策略生效，所以内层也带同样的 `frame-src`，两种理解都覆盖。牢笼帧的 `frame-src 'none'` 是否豁免 srcdoc 未验证；会拦的话，牢笼改用 `blob:` 装载内层并设 `frame-src blob:`。

沙盒标志逐项：

| 标志                                             | 给不给 | 理由                                                                                               |
| ------------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------- |
| `allow-scripts`                                  | 给     | 插件要跑脚本                                                                                       |
| `allow-forms`                                    | 给     | 不给的话表单的 `submit` 事件不触发，常见 UI 框架的表单用不了。真正的提交由 `form-action 'none'` 挡 |
| `allow-pointer-lock`                             | 给     | 小游戏需要；Esc 可退出，不碰红线                                                                   |
| `allow-same-origin`                              | 不给   | 保持 opaque origin，这是红线 A 的地基                                                              |
| `allow-popups`、`allow-popups-to-escape-sandbox` | 不给   | 外链改走 `host.ui.openExternal`（§5.7）                                                            |
| `allow-top-navigation` 及其变体                  | 不给   | 不能导航顶层页面                                                                                   |
| `allow-downloads`                                | 不给   | 红线 C                                                                                             |
| `allow-modals`                                   | 不给   | `alert` / `prompt` 没有必要；提示走 `host.ui.toast`                                                |

不写 `allow` 属性，摄像头、麦克风、定位等对跨源帧默认关闭。`credentialless` 仅 Chromium 支持且不限制联网，不写。

### 4.2 联网域名校验与 CSP 生成

`network` 每一项的校验（`src/core/plugins/plugin-network.ts`，纯函数，安装时与建帧时各验一次）：

- 只接受主机名，不带协议、端口、路径。可以有一个前导 `*.`，通配后的部分至少两段。
- 必须是 ASCII 的字母、数字、连字符组成的多段名字（国际化域名用 punycode 形式，展示时两种都显示）。至少两段，最后一段不能是纯数字。
- 拒绝：IPv4 与 IPv6 字面量（含十进制、十六进制、八进制写法，它们要么是单段要么末段是数字）、`localhost` 与 `*.localhost`、单段主机名、以 `local`、`internal`、`lan`、`home`、`corp`、`intranet`、`home.arpa`、`test`、`invalid`、`example`、`onion`、`arpa` 结尾的名字。
- 另有一张「把公网名字解析到任意 IP」的已知服务后缀表（如 `nip.io`、`sslip.io`），命中即拒。这张表只是卫生措施，不是边界；边界见 §4.3。
- 最多 16 项。

CSP 模板（`<D>` 是每个域名展开成的 `https://域名`，`<W>` 是 `wss://域名`；不带端口，所以只匹配 443）：

```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob: data: <D>;
style-src 'unsafe-inline' blob: data: <D>;
img-src blob: data: <D>;  font-src blob: data: <D>;  media-src blob: data: <D>;
connect-src blob: data: <D> <W>;
worker-src blob:;
frame-src 'none';  child-src 'none';  object-src 'none';
form-action 'none';  base-uri 'none';  manifest-src 'none';
```

- 没声明 `network` 的插件，`<D>`、`<W>` 为空，即「未声明联网域名」。这不等于离线：CSP 管不到 WebRTC（附录 A 的 T1），插件仍能和公网上的对端建数据通道。
- 任何指令里都不出现 `http:`、`ws:`、裸的 `https:`、`*`、IP、端口。结构闸门测试对生成器做属性测试：任意输入下产物都满足这一条。
- `frame-src 'none'` 是硬性的。远程页面一旦载入帧内，它不继承这份 CSP，可以随意请求 `http://127.0.0.1`。所以插件不能内嵌任何远程页面，也不能把自己导航到远程页面。代价是嵌不了第三方视频播放器之类的 iframe 小部件。

### 4.3 红线 D 逐条论证

| 途径                                                                                  | 防线与论证                                                                                                                                                                                                                                      | 状态                                   |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `fetch` / XHR / WebSocket / EventSource / `sendBeacon` / `<a ping>` / WebTransport    | `connect-src` 只含声明的 `https://域名` 与 `wss://域名`。IP、`localhost`、`http:`、非 443 端口都不匹配                                                                                                                                          | 规范，进自检                           |
| 图片、字体、媒体、样式、脚本、CSS `url()`、SVG 外部引用                               | 各资源指令同上；没有单列指令的类型回落到 `default-src 'none'`                                                                                                                                                                                   | 规范，进自检                           |
| DNS rebinding：声明的域名解析到 `127.0.0.1` 或内网 IP                                 | 请求只能是 HTTPS、端口只能是 443、证书必须对该域名有效。ComfyUI（8188）、Ollama（11434）、BFF（5173）不在 443 上，也不讲 TLS，收不到请求。内网 443 上的设备拿不出攻击者域名的有效证书，握手失败，HTTP 请求发不出去。对方最多收到一个 TLS 握手包 | 规范；残余见下                         |
| 重定向：允许的域名 302 到 `http://127.0.0.1:8188`                                     | CSP 对每一跳都重新检查（重定向后只忽略路径，协议、主机、端口照查）                                                                                                                                                                              | 规范，进人工矩阵；自检尽力而为（§4.8） |
| 帧自身导航（`location=`、`meta refresh`、锚点点击）                                   | 牢笼帧与插件帧的 `frame-src 'none'`                                                                                                                                                                                                             | 未验证，进自检                         |
| 导航到 `blob:` / `data:` / `about:blank` 文档再发请求                                 | 这类文档继承 CSP                                                                                                                                                                                                                                | 未验证，进自检                         |
| 嵌套 iframe、`<object>`、`<embed>`                                                    | `frame-src 'none'`、`object-src 'none'`                                                                                                                                                                                                         | 规范，进自检                           |
| blob Worker 里发请求                                                                  | Worker 继承创建者的 CSP                                                                                                                                                                                                                         | 未验证，进自检                         |
| 表单提交                                                                              | `form-action 'none'`；提交目标又受 `frame-src` 约束                                                                                                                                                                                             | 规范，进自检                           |
| `window.open`、`target=_blank`、导航顶层                                              | 沙盒不给 `allow-popups` 与 `allow-top-navigation`                                                                                                                                                                                               | 规范                                   |
| 外部协议（`mailto:`、自定义 scheme）                                                  | 沙盒帧默认不能拉起外部协议                                                                                                                                                                                                                      | 规范，进人工矩阵                       |
| 下载                                                                                  | 沙盒不给 `allow-downloads`                                                                                                                                                                                                                      | 规范                                   |
| 借 BFF 当跳板（BFF 的转发不拒绝 localhost 与私有 IP，`server/routes/proxy.ts:17-23`） | BFF 的地址是 `http://localhost`，不在任何插件的 CSP 里；BFF 另外拒绝 `Origin: null`（`server/app.ts:84-92`，`vite.config.ts:38-47`）                                                                                                            | 规范，自检的金丝雀就在 BFF 上          |
| 借宿主渲染（插件写进状态的 URL 被宿主请求）                                           | 见 §4.4                                                                                                                                                                                                                                         | 读码确认                               |
| 借美化帧（插件经 `ai.note` / `context.set` 诱导模型输出指向内网的标记）               | 启用插件的硬前置：美化帧去掉 `http:` 与 `ws:` 并套牢笼帧（§4.4、§11），自检 S6 证明                                                                                                                                                             | 进自检                                 |
| 借宿主打开外链（`host.ui.openExternal`）                                              | 宿主打开的页面在沙盒和 CSP 之外，能 POST 到 `http://127.0.0.1:8188`。所以默认只给玩家复制链接，宿主不打开（§5.7）；放开见 Q12                                                                                                                   | 残余：玩家自己粘贴打开的页面           |
| WebRTC（STUN、TURN、ICE-TCP）                                                         | CSP 管不到（附录 A 的 T1）。见下方残余风险                                                                                                                                                                                                      | 残余，Q2                               |
| `<link rel=preconnect>`、`dns-prefetch`                                               | CSP 是否管资源提示未验证。`preconnect` 只建连接不发请求，`dns-prefetch` 只查名字                                                                                                                                                                | 残余，并入 Q2；进人工矩阵（抓包）      |
| Chrome 的 Private / Local Network Access                                              | 应用页面本身在 loopback 上，帧继承同一地址空间，预期不触发拦截                                                                                                                                                                                  | 未验证，不计入防线                     |

DNS rebinding 的残余：

- 本机或内网 443 端口上的服务会收到一个 TLS 握手包。里面攻击者能控制的只有域名字符串，不构成指令。
- 如果玩家自己用**公网域名加有效证书**在 443 端口暴露了一个内网服务（比如自建 NAS），而插件恰好声明了这个域名，请求能到达。这要求攻击者事先知道玩家的私人域名，并且这个域名会出现在安装确认窗里。本文接受这一点，不另设防线。

WebRTC 的残余（Q2）：

- 插件脚本可以让浏览器向任意 IP 和端口发 STUN 探测（UDP），或用 TURN over TCP、ICE-TCP 建 TCP 连接。
- 发出去的是 STUN / TURN 的二进制报文。报文头固定，事务号随机。攻击者能控制的字段是 ICE 用户名片段，字符集只有字母、数字、`+`、`/`，没有空格和换行。TURN 的用户名要等服务器按协议回了 401 才会发，普通服务回不出来。所以它拼不出 HTTP 请求行，也拼不出按行解析的文本协议命令。
- 插件可以改写 SDP 塞进含非法 ice-char（空格、CR/LF）的 ufrag。浏览器应拒绝这类 ufrag；这一条进人工矩阵。
- `turns:` 地址会让浏览器向任意端口发一个 TLS ClientHello。里面没有攻击者可控的 HTTP 字节，不构成指令。
- 数据通道要对方完成 ICE 握手才能传数据，本地服务做不到。
- 结论：插件能做的是端口与主机的在线探测，以及时序级的推断。它不能向 ComfyUI、Ollama、BFF、路由器下达指令。写得很差的设备固件收到畸形报文可能出错，这一点无法排除。
- 以上是按协议推断，未验证；人工矩阵里抓包确认报文内容。

### 4.4 宿主侧的 URL 汇点

插件写进状态的字符串如果被宿主当 URL 请求，宿主就替它访问了内网。现状盘点：

| 汇点                               | 现状                                                                                                                                                                                                                                                               | 处理                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `v-html`                           | 全前端一处，且先 `escapeHtml`（`src/ui/components/game/ChatFlow.vue:643-644`）                                                                                                                                                                                     | 安全                                                                                      |
| system 消息与卡片                  | 文本插值（`ChatFlow.vue:860`）                                                                                                                                                                                                                                     | 安全                                                                                      |
| 头像、立绘、插画、素材             | `:src` 全部来自素材库或插画表的 object URL，按名字解析                                                                                                                                                                                                             | 安全                                                                                      |
| 地图标记图片 `MapMarker.imageUrls` | 直接当 `<img src>`（`types.ts:4595`，`src/ui/components/game/MapPanel.vue:580`）。数据在 `worldFlags.mapMarkers`（`src/core/state/save-profile.ts:376-378`），`StatePatch` 写不到                                                                                  | 不开放任何地图标记命令                                                                    |
| 变量写入                           | 只落 `profile.variables`（`state-manager.ts:1061-1071,1129-1133`）                                                                                                                                                                                                 | 安全                                                                                      |
| 远程素材声明                       | 只从世界书条目和内容包抽取                                                                                                                                                                                                                                         | 安全                                                                                      |
| 音频                               | 按名寻址；`AudioTrack.url` 只是内置清单路径（`types.ts:4619`）                                                                                                                                                                                                     | 安全                                                                                      |
| 模型正文经美化帧渲染               | 插件经 `ai.note` 或 `context.set` 诱导模型输出 `<img src="http://192.168.1.1/…">` 或 `<meta http-equiv=refresh>`。模型卡片正文原样进模型帧（`src/core/story/beautifier.ts:547-566`），该帧 `img-src` 放行 `http:`（`beautifier-frame.ts:38-41`）。插件单独就能破 D | 启用插件的硬前置：两档美化帧去掉 `http:` 与 `ws:`，套牢笼帧拦导航；进自检 S6（§11、§4.8） |

规则一：新增结构闸门测试，扫描 `src/ui/**` 里的 `v-html`、`:src`、`:href`、`style` 内 `url()` 绑定，新增项必须登记来源，插件可写字段不许成为直接来源。

规则二（插件字节进入宿主 origin）：唯一入口是贡献点图标。只收栅格格式（按文件头判 PNG / JPEG / WebP / GIF），用 `createImageBitmap` 解码、缩到 256 像素以内、经 canvas 重编码成 PNG 后才使用。不收 SVG。宿主 origin 下不得为插件字节创建任何其他类型的 blob URL，否则「在新标签页打开图片」会让带脚本的 SVG 或 HTML 在应用 origin 里执行，直接破 A。

### 4.5 红线 A：密钥不可达

- 结构：插件帧是 opaque origin，读不到宿主的 DOM、localStorage、IndexedDB 和内存。它只能拿到宿主经端口发过去的数据。
- 读接口是白名单投影构建器，不是「按路径读任意状态」。`src/core/plugins/plugin-projection.ts` 的输入只允许 `CharacterState[]`、`SaveProfile`、`ChatMessage[]`、`PlotEvent[]`。
- 机器闸门：源码扫描测试。`src/core/plugins/**`、`plugin-bridge.ts`、`plugin-store.ts`、`plugin-frame.ts` 不得 import `api-source-store`、`settings-store`、`discord-auth-client`、`workshop-social-store`，不得出现 `apiEndpoints`、`imageApiConnections`、`debugTurns`、`promptSessions` 标识符。
- 聊天记录投影的过滤与脱敏见 §5.2。联网之后这条更要紧：投影里漏出的任何东西都可能被发走。
- 不提供设置读取接口。主题变量只下发 `--theme-*`（做法同 `beautifier-frame.ts:453-458`）。
- BFF 不持有任何密钥（透传模式，`server/app.ts:74-79`），而且插件够不着它（§4.3）。

### 4.6 红线 C：本地文件

目录位置：

- Vite root 就是仓库根（`vite.config.ts` 没有设 `root`），dev server 会把 root 下的 `.html`、`.svg`、`.js` 按同源返回。插件目录如果在仓库里，任何网页把玩家的浏览器导航到那个地址，插件文件就在应用 origin 里执行，能读到全部密钥。
- 所以默认目录在仓库之外（§3.3）。`POEM_PLUGINS_DIR` 解析后若落在 Vite root、`public/` 或 `dist-ui/` 之内，插件路由拒绝启用并在扩展管理页报错。
- 再加两层：`server.fs.deny` 列入该目录；dev 与 preview 两处中间件最前面加一条拒绝规则，凡是解析后落在该目录里、又不是 `/api/plugins` 前缀的请求（含 `/@fs/` 形式）一律 403。
- 测试断言：对插件目录里的 `.html`、`.svg` 文件，任何 URL 形式都拿不到 `text/html` 或 `image/svg+xml` 响应。

BFF 路由 `server/routes/plugins.ts`，挂进路由表（`server/app.ts:40-58`）：

- `GET /api/plugins`：列目录下名字合法的一级子目录，读各自的 `manifest.json`（上限 64KB）。
- `GET /api/plugins/:id/file?path=<相对路径>`：返回文件字节。
- 除金丝雀记录路由外只注册 GET，测试断言其他方法得到 404 或 405。结构闸门扫描该文件不得出现 `writeFile`、`rename`、`unlink`、`mkdir`、`rm`、`appendFile`、`realpath`。
- 只接受同源请求：`Sec-Fetch-Site` 不是 `same-origin` 即 403。全局 CORS 是 `*`（`server/app.ts:95-98`），这条前缀不能跟着放开。
- 响应头固定：`Content-Type: application/octet-stream`、`Content-Disposition: attachment`、`X-Content-Type-Options: nosniff`、`Content-Security-Policy: sandbox; default-src 'none'`、`Cross-Origin-Resource-Policy: same-origin`。
- 上限：单文件 5MB，单插件 20MB，扩展名白名单。

路径校验：

- 不调用 `realpath`。它会跟随链接，链接指向 UNC 路径时会触发 SMB 外连并泄漏 NTLM 凭据。
- 把 `path` 按 `/` 切段，逐段校验后从插件目录起逐级 `lstat`：遇到符号链接或目录联接直接拒绝；`readlink` 不抛错也视为链接并拒绝（Windows 上 `lstat` 对联接的判定未验证，用它交叉确认）。最后一段必须是普通文件。
- 每段拒绝：`..`、`.`、空段、反斜杠、`:`（盘符与 NTFS 备用数据流）、控制字符、尾随点或空格、Windows 保留设备名（`CON`、`PRN`、`AUX`、`NUL`、`COM1`–`COM9`、`LPT1`–`LPT9`，带不带扩展名都算）。
- 包含判定沿用 `resolve` 加 `relative`（先例 `server/routes/content.ts:70-74`）。

帧内的文件能力：

| 能力                                              | 防线                                                                                             | 状态                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------ |
| 下载（`<a download>`、blob 导航）                 | 沙盒不给 `allow-downloads`                                                                       | 规范                     |
| File System Access 选择器（读或写）               | 跨源、opaque origin 的帧里应抛 `SecurityError`；自检 S7 查插件帧里 `showSaveFilePicker` 是否存在 | 未验证，进人工矩阵与自检 |
| OPFS、IndexedDB、Cache                            | opaque origin 不可用。它们是浏览器内部存储，不是玩家意义上的文件                                 | 规范                     |
| 宿主的导出与备份                                  | 只由玩家在宿主界面触发，插件 API 没有对应命令                                                    | 结构排除                 |
| 现有的内容写回路由（`server/app.ts:49-57`）       | 插件够不着 BFF（§4.3）                                                                           | 规范，进自检             |
| `<input type=file>`、把文件拖进插件窗口、粘贴文件 | 拦不住。每次都要玩家亲手选或拖，浏览器不会让插件自己去读                                         | 见 Q8                    |

文件选择器的探针没法自动跑：没有用户激活时它一定抛 `NotAllowedError`，和「被 opaque origin 拒绝」的 `SecurityError` 分不开。所以放进人工矩阵，由人点一下再看错误名。自检只能查「有没有」：插件帧里存在 `showSaveFilePicker`，而本引擎与大版本没过人工矩阵的这一项，插件子系统禁用（§4.8 S7）。

> 📌 2026-11-15 本段的前提被推翻：「没有用户激活时一定抛激活错误、与隔离拒绝分不开」不成立。Chromium 156.0.8078.75 实测（2026-11-15，无用户激活调用）：sandbox 只有 `allow-scripts` 的不透明帧、以及嵌在这种帧里的 srcdoc 子帧，三种选择器都抛 `SecurityError`，原文是「Sandboxed documents aren't allowed to show a file picker.」；`allow-scripts allow-same-origin` 或不加沙盒的帧抛的也是 `SecurityError`，原文却是「Must be handling a user gesture to show a file picker.」。也就是说 Chromium 先查沙盒 / 不透明来源、再查用户激活，两句报错不同。所以无激活调用在 Chromium 上就能区分「被隔离拒绝」与「只是缺激活」，S7 改为自动判定，规则见 §4.8 的「📌 2026-11-15 S7 自动判定」注。人工矩阵的选择器按钮保留，用于其他引擎与复核。

### 4.7 隔离与界面标识

- 每个界面一对帧，各自 opaque origin，互相读不到 DOM 与存储。
- 身份由宿主绑定：建帧时把 `pluginId` 记在端口上，消息里自报的 id 不采信。
- 插件改不了宿主设置、别的插件的 `worldFlags.plugins[其他id]` 和 `pluginKv`。共享游戏状态上的互相覆盖是允许的，由玩家和作者自理。
- 插件帧挂在 shadow tree 里，这样别的帧在 `window.frames` 里枚举不到它（附录 A 的 T3）。这是卫生措施，不是红线防线。
- 界面标识：每个 surface 外面有一圈宿主在帧外绘制的边框，写明插件名，联网插件带一个「联网」标记，并带关闭按钮。它不再是安全机制（钓鱼不是红线），留着是因为成本低，而且让玩家始终知道眼前这块是谁画的。

### 4.8 启动自检

目的：在这台机器、这个浏览器上证明「带插件同款 CSP 的帧够不着本机」，以及「插件存档里的两档美化帧够不着本机」（§11）。任何一项失败则插件子系统禁用，并在扩展管理页写明是哪一项。

金丝雀：BFF 提供 `/api/plugins/__canary/:nonce`（只在内存里记一次命中，60 秒过期）和同源才能读的命中查询。BFF 就在 loopback 上，所以「零命中」直接等于「够不着本机」。

- 记录路由接受全部 HTTP 方法（`<a ping>` 是 POST）。
- 挂载顺序：dev 模式下 Vite 中间件里有一层对全部 `/api/` 的 `Origin: null` 拒绝（`vite.config.ts:38-47`），排在 Hono 之前；Hono 里还有一层（`server/app.ts:84-92`）。金丝雀记录器必须挂在这两层和 `Sec-Fetch-Site` 检查之前，先记命中再拒绝。preview 分支没有 Vite 那一层，两边的挂载顺序要对齐，否则对照组在 dev 下恒不命中，插件被恒禁用。
- 只记宿主事先经同源调用登记的 nonce，有长度与条数上限。
- WebSocket 握手走 Node 的 `upgrade` 事件，不经过中间件。金丝雀另挂一个 `upgrade` 处理器，对同一前缀记命中后销毁套接字。
- 命中查询接口显式拒绝跨源请求（检查 `Sec-Fetch-Site` 与 `Origin`）。
- 判定「零命中」前要等一个窗口：取本轮对照组实测的命中延迟 × 3，至少 2 秒。

探针帧用生产的 CSP 生成器建，`network` 填一个合规的公网域名占位。S5 例外，见该行。

| 号  | 探测                                                                                                                                                                                                                                                                              | 通过判据                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| S0  | 对照组：一个沙盒标志相同、不带 CSP、不套牢笼的帧，对 S1–S4 与 S6 用到的**每一种**手段各打一次金丝雀（含 S1 新增的预取、推测规则、`<object>`、`<embed>`）                                                                                                                          | 每种手段都必须命中。哪种不命中说明该手段失效，自检判失败                             |
| S1  | 探针帧里：`fetch`、XHR、`sendBeacon`、WebSocket、EventSource、`<img>`、`<script src>`、样式表、CSS `url()`、`@font-face`、`<video>`、`<a ping>`、`<link rel=prefetch>`、`<link rel=preload>`、`<link rel=modulepreload>`、`<script type=speculationrules>`、`<object>`、`<embed>` | 金丝雀零命中                                                                         |
| S2  | 探针帧里：`location=`、`meta refresh`、锚点点击、表单提交，目标都是金丝雀                                                                                                                                                                                                         | 金丝雀零命中                                                                         |
| S3  | 探针帧里：建空白子帧、srcdoc 子帧，以及导航到 `blob:`、`data:` 文档，在这些文档里重做 S1 的 `fetch` 与 `<img>`                                                                                                                                                                    | 金丝雀零命中（证明 CSP 被继承）                                                      |
| S4  | 探针帧里：建 blob Worker，在里面 `fetch` 与 `importScripts` 金丝雀                                                                                                                                                                                                                | 金丝雀零命中                                                                         |
| S5  | 重定向（尽力而为）：若本机有第二个能命中的 loopback 主机名，让 CSP 只放行其中一个，请求它上面一个 302 到另一个主机名金丝雀的端点。它要放行 `http://localhost`，生产生成器按设计产不出，所以本项用一份单独的测试策略，不经生产生成器；生产生成器的属性测试（§4.2）不改             | 金丝雀零命中。没有第二个主机名时本项标「未自检」，不判失败                           |
| S6  | 两档美化帧，按插件存档的生产配置建（去掉 `http:` 与 `ws:`、套牢笼帧）：模型帧里放 `<img>`、样式表、CSS `url()`、`@font-face`、`<video>`、`<meta http-equiv=refresh>`；规则帧里另做 S1 的脚本手段与 S2 的导航手段，目标都是金丝雀                                                  | 金丝雀零命中。任何一次命中即禁用插件子系统                                           |
| S7  | 插件帧里查 `typeof showSaveFilePicker`                                                                                                                                                                                                                                            | 不存在即通过。存在时，本引擎与大版本须在人工矩阵的选择器已验表里，否则禁用插件子系统 |

不进自检的：WebRTC 与资源提示里的 `preconnect`、`dns-prefetch`（金丝雀看不到，且是已知残余，Q2）；`window.open`（自检时弹窗太扰民，靠沙盒标志）；文件选择器（§4.6）。

人工矩阵（P1a 验收条件，结果写回本文）：§4.3 与 §4.6 里所有「未验证」和「进人工矩阵」的行，在真实的 `http://localhost` 页面上对 Chromium、Firefox、Safari 各跑一遍；WebRTC 与 `preconnect` 抓包看报文；改写 SDP 塞进含空格或 CR/LF 的 ufrag，确认浏览器拒绝（§4.3）。

引擎门控：自检全过即启用。r2 的「未测过的引擎与大版本默认禁用」随红线 B 取消而放宽，理由和是否保留见 Q5。唯一保留的窄门控是 S7：只为文件选择器维护一张「人工矩阵已验」的引擎与大版本表，插件帧里没有 `showSaveFilePicker` 的引擎不受这张表约束。

> 📌 2026-11-15 S7 自动判定（上表 S7 一行与本段的「只查有没有」已被取代）：
>
> - 证据：Chromium 156.0.8078.75 实测（2026-11-15，无用户激活调用）：sandbox 只有 `allow-scripts` 的不透明帧、以及嵌在这种帧里的 srcdoc 子帧，三种选择器都抛 `SecurityError`，原文是「Sandboxed documents aren't allowed to show a file picker.」；`allow-scripts allow-same-origin` 或不加沙盒的帧抛的也是 `SecurityError`，原文却是「Must be handling a user gesture to show a file picker.」。也就是说 Chromium 先查沙盒 / 不透明来源、再查用户激活，两句报错不同。
> - 探测：主探针帧（生产 `mountPluginFrame` 挂的那个）挂载时带宿主专用选项 `probePickers`，随 `init` 下发；帧内引导脚本在装载插件代码**之前**、无用户激活地调用 `showSaveFilePicker` / `showOpenFilePicker` / `showDirectoryPicker`（有哪个调哪个，每个限时 1.5 秒），结局（不存在 / 兑现 / 被拒的错误名与原文 / 限时内无结果）随 `ready` 报回。插件可见的 API 不变。管线孪生帧（宿主自写、`allow-scripts allow-same-origin`、无 CSP、无插件代码）同样调用一次，拿到本引擎「缺用户激活」那句拒绝原文作对照，经 `postMessage` 报给宿主（只收该帧自己发来、token 相符的消息）。
> - 判定（逐种）：不存在 ⇒ 可以；兑现 ⇒ S7 失败（不看已验表）；错误名不是 `SecurityError` ⇒ 判不出；`SecurityError` 且原文与孪生帧同一种选择器的拒绝原文**不同** ⇒ 引擎在查激活之前就按隔离条件拒了，有没有点击都一样 ⇒ 可以；原文相同、孪生帧缺席或没拒、原文为空、限时内无结果 ⇒ 判不出。三种都可以 ⇒ S7 通过；有判不出的 ⇒ 回退到 `PICKER_VERIFIED_ENGINES`（引擎与大版本在表里才通过），说明里写明走了哪条路。只比较原文是否相同，不按报错文字的内容匹配，所以与界面语言和引擎措辞无关。
> - 安全前提：自检帧都在屏幕外（容器 `pointer-events:none`）、从不接收输入；用户激活只沿祖先方向传播，不会从宿主页传给子帧。所以这些调用都不带激活，弹不出对话框。
>   - 📌 2026-11-15 审查实测更正：上一句的激活传播前提不成立。Chromium 里宿主页点一下，`allow-same-origin` 的屏幕外 srcdoc 孪生帧 `navigator.userActivation.isActive` 也变 `true`（同源激活可见性），它的 `showOpenFilePicker()` 能越过激活检查、会弹真的对话框。现在两边的探测脚本在**每次**调用前都同步确认本帧 `navigator.userActivation.isActive === false`，读不到或为 `true` 就不调用，报 `skipped-active`（判不出，回退已验表）。判定同时收紧：插件帧里限时内没结果（对话框可能已打开）与兑现同样判失败；对照帧的拒绝不是 `SecurityError` 时不拿它作对照。
> - 状态：代码与单测已就位；2026-11-15 在 Chromium 156.0.8078.75 真机（dev，localhost）复跑，自检 `ok: true`，S7 详情「文件选择器在插件帧里被隔离拒绝（无需点击即可确认），共 3 种」；Firefox、Safari 未测（它们若报错原文与对照相同，会回退到已验表）。

> 📌 2026-11-15 实施与真机结果（`src/ui/lib/plugin-selfcheck.ts`）：
>
> - 真机（Claude 浏览器窗格，Chromium 156.0.8078.75，dev server 跑在 localhost）：CAGE 通过（srcdoc）；S1–S4、S6 零命中；S5 跳过（没有第二个可达的 loopback 主机名）；S7 失败（有 `showSaveFilePicker`，`PICKER_VERIFIED_ENGINES` 为空）。所以目前 Chromium 上插件保持禁用，要等人在「开发者模式 → 插件管理 → 人工矩阵」跑一次选择器探针并把引擎与大版本加进表。
>   - 📌 2026-11-15 本条结论已过时：S7 改为自动判定（见上方「📌 2026-11-15 S7 自动判定」注），2026-11-15 Chromium 156 真机复跑确认 S7 自动通过，自检全过。
> - S0 在这台 Chromium 上本来会恒失败：opaque origin 的帧访问 loopback 被浏览器自己拦掉（请求根本到不了服务器，与 Local Network Access 把 opaque origin 当公网的行为一致），没带 CSP 的对照组也打不中金丝雀。主人当日裁定：当带 `allow-same-origin` 的管线对照组能命中、而全部 opaque 的核心对照组都不命中时，S0 判通过并记 `browserBlocksLocal`，此时红线 D 由浏览器执行。
>   - 📌 2026-11-15 二审收紧：`browserBlocksLocal` 还要求**任何**不透明来源对照组（核心与可选）都没命中、任何探针也没命中；只要有一条命中而核心通道全不中，说明浏览器只拦了一部分，S0 判失败（「浏览器只拦截了部分不透明来源通道，结果不可信」）。轮询阶段因「对照组一个不中」提前收尾时，不再拿孪生帧延迟顶替对照组延迟；之后对照组若又命中，也按部分拦截判失败。
> - 对照组分「核心」与「可选」两类通道：核心通道不命中判 S0 失败；可选通道（部分浏览器不支持或不发请求的手段）不命中只在结果里记一条说明。
> - 美化规则帧的 S6 探针没有表单提交一项：规则帧的沙盒没有 `allow-forms`。
> - 自检每个页面会话在第一次需要时跑一次（装了插件或打开插件管理），结果只在内存里，插件管理里可以重跑。探针容器必须放在屏幕外而不是 `display:none`，否则 CSS 与字体加载不会发生。

## 5. 插件 API

### 5.1 桥协议

帧内由宿主引导脚本提供全局 `host`。所有调用是请求-响应，载荷必须可结构化克隆，单条上限 256KB，每插件每秒上限 60 条。

```
host.read(view: string): Promise<unknown>
host.subscribe(view: string, cb): Unsubscribe
host.on(event: string, cb): Unsubscribe
host.commit({ commands: Command[], expect?: Expect[] }): Promise<CommitResult>
host.storage.save.get/set/remove(key) ; host.storage.global.get/set/remove(key)
host.assets.read(path): Promise<ArrayBuffer> ; host.assets.readText(path) ; host.assets.url(path): string
host.ui.close() / resize(w, h) / toast(text) / fillInput(text) / openExternal(url)
host.ai.note(text, { visible? }) / host.ai.context.set(text | null)
type CommitResult = { ok: true } | { ok: false, code, message, index? }
```

错误码：`BUSY`、`IN_COMBAT`、`DENIED`、`INVALID`、`PRECONDITION_FAILED`、`NOT_FOUND`、`QUOTA`、`NO_SAVE`。

### 5.2 读投影

| view                                                        | 内容                                               | 来源                                       |
| ----------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------ |
| `player`                                                    | 主角全部非账务字段（含 `money`、五维、资源、位置） | `CharacterState`（`types.ts:1294` 一带）   |
| `player.inventory`、`player.skills`、`player.statusEffects` | 对应数组                                           | `InventoryItem`（`types.ts:1146-1169`）等  |
| `characters`                                                | 全部角色，同上口径                                 | 同上                                       |
| `stats`                                                     | 与 EJS `stats` 面同一份推导                        | `src/core/character/stat-projection.ts`    |
| `vars`                                                      | 叙事变量整棵树                                     | `SaveProfile.variables`（`types.ts:3649`） |
| `quests`、`affections`、`news`、`fp`、`time`                | 对应字段                                           | `SaveProfile`（`types.ts:3632-3652`）      |
| `plot`                                                      | 剧情事件列表                                       | `PlotEvent`                                |
| `map`                                                       | 落位与地块事实的只读快照                           | `worldFlags.map`、`worldFlags.mapFacts`    |
| `messages`                                                  | 最近 N 条已接纳的对话                              | `ChatMessage`，过滤规则见下                |
| `run`                                                       | `{ generating, inCombat, turn, mode }`             | `game-store.ts:176,241`                    |

`messages` 的过滤（照 `src/core/memory/memory-context.ts:97-107` 的口径）：

- 只取 `user` 和 `assistant` 两种角色。
- 排除带 `systemEvent` 的、`diagnostic` 为真的（`types.ts:929-930`）、`storyTurnStatus` 有值且不是 `accepted` 的。
- 只给 `id`、`role`、`content`、`turn`、`timestamp`。不给思维链、调试字段。
- `content` 统一过 `redactSecrets`。该函数现在在 `src/ui/lib/turn-failure.ts:96`，需要搬进引擎 `src/core/utils/`，前端留转发。

投影在引擎侧构建，返回深拷贝。

### 5.3 命令词汇全表

一次 `commit` 里的全部命令翻译成一批 `StatePatch`，整批成功或整批失败。`target` 缺省为主角。handler 行号为 `src/core/state/state-manager.ts`。

| 命令                                           | StatePatch                                                                                                                                                                               | 校验                                                                                     |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `vars.set`                                     | `set_variable`，`variables.<path>`（:1061）                                                                                                                                              | 路径非空                                                                                 |
| `vars.delta`                                   | `delta_variable`（:1072）                                                                                                                                                                | `amount` 为有限数                                                                        |
| `vars.remove`、`vars.move`、`vars.insert`      | `remove_variable`（:1084）、`move_variable`（:1094）、`insert_variable`（:1108）                                                                                                         | `move` 需 `toPath`（:1011）                                                              |
| `fp.add`、`fp.spend`                           | `delta_variable` 且 `target='profile.fp'`，走 FP 账务（:652-661）                                                                                                                        | 余额不足时 `spendFP` 抛错（`save-profile.ts:87-89`），整批不落；数额 ≤ 0 是空操作（:86） |
| `character.update`                             | `update_character`，可带 `metadata.delta`（:1135）                                                                                                                                       | 字段白名单（:270-313）；delta 仅数值字段（:327-341）                                     |
| `money.add`                                    | `update_character {money:+n}` delta                                                                                                                                                      | `n` 为有限数                                                                             |
| `money.spend`                                  | `update_character {money:-n}` delta                                                                                                                                                      | 隐含前置条件：余额 ≥ n。现有 delta 无下限（:1199-1200）                                  |
| `resource.set`、`resource.delta`               | `set_hp` / `set_mp` / `set_sp`（:1360）、`delta_hp` / `delta_mp` / `delta_sp`（:1373）                                                                                                   | 引擎钳到 `[0, max]`                                                                      |
| `character.add`                                | `add_character`（:1878）                                                                                                                                                                 | 宿主用 `createDefaultCharacterState` 补 `id`、`saveId` 和年龄锚点；插件不得提供账务字段  |
| `character.remove`                             | `remove_character`（:1912）                                                                                                                                                              | 拒绝主角                                                                                 |
| `character.rename`                             | `rename_character`（:1931）                                                                                                                                                              | 名字唯一                                                                                 |
| `status.add`、`status.update`、`status.remove` | `add_status_effect`（:1397）、`update_status_effect`（:1497）、`remove_status_effect`（:1473）                                                                                           | 分类枚举归一                                                                             |
| `item.grant`                                   | `add_item`（:1539）                                                                                                                                                                      | `name` 必填；同名只累加数量，其余字段被忽略（:1547-1550）                                |
| `item.remove`                                  | `remove_item`（:1580）                                                                                                                                                                   | 不存在或数量不足即失败（:1589-1595）                                                     |
| `item.update`                                  | `update_item`（:1612）                                                                                                                                                                   | 不能改 `name`、`quantity`（:1622-1625）                                                  |
| `item.transfer`                                | `transfer_item`（:1645）                                                                                                                                                                 | 两端角色存在且数量足够                                                                   |
| `item.equip`、`item.unequip`                   | `equip_item`（:1697）、`unequip_item`（:1736）                                                                                                                                           | 槽位枚举；堆叠数 > 1 不能直接穿                                                          |
| `skill.add`、`skill.update`、`skill.remove`    | `add_skill`（:1769）、`update_skill`（:1820）、`remove_skill`（:1843）                                                                                                                   | 按名寻址                                                                                 |
| `location.set`                                 | `set_location`（:1857）                                                                                                                                                                  | 非空字符串；地图落位由引擎钩子做                                                         |
| `quest.upsert`、`quest.remove`                 | `update_quest`（:1992）、`remove_quest`（:2011）                                                                                                                                         | `name` 必填                                                                              |
| `affection.set`、`affection.delta`             | `set_affection`、`delta_affection`，`affections.<角色名>`（:2031）                                                                                                                       | 引擎钳到 ±100                                                                            |
| `news.add`                                     | `add_news`（:2068）                                                                                                                                                                      | `title`、`content` 必填                                                                  |
| `plot.updateEvent`                             | `update_plot_event`（:1977）                                                                                                                                                             | 事件存在                                                                                 |
| `map.tile.*`（六条）                           | `tile_status_add`（:2148）、`tile_status_remove`（:2172）、`tile_building_add`（:2199）、`tile_building_update`（:2256）、`tile_dev_progress_add`（:2341）、`tile_history_note`（:2360） | `value.tile` 是地块名（`types.ts:2699-2707`）                                            |

推迟开放：`memory.add`（`add_memory`，:1969）。它要求调用方先在全局记忆锁里分配 `id`（:1971；`src/core/memory/memory-summarizer.ts:259`），与领域命令事务的嵌套方式要单独设计，P2 再定。

不开放（不是 `StatePatchOp`）：快照与回退、时间推进、回合提交、消息直写、世界书、预设、设置、素材、地图标记。时间推进与回合提交见 Q7、Q1。

通用校验：载荷里出现 `id`、`saveId` 即 `INVALID`；整次提交序列化后不超过 256KB；命令名不在 `capabilities.commands` 里即 `DENIED`。

### 5.4 前置条件与提交入口

`expect` 是一组在写锁和事务内求值的断言，任何一条不满足则整批不落，返回 `PRECONDITION_FAILED` 与下标。

```
{ view: 'player.money', gte: 30 }
{ item: '治疗药水', owner?: string, gte: 1 }
{ var: 'user.shop.stock.potion', gte: 1 } | { var, eq: value } | { var, exists: boolean }
```

引擎入口：

```
StateManager.commitPluginCommand(input: { pluginId, patches, expect, isAllowed: () => 'ok' | 'BUSY' | 'IN_COMBAT' }): Promise<PluginCommitResult>
```

实现复用 `commitDomainCommand` 的结构（`state-manager.ts:638-677`）：进写锁，**在锁内先调 `isAllowed` 复检运行态**，开事务，求值 `expect`，逐条 `applyPatch`，flush。锁内复检的先例是 `assertCurrentTurn`（`state-manager.ts:196-202`）。

### 5.5 订阅与生命周期事件

引擎没有事件总线，事件由 `plugin-store` 监听 Pinia 状态派生。全部是通知，不能否决，宿主不等待回调。

| 事件                         | 触发                                         |
| ---------------------------- | -------------------------------------------- |
| `save.enter`、`save.leave`   | 游戏页挂载且插件已启用；卸载或切档           |
| `turn.start`                 | `isGenerating` 变真；此后写入返回 `BUSY`     |
| `turn.end`、`turn.failed`    | 回合被接纳；失败或取消                       |
| `combat.start`、`combat.end` | `isInCombat` 变化                            |
| `timeline.restored`          | 回退或恢复快照完成；插件应重读状态与存储     |
| `state.changed`              | 订阅的投影内容变了（宿主做浅比较后推送新值） |

帧的生命周期：界面帧在玩家打开时建、关闭时销毁。manifest 写了 `background` 的插件，在游戏页挂载期间另有一对不可见的帧，用来响应事件（比如每回合结束发一笔收入）。启用带后台页面的插件数量设上限（建议 8 个）。

### 5.6 存储

- `storage.save`：读写 `worldFlags.plugins[pluginId]`。写入走专用的窄写入口（写锁内重读 profile，只改这一格，先例 `save-profile.ts:197-212`），同样受 `BUSY`、`IN_COMBAT` 约束。随快照回退。
- `storage.global`：读写 `pluginKv`。不随存档，不回退。
- 两者的键和值都是 JSON；超配额返回 `QUOTA`。

### 5.7 UI 贡献点

| slot                    | 位置                                                                                   | 期次 |
| ----------------------- | -------------------------------------------------------------------------------------- | ---- |
| `game.toolbar`          | 侧栏工具列末尾追加按钮（现为写死的表，`src/ui/components/game/SideToolbar.vue:19-29`） | P1b  |
| `game.menu`             | 游戏菜单追加项                                                                         | P2   |
| `game.overlay`          | 游戏页上方的层，一次只显示一个                                                         | P2   |
| `panel.items.footer` 等 | 现有面板内的具名插槽                                                                   | P2   |

`surface: 'window'` 是应用内浮动窗：可拖动、可调大小，不占 `game.activeModal`（`game-store.ts:734`），先例是迷你播放器（`src/ui/components/game/GamePage.vue:459`）。Esc 分层要把「有插件窗口获得焦点」加进 `onEscapeCapture` 的让路判据。按钮的 `label` 只做文本插值；`icon` 按 §4.4 规则二处理。

界面内容完全由插件文档自己决定：任意 HTML、CSS、JS，可以用任意 UI 框架、canvas、WebGL、Web Audio。

外链：`host.ui.openExternal(url)`。宿主校验它是 `https:`，主机名过 §4.2 的同一套规则（不必在 `network` 里），然后用宿主的弹窗显示完整地址和一个「复制链接」按钮，宿主不打开它。理由：宿主打开的页面在沙盒和 CSP 之外，玩家点一次确认它就能 POST 到 `http://127.0.0.1:8188`，等于插件经宿主破 D。玩家自己粘贴到浏览器里打开，等同于玩家自己上网。「警告后由宿主打开」见 Q12。

### 5.8 AI 交互手段

| 手段           | 接口                         | 效果                                                                                                                                                                                    |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 静默           | 不调用                       | AI 下一回合只看到状态变了（agent 模式经 `context_delta`，`src/core/prompts/prompt-state-projection.ts:54,709-713`；直出经绝对状态帧，`src/core/prompts/direct-context-frame.ts:64-87`） |
| 一次性告知     | `host.ai.note(text)`         | 进 `worldFlags.pluginNotes` 队列；下一回合装配时注入，回合接纳后清空                                                                                                                    |
| 给玩家看的通知 | `note(text, {visible:true})` | 另落一条 system 通知条（新增 `SystemEvent` 变体，`types.ts:4469-4476`）                                                                                                                 |
| 回填输入框     | `host.ui.fillInput(text)`    | 只填不发（`game-store.ts:743`）                                                                                                                                                         |
| 常驻提示块     | `host.ai.context.set(text)`  | 存 `worldFlags.plugins[id]`，每回合注入，直到插件清掉                                                                                                                                   |
| 经变量         | `vars.set`                   | 变量本来就在 AI 视野里，也能被世界书 EJS 与 `{{getvar}}` 读到                                                                                                                           |

不靠 system 消息让 AI 知情：Story v2 的回合分组只收 user 和 assistant（`memory-context.ts:97-107`），system 消息是否进入各模式的提示未验证，所以单独设注入通道。

注入位置：新占位符 `{{PLUGIN_NOTES}}` 与 `{{PLUGIN_CONTEXT}}`（`src/core/prompts/placeholder-registry.ts`），必须落在动态区或不留存的 `turn_context` 段，不破坏缓存前缀。队列清空放在成功回合收口处，带回合号幂等（先例 `commitPlotThreadTurn`，`save-profile.ts:635`）。

## 6. 关键语义

### 6.1 生成中

`game.isGenerating`（`game-store.ts:176`）或正在润色、正在恢复时间线时，一切写入（命令、`storage.save`、`ai.note`）返回 `BUSY`。读与 `storage.global` 不受限。

> 📌 2026-11-15 实施核对：「恢复时间线」没有单独的标志。`game-store.restoreTimeline` 在整个恢复过程里把 `isGenerating` 置真（回退、恢复快照、重开战斗都走它），运行态守卫 `plugin-runtime-store.runGuard` 只读 `isGenerating` / `isRewriting` / `isInCombat`，恢复期间的写入因此回 `BUSY`。`tests/ui/stores/game-store.test.ts` 钉住恢复中 `isGenerating` 为真。

理由：写锁只解决交错，不解决陈旧。直出模式允许 AI 对 `money` 做绝对值替换（`src/core/prompts/direct-prompt.ts:44`），它依据的是回合开始时的上下文，会盖掉插件的扣款。

守卫要做两处，缺一处都有竞态：

- 锁内复检：桥层检查通过之后，提交要排队等写锁。等到锁时回合可能已经开始，所以 `commitPluginCommand` 在锁内再问一次（§5.4）。
- 发送侧等待：玩家点发送时可能有插件提交正在落库。`GamePipeline` 开始读状态之前，先等 `plugin-store` 里在途的提交全部结束并完成回读。

### 6.2 战斗

`game.isInCombat`（`game-store.ts:241`）为真时写入返回 `IN_COMBAT`，同样锁内复检。战斗状态开战时从存档角色建（`src/ui/lib/game-pipeline.ts:3649`），终局只白名单写回资源与状态（`src/core/combat/sandbox/settlement.ts:138`），「重开战斗」会回到战前快照（`game-pipeline.ts:3855`）。

### 6.3 回退与重新生成

- 回退恢复到 turn ≤ N-1 的快照（`game-store.ts:1562-1571`）。第 N 回合结束之后的插件写入随之消失（D5）。
- 自动存档是 5 秒节流且生成中不写（`src/ui/composables/useAutosave.ts:20-34`，`game-store.ts:1734-1737`）。玩家买完马上发送时，这笔购买来不及进 N-1 快照，重新生成第 N 回合就会丢。
- 所以每次插件写入成功后，宿主立即调用 `amendCurrentTurnSnapshot`（`state-manager.ts:2595-2619`），不等节流。§6.1 的发送侧等待把这一步也包含在内。
- 回退后派发 `timeline.restored`。`storage.save` 跟着回退，`storage.global` 不回退。插件发到自己服务器上的数据当然也不回退，作者要自己处理两边不一致。

### 6.4 存档、备份、导入

- 插件的存档数据在 `SaveProfile` 里，随快照、FullBackup、单存档导出走。
- 单存档导出的依赖清单加一类「插件」（`src/core/persistence/session-backup.ts` 的依赖体检）；导入时缺插件只告警不拦。
- 导入的存档里勾选的插件，在本机要重新确认才启用（§3.4）。
- 存档启用了一个本机没装的插件：数据原样保留，界面不出现，扩展管理页提示。
- 卸载插件不清各存档里的 `worldFlags.plugins[id]`，重装后可续用；提供「清除此插件在本存档的数据」按钮。

### 6.5 多标签页

写队列是每个页面一份的内存结构（`state-write-queue.ts:21`），两个标签页开同一存档时互不知情。现有代码有无防护未验证，所以插件侧自带一道：

- 进入启用了插件的存档时，用 Web Locks 申请一把按存档命名的锁（先例 `discord-auth-client.ts:213,317`）。拿不到说明另一个标签页已持有，本标签页的插件写入全部禁用并显示横幅。
- 浏览器没有 Web Locks 时同样禁用插件写入。`navigator.locks` 只在安全上下文里存在：`http://localhost` 算安全上下文，但经局域网 IP 用 HTTP 访问时不算，此时插件写入一律禁用，扩展管理页写明原因。
- 拿不到锁的标签页不会自动接管。横幅上给「重试」按钮；同时挂一个排队申请，持有方关闭或离开存档后自动拿到锁，恢复插件写入并收起横幅。
- `expect` 在 IndexedDB 读写事务里求值，事务跨连接串行，即使上面的锁失效，「余额够才扣」也成立。

真弹窗（P4）必须做成薄壳，把调用转给打开它的页面，不能自己连 Dexie。

## 7. 商店示例

包内文件：`manifest.json`、`shop.html`、`shop.js`、`shop.css`、`stock.json`、`icon.png`。

manifest 要点：一项 `game.toolbar` 贡献点，`surface: 'window'`，`entry: 'shop.html'`；不写 `network`（未声明联网域名）；`capabilities.read = ['player']`，`commands = ['money.spend', 'item.grant']`，`ai = ['note']`，`storage = ['save']`。

`shop.js` 的骨架（签名级）：

```
const stock = JSON.parse(await host.assets.readText('stock.json'))
host.subscribe('player', (p) => { balanceEl.textContent = p.money + ' G' })
buyButton.addEventListener('click', async () => { const r = await host.commit({ commands: [...] }); /* 按 r.ok 显示提示 */ })
```

流程：

1. 玩家第一次在这个存档启用它时过一次风险确认（§3.4），窗里写着「未声明联网域名」。
2. 玩家点侧栏的「杂货铺」。宿主建一对帧，画好标识边框，帧内装载器载入 `shop.html`。
3. 页面脚本读货架、订阅余额，自己渲染。
4. 玩家点购买，脚本提交：

```
host.commit({ commands: [
  { type: 'money.spend', amount: 30 },
  { type: 'item.grant', item: { name: '治疗药水', quantity: 1, type: 'consumable', rarity: '普通', description: '…' } },
] })
```

5. 桥层检查：插件在本存档已启用，两条命令都已声明，不在生成中，不在战斗中，本标签页持有存档锁。
6. 引擎翻译成两条补丁：`{op:'update_character', target:'characters.<主角名>', value:{money:-30}, metadata:{delta:true}}`（同形先例 `src/core/variables/vars-update-translator.ts:316-321`）与 `{op:'add_item', target:'characters.<主角名>', value:{…}}`，外加隐含前置条件「余额 ≥ 30」。
7. `commitPluginCommand` 在锁内复检运行态，求值前置条件并应用。余额不足返回 `PRECONDITION_FAILED`，什么都不落。
8. 成功后宿主依次：补写本轮快照，从库回读刷新界面，向订阅者推送新的 `player`。页面里的余额跟着变。
9. 作者想让叙事知道，就再调 `host.ai.note('主角在杂货铺买了一瓶治疗药水')`；不想就什么都不做。
10. 限量库存用 `storage.save` 记，回退时库存跟着回退，与钱和物品保持一致。

联网版本的差别只有两处：manifest 加 `network: ['shop-api.example.com']`，页面里用 `fetch('https://shop-api.example.com/stock')` 取货架。安装确认窗会列出这个域名并要求多勾一个框。

## 8. 兼容性与版本

- `pluginApi` 用语义化版本。宿主导出常量 `PLUGIN_API_VERSION`；只增不改算小版本，删改命令或投影字段算大版本。
- 命令、投影、联网域名规则各有一张单一来源的表（照 `EJS_SURFACE`，`src/core/ejs/ejs-capabilities.ts:742`），文档与校验都从它推导。
- `manifestVersion` 单独计数；不认识的版本显示为不兼容。
- 引擎的 `StatePatchOp` 增删时，命令表必须同步：加一条测试，断言每个 `StatePatchOp` 要么有对应命令，要么在「推迟」或「不开放」名单里。
- 存档数据带 `schemaVersion`，由插件自己迁移；宿主不解释内容。
- 创作者文档另写一份 `docs/reference/plugin-authoring-guide.md`，本文是设计契约。其中要写明帧内的限制：不能内嵌远程页面、不能弹窗、不能下载、只能连声明的域名的 443 端口。

## 9. 分期路线图

| 期  | 内容                                                                                                                                                                                 | 规模 | 触及文件                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1a | 红线地基：联网域名校验与 CSP 生成器、双层帧与帧内装载器、金丝雀与启动自检、BFF 只读路由与目录防护、美化帧 https-only 档与牢笼帧（启用插件的硬前提，§11）、人工矩阵（含 WebRTC 抓包） | M    | 新 `src/core/plugins/plugin-network.ts`、`src/ui/lib/plugin-frame.ts`、`plugin-selfcheck.ts`、`server/routes/plugins.ts`；改 `server/app.ts`、`vite.config.ts`、`src/ui/lib/beautifier-frame.ts`、`src/ui/components/game/BeautifierFrame.vue`、`BeautifiedNarrative.vue`；对应测试                                                                                                                                                                                                                         |
| P1b | API 与界面：清单、命令全表、投影、前置条件与锁内复检、桥、浮动窗与标识边框、工具栏槽位、本地发现、安装与启用的风险确认、按存档启用、发送侧等待、存档锁、示例商店                     | L    | 新 `src/core/plugins/{plugin-manifest,plugin-commands,plugin-projection,plugin-install-plan}.ts`、`src/ui/lib/{plugin-bridge,plugin-risk-messages}.ts`、`src/ui/stores/plugin-store.ts`、`src/ui/components/game/PluginSurface.vue`、安装确认弹窗；改 `src/core/state/state-manager.ts`、`src/core/types/types.ts`、`src/core/persistence/database.ts`（v34）、`game-store.ts`、`game-pipeline.ts`、`GamePage.vue`、`SideToolbar.vue`、`ExtensionManagementPage.vue`；示例放 `tests/fixtures/plugins/shop/` |
| P2  | 存储两档、后台页面与事件、AI 手段（告知队列、常驻块、通知条）、overlay 与面板槽、菜单项、`openExternal`、`memory.add`、导出依赖体检                                                  | M    | 改 `src/core/state/save-profile.ts`、`src/core/prompts/placeholder-registry.ts`、直出与 Story v2 的装配点、`src/core/persistence/session-backup.ts`、`ChatFlow.vue`、`GameMenu.vue`；新通知卡                                                                                                                                                                                                                                                                                                               |
| P3  | 创意工坊接入（待工坊解锁）                                                                                                                                                           | M    | `src/core/workshop/{workshop-types,workshop-manifest,workshop-install-plan}.ts`、`src/ui/lib/workshop-client.ts`、`src/ui/stores/workshop-store.ts`                                                                                                                                                                                                                                                                                                                                                         |
| P4  | 真弹窗薄壳、已获批的待裁定能力                                                                                                                                                       | M    | 视裁定而定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

每期都要过 `npm run gates`。P1a 额外以 §4.8 的自检与人工矩阵为验收条件，没过不进 P1b。§11 修法的前两档是启用插件的硬前置，在插件存档里的部分随 P1a 验收（自检 S6）；推广到没启用插件的存档（Q11）不属于本路线图，建议单独排期。

## 10. 待裁定与风险

待裁定：

- Q1 宿主代发 AI 调用，包括「让宿主用玩家配置的模型生成文本或图片」和「替玩家提交一个回合」。
  - 密钥不进插件帧，A 不破。
  - 但它让插件能花玩家的钱。出图若允许插件提供 ComfyUI 工作流，等于让插件经宿主向本机的 ComfyUI 下达任意指令，直接破 D，也可能破 C。
  - 建议：P1 到 P3 不开放。若要开，条件是端点和模型只能用玩家已配置的、插件只提供提示词文本、不接受工作流和任何 URL、按插件限频、玩家逐插件显式授权且每次调用可见。
- Q2 WebRTC 与 `preconnect` 的残余（§4.3）：插件能探测本机和局域网里哪些主机和端口在线，但发不出对方能理解的指令。
  - 建议：接受，并在所有插件的风险说明里写明（§3.4 已含；没声明 `network` 也能用 WebRTC）。
  - 不接受的话只有一条路：回到附录 A 的 Worker 方案，代价是插件失去 DOM 和 UI 框架。
- Q5 引擎门控。建议：自检全过即启用，不再维护「已测大版本」表。理由是 D 依赖的 CSP 网络指令和沙盒标志在各引擎里都成熟，而自检每次启动都在本机实证。保留那张表的代价是浏览器每升一个大版本插件就停用。例外：文件选择器的拒绝没法自动探测（§4.6），所以对插件帧里存在 `showSaveFilePicker` 的引擎保留一张窄表（§4.8 S7），只管这一项。
  - 📌 2026-11-15「没法自动探测」不成立（§4.6 注）：S7 先自动判定，判不出时才查这张窄表，表仍发布为空。
- Q6 FullBackup 是否携带插件包字节。建议不带，只带启用清单和数据。
- Q7 时间推进等非 `StatePatchOp` 的引擎能力是否以后开放成命令。
- Q8 玩家亲手交给插件的文件算不算破 C。
  - 事实：插件帧有完整 DOM，`<input type=file>`、把文件拖进插件窗口、粘贴文件都拦不住，沙盒和权限策略里没有对应的开关。带 `webkitdirectory` 的输入框还能让玩家一次交出整个文件夹。
  - 每次都需要玩家亲手选或拖，插件不能自己去读任何文件。
  - 风险：插件可以哄玩家选一个旧版整库备份，里面可能有 API Key（`database.ts:930-931`），再经网络发走。这是钓鱼，按 D11 不算红线。
  - 建议：裁定为「玩家主动交出的不算破 C」，并在风险说明里单列一条（§3.4 已含）。不接受的话同样只能回到 Worker 方案。
- Q9 本地文件夹的默认位置（现定为仓库上一级的 `poem-plugins/`），以及开发者模式的自动重载是否默认开。
- Q11 §11 的修法要不要也用到没启用插件的存档，即全局修。插件存档里的前两档已是启用插件的硬前置（§11），不在此裁定。
  - 建议：全局修。工坊美化规则的脚本和世界书牵着模型输出，不需要插件就能触发同一问题。
- Q12 是否允许「警告之后由宿主打开插件给的链接」（§5.7）。宿主打开的页面不受沙盒和 CSP 约束，能访问本机和局域网上的服务，玩家的一次点击就会破 D。
  - 建议：不允许，维持只复制链接。

已取消的待裁定项：原 Q2、Q3（插件存档里美化帧是否放宽断网）、原 Q4（DNS 通道）、原 Q10（无脚本视图帧），都随红线 B 取消而失效。

> 📌 2026-11-15 主人裁定：
>
> - Q2：接受，按建议写进所有插件的风险说明。
> - Q5：按建议，自检全过即启用；只保留 S7 的文件选择器窄表（`PICKER_VERIFIED_ENGINES`，发布时为空）。另加 `browserBlocksLocal` 规则（§4.8 短注）。
>   - 📌 2026-11-15 补：窄表降为 S7 自动判定的回退（§4.8「S7 自动判定」注）。
> - Q6：FullBackup 不带插件包字节，只带 `pluginKv` 与存档里的启用清单和数据。
> - Q8：玩家亲手交给插件的文件不算破 C，写进风险说明。
> - Q9：默认目录 `../poem-plugins`（仓库上一级）；开发者模式的「跟随文件夹自动重载」默认关，且只在开发者模式打开时生效（设置键 `pluginDevAutoReload`）。
> - Q1、Q7、Q11、Q12 仍待裁定，未实施；Q12 维持只复制链接。

风险：

- §4.3 里「未验证」的几行（自身导航被 `frame-src` 拦、本地协议文档与 Worker 继承 CSP）是 D 的承重点。它们都在自检里，证明不了就禁用，但如果某个主流浏览器上证明不了，插件在那里就不可用。
- 联网域名规则挡的是「名字」。名字背后的解析结果由 HTTPS、443 端口和证书校验兜底（§4.3）。这个论证成立的前提是插件拿不到 `http:` 和自定义端口，生成器的属性测试要守住这一条。
- 风险确认是这一版里钓鱼、隐私、远程代码三件事的唯一处理手段。文案写得含糊或者勾选框做成默认勾上，就等于没有。
- 插件可以把存档改到引擎不认识的形状。缓解：命令层做类型级校验，回退是玩家的出路。
- 提示注入是 D3 明确允许的，但会让「AI 行为异常」的排查多一个来源。调试面板应列出本回合注入的插件文本。
- 插件脚本跑在主线程的帧里，死循环会卡住整个页面。宿主提供「强制关闭插件」的入口，但卡死时点不到，只能刷新。
- knip 棘轮与分层闸门：新导出必须有消费方，引擎侧模块不得反向依赖前端。
- 工坊解锁前，第三方插件只能靠手工拷文件夹分发。

## 11. 现有风险：美化帧今天就能访问本机和局域网

这原本不在插件系统的范围内，但它破的是同一条红线 D 的精神，而且不需要插件就能发生。

读码确认的事实：

- 美化规则帧的 CSP 放行全部 `http:` / `https:` / `ws:` / `wss:` 连接和远程脚本（`src/ui/lib/beautifier-frame.ts:55-62`），帧的沙盒是 `allow-scripts`（`beautifier-frame.ts:1`）。规则来自工坊时原样安装、默认启用、不剥脚本（`docs/planning/2026-07-31-creative-workshop-compat-design.md:248-254`）。
- 所以一条工坊美化规则里的脚本，今天就可以向 `http://127.0.0.1:8188`、`http://192.168.1.1` 这类地址发请求。ComfyUI 接受工作流投递，工作流可以写文件，装了某些节点还能执行代码。
- 模型帧不跑脚本，但放行远程图片、字体、媒体、样式（`beautifier-frame.ts:38-41`）。模型输出里一个指向内网地址的 `<img>` 就是一次 GET，世界书和角色卡可以牵着模型输出它。
- 两类帧都是单层帧，标记不经清洗（`beautifier-frame.ts:155-160`），应用页面也没有 CSP（`index.html:4-5`），所以帧可以把自己导航到任意地址。
- 应用自己的 BFF 是受保护的：带 `Origin: null` 的请求在 dev 下两层都被拒（`server/app.ts:84-92`，`vite.config.ts:38-47`）；preview 下只有 Hono 那一层（`vite.config.ts:117-130` 的 preview 分支不挂 Vite 那层）。但这是 BFF 自己的防护，别的本地服务没有。

未验证的部分：ComfyUI、Ollama 等服务对这类跨源请求是否有自己的来源检查。那在本仓之外，不能当防线。

残余（2026-11-15 r5 复核记）：https-only 档仍保留裸 `https:`，所以 `https://localhost:端口` 和 IP 字面量仍然连得上。本机如果有装了受信任本地证书（如 mkcert）的服务，美化帧就能请求到它，而且不经过插件的域名确认窗。要彻底堵上，需要对美化帧也做域名白名单，代价是图床要逐个登记，放到 Q11 一并裁定。

插件让这条风险变成插件系统自己的问题：插件单独就能经 `ai.note` 或 `context.set` 让模型输出 `<img src="http://192.168.1.1/…">` 或 `<meta http-equiv=refresh>`，模型卡片正文原样进模型帧（`src/core/story/beautifier.ts:547-566`），不需要任何美化规则配合（§4.4）。

修法（按成本从低到高）。前两档是**启用插件的硬前置**：启用了插件的存档里，美化帧不满足这两档就不许启用插件。

- 两档美化帧的 CSP 去掉 `http:` 和 `ws:`，只留 `https:` 与 `wss:`。本地服务几乎都是明文 HTTP；即使对着内网地址发 HTTPS，对方也拿不出有效证书。代价是只有 HTTP 的图床不再显示。
- 给美化帧套一层牢笼帧拦导航，做法同 §4.1。
- 启动自检对两档美化帧各跑一遍金丝雀探测（§4.8 S6），命中即禁用插件子系统。
- WebRTC 的残余与插件相同（Q2）。

没启用插件的存档要不要同样修（全局修），见 Q11。建议把没启用插件时的这一条晋升到 `docs/known-issue.md`。

> 📌 2026-11-15 实施：前两档已做，开关是存档元数据里的粘性标记 `metadata.pluginHardened`。第一次在某存档启用插件时置上，进入一个列出了插件的存档（例如导入的存档）时也补置；之后不清除，即使插件全部停用。置上后两档美化帧都走加固文档（`src/ui/lib/beautifier-frame.ts` 的 `hardened` 选项：去掉 `http:` 与 `ws:`，套牢笼帧），未置上的存档输出与以前逐字节一致。Q11（没启用插件的存档）未做，已登记到 `docs/known-issue.md`。

## 12. 审查闭环（r1、r2、r4 的发现在 r5 下的状态）

仍有效并已处理：

| 来源       | 发现                                                  | r4 的处理                                                                        | 章节             |
| ---------- | ----------------------------------------------------- | -------------------------------------------------------------------------------- | ---------------- |
| r1-1       | 默认插件目录在 Vite root 内，文件可在应用 origin 执行 | 目录移到仓库外；落在 root 内则拒绝启用；`server.fs.deny` 加拒绝中间件；测试断言  | §3.3、§4.6       |
| r1-2       | 图标用宿主 origin 的 blob URL，SVG 可执行             | 只收栅格并重编码为 PNG；规则适用于所有进入宿主 origin 的插件字节                 | §4.4             |
| r1-5       | 未验证项缺回落；探针会空过                            | 带对照组的金丝雀自检保留，目的改为证明 D；`spendFP` 已读码确认；多标签页加存档锁 | §4.8、§5.3、§6.5 |
| r1-7       | 文件输入                                              | 新架构下拦不住，改为待裁定并写进风险说明                                         | §4.6、Q8         |
| r1-8       | `messages` 投影口径过宽                               | 照 `memory-context.ts:97-107` 过滤并统一脱敏                                     | §5.2             |
| r1-9       | 先 `realpath` 会跟随指向 UNC 的链接                   | 逐段 `lstat`，遇链接即拒；拒绝 `:`、尾随点或空格、保留设备名                     | §4.6             |
| r1-10      | `types.ts:1846` 引用错误                              | 改引 `types.ts:1651`                                                             | §3.5             |
| r1-11      | 表格里未转义的竖线                                    | 表格单元格里不出现竖线                                                           | 全文             |
| r1-12      | BUSY 守卫与提交之间有竞态                             | 锁内复检；发送前等待在途提交                                                     | §5.4、§6.1       |
| r1-14      | `credentialless` 不是防线                             | 不写                                                                             | §4.1             |
| r1-15      | 矩阵缺项与边界                                        | 外部协议进人工矩阵；Spectre 与隐蔽信道划出威胁模型                               | §2.3、§4.3       |
| r1-16      | `memory.add`                                          | 推迟开放                                                                         | §0、§5.3         |
| R2-5、R2-6 | 金丝雀的方法、WebSocket、对照组、等待窗口、挂载顺序   | 全部沿用                                                                         | §4.8             |
| R2-7       | `save-profile.ts` 行号偏移                            | 沿用修正后的行号                                                                 | §5.3             |
| R2-12      | Web Locks 的安全上下文与接管                          | 沿用                                                                             | §6.5             |
| R2-13      | D10 不是主人裁定                                      | D10 已撤回                                                                       | §0、附录 A       |

随架构回退失效：

| 来源  | 发现                                   | 失效原因                                                                                                                                       |
| ----- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| r1-3  | 同作者的美化正则可把模型回显的数据发走 | 外发这一半失效：隐私外发不再是红线。访问内网这一半仍有效，由 R4-1 处理（§11）                                                                  |
| r1-4  | `webrtc 'block'` 不可靠                | 红线 B 取消。WebRTC 对 D 的残余改列 Q2                                                                                                         |
| r1-6  | 装载器如何解析不可信 HTML              | 清洗器删除。装载改在帧内进行，宿主页面不解析插件 HTML                                                                                          |
| r1-7  | 防钓鱼边框                             | 钓鱼不再是红线。边框保留为界面标识                                                                                                             |
| r1-13 | 隔离与 closed 无关的措辞               | shadow tree 挂载降为卫生措施                                                                                                                   |
| R2-1  | 插件存档的美化帧需牢笼帧并剥元素       | 外发这一半失效：「插件存档里美化帧断网」整项删除。访问内网这一半仍有效，由 R4-1 处理：去掉 `http:` / `ws:` 与牢笼帧成为启用插件的硬前置（§11） |
| R2-2  | nonce 可被 CSS 读出                    | 视图帧删除，插件帧允许内联脚本，没有要保护的 nonce                                                                                             |
| R2-3  | `patch` 的清洗与定位范围               | 声明式界面协议删除                                                                                                                             |
| R2-4  | URL 白名单过宽                         | 清洗器删除。联网范围改由 CSP 与域名规则决定                                                                                                    |
| R2-8  | 无脚本帧的备选方案                     | 插件帧就是跑插件脚本的                                                                                                                         |
| R2-9  | `FontFace` 漏出原构造器                | Worker 全局白名单删除                                                                                                                          |
| R2-10 | 壳帧是有 WebRTC 的 window realm        | 壳帧删除                                                                                                                                       |
| R2-11 | 清洗器白名单只看标签名                 | 清洗器删除                                                                                                                                     |

r4 审查闭环（r5 处理）：

| 来源  | 级别 | 发现                                                                                                                             | r5 的处理                                                                                                                     | 章节                           |
| ----- | ---- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| R4-1  | P0   | 插件经 `ai.note` / `context.set` 让模型输出指向内网的 `<img>` 或 `meta refresh`，模型帧 `img-src` 放行 `http:`，插件单独就能破 D | §11 前两档（去掉 `http:` / `ws:`、牢笼帧拦导航）改为启用插件的硬前置；自检加 S6，命中即禁用；Q11 改为只裁定是否全局修，建议是 | §4.3、§4.4、§4.8、§9、§11、Q11 |
| R4-2  | P1   | 「此插件不联网」「等于完全离线」不实，WebRTC 拦不住                                                                              | 改为「未声明联网域名」；外发、探测局域网、远程代码三条警告对所有插件无条件显示                                                | §3.2、§3.4、§4.2、§7、Q2       |
| R4-3  | P1   | `'unsafe-eval'` 加 `blob:` 让任何联网插件都能取代码执行，`remoteCode` 挡不住                                                     | 选择删除该字段：远程代码警告不再依赖它，`script-src` 始终含声明的域名，旧 manifest 里的该字段按未知字段丢弃                   | §3.2、§3.3、§3.4、§3.6、§4.2   |
| R4-4  | P1   | `openExternal` 打开的页面在沙盒和 CSP 之外，玩家点一次确认就能 POST 到 `http://127.0.0.1:8188`                                   | 默认只显示地址和复制按钮，宿主不打开；「警告后由宿主打开」列为 Q12                                                            | §3.4、§4.3、§5.7、Q12          |
| R4-5  | P2   | S5 要放行 `http://localhost`，与「探针用生产生成器」矛盾                                                                         | S5 用单独的测试策略；生产生成器的属性测试不改                                                                                 | §4.8                           |
| R4-6  | P2   | S1 缺预取、推测规则与 `<object>` / `<embed>`                                                                                     | S1 补 `<link rel=prefetch/preload/modulepreload>`、`<script type=speculationrules>`、`<object>`、`<embed>`，S0 各有对照       | §4.8                           |
| R4-7  | P2   | WebRTC 论证缺 ufrag 非法字符与 `turns:` 两点                                                                                     | 人工矩阵加「含空格或 CR/LF 的 ufrag 被浏览器拒绝」；写明 `turns:` 只发 TLS ClientHello，不含可控 HTTP 字节                    | §4.3、§4.8                     |
| R4-8  | P2   | 丢了「宿主向玩家自配服务发受插件影响的提示词不算破 D」的澄清                                                                     | 在 D 的定义下补回：插件只影响提示词文本，不选端点或工作流                                                                     | §2.1                           |
| R4-9  | P2   | 文件选择器拒绝无法自动证明，Q5 又建议去掉引擎门控                                                                                | 自检加 S7：插件帧里存在 `showSaveFilePicker` 且本引擎未过人工矩阵即禁用；Q5 保留只管这一项的窄表                              | §4.6、§4.8、Q5                 |
| R4-10 | P2   | §11「两层都被拒」只在 dev 成立                                                                                                   | 改为 dev 两层、preview 只有 Hono 一层                                                                                         | §11                            |

## 附录 A：已放弃的方案与实测记录

r2、r3 的方案：插件代码只跑在 Dedicated Worker 里；界面由 Worker 产出声明式标记，宿主清洗后渲染进一个只跑宿主脚本的视图帧；交互经 `data-action` 回传；自定义绘制走 `OffscreenCanvas`；Worker 里用全局白名单删掉所有联网 API；启用插件的存档里美化帧断网并停脚本。

放弃理由：它的唯一动机是红线 B（不能联网）加上实测 T1。2026-11-15 红线 B 取消后，这套方案付出的代价（没有 DOM、不能用 UI 框架、交互多一跳、美化规则在插件存档里退化）不再有对应的收益。

实测记录（Chromium 156.0.8078.75，2026-11-15），留作以后参考：

| 号  | 结论                                                                                                                                                                                                                                                                       |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | CSP `webrtc 'block'` 不生效。`sandbox="allow-scripts"` 的 srcdoc 帧，带 `default-src 'none'; connect-src 'none'; webrtc 'block'`，挂在 shadow root 里，仍能建 `RTCPeerConnection`、`createOffer`、`setLocalDescription` 并收集到 host 类型的 ICE candidate                 |
| T2  | 上述帧内用 blob 建的 Dedicated Worker 里没有 `RTCPeerConnection` 和 `webkitRTCPeerConnection`。存在 `RTCDataChannel`（只能靠转移获得）、`fetch`、`XMLHttpRequest`、`WebSocket`、`EventSource`、`importScripts`、`Worker`。Worker 是否继承创建者的 `connect-src` 当时没测准 |
| T3  | 挂在 shadow tree 里的 iframe 不出现在 `window.frames` 里：顶层 `frames.length` 只计 light DOM 的帧，帧内看 `parent.frames.length` 同样。Firefox、Safari 未验证                                                                                                             |

留给以后的结论：

- T1 在 r4 里仍然有用：它是 Q2 残余风险的依据。
- 如果将来又要「插件完全不能联网」或者不接受 Q2、Q8 的残余，Worker 方案是已知的方向。它的前提是 Worker 继承创建者的 CSP，这一条当时未验证；`import()` 是语法、删不掉，只能靠 CSP。
- 当时记下的一个坑：插件源码不能和宿主引导脚本拼进同一个脚本，全局函数声明会在任何代码执行前实例化，能顶替内建对象并抢先执行。
