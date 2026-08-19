# AGENTS.md — `src/ui/` 前端层

> 本文件是**根目录 `AGENTS.md` 的分册**，从中拆出，内容一字未改。
> 拆分理由：这份架构地图只描述 `src/ui/` 下的代码，改这里的代码时才需要它；
> 放进根目录会让每一次会话（哪怕只改引擎）都付它的上下文成本。
>
> **非 Claude Code 的工具**（Codex / Cursor / Windsurf 等）：根 `AGENTS.md` 只留了一行指针，
> 动 `src/ui/` 下任何文件之前，请连同本文件一起读。
> Claude Code 通过同目录的 `CLAUDE.md` 自动导入本文件，无需手动读取。
>
> 🔴 写任何前端 UI 代码前仍必须先看 `docs/design.md`（排版/间距/组件/装饰/动画规范），那条规则在根 `AGENTS.md`。

## 前端架构 (Phase 7)

```
src/ui/                              ← Vue 3 + Pinia + Vite 前端（单 URL 状态驱动）
├── main.ts                          ← 应用入口（createApp + Pinia + 主题 + 音频手势解锁监听）
├── App.vue                          ← 根组件 = **视图状态机 + Toast + 启动链**
│                                       🔴 **全应用没有 vue-router**（别照旧文档去找 `<router-view>`）：
│                                          `viewComponent` 是对 `ui.currentView` 的 computed switch，
│                                          模板里一个 `<component :is>` + `<transition>` 渲染五个
│                                          `defineAsyncComponent`（Home/Create/Game/Settings/Workshop）。
│                                          「懒加载」是当年 router 留下的形状，路由本身已经不在了 ——
│                                          `useRouter()` / `$route` 一个都没有，加回来等于新引入一套
│                                          与 `ui.currentView` 并行的真源
│                                       两个 watch：界面级场景配乐（`queryForView`，见 lib/view-audio.ts）
│                                       + 减少动态效果（**必须 `immediate`** —— 设置从 localStorage
│                                       水合回来不触发变更回调，少了它，开着该选项的用户重启后会先看
│                                       完整一轮动画）
│                                       启动链（全部 `void` + `catch`，任何一条都不许拦住启动）：
│                                       `settings.initApiSecrets()` /
│                                       `worldbooks.init() → workshop.init() → assets.syncRemoteAssets()`
│                                       —— **这三步的顺序是契约**：远程素材的声明有一半住在世界书条目
│                                       正文里（含工坊装进来的书），所以必须排在那两步之后；这里只是
│                                       踢一脚，真正的前置等待在 `syncRemoteAssets()` 内部（设置页的
│                                       「立即同步」不经过这条链，门只能在 action 里）
│                                       / `beautifier.init()` / `audio.init()` / `assets.init()`
│                                       —— 后两个刻意在**这里**而不是各自的设置分区：曲库与素材库要在
│                                       游戏页与捏人页渲染，而那两处都不经过设置页（此前只在
│                                       AssetSection.onMounted 里 init，症状是「导入过的头像不显示」）
├── env.d.ts
│
├── composables/
│   ├── useMapViewer.ts              ← OpenSeadragon 生命周期
│   ├── useMapMarkers.ts             ← 地图标记 CRUD + Overlay 同步
│   │                                   🔴 overlay 居中**只做一次，归 OSD 的 `Placement.CENTER`**
│   │                                      （2026-08-13）：`.osd-marker` 根元素（MapPanel.vue 非
│   │                                      scoped 样式）尺寸恒等于图标、零位移样式 —— 在根元素上
│   │                                      叠 translate/margin 等于恒定屏幕偏移，缩放时标记就在
│   │                                      地图上滑走。名字标签绝对定位在根盒子外，**必须
│   │                                      pointer-events: auto**（none 会让点名牌穿透到画布）。
│   │                                      钉在 MapPanel.marker-anchor.test.ts（?raw 源码断言）
│   ├── useMapPolitical.ts           ← [地图 v1] 势力地图舞台的状态与生命周期（懒建 / 按
│   │                                   `contentHash` 失效 / 卸载释放 / 失败分档）
│   │                                   🔴 懒 + 释放两头都要（设计 §9 预算：一次构建约 280ms、
│   │                                      常驻 idBuf 约 35MB）。提到模块级「反正只建一次」
│   │                                      = 手滑点开一次就常驻 35MB 到本局结束
│   │                                   🔴 失效纪律分两层（2026-08-13 补第二层）：内存缓存按
│   │                                      `contentHash` 失效（不拿路径当键 —— 换图时内容变
│   │                                      路径不变，旧像素配新图不报错）；HTTP 请求经
│   │                                      content-store 的 `provincesRasterUrl(hash)` 挂
│   │                                      `?v=` 回源 + 取图 fetch `no-cache` 验新兜底 ——
│   │                                      只堵内存层时，换包重建仍会拿浏览器缓存的旧像素
│   ├── useHoverPopup.ts             ← 悬停浮层唯一实现（读 settings.hoverDelayMs）
│   ├── usePresets.ts                ← 正文 Agent 预设（ChatPreset）的共享响应式状态 + Dexie 持久化
│   │                                   🔴 Dexie `presets` 表是**唯一真源**：此前预设同时写 Dexie 与
│   │                                      `settings.presets` 镜像、UI 全读镜像 —— 装包写 Dexie、
│   │                                      UI 读镜像 = **装了看不见**。别把第二份镜像加回来
│   │                                   🔴 `presetsRef` 是**模块级单例**：挪进函数体会让 PresetManager
│   │                                      与 AgentConfigPanel 各持一份，`saveAsDefault` 写完另一边看不到。
│   │                                      `activePresetId` 仍留在 settings-store（D22：settings 只留它）
│   ├── useBeautify.ts               ← [工坊正则] 美化管线（从 ChatFlow.vue 抽出，CombatMessageFlow 复用）：
│   │                                   按当前存档合并预设规则与用户规则，交给统一 narrative renderer 编译。
│   │                                   autoEnable 解析与 BeautifierSection **同口径** ——
│   │                                   绑的是**启用的世界书条目 uid**，不是角色名
│   ├── useAssetImage.ts             ← [素材] 渲染缝：(name,type?) → {url,isVideo,row}，世代号守卫 + 引用计数索引
│   │                                   `options.variant` 指定表情/差分（与 name/type 同属"要解析什么"，
│   │                                   故收 getter）—— 位置参数已被注入缝占了，在 options 包**后面**
│   │                                   再挂位置参数是读者陷阱
│   ├── usePlayerPortrait.ts         ← [Q-25] 玩家画像位：立牌链渲染 + 定点导入 + 裁剪台开关
│   │                                   （文案一律出自 game/portrait-messages.ts，本层只决定"做什么"）
│   ├── useSceneImageUrls.ts         ← [图像 v1] 插画字节 → object URL（正文与 CG 图鉴共用一份缓存）
│   │                                   🔴 一律走 lib/asset-url.ts 的引用计数 LRU，**不写第二个**。
│   │                                      每个使用面自己记账：少还是泄漏，多还花的是**别人**那一份
│   │                                      （那份 LRU 只按 id 计数，不记是谁欠的）
│   └── useManualSceneImage.ts       ← [图像 v1] 玩家主动要图那条路（发起 → 被限额拦下 → 弹一次确认 →
│                                       带确认重发）。手动有**两个入口**（正文按钮 + 消息右键），
│                                       D24「手动永不被判成不可用」两处都得守 —— 各写一遍的下场是
│                                       一处补了确认、另一处仍把人拦死在 toast 上
│                                       🔴 请求形状里**没有** source / quotaConfirmed 字段，所以
│                                          「顺手给自动档开个绕过口」在这一层是类型错误，不是代码审查
│
├── lib/                             ← 前端侧的**非组件模块**（纯逻辑 / 唯一 I/O 面 / 注入缝装配）
│                                       🔴 **别把它读成「前端↔引擎的桥接层」** —— 那是意图不是现状：
│                                          实测（2026-08-18）`src/ui` 下有 **134 个非测试文件**直接
│                                          `import '@engine/*'`，其中只有 **19 个**住在本目录，
│                                          另外 115 个是 stores / components 自己直连引擎。
│                                          「引擎只经 lib/ 触达」这条**没有任何闸门**，写代码时不要
│                                          依赖它成立（比如「改引擎签名只要改 lib/」是错的）
│                                       ✅ 真正被机器闸门钉死的是**引擎侧的单向规则**（根 AGENTS.md
│                                          「分层方向只有一个：前端 → 引擎」）：`src/sillytavern/**` 禁止
│                                          反向 import `../ui/*` / `@ui/*` / `vue` / `pinia`（type-only 也算），
│                                          由 `eslint.config.js` 的 `no-restricted-imports` +
│                                          `tests/layering-gate.test.ts` 两道闸守着。**前端往引擎的方向
│                                          不受限**，所以本目录是「值得收口的东西的家」，不是必经之路
│   ├── game-pipeline.ts             ← GamePipeline（AgentConfig 组装/上下文/编排器/回调）
│   │                                   [图像 v1] +onSceneImage（照 onPlayAudio 的形状）
│   │                                   🔴 **自动档绝不追溯开火**（D15）：这个回调只在编排器**刚产出**
│   │                                      这条消息时触发一次，历史消息重渲染走 store 查询、根本不经过
│   │                                      这里 —— D15 是这么**白拿**的。日后千万别为了「补全历史插画」
│   │                                      加一条扫描全部消息的路径，那会把这条安全性一次性拆掉
│   │                                   🔴 checkQuota 在 image_prompt 侧链**之前**（D32）；限额拒绝时
│   │                                      **绝不丢弃标记** —— 什么都不做，让它落到「无记录」格渲染成
│   │                                      手动按钮（D21）。off 档标记照扫（否则会漏成文本）但不建记录
│   ├── audio-singleton.ts           ← AudioManager 应用级单例（setBlobResolver 注入缝）
│   ├── audio-folder.ts              ← [Audio] 本地音乐文件夹（File System Access 唯一接触点，仅 Chromium）
│   ├── asset-zip.ts                 ← [素材] 一键 zip 读写（流式 + SHA-256 + 体积上限）
│   ├── media-hash.ts                ← [素材] **转发壳** —— 实现已迁 `@engine/media-hash`（分层收口 2026-08-17）
│   │                                   仍是全项目唯一一份实现（不可用返 undefined 不换算法），只是换了住处：
│   │                                   引擎的 content-source 也要算同一份 hash，住前端就只能让引擎反向 import。
│   │                                   本文件**不许长出第二份实现**，它只为让四处既有 import 路径不变
│   ├── asset-url.ts                 ← [素材] object URL LRU + 引用计数
│   ├── image-crop.ts                ← [素材] 从源图切真字节（解码与画布两处注入缝）
│   ├── crop-rects.ts                ← [素材] 裁剪框几何（纯函数，源图像素坐标系）
│   ├── beautifier-frame.ts          ← [工坊正则] opaque iframe 文档/CSP/同步 storage 镜像与消息协议
│   ├── beautifier-storage.ts        ← [Dexie v16] regexStorage hydrate / 有序 mutation / 跨 frame 广播 / 配额
│   ├── workshop-client.ts           ← [工坊] 唯一网络接触点（判别联合永不抛穿 + 超时 + 取消）
│   │                                   P4: +listMyProjects / 投稿写侧（create/update/visibility/delete/上传三口）
│   │                                   / 审核面（pending/review/admins/logs/set-admin）
│   ├── workshop-cover.ts            ← [工坊 P4] 封面候选链（wsrv.nl 代理 → 原图；组件按序试）
│   ├── workshop-upstream-error.ts   ← [工坊 P4] Cloudflare 平台错误（1027 额度/1102 资源/429）优先于业务错误
│   ├── workshop-enable.ts           ← [工坊] 启用展开纯函数（项目 → `creative_workshop:<uid>` 集合）
│   ├── image-client.ts              ← [图像 v1] 文生图上游的**唯一网络接触点**（照 workshop-client.ts：
│   │                                   判别联合永不抛穿 + 超时 + 取消）
│   │                                   🔴 成功路径**只准 arrayBuffer()，永远不许 json()/text()**：
│   │                                      NAI 成功响应是 zip 二进制，按文本读会在非法 UTF-8 处产生
│   │                                      U+FFFD 把 zip 悄悄读坏 —— 不报错、只是解不开，症状还伪装成
│   │                                      「上游返回了坏 zip」。text() 只在**非 2xx** 的错误体上用
│   │                                   🔴 必须走 BFF（`server/routes/image.ts` 复用 forward() 管道直通）
│   │                                      —— NAI 没有 CORS，浏览器直连必被拦；key 仍前端持有、
│   │                                      经 Authorization 透传，BFF 零状态
│   │                                   解 zip 归引擎的 image-providers/novelai.ts，本层不解析
│   │                                   🔴 **上游地址是常量，生产不传 `baseUrl`**（2026-08-05 真机连坑两轮）：
│   │                                      出图只有一个地址，而这一格错了之后上游报的错**全都指着无辜的
│   │                                      地方** —— 填成 `api.novelai.net`（NAI 的文本/账户域）时那台机器的
│   │                                      模型枚举停在 V3，于是对合法的 `nai-diffusion-4-5-full` 回
│   │                                      「model must be a valid enum value」；漏掉 `https://` 时 BFF 回
│   │                                      「invalid X-Target-Base-URL」。`baseUrl` 参数保留（自建镜像/测试
│   │                                      替身用），归一化与早退在 `resolveImageBaseUrl`：补协议、剃掉
│   │                                      BFF 会自己拼的 `/ai/generate-image`、文本域**只报错不改写**
│   │                                      （改写等于替用户决定令牌送去哪台机器）
│   │                                   [图像 v2 / C10·C13] +`generateComfyImage`：排队（POST
│   │                                   `/api/image/comfy/prompt`）→ 每 1.5s 轮询 `/comfy/history/{id}`
│   │                                   → 取图 `/comfy/view`，三条路由全部复用 BFF 的 `forward()`
│   │                                   （SSRF 名单早已放行 localhost，ollama 先例），用户免配 CORS
│   │                                   🔴 单 Promise 契约不变 —— 轮询在本层内部，**不做 WebSocket**；
│   │                                      超时是 **provider 属性**：NAI 维持 120s，Comfy 默认 600s
│   │                                      且可配。2 分钟硬闸会把仍在渲染的图记成失败，随后图又悄悄
│   │                                      落在输出目录里
│   │                                   🔴 地址口径与 NAI **相反**：`COMFY_DEFAULT_BASE_URL`
│   │                                      （`http://127.0.0.1:8188`）只是缺省，真值来自
│   │                                      `imageComfy.baseUrl`（C16）—— 本地地址填错的败法是诚实的
│   │                                      connection-refused，不是指向别处的上游错
│   │                                   解析（占位符替换 / node_errors / history 三态）归引擎的
│   │                                   image-providers/comfyui.ts，本层同样不解析
│   ├── scene-image-seams.ts         ← [图像 v1] 把 scene-image-store 的三条缝（checkQuota /
│   │                                   runPromptAgent / send）接到真实实现上，**唯一**生产实现
│   │                                   🔴 缝必须在**存档加载时**挂上，否则每次 generate() 都以
│   │                                      prompt-agent 失败告终，症状是「按了没反应、记录直接变红」
│   │                                   🔴 **不读 `endpoint.baseUrl`**（2026-08-05）：端点记录里只取
│   │                                      `apiKey`，地址走 image-client 的常量。加回来会同时红两处测试
│   │                                      （seams 的「地址一概不传」+ ApiSection.image-endpoint 的源码断言）
│   │                                   刻意做成**不碰 Pinia 的工厂**（入参全是取值函数）——「缝挂上没有」
│   │                                   「限额拒绝时侧链一次都没被调用」这类断言不必挂载任何组件
│   │                                   [图像 v2 / C1·C2·C3] **两条正交分叉线都在本文件收口**：
│   │                                   🔴 `PROVIDER_CAPABILITIES`（supportsCharacterSlots / costModel /
│   │                                      defaultTimeoutMs）是**全仓唯一一张能力表** —— `send` 按
│   │                                      `imageProvider` 分叉去 `generateNaiImage` / `generateComfyImage`，
│   │                                      装配的 `flattenCharacters`、限额的 `costModel` 都从这里取。
│   │                                      能力位属 provider 不属方言（C7）
│   │                                   🔴 方言**每次调用现取现解析**（`parseImageDialects` +
│   │                                      `resolveImageDialect`）：设置页换方言不必重挂缝。缝收到的是
│   │                                      **原料不是成品**（注册表那一面 + 覆盖袋），解析口径全仓一处
│   │                                   🔴 账本记的是**真正发出去的东西**（Q-21）：NAI 从请求体回读，
│   │                                      ComfyUI 从喂给 `substituteWorkflow` 的那袋值回读 ——
│   │                                      不从设置里再算一遍。seed 在这一层定死（客户端那个时钟兜底
│   │                                      只是保险）
│   │                                   `runtimeInfo()` 是记录戳（provider + dialectId）的唯一供给方
│   ├── map-political.ts             ← [地图 v1 / §9] 势力地图的**全部纯逻辑**：provinces.png
│   │                                   像素→tileId 解码 / 政治着色缓冲 / 边界折线（栅格→单位段
│   │                                   →链化→RDP→SVG path）/ 命中 / 高亮补丁 / 平移缩放数学 /
│   │                                   信息卡投影 / 「出发」指令措辞
│   │                                   🔴 **颜色↔tileId 是承重假设**：`MapTile.color` 自
│   │                                      2026-08-12 的 pack 起随包携带（definition.csv 权威色，
│   │                                      地块视图直接用它），但**像素解码仍靠** `colorForId(id)`
│   │                                      确定性哈希 —— provinces.png 的像素↔id 对应就是这个哈希
│   │                                      （实测与首发 definition.csv 316/316 全等；缺 color 的
│   │                                      旧包也回退它）。撞色时两块地**一起丢** —— 顶替的后果是
│   │                                      「整块地画错/点错」且完全无声
│   │                                   🔴 高亮必须是**一份**补丁：`putImageData` 是覆盖不是混合，
│   │                                      逐块 put 会把邻块已画的像素清成透明
│   ├── map-provinces-raster.ts      ← [地图 v1] 取图 + 解码那一步，**唯一**碰 canvas 的地方
│   │                                   （组件测试 mock 它；jsdom 没有 2D 上下文）。永不抛：
│   │                                   公开仓占位包**没有** provinces.png，404 是常态
│   ├── remote-asset-sync.ts         ← [远程素材 v1 / 波 2] 镜像同步：**算清单**（纯函数
│   │                                   `collectDesiredRemoteAssets` / `planRemoteAssetSync`）+
│   │                                   **执行清单**（`runRemoteAssetSync`，本模块唯一的 I/O 面，
│   │                                   fetch/落库/删除/哈希/时钟/发号全从 deps 交进来，故不挂 Pinia 可测）。
│   │                                   调用方是 App.vue 启动链的 `assets.syncRemoteAssets()`
│   │                                   🔴 **清单 100% 由本地算出**（本地世界书 + 已装内容包），网络只下字节
│   │                                      —— 所以断网时「镜像删除」是安全的（清单根本不问网络）。
│   │                                      一次下载失败**永远不许**删掉或降级任何已有行，只进 `failed` 逐条隔离
│   │                                   🔴 **用户的行永远赢**：同一个 `(name,type,variant)` 位上坐着没有
│   │                                      `remote` 戳的行（用户自己导的）时，远程声明让路，只计
│   │                                      `skippedUserOwned`。少了这条，装一次包就能把玩家配的立绘悄悄换掉
│   │                                   🔴 **只镜像自己那一半**：删除候选**仅限带 `remote` 戳的行**。
│   │                                      少了这道过滤，「同步」会变成「把素材库删到只剩声明里那几张」
│   ├── agent-activity.ts            ← 13 个 Agent 的**中文活动文案**（「书写此刻」「辨认后续事件」…）
│   │                                   + AgentToolActivity 的展示层投影；TurnActivityLedger 消费
│   ├── chat-depth.ts                ← ST 兼容的消息深度（zero-based，从末尾倒数）。
│   │                                   🔴 只有 user/assistant 占槽位 —— 应用自造的 system 事件**不占**，
│   │                                      否则深度与酒馆口径对不上
│   ├── item-effects.ts              ← 效果词条归一化纯函数（ItemsPanel 消费）。真机 2026-08-02：
│   │                                   item_gen 落库的 `effects` 有**三种形态**（对象 / `名:描述` 分号串 /
│   │                                   数组），全部压成 `{ name → desc }`。类型定义只描述了其中一种
│   ├── view-audio.ts                ← [Audio] 界面 → 场景配乐映射（纯函数，不碰 store 不播放；
│   │                                   调用方是 App.vue 的 watch）。离开游戏页**不 stop 而是换场景** ——
│   │                                   突然死寂比继续放更突兀，与「未命中时保持当前播放」同一条道理。
│   │                                   游戏页/设置页/工坊返回空 query = 不动音乐
│   ├── reduced-motion.ts            ← 「现在该不该动画」的唯一判定（系统 `prefers-reduced-motion`
│   │                                   ∪ 应用内开关）。★读 DOM 的 `data-reduced-motion` 而**不是**
│   │                                   import settings-store：本模块被组件直接调，走 store 会把纯查询
│   │                                   变成对 Pinia 的依赖（单测就得摆 activePinia）
│   ├── session-import-messages.ts   ← [存档互传] 单存档导入体检结果 → 中文告警行（纯函数，除类型零依赖）。
│   │                                   它是「到底会缺什么」这句话的**唯一措辞来源**（散进模板 = 两个入口
│   │                                   各说各的）；🔴 告警**不是错误**，缺内容照样导得进，语气一律陈述不阻拦
│   └── quality-colors.ts / test-fixtures.ts / toSystemEvent.ts
│
├── themes/                          ← 🔴 主题 CSS **住在这里，不在 lib/**：
│                                       variables.css + 10 主题
│                                       （parchment/obsidian/crimson/indigo/bronze/sakura/
│                                       ivory/misty-lilac/forest/ocean），由 main.ts 逐个 import
│
├── stores/
│   ├── theme-store.ts / ui-store.ts / create-store.ts / game-store.ts
│   │      ui-store 的 `viewHistory` 负责页面级多层返回（例如设置 → 扩展管理 → 工坊），
│   │      `previousView` 只作兼容投影；`back()` 直接弹栈，不能再经 `navigate()` 把当前页
│   │      压回去。同视图重复 navigate 不入栈，否则返回目标会变成自己
│   ├── settings-store.ts            ← 全应用最热的状态；deep watch 自动落 localStorage
│   │                                   🔴 **加新设置要改两处**（Q-18）：先在 settings-types.ts
│   │                                      的 `UiSettings` 上声明，再在 getDefaults() 给默认值。
│   │                                      「任意新字段零改动」那条设计意图已于 2026-08-04 反转
│   ├── settings-types.ts            ← [Q-18] ★`UiSettings`（**type 不是 interface** —— 整份袋子
│   │                                   要传进 5 处 `Record<string, unknown>` 参数，interface 没有
│   │                                   隐式索引签名会当场编译不过；也**不能**加显式索引签名，
│   │                                   那会让 `s.agentTopp` 重新变成合法的 unknown）
│   │                                   已迁出的历史键与迁移标志位刻意**不声明** —— 应用代码碰它
│   │                                   就是编译错误，迁移模块经宽参数照常工作
│   │                                   🔴 [图像 v2 / C8] 图像那 17 个平铺 `image*` 字段全是 NAI 形，
│   │                                      已重构为 **per-provider 袋子**：`imageProvider` /
│   │                                      `imageDialectId` / `imageDialectOverrides[dialectId]` +
│   │                                      共享档（尺寸/步数/CFG/分级/打码/全局负向，两家都读，
│   │                                      comfy 侧作 `%token%` 替换值）+ `imageNovelai`（端点/模型/
│   │                                      采样器/档位 + **限额**，随 C9 归付费后端）+ `imageComfy`
│   │                                      （baseUrl / workflowJson / timeoutMs / pollIntervalMs）
│   ├── image-settings-migration.ts  ← [图像 v2 / C8] 上面那次重构的一次性形状迁移。与
│   │                                   `agent-settings-migration` **完全同一类**（同对象内重排、零跨存储、
│   │                                   无标志位、纯函数永不抛），**不是**六步迁移那一类
│   │                                   🔴 在 `ref()` **之前**同步跑：响应式状态从第一拍起只有新形状，
│   │                                      读取侧不需要「有时平铺、有时袋子」的兼容分支
│   │                                   🔴 **一个旧平铺键都不在时整个早退**，连 agents 袋那步也不做 ——
│   │                                      `agents.image_prompt.systemPrompt` 也要搬进方言覆盖，但无条件
│   │                                      搬运会在**下次启动时把用户刚写的提示词偷走**。旧平铺键当总闸
│   │                                      是安全的：那个 agent 与那 17 个字段是同一版上线的
│   │                                   🔴 覆盖**只在与默认不同时才落**（C6）：相等意味着用户从没改过，
│   │                                      落一份覆盖会把今天的默认值永久钉死在这个档案上。
│   │                                      `systemPrompt` 无法同步比较（方言 JSON 要 fetch），一律当覆盖搬
│   │                                      —— 内容相同的覆盖无害（行为逐字节一致，只是多存一份）
│   ├── agent-settings.ts            ← [Q-18 / 内容分离波 1 D44 v1.2] per-Agent 设置唯一读写口
│   │                                   （`getAgentSettings` / `patchAgentSettings` /
│   │                                   `resetAgentSettings` / `listConfiguredAgents` /
│   │                                   `updateAgentWorldBookIds` + `applyProjectDefaultToAgent`
│   │                                   + `fingerprintValue` / `migrateLegacyAgentOverrides`）
│   │                                   🔴 **`fillMissingAgentSettings` 已删**（D44 大修）：那条「只填空位」
│   │                                      的路径正是「新默认永远进不来」的根因，别照旧文档去找它
│   │                                   🔴 **两层「覆写 ?? 默认」**：覆写层 = `settings.agents[agentId]`，
│   │                                      只装**用户显式改过的 diff**；默认层 = pack `agentDefaults` >
│   │                                      占位文件，由调用方从 content-store 解析后当 `defaultsLayer`
│   │                                      参数传进来。boot 播种已删 —— 它把默认值抄进覆写层、看起来像
│   │                                      用户改过，于是 pack 的新默认永远够不到那个 agent。
│   │                                      合并只发生在**读取咽喉** `getAgentSettings`
│   │                                   🔴 **生产路径必须传 `defaultsLayer`**：不传时退回纯覆写层 + 兜底
│   │                                      （给测试的安全退化），而删播种后世界书/model/数值的唯一来源就是
│   │                                      默认层 —— 漏传的症状是**全体 agent 静默失去世界书**，不报错。
│   │                                      `listConfiguredAgents` / `updateAgentWorldBookIds` 同理迭代
│   │                                      **解析名册**（默认层键 ∪ 覆写层键），否则覆写层为空时工坊装书
│   │                                      会「授权给零个 agent」，用户看到的是「装了等于没装」
│   │                                   🔴 `historyLayers` / `historySlice` **必须保持可缺省，`undefined`
│   │                                      是承重的**：「键不存在」编码的是「让引擎按 Agent 类别决定」
│   │                                      （story / 侧链等类别的引擎默认各不相同）。所以这两键
│   │                                      **无第三层兜底**（两层都缺 → 返 `undefined`），且
│   │                                      `patchAgentSettings` 收到 `undefined` 是**删键**而不是写入
│   │                                      `undefined` —— 后者会让「键存在」成立，从而挡掉引擎默认
│   │                                   🔴 `resetAgentSettings` / `applyProjectDefaultToAgent` 的语义是
│   │                                      **清覆写层**（后者保留 `model` —— 用户选的 API 池不该被默认盖掉），
│   │                                      不再是「把来源值抄进覆写层」
│   │                                   + `AGENT_SETTINGS_DEFAULTS`（**第三层**硬兜底、全应用唯一出处：
│   │                                   temperature 0.7 / topP 1.0 / freqPen 0 / presPen 0 /
│   │                                   **maxTokens 65536**（2026-08-08 由 16384 上调，大纲 5×5 等重输出
│   │                                   不再贴边）/ **maxRetries 3**（2026-08-16，AgentClient.chat|chatStream
│   │                                   的循环上限，外部取消永不重试））
│   │                                   一次性 **指纹迁移**（D44 修正 3）：`@engine/agent-defaults-fingerprints.json`
│   │                                   逐 agent 逐字段 SHA-256，覆写层里命中历史默认指纹的键**删掉**，
│   │                                   用户真改过的（指纹不匹配）保留。指纹不泄内容，首启在
│   │                                   `loadAgentProjectDefaults` 之后跑一次
│   ├── agent-settings-migration.ts  ← [Q-18] 12 张并行 map → `agents` 的一次性形状迁移。
│   │                                   **不是**六步迁移那一类：同一个对象内重排、零跨存储、
│   │                                   无标志位（旧键在不在就是信号）、在 `ref()` **之前**同步跑
│   ├── audio-store.ts               ← [Audio] Pinia 薄壳（桥接单例 + CRUD + 三后端分流）
│   ├── asset-store.ts               ← [素材] 执行器（planImport 出计划，本店只落库）+ importForCharacter/importPortraitPair
│   ├── worldbook-store.ts           ← [工坊 P0] 🆕 世界书 Dexie 唯一入口（`settings.worldBooks` 已不存在）
│   ├── worldbook-migration.ts       ← [工坊 P0] localStorage→Dexie 六步迁移（标志位判定→单事务 bulkPut→逐本回读校验→过了才删源→失败一律不动可重试；dedupeIds 防同 id 静默合并）
│   ├── beautifier-store.ts          ← [工坊 P0b] 美化规则 Dexie 唯一入口（内置预设走纯内存 ref，不持久化）
│   ├── beautifier-migration.ts      ← [工坊 P0b] 复用 P0 六步迁移
│   ├── legacy-dexie-migration.ts    ← [Q-08] localStorage → Dexie 六步迁移的**唯一实现**
│   │                                   （上面两个 migration 都调它，不再各存一份）
│   │                                   🔴 全仓唯一「用户唯一副本 + 校验通过就删源」的数据销毁路径。
│   │                                      铁律：**宁可迁移永不成功，也不能半成功** —— 任何一步失败都让
│   │                                      localStorage 原封不动、标志位不置，下次启动重试
│   │                                   🔴 之所以只许有一份：世界书与美化规则曾各存一份逐字相同的六步，
│   │                                      而漂移已经开始（两份 `dedupeIds` 只差变量名，回读校验一份比
│   │                                      `entries.length`、一份比 `pattern`/`replacement`）。漏改一处的
│   │                                      代价不是编译错误，是**用户数据静默永久丢失**
│   │                                   🔴 `api-key-migration.ts` **刻意留在外面**：它没有 dedupe、不把
│   │                                      标志位当充分条件（还要看 `legacyKeysRetained`）、多一个带回滚的
│   │                                      第 4 阶段 scrub、还要把本地条目 merge 回去 —— 四条差异塞进同一个
│   │                                      泛型签名等于把骨架撑成带四个开关的怪物
│   ├── api-key-migration.ts         ← API 密钥搬进安全存储（App.vue 的 `initApiSecrets()`）。
│   │                                   🔴 加新 `apiType` 时**这里与 `readEntries` 的收窄三元一起改**：
│   │                                      只改一处的症状是「图像 API 存了、重开变成 chat」——
│   │                                      那行收窄跑在每次启动的读取路径上，把不认识的值一律翻成 `'chat'`
│   ├── content-store.ts             ← [内容分离波 1 / D16 §5.1] provider 执行层（纯函数半边在
│   │                                   `@engine/content-source`）。三件事：
│   │                                   ① **模块级 ready promise**（时序契约，最承重的一条）——
│   │                                      settings-store 的构造器在 `main.ts`、`app.mount` **之前**就
│   │                                      `setTimeout(0)` 触发 `loadProjectDefaults()`，App.vue 的 init 链
│   │                                      根本拦不住这个时序。所以 promise **必须在模块加载时创建**，
│   │                                      谁先到都等它（这样装包叠加层才来得及在 fetch 落地前灌进内存层）
│   │                                   ② **contentStatus**（§5.5）：三处 fetch + AgentConfigPanel raw 读 +
│   │                                      audio manifest + beautifier + builtin-worldbooks 全部经 provider
│   │                                      上报内容态。行为兜底不变（失败不阻塞启动），但失败进
│   │                                      `contentStatus='error'` 而不是静默
│   │                                   ③ **内容注册表**：catalog/locations/bloodlines/namePools/markers/
│   │                                      branding/imageDialects/mapPack 等分面的同步读取入口
│   │                                      （`/data/content/<name>.json`）
│   ├── character-appearance-store.ts← [图像 v1 / D56·D58] 角色外貌**会话副本**的 Dexie 唯一读写口。
│   │                                   两份定义：**基线**在 `imagePresets.appearance`（全局、跨存档、
│   │                                   只有用户能改）；**会话**在本店（按存档隔离、由出图 AI 自动写、
│   │                                   删存档连带删）
│   │                                   🔴 「只有用户能改基线」这句话在 v1.3 之前是**假的**：D57 曾让 AI
│   │                                      为没基线的角色现建一份基线，而基线是全局的 —— A 周目的即兴会
│   │                                      成为 B 周目的定义，且两个重置口都够不着它。现在那种角色的即兴
│   │                                      外貌也落本店，于是本店是 **AI 唯一能写的地方**
│   │                                   🔴 自动写入之所以可接受全靠「写的是副本」，所以**必须**提供重置，
│   │                                      且不能只给一种粒度：`resetOne(name)` 与整档重置并存（某个角色
│   │                                      被写歪，别的角色的正确变化不该跟着丢）
│   ├── db-write.ts                  ← [Q-16] 落库前切断 Vue Proxy 的**唯一实现**（`detach`）。
│   │                                   这条不变式由 Dexie 的 structured clone 强制、而**类型系统完全
│   │                                   看不见**：`db.worldBooks.put(reactiveBook)` 类型合法，只在运行时
│   │                                   炸 `DataCloneError`。此前八处各写各的名字、全仓 30+ 次裸
│   │                                   `JSON.parse(JSON.stringify(`
│   │                                   🔴 **内部保持 JSON 往返，别换成 `toRaw` + `structuredClone`**：
│   │                                      `toRaw` 只解顶层代理（嵌套 reactive 照样抛），且会改变落库形状
│   │                                      （Date 存成对象而非 ISO 串、`undefined` 键被保留）——
│   │                                      那是存储格式迁移，不是重构
│   ├── store-result.ts              ← [Q-14] store 层**单条**写操作的统一回执（判别联合）。
│   │                                   起因：`boolean` 的多义性把判定漏到每个调用点 —— AudioLibrary 曾被迫
│   │                                   在 `renameTrack` 返回 false 后反查 `findTrack(id)` 才能分清
│   │                                   「曲目没了」和「名字撞了」；store 明明早就知道，只是没法说出口
│   │                                   🔴 边界是**有意的，别顺手统一掉**：❌ 不管**批量**（走「尽力做完 +
│   │                                      分项计数」，`deleteTracks` 的 skipped 桶把 builtin + 查无此曲
│   │                                      归为**非错误**，统一回执不许把它们翻成失败）；
│   │                                      ❌ 不管**故意的静默无操作**（`setTrackTags`/`setTrackKind` 遇内置
│   │                                      曲目直接 return 是既定策略，改判别式等于凭空多一个分支）
│   ├── store-utils.ts               ← [Q-16] store 层共享小工具（`isQuotaError` 等）。此前 asset-store 与
│   │                                   audio-store 逐字各存一份，注释亲口写着「改一处记得改另一处」——
│   │                                   那句话本身就是本文件该存在的理由
│   ├── scene-image-store.ts         ← [图像 v1] sceneImages/sceneImageBlobs 的 Dexie 唯一读写口 +
│   │                                   `generate()` **串行**队列（NAI 有速率限制且并发同时扣费；
│   │                                   手动点击进同一个队列，不另开一条）
│   │                                   🔴 记录**先落库再发请求**（D5），状态 queued；轮到它才写 startedAt
│   │                                      —— **不是 createdAt**，否则排第三位的图一上来就显示「已用 180 秒」
│   │                                   🔴 `generate()` 的**读-判-写整段串行**（serializeAdmission）：
│   │                                      限额拿落库前的记录集算，两次调用交错就双双读到旧快照、
│   │                                      双双放行。手动开火有两个入口，各自的 busy 只锁自己那个
│   │                                      组件实例 —— 这是唯一一条会**多花钱**的竞态
│   │                                   🔴 取消 queued 项**不产生任何网络调用**（有断言）；中止在飞的
│   │                                      上游照样计费，两种取消的措辞必须不同（D36）。
│   │                                      `fail()` **不覆盖已经落成 aborted 的失败** —— 否则客户端随后
│   │                                      回的「已取消」会把「本次仍可能计费」抹掉，而中止只可能发生
│   │                                      在请求发出之后，也就是每次都被抹掉
│   │                                   🔴 排队中被取消/删掉的记录**永远轮不到 runOne 的 finally**，
│   │                                      所以侧链上下文由 dequeue/abortAll 负责删（纯内存泄漏，无症状）
│   │                                   🔴 `whenIdle()` 轮数用完**抛**不静默返回；它挡的是泵反复被 kick，
│   │                                      挡不住永不兑现的 send（那种交给测试框架超时更好定位）
│   │                                   🔴 重画是**追加 take 不覆盖**；同一锚点下 pinned 至多一条；
│   │                                      'marker' 与 'message-end' 两种锚点的 occurrence 各自独立计数
│   │                                   🔴 [图像 v2 / C14] 新记录盖 `provider` + `dialectId` 戳，值由缝的
│   │                                      `runtimeInfo()` 给 —— **store 不认识 provider 也不认识方言**，
│   │                                      只是把答案抄进记录。两处缺席都读作 novelai + 内置 danbooru
│   │                                      （`LEGACY_DIALECT_ID`），老记录免迁移
│   │                                   🔴 **缓存的场景串只在方言内有效**：重画时源记录方言不匹配就
│   │                                      **不继承** `scenePrompt`，让侧链重跑（D31 的缓存是方言内的）。
│   │                                      那串 danbooru 标签喂给吃句子的模型产出的是一张谁也没要的图，
│   │                                      而调用方以为「重画 = 用我现在的配置再来一次」。
│   │                                      `editedScenePrompt` **不在此列**（D26 逐字优先），
│   │                                      对不对由界面提示，不由 store 替他丢掉。缝没接 `runtimeInfo`
│   │                                      时一律算数 = v1 行为（不认识方言时凭空重跑是在白花钱）
│   │                                   🔴 装配告警落库（`composeWarnings`，C15）**只在非空时写** ——
│   │                                      缺席就是「一切正常」；告警只有缝交得出，store 自己算不出来
│   │                                   限额/侧链/发请求三件事都不在本店（三条注入缝，见 lib/scene-image-seams.ts）
│   │                                   🔴 用量统计与「清理」**不在本店** —— 走 `@engine/database` 的
│   │                                      getSceneImageUsage / listCleanableSceneImageIds /
│   │                                      dropSceneImageBlobs。本店那份重复实现已删（生产零调用方，
│   │                                      且与引擎那份类型同名、字段不同，import 写错就换了套语义）
│   ├── image-preset-store.ts        ← [图像 v1] 角色视觉预设 CRUD。**地点已随 D59 废除**，
│   │                                   `ImagePresetKind` 只剩 'character'（表结构不动，v18 删了那些行）
│   │                                   🔴 主键 = `${kind}:${name}` —— 幻想设定里人名与地名撞车是会发生的
│   │                                   🔴 name 保**原始字符串**、`===` 匹配：不 trim / 不折大小写 / 不 NFKC
│   │                                      （铁律 1）。角色名真源在别处，这边偷偷改名只会让预设查不中；
│   │                                      改名走 rename()（删旧建新），原地 upsert 会留下孤儿记录
│   ├── workshop-store.ts            ← [工坊 P1] 执行器：拿 planInstall 的计划落 DB，不含转换逻辑
│   └── workshop-social-store.ts     ← [工坊 P3] 社交状态（Bearer JWT 弹窗+轮询登录 / JWT 本地解码 /
│                                       toggle 乐观→校正→回滚 + 800ms 节流；纯内存展示层，零 Dexie，D22/D23）
│
├── components/
│   ├── shared/                      ← 通用组件
│   │   ├── AppButton / AppModal / AppCard / AppTabs / ResourceBar / QualityBadge / BuffChip
│   │   │     AppModal 的 `size` 多一档 `full`（通栏两栏版式：**定死高度**而不是给
│   │   │     max-height，里面"左栏铺满 + 右栏自己滚"要一个能百分比化的高度），
│   │   │     另有 `bare`：不画页头、body 不留内边距，**Esc 与点遮罩照旧生效**
│   │   │     （🔴 别写成 `closable: false` —— 那会顺手废掉 design.md §4.5 要求的 Esc）
│   │   ├── AvatarPanel.vue          ← 头像（4 尺寸 × circle/square + video prop）
│   │   ├── AssetMedia.vue           ← [素材] 命中铺满/没命中交回插槽兜底；`variant` 可指定表情/差分
│   │   │                               （⚠️ 不是精确寻址：该变体缺席会退回主图、再退类型链下一档）
│   │   ├── CharacterPortrait.vue    ← [素材] 顶对齐大画像位（纯呈现组件，不碰 store）
│   │   │                               `fill` 档把**尺寸**交回外层容器（撤掉 4:5 与 24rem 上限），
│   │   │                               取景夹逼与焦点缩放两条铁律不变；`overflow:hidden` 必须留
│   │   ├── PortraitSettingsDialog.vue ← [素材] 画像唯一调节面（取景三滑块 + 换图）
│   │   ├── AssetCropEditor.vue      ← [素材] 裁剪台（一张源图烘出立绘+头像两份真字节）
│   │   ├── WorkshopEnableList.vue   ← [工坊] 项目粒度启用列表（捏人页与游戏页共用）
│   │   ├── ContentStatusBanner.vue  ← [内容分离波 1 / D16 §5.5] 内容态横幅（首页与设置页顶部）：
│   │   │                               消费 content-store 的 `contentStatus`，四态文案
│   │   │                               （placeholder / placeholder+检测到本地真实内容 / error /
│   │   │                               pack·needs_attention）。`activePackId` 为空时不渲染
│   │   ├── ToastContainer.vue
│   │   └── form/ (FormInput / FormSelect / FormStepper —— **只有这三个**；
│   │             早期文档里的 Cascader / KeyValue 从未落地，别照着 import)
│   ├── home/
│   │   ├── HomePage.vue             ← 游戏标题画面 —— **本目录唯一的生产组件**
│   │   └── *.standalone.html        ← 🔴 8 个**设计原型**，不是生产界面（AstralDrift / AstralDriftHome /
│   │                                   AstralDriftHomeParticles / AstralDriftHomeTuner / AstralDriftV2 /
│   │                                   AstralDriftV2Tuner / MagicCircle / ObsidianAstrolabeV2）。
│   │                                   自包含单页，无人 import、不进打包 —— 改它们对游戏零影响，
│   │                                   反过来「首页看起来不对」也不要去这里找。
│   │                                   星流首页的集成方案在
│   │                                   `docs/planning/2026-08-09-home-astral-drift-integration-design.md`，
│   │                                   **D6 未获准、集成尚未开始**
│   ├── settings/                    ← [Q-25] 14 个分区**全部**是一行子组件
│   │   ├── SettingsPage.vue         ← 纯壳层（1995 → 约 415 行）：页头 + 主导航 + Agent 子导航
│   │   │                               只留 activeSection / activeAgent / selectSection /
│   │   │                               selectAgent / restoreAgent / agentModelOf 与
│   │   │                               wb.init()（世界书分区也靠它）
│   │   │                               🔴 进 Agent 分区**恢复** `s.activeAgent`，别置 null：
│   │   │                                  此前主导航每个按钮都无条件清掉它（含「Agent 配置」
│   │   │                                  自己），而进分区必须点那一下 —— 于是持久化的选择
│   │   │                                  永远读不回来，每次都落在空态。重挂载由 `v-if` 保证，
│   │   │                                  不需要拿一次用户点击去换。恢复前先对 AGENT_LIST 验，
│   │   │                                  查不到就退空态（陈旧 id 会让页头渲染成空白）
│   │   │                               🔴 主导航末尾那条「扩展管理」**不是分区**：它 navigate 去
│   │   │                                  扩展管理页，故不进 `navItems`、也没有对应的 `activeSection`
│   │   │                                  值。塞进那张表 = 多一个点了只出现空白右栏的选项
│   │   ├── agent/                    ← [Q-25] Agent 分区（照 settings/audio/ 的样子）
│   │   │   ├── AgentSection.vue      ← 分区壳：**单根** section.section.centered + 页头，
│   │   │   │                            其余全交给 AgentConfigPanel
│   │   │   ├── AgentConfigPanel.vue  ← ★可复用配置面（收 agentId）：两个草稿 + 三个动作
│   │   │   │                            （保存/恢复默认/存为项目默认）+ 三张卡。别的分区
│   │   │   │                            传不同 agentId 即可复用；**多根**，外框靠宿主 section
│   │   │   │                            🔴 草稿载入必须 watch(..., { immediate: true })：
│   │   │   │                               分区整块是 `v-if`，每次进分区本组件都是
│   │   │   │                               新挂载，普通 watch 不触发 → 文本框空着渲染
│   │   │   │                               → 「保存设置」把空串写进用户提示词
│   │   │   │                               （回归测试 AgentConfigPanel.test.ts 第一条）
│   │   │   ├── AgentParamsCard.vue   ← API 池 + LLM 旋钮 + 世界书卡（共用 agentCfg/setAgentField）。
│   │   │   │                            旋钮里除数值五参外还有 **失败重试次数**（`maxRetries`，
│   │   │   │                            2026-08-16）与 **历史层数 / 历史截断字数**
│   │   │   │                            （`historyLayers` / `historySlice`）
│   │   │   │                            🔴 后两格**留空 = 写 `undefined` = 删键**（`v === '' ? undefined`），
│   │   │   │                               编码「让引擎按 Agent 类别决定」；绑成 0 或空串会把那条语义
│   │   │   │                               变成一个真的上限，且不报错。见 stores/agent-settings.ts
│   │   │   │                            每格挂 `已覆写 / 默认` 角标（`isOverridden(field)`）——
│   │   │   │                            两层模型下「这个值从哪来」是用户唯一看得见的线索
│   │   │   ├── AgentUpdateCenter.vue  ← **覆写差异面板**（Agent 分区空态区）+ per-agent「清除覆写」。
│   │   │   │                            🔴 它原本叫「提示词更新中心」，为 `fillMissingAgentSettings`
│   │   │   │                               那个旧缺陷而生；D44 从源头解决后**已重定位**——
│   │   │   │                               现在列的是「覆写层里还有条目的 agent」，一键清回默认层
│   │   │   │                               （保留 model）。别按旧名字去理解它做什么
│   │   │   ├── AgentPromptCard.vue   ← systemPrompt + 上下文模板 + 占位符徽章 + 预览（非 story）
│   │   │   │                            占位符插入改用**模板 ref**，不再全局 querySelectorAll
│   │   │   ├── PresetManager.vue     ← 预设子系统 + 两个弹窗（story）；单根，弹窗在根卡内层
│   │   │   ├── agent-list.ts         ← 12 个 Agent 的展示元数据 + getDefaultTemplateForAgent
│   │   │   │                            （combat_v3 战斗侧链：不进主 DAG 但在设置页有入口）
│   │   │   ├── placeholder-catalog.ts← 23 项占位符 + 按 Agent 过滤（DAG 偏序 + 侧链归属）
│   │   │   ├── agent-defaults.ts     ← buildAgentDefaultEntry（纯装配；patch 副作用留调用方）
│   │   │   └── agent-chrome.css      ← ★跨组件共用：.prompt-editor / .template-preview-panel
│   │   │                                🔴 @keyframes 必须与用它的规则同组件 —— Vue 的 scoped
│   │   │                                   编译器按组件 hash 重命名关键帧，分家动画就停了
│   │   ├── settings-chrome.css      ← [Q-25] ★共用外壳样式**唯一一份**（.section>h3/.section-desc/
│   │   │                               .form-*/.toggle-*/.detail-card）。各分区（含壳层）用
│   │   │                               `<style scoped src>` 引入 —— 一份源码，各自作用域。
│   │   │                               父组件的 scoped 样式只能命中子组件**根节点**，够不到里面
│   │   ├── ApiSection.vue           ← API 池 CRUD + 连接测试 + 模型列表（含添加/编辑弹窗）
│   │   │                               🔴 必须**单根**：弹窗放 <section> 内层，否则父级 `.centered`
│   │   │                                  命不中根节点，本分区在宽屏下摊满整行（真机走查逮到）
│   │   │                               🔴 **出图端点只填名称 + API Key**（2026-08-05）：`isImageEntry`
│   │   │                                  把「主链接」与「模型」两格藏掉 —— 地址是常量（见
│   │   │                                  lib/image-client.ts 那条），出图模型在「图像生成 → 出图」卡上。
│   │   │                                  留着它们只会让人以为生效，而填错的后果全是**上游报一句指向
│   │   │                                  别处的错**。保存时 baseUrl 写成常量而非留空（卡片上那行地址
│   │   │                                  要说实话）；「测试连接」的图像分支必须排在 baseUrl 闸**之前**，
│   │   │                                  否则没有地址的出图端点点了会静悄悄什么都不发生
│   │   │                                  结构断言在 ApiSection.image-endpoint.test.ts（不 mount）
│   │   ├── WorldBookSection.vue     ← 世界书列表/导入/新建/删除/恢复 + 条目编辑器入口（约 368 行）
│   │   ├── WorldBookEditor.vue      ← 条目编辑器本体（约 909 行，本目录最大的单文件）：
│   │   │                               条目 CRUD + 关键词/插入位置/深度/触发策略 + EJS 正文
│   │   ├── BeautifierSection.vue    ← ✨ 输出美化分区（Phase 10i 三段式：自动管理 / 已启用 /
│   │   │                               可用规则库折叠）。预设规则从 `beautifier-rules.json` 来，
│   │   │                               用户规则完全可控
│   │   ├── RuleEditorModal.vue      ← 美化规则编辑弹窗；★预览直接挂 game/BeautifiedNarrative.vue
│   │   │                               —— 与正文**同一条渲染链**，不另写一个「像正文」的预览
│   │   ├── TemplatePreview.vue      ← 上下文模板的分段高亮（text / placeholder），AgentPromptCard 消费
│   │   ├── PackInstallConfirmModal.vue ← [内容分离波 1 T7 / D19] 内容包安装/升级的两阶段确认：
│   │   │                               展示 `planPackInstall` 的计划（逐节 added/updated/removed/
│   │   │                               conflicted + 存档 uid 迁移说明 + 三类处置记录），确认后由
│   │   │                               DataSection 以 `{ confirmConflicts: true }` 重入 `installPack`。
│   │   │                               纯展示：不碰 store，也不判该不该显示（宿主决定传什么 plan）
│   │   ├── PlotSection.vue / MemorySection.vue / ThemeSection.vue / MessagesSection.vue
│   │   ├── DataSection.vue          ← 导出/导入/存储用量/清除全部（用量改为**本分区**挂载时读）
│   │   │                               [图像 v1] +本存档插画用量与清理。🔴 这一行**刻意不在图像分区**：
│   │   │                               用量是**每存档**的数字，而图像分区是全局设置；且「清理」与
│   │   │                               旁边那些清除动作是同一类事，放一起才找得到
│   │   ├── DeveloperSection.vue     ← 开发者模式开关 + 诊断能力说明 + 导出隐私警告
│   │   ├── AboutSection.vue
│   │   ├── AudioSection.vue         ← [Audio] 音频分区（壳层 + 5 子组件）
│   │   ├── AssetSection.vue         ← [素材] 素材分区壳层 + 5 子组件（AssetImportStrip /
│   │   │                               AssetRemoteSyncStrip / AssetLibrary / AssetCharacterDrawer /
│   │   │                               AssetDialogs）
│   │   │                               AssetRemoteSyncStrip = [远程素材 v1] 总开关 + 立即同步 +
│   │   │                               上次同步结果行。与 AssetImportStrip 是同一类东西（第三条
│   │   │                               **获取**素材的路径），故沿用 `.io-strip` 外壳与共用 `.toggle-*`。
│   │   │                               🔴 它**不做任何判断** —— 跑不跑、跑出什么、文案怎么写全在
│   │   │                                  asset-store 与 lib/remote-asset-sync.ts
│   │   │                                  （结果行用的就是那边导出的 `formatRemoteSyncCounts`）
│   │   └── image/                   ← [图像 v1] 图像生成分区（壳层 + 3 张卡）
│   │       ├── ImageSection.vue     ← 分区壳。**单根** section.centered（.centered 是 SettingsPage 的
│   │       │                           scoped 规则，只够得到子组件根节点；多根会在宽屏摊满整行，
│   │       │                           ApiSection 真机走查栽过一次）
│   │       │                           🔴 为什么是自己的分区而不是 Agent 分区里的一个类目（D50，
│   │       │                              这条推翻过一次）：Agent 子导航的角标读每 Agent 的 LLM 设置袋，
│   │       │                              「出图」在里面永远没有 model → 永久挂红叉。它本来就不是一个
│   │       │                              agent，是含**两次不同调用**的子系统（LLM 出标签 / NAI 出图）
│   │       ├── ImagePromptCard.vue  ← 第一卡「提示词生成」= 薄壳，内部是 AgentConfigPanel 传
│   │       │                           agentId="image_prompt"
│   │       │                           🔴 **渲染位置 ≠ 存储位置**（D52）：渲染的是 `agents` 袋子里的
│   │       │                              **同一份存储**，不复制到 UiSettings
│   │       │                           🔴 它**不进 agent-list.ts 的 AGENT_LIST**（D53）——同一份配置
│   │       │                              开两个入口，用户就要猜哪个是权威的（先例：combat_v3）
│   │       │                           🔴 [图像 v2 / C3·C6] 给 AgentConfigPanel 传 **`hide-prompt`**
│   │       │                              （该 prop 为此新增），自己画一个**按方言**的编辑器：
│   │       │                              systemPrompt 是方言属性，存 `imageDialectOverrides[id]`，
│   │       │                              占位符显示的是**方言 JSON 的默认形态**（显示叠加后的值，
│   │       │                              用户就再也看不出自己改没改过）。留着那个旧框的下场正是 C6
│   │       │                              点名的静默漂移：两个长得一样的框，一个跟方言走一个不跟
│   │       ├── ImageRenderCard.vue  ← 第二卡「出图」：后端选择 + 三档开关 + per-provider 参数与限额，
│   │       │                           全存 UiSettings
│   │       │                           🔴 三档不是三个光秃秃的单选（D44）：auto 项底下带后果行，
│   │       │                              首次切到 auto 弹一次确认（imageAutoConfirmed 记住）。
│   │       │                              后果行的数字取**当前设置值**，照文案写死会变成一句假话
│   │       │                           🔴 **免费额度是 Opus 专属的**（D43 补丁 2026-08-04）：默认参数满足
│   │       │                              Opus 全部三条，于是这行字曾对**每个**账户都说「免费」——
│   │       │                              按点数付费的账户每张扣约 17 点却被告知不花钱。档位由
│   │       │                              `imageNovelai.tier` 明说，默认 `'unset'`（不猜）；`estimateAnlasCost`
│   │       │                              的 tier 缺省同样是 `'unset'` 而非 `'opus'` —— 忘了传的调用方
│   │       │                              不该白得一个乐观答案
│   │       │                           🔴 免费额度指示只在 consumes-anlas 时报数：anlasPerSample 在免费档内
│   │       │                              也是正数（那是牌价不是这次要付的），照报会显示「免费，约 17 点」；
│   │       │                              输入框清空 → NaN 那一支单独渲染成「算不出来」——把**不知道**
│   │       │                              显示成**免费**是这个指示器最不该犯的错
│   │       │                           🔴 本分区里有**两处**都叫「提示词」：这张卡的画质后缀/全局负向是
│   │       │                              **图本身的提示词**，上一张卡的 systemPrompt 是**教模型怎么转标签**。
│   │       │                              写错框两边都不报错，只是画出来不对
│   │       │                           🔴 [图像 v2] 卡上多两个选择器：**后端**（novelai / comfyui，C1）
│   │       │                              与**方言**（与后端正交，C2；下拉从内容注册表第 7 面读，
│   │       │                              那一面缺席就退化成内置兜底方言 —— 下拉永远不是空的）。
│   │       │                              🔴 注册表**不是响应式的**（模块级 `let`）：computed 里直接读会
│   │       │                              永久缓存空目录，必须落 `ref` + 加载完再刷
│   │       │                           🔴 [C6] 画质后缀 / 全局负向两格绑的不再是平铺字段，而是
│   │       │                              **当前方言的覆盖**：空 = 回落方言 JSON 默认（不是「一个空后缀」）
│   │       │                           🔴 [C9·C16] 切到 ComfyUI 要把 NAI 专属的整块藏掉（端点 / 模型 /
│   │       │                              采样器 / Anlas 卡 / 每消息·每小时上限 —— 本地档那两个上限
│   │       │                              根本不存在），换上 baseUrl + 工作流粘贴框。判据写成
│   │       │                              「等于 comfyui」而不是「不等于 novelai」
│   │       │                           🔴 工作流**空 = 合法**（用内置最小 SDXL 图）；失焦校验只**提前告知
│   │       │                              不拦保存**（躺在里面的是用户从 ComfyUI 导出的整张图）。
│   │       │                              超时输入读不懂（清空/负数）**不写** —— 存成 0 等于每张图
│   │       │                              一发出去就超时
│   │       ├── preset-dialect-form.ts ← [图像 v2 / C15] 「这条预设在当前方言下还有没有可用形象」的纯判定
│   │       │                           🔴 必须与装配层（`composePrompt` 的 `missing-preset` 分支）**给出
│   │       │                              同一个答案**，所以是独立纯函数不是模板里的表达式 —— 两边不一致
│   │       │                              的表现不是报错，是「设置页说好好的，图里那个人就是没出现」
│   │       │                           🔴 `appearance` 用 `hasAppearanceContent` 而**不是** `!== undefined`
│   │       │                              （D62）：编辑器整份写回九个槽，「只填过老标签框」的预设带着一个
│   │       │                              存在但全空的 `appearance`，按存在性判会漏掉最该提示的那一类
│   │       │                           🔴 `dialects.danbooru` **不算数**：C15 明确不做跨方言降级透传
│   │       └── ImagePresetList.vue  ← 第三卡「视觉预设」：角色**初始设定**（属性槽）+ 本档变化
│   │                                   🔴 地点页签已随 D59 删除（地点无法穷举，改由侧链现写）
│   │                                   🔴 D56 两份定义：初始设定全局可编辑；剧情里的变化由出图 AI
│   │                                      **自动**写进**本存档副本**，两个重置口（单角色 / 整档）——
│   │                                      看不见 + 撤不掉的自动写入，正是当初拒绝「一份可变定义」的理由
│   │                                   🔴 D60/D61（v1.3）：**AI 一个字节都写不到基线**。没有基线的
│   │                                      角色，即兴外貌只落会话层 —— 所以本卡必须有「本档临时外貌」
│   │                                      那一节，否则那些角色**整个隐形**（上表按预设行渲染），
│   │                                      也没有单角色重置可按。「存为初始设定」是从即兴到用户拥有的
│   │                                      唯一路径，且**由人按下**
│   │                                   🔴 编辑器里九个槽**各有输入框且留空即空值**（D58）：
│   │                                      只写非空槽会让「清空某个槽」永远做不到
│   │                                   🔴 [图像 v2 / C15] 散文方言下「只有标签形式」的老预设会被装配层
│   │                                      **静默跳过**，所以每行要挂角标（判定在 preset-dialect-form.ts，
│   │                                      本组件只渲染）。跳过是静默的，正是要补这个角标的理由
│   │                                   🔴 名字被占用时如实报 store 的 name-taken，**别自动编号**：
│   │                                      预设是**按名字**被出图链路查中的，编过号的名字永远查不中
│   │                                   🔴 pinnedSeed 的说明必须照实说「同一 seed 只让构图更接近，
│   │                                      **不保证同一张脸**」—— 写成「锁定长相」是守不住的承诺
│   ├── create/                      ← 捏人页（**不再是占位**：8 步向导，共 ~21 个组件 + 7 个测试）
│   │   ├── CreatePage.vue           ← 页壳：8 个 `defineAsyncComponent` 步骤 + 进度条 + 页脚，
│   │   │                               `store.currentStep` 决定渲染哪一步（与 App.vue 同一种
│   │   │                               「computed 选组件」形状，同样没有 router）
│   │   ├── CreateSteps.vue          ← 顶部进度条。★步骤名的**唯一出处** `STEP_LABELS`：
│   │   │                               难度选择 / 基础信息 / 命定核心 / **角色启用** /
│   │   │                               装备选择 / 背景故事 / 剧情规划 / 确认提交
│   │   ├── CreateStepDifficulty.vue      ← ① 难度
│   │   ├── CreateStepBasic.vue           ← ② 基础信息（姓名/性别/种族/血脉…）
│   │   ├── CreateStepDestinyCore.vue     ← ③ 命定核心（★工坊项目粒度的启用在**这一步**，
│   │   │                                    复用 shared/WorkshopEnableList.vue）
│   │   ├── CreateStepCharacters.vue      ← ④ 角色启用：按**世界书条目 uid** 勾选
│   │   │                                    （`store.enabledCharacterEntryUids`），
│   │   │                                    与③的工坊项目粒度是两回事，别混
│   │   ├── CreateStepSelections.vue      ← ⑤ 装备/技能/道具选择
│   │   ├── CreateStepBackground.vue      ← ⑥ 背景故事
│   │   ├── CreateStepPlot.vue            ← ⑦ 剧情规划
│   │   ├── CreateStepConfirm.vue         ← ⑧ 确认提交（含素材/画像收尾）
│   │   ├── AttributeEditor.vue / PointsBar.vue   ← 五维分配与点数条（点数余额的展示层）
│   │   ├── QualityFilter.vue / CategoryTabs.vue / CategorySelectionLayout.vue
│   │   │                                 ← 品质筛选 + 类目页签 + 「左类目 / 右列表」通用版式
│   │   ├── SelectableCard.vue / SelectedPanel.vue ← 可选卡片 + 已选面板（选择步骤的两半）
│   │   ├── BackgroundList.vue / CustomItemForm.vue / PlotOutlinePreview.vue
│   │   │                                 ← 背景列表 / 自定义条目录入 / 大纲预览
│   │   ├── PresetModal.vue          ← 捏人预设弹窗
│   │   ├── CreateFooter.vue         ← 上一步/下一步/校验提示（各步共用，别在步骤里各画一套）
│   │   └── *.test.ts                ← AttributeEditor / PointsBar / SelectableCard / CreateSteps /
│   │                                   CreateStepDestinyCore / CreateStepConfirm.assets
│   ├── game/
│   │   ├── GamePage.vue             ← 游戏页主布局（三栏 + **10 个页面级弹窗**；持有 --rail-w）
│   │   │                               `game.activeModal` 是**单选位**，十个取值：items / characters /
│   │   │                               quests / plot / memory / snapshots / gallery / workshop / map /
│   │   │                               debug（最后一个还要 `s.developerMode`）
│   │   │                               🔴 不占这个位的两类东西别顺手塞进来：迷你播放器是**浮动卡片**
│   │   │                                  （§6.2，必须先于 showModal 拦下），CharacterViewerModal 是
│   │   │                                  **场景栏自己的一层**
│   │   ├── MapPanel.vue / TopBar.vue / SideToolbar.vue / ScenePanel.vue / ChatFlow.vue / InputBar.vue
│   │   │                               [地图 v1] MapPanel 加页签「标记地图 / 势力地图」：两个都靠
│   │   │                               `v-show` 切（标记页签用 v-if 会拆掉 OSD 的挂载容器 ——
│   │   │                               切一次地图就白），势力页签额外一次性 `v-if` 懒挂载
│   │   │                               🔴 顺手修了 `schedulePersist` —— 它此前是**空壳**（定时器
│   │   │                                  回调里什么都不做），标记工作台改的名字/颜色关掉就没了。
│   │   │                                  现在按基线 diff 走 `setMapMarker`/`removeMapMarker`
│   │   │                                  （P1-09 命名写入口 + try/catch），挂载灌入预设**不算改动**
│   │   │                                  （否则预设被复制进存档，此后内容包更新永远不生效）
│   │   ├── MapPoliticalTab.vue      ← [地图 v1 / §9] 势力地图页签（自包含渲染栈，裁定 §12-12：
│   │   │                               **不做 OSD 叠加集成**）。着色 canvas（底图**合成在这张画布
│   │   │                               里**，不留独立 `<img>` 层 —— 被拉伸的图片层在深缩放下会丢光栅块）
│   │   │                               + 高亮 canvas +
│   │   │                               SVG 边界 + 指针交互 + 信息卡 + 路线预览（via/avoid 实时重算）
│   │   │                               四档着色（**自动**/势力/中层/地块，会话内 ref **不落任何存储**，
│   │   │                               默认自动）：自动档按 `view.s / view.min` 定粒度（CK3 口径）——
│   │   │                               < 1.5 势力、< 4.5 中层、≥ 4.5 地块，判定在纯函数
│   │   │                               `resolveEffectiveTintMode`，**渲染面一律读实档不读选档**
│   │   │                               （watch 也是，否则自动档跨阈值时颜色不跟着走）。
│   │   │                               进中层的阈值**就是**标签起显阈值本身（引用同一个常量，
│   │   │                               差一点点就会出现「变了色却没有名字」的一小段区间）。
│   │   │                               刻意**不做迟滞**：同一缩放显示什么不该取决于你是放大还是缩小过来的。
│   │   │                               自动档按钮带出实档（自动·势力/中层/地块）—— 否则玩家不明白
│   │   │                               「我什么都没点，颜色怎么变了」；测试按 `data-mode` 选按钮，
│   │   │                               别按文字（「自动·势力」含「势力」，包含匹配会点错按钮还照样绿）
│   │   │                               换档**重烘**那张离屏底片，绝不为三档各缓存一份 35MB；
│   │   │                               势力档直接复用舞台烘好的缓冲 = 逐像素不变。中层/地块档
│   │   │                               额外画名字标签，**粒度跟着着色粒度走**（地块档标
│   │   │                               地块名约 310 个；中层档标**中层名**、一个域一个约 45 个，
│   │   │                               落点取锚地块形心、缺锚才按 areaPx 加权平均 —— 等权会被
│   │   │                               碎块拽出主体；无成员地块的空壳中层不出标签）；
│   │   │                               低于 `min × 1.5` 整组不画
│   │   │                               🔴 **freeze-and-settle（性能契约，2026-08-12 真机剖析后重做）**：
│   │   │                                  缩放最坏帧曾达 250ms，两个元凶各自都够呛 ——
│   │   │                                  ①`.pv-*` 的 `vector-effect: non-scaling-stroke`（线宽按屏幕算 →
│   │   │                                  「拉大旧栅格」就是错的 → 每格滚轮整张 SVG 重栅格化，实测 204ms）；
│   │   │                                  ②每格改一次反缩放变量 → 310 个带描边中文标签逐帧重排+重刻字形（234ms）。
│   │   │                                  规矩：**`view` 只准喂 `.pol-world` 的 transform**（纯 GPU 变换），
│   │   │                                  一切按分辨率算的量（分档 / 标签可见性 / 标签与棋子位置 /
│   │   │                                  线宽变量 `--pol-stroke-k` / 途经点半径）一律读**防抖 150ms 后的**
│   │   │                                  `settledView`。`.pv-*` 上**禁止**再加 non-scaling-stroke
│   │   │                                  （加回来不报错，只是又开始卡）
│   │   │                               🔴 **标签与棋子住在 `.pol-world` 外的屏幕层 `.pol-screen`**：
│   │   │                                  Chromium 对巨大合成层的栅格化倍率有上限，超过后是把旧栅格拉大 ——
│   │   │                                  住在被 scale() 的层里的文字/头像**必糊，且字号技巧一个都救不了**。
│   │   │                                  屏幕层里字号就是朴素 12px/15px（**别再加 `var(--pol-*-k)`**）。
│   │   │                                  位置按**实时视图逐帧**投影 + 按视口裁剪
│   │   │                                  （`projectLabelsToScreen`，深缩放只留看得见的 ~35 个），
│   │   │                                  每个节点**只写 `transform: translate()`**、字号恒为 12/15px
│   │   │                                  → 大小不变是结构保证，位置逐帧精确跟随
│   │   │                                  🔴 **容器补偿 scale 这条路已废弃、禁止再用**：曾给屏幕层套
│   │   │                                  `scale(f)` 把停稳坐标映射到实时视图，用户直接看见
│   │   │                                  **字在缩放中变大变小、停手 150ms 后啪地跳回去**。
│   │   │                                  文字经过任何 scale 视觉大小就必然变，补偿救不了
│   │   │                               玩家不再涂色高亮，改画一枚棋子 `.pol-pin`（形心落点 +
│   │   │                               `useAssetImage` 头像链、无素材退首字；`transform-origin:
│   │   │                               bottom center` + `translate(-50%,-100%) scale(k)` 三件套
│   │   │                               让**针尖恒指着形心**，少一行就会随缩放滑走）。路线除涂色
│   │   │                               外再画一条折线（顺序）+ 途经点圆点，**只标真的落在
│   │   │                               `tilePath` 上的 via** —— via 是软约束，照原样画会在没经过
│   │   │                               的地块上撒谎
│   │   │                               🔴 「出发」只 `game.fillInput(...)` **不自动发送**（§8.2）：
│   │   │                                  与 ChatFlow 点行动选项同一条缝，**不开第二条写路径**
│   │   │                               🔴 唯一的写是「设为当前位置」→ `game.setPlayerLocation(地块名)`，
│   │   │                                  那条 action 只提交**一条** `set_location`；地块投影归
│   │   │                                  `applySetLocation` 的 `syncMapLocation` 钩子（位置路径先
│   │   │                                  落库、再投影，顺序是契约）。**本组件与那条 action 都不碰**
│   │   │                                  `worldFlags.map` —— 顺手补 `lastTileId` 写的是一份没有
│   │   │                                  patch 背书的派生态，换包自愈/快照回退都会与它打架且不报错。
│   │   │                                  天堑不可落位（findPath 把它剔出邻接图，落过去就哪都去不了）
│   │   │                               [图像 v1] ChatFlow 右键菜单加「为这一段配图」：回退只在**最新一条**
│   │   │                               消息上 —— assistant「回退本轮」/ user「回退到这条输入」（正文没
│   │   │                               生成时右键自己的输入撤回重发），配图**哪条都行**（story 被教了克制使用）
│   │   │                               🔴 `off` 档下这一项**不出现** —— 功能整个关掉了、右键里却还留着
│   │   │                                  一个能开始花钱的入口，是「关掉了但没完全关掉」那类最招人烦的 bug
│   │   │                               锚点是 anchorKind:'message-end'，不做选中文本锚定（原文一改就丢）
│   │   ├── StatusHUD.vue / StatusOverview.vue / ItemsPanel.vue / CharacterListPanel.vue
│   │   ├── CharacterViewerModal.vue ← 非玩家角色的**通栏档案**（左画像 + 右信息面 6 页签：
│   │   │                               档案/状态/装备/技能/背包/相册）。入口是场景栏「在场」那一行
│   │   │                               🔴 分工按**角色归属**不按内容：StatusOverview 是**玩家自己的**面，
│   │   │                                  本弹窗是**别人的**面。字段重叠但变更理由不同，不共用组件
│   │   │                               🔴 画像位只认 `立绘bg → 立绘`，**刻意不复用**共享的两条链 ——
│   │   │                                  那两条都以 `头像` 收尾，而一整栏高的位置上，一张 1:1 证件照
│   │   │                                  拉满看起来像 bug；这一位宁可空着走首字母兜底
│   │   │                               🔴 收的是**名字**不是角色对象：每次从 store 回查（M4 起名字唯一），
│   │   │                                  否则提交换掉整份 characters 后弹窗停在提交前的数值
│   │   │                               🔴 不占 `game.activeModal`（那是页面级弹窗的单选位），
│   │   │                                  它是场景栏自己的一层
│   │   │                               🔴 `.viewer-body` 的 `min-height: 0` 不是洁癖: 少了它窄屏那一档
│   │   │                                  （竖向叠栏）内部滚动作废，弹窗底部内容被切掉且滚不到
│   │   │                                  （jsdom 测不到，靠 `?raw` 源码断言钉住）
│   │   │                               🔴 两栏**都不设 background**：铺一层不透明底会盖掉主题给
│   │   │                                  `.modal-content` 的处理（indigo 的 frosted+blur、sakura 的
│   │   │                                  漆器底纹）。画像栏的底由画框自己给；先例是 `.char-panel`
│   │   │                                  （crimson 在那个前提上做了 `:has()` 液态玻璃）
│   │   │                               🔴 `.viewer-scroll` 要 `tabindex="0"`：它是弹窗唯一的滚动容器，
│   │   │                                  而某些页签下里面一个可聚焦元素都没有 —— 那时长背景故事
│   │   │                                  **只有鼠标读得到**
│   │   │                               🔴 状态效果的时长/层数一律 `== null` 判空: 存量行整键缺
│   │   │                                  `remainingTime` / `stacks`，严格判 `null` 会把
│   │   │                                  **「undefined小时」**印到界面上
│   │   ├── character-viewer.ts       ← 上者的展示层判定（纯函数，不 mount 可测）：副标题分段 /
│   │   │                               好感度视图 / 档案四行 / 登神三轨 / 装备背包分家 / 相册分组
│   │   │                               🔴 层级名由 `tier` 反查 TIER_CONFIGS，`tierName` 只当兜底 ——
│   │   │                                  两者会不一致（真机上一位 T5 贤者自称「普通」）
│   │   │                               🔴 登神三字段自 Phase 9 是数组，存量存档可能仍是 Record：
│   │   │                                  统一先摊平，不摊的表现不是少一行而是白屏；**裸字符串条目
│   │   │                                  要收下**（AI 写得出 `elements: ['空间']`，丢掉就是
│   │   │                                  「明明有两个要素却显示 0/3」）
│   │   │                               🔴 `identity`/`occupation`/`personality`/`appearance`/`outfit`
│   │   │                                  **一律先过收敛器**（`joinLoose`/`textLoose`）：它们经
│   │   │                                  `update_character` 的裸 `Object.assign` 落库、零校验，
│   │   │                                  `??` 兜不住一个字符串 —— `.join`/`.trim` 会从 mount 里抛穿，
│   │   │                                  整个弹窗打不开
│   │   │                               🔴 相册**一个 (类型,变体) 只出一格**：格子按行 id 做 key、图按
│   │   │                                  三元组解析，而索引对同一个位只认一个胜出行。不去重就是
│   │   │                                  两格标题与图都一样、界面上无从区分
│   │   ├── portrait-messages.ts     ← [Q-25] 画像导入路径的文案层（纯函数，零副作用，不 mount 可测）
│   │   ├── QuestsPanel.vue / PlotPanel.vue / MemoryPanel.vue / SnapshotPanel.vue / MiniPlayer.vue
│   │   │                               🔴 SnapshotPanel 自**快照拆表 v22**（2026-08-17）起只读
│   │   │                                  `SnapshotMeta.preview`（玩家台词 / 游戏时间），**不再拉整份
│   │   │                                  快照体** —— 列表渲染碰 body 会把拆表白拆
│   │   ├── BeautifiedNarrative.vue  ← [工坊正则] 正文渲染入口：`compileBeautifierSegments` 分段 +
│   │   │                               `splitSceneImageSegments` 切插画锚点，再分派给
│   │   │                               BeautifierFrame（美化段）与 SceneImageSegment（插画格）。
│   │   │                               ★设置页的 RuleEditorModal 预览也挂它 —— 编辑器与正文同一条链
│   │   ├── BeautifierFrame.vue      ← [工坊正则] opaque iframe 的渲染面：文档由
│   │   │                               `lib/beautifier-frame.ts` 生成（sandbox / CSP / 主题变量注入 /
│   │   │                               消息协议），storage 会话由 `lib/beautifier-storage.ts` 开。
│   │   │                               🔴 本组件只**装**那两份契约，不在这里另写第二套消息协议
│   │   ├── DebugPanel.vue           ← 调试面板（`activeModal === 'debug'` 且 `developerMode`）：
│   │   │                               Agent 请求/响应 + EJS 后端状态 + 引擎设置 + **随机事件区块**
│   │   ├── random-event-debug.ts    ← [随机事件 v1] 上者随机事件区块的展示层判定（纯函数，不 mount 可测）
│   │   │                               🔴 **不装任何判据的第二实现**：硬门槛走 `evaluateEventCondition`、
│   │   │                                  权重走 `computeEventWeight`、上下文走
│   │   │                                  `buildRandomEventRollContext` —— 全是生产函数。调试面板照抄
│   │   │                                  一份判据是最坏的一种重复：**它会在真机上说谎，而说谎的正是
│   │   │                                  那块用来查真相的面板**
│   │   │                               🔴 日概率必须与 `rollRandomEvents` 同算式同顺序：
│   │   │                                  `p = min(1, computeEventWeight(def, ctx, frequency) / mtthDays)`
│   │   │                                  —— 频率系数在 `min` **里面**。写成 `min(1, w/mtth) × freq`
│   │   │                                  在高权重事件上给出不同的数，不报错，只是让人拿着面板上的
│   │   │                                  数字去怀疑调度器
│   │   │                               🔴 本区块回答的是「调度器会不会考虑它」，**不做过期/权重 0 的
│   │   │                                  撤池判定**（`isPendingStillValid` 那一套）；`inPool` 只原样
│   │   │                                  报告池里有没有这个名字，不替它判活
│   │   ├── TurnActivityLedger.vue   ← [管线并行化] 一回合的 Agent 活动账本（逐步骤状态/耗时/重试入口）；
│   │   │                               中文步骤名出自 `lib/agent-activity.ts`，本组件不自造文案
│   │   ├── SceneImageSegment.vue    ← [图像 v1] 正文里一格插画的六种样子。**不判定**该显示什么
│   │   │                               （那是 scene-image-view.ts），只把判定画出来
│   │   │                               🔴 按钮态/排队态/生成中态**占同样高度**，否则每张图落地时对话流
│   │   │                                  会往下跳一截，正在读的那一行被推走
│   │   │                               🔴 占位框里始终写 title 与 intent（D37）：5–60 秒的灰框是纯死时间，
│   │   │                                  而「这张画的是什么」本来就在记录里，写上去成本为零
│   │   ├── scene-image-view.ts      ← [图像 v1] ★七态真值表的**唯一**判定（纯函数，组件里没有第二处）
│   │   │                               🔴 **「无记录 + auto」出的是按钮，不是去生成**（D15/D21）。
│   │   │                                  自动档只对编排器刚产出的那条消息开火一次；渲染层若解释成
│   │   │                                  「没记录就补一张」，每次把开关拨到自动、每次滚回历史消息
│   │   │                                  都会**追溯烧钱**。设计点名这是最可能被人「顺手补全」掉的一环
│   │   │                               🔴 blurByDefault 曾经**声明了但没人传**，D46 打码整个是死的。
│   │   │                                  根因是只有单组件测试 —— 那种测试能证明逻辑对，
│   │   │                                  **证明不了有人供值**。现有从 ChatFlow 真渲染到底的链路测试
│   │   ├── scene-image-actions.ts   ← [图像 v1] done 态里两件纯判定：复制的必须是**这张实际发出去的**
│   │   │                               那份提示词（记录里躺着三个候选，取错不报错）；角标 2/3 的点击是
│   │   │                               **浏览**不是钉住（后者会落库、正文从此定死）
│   │   │                               🔴 [图像 v2 / C14] +重画前的方言提醒（SceneImageSegment 渲染）：
│   │   │                                  **只在有 `editedScenePrompt` 时提醒**。没手改时方言变了引擎会
│   │   │                                  自己重跑侧链，那条路已经是对的，再弹一句只会教会用户忽略它。
│   │   │                                  **提醒不是阻断**（那份手改可能正是为新方言写的）；两边缺席
│   │   │                                  都读作内置 danbooru 方言
│   │   ├── CgGalleryPanel.vue / CgGalleryDetail.vue / cg-gallery.ts
│   │   │                             ← [图像 v1] CG 图鉴 = 同一批 SceneImageRecord 的**第二个视图**，
│   │   │                               零新数据模型（折叠/排序/收录判据在纯函数 cg-gallery.ts）
│   │   │                               🔴 只列**已经画出来的**：未生成的标记与失败的记录都不进 ——
│   │   │                                  塞灰格子会让它从战利品陈列变成待办清单。已清理的**要列**，
│   │   │                                  显示成「字节已清理 + 重画」而不是破图
│   │   │                               🔴 懒加载**双保险**：IntersectionObserver **加上** 500ms 定时兜底
│   │   │                                  （对视口 ±1500px 复查）。单靠观察器在低带宽/弱设备上会不触发，
│   │   │                                  表现为一屏空白框 —— 那种「我这边好好的」的 bug
│   │   │                               🔴 [图像 v2 / C14·C15] 详情页多两行：**出图后端 / 方言**（缺席读作
│   │   │                                  novelai + danbooru，**不渲染成「未知」**）与 `composeWarnings`
│   │   │                                  的说明行 —— `ComposedPrompt.warnings` 在 v1 里产出后全仓无人读，
│   │   │                                  于是「某角色在那条方言下没有可用形象，已跳过」对玩家完全不可见，
│   │   │                                  他只看到画面里少了个人。措辞说**「出图时的方言」不是「当前方言」**：
│   │   │                                  告警是那一次装配留下的，把历史事实说成现状会让排查走错方向。
│   │   │                                  不做 toast（每张图都会响）、不阻断（AI 新造 NPC 无预设仍要画场景）
│   │   └── (战斗面板见 combat/ 子组件，docs/reference/combat-system-architecture.md)
│   └── workshop/                    ← 扩展管理 + [工坊 P1] 创意工坊子页面
│       ├── ExtensionManagementPage.vue
│       │                               ← 首页/设置/游戏侧栏统一入口；原版扩展暂为明确占位，
│       │                                  社区扩展的按存档启用设置归本页
│       ├── CommunityExtensionSettings.vue
│       │                               ← 已安装社区扩展启用面（选择存档 + 项目粒度勾选）
│       ├── WorkshopPage.vue         ← 创意工坊子页面（浏览/安装/更新/卸载/投稿，不放启用设置）
│       ├── WorkshopBrowseModal.vue    ← 搜索 + 服务端排序（5 模式）+ 恒定四标签筛选 + 骨架屏
│       ├── WorkshopDetailModal.vue    ← 装前检视：条目/正则逐条展开
│       │                                 ★ 正则行的处置预告复用 `mapWorkshopRegexes`
│       │                                   （与装后已装列表同源，别另写第二套判定）
│       ├── WorkshopProjectCard.vue    ← tags 一条不折叠（D12，勿改成「更多」）
│       ├── WorkshopInstalledList.vue / WorkshopConflictModal.vue
│       │     ★ P4 起后者对**每一次更新**都出现（不只有冲突时）——多出改动预告一节；
│       │       有冲突才用那句惊悚标题，否则只是「确认更新」（狼来了会让用户闭眼点过去）
│       ├── WorkshopSubmitModal.vue    ← [工坊 P4] 投稿/编辑（多步进度 + 失败善后话）
│       │                                 🔴 编辑已发布项目上游会**换成草稿 id**，后续上传必须打新 id
│       ├── WorkshopAdminModal.vue     ← [工坊 P4] 审核面板（待审核/管理员/日志三 Tab，超管才见后两个）
│       ├── WorkshopSocialActions.vue  ← [工坊 P3] 点赞/订阅按钮对（卡片 compact / 详情 full 共用
│       │                                 **唯一**社交动作入口——四条失败分支文案必须同源，别各写一份）
│       └── format.ts / failure-text.ts（展示层纯函数；P3: +unauthorized 分支 / Discord 头像与登录引导文案）
│
└── styles/                          ← base.css / transitions.css / utilities.css
    ├── cards-shared.css             ← 系统卡片共享样式（game/cards/ 的 Craft / Combat / Item 卡引用）。
    │                                   强调色由消费方设 `--sys-accent`（品质色/结局色），骨架用整圈
    │                                   边框色调 + 头部色点表达 —— **禁用左侧色条**；颜色一律走变量
    └── integrated-game-surfaces.css ← 七个主题的材质整合层（生成的底盘负责材质，组件只负责结构/
                                        可读性/交互，绝不在底盘之上再叠一层通用应用卡片）
                                        🔴 **加载顺序是契约**（见 main.ts 的注释）：本表刻意排在
                                           九个主题之后、而 `themes/ivory.css` 又刻意排在**本表之后**。
                                           ivory 的织锦浮雕要一块不透明连续布面，本表给它的却是
                                           全屏丝绸底盘 + 近乎透明面板，两者互斥且特异度相同 ——
                                           只靠特异度赢要给每条规则加冗余选择器，所以用顺序解决。
                                           本表不重定义任何 `--theme-*`，故这个位置对另外九个主题零影响
