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
├── App.vue                          ← 根组件（<router-view> + Toast + 界面级场景配乐 watch + 音频/素材库 init）
├── env.d.ts
│
├── composables/
│   ├── useMapViewer.ts              ← OpenSeadragon 生命周期
│   ├── useMapMarkers.ts             ← 地图标记 CRUD + Overlay 同步
│   ├── useHoverPopup.ts             ← 悬停浮层唯一实现（读 settings.hoverDelayMs）
│   ├── useAssetImage.ts             ← [素材] 渲染缝：(name,type?) → {url,isVideo,row}，世代号守卫 + 引用计数索引
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
├── lib/                             ← 前端↔引擎桥接层
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
│   ├── media-hash.ts                ← [素材] SHA-256 唯一实现（不可用返 undefined 不换算法）
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
│   ├── quality-colors.ts / test-fixtures.ts / toSystemEvent.ts
│   └── variables.css + 10 主题 CSS（parchment/obsidian/crimson/indigo/bronze/sakura/ivory/misty-lilac/forest/ocean）
│
├── stores/
│   ├── theme-store.ts / ui-store.ts / create-store.ts / game-store.ts
│   │      ui-store 的 `previousView` 只记**一层**来路，服务「进去了要能原路回来」
│   │      （工坊有三个入口：首页 / 游戏页侧栏 / 设置页导航）。同视图重复 navigate
│   │      刻意不覆盖它 —— 否则返回目标会变成自己，返回键就地失效。不是历史栈
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
│   ├── agent-settings.ts            ← [Q-18] per-Agent 设置唯一读写口（get/patch/reset/fillMissing
│   │                                   /listConfigured/updateAgentWorldBookIds）+ AGENT_SETTINGS_DEFAULTS
│   │                                   （0.7/1.0/0/0/16384 全应用唯一出处，此前四文件六处拷贝）
│   ├── agent-settings-migration.ts  ← [Q-18] 12 张并行 map → `agents` 的一次性形状迁移。
│   │                                   **不是**六步迁移那一类：同一个对象内重排、零跨存储、
│   │                                   无标志位（旧键在不在就是信号）、在 `ref()` **之前**同步跑
│   ├── audio-store.ts               ← [Audio] Pinia 薄壳（桥接单例 + CRUD + 三后端分流）
│   ├── asset-store.ts               ← [素材] 执行器（planImport 出计划，本店只落库）+ importForCharacter/importPortraitPair
│   ├── worldbook-store.ts           ← [工坊 P0] 🆕 世界书 Dexie 唯一入口（`settings.worldBooks` 已不存在）
│   ├── worldbook-migration.ts       ← [工坊 P0] localStorage→Dexie 六步迁移（标志位判定→单事务 bulkPut→逐本回读校验→过了才删源→失败一律不动可重试；dedupeIds 防同 id 静默合并）
│   ├── beautifier-store.ts          ← [工坊 P0b] 美化规则 Dexie 唯一入口（内置预设走纯内存 ref，不持久化）
│   ├── beautifier-migration.ts      ← [工坊 P0b] 复用 P0 六步迁移
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
│   │   ├── AvatarPanel.vue          ← 头像（4 尺寸 × circle/square + video prop）
│   │   ├── AssetMedia.vue           ← [素材] 命中铺满/没命中交回插槽兜底
│   │   ├── CharacterPortrait.vue    ← [素材] 顶对齐大画像位（纯呈现组件，不碰 store）
│   │   ├── PortraitSettingsDialog.vue ← [素材] 画像唯一调节面（取景三滑块 + 换图）
│   │   ├── AssetCropEditor.vue      ← [素材] 裁剪台（一张源图烘出立绘+头像两份真字节）
│   │   ├── WorkshopEnableList.vue   ← [工坊] 项目粒度启用列表（捏人页与游戏页共用）
│   │   ├── ToastContainer.vue
│   │   └── form/ (Input/Select/Stepper/Cascader/KeyValue)
│   ├── home/HomePage.vue            ← 游戏标题画面
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
│   │   │                               🔴 主导航末尾那条「创意工坊」**不是分区**：它 navigate 去
│   │   │                                  工坊页，故不进 `navItems`、也没有对应的 `activeSection`
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
│   │   │   ├── AgentParamsCard.vue   ← API 池 + 7 个 LLM 旋钮 + 世界书卡（共用 agentCfg/setAgentField）
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
│   │   ├── WorldBookSection.vue     ← 世界书列表/导入/新建/删除/恢复 + 条目编辑器
│   │   ├── PlotSection.vue / MemorySection.vue / ThemeSection.vue / MessagesSection.vue
│   │   ├── DataSection.vue          ← 导出/导入/存储用量/清除全部（用量改为**本分区**挂载时读）
│   │   │                               [图像 v1] +本存档插画用量与清理。🔴 这一行**刻意不在图像分区**：
│   │   │                               用量是**每存档**的数字，而图像分区是全局设置；且「清理」与
│   │   │                               旁边那些清除动作是同一类事，放一起才找得到
│   │   ├── DeveloperSection.vue     ← 开发者模式开关 + 诊断能力说明 + 导出隐私警告
│   │   ├── AboutSection.vue
│   │   ├── AudioSection.vue         ← [Audio] 音频分区（壳层 + 5 子组件）
│   │   ├── AssetSection.vue         ← [素材] 素材分区壳层 + 4 子组件
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
│   ├── create/CreatePage.vue        ← [占位] 捏人页
│   ├── game/
│   │   ├── GamePage.vue             ← 游戏页主布局（三栏 + 6 弹窗；持有 --rail-w）
│   │   ├── MapPanel.vue / TopBar.vue / SideToolbar.vue / ScenePanel.vue / ChatFlow.vue / InputBar.vue
│   │   │                               [图像 v1] ChatFlow 右键菜单加「为这一段配图」：回退只在**最新一条**
│   │   │                               消息上 —— assistant「回退本轮」/ user「回退到这条输入」（正文没
│   │   │                               生成时右键自己的输入撤回重发），配图**哪条都行**（story 被教了克制使用）
│   │   │                               🔴 `off` 档下这一项**不出现** —— 功能整个关掉了、右键里却还留着
│   │   │                                  一个能开始花钱的入口，是「关掉了但没完全关掉」那类最招人烦的 bug
│   │   │                               锚点是 anchorKind:'message-end'，不做选中文本锚定（原文一改就丢）
│   │   ├── StatusHUD.vue / StatusOverview.vue / ItemsPanel.vue / CharacterListPanel.vue
│   │   ├── portrait-messages.ts     ← [Q-25] 画像导入路径的文案层（纯函数，零副作用，不 mount 可测）
│   │   ├── QuestsPanel.vue / PlotPanel.vue / MemoryPanel.vue / SnapshotPanel.vue / MiniPlayer.vue
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
│   │   ├── WorkshopEnablePanel.vue  ← [工坊] 每存档「内容启用」面板（建档后仍可改）
│   │   └── (战斗面板见 combat/ 子组件，docs/reference/combat-system-architecture.md)
│   └── workshop/                    ← [工坊 P1] 创意工坊页
│       ├── WorkshopPage.vue         ← 页面壳（已安装列表 + 浏览入口；首页与侧栏均有入口）
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
```

### 设置页 14 分区

| 分区           | 内容                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔌 API 配置    | API 池 CRUD、连接测试、模型列表获取、模型推荐                                                                                                                                                                                                                                                                                                   |
| 🤖 Agent 配置  | 12 个汉化 Agent、模型选择、世界书开关、System Prompt 编辑                                                                                                                                                                                                                                                                                       |
| 📚 世界书      | [占位] 导入/新建按钮                                                                                                                                                                                                                                                                                                                            |
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
| ℹ 关于         | 引擎版本/技术栈/统计                                                                                                                                                                                                                                                                                                                            |

### 预设系统（正文 Agent 专用）

仿 SillyTavern AI Response Configuration 面板：预设选择器 + 导入 ST JSON / 新建 / 导出 / 删除；采样器参数预览；条目列表（启用/名称/角色/字数/编辑）；ST 导入完整保留 `prompts[]`。
