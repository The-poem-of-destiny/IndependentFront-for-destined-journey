# AGENTS.md — `src/core/` 引擎层

> 本文件是**根目录 `AGENTS.md` 的分册**，维护引擎层架构与路径索引。
> 拆分理由：这份架构地图只描述 `src/core/` 下的代码，改这里的代码时才需要它；
> 放进根目录会让每一次会话（哪怕只改文档）都付它的上下文成本。
>
> **非 Claude Code 的工具**（Codex / Cursor / Windsurf 等）：根 `AGENTS.md` 只留了一行指针，
> 动 `src/core/` 下任何文件之前，请连同本文件一起读。
> Claude Code 通过同目录的 `CLAUDE.md` 自动导入本文件，无需手动读取。

## 架构（已实现部分）

实现自 2026-09-30 起按职责归入子目录；根目录仅保留 `index.ts` 和指令文件。
引擎测试、专用辅助文件和夹具独立放入 `tests/core/`，按相同模块职责分类。
完整分类与新增文件约定见 [src 目录与模块归属](../../docs/reference/src-directory-structure.md)。
以下为模块职责索引，模块路径相对于 `src/core/`；纵向注释线表示说明归属。

````
src/core/                    ← 核心引擎
  │
  ├── types/types.ts                      ← 唯一类型来源；大型联合类型拆 types-*.ts（如 types-audio.ts）
  │   ├── types/types-api.ts: API source 的 kind/protocol 联合、JSON 请求体类型（2026-09-16 T1）
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
  ├── persistence/create-journey.ts             ← 新旅程唯一原子落库入口（角色/存档/档案/大纲/事件同一事务）
  ├── persistence/database.ts                   ← Dexie/IndexedDB v25
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
  │   │              两张死表刻意保留（删表要写 `表名: null`，会永久抹掉老用户的 v1–v3 行）。
  │   │              lorebooks 仍随 FullBackup 往返；settings 可能残留旧 API Key，SEC-01 起
  │   │              新备份不导出、旧备份导入也不读取或覆盖。
  │   ├── v4+: memories / plotEvents / characters / snapshots / saves / apiEndpoints
  │   │         🔒 apiEndpoints 是设备本地凭据表：不进 FullBackup；导入新旧备份都不改本机行。
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
  │   ├── v23+: apiRateLimitPolicies（全局 API RPM 策略）——按
  │              `SHA-256(归一化 baseUrl + API Key)` 指纹存上限，不落明文密钥；进 FullBackup
  │       🔴 **世界书、美化规则与 API Key 现居应用 Dexie，不再在 localStorage**。正则 iframe
  │          只能经同步镜像访问 `regexStorage`，不能访问任何应用表；应用 localStorage 只存无密钥
  │          设置元数据（Agent 配置/主题/`beautifierBuiltinDisabled` 等）
  │   ├── v24+: debugTurns（每存档最近 10 回合完整 Agent 调试历史）——按 invocationId
  │              保留同名侧链的每次调用、agentic provider 往返 usage 与 Delta 重基线诊断；
  │              Embedding 召回/记忆向量化也记录真实 provider usage；写入服从 withSaveWriteLock；
  │              删存档级联删，不进 FullBackup（调试提示词/响应不混入日常备份）
  │   ├── v25+: imageApiConnections —— 保存 NovelAI/ComfyUI 独立命名连接；与 apiEndpoints
  │   │          同为设备本地数据，不进 FullBackup。apiEndpoints 只接受显式 kind + protocol，
  │   │          启动时不补旧字段、不移动旧 image 行；旧配置需由用户重新配置
  │   └── v26+: promptSessions（Delta 会话持久化，2026-09-26 问题 2）—— 每 `(saveId, agentId)`
  │              一行，主键 `key`、`saveId` 索引；**rebuildable 缓存**，不进 FullBackup /
  │              单存档导出，删存档级联删、快照回退/切档由 `invalidatePromptSession` 删。
  │              装了它刷新页面后续用上一轮 wire transcript（签名不符自动冷建）
  │
  ├── persistence/session-backup.ts             ← 单存档导出/导入：每存档表整取（清单同 deleteSaveSlot，字节不随行）+ 内容依赖清单（世界书 token / 工坊项目 / 内容包 / story 预设，导入前只读体检）+ 导入**一律重发 id**（不重发 = 第二次导入静默覆盖第一次），全局表一行不改
  │
  ├── api/api-rpm-limiter.ts            ← [ADR-34] 应用级凭据桶：默认不限；达到上限后的请求按 FIFO
  │                                    暂停整 60 秒，发布等待快照后自动续发；网络 timeout 从放行后才计
  ├── api/                           ← [API 配置重构 / 2026-09-16] 协议无关配置与 provider adapter
  │   ├── source-config.ts          ← 新 schema 严格解析；不推断旧用途/协议，不改写旧行
  │   ├── body-parameters.ts        ← 源参数优先的不可变深合并 / JSON Pointer 省略 / 保护字段 / 实际预算
  │   ├── header-overrides.ts       ← [2026-09-30] 源级自定义请求头（「参数跟随模型」的头那一半）：
  │   │                                受保护头名（鉴权/内容类型/传输控制/`X-Target-*`）+ CRLF 注入防线 +
  │   │                                `X-Custom-Headers`（percent-encoded JSON）载荷编码。
  │   │                                BFF `server/routes/proxy.ts` 有一份独立同名单，两层各验一次
  │   ├── llm-adapter.ts            ← 三种 LLM 协议统一入口、规范化响应/usage/工具调用及原生续接类型
  │   ├── openai-chat.ts            ← Chat Completions 普通/SSE/工具调用编解码
  │   ├── gemini.ts                 ← generateContent/SSE + functionCall/Response + thoughtSignature 保真
  │   ├── anthropic-messages.ts     ← Messages SSE + content blocks + thinking/signature/tool ID 保真
  │   ├── transport.ts              ← 受控 BFF 请求、模型分页、超时与 RPM 发送缝
  │   └── embedding.ts / reranker.ts ← OpenAI 兼容检索请求；受保护字段、响应校验与候选重排
  ├── agents/agent-client.ts               ← [Phase 3 + API 重构] API 客户端（配置快照 / 重试 / 缓存 / RPM；
  │                                    协议适配、流式归一化、工具调度及 continuationMessages）
  ├── prompts/agent-templates.ts            ← [Phase 3+9] Prompt 模板（systemPrompt 已迁 agent-config.json，留 stub + 动态上下文）
  ├── prompts/prompt-session-assembler.ts   ← [Delta 会话 v1 + API 重构] 主 DAG普通 chat/chatStream 的 delta session 深模块：
  │      独占 `(saveId, agentId)` 的 transcript / baselineSignature / revision / 投影 diff 起点，只开
  │      prepare/complete/invalidate 三入口；首轮完整渲染 baseline，后续复用 wire transcript 只追加
  │      `context_delta + turn_context + tailPrompt` 增量；保存原生 assistant 续接块。
  │      baselineSignature 含协议/端点修订/参数签名；重基线判据 = 投影 rebase 信号 →
  │      token 保险（可选 `contextWindowTokens`；`lastPromptTokens >= 窗口` 时自动忽略）→
  │      **增长比**（累积 transcript / 当轮纯 prompt 层 > 1.2，`transcript_growth`，
  │      不依赖 provider token，故 story 流式同样生效）。
  │      🆕 2026-09-26（问题 2）：经注入缝 `PromptSessionStore` 持久化会话（默认不装 = 纯内存，
  │      引擎单测零改动）；刷新后签名一致即续用；invalidate 同时删持久化行（回退整体失效，不 fork）。
  │      embedding / tools / combat / 侧链 / regenerate 走原路径（handle===null 或 skipSession）。
  │      设计：docs/planning/2026-08-22-llm-assembly-delta-architecture-scratch.md
  ├── prompts/prompt-session-store.ts       ← [Delta 会话持久化 / 2026-09-26] `PromptSessionStore` 的 Dexie 实现
  │      （`createDexiePromptSessionStore`）：读写走 `withSaveWriteLock`（与提交串行 + save/delete 时序），
  │      落库前 JSON 往返切断 Proxy。**唯一生产实现在 `src/ui/main.ts` 安装**——引擎默认不装。
  ├── prompts/prompt-state-projection.ts    ← [Delta 会话 v1] 读取型、幂等投影 + 纯 diff（prompt-session-assembler 的基座）：
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
  ├── agents/agent-tools.ts                ← [Phase 8.5] Agentic 工具注册表（**现役工具定义**）+ AGENT_TOOL_MAP
  │      白名单 4 桶：craft_gen(9) / entity_gen(12) / vars_update(2) / combat(15)（2026-10-03 实测）
  │      🪦 `combat_enemy` 桶随 v3 内核退役删除 —— 现役是单一 `combat` DM 沙盒
  │      🔴 combat 桶的真源是 `combat/sandbox/tools.ts` 的 COMBAT_SANDBOX_TOOL_DEFINITIONS：
  │         `getToolsForAgent('combat')` 直接从沙盒定义取，不走 ALL_TOOL_DEFINITIONS
  ├── agents/agent-xml.ts                  ← [Q-05] AI 输出 XML 解析的**唯一**工具面：`tagInner`（取内文，trim）/
  │                                    `tagBlock`（取含标签整块），参数顺序永远 `(source, tag)`
  │      🔴 不再有叫 `extractTag` 的东西 —— 曾有两个同名反义实现（一个取 `match[1]`、一个取
  │         `match[0]`），签名都是 `(string, string)`，连定义带调用抄过去**编译照过**，
  │         运行时把整块 XML 当字段值写进角色档案
  ├── utils/model-json.ts                 ← [Q-05] 从模型输出里抢救 JSON 的**唯一**入口（整段直解 / ```json 围栏 /
  │                                    `<json>` 标签 / 括号切片，顺序即优先级）。剥壳只此一份，兜底由调用方
  │                                    传 `normalize` 回调 —— 形态上就长不出「两个分支两套兜底」
  ├── story/story-output.ts               ← Story 信封投影：`<maintext>`/`<options>` 等结构化外壳 → 玩家可见正文 +
  │                                    行动选项；流式与完成后共用这一条缝（流式期多剥一组控制标签）
  ├── agents/agent-orchestrator.ts         ← [Phase 3+8.5] DAG 编排引擎（阶段串行+同阶段并行/M3 翻译层按名寻址零id单patch）
  │   ├── callAgenticAgent(): toolsEnabled=true → chatWithTools() 多轮循环
  │   └── Marker 回调: onCraftRequest/onCombatTrigger/onEntityGenRequest/onPlayAudio
  │       🔴 [并行化 2026-08-16] 侧链（entity_gen/craft_gen）启动**不 await**，
  │          与 vars_update LLM 并行；收尾三点：vars_update 提交前的回合级 barrier /
  │          combat 分支显式等 charGenPromise / run() 末尾与失败路径统一 await。
  │          per-agent 依赖：`PipelineStage.agentWaitFor[agentId]`（缺省回退 stage.waitFor），
  │          依赖失败的 agent 只跳过自己、不连坐同 stage 其他 agent
  │       🆕 [Phase 3 / 2026-10-03] `daily_check` 独立成 stage，插在 Stage 2（dispatcher，产
  │          `delta_time` 并调 `applyTimeAdvance`）**之后**、Stage 3（vars_update）**之前**；
  │          `advanceTime` 之后把本轮分钟写进 `ctx.deltaTimeMinutes`（供 `{{DELTA_TIME}}`）；
  │          战斗会话活跃（`ctx.combatActive`）时在 `executeStage` 跳过该 agent
  ├── story/story-rescue.ts               ← Story 正文救援（正文吞思维链 / 思维链泄漏正文 AI 缺陷兜底）
  ├── agents/random-tables.ts              ← [Phase 8.5] NPC 生成随机表
  │
  ├── content/field-enums.ts                ← [M1] 中文枚举集中定义 + 归一化（铁律5）
├── character/tier-constants.ts / bloodlines.ts / validate.ts / char-query.ts
├── character/resource-calc.ts / var-resolver.ts / namespace-normalizer.ts / time-system.ts
├── character/exp-table.ts                  ← 🆕 [经验系统 v2 2026-08-24] 累计经验表（LEVEL_XP_TABLE，照参考脚本）
│                                     + Code 接管升级（resolveLevelUps）+ 登神长阶放宽版（resolveAscensionFlyup）
│                                     + 战斗经验系数按档（EXPERIENCE_COEFFICIENTS normal/easy）
│                                     + 旧档归一化（applyExpFloor 幂等只提升）。char-gen / resource-calc /
│                                     tier-constants / combat/sandbox/settlement 的等级经验逻辑统一委托此处
│
  ├── state/save-profile.ts               ← [Phase 4.6] 存档级 FP 元货币（M5: +variables 变量唯一真源）
  │                                      [2026-09-09] +`worldFlags.plotThreads` 袋的读/写（getPlotThreadFlags /
  │                                    setPlotThreadFlagsInPlace + commitPlotThreadTurn 成功回合收口写入口）
  ├── effects/effect-parser.ts / buff-registry.ts / effect-types.ts
  │      🪦 [2026-10-03] 同目录 `effect-runtime.ts` / `game-event.ts` / `effect-wiring.ts` /
  │         `subscription-manager.ts` / `status-api.ts` 已随脚本系统退役删除（详见下方 game-event 条）
  ├── ejs/ejs-backend.ts                ← [能力面 T1] EjsBackend 接口 + LegacyBackend + 生产切换入口
  ├── ejs/ejs-quickjs-backend.ts        ← [能力面 T7] ★ QuickJS(wasm,主线程) 隔离后端 —— SEC-02 的边界
  │                                    实测：构造器逃逸/死循环/ReDoS/OOM 四条全部堵住
  ├── ejs/ejs-capabilities.ts           ← [能力面 T4/T5] chat/char/world/quest/lore/local/ui/engine
  ├── ejs/ejs-fmt.ts                    ← [能力面 T5] fmt.yaml/table/num/bar + 不依赖 locale 的 compareName
  ├── ejs/ejs-rng.ts                    ← [能力面 T2] 种子随机（快照重放可复现）
  ├── ejs/ejs-preflight.ts              ← [能力面 T8] 装前预检（纯函数，不阻断安装）
  ├── ejs/ejs-runtime.ts                ← [工坊 P2] 整片编译（全条目 token 编进同一函数体，跨块 if/for 成立）
  │                                    compileEjsEntry / executeEjsEntry；两轴注入 + 失败回滚
  ├── ejs/ejs-lodash-shim.ts            ← [工坊 P2] `_` 纯读边 17 方法 + chain（不含任何写方法）
  ├── character/stat-projection.ts            ← [工坊 P2] buildStatData：主角资源/等级/五维/命运点数/世界.时间（只读快照）
  ├── ejs/ejs-vars-diff.ts              ← [工坊 P2] 草稿深 diff → {replace,remove} 喂 applyVarsPatch；256KB 护栏
  ├── 🪦 [2026-10-03] `effects/game-event.ts`（EventBus 按存档隔离 + emitChain 链式管道 ADR-29）/
  │      `effect-wiring.ts` / `subscription-manager.ts` / `status-api.ts` / `effect-runtime.ts`
  │      随战斗外 JS 脚本链整体删除 —— EventBus + 双 facade 效果系统整链成为历史，别再按图找
  │      现役替代：声明式 VarsPatch / StatusEffect 经 dispatcher 管线落地，战斗走 combat/sandbox/
  ├── state/state-write-queue.ts          ← 🆕 [并行化 2026-08-16] 写入串行队列地基：withSaveWriteLock
  │                                    （per-saveId FIFO）+ withGlobalWriteLock（记忆 id 分配+落库）。
  │                                    🔴 锁粒度 = RMW 区段，锁内**禁止**调用任何会再入队列的函数
  │                                    （reactToEvents / applyTimeAdvance 尾部自提交一律移锁外，
  │                                    否则同 saveId 自等死锁）。LLM 调用无副作用可并行；
  │                                    一切 Dexie 写入必须经此串行。收编点：commitChatState /
  │                                    applyTimeAdvance / confirmRandomEventTrigger / sync* /
  │                                    advanceTurn / createSnapshot / restoreSnapshot /
  │                                    commitPlotThreadTurn（2026-09-09 主线细化收口）
  ├── state/state-manager.ts              ← 唯一状态写入入口（M2按名寻址 M4名字唯一化 M5变量迁profile+快照重建）
  │      🆕 [Phase 3 / 2026-10-03] **状态计时全权交 `daily_check`**：`applyTimeAdvance` 删掉了
  │         遍历角色扣减 `remainingTime` / 到期移除的整段逻辑（现恒返回空补丁，只推时钟 +
  │         天气/随机事件/地块结算三个钩子）；`StatusEffect.carryMinutes`（F07）随之退役。
  │         新增 op `update_status_effect`（按名改既有状态的 `remainingTime`（null=永久）/`stacks`，
  │         找不到名字 warn 忽略不抛）；资源与上限仍走既有 `update_character`（白名单含
  │         `hp/maxHp/mp/maxMp/sp/maxSp` 且自带 `[0, max]` 钳制，故未新增资源 op）
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
  ├── character/attribute-allocation.ts       ← 自由属性点分配的引擎侧唯一入口（校验上限查 `getTierConfig`，
  │                                    落库走 `commitChatState`）。🔴 补丁只写 attributes + freeAttrPoints，
  │                                    **绝不碰 level/tier** —— 那两个字段的差值正是自动加点钩子的判据
  ├── crafting/quality-inference.ts          ← [Q-11] 由属性加成总和推断品质（**封顶在传说是刻意的**）。
  │                                    此前逐字重复住在 ItemsPanel.vue / CharacterListPanel.vue 两处，
  │                                    分叉的表现只是「同一件装备两个面板显示不同品质」，不会有东西失败
  ├── variables/vars-update-translator.ts     ← [Q-19] AI JSON → `StatePatch[]` 的**纯翻译层**（无 I/O，import 只有类型）。
  │                                    从 `agent-orchestrator.processStageMarkers`（那时 1327 行）里剥出来的
  │                                    纯映射；不违反 ADR-21 —— `commitChatState` 仍是唯一写入口
  ├── variables/daily-check-translator.ts     ← 🆕 [Phase 3 / 2026-10-03] daily_check 的 AI JSON → `StatePatch[]`
  │                                    纯翻译层（同款：无 I/O、只 import 类型）：`characterUpdates` →
  │                                    `update_character`（hp/mp/sp+上限，白名单已覆盖且自带钳制）、
  │                                    `statusUpdates` → `update_status_effect`、`statusRemovals` →
  │                                    `remove_status_effect`。整组认不出当没写、单条认不出只丢那一条
  ├── utils/dice.ts / memory-store.ts / memory-summarizer.ts / plot-outline.ts / plot-engine.ts / location-db.ts
  ├── plot/plot-threads.ts               ← 🆕 [主线细化层 ADR-35 / 2026-09-09] 事件线纯领域逻辑：
  │                                    PlotThreadNode/Flags + 节奏闸门 evaluatePlotThreadGate
  │                                    （main-only、4 回合冷却、窗口距离概率带、createEjsRng 专用 salt
  │                                    确定性抽样，同回合重试不重掷）+ reducer（declarations/updates/
  │                                    revealed 三入口，按名寻址、终态不被 pre 降级、前向引用不造空节点）
  │                                    + 边推导 collectPlotThreadEdges（foreshadows/payoffs 双向合一）
  │                                    + 快照/表层投影 buildPlotThreadSnapshot / projectPlotThreadSurface
  │                                    + char_gen 实体化投影 A/B（§3.4: 未出现给全量行为化，已出现只给表层）
  │                                    🔴 存储用英文四值 + 中文标签集中映射（「中文枚举」通则的明确例外）
  │                                    🔴 禁 Math.random/时钟/DB（快照回退可复现，同 ejs-rng）；禁中文字面量
  │                                    于判据（状态标签是显示面不是判据；措辞在 placeholder 与 UI 层）
  │                                    写入口见 save-profile.commitPlotThreadTurn（锁内重读窄写+幂等）
  ├── index.ts                      ← barrel（Q-04/Q-12 清仓后只 re-export 活着的模块）
  │
  │  ── 提示装配 / 上下文 ──
  ├── prompts/placeholder-registry.ts       ← [Phase 10] `{{PLACEHOLDER}}` → 解析函数注册表（31 个，2026-08-18 实数；
  │                                    文件头注释写 18 是旧的）+ 每 Agent 默认模板。
  │                                    地图 `{{MAP_CONTEXT}}` 与 `{{RANDOM_EVENTS}}` 的**中文措辞都在这里**
  │                                    （数据面是纯函数模块，措辞在 resolver —— 那两个子系统零中文字面量的原因）
  ├── prompts/template-resolver.ts          ← [Phase 10a] 模板解析：localParams（链上覆盖）→ 注册表 → 认不出的原样留着
  ├── prompts/preset-loader.ts              ← [Phase 8+10] ST 预设加载 + 占位符宏预处理（setvar/getvar/random/roll/注释）；
  │                                    EJS `<%…%>` **原样保留**交给 ejs-runtime
  ├── content/worldbook-loader.ts           ← [Phase 8] 世界书加载/激活/排序/渲染（constant + keyword 双层激活），
  │                                    条目正文经 `executeEjsEntry` 求值（ADR-30）
  ├── content/builtin-worldbooks.ts         ← [Phase 8] 内置世界书运行期 fetch 预加载（刻意不用 `import.meta.glob` eager
  │                                    —— 那会把旧数据打进构建产物，且 HMR 变全页刷新）
  ├── prompts/context-visibility.ts         ← [Phase 8] Agent × Zone 可见性矩阵（**设计时决策，不是运行时配置**）+
  │                                    buildZoneContext / filterZoneContent（FULL/NARRATIVE/SUMMARY/KEYS/NONE 五级）
  ├── story/beautifier.ts                 ← [Phase 7e+10i] 输出美化正则管道（纯函数，编译失败静默跳过不阻断）。
  │                                    执行边界在 UI 那个网络可用的 opaque iframe，不在本层
  │
  ├── types/types-map.ts                  ← [地图 v1 / ADR-31] 地图类型分册（MapPack/MapTile/MapSaveFlags/MapRoute）
  ├── map/map-pack.ts                   ← [地图 v1] coerceMapPack 容错解析（永不抛，坏包回退 EMPTY_MAP_PACK）
  ├── map/map-index.ts                  ← [地图 v1] 索引 + resolveTileByLocation（落位契约五条 + 锚地块 + 8 向罗盘）
  ├── map/map-path.ts                   ← [地图 v1] 混合通行图 Dijkstra（陆海同图按边计价 + via/avoid，逐边时间累积）
  ├── map/map-weather.ts                ← [地图 v1] 确定性天气采样（种子随机，词汇随包，零存储）
  ├── map/map-context.ts                ← [地图 v1] $map 结构快照 + uid 446 runtime_geo 投影（只产数据不产中文 prose）
  ├── map/map-runtime.ts                ← [地图 v1] 注入缝（installMapPack/getMapIndex；content-store 第 8 面点火）
  │      🔴 **map-*.ts 禁任何中文字面量**（`map-literals-gate.test.ts` 结构闸门；同款的还有
  │         `random-event-literals-gate.test.ts`，见下面随机事件一节）——随图数据全在
  │         pack 里、中文渲染在 placeholder-registry（dispatcher）与内容仓世界书条目（story），
  │         这是 ADR-31「换图零改码」的机器保证。落位/天气/旅程接线在 state-manager
  │         （applySetLocation 仅玩家 / applyTimeAdvance 跨天重断言 / packStamp=contentHash 自愈），
  │         设计与 14 条裁定见 docs/planning/2026-08-11-map-system-v1-integration.md
  │
  ├── types/types-random-events.ts        ← [随机事件 v1 / ADR-32] 类型分册（事件定义 / 条件 DSL / 权重链 / 槽位表 /
  │                                    `RandomEventSaveFlags` = `worldFlags.randomEvents` 的形状 / 只读快照）。
  │                                    照 types-map / types-image 的规矩**不 import types.ts**，边不成环。
  │                                    唯一的例外导出是 `DEFAULT_RANDOM_EVENT_CONFIG`（三个数字的兜底常量）
  ├── random-events/random-event-pack.ts          ← [随机事件 v1] `coerceRandomEventPack` 容错解析（内容包第 13 分节 `randomEvents`）
  │                                    🔴 **永不抛**：坏定义整条跳过 / 坏子项逐条丢 / 坏旋钮只回落那一格 /
  │                                       整份认不出（含**数组**）→ 空包。空包是合同不是异常（引擎仓零内置事件）
  ├── random-events/random-event-scheduler.ts     ← [随机事件 v1] ★确定性调度核（954 行，纯函数）：MTTH 逐天掷骰 `rollRandomEvents` /
  │                                    首访强制入池 `armFirstVisitEvent` / 池子保洁 `pruneRandomEvents` /
  │                                    触发结算 `settleRandomEventTrigger` + 条件求值与权重链两个共用判据
  │                                    🔴 **零存储、零时钟、零 `Math.random`**：种子 = `(saveSeed, 事件名, gameDay)`，
  │                                       随机数复用 `createEjsRng` —— 快照回退/重发天然一致。测试里有结构闸门扫源码
  │                                    🔴 **改入参就是错**：四个入口一律「无变化返回 `null`」，有变化返回全新 flags
  ├── random-events/random-event-snapshot.ts      ← [随机事件 v1] 条件求值只读快照的**全仓唯一一份**（地点键解析 + RollContext 组装）。
  │                                    写侧（state-manager 入池）与读侧（game-pipeline 注入）此前各抄一份，
  │                                    靠注释维持一致 —— 漂了不报错，症状是首访条目在注入面静默消失
  ├── random-events/random-event-context.ts       ← [随机事件 v1] 注入块的**数据面**：候选池过滤+排序成快照。**一个字的措辞都不在这里**
  │                                    （`<random_events>` 外壳 / `[!]` 首访标记 / 「至多触发一个」全在 resolver）。
  │                                    过滤判据整份委托 `isPendingStillValid`，与保洁共用同一份
  ├── random-events/random-event-runtime.ts       ← [随机事件 v1] 注入缝（`installRandomEventPack` / `getRandomEventPack`），
  │                                    理由逐字同 map-runtime。**刻意没有索引缓存**：事件是几十条量级，
  │                                    加一层缓存只多出「什么时候失效」这个得有人记得维护的问题
  │      🔴 `random-event-*.ts` 同样**禁中文字面量**（`random-event-literals-gate.test.ts`，与
  │         `map-literals-gate.test.ts` 同款结构闸门）—— 事件名/简报/槽位词全是包数据。
  │         唯一例外是 `{{place}}` 这个 ASCII 占位符，它是**协议**不是内容。
  │         接线在 state-manager（逐天掷骰 / 首访 / `confirmRandomEventTrigger` 按名结算），
  │         注入在 `{{RANDOM_EVENTS}}` resolver（池空/关闭/**战斗会话活跃**时返空串零 token）
  │
  ├── content/content-registry-runtime.ts   ← 🆕 [分层收口 2026-08-17] 内容注册表的注入缝
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
  ├── types/types-content.ts              ← [内容分离 波1] 内容包子系统的纯类型分册（pack 载荷 / 14 分节 / 安装计划 /
  │                                    校验记录 / 四态基线）。落库实体仍住 types.ts，本册只 type-only import 它们
  ├── content/content-source.ts             ← [内容分离 波1] ContentProvider 的引擎半边（纯同步）：`validatePackOrThrow` /
  │                                    `hashContentDeterministic` / `hashWorldBook` / `resolveSection`（三态语义）
  ├── content/content-pack-plan.ts          ← [内容分离 波1] ★安装/升级/卸载的纯函数 planner（四态判定 + 存档 uid 迁移三段式）
  │      🔴 **本文件与 content-source 互相 import，是一条真实的运行时环**（如实记录，别按旧注释
  │         理解成单向）。目前无害**只因为两侧的使用点全在函数体内** —— ESM 环下模块初始化期取到的是
  │         undefined，所以**任一侧都不许在模块顶层（含字段初始值/顶层常量表达式）使用对方的导出**
  │      纯度约束同 workshop-install-plan / asset-import-plan：无 I/O、无 Dexie、无 Vue、
  │      **无 `crypto.subtle`**（异步会把 planner 传染成 async，所以逐书基线用同步 hash 不用 SHA-256）
  ├── assets/remote-asset-catalogue.ts     ← 🆕 [远程素材 v1] 远程素材**声明**的纯函数解析层：两种本地载体
  │                                    （世界书 char-info 那段 `profile` 字面量 / 内容包第 14 分节 `remoteAssets`）
  │                                    各自归一成 `RemoteAssetDecl`，**到此为止** —— 下载/落库/镜像同步全在 UI 波
  │      🔴 **永不抛**（两个来源都是第三方可编辑数据）：认不出的块跳过、认不出的行跳过，
  │         返回值永远是合法数组。一个写坏了的角色卡不该让另外十四个角色没有立绘
  │      🔴 名字与变体走既有闸门（`asset-filename.ts` 的 `violatesNamingInvariant` /
  │         `violatesZipEntryName`），不另立一套 —— 远程素材最终落成**普通素材行**，
  │         这里放进一个 `圣殿/内庭`，症状会推迟到半年后某次「导出再导入之后少了几张图」
  │
  ├── runtime/engine-settings.ts            ← [Q-06] 引擎侧读设置的**唯一入口**（注入缝）。裁定：真源在前端
  │                                    localStorage，引擎经本缝读，**不是**搬进 Dexie —— 引擎要的是
  │                                    「当前生效的设置」这个能力，不是「某张表」这个位置；缝也让引擎在
  │                                    无 UI 的场合（测试 / 未来 headless 跑批）自带可用缺省
  │      🪦 收口前 Dexie `settings` 表是一份**影子配置**（`initializeDatabase` 播种后再没人写全），
  │         两侧靠 `game-pipeline.syncSnapshotSettings` 那座只搬两个字段、`catch { console.warn }`
  │         静默失败的桥连着 —— 症状是「设置页明明改了、引擎行为没变」，桥断了用户完全无感
  │
  │  🚧 **四条注入缝 = 引擎读前端的唯一合法途径**（engine-settings / map-runtime /
  │     random-event-runtime / content-registry-runtime）。`src/core/**` 里
  │     **禁止**出现任何 `../ui/*` `@ui/*` `vue` `pinia` 的 import —— 收口前有 6 条这样的反向边，
  │     全都编译得过、跑得通、测试全绿，代价是引擎拖着整条前端链。两道机器闸门钉死：
  │     `eslint.config.js` 的 `no-restricted-imports`（静态边，含 type-only）+
  │     `tests/layering-gate.test.ts`（源码扫描，专治动态 import / 字符串路径 / import.meta.glob）。
  │     `?raw` 源码读取不算依赖边（供值链路测试要它）。要在引擎里用前端的东西：搬进引擎，或开一条新缝
  │
  ├── combat/                             ← 战斗模块（协议沙盒 + 计算库）
  │   ├── combat-damage.ts / combat-turn.ts
  │   │                                    ← 纯计算库：8 步伤害管线 / 先攻计算（sandbox/tools.ts 在用）
  │   └── 🪦 v3 内核（kernel/reducer/state/dice-tape/windows/intents/coordinator/phases/automata/
  │      adjudication/rule-keys/player-input/summon-pool/participant/client/projection-*/types.ts）
  │      及其全部测试已于 C5a 删除；`combat-intention.ts` / `morale-system.ts` /
  │      `combat-item-validator.ts` / `describe-modifier.ts` / `describe-automaton.ts` 随 C5b 删除。
  │      🪦 UI 桥（`ui-contract.ts` 的 CombatView/CombatUnitView/CombatCommand、`ui-events.ts` 的
  │      CombatEvent、`combat/index.ts` barrel）随 **C6** 删除 —— 前端改直接吃沙盒 `CombatState`
  │      （`src/ui/components/game/combat/combat-view.ts`），不再走事件投影。
  ├── combat/sandbox/                       ← 🆕 [战斗重写 Phase 2，2026-10-02] 协议驱动战斗沙盒后端
  │   │                                        （game-pipeline 战斗路径自 C2 起切到这里）
  │   ├── types.ts                          ← 权威 CombatState（meta + 按名字索引的 units）；工具 op 类型；
  │   │                                    Dexie `combatSandboxes` 行类型。逻辑键=名字（铁律1），AI 永不产 id
  │   ├── state.ts                          ← createCombatState（从存档角色建 origin:'save' 单位 + 按 tier
  │   │                                    补齐 max 资源）+ 纯函数 applyOps/setMeta/状态增删 + 轻量不变量校验
  │   │                                    （负/超上限 **warn 照写不抛**）
  │   ├── settlement.ts                     ← buildCombatSettlementPatches：终局把 origin:'save' 单位的
  │   │                                    hp/mp/sp + 状态差量转 StatePatch（temp 单位、**集群编队**与战斗字段
  │   │                                    丢弃；exp/fp 由调用方经 extras 传入）+ computeCombatExpRewards
  │   │                                    （胜利经验：击杀敌方 Lv×层级系数 × 集群衰减 (1+(N-1)×0.2)
  │   │                                    平分给存活存档单位）+ deriveCombatOutcome/isCombatOutcome
  │   │                                    （AI 写中文 outcome 时由 Code 按场上存活推导胜负）
  │   ├── roster.ts                         ← 🆕 marker 名单 → 参战单位：解析 `名字×N` 计数语法，
  │   │                                    同一名字人数 ≥3 时聚合成**集群单位**（资源=个体上限×N、
  │   │                                    `cluster.alive/total=N`）；buildCombatRosterFromMarker 纯函数
  │   ├── protocol.ts                       ← loadCombatProtocolText：从世界书 combat_extra 取协议条目正文
  │   │                                    （点名取文，**不看 enabled、不走 EJS 激活**）+ 纯拼装函数
  │   ├── tools.ts                          ← 15 个工具（7 状态维护 + 3 骰 + calc/calc_damage/calc_initiative
  │   │                                    + get_character/get_inventory 只读查询）
  │   │                                    + createCombatToolBinding（绑定一个 CombatState，就地更新）
  │   ├── runner.ts                         ← runCombatSandbox 单 exchange（系统提示=协议+流程（可注入
  │   │                                    agent-config 的 combat.systemPrompt）+参战表单+当前状态；玩家输入
  │   │                                    user 回注续战；continuationMessages 整段续接）/ runCombatSandboxLoop
  │   └── persistence.ts                    ← Dexie v27 `combatSandboxes`（每存档一行，存 CombatState +
  │                                            transcript）；rebuildable 缓存，不进 FullBackup，删档级联删
  ├── effects/effect-types.ts               ← [战斗 v2 M2] Modifier 6 大类 + 登神 divinity 仲裁。
  │                                    🔴 C5b 后已无生产引用（craft-request 的 modifier 采集随实体字段删除而移除），
  │                                    目前仅其单测引用；保留待裁量
  ├── effects/buff-registry.ts              ← [战斗 v2 M2] buff 去重/生命周期/结算时机的**纯函数集**（不持状态不落 DB）。
  │                                    buff id = 有 sourceKey 时 `sourceKey.name`、否则裸 name（铁律：AI 永不产 id）
  │                                    🔴 [2026-10-03] 与 effect-types / effect-parser 同状：脚本系统退役后
  │                                       生产零引用、仅其单测引用，如实保留待裁量（不是现役链路）
  ├── crafting/craft-quality.ts / craft-dc.ts / craft-resolver.ts
  │   ├── crafting/craft-request.ts        ← [Q-21] 装配唯一口 buildCraftRequest(角色, 工具参数, 骰带)
  │   │                              🔴 **纯函数、无随机** —— 骰子由工具边界掷好传进来
  │   │                              （agent-tools.takeCraftTape）。此前两个工具各装配一遍
  │   │                              且都写 `d20Rolls: []`，`rollCraftDice` 兜底成
  │   │                              `d20Rolls[0] ?? 10` → **生产每一次制作检定都是 d20=10**，
  │   │                              连带大失败不可达（判据要 length===1，而 length 是 0）、
  │   │                              优/劣势整条死规则（要 length>=2）。与 Q-01 同形状，
  │   │                              但 Q-01 只覆盖了 combat/coordinator。
  │   │                              check 的骰带按**请求指纹**存 ToolExecutionContext.craftDice，
  │   │                              同参数的 settle 取走 —— AI 只见结果不碰骰值，且刷检定无效。
  │   │                              🔴 骰数由优/劣势决定（齐平 1 颗 / 优劣势 2 颗），
  │   │                                 **不能**一律掷 2 颗，那会把大失败判据换个姿势再打掉一次
  │   └── crafting/craft-projection.ts     ← [Q-21] 结算结果 → `<action_info>` 竖线表 + 一句话摘要
  │                                  这一层不允许出现计算（ADR-28：面板是给纯文本 AI 的遗留手段）
  ├── character/affection-system.ts          ← 好感度系统
  ├── content/start-catalog.ts              ← [Q-30] 捏人目录入口（re-export 机制 + 属性名/品质码表/品质色/品质基础 DC）
  │   └── content/start-catalog-mechanics.ts ← [D24] 机制半边：schema/类型 + 难度档位/性别枚举/限定覆盖表
  │                                     + 纯函数（parseCatalogData 容错解析 / lookupCost 查表 /
  │                                     flattenLocationTree / classifyBackground）
  │       🪦 `start-catalog-data.ts`（8704 行）已删。七个池（装备/物品/技能、背景、命定核心、
  │          种族/身份点数表、起始地树）住在 `public/data/content/catalog.json`，经内容注册表
  │          （content-store 的 `catalog` 面）供给、pack 可整份替换。
  │          🔴 **不许往机制文件里加任何一条具体条目** —— `start-catalog-mechanics.test.ts`
  │             有一条结构闸门专门盯这件事（导出名黑名单）。
  ├── story/marker-protocol.ts            ← [Phase 6e+Audio+图像 v1] XML 标记检测（含 <play_audio> / <scene_image>）
  │                                    + sanitizeCaption（标题/说明的收敛器）
  │                                    🔴 加标记**只动 MARKER_SPECS**（Q-05）：扫描器、MARKER_TAGS、
  │                                       scanMarkers 全由那张表推导，别去手改它们
  │                                    🔴 标记正文那句中文**不过 normalizeTagString** —— 全角标点在中文
  │                                       句子里是对的，归一化会把它改坏
  │                                    🔴 title 畸形（含引号/超长/缺省）**只收敛不拒绝**：为一次装饰性
  │                                       失误否掉整个标记，等于把它升级成一张画不出来的图
  ├── agents/entity-gen-agent.ts          ← [2026-10-02 / Phase 1d] 通用实体生成编排（char_gen + item_gen 硬改名合并）。
  │      `entityType` 分派：character（单 `add_character`，技能/装备/道具/登神内嵌）/ skill·equipment·item
  │      （复数 `add_skill`/`add_item`）/ status（`add_status_effect`）/ ascension（`update_character`）。
  │      重铸 `rewriteLoadoutItem`、战斗召唤 `runEntityGenForCombat` 同址。装备单 `add_item` 带 `equippedSlot`。
  ├── agents/entity-gen-parse.ts          ← [2026-10-02 / Phase 1d] entity_gen 的统一 XML/JSON 解析层
  │      （`parseEntityGenOutput` + `parseStatusesXML` + `parseStatusEffectsXML` 从 char-gen-agent 抽出）。
  │      🔴 实体两层字段 `protocolText`（条目原样内文）+ `tags`（`<tag>`/`[...]`）；
  │         不解析 `<modifiers>/<buff>/<automaton>/<script>/<divinity>`（写了也忽略并剥离）。
  ├── crafting/craft-gen-chain.ts            ← [Phase 9b] 制作生成编排（M3 零id/type归一化/单patch）
  │
  │  🪦 [2026-10-03 / Phase 1b·1c] **战斗外 JS 脚本链整体删除**（`scripting/` 现只剩空目录）：
  │     `scripting/script-executor.ts`（`$` 沙盒名单 `buildSandbox()`）/ `script-registry.ts` /
  │     `script-backend.ts`（SEC-02 接缝 + installProductionScriptBackend）/ `script-quickjs-backend.ts`
  │     （QuickJS wasm 隔离后端），以及 `effects/subscription-manager.ts`（持久订阅 + 递归保护）/
  │     `effects/effect-wiring.ts`（战斗外效果接线）/ `effects/status-api.ts` / `effects/effect-runtime.ts` /
  │     `effects/game-event.ts`（EventBus + emitChain）全部删除。
  │     🔴 AI 可编程脚本面（实体 `scripts` 池 / `$event` / `$call` / `@parent` / init·cleanup）随之消失，
  │        实体 `scripts` 字段同步清出；效果回归「声明式 VarsPatch / StatusEffect + dispatcher 管线」。
  │     ✅ **世界书 EJS（ADR-30）与工坊正则不受影响**，EJS 沙盒仍在 `ejs/`。
  │     设计全文：docs/planning/2026-10-02-combat-decode-entitygen-plan.md
  │
  ├── audio/audio-channels.ts             ← [Audio] MusicChannel 音序器 + SfxChannel 声池（加载世代号竞态保护）
  ├── audio/audio-manager.ts              ← [Audio] 音轨库注册表 + 主音量 + 手势解锁 + playByTag AI 钩子
  ├── audio/audio-names.ts                ← [Audio] 按名寻址纯函数（normalizeAudioName / findByName 稳定取最早）
  ├── audio/audio-tags.ts / audio-scene.ts ← [Audio] 四维标签 + 场景选曲（七段路径逐级回退+四维加权打分）
  ├── types/types-audio.ts                ← [Audio] 注入缝接口 + state/options（数据模型类型仍在 types.ts）
  │   tests/core/audio/audio-fakes.ts     ← [Audio] 独立测试目录中的注入 seam 测试替身（vitest environment 是 node：
  │                                    没有 AudioContext / Audio / URL.createObjectURL）
  │
  ├── assets/asset-types.ts                ← [素材] categoryForType / allowsVideo / ASSET_MIME_BY_EXTENSION
  ├── assets/asset-filename.ts             ← [素材] `<name>[_<type>][_<variant>].<ext>` 解析/格式化（命名不变式）
  ├── assets/asset-path.ts                 ← [素材 / Q-16] normalizeSlashes / basenameOf / 扩展名归一化的**唯一实现**
  │                                    （引擎导入计划与 UI 侧 zip 往返曾各存一份逐字相同的拷贝）
  │                                    🔴 已经咬过一次：`"苏婉_头像.png "` 的字面扩展名是 `"png "`，
  │                                       zip 侧比引擎侧更严 → 整条被当噪音丢掉，症状是「导入了但库里查不到」
  ├── assets/asset-index.ts                ← [素材] buildAssetIndex(rows) → 大类→名字→类型→{base,variants}
  ├── assets/asset-resolve.ts              ← [素材] resolveAsset + 两条相反回退链（立牌链 / 脸位链）
  ├── assets/asset-import-plan.ts          ← [素材] ★ planImport 纯同步出计划（撞号进 variant / 哈希去重 / manifest 只补元数据）
  ├── assets/media-hash.ts                 ← [素材] SHA-256 全项目唯一实现（不可用返 undefined，**绝不换算法**）
  │      2026-08-17 从 `src/ui/lib/media-hash.ts` 迁来（分层收口）：消费方横跨两层
  │      （引擎的 content-source 算 pack 分节 hash + 前端四处写入路径），住前端就只能反向 import。
  │      前端那个路径留了转发壳，asset-zip / asset-store / audio-store / scene-image-seams 的 import 一字未改
  │
  ├── workshop/workshop-types.ts             ← [工坊 P1] WorkshopProject / 载荷与安装计划类型 + 常量
  ├── workshop/workshop-manifest.ts          ← [工坊 P1] ★纯函数：上游 JSON → 内部形状（容忍字段增删，丢弃项记 droppedNotes）
  ├── workshop/workshop-regex-map.ts         ← [工坊 P1] ★纯函数：ST 正则 → BeautifierRule（裸 pattern 与 /p/flags 两形态都吃）
  ├── workshop/workshop-install-plan.ts      ← [工坊 P1] ★纯同步 planInstall：uid 分区内重新发号 / 条目转换 / 按名匹配更新 / 冲突与丢弃收集
  ├── workshop/workshop-diff.ts              ← [工坊 P4] ★纯函数 diffInstallPlan：更新前的「这一版会改什么」
  │                                    输入是**已算好的计划**而非重拉详情 —— 预告与提交在结构上同源
  │
  ├── types/types-image.ts                ← [图像 v1] 子系统类型分册（先例 types-audio.ts）。与音频分册不同的是
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
  ├── image/image-dialect.ts              ← [图像 v2 / C4·C6] 方言的容错解析（parseImageDialects）+ 按 id 取用
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
  ├── image/image-defaults.ts             ← [图像 v1] 画质后缀 / 固定构图词 / 基础负向 / 限额初值的唯一出处
  │                                    （被 image-prompt、image-quota 与设置页 getDefaults() 共用）
  │                                    🔴 默认模型刻意**不是 Curated**：它既是过滤子集，官方规范画质后缀
  │                                       还强制带 `rating:general` —— 本项目要支持露骨内容，带上等于
  │                                       每张图都在跟自己的提示词打架。已有断言钉死这条
  ├── image/image-prompt.ts               ← [图像 v1] ★承重纯函数：场景串 + 角色/地点预设 + 世界标签 → ComposedPrompt
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
  ├── image/image-quota.ts                ← [图像 v1] 三层限额（每消息 / 滚动一小时 / 同回合去重）**唯一**判定处
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
  ├── image/image-segments.ts             ← [图像 v1] 一条正文 → 文本段/图片段序列（分段在**美化之前**且不看
  │                                    美化开关：否则美化关掉或流式途中，标记会漏成尖括号给玩家看见）
  │                                    🔴 **不许写第二个解析器** —— 调 marker-protocol 的 scanSceneImages
  │                                       拿 position 切。一个标签两个解析器就是漂移的来路
  ├── image/image-world-tags.ts           ← [图像 v1] 时段 / 天气中文 → danbooru 标签（D39）：夜里的戏不该被
  │                                    画成白天，而引擎本来就知道现在几点 —— 不必问 AI
  │                                    🔴 **映射不中的值一律不贡献标签，绝不猜**。天气是 AI 自由书写的
  │                                       短词（「小雨转晴」「血月低垂」），留空只是少一个标签，
  │                                       猜错是**在画面上画出没发生的事**。故只做精确匹配
  ├── image/image-anlas.ts                ← [图像 v1] 估算这一张会不会烧 Anlas（D43）：宽高与步数在设置里**可调**，
  │                                    调大了会**静默**开始扣费，用户只看到图变清楚了
  │                                    🔴 给的是提示不是保证 —— 判定值叫 within-free-allowance 而不是
  │                                       isFree，UI 措辞必须是「按当前订阅规则**估算**」。
  │                                       规则会变，所以数字只许出现在 NAI_ANLAS_RULES 一处，
  │                                       测试就是这条规则的文档
  │                                    🔴 **免费额度只有 Opus 有**（2026-08-04 真机催生）。`tier` 缺省是
  │                                       `'unset'` 而不是 `'opus'` —— 默认给乐观答案，等于替所有按点数
  │                                       付费的账户（Tablet/Scroll/免订阅购点）宣布「这些图不要钱」，
  │                                       而他们每张扣约 17 点。牌价与档位无关，档位只决定免不免
  ├── image/image-prompt-agent.ts         ← [图像 v1] image_prompt 侧链：装配 → callAgent → 抽取，
  │                                    **两端是纯函数，中间那次调用是唯一 I/O**（客户端从 deps 交进来，
  │                                    形状照 entity-gen-agent 的 EntityGenClient）
  │                                    🔴 抽不到 <image_prompt> 就是**明确失败**，不猜、不用启发式兜一个
  │                                       —— 兜出来的是一张没人要的图，且失败被掩盖
  │                                    模型爱在答案前写一段废话，抽取要能越过它（先例 story-rescue.ts）
  ├── character/character-appearance.ts       ← [图像 v1 / D56·D58] 外貌**属性槽**模型（九槽）+ 逐槽合并。
  │                                    🔴 `undefined` = 没说，空串 = **明确清空** —— 两者长得一样正是
  │                                       D58 要消灭的歧义（`patch.x || base.x` 会把清空悄悄退回基线）
  ├── character/character-appearance-agent.ts ← [图像 v1 / D56·D57] AI 报外貌的线格式与抽取 + 追加进 systemPrompt
  │                                    的那段规则（**格式定义与解析器同源**，写进 agent-config.json 会
  │                                    长出「提示词教它写 A、解析器只认 B」那种静默失效）
  ├── character/character-appearance-resolve.ts ← [图像 v1 / D60·D61·D62，v1.3] ★「这个角色现在到底长什么样」
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
  ├── image/providers/novelai.ts    ← [图像 v1] ComposedPrompt → NAI V4.5 请求体 / 响应 zip → PNG 字节
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
  ├── image/providers/comfyui.ts    ← [图像 v2 / C10-C13] 工作流 JSON 占位符替换 + ComfyUI 响应解析。
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
  │      入参形状提进 `types.ts` 的 `VarPathOps`；`VarsPatch` 保留，它是声明式变量补丁的载荷，
  │      现由 `var-resolver.applyPathOps` 应用（🪦 `effect-runtime.executeVarsPatch` 随脚本系统
  │      于 2026-10-03 删除），与 `applyPathOps` 的入参形状不同别再混。
  ├── api/api-tools.ts
  │   🪦 `api-router.ts` 已删（BFF 同源后端重构 Phase A+B）。路由改住 `server/routes/`
  │      （**7 个文件**：chat / models / image / embeddings / proxy / status / **content**），
  │      入口是 `server/app.ts`，引擎目录里不再有路由层，别按图找那个文件。
  │
  └── (🪦 战斗 v2/v3 架构文档均已退役：纯计算公式可参考 docs/reference/combat-system-architecture.md
       的 §四/§五/§八/§九；现役战斗真源 = `combat/sandbox/` + docs/planning/2026-10-02-combat-decode-entitygen-plan.md)