```

### 设置页 14 分区

| 分区           | 内容                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔌 API 配置    | API 池 CRUD、连接测试、模型列表获取、模型推荐                                                                                                                                                                                                                                                                                                   |
| 🤖 Agent 配置  | 12 个汉化 Agent、模型选择、世界书开关、System Prompt 编辑                                                                                                                                                                                                                                                                                       |
| 📚 世界书      | **早已不是占位**：书列表 + 导入/新建/删除/恢复（`WorldBookSection.vue`，约 368 行）+ 条目编辑器（`WorldBookEditor.vue`，约 909 行：条目 CRUD / 关键词 / 插入位置与深度 / 触发策略 / EJS 正文）。数据在 Dexie（工坊 P0 起 `settings.worldBooks` 已不存在）                                                                                       |
| 📖 剧情系统    | 8 种剧情偏向、模式/年份/难度/外部NPC/自定义偏好、大纲预览                                                                                                                                                                                                                                                                                       |
| 🧠 记忆 & 缓存 | 召回数/压缩阈值/快照上限/缓存策略                                                                                                                                                                                                                                                                                                               |
| 🎨 外观主题    | 10 主题网格、字体风格、字体大小、悬停延迟、减少动态效果                                                                                                                                                                                                                                                                                         |
| 💬 消息显示    | 系统通知开关 + 7 种事件类型过滤                                                                                                                                                                                                                                                                                                                 |
| ✨ 输出美化    | 预设规则库 (22条) + auto-enable 绑定 + 三段式 UI + CRUD                                                                                                                                                                                                                                                                                         |
| 🎵 音频        | 混音台 + 播放列表 + 音轨库（音乐文件夹条/上传/搜索/场景配乐开关）                                                                                                                                                                                                                                                                               |
| 🖼 素材         | 导入条 + 素材库（按角色分组/扁平表/多选批删）+ 变体抽屉（设主图/裁剪/改名）                                                                                                                                                                                                                                                                     |
| 🖼 图像生成     | 三张卡：提示词生成（`image_prompt` 的模型/温度/世界书存 `agents` 袋子；systemPrompt 按方言存 `imageDialectOverrides`）/ 出图（后端 + 方言选择 + 三档开关 + per-provider 参数与限额，存 `UiSettings` 的 `imageNovelai`/`imageComfy` 袋）/ 视觉预设（角色初始设定存 Dexie `imagePresets`；本档外貌存 `characterAppearances`，含「存为初始设定」） |
| 💾 存档数据    | 导出/导入/清除（排除音频库与素材库，各有独立导出口）                                                                                                                                                                                                                                                                                            |
| 🛠 开发者模式   | 持久开关（默认关闭）；控制调试工具栏、原始 Agent 请求/响应、reasoning、工具 payload、诊断导出与 `Alt + Shift + D` 抽屉                                                                                                                                                                                                                          |
| ℹ 关于         | 制作人员、项目与技术信息、内容包世界概览、版权与第三方许可证署名                                                                                                                                                                                                                                                                                |

### 预设系统（正文 Agent 专用）

仿 SillyTavern AI Response Configuration 面板：预设选择器 + 导入 ST JSON / 新建 / 导出 / 删除；采样器参数预览；条目列表（启用/名称/角色/字数/编辑）；ST 导入完整保留 `prompts[]`。
