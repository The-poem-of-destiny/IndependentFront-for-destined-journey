# AGENTS.md — `src/sillytavern/` 引擎层

> 本文件是**根目录 `AGENTS.md` 的分册**，从中拆出，内容一字未改。
> 拆分理由：这份架构地图只描述 `src/sillytavern/` 下的代码，改这里的代码时才需要它；
> 放进根目录会让每一次会话（哪怕只改文档）都付它的上下文成本。
>
> **非 Claude Code 的工具**（Codex / Cursor / Windsurf 等）：根 `AGENTS.md` 只留了一行指针，
> 动 `src/sillytavern/` 下任何文件之前，请连同本文件一起读。
> Claude Code 通过同目录的 `CLAUDE.md` 自动导入本文件，无需手动读取。

## 架构（已实现部分）

````
src/sillytavern/                    ← 核心引擎
  │
  ├── types.ts                      ← 唯一类型来源；大型联合类型拆 types-*.ts（如 types-audio.ts）
  │   ├── v3 兼容: Lorebook / ChatPreset / AppSettings / ChatSession / ChatMessage
  │   ├── v4+: CharacterState / MemoryRecord / PlotEvent / Snapshot / SaveSlot
  │   │         ApiEndpoint / AgentConfig / AgentDefinition / Pipeline / AgentContext
  │   │         AgentResult / OrchestratorRun / MapMarker / VarsPatch（🪦 MapTopology 从未存在过，
  │   │         地图类型在 types-map.ts 分册）
  │   ├── Audio: AudioSourceKind ('blob'|'builtin'|'file') / AudioTrack / AudioBlobRecord 等
  │   ├── CreatePreset（捏人预设的**落库形状**，Dexie `createPresets.data`）——
  │   │    定义 2026-08-17 从 `src/ui/stores/create-store.ts` 迁来（分层收口）：
  │   │    `database.ts` 曾为标这一个类型反向 import 前端 store。create-store 侧 re-export 同名
  │   └── 辅助: createDefaultCharacterState() / resolvePlotTree()
  │
  ├── database.ts                   ← Dexie/IndexedDB v23
  │       🔴 `DB_VERSION` 常量必须等于最后一个 `this.version(n)`。它只出现在
  │          `FullBackup.version` 上、导入侧不拿它做判断，所以**对不上不会有任何报错**，
  │          只是每份导出的备份都盖了过期的戳。它曾经落后两版（v18/v19 忘了改），
  │          而 `database.test.ts` 的断言跟着写了旧值 —— 漂移被测试固定而不是拦下
  │   ├── v1-v3: lorebooks / presets / settings / chats
  │   │           🪦 lorebooks 是 v3 遗留 `Lorebook` 类型的**死表**，生产代码零读写；
  │   │              现役世界书表是 v14 的 worldBooks（`WorldBook` 类型）。
  │   │              settings 自 Q-06 起也是死表 —— 此前这句话是**错的**：它有三处活引用
  │   │              （initializeDatabase 播种 / state-manager 打快照时读 / FullBackup），
  │   │              而前端设置的真源在 localStorage，于是引擎读到的是一份永远停在
  │   │              DEFAULT_SETTINGS 的影子配置（症状：设置页改了、引擎行为没变）。
  │   │              现在引擎经 `engine-settings.ts` 注入缝读真源，播种与那座只搬两个
  │   │              字段的桥（game-pipeline.syncSnapshotSettings）都已删除。
  │   │              两张死表刻意保留（删表要写 `表名: null`，会永久抹掉老用户的 v1–v3 行）；
  │   │              FullBackup 仍照搬它们的行，只为老备份往返不丢字节。
  │   ├── v4+: memories / plotEvents / characters / snapshots / saves / apiEndpoints
  │   ├── v11+: audioTracks / audioBlobs / audioPlaylists（全局共享，排除 FullBackup）
  │   ├── v12+: audioHandles（持久化 FileSystemDirectoryHandle）
  │   ├── v13+: assetMeta / assetBlobs（素材库，全局共享，排除 FullBackup，走 zip 导出）
  │   ├── v14+: worldBooks / workshopProjects（工坊 P0；两者都进 FullBackup）
  │   ├── v15+: beautifierRules（工坊 P0b；只存**用户规则**，内置预设是派生缓存不落库）
  │   ├── v16+: regexStorage（所有正则/信任级别/预览共享的隔离 KV；进 FullBackup；更新/卸载保留）
  │   ├── v17+: sceneImages / sceneImageBlobs / imagePresets（图像 v1）
  │   │          删存档连带删前两张；**imagePresets 刻意不删** —— 视觉预设是全局的，
  │   │          与素材库同口径（删一个存档不该让别的存档的角色换脸）
  │   │          FullBackup 收 sceneImages ✅ + imagePresets ✅、**sceneImageBlobs ❌** ——
  │   │          图片字节进 JSON 会爆炸；字节的回收走「清理」不走备份
  │   │          🔴 「清理」= 删 blob 行 + 给记录打 blobDropped，**sceneImages 行数不变**（D47）：
  │   │             图鉴那一格变成「字节已清理 + 重画」，标题/说明/提示词一条不少
  │   │             判据 `hasStoredSceneImageBytes` 与三个入口（用量 / 可清理名单 /
  │   │             真正删字节）**只有这一份** —— scene-image-store 里那份重复实现已删
  │   ├── v18+: **无新表**，只删数据 —— 地点视觉预设废除（D59），
  │   │          `imagePresets` 里 `kind==='location'` 的行清掉。故这一版
  │   │          **不带 `.stores()`**：带上就得把 v17 全套表名再抄一遍，抄漏一张就是删表
  │   ├── v19+: characterAppearances（角色外貌**会话副本**，D56）
  │              与 imagePresets（全局基线）刻意相反：**随存档隔离，删存档连带删**，
  │              且**进 FullBackup** —— 它与 sceneImages 同为「每存档」数据，必须同进同出。
  │              漏收它不会报错，症状是导入后每个角色的本档变化静默退回基线
  │              🔴 **这是 AI 唯一写得到的外貌表**（D60，v1.3）：没有基线的角色，
  │                 AI 即兴出来的那份也落这里（差量基准全空），**不再**去建全局基线
  │   ├── v20+: contentPacks（内容包安装持久化，D18）—— payload 是整包，**不进 FullBackup**
  │   ├── v21+: mapBlobs（地图图源字节本地缓存，D23 补强）—— 字节同样**不进 FullBackup**
  │   ├── v22+: snapshotPayloads（快照拆表）——`snapshots` 只留元数据
  │              （id/saveId/createdAt/reason/turn + 展示缩略 `preview`），整档载荷
  │              （characters/saveProfile/plotEvents/**messages**）搬进这张表，`id` 与元数据行同值。
  │              🔴 拆的理由是**读放大**：列快照与淘汰旧快照每回合都跑，却只用得上
  │                 turn/createdAt —— 拆表前每回合要在主线程反序列化约 30 份整档对话历史。
  │                 故 `getSnapshots` / `trimSnapshots` **一行都不许读载荷表**
  │                 （database.test.ts 有间谍钉着这条），整份快照只有 `getSnapshot(id)` 会 join。
  │              🔴 元数据在、载荷行不在 = 半条快照 → `getSnapshot` **直接抛**：
  │                 默默返回一份没有 characters 的快照，恢复会把存档洗空。
  │              🔴 两种备份的导入侧都必须吃**旧格式**（v21 及以前整份内嵌、无
  │                 `snapshotPayloads` 字段）：归一化在 `normalizeSnapshotBackupRows`，
  │                 判据是载荷字段在不在、**不是版本号**。
  │              🔴 `preview` 不是第二个真源，只喂快照面板那一行字（主角 HP / 游戏内日期）；
  │                 任何逻辑一律读载荷。旧行缺席 = 那一行不显示，v22 升版时从载荷回填
  │   └── v23+: apiRateLimitPolicies（全局 API RPM 策略）——按
  │              `SHA-256(归一化 baseUrl + API Key)` 指纹存上限，不落明文密钥；进 FullBackup
  │       🔴 **世界书、美化规则与 API Key 现居应用 Dexie，不再在 localStorage**。正则 iframe
  │          只能经同步镜像访问 `regexStorage`，不能访问任何应用表；应用 localStorage 只存无密钥
  │          设置元数据（Agent 配置/主题/`beautifierBuiltinDisabled` 等）
  │
  ├── session-backup.ts             ← 单存档导出/导入：每存档表整取（清单同 deleteSaveSlot，字节不随行）+ 内容依赖清单（世界书 token / 工坊项目 / 内容包 / story 预设，导入前只读体检）+ 导入**一律重发 id**（不重发 = 第二次导入静默覆盖第一次），全局表一行不改
  │
  ├── api-rpm-limiter.ts            ← [ADR-34] 应用级凭据桶：默认不限；达到上限后的请求按 FIFO
  │                                    暂停整 60 秒，发布等待快照后自动续发；网络 timeout 从放行后才计
  ├── agent-client.ts               ← [Phase 3] API 客户端（每 Agent 独立 userId / 重试退避 / 缓存检测 / RPM 许可）
  ├── agent-templates.ts            ← [Phase 3+9] Prompt 模板（systemPrompt 已迁 agent-config.json，留 stub + 动态上下文）
  ├── prompt-session-assembler.ts   ← [Delta 会话 v1 / 2026-08-23] 主 DAG 普通 chat/chatStream 的 delta session 深模块：
  │      独占 `(saveId, agentId)` 的 transcript / baselineSignature / revision / 投影 diff 起点，只开
  │      prepare/complete/invalidate 三入口；首轮完整渲染 baseline，后续复用 wire transcript 只追加
  │      `context_delta + turn_context + tailPrompt` 增量；**不写 Dexie**（内存态随刷新冷建基线）。
  │      embedding / tools / combat / 侧链 / regenerate 走原路径（handle===null 或 skipSession）。
  │      设计：docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md
  ├── prompt-state-projection.ts    ← [Delta 会话 v1] 读取型、幂等投影 + 纯 diff（prompt-session-assembler 的基座）：
  │      封闭 scope 联合（14 个）、数据面 `set/upsert/remove` + `rebase` 控制信号、按逻辑名字归一化 +
  │      规范化内容深比较、固定排序字节稳定，序列化进 `<context_delta>` 外壳。**无 I/O、无全局状态**。
  ├── agent-config.json             ← [Phase 9] 10+ Agent 完整 systemPrompt 唯一来源
  │      （🔴 实际文件在 `public/data/defaults/agent-config.json`，不在本目录；
  │        磁盘路径带 `public/`，运行时 URL 仍是 `/data/defaults/agent-config.json`）
  │      🔴 **story 是这条「唯一来源」的例外**：`buildAgentMessages(story)` 先跑
  │         `assemblePresetContent`，拿到内容就直接用、**根本不看 systemPrompt**，
  │         只有「用户一个预设都没有」时才回退 `STORY_TEMPLATE.fixedSystem + fixedExamples`。
  │         于是往 `agents.story.systemPrompt` 里写字有两种结果、没有一种是想要的：
  │         有预设时（常态）永远不生效；没预设时**顶掉整份** fixedSystem+fixedExamples ——
  │         一句话换掉全游戏最要紧的提示词。**story 的行为真源是预设条目**
  │         （图像 v1 那句 `<scene_image>` 指令就落在预设条目里，不在 systemPrompt）。
  │         挑条目还有第二个坑：`assemblePresetContent` 按**条目自身的 `enabled`** 过滤、
  │         **不读 `prompt_order`** —— 现行预设 101 条里只有 32 条真的进提示词，
  │         写进一条没启用的条目 = 写进空气
  │      🔴 **`image_prompt.systemPrompt` 已退役**（图像 v2 / C5，字段已从本文件删除）：
  │         那段提示词随方言走，真源是 `public/data/content/image-dialects.json`（内容注册表
  │         第 7 面，pack 可整份替换），用户改动存 `imageDialectOverrides[dialectId]`。
  │         留在这里就是 D53 点名的第三份拷贝 —— 换条方言它不跟着换，用户改完看着生效、
  │         切回来又变回去。该 agent 的 model / 温度 / 世界书旋钮**不动**，仍在本文件
  │      🔴 本文件现存 47 个 U+FFFD 替换字符（16 段 / 6 个 agent），其中一处落在闭合 XML
  │         标签的标签名里（形如 `</□有物品>`，模型看到的是坏标签）。**既有问题，
  │         图像 v1 未修**，已另开任务；改这个文件时别顺手把它们当成自己弄坏的
  ├── agent-tools.ts                ← [Phase 8.5] Agentic 工具注册表（**27 个 tool 定义**）+ AGENT_TOOL_MAP
  │      白名单 5 桶：craft_gen(9) / char_gen(12) / item_gen(3) / vars_update(3) / combat_v3(12)
  │      🪦 v2 的 `['combat']` 桶随 M5 删除；`get_hp_percent` 定义还在、但**不在任何桶里**
  │         （combat_v3 的文本面板自带 HP%）—— 定义数 27 与「AI 真够得到的」26 差的就是它
  ├── agent-xml.ts                  ← [Q-05] AI 输出 XML 解析的**唯一**工具面：`tagInner`（取内文，trim）/
  │                                    `tagBlock`（取含标签整块），参数顺序永远 `(source, tag)`
  │      🔴 不再有叫 `extractTag` 的东西 —— 曾有两个同名反义实现（一个取 `match[1]`、一个取
  │         `match[0]`），签名都是 `(string, string)`，连定义带调用抄过去**编译照过**，
  │         运行时把整块 XML 当字段值写进角色档案
  ├── model-json.ts                 ← [Q-05] 从模型输出里抢救 JSON 的**唯一**入口（整段直解 / ```json 围栏 /
  │                                    `<json>` 标签 / 括号切片，顺序即优先级）。剥壳只此一份，兜底由调用方
  │                                    传 `normalize` 回调 —— 形态上就长不出「两个分支两套兜底」
  ├── story-output.ts               ← Story 信封投影：`<maintext>`/`<options>` 等结构化外壳 → 玩家可见正文 +
  │                                    行动选项；流式与完成后共用这一条缝（流式期多剥一组控制标签）
  ├── agent-orchestrator.ts         ← [Phase 3+8.5] DAG 编排引擎（阶段串行+同阶段并行/M3 翻译层按名寻址零id单patch）
  │   ├── callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │   └── Marker 回调: onCraftRequest/onCombatTrigger/onCharGenRequest/onPlayAudio
  │       🔴 [并行化 2026-08-16] 侧链（char_gen/item_gen/craft_gen）启动**不 await**，
  │          与 vars_update LLM 并行；收尾三点：vars_update 提交前的回合级 barrier /
  │          combat 分支显式等 charGenPromise / run() 末尾与失败路径统一 await。
  │          per-agent 依赖：`PipelineStage.agentWaitFor[agentId]`（缺省回退 stage.waitFor），
  │          依赖失败的 agent 只跳过自己、不连坐同 stage 其他 agent
  ├── story-rescue.ts               ← Story 正文救援（正文吞思维链 / 思维链泄漏正文 AI 缺陷兜底）
  ├── random-tables.ts              ← [Phase 8.5] NPC 生成随机表
  │
  ├── field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化（铁律5）
├── tier-constants.ts / bloodlines.ts / validate.ts / char-query.ts
├── resource-calc.ts / var-resolver.ts / namespace-normalizer.ts / time-system.ts
├── exp-table.ts                  ← 🆕 [经验系统 v2 2026-08-24] 累计经验表（LEVEL_XP_TABLE，照参考脚本）
│                                     + Code 接管升级（resolveLevelUps）+ 登神长阶放宽版（resolveAscensionFlyup）
│                                     + 战斗经验系数按档（EXPERIENCE_COEFFICIENTS normal/easy）
│                                     + 旧档归一化（applyExpFloor 幂等只提升）。char-gen / resource-calc /
│                                     tier-constants / combat-v3 coordinator 的等级经验逻辑统一委托此处
│
  ├── save-profile.ts               ← [Phase 4.6] 存档级 FP 元货币（M5: +variables 变量唯一真源）
  ├── effect-parser.ts / effect-runtime.ts
  ├── ejs-backend.ts                ← [能力面 T1] EjsBackend 接口 + LegacyBackend + 生产切换入口
  ├── ejs-quickjs-backend.ts        ← [能力面 T7] ★ QuickJS(wasm,主线程) 隔离后端 —— SEC-02 的边界
  │                                    实测：构造器逃逸/死循环/ReDoS/OOM 四条全部堵住
  ├── ejs-capabilities.ts           ← [能力面 T4/T5] chat/char/world/quest/lore/local/ui/engine
  ├── ejs-fmt.ts                    ← [能力面 T5] fmt.yaml/table/num/bar + 不依赖 locale 的 compareName
  ├── ejs-rng.ts                    ← [能力面 T2] 种子随机（快照重放可复现）
  ├── ejs-preflight.ts              ← [能力面 T8] 装前预检（纯函数，不阻断安装）
  ├── ejs-runtime.ts                ← [工坊 P2] 整片编译（全条目 token 编进同一函数体，跨块 if/for 成立）
  │                                    compileEjsEntry / executeEjsEntry；两轴注入 + 失败回滚
  ├── ejs-lodash-shim.ts            ← [工坊 P2] `_` 纯读边 17 方法 + chain（不含任何写方法）
  ├── stat-projection.ts            ← [工坊 P2] buildStatData：主角资源/等级/五维/命运点数/世界.时间（只读快照）
  ├── ejs-vars-diff.ts              ← [工坊 P2] 草稿深 diff → {replace,remove} 喂 applyVarsPatch；256KB 护栏
  ├── game-event.ts                 ← [Phase 4.5] EventBus 按存档隔离（+ emitChain 链式管道 ADR-29）
  ├── state-write-queue.ts          ← 🆕 [并行化 2026-08-16] 写入串行队列地基：withSaveWriteLock
  │                                    （per-saveId FIFO）+ withGlobalWriteLock（记忆 id 分配+落库）。
  │                                    🔴 锁粒度 = RMW 区段，锁内**禁止**调用任何会再入队列的函数
  │                                    （reactToEvents / applyTimeAdvance 尾部自提交一律移锁外，
  │                                    否则同 saveId 自等死锁）。LLM 调用无副作用可并行；
  │                                    一切 Dexie 写入必须经此串行。收编点：commitChatState /
  │                                    applyTimeAdvance / confirmRandomEventTrigger / sync* /
  │                                    advanceTurn / createSnapshot / restoreSnapshot
  ├── state-manager.ts              ← 唯一状态写入入口（M2按名寻址 M4名字唯一化 M5变量迁profile+快照重建）
  │      🗃 **提交级缓存 `CommitScope`**（2026-08-17，本文件已 2664 行）：读收到入口、写收到出口 ——
  │         一次 `commitChatState` 至多 1 读 1 写 profile + 1 读 1 次 `bulkPut` characters。
  │         此前每个补丁各跑一趟完整读-改-写（10 个变量补丁 = 20 次 `getProfile` + 10 次 `updateProfile`）
  │      🔴 **缓存边界只有 SaveProfile + 本存档 characters 两样**。别的表（memories / plotEvents /
  │         saves / snapshots）照旧直读直写；作用域外的入口（快照 / 时间推进 / 三条 sync 钩子）
  │         自动退化成直读 Dexie —— 同一个 handler 两种上下文下都对，调用点不必知道自己在不在提交里
  │      🔴 **读失败不缓存**（`profileLoaded` 是布尔而不是 `profile !== undefined`）：EJS 差量那步
  │         读炸之后，后面的 AI 补丁仍要能自己再读一次。flush 则**无条件发生**（哪怕有补丁失败，
  │         先成功的那些也得落库）
  │      🔴 缓存把 `commitChatState` 的写窗口拉成「整次提交一拍」，于是 P1-09 那两个 UI 例外写入口
  │         （`save-profile.ts` 的 `persistFocusQuest` / `persistNewsRead`）**必须两件事都做**：
  │         ①进 `withSaveWriteLock` 与提交串行（不进队列会被出口那次整档 flush 盖掉）；
  │         ②**锁内重读一份新鲜 profile、只改那一个字段**（拿 UI 手里那份陈旧整档进锁写回去，
  │         照样把提交刚落的 fp/任务/变量抹回旧值）。锁解决交错，解决不了陈旧 —— 缺一条都不算修好。
  │         缓存之前每个补丁各自重读一次库，UI 的写被顺带吸收了 —— 那是**巧合**不是设计
  ├── attribute-allocation.ts       ← 自由属性点分配的引擎侧唯一入口（校验上限查 `getTierConfig`，
  │                                    落库走 `commitChatState`）。🔴 补丁只写 attributes + freeAttrPoints，
  │                                    **绝不碰 level/tier** —— 那两个字段的差值正是自动加点钩子的判据
  ├── quality-inference.ts          ← [Q-11] 由属性加成总和推断品质（**封顶在传说是刻意的**）。
  │                                    此前逐字重复住在 ItemsPanel.vue / CharacterListPanel.vue 两处，
  │                                    分叉的表现只是「同一件装备两个面板显示不同品质」，不会有东西失败
  ├── vars-update-translator.ts     ← [Q-19] AI JSON → `StatePatch[]` 的**纯翻译层**（无 I/O，import 只有类型）。
  │                                    从 `agent-orchestrator.processStageMarkers`（那时 1327 行）里剥出来的
  │                                    纯映射；不违反 ADR-21 —— `commitChatState` 仍是唯一写入口
  ├── dice.ts / memory-store.ts / memory-summarizer.ts / plot-outline.ts / plot-engine.ts / location-db.ts
  ├── index.ts                      ← barrel（Q-04/Q-12 清仓后只 re-export 活着的模块）
  │
  │  ── 提示装配 / 上下文 ──
  ├── placeholder-registry.ts       ← [Phase 10] `{{PLACEHOLDER}}` → 解析函数注册表（31 个，2026-08-18 实数；
  │                                    文件头注释写 18 是旧的）+ 每 Agent 默认模板。
  │                                    地图 `{{MAP_CONTEXT}}` 与 `{{RANDOM_EVENTS}}` 的**中文措辞都在这里**
  │                                    （数据面是纯函数模块，措辞在 resolver —— 那两个子系统零中文字面量的原因）
  ├── template-resolver.ts          ← [Phase 10a] 模板解析：localParams（链上覆盖）→ 注册表 → 认不出的原样留着
  ├── preset-loader.ts              ← [Phase 8+10] ST 预设加载 + 占位符宏预处理（setvar/getvar/random/roll/注释）；
  │                                    EJS `<%…%>` **原样保留**交给 ejs-runtime
  ├── worldbook-loader.ts           ← [Phase 8] 世界书加载/激活/排序/渲染（constant + keyword 双层激活），
  │                                    条目正文经 `executeEjsEntry` 求值（ADR-30）
  ├── builtin-worldbooks.ts         ← [Phase 8] 内置世界书运行期 fetch 预加载（刻意不用 `import.meta.glob` eager
  │                                    —— 那会把旧数据打进构建产物，且 HMR 变全页刷新）
  ├── context-visibility.ts         ← [Phase 8] Agent × Zone 可见性矩阵（**设计时决策，不是运行时配置**）+
  │                                    buildZoneContext / filterZoneContent（FULL/NARRATIVE/SUMMARY/KEYS/NONE 五级）
  ├── beautifier.ts                 ← [Phase 7e+10i] 输出美化正则管道（纯函数，编译失败静默跳过不阻断）。
  │                                    执行边界在 UI 那个网络可用的 opaque iframe，不在本层
  │
  ├── types-map.ts                  ← [地图 v1 / ADR-31] 地图类型分册（MapPack/MapTile/MapSaveFlags/MapRoute）
  ├── map-pack.ts                   ← [地图 v1] coerceMapPack 容错解析（永不抛，坏包回退 EMPTY_MAP_PACK）
  ├── map-index.ts                  ← [地图 v1] 索引 + resolveTileByLocation（落位契约五条 + 锚地块 + 8 向罗盘）
  ├── map-path.ts                   ← [地图 v1] 混合通行图 Dijkstra（陆海同图按边计价 + via/avoid，逐边时间累积）
  ├── map-weather.ts                ← [地图 v1] 确定性天气采样（种子随机，词汇随包，零存储）
  ├── map-context.ts                ← [地图 v1] $map 结构快照 + uid 446 runtime_geo 投影（只产数据不产中文 prose）
  ├── map-runtime.ts                ← [地图 v1] 注入缝（installMapPack/getMapIndex；content-store 第 8 面点火）
  │      🔴 **map-*.ts 禁任何中文字面量**（`map-literals-gate.test.ts` 结构闸门；同款的还有
  │         `random-event-literals-gate.test.ts`，见下面随机事件一节）——随图数据全在
  │         pack 里、中文渲染在 placeholder-registry（dispatcher）与内容仓世界书条目（story），
  │         这是 ADR-31「换图零改码」的机器保证。落位/天气/旅程接线在 state-manager
  │         （applySetLocation 仅玩家 / applyTimeAdvance 跨天重断言 / packStamp=contentHash 自愈），
  │         设计与 14 条裁定见 docs/planning/2026-08-11-map-system-v1-integration.md
  │
  ├── types-random-events.ts        ← [随机事件 v1 / ADR-32] 类型分册（事件定义 / 条件 DSL / 权重链 / 槽位表 /
  │                                    `RandomEventSaveFlags` = `worldFlags.randomEvents` 的形状 / 只读快照）。
  │                                    照 types-map / types-image 的规矩**不 import types.ts**，边不成环。
  │                                    唯一的例外导出是 `DEFAULT_RANDOM_EVENT_CONFIG`（三个数字的兜底常量）
  ├── random-event-pack.ts          ← [随机事件 v1] `coerceRandomEventPack` 容错解析（内容包第 13 分节 `randomEvents`）
  │                                    🔴 **永不抛**：坏定义整条跳过 / 坏子项逐条丢 / 坏旋钮只回落那一格 /
  │                                       整份认不出（含**数组**）→ 空包。空包是合同不是异常（引擎仓零内置事件）
  ├── random-event-scheduler.ts     ← [随机事件 v1] ★确定性调度核（954 行，纯函数）：MTTH 逐天掷骰 `rollRandomEvents` /
  │                                    首访强制入池 `armFirstVisitEvent` / 池子保洁 `pruneRandomEvents` /
  │                                    触发结算 `settleRandomEventTrigger` + 条件求值与权重链两个共用判据
  │                                    🔴 **零存储、零时钟、零 `Math.random`**：种子 = `(saveSeed, 事件名, gameDay)`，
  │                                       随机数复用 `createEjsRng` —— 快照回退/重发天然一致。测试里有结构闸门扫源码
  │                                    🔴 **改入参就是错**：四个入口一律「无变化返回 `null`」，有变化返回全新 flags
  ├── random-event-snapshot.ts      ← [随机事件 v1] 条件求值只读快照的**全仓唯一一份**（地点键解析 + RollContext 组装）。
  │                                    写侧（state-manager 入池）与读侧（game-pipeline 注入）此前各抄一份，
  │                                    靠注释维持一致 —— 漂了不报错，症状是首访条目在注入面静默消失
  ├── random-event-context.ts       ← [随机事件 v1] 注入块的**数据面**：候选池过滤+排序成快照。**一个字的措辞都不在这里**
  │                                    （`<random_events>` 外壳 / `[!]` 首访标记 / 「至多触发一个」全在 resolver）。
  │                                    过滤判据整份委托 `isPendingStillValid`，与保洁共用同一份
  ├── random-event-runtime.ts       ← [随机事件 v1] 注入缝（`installRandomEventPack` / `getRandomEventPack`），
  │                                    理由逐字同 map-runtime。**刻意没有索引缓存**：事件是几十条量级，
  │                                    加一层缓存只多出「什么时候失效」这个得有人记得维护的问题
  │      🔴 `random-event-*.ts` 同样**禁中文字面量**（`random-event-literals-gate.test.ts`，与
  │         `map-literals-gate.test.ts` 同款结构闸门）—— 事件名/简报/槽位词全是包数据。
  │         唯一例外是 `{{place}}` 这个 ASCII 占位符，它是**协议**不是内容。
  │         接线在 state-manager（逐天掷骰 / 首访 / `confirmRandomEventTrigger` 按名结算），
  │         注入在 `{{RANDOM_EVENTS}}` resolver（池空/关闭/**战斗会话活跃**时返空串零 token）
  │
  ├── content-registry-runtime.ts   ← 🆕 [分层收口 2026-08-17] 内容注册表的注入缝
  │      installContentRegistry / getContentRegistry / createEmptyContentRegistry /
  │      resetContentRegistryRuntime + `ContentRegistry` 类型（十面）本身
  │      🔴 **注册表只有一份存储，就在这里**：content-store 的 `getContentRegistry()` 现在只是转发，
  │         那边的模块级 `let registry` 已删。与 mapPack/randomEvents 两面刻意不同 ——
  │         那两条缝装的是 `coerce*` 之后的**派生值**（两份不是同一个东西），
  │         注册表本体两处各存一份就能各说各话，症状是「装完包了，引擎那边的目录还是旧的」
  │      🔴 时序契约：读取一律**惰性、按调用时刻**发生；消费方（agent-tools 品牌面 /
  │         random-tables 名字池 / bloodlines 血脉集 / location-db 地点集）**不许**把读数
  │         缓存成模块级常量。没装过 → 十面全 undefined 的空骨架（不是 null、不抛）
  │      🔴 **「面」与「分节」是两套编号，别互相换算**（读到 `第 N 面` / `第 N 分节` 先看是哪套）：
  │         · **面** = `ContentRegistry` 的字段，**共 10 个**，声明序 catalog / locations / bloodlines /
  │           namePools / markers / branding / imageDialects(7) / mapPack(8) / randomEvents(9) / remoteAssets(10)
  │         · **分节** = `ContentPack` 的可选字段（`types-content.ts`），**共 14 个**，多出
  │           agentDefaults / presets / beautifierRules / mapMarkers 这几个不进注册表的域；
  │           `imageDialects` 在这里是第 11 分节、`mapPack` 第 12、`randomEvents` **第 13**、`remoteAssets` **第 14**
  │         🪦 `types-content.ts` 里那两句「注册表**第 13/14 面**」是**串号写法**（数的是分节序）。
  │            本文件按上表口径：那两样是第 9 / 第 10 **面**，第 13 / 第 14 **分节**
  │
  ├── types-content.ts              ← [内容分离 波1] 内容包子系统的纯类型分册（pack 载荷 / 14 分节 / 安装计划 /
  │                                    校验记录 / 四态基线）。落库实体仍住 types.ts，本册只 type-only import 它们
  ├── content-source.ts             ← [内容分离 波1] ContentProvider 的引擎半边（纯同步）：`validatePackOrThrow` /
  │                                    `hashContentDeterministic` / `hashWorldBook` / `resolveSection`（三态语义）
  ├── content-pack-plan.ts          ← [内容分离 波1] ★安装/升级/卸载的纯函数 planner（四态判定 + 存档 uid 迁移三段式）
  │      🔴 **本文件与 content-source 互相 import，是一条真实的运行时环**（如实记录，别按旧注释
  │         理解成单向）。目前无害**只因为两侧的使用点全在函数体内** —— ESM 环下模块初始化期取到的是
  │         undefined，所以**任一侧都不许在模块顶层（含字段初始值/顶层常量表达式）使用对方的导出**
  │      纯度约束同 workshop-install-plan / asset-import-plan：无 I/O、无 Dexie、无 Vue、
  │      **无 `crypto.subtle`**（异步会把 planner 传染成 async，所以逐书基线用同步 hash 不用 SHA-256）
  ├── remote-asset-catalogue.ts     ← 🆕 [远程素材 v1] 远程素材**声明**的纯函数解析层：两种本地载体
  │                                    （世界书 char-info 那段 `profile` 字面量 / 内容包第 14 分节 `remoteAssets`）
  │                                    各自归一成 `RemoteAssetDecl`，**到此为止** —— 下载/落库/镜像同步全在 UI 波
  │      🔴 **永不抛**（两个来源都是第三方可编辑数据）：认不出的块跳过、认不出的行跳过，
  │         返回值永远是合法数组。一个写坏了的角色卡不该让另外十四个角色没有立绘
  │      🔴 名字与变体走既有闸门（`asset-filename.ts` 的 `violatesNamingInvariant` /
  │         `violatesZipEntryName`），不另立一套 —— 远程素材最终落成**普通素材行**，
  │         这里放进一个 `圣殿/内庭`，症状会推迟到半年后某次「导出再导入之后少了几张图」
  │
  ├── engine-settings.ts            ← [Q-06] 引擎侧读设置的**唯一入口**（注入缝）。裁定：真源在前端
  │                                    localStorage，引擎经本缝读，**不是**搬进 Dexie —— 引擎要的是
  │                                    「当前生效的设置」这个能力，不是「某张表」这个位置；缝也让引擎在
  │                                    无 UI 的场合（测试 / 未来 headless 跑批）自带可用缺省
  │      🪦 收口前 Dexie `settings` 表是一份**影子配置**（`initializeDatabase` 播种后再没人写全），
  │         两侧靠 `game-pipeline.syncSnapshotSettings` 那座只搬两个字段、`catch { console.warn }`
  │         静默失败的桥连着 —— 症状是「设置页明明改了、引擎行为没变」，桥断了用户完全无感
  │
  │  🚧 **四条注入缝 = 引擎读前端的唯一合法途径**（engine-settings / map-runtime /
  │     random-event-runtime / content-registry-runtime）。`src/sillytavern/**` 里
  │     **禁止**出现任何 `../ui/*` `@ui/*` `vue` `pinia` 的 import —— 收口前有 6 条这样的反向边，
  │     全都编译得过、跑得通、测试全绿，代价是引擎拖着整条前端链。两道机器闸门钉死：
  │     `eslint.config.js` 的 `no-restricted-imports`（静态边，含 type-only）+
  │     `tests/layering-gate.test.ts`（源码扫描，专治动态 import / 字符串路径 / import.meta.glob）。
  │     `?raw` 源码读取不算依赖边（供值链路测试要它）。要在引擎里用前端的东西：搬进引擎，或开一条新缝
  │
  ├── combat-intention.ts / combat-damage.ts / combat-turn.ts
  │   └── (以上为 v2 战斗纯计算函数，v3 内核仍调用；v2 编排层 combat-runner/combat-pipeline 由 M5 删除)
  │       🪦 `combat-resolver.ts` 已被 M5 删除（`$combat` API + 8 步伤害管线随 v2 运行时一起退役）。
  │          存活的纯函数（`characterToCombatParticipant` 等）迁到 `combat-v2-types.ts`，
  │          全仓零 import，别按图找那个文件。
  │   └── combat-v3/               ← [战斗 v3] 代码内核主持流程（M0-M5 已合入）
  │       ├── kernel.ts / reducer.ts / state.ts     ← 状态机 + 原子提交 + 5 不变量
  │       ├── dice-tape.ts                          ← 分通道骰带（32/10/7/6/5）
  │       ├── coordinator.ts                        ← 战斗循环 + RequiredInput 路由
  │       ├── windows.ts / intents.ts               ← 18 窗口求值 + EffectIntent 解释执行
  │       ├── adjudication.ts / rule-keys.ts        ← BoundedAdjudication + 4 RuleKey
  │       ├── automata/                             ← DSL parser/interpreter/compile/builtins/reflection
  │       │                                            + index-active.ts（ActiveEffectIndex：按窗口取订阅者）
  │       ├── phases/                               ← 7 个 phase handler：round / initiative / unit-turn /
  │       │                                            action / attack / terminal + outcome.ts（统一返回形状，
  │       │                                            reducer 据此把 changes 累加进单一 PendingChangeSet，
  │       │                                            末尾一次 applyPending 原子提交 —— 不变量④）
  │       ├── player-input.ts                       ← [战斗主持人] 玩家自由文本 → `CombatCommand` 的**确定性**
  │       │                                            解析（关键词 + 名字匹配，零 I/O 零随机）。四步拼装能直接
  │       │                                            定 Command 时走结构化路径，只有自由文本过这里
  │       │      🔴 解析不出意图**明确拒绝**（`ok:false` + 人话 reason），绝不静默 fallback 成 PassAttack
  │       │         —— 那会吞掉玩家的决定（v2 runner「查询工具静默变 pass」在玩家侧的镜像）
  │       │      🔴 名字按「文本中首次出现、同位置取长名」匹配（否则「骷髅兵」误配「骷髅兵队长」）
  │       ├── summon-pool.ts                        ← [M3.5] 预生成召唤物池：**目前是空池 + 幂等查找 + key 归一化**
  │       │                                            （key = `种族-层级-定位`），未命中走实时 char_gen。
  │       │                                            池内容要靠离线脚本填，不在 plan 范围内
  │       ├── types.ts                              ← v3 内部类型（1816 行；DiceChannel/CombatState/EffectIntent/
  │       │                                            WindowKey/DomainEvent 等全在这里）
  │       ├── test-utils.ts                         ← 测试共享构造（最小 2 单位 bundle + 命令）
  │       ├── projection-ui.ts / projection-agent.ts← 双投影（UI 事件 + Agent 文本面板）
  │       ├── replay.ts / contract/ / fixtures/     ← contract harness + 7 场 fixture（JSON 在 fixtures/，
  │       │                                            用例在 contract/，里程碑表在 contract/milestones.ts）
  │       └── index.ts                              ← 唯一公共出口（openCombat / runCombatV3 / parsePlayerInput
  │                                                    + 少数公共类型）；reducer/tape/windows/automata 全 internal
  ├── effect-types.ts               ← [战斗 v2 M2] Modifier 6 大类（固伤/百分比/资源/检定/附加效果/特殊机制）+
  │                                    登神 divinity 仲裁。与 StatusEffect（落库实例）/ EffectDefinition
  │                                    （Agent 声明）是三样东西，别混
  ├── buff-registry.ts              ← [战斗 v2 M2] buff 去重/生命周期/结算时机的**纯函数集**（不持状态不落 DB）。
  │                                    buff id = 有 sourceKey 时 `sourceKey.name`、否则裸 name（铁律：AI 永不产 id）
  ├── status-api.ts                 ← [战斗 v2 M2] 把沙盒收集的 `$status.apply/remove` 意图经 BuffRegistry
  │                                    转成 StatePatch，仍交 `commitChatState` 落库（ADR-21）
  ├── script-registry.ts            ← [战斗 v2 M1] 声明式脚本注册 facade（物品/技能自带的静态清单，装备即注册
  │                                    整份、卸下即全注销）。与 SubscriptionManager（动态 `$event.on`）各走各的
  │                                    注册表（chainHandlers vs handlers），**不是第三套效果系统**
  ├── modifier-collector.ts         ← [战斗 v2 M2] `collect_mods`：用 `emitChain` 收攻/守方 modifier
  │                                    （在场过滤 + priority 排序 + 错误隔离全复用 emitChain 内置能力）
  ├── combat-item-validator.ts      ← [战斗 v2 M4] item_gen 产出的 modifier/buff 契约**纯校验**（空 reasons = 合规）
  │      🔴 **`V3_WINDOW_KEYS_LIVE`(12) / `V3_WINDOW_KEYS_RESERVED`(6) / `V3_WINDOW_KEYS`(18) 住在这里，
  │         不在 `combat-v3/`** —— `combat-v3/automata/compile.ts` 反过来 import 它们。
  │         下文「18 窗口只有 12 个真接了求值器」那条讲的就是这两张表；接上求值器 = 把 key 从
  │         RESERVED 挪进 LIVE。判据是「`phases/` 或 `reducer.ts` 里有 `runWindow(...)` 调用点」，
  │         **不是「架构文档列了它」**
  ├── describe-modifier.ts / describe-automaton.ts
  │                                  ← Modifier / EffectAutomatonDecl → 人类可读中文摘要（纯函数，
  │                                    前端物品详情弹窗用；18 窗口的中文名表在 describe-automaton）
  ├── craft-quality.ts / craft-dc.ts / craft-resolver.ts
  │   ├── craft-request.ts        ← [Q-21] 装配唯一口 buildCraftRequest(角色, 工具参数, 骰带)
  │   │                              🔴 **纯函数、无随机** —— 骰子由工具边界掷好传进来
  │   │                              （agent-tools.takeCraftTape）。此前两个工具各装配一遍
  │   │                              且都写 `d20Rolls: []`，`rollCraftDice` 兜底成
  │   │                              `d20Rolls[0] ?? 10` → **生产每一次制作检定都是 d20=10**，
  │   │                              连带大失败不可达（判据要 length===1，而 length 是 0）、
  │   │                              优/劣势整条死规则（要 length>=2）。与 Q-01 同形状，
  │   │                              但 Q-01 只覆盖了 combat-v3 的 coordinator。
  │   │                              check 的骰带按**请求指纹**存 ToolExecutionContext.craftDice，
  │   │                              同参数的 settle 取走 —— AI 只见结果不碰骰值，且刷检定无效。
  │   │                              🔴 骰数由优/劣势决定（齐平 1 颗 / 优劣势 2 颗），
  │   │                                 **不能**一律掷 2 颗，那会把大失败判据换个姿势再打掉一次
  │   └── craft-projection.ts     ← [Q-21] 结算结果 → `<action_info>` 竖线表 + 一句话摘要
  │                                  照 combat-v3 projection-agent/projection-ui 的先例；
  │                                  这一层不允许出现计算（ADR-28：面板是给纯文本 AI 的遗留手段）
  ├── morale-system.ts / affection-system.ts
  ├── start-catalog.ts              ← [Q-30] 捏人目录入口（re-export 机制 + 属性名/品质码表/品质色/品质基础 DC）
  │   └── start-catalog-mechanics.ts ← [D24] 机制半边：schema/类型 + 难度档位/性别枚举/限定覆盖表
  │                                     + 纯函数（parseCatalogData 容错解析 / lookupCost 查表 /
  │                                     flattenLocationTree / classifyBackground）
  │       🪦 `start-catalog-data.ts`（8704 行）已删。七个池（装备/物品/技能、背景、命定核心、
  │          种族/身份点数表、起始地树）住在 `public/data/content/catalog.json`，经内容注册表
  │          （content-store 的 `catalog` 面）供给、pack 可整份替换。
  │          🔴 **不许往机制文件里加任何一条具体条目** —— `start-catalog-mechanics.test.ts`
  │             有一条结构闸门专门盯这件事（导出名黑名单）。
  ├── marker-protocol.ts            ← [Phase 6e+Audio+图像 v1] XML 标记检测（含 <play_audio> / <scene_image>）
  │                                    + sanitizeCaption（标题/说明的收敛器）
  │                                    🔴 加标记**只动 MARKER_SPECS**（Q-05）：扫描器、MARKER_TAGS、
  │                                       scanMarkers 全由那张表推导，别去手改它们
  │                                    🔴 标记正文那句中文**不过 normalizeTagString** —— 全角标点在中文
  │                                       句子里是对的，归一化会把它改坏
  │                                    🔴 title 畸形（含引号/超长/缺省）**只收敛不拒绝**：为一次装饰性
  │                                       失误否掉整个标记，等于把它升级成一张画不出来的图
  ├── char-gen-agent.ts             ← [Phase 6e] 角色生成编排（M3 单patch落库/正式字段直写/零id）
  ├── craft-gen-chain.ts            ← [Phase 9b] 制作生成编排（M3 零id/type归一化/单patch）
  ├── item-gen-chain.ts             ← [Phase 9c] 独立物品/技能生成编排（上游是 dispatcher 的 `<item_gen_request>`）
  │                                    🔴 装备落库**两步同 id**：`add_item`（进背包）+ `equip_item`（搬进装备栏）
  │                                    —— applyEquipItem 按 itemId 从背包移除，两步 id 不同就静默丢件
  │
  ├── script-executor.ts            ← [Phase 7e+8] 脚本沙盒（$event.on/off / $call / @parent / init·cleanup）
  │      🔴 **求值跑在 QuickJS 隔离里，不再是 `new Function`**（2026-08-10 / SEC-02 收口）。
  │         `buildSandbox()` 仍是 $ API 名单的**唯一真源** —— guest 面由后端从它推导，
  │         加 `$foo` 不必动后端；宿主闭包一行没改，所以 `_parentScripts` 盖章 /
  │         `$call` 合并 / handle 编号全在宿主侧原样发生（这是兼容性的来源）
  │      🔴 **测试必须 `await installProductionScriptBackend()`**（`beforeAll`）。默认后端是
  │         fail-closed：不装就是**脚本一行不跑**，而「断言收集到 0 条效果」那类用例会照常变绿。
  │         已装的四个文件：script-executor / script-quickjs-backend / subscription-manager /
  │         effect-wiring / state-manager（后者有两组用例真的会执行 onRemove 与反应轮脚本）
  ├── script-backend.ts             ← [SEC-02] 脚本后端接缝：ScriptBackend 接口 + FailClosed + 单例 +
  │                                    installProductionScriptBackend()（预热真 wasm 才算成功）
  │      🔴 与 `ejs-backend.ts` **刻意不同：没有 Legacy**。脚本执行面就是 SEC-02 本身，
  │         留一个可安装的 `new Function` 实现等于把刚拆掉的枪放回抽屉。`setScriptBackend`
  │         同理不导出 —— 公开的「换掉当前后端」入口会把 fail-closed 默认值变成建议
  ├── script-quickjs-backend.ts     ← [SEC-02] ★脚本的 QuickJS(wasm) 隔离后端。**一次脚本一个
  │                                    runtime+context**（脚本之间零泄漏 + `$call` 重入无干扰），
  │                                    墙钟 50ms、内存 32MB
  │      实测：构造器逃逸只拿到 guest 全局（宿主哨兵不可见）/ fetch·indexedDB·process 全不可达 /
  │      `while(true)` 53ms 被中断且不毒化后端 / 每次执行约 0.47ms
  │      🔴 宿主全局仍**显式遮蔽成 `undefined`**（不是让它 ReferenceError）—— 保真旧实现的
  │         形参遮蔽，`if (window)` 这种防御性写法（AI 爱写）不能因此整个脚本中断。
  │         但 `Function` / `globalThis` / `eval` **刻意不遮蔽**：在 realm 里它们够不到宿主，
  │         留着反而更兼容
  ├── subscription-manager.ts       ← [Phase 7e+8] 持久订阅管理器（递归保护≤10 + 僵尸兜底）
  ├── effect-wiring.ts              ← [Q-07] 战斗外效果接线（存档加载 wireEffectSystem / 装备卸下 wire-unwireObject）
  │                                    EventBus 按存档实例化 + ScriptRegistry/SubscriptionManager 双 facade
  │
  ├── audio-channels.ts             ← [Audio] MusicChannel 音序器 + SfxChannel 声池（加载世代号竞态保护）
  ├── audio-manager.ts              ← [Audio] 音轨库注册表 + 主音量 + 手势解锁 + playByTag AI 钩子
  ├── audio-names.ts                ← [Audio] 按名寻址纯函数（normalizeAudioName / findByName 稳定取最早）
  ├── audio-tags.ts / audio-scene.ts ← [Audio] 四维标签 + 场景选曲（七段路径逐级回退+四维加权打分）
  ├── types-audio.ts                ← [Audio] 注入缝接口 + state/options（数据模型类型仍在 types.ts）
  ├── audio-fakes.ts                ← [Audio] 全部注入 seam 的测试替身（vitest environment 是 node：
  │                                    没有 AudioContext / Audio / URL.createObjectURL）
  │
  ├── asset-types.ts                ← [素材] categoryForType / allowsVideo / ASSET_MIME_BY_EXTENSION
  ├── asset-filename.ts             ← [素材] `<name>[_<type>][_<variant>].<ext>` 解析/格式化（命名不变式）
  ├── asset-path.ts                 ← [素材 / Q-16] normalizeSlashes / basenameOf / 扩展名归一化的**唯一实现**
  │                                    （引擎导入计划与 UI 侧 zip 往返曾各存一份逐字相同的拷贝）
  │                                    🔴 已经咬过一次：`"苏婉_头像.png "` 的字面扩展名是 `"png "`，
  │                                       zip 侧比引擎侧更严 → 整条被当噪音丢掉，症状是「导入了但库里查不到」
  ├── asset-index.ts                ← [素材] buildAssetIndex(rows) → 大类→名字→类型→{base,variants}
  ├── asset-resolve.ts              ← [素材] resolveAsset + 两条相反回退链（立牌链 / 脸位链）
  ├── asset-import-plan.ts          ← [素材] ★ planImport 纯同步出计划（撞号进 variant / 哈希去重 / manifest 只补元数据）
  ├── media-hash.ts                 ← [素材] SHA-256 全项目唯一实现（不可用返 undefined，**绝不换算法**）
  │      2026-08-17 从 `src/ui/lib/media-hash.ts` 迁来（分层收口）：消费方横跨两层
  │      （引擎的 content-source 算 pack 分节 hash + 前端四处写入路径），住前端就只能反向 import。
  │      前端那个路径留了转发壳，asset-zip / asset-store / audio-store / scene-image-seams 的 import 一字未改
  │
  ├── workshop-types.ts             ← [工坊 P1] WorkshopProject / 载荷与安装计划类型 + 常量
  ├── workshop-manifest.ts          ← [工坊 P1] ★纯函数：上游 JSON → 内部形状（容忍字段增删，丢弃项记 droppedNotes）
  ├── workshop-regex-map.ts         ← [工坊 P1] ★纯函数：ST 正则 → BeautifierRule（裸 pattern 与 /p/flags 两形态都吃）
  ├── workshop-install-plan.ts      ← [工坊 P1] ★纯同步 planInstall：uid 分区内重新发号 / 条目转换 / 按名匹配更新 / 冲突与丢弃收集
  ├── workshop-diff.ts              ← [工坊 P4] ★纯函数 diffInstallPlan：更新前的「这一版会改什么」
  │                                    输入是**已算好的计划**而非重拉详情 —— 预告与提交在结构上同源
  │
  ├── types-image.ts                ← [图像 v1] 子系统类型分册（先例 types-audio.ts）。与音频分册不同的是
  │                                    **数据模型类型也全在这里** —— 图像生成与 types.ts 既有实体零交织，
  │                                    集中放才只有一个真相来源。唯一反向边是 `SceneImageMarker`：它要进
  │                                    types.ts 的 `DetectedMarker` 联合，那边 type-only import 回来，
  │                                    本册**不 import types.ts**，边不成环
  │                                    [图像 v2] +`ImageDialect`（方言的封闭旋钮集，C4）/
  │                                    `ImageProviderId` + `ImageProviderCapabilities`（能力位属 provider
  │                                    **不属方言**，C7）/ 失败分类新增 `workflow`·`execution` 两类
  │                                    （重试语义相反，C12）/ `SceneImageRecord` 的 `provider`+`dialectId`
  │                                    记录戳（都是可选，缺席读作 novelai + danbooru，老记录免迁移，C14）
  │                                    / `SceneImageRecord.composeWarnings[]`（C15 的落库告警）
  ├── image-dialect.ts              ← [图像 v2 / C4·C6] 方言的容错解析（parseImageDialects）+ 按 id 取用
  │                                    并叠加用户覆盖（resolveImageDialect）。内容注册表**第 7 面**
  │                                    `imageDialects` 的引擎侧；数据在 `public/data/content/image-dialects.json`，
  │                                    pack 可整份替换（与 catalog 等六面同一机制）
  │                                    🔴 **本模块永不抛**：方言 JSON 是第三方可编辑的数据，认不出的旋钮值
  │                                       回落 danbooru 形状、认不出的条目整条跳过，返回值永远是合法数组
  │                                       （容错口径照 workshop-manifest.ts）
  │                                    🔴 `FALLBACK_IMAGE_DIALECT` = **v1 的行为**穿上方言外衣：注册表这面
  │                                       缺席 / fetch 404 / 设置里存着已不存在的 id，三条路径全落到它，
  │                                       画出来的图与 v1 一模一样。三个字符串旋钮**引用** image-defaults
  │                                       的常量而不是抄一份（抄一份的败法是「改了默认值兜底还是老的」，
  │                                       而兜底恰恰是没人手工验的那条）
  │                                    🔴 兜底方言的 `systemPrompt` 是**空串且这是对的** —— 表示「本方言
  │                                       没话说」（装配层回落 agent-config / 模板），不是「用空提示词调模型」
  │                                    🔴 覆盖按**方言 id 键控**（C6）：全局单份覆盖会把 danbooru 调优带进
  │                                       prose 档，静默废掉整个特性。空串**不算覆盖**（清空 = 回落默认）
  ├── image-defaults.ts             ← [图像 v1] 画质后缀 / 固定构图词 / 基础负向 / 限额初值的唯一出处
  │                                    （被 image-prompt、image-quota 与设置页 getDefaults() 共用）
  │                                    🔴 默认模型刻意**不是 Curated**：它既是过滤子集，官方规范画质后缀
  │                                       还强制带 `rating:general` —— 本项目要支持露骨内容，带上等于
  │                                       每张图都在跟自己的提示词打架。已有断言钉死这条
  ├── image-prompt.ts               ← [图像 v1] ★承重纯函数：场景串 + 角色/地点预设 + 世界标签 → ComposedPrompt
  │                                    🔴 角色预设**绝不拼进 base**，各进 characters[]；角色负向进**该角色的
  │                                       槽**，不并入 baseNegative —— 官方文档确认多角色并进去会串味
  │                                    🔴 `normalizeTagString` 由本模块 export，是**全仓唯一一份**
  │                                       （image-prompt-agent 从这里 import，绝不另抄一份）
  │                                    🔴 无随机、不读时钟、不做 I/O —— 中文→标签是一次 LLM 调用，
  │                                       发生在侧链里；那一步挪进来，本层就再也测不动了
  │                                    🔴 [图像 v2 / C3] **装配是方言参数化的**（`ComposeOptions.dialect`）：
  │                                       分隔符 / 归一化器 / 外貌渲染器（danbooru↔prose）/ 世界·分级·人数
  │                                       三段的形态 / 支不支持负向，全由 `ImageDialect` 决定。只换
  │                                       systemPrompt 的方言仍会给 krea2 螺栓上六段 danbooru ——
  │                                       方言必须拥有**整个**装配契约。不传方言时逐字节等于 v1 行为
  │                                       （金测试就是这条保证本身）
  │                                    🔴 [图像 v2 / C7] `flattenCharacters`（= provider 无角色槽）时各角色
  │                                       positive 按标记顺序并进 base、negative 并进 baseNegative，
  │                                       用方言分隔符。开关来自 **provider 能力位**，不是方言声明的 ——
  │                                       方言作者声明一个后端没有的能力，败法是静默丢角色
  ├── image-quota.ts                ← [图像 v1] 三层限额（每消息 / 滚动一小时 / 同回合去重）**唯一**判定处
  │                                    🔴 自动档与手动档共用它，差别只在拿到 ok:false 之后做什么。
  │                                       两处各写一份就是漂移的来路 —— 一边改阈值另一边没改，症状是
  │                                       「有时候拦有时候不拦」，而错的那一边在花钱
  │                                    🔴 传进来的记录必须含 queued/generating/failed：只算 done 的话，
  │                                       连点 10 次会在第一张落地之前全部放行，限额形同虚设
  │                                    🔴 必须跑在 image_prompt 侧链**之前**（D32）：两处都花钱
  │                                       （LLM token + Anlas），闸门要在最前面
  │                                    🔴 `source==='manual'` 的 ok:false 语义是**「要确认」不是「不许」**
  │                                       —— 机器该被拦死，人该只被减速
  │                                    🔴 [图像 v2 / C9] **三层按保护对象拆开**：L1（每消息）/ L2（滚动
  │                                       一小时）是**花钱防线**，`costModel:'local'` 时整条跳过（本地画一张
  │                                       只花自己的显卡时间，用户明确推翻了「本地也降档保留」的建议）；
  │                                       L3（同回合去重，仅 auto）是**正确性规则**，与谁付钱无关，
  │                                       **对所有 provider 恒开**。`costModel` 取自当前 provider 的能力位，
  │                                       不是设置里的某个开关，且刻意**必填无默认** —— 两个方向都错得无声
  ├── image-segments.ts             ← [图像 v1] 一条正文 → 文本段/图片段序列（分段在**美化之前**且不看
  │                                    美化开关：否则美化关掉或流式途中，标记会漏成尖括号给玩家看见）
  │                                    🔴 **不许写第二个解析器** —— 调 marker-protocol 的 scanSceneImages
  │                                       拿 position 切。一个标签两个解析器就是漂移的来路
  ├── image-world-tags.ts           ← [图像 v1] 时段 / 天气中文 → danbooru 标签（D39）：夜里的戏不该被
  │                                    画成白天，而引擎本来就知道现在几点 —— 不必问 AI
  │                                    🔴 **映射不中的值一律不贡献标签，绝不猜**。天气是 AI 自由书写的
  │                                       短词（「小雨转晴」「血月低垂」），留空只是少一个标签，
  │                                       猜错是**在画面上画出没发生的事**。故只做精确匹配
  ├── image-anlas.ts                ← [图像 v1] 估算这一张会不会烧 Anlas（D43）：宽高与步数在设置里**可调**，
  │                                    调大了会**静默**开始扣费，用户只看到图变清楚了
  │                                    🔴 给的是提示不是保证 —— 判定值叫 within-free-allowance 而不是
  │                                       isFree，UI 措辞必须是「按当前订阅规则**估算**」。
  │                                       规则会变，所以数字只许出现在 NAI_ANLAS_RULES 一处，
  │                                       测试就是这条规则的文档
  │                                    🔴 **免费额度只有 Opus 有**（2026-08-04 真机催生）。`tier` 缺省是
  │                                       `'unset'` 而不是 `'opus'` —— 默认给乐观答案，等于替所有按点数
  │                                       付费的账户（Tablet/Scroll/免订阅购点）宣布「这些图不要钱」，
  │                                       而他们每张扣约 17 点。牌价与档位无关，档位只决定免不免
  ├── image-prompt-agent.ts         ← [图像 v1] image_prompt 侧链：装配 → callAgent → 抽取，
  │                                    **两端是纯函数，中间那次调用是唯一 I/O**（客户端从 deps 交进来，
  │                                    形状照 char-gen-agent 的 CharGenClient）
  │                                    🔴 抽不到 <image_prompt> 就是**明确失败**，不猜、不用启发式兜一个
  │                                       —— 兜出来的是一张没人要的图，且失败被掩盖
  │                                    模型爱在答案前写一段废话，抽取要能越过它（先例 story-rescue.ts）
  ├── character-appearance.ts       ← [图像 v1 / D56·D58] 外貌**属性槽**模型（九槽）+ 逐槽合并。
  │                                    🔴 `undefined` = 没说，空串 = **明确清空** —— 两者长得一样正是
  │                                       D58 要消灭的歧义（`patch.x || base.x` 会把清空悄悄退回基线）
  ├── character-appearance-agent.ts ← [图像 v1 / D56·D57] AI 报外貌的线格式与抽取 + 追加进 systemPrompt
  │                                    的那段规则（**格式定义与解析器同源**，写进 agent-config.json 会
  │                                    长出「提示词教它写 A、解析器只认 B」那种静默失效）
  ├── character-appearance-resolve.ts ← [图像 v1 / D60·D61·D62，v1.3] ★「这个角色现在到底长什么样」
  │                                    的**唯一**判定（纯函数叶子）。四个消费方共用同一个答案：装配 /
  │                                    侧链点名 / 正文缺预设提示 / 写入路由 —— 各写一份的表现是
  │                                    「界面说这张图的形象是随机的，其实并不是」
  │                                    🔴 **AI 一个字节都写不到基线**（D60）：`appearanceWriteTarget`
  │                                       永远给 session，没有基线时差量基准是全空
  │                                    🔴 `buildEffectivePresets` 必须把**只有会话副本、没有预设行**的
  │                                       角色也合成进去，否则那份即兴外貌永远到不了提示词
  │                                    🔴 全空的 `appearance` **等于没有** `appearance`（D62）——
  │                                       编辑器总是整份写回九个槽，按存在性判会把用户填过的
  │                                       手写串预设当成「没有预设」丢掉，静默且每张图都不像
  ├── image-providers/novelai.ts    ← [图像 v1] ComposedPrompt → NAI V4.5 请求体 / 响应 zip → PNG 字节
  │                                    🔴 **三重冗余是这一层的全部要害**：同一份内容要展开到 `input` /
  │                                       `v4_prompt` / `characterPrompts` 三处，字段名还各不相同，而
  │                                       **只填一处不会报错，只会静默产出不对的图**。所以三处一律由
  │                                       同一个中间结构一次性展开，中间不许插 filter/sort（下标会错位）
  │                                    🔴 本层不产随机：seed 缺省由调用方给，塞 Math.random() 会让快照
  │                                       复现失效（测试钉住了这条）
  │                                    🔴 **字节是权威，content-type 只是线索**（2026-08-04 真机纠正）：
  │                                       `parseNaiZip` 原先先判 content-type 含不含 `zip`，而 NAI 真机
  │                                       报的是 **`binary/octet-stream`** —— 一张已生成、已扣点数的图
  │                                       被我们自己扔掉。现在一律先试解包，content-type 只进失败 detail。
  │                                       真机实测：zip 魔数 `50 4b 03 04`，单条目 `image_0.png`
  ├── image-providers/comfyui.ts    ← [图像 v2 / C10-C13] 工作流 JSON 占位符替换 + ComfyUI 响应解析。
  │                                    **纯函数层**（照 novelai.ts 的规矩：无 fetch / 无 Dexie / 无随机 /
  │                                    无时钟）；网络那一半在 `src/ui/lib/image-client.ts` 的
  │                                    `generateComfyImage`（排队 → 轮询 → 取图三步）
  │                                    🔴 **在解析后的对象上按值替换，不做原文字符串替换**（C11）：
  │                                       提示词里第一个引号或反斜杠就会打断 JSON。先 `JSON.parse` 再按值
  │                                       替换，替进去的内容天然不参与语法。整值是占位符 → 换成对应类型
  │                                       （seed/steps 是数字）；字符串内嵌 → 串内替换
  │                                    🔴 **`POST /prompt` 会带着 `node_errors` 返回 HTTP 200**（C12）——
  │                                       只看状态码的分类器会把「图在跑起来之前就被拒了」当成排队成功，
  │                                       然后去轮询一个永不出现的 prompt_id，最终报成超时。所以
  │                                       `parseComfyQueueResponse` **先看响应体、后看状态码**
  │                                       （与 v1「content-type 撒谎扔掉付费图」同形状，这次提前钉死）
  │                                    🔴 `workflow`（跑前被拒：缺 checkpoint / 未知节点 / 替换失败）
  │                                       **不可重试**，文案点名违规节点 id；`execution`（跑到一半 OOM /
  │                                       节点崩）可重试。两类重试语义相反，**不许合并**
  │                                    🔴 `parseComfyHistory` 是**三态**（pending / done / failed）：
  │                                       还在跑时 `/history/{id}` 回的是 `{}` —— 空对象是「等」不是「失败」
  │                                    图刻意建模成 `Record<string, unknown>`：图是**用户的**（LoRA 栈 /
  │                                    上采样 / 社区节点都合法），我们只认那几个 `%占位符%`，其余原样搬运。
  │                                    内置一份最小 SDXL txt2img 图（`BUILTIN_COMFY_WORKFLOW`），
  │                                    未配置也能跑通
  │
  │  🪦 Q-12：`variables.ts` / `vars-merger.ts` 已删。两者整条链零生产引用
  │     （`variables.ts` 最后一个活着的导出 `formatVariablesForPrompt` 的唯一消费方
  │      是 Q-04 删掉的 prompt-assembler）。顺带拆掉「两个同名 `applyVarsPatch`
  │      契约互斥」那个 auto-import 陷阱：留下的那份改名 `var-resolver.applyPathOps`，
  │      入参形状提进 `types.ts` 的 `VarPathOps`；`VarsPatch` 保留，它是效果系统
  │      （`effect-runtime.executeVarsPatch`）的声明式载荷，两者用途不同别再混。
  ├── api-tools.ts
  │   🪦 `api-router.ts` 已删（BFF 同源后端重构 Phase A+B）。路由改住 `server/routes/`
  │      （**7 个文件**：chat / models / image / embeddings / proxy / status / **content**），
  │      入口是 `server/app.ts`，引擎目录里不再有路由层，别按图找那个文件。
  │
  └── (战斗 v2 纯计算规则见 docs/reference/combat-system-architecture.md；v3 内核见 docs/reference/combat-system-architecture-v3.md)
````

> 🪦 这里曾指着一行 `src/vanilla/sillytavern-store.ts`（"框架无关响应式 Store"）——该目录早已不存在，Store 由 Pinia 接管。Q-15 清仓时删掉，别按图找那个文件。

---

> 以下三节 2026-08-13 自根 `AGENTS.md` **原文**迁入（引擎层内容归引擎分册）。

## 事件驱动架构（Phase 4.5-8 实现）

```
Layer 5  脚本级 Script Sandbox  AI 写脚本: $event.on/off(持久订阅) / $call(跨对象引用)
  ↑       (AI 可编程)            init/cleanup 生命周期 + @parent 继承链
Layer 4  语义级 工具面          AI 调工具: craft_check / craft_settle / declare_attack …
  ↑       (AI 可见)             = agent-tools.ts 的 27 个 tool 定义（function calling），
  │                              工具 handler 内部才去调 Layer 3。**AI 手里没有 `$` 对象**
Layer 3  流程级 Resolver        引擎内部: CraftResolver（`$craft`，craft-resolver.ts）
  ↑       (AI 不可见)           🪦 CombatResolver 随 v2 运行时删除；战斗流程改由 combat-v3
  │                              内核主持（openCombat → kernel/reducer/phases），不再有 resolver
Layer 2  计算级 纯函数          $dice.d20() / $resource.getHpPercent() / $char.getTier()
  ↑       (AI 可读，不可写)      —— 这一层的 `$` 是**模块级导出对象**，见下节
Layer 1  原语级 状态读写        StateManager.commitChatState() / $validate.effectValue()
          (仅引擎内部)
```

🔴 **Layer 4 的名字变了但层还在**：v2 时代它真的是「AI 调 `$combat.attack()`」；现在 AI 那一侧
只有 OpenAI function calling 的工具名，`$` 对象一个都够不到（脚本沙盒那份除外，见下节）。
把这层理解成「AI 声明意图的语义面」仍然对（ADR-19），只是载体从 `$` API 换成了 tools。

### 关键架构决策

| 决策                         | 选择                                | 理由                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EventBus 实例化              | 按 SaveSlot                         | 效果实例随存档隔离                                                                                                                                                                                                                                                                            |
| Script 执行                  | **QuickJS(wasm) realm 隔离**        | $event.on/off 持久订阅 + $call 跨对象调用 + init/cleanup 生命周期。2026-08-10 起求值从 `new Function` 迁到隔离后端（SEC-02）：guest 里没有宿主 `globalThis`/`indexedDB`/`fetch`，够不到 Dexie 与 API Key；墙钟 50ms 预算。装不上 **fail-closed**（脚本一行不跑），**绝不回落 `new Function`** |
| 持久订阅管理                 | subscription-manager.ts             | 递归保护(≤10) + 僵尸兜底(unregisterAll)                                                                                                                                                                                                                                                       |
| EffectRuntime 时序           | 管线完成后批量执行                  | 保持 DAG 原子性                                                                                                                                                                                                                                                                               |
| EventBus 引入时机            | Phase 7e+8（已完成）                | 与 Script 系统同步上线                                                                                                                                                                                                                                                                        |
| Agentic 模式                 | OpenAI function calling (Phase 8.5) | craft_gen/char_gen/item_gen 通过 tools 调用真实 Code 函数，禁止 AI 编造数值                                                                                                                                                                                                                   |
| craft_request 时序           | 延迟型 (对齐 combat_trigger)        | Stage 1 暂存 → Stage 2 统一执行，避免阻塞叙事                                                                                                                                                                                                                                                 |
| System Prompt 管理 (Phase 9) | agent-config.json 唯一来源          | 所有 Agent 的完整 systemPrompt 存在 agent-config.json；agent-templates.ts 只留 stub + 动态上下文函数。🔴 **story 例外**：预设短路，行为真源是预设条目——细节见架构图里 agent-config.json 那条                                                                                                  |

### 效果系统统一框架（战斗+制作共用，ADR-29）

战斗 v2 (M1-M5) 已验证一套**统一 subscribeChain 链式管道**机制，制作系统直接复用，不发明第二套。完整设计见 `docs/planning/unified-effect-system-framework.md`。

> 📌 **v3 演进**：战斗内已由 v3 内核接管（`combat-v3/`），效果走 **EffectAutomaton DSL**（18 窗口声明 / **12 个已接求值器** + 8 大类 intent + 封闭表达式文法），不再走 emitChain/script-executor。**本框架仍是制作系统与战斗外的效果基座**（ADR-29 继续适用）。

- **统一机制**：`EventBus.emitChain(type, params, ctx)` 链式参数管道——`(priority, order, 注册序)` 稳定排序、`ctx.combatants`+`subscription.owner` 在场过滤、错误隔离、递归保护
- **两个注册 facade**（互不干扰）：`ScriptRegistry`（声明式，物品装备/卸下）+ `SubscriptionManager`（动态，AI script 运行时 `$event.on`）
- **modifier 不是第二套系统**：物品 `modifiers[]` 在装备时由 ScriptRegistry 注册成"push handler"，走同一条 emitChain
- **核心模式：纯函数兜底 + AI subscribeChain 覆盖**：Code 算基础 → emitChain 传 AI → AI handler 改 outcome → AI 不响应走兜底
- **✅ P1-11 已接线（Q-07, 2026-08-03）**：战斗外效果系统已由 `effect-wiring.ts` 接进生产——`wireEffectSystem(saveId, characters)` 在存档加载时对已装备物品/技能执行 `executeInit` + `$event.on` 订阅注册，装备/卸下经 `state-manager` 的 equip/unequip handler 调 `wireObject`/`unwireObject`。`getEventBus(saveId)` 按存档实例化，`ScriptRegistry` + `SubscriptionManager` 双 facade 随存档生命周期。
- **✅ emit 源与效果回收也已接线（Q-07 第二半, 2026-08-03）**：`commitChatState` 每次提交后，把本次 patch 产生的 `GameEvent` 经 `publishToEffectSystem(saveId, events)` 发到存档 EventBus；`SubscriptionManager` 新增 `setEffectSink`，触发脚本产出的 `hpChanges`/`statChanges`/status 意图不再被丢弃（此前 `handleEvent` 执行完脚本直接扔掉，注释写着「由 state-manager 统一 apply」却没有那个调用方——与 Q-02 同形状的缺陷）。收上来的效果经 `convertScriptEffects` 转成 StatePatch，再走一轮 `commitChatState`（ADR-21 唯一写入口，**没有开第二条写路径**）。反应轮有深度上限 `MAX_EVENT_REACTION_DEPTH = 3`，防止「A 触发 B、B 触发 A」打成事件风暴。没接过线的存档零开销（`peekEffectWiring` 不凭空建 EventBus）。
- **⚠️ 战斗内 18 窗口里只有 12 个真的接了求值器**：`initiative.before` / `initiative.after` / `turn.close` / `morale.before` / `morale.after` / `settlement.before` 在 `combat-v3/phases/` 里没有任何求值器。它们现在编译期就以 `WINDOW_NOT_WIRED` 掉落（`V3_WINDOW_KEYS_RESERVED`），不再静默入索引；接上求值器时把 key 挪进 `V3_WINDOW_KEYS_LIVE` 即可。🔴 **这三张表（LIVE 12 / RESERVED 6 / 合集 18）住在 `combat-item-validator.ts`，不在 `combat-v3/` 下** —— `combat-v3/automata/compile.ts` 反过来 import 它们，按目录名去 v3 里找会扑空。判据是「`phases/` 或 `reducer.ts` 里有 `runWindow(...)` 调用点」，不是「架构文档列了它」。窗口求值统一走 `runWindow(out.events, ...)`——它保证 `EffectRejected` 诊断必进事件流，忽略返回值是可见的 TODO 而非隐藏的丢弃。

## v4 三层子系统分流 (ADR-24/25/26)

```
SubSystem-Craft  制作  → 🚩 延迟型: Story 输出 <craft_request>，Stage1 暂存 → Stage2 执行 craft_gen Agent
                          → AI 调 tools (get_inventory→craft_check→craft_settle) → 真实 DC+骰值+评级+结算 (Code)
                          → 创意效果 (AI) → 结果注入正文 + StatePatch 提交
SubSystem-Combat 战斗  → Stage1后检测 <combat_trigger> → 暂存 → Stage2 request_dispatcher 完成 char_gen 后唤起
                          → 独立战斗窗口: **v3 内核主持流程**（openCombat → kernel/reducer/phases，
                            骰值全出 DiceTape），combat_v3 Agent 是**战斗主持人/DM**（持久会话，
                            经 6 个战斗工具下 Command + 4 个只读查询；玩家自由文本先过 player-input 解析）
                          → write_summary 的终局叙事回注正文 + 批量StatePatch
SubSystem-CharGen 角色 → Stage2 request_dispatcher 异步检测新NPC → char_gen Agent 调 tools → 输出 <char_result> XML
                          → 调 item_gen Agent (仅1次, ADR-26) → 下回合可用
```

🪦 上表 Combat 一行原写作「Code循环 + AI摘要」，那是 v2 combat-runner 的形状。v3 起循环在
`combat-v3/coordinator.ts`，AI 不再只写摘要而是**主持流程**（ADR-19 的意图声明面从 `$combat.attack()`
换成了 `declare_attack` 等工具）。战斗内效果不走 emitChain/script-executor，走 **EffectAutomaton DSL**。

### AI 能碰到的 `$` 面 = 脚本沙盒那一份

**唯一面向 AI 的 `$` API 是 `script-executor.ts` 的 `ScriptSandbox`**（`buildSandbox()` 是这份名单的
唯一真源 —— guest 面由 QuickJS 后端从它推导，加 `$foo` 不必动后端）。AI 写在物品/技能/buff 的
`scripts` 池里的那段代码，看得见的就是下面这些，**没有别的**：

| Namespace   | 方法                                                                                         | 语义                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `$dice`     | `d20()` / `d100()` / `roll(公式)`                                                            | 骰池（`roll` 只认 `NdM±K`，认不出返 0）                                   |
| `$resource` | 读 `getHp/getMaxHp/getMp/getMaxMp/getSp/getMaxSp/getHpPercent`；写 `modifyHp` / `modifyStat` | 读走 `readHooks`（**未注入时一律返 0**）；写只进收集器                    |
| `$char`     | `getAttr(id, 五维英文键)` / `getTier(id)` / `isPresent(id)`                                  | 只读（未注入返 0 / 0 / false）                                            |
| `$status`   | `add` / `apply` / `remove` / `setStacks` / `getStacks` / `has` / `query`                     | `apply` 走 BuffRegistry 去重（同源刷新+增层），`add` 是直接加、**不去重** |
| `$event`    | `on(事件, scriptKey)→handle` / `off(handle 或事件)` / `emit(事件, data)`                     | 持久订阅由引擎在脚本执行后注册进 EventBus                                 |
| `$call`     | `$call(ref)`（函数不是 namespace）                                                           | 跨对象脚本引用（`@parent` 继承链），子脚本的效果合并回本次收集器          |

外加四个上下文变量：`owner` / `target` / `event` / `self`（`self.stacks` / `remainingTime` / `name` / `scripts`）。

🔴 **沙盒里的写全是「收集意图」不是「改状态」**：`modifyHp` / `$status.*` / `$event.emit` 只往
`ScriptEffects` 里 push，落库仍由调用方转成 StatePatch 走 `commitChatState`（ADR-21）。
🔴 `$call` 有递归深度上限 `MAX_CALL_DEPTH`（旧实现靠爆栈兜底）。

**退役的**：`$combat` 随 v2 运行时被 M5 删除（战斗内效果改走 `combat-v3/automata/` 的
EffectAutomaton DSL —— 声明式窗口订阅 + 封闭表达式文法，v3 不接受任意 JS）；`$craft` / `$var` /
`$time` / `$validate` / `$location` / `$affection` / `$effect` / `$chargen` **从来就不在沙盒里** ——
它们是各模块的**模块级导出对象**（`craft-resolver.ts` / `var-resolver.ts` / `time-system.ts` /
`validate.ts` / `location-db.ts` / `affection-system.ts` / `effect-parser.ts` / `char-gen-agent.ts`），
只有引擎 TS 代码 import 得到；AI 那一侧对应的是 agent-tools 的工具名（如 `craft_check` / `craft_settle`）。
注意 `$char` 有**两个不相干的同名对象**：沙盒里那个（三个只读方法）和 `char-query.ts` 导出的那个
（引擎侧查询集）—— 名字撞车，边界不同，别互相照抄方法名。