````

> 🪦 这里曾指着一行 `src/vanilla/sillytavern-store.ts`（"框架无关响应式 Store"）——该目录早已不存在，Store 由 Pinia 接管。Q-15 清仓时删掉，别按图找那个文件。

---

> 以下三节 2026-08-13 自根 `AGENTS.md` **原文**迁入（引擎层内容归引擎分册）。

## 事件驱动架构（Phase 4.5-8 实现）

> 🪦 **[2026-10-03] 本节大半已退役。** Layer 5（Script Sandbox）随战斗外 JS 脚本链整体删除，
> 其上的 EventBus / ScriptRegistry / SubscriptionManager 双 facade 机制亦已删除；下方 Layer 5 与
> 「关键架构决策」表中 EventBus / Script 执行 / 持久订阅 / EffectRuntime 四行仅存历史。
> 仍有效的是：Layer 4 的 tools 面（ADR-19 语义级）、Layer 2/1 的模块级 `$` 对象与 StateManager 唯一写入口。

```
Layer 5  脚本级 Script Sandbox  AI 写脚本: $event.on/off(持久订阅) / $call(跨对象引用)
  ↑       (AI 可编程)            🪦 [2026-10-03] 已删除 —— 脚本沙盒不复存在
Layer 4  语义级 工具面          AI 调工具: craft_check / craft_settle / declare_attack …
  ↑       (AI 可见)             = agent-tools.ts 的 27 个 tool 定义（function calling），
  │                              工具 handler 内部才去调 Layer 3。**AI 手里没有 `$` 对象**
Layer 3  流程级 Resolver        引擎内部: CraftResolver（`$craft`，craft-resolver.ts）
  ↑       (AI 不可见)           🪦 CombatResolver 随 v2 运行时删除；v3 内核（openCombat →
  │                              kernel/reducer/phases）亦随 C5a/C5b 删除，现役战斗 = combat/sandbox/ 协议沙盒
Layer 2  计算级 纯函数          $dice.d20() / $resource.getHpPercent() / $char.getTier()
  ↑       (AI 可读，不可写)      —— 这一层的 `$` 是**模块级导出对象**，见下节
Layer 1  原语级 状态读写        StateManager.commitChatState() / $validate.effectValue()
          (仅引擎内部)
```

