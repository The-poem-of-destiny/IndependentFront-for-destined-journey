# AGENTS.md — `src/sillytavern/` 引擎层

> 本文件是**根目录 `AGENTS.md` 的分册**，从中拆出，内容一字未改。
> 拆分理由：这份架构地图只描述 `src/sillytavern/` 下的代码，改这里的代码时才需要它；
> 放进根目录会让每一次会话（哪怕只改文档）都付它的上下文成本。
>
> **非 Claude Code 的工具**（Codex / Cursor / Windsurf 等）：根 `AGENTS.md` 只留了一行指针，
> 动 `src/sillytavern/` 下任何文件之前，请连同本文件一起读。
> Claude Code 通过同目录的 `CLAUDE.md` 自动导入本文件，无需手动读取。

## 架构（已实现部分）

```
src/sillytavern/                    ← 核心引擎
  │
  ├── types.ts                      ← 唯一类型来源；大型联合类型拆 types-*.ts（如 types-audio.ts）
  │   ├── v3 兼容: Lorebook / ChatPreset / AppSettings / ChatSession / ChatMessage
  │   ├── v4+: CharacterState / MemoryRecord / PlotEvent / Snapshot / SaveSlot
  │   │         ApiEndpoint / AgentConfig / AgentDefinition / Pipeline / AgentContext
  │   │         AgentResult / OrchestratorRun / MapMarker / VarsPatch（🪦 MapTopology 从未存在过，
  │   │         地图类型在 types-map.ts 分册）
  │   ├── Audio: AudioSourceKind ('blob'|'builtin'|'file') / AudioTrack / AudioBlobRecord 等
  │   └── 辅助: createDefaultCharacterState() / resolvePlotTree()
  │
  ├── database.ts                   ← Dexie/IndexedDB v19
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
  │   └── v19+: characterAppearances（角色外貌**会话副本**，D56）
  │              与 imagePresets（全局基线）刻意相反：**随存档隔离，删存档连带删**，
  │              且**进 FullBackup** —— 它与 sceneImages 同为「每存档」数据，必须同进同出。
  │              漏收它不会报错，症状是导入后每个角色的本档变化静默退回基线
  │              🔴 **这是 AI 唯一写得到的外貌表**（D60，v1.3）：没有基线的角色，
  │                 AI 即兴出来的那份也落这里（差量基准全空），**不再**去建全局基线
  │       🔴 **世界书、美化规则与 API Key 现居应用 Dexie，不再在 localStorage**。正则 iframe
  │          只能经同步镜像访问 `regexStorage`，不能访问任何应用表；应用 localStorage 只存无密钥
  │          设置元数据（Agent 配置/主题/`beautifierBuiltinDisabled` 等）
  │
  ├── agent-client.ts               ← [Phase 3] API 客户端（每 Agent 独立 userId / 重试退避 / 缓存检测）
  ├── agent-templates.ts            ← [Phase 3+9] Prompt 模板（systemPrompt 已迁 agent-config.json，留 stub + 动态上下文）
  ├── agent-config.json             ← [Phase 9] 10+ Agent 完整 systemPrompt 唯一来源
  │      （🔴 实际文件在 `data/defaults/agent-config.json`，不在本目录）
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
  │         那段提示词随方言走，真源是 `data/content/image-dialects.json`（内容注册表
  │         第 7 面，pack 可整份替换），用户改动存 `imageDialectOverrides[dialectId]`。
  │         留在这里就是 D53 点名的第三份拷贝 —— 换条方言它不跟着换，用户改完看着生效、
  │         切回来又变回去。该 agent 的 model / 温度 / 世界书旋钮**不动**，仍在本文件
  │      🔴 本文件现存 47 个 U+FFFD 替换字符（16 段 / 6 个 agent），其中一处落在闭合 XML
  │         标签的标签名里（形如 `</□有物品>`，模型看到的是坏标签）。**既有问题，
  │         图像 v1 未修**，已另开任务；改这个文件时别顺手把它们当成自己弄坏的
  ├── agent-tools.ts                ← [Phase 8.5] Agentic 工具注册表（17 tools）+ AGENT_TOOL_MAP
  ├── agent-orchestrator.ts         ← [Phase 3+8.5] DAG 编排引擎（阶段串行+同阶段并行/M3 翻译层按名寻址零id单patch）
  │   ├── callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │   └── Marker 回调: onCraftRequest/onCombatTrigger/onCharGenRequest/onPlayAudio
  ├── story-rescue.ts               ← Story 正文救援（正文吞思维链 / 思维链泄漏正文 AI 缺陷兜底）
  ├── random-tables.ts              ← [Phase 8.5] NPC 生成随机表
  │
  ├── field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化（铁律5）
  ├── tier-constants.ts / bloodlines.ts / validate.ts / char-query.ts
  ├── resource-calc.ts / var-resolver.ts / namespace-normalizer.ts / time-system.ts
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
  ├── state-manager.ts              ← 唯一状态写入入口（M2按名寻址 M4名字唯一化 M5变量迁profile+快照重建）
  ├── dice.ts / memory-store.ts / memory-summarizer.ts / plot-outline.ts / plot-engine.ts / location-db.ts
  │
  ├── types-map.ts                  ← [地图 v1 / ADR-31] 地图类型分册（MapPack/MapTile/MapSaveFlags/MapRoute）
  ├── map-pack.ts                   ← [地图 v1] coerceMapPack 容错解析（永不抛，坏包回退 EMPTY_MAP_PACK）
  ├── map-index.ts                  ← [地图 v1] 索引 + resolveTileByLocation（落位契约五条 + 锚地块 + 8 向罗盘）
  ├── map-path.ts                   ← [地图 v1] 混合通行图 Dijkstra（陆海同图按边计价 + via/avoid，逐边时间累积）
  ├── map-weather.ts                ← [地图 v1] 确定性天气采样（种子随机，词汇随包，零存储）
  ├── map-context.ts                ← [地图 v1] $map 结构快照 + uid 446 runtime_geo 投影（只产数据不产中文 prose）
  ├── map-runtime.ts                ← [地图 v1] 注入缝（installMapPack/getMapIndex；content-store 第 8 面点火）
  │      🔴 **map-*.ts 禁任何中文字面量**（map-literals-gate.test.ts 结构闸门）——随图数据全在
  │         pack 里、中文渲染在 placeholder-registry（dispatcher）与内容仓世界书条目（story），
  │         这是 ADR-31「换图零改码」的机器保证。落位/天气/旅程接线在 state-manager
  │         （applySetLocation 仅玩家 / applyTimeAdvance 跨天重断言 / packStamp=contentHash 自愈），
  │         设计与 14 条裁定见 docs/planning/2026-08-11-map-system-v1-integration.md
  │
  ├── combat-intention.ts / combat-damage.ts / combat-turn.ts / combat-resolver.ts
  │   └── (以上为 v2 战斗纯计算函数，v3 内核仍调用；v2 编排层 combat-runner/combat-pipeline 由 M5 删除)
  │   └── combat-v3/               ← [战斗 v3] 代码内核主持流程（M0-M5 已合入）
  │       ├── kernel.ts / reducer.ts / state.ts     ← 状态机 + 原子提交 + 5 不变量
  │       ├── dice-tape.ts                          ← 分通道骰带（32/10/7/6/5）
  │       ├── coordinator.ts                        ← 战斗循环 + RequiredInput 路由
  │       ├── windows.ts / intents.ts               ← 18 窗口求值 + EffectIntent 解释执行
  │       ├── adjudication.ts / rule-keys.ts        ← BoundedAdjudication + 4 RuleKey
  │       ├── automata/                             ← DSL parser/interpreter/compile/builtins/reflection
  │       ├── projection-ui.ts / projection-agent.ts← 双投影（UI 事件 + Agent 文本面板）
  │       ├── replay.ts / contract/                 ← contract harness + 7 场 fixture
  │       └── index.ts                              ← 唯一公共出口（openCombat / runCombatV3）
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
  │          种族/身份点数表、起始地树）住在 `data/content/catalog.json`，经内容注册表
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
  │
  ├── asset-types.ts                ← [素材] categoryForType / allowsVideo / ASSET_MIME_BY_EXTENSION
  ├── asset-filename.ts             ← [素材] `<name>[_<type>][_<variant>].<ext>` 解析/格式化（命名不变式）
  ├── asset-index.ts                ← [素材] buildAssetIndex(rows) → 大类→名字→类型→{base,variants}
  ├── asset-resolve.ts              ← [素材] resolveAsset + 两条相反回退链（立牌链 / 脸位链）
  ├── asset-import-plan.ts          ← [素材] ★ planImport 纯同步出计划（撞号进 variant / 哈希去重 / manifest 只补元数据）
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
  │                                    `imageDialects` 的引擎侧；数据在 `data/content/image-dialects.json`，
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
  ├── api-router.ts / api-tools.ts
  │
  └── (战斗 v2 纯计算规则见 docs/reference/combat-system-architecture.md；v3 内核见 docs/reference/combat-system-architecture-v3.md)
```

> 🪦 这里曾指着一行 `src/vanilla/sillytavern-store.ts`（"框架无关响应式 Store"）——该目录早已不存在，Store 由 Pinia 接管。Q-15 清仓时删掉，别按图找那个文件。