🔴 **Layer 4 的名字变了但层还在**：v2 时代它真的是「AI 调 `$combat.attack()`」；现在 AI 那一侧
只有 OpenAI function calling 的工具名，`$` 对象一个都够不到（🪦 曾有的「脚本沙盒那份」已随脚本系统删除）。
把这层理解成「AI 声明意图的语义面」仍然对（ADR-19），只是载体从 `$` API 换成了 tools。

### 关键架构决策

> 🪦 [2026-10-03] 表中 EventBus 实例化 / Script 执行 / 持久订阅管理 / EffectRuntime 时序 / EventBus 引入时机
> 五行所描述的机制已随脚本系统整体删除，仅存历史；Agentic 模式与 System Prompt 管理两行仍有效。

| 决策                         | 选择                                | 理由                                                                                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| EventBus 实例化              | 按 SaveSlot                         | 效果实例随存档隔离                                                                                                                                                                                                                                                                            |
| Script 执行                  | **QuickJS(wasm) realm 隔离**        | $event.on/off 持久订阅 + $call 跨对象调用 + init/cleanup 生命周期。2026-08-10 起求值从 `new Function` 迁到隔离后端（SEC-02）：guest 里没有宿主 `globalThis`/`indexedDB`/`fetch`，够不到 Dexie 与 API Key；墙钟 50ms 预算。装不上 **fail-closed**（脚本一行不跑），**绝不回落 `new Function`** |
| 持久订阅管理                 | subscription-manager.ts             | 递归保护(≤10) + 僵尸兜底(unregisterAll)                                                                                                                                                                                                                                                       |
| EffectRuntime 时序           | 管线完成后批量执行                  | 保持 DAG 原子性                                                                                                                                                                                                                                                                               |
| EventBus 引入时机            | Phase 7e+8（已完成）                | 与 Script 系统同步上线                                                                                                                                                                                                                                                                        |
| Agentic 模式                 | OpenAI function calling (Phase 8.5) | craft_gen/entity_gen 通过 tools 调用真实 Code 函数，禁止 AI 编造数值                                                                                                                                                                                                                          |
| craft_request 时序           | 延迟型 (对齐 combat_trigger)        | Stage 1 暂存 → Stage 2 统一执行，避免阻塞叙事                                                                                                                                                                                                                                                 |
| System Prompt 管理 (Phase 9) | agent-config.json 唯一来源          | 所有 Agent 的完整 systemPrompt 存在 agent-config.json；agent-templates.ts 只留 stub + 动态上下文函数。🔴 **story 例外**：预设短路，行为真源是预设条目——细节见架构图里 agent-config.json 那条                                                                                                  |

### 效果系统统一框架（战斗+制作共用，ADR-29）

> 🪦 **[2026-10-03] 本节已整体退役。** 战斗 v2 的「统一 subscribeChain 链式管道」其 Code 侧机制
> （`EventBus.emitChain` / `ScriptRegistry` + `SubscriptionManager` 双 facade / `effect-wiring` /
> `subscription-manager` / `game-event` / `effect-runtime`）随**战斗外 JS 脚本链**（Phase 1b·1c）与
> **v3 战斗内核**（Phase 2）一并删除，历史正文不再逐条保留。
>
> 现役替代：战斗 = `src/core/combat/sandbox/`（单一 DM 协议沙盒，AI 读 v1.4.2 协议自算、Code 只持
> 权威 `CombatState` + 只读计算工具 + 终局白名单写回）；战斗外效果 = 声明式 `VarsPatch` / `StatusEffect`
> 经 dispatcher 管线落地（ADR-20/21）。设计与裁定全文见
> `docs/planning/2026-10-02-combat-decode-entitygen-plan.md`。

## v4 三层子系统分流 (ADR-24/25/26)

```
SubSystem-Craft  制作  → 🚩 延迟型: Story 输出 <craft_request>，Stage1 暂存 → Stage2 执行 craft_gen Agent
                          → AI 调 tools (get_inventory→craft_check→craft_settle) → 真实 DC+骰值+评级+结算 (Code)
                          → 创意效果 (AI) → 结果注入正文 + StatePatch 提交
SubSystem-Combat 战斗  → Stage1后检测 <combat_trigger> → 暂存 → Stage2 request_dispatcher 完成 entity_gen 角色生成后唤起
                          → 独立战斗窗口: **协议驱动沙盒**（`combat/sandbox/`：单一 combat DM 读 v1.4.2 协议自算，
                             Code 只提供只读计算工具 + 终局写回）；战斗状态归 AI 会话内存并落 Dexie `combatSandboxes`
                          → 主持人终局叙事回注正文 + 批量 StatePatch
SubSystem-EntityGen 实体 → Stage2 request_dispatcher 检测到 <entity_gen_request> → entity_gen Agent 调 tools
                          → 输出 <entity_result> XML（角色/技能/装备/道具/状态/登神，一次产全）→ 下回合可用
                          🔴 2026-10-02 硬改名：原 char_gen + item_gen 两链合并（不再有 ADR-26 的二次调用）
```

🪦 上表 Combat 一行原写作「Code循环 + AI摘要」（v2 combat-runner），后来经历过 v3 内核（kernel/reducer/
phases/automata，AI 用 `declare_attack` 等工具主持）—— v3 内核已随 C5a/C5b 整体删除，现行是
`combat/sandbox/` 的**协议驱动沙盒**（单 DM 读协议自算，Code 只做计算与终局写回）。

### AI 能碰到的 `$` 面 = 脚本沙盒那一份（🪦 已退役）

> 🪦 **[2026-10-03] 本节已退役。** `script-executor.ts` 的 `ScriptSandbox`（`$dice` / `$resource` /
> `$char` / `$status` / `$event` / `$call` 与 `owner`/`target`/`event`/`self` 上下文变量）随**战斗外
> JS 脚本链**（Phase 1b·1c）整体删除，实体 `scripts` 池同步清出 —— **AI 可编程的 `$` 面已不存在**。
>
> ✅ **世界书 EJS（ADR-30）不受影响**：`ejs/` 的 QuickJS 沙盒与 `stats`/`vars` 两轴注入照常工作，
> 与本次脚本退役无关。创作者规范见 `docs/reference/worldbook-ejs-regex-authoring-guide.md`。
>
> 引擎侧的 `$craft` / `$var` / `$time` / `$validate` / `$location` / `$affection` 等**模块级导出对象**
> 与 `char-query.ts` 的 `$char` 不受影响（它们从来不在脚本沙盒里，只供引擎 TS import；AI 那一侧对应
> 的是 agent-tools 的工具名）。

### 2026-09-05 可靠性契约补注

- 🪦 [2026-10-03] `reconcileEffectWiring(saveId, characters)`（战斗外效果接线对账）随 `effect-wiring.ts` 删除，此条作废。
- `StateManager.commitAiPatches` 为明确的 best-effort AI 接口，`commitChatState` 保留兼容；`commitDomainCommand` 在同一 save lock 与 Dexie 事务内整批提交，失败抛出且不发布事件。制作、战斗、物品生成/重铸使用后者。领域命令的 `delta_variable profile.fp` 调用既有 FP 账务函数，不写入故事变量。
