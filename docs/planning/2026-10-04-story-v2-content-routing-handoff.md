# Story 上下文 v2 与内容路由：会话交接

日期：2026-10-04

用途：保留原第 1–8 批交接记录。后续第 9–11 批及本轮 A01–A14 修复的最新状态以[交付说明](../reference/story-v2-routing-delivery.md)、[验收记录](2026-10-04-story-v2-content-routing-acceptance-progress.md)新增修复章节和 CHANGELOG 为准；本页第 4–5 节是历史待办，不代表当前代码。用户本轮确认：归档失败绑定原判断回合自动重试，补摘要语义字段，第一版激活规则正式收敛，真实 LLM/实机/全量逐条语义验收继续暂缓。原计划按实现与验收拆分勾选，不以历史“9 项问题”或修复前 gates 判本轮结论。代码仍未提交、未推送、未发布。

## 1 依据文档

- [Story 上下文与记忆计划](2026-09-30-story-context-memory-content-routing-plan.md)：第 14 节 P0–P8 是任务清单，第 16 节 Q01–Q15 是待定事项。
- [内容包生成与条目路由计划](2026-10-02-content-pack-routing-compatibility-plan.md)：第 9 节 C0–C5 是任务清单。
- [Story 实验模式摘要](2026-10-02-story-context-v2-implementation.md)：实施任务清单。
- 引擎与前端分册：`src/core/AGENTS.md`、`src/ui/AGENTS.md`（改对应目录前必读）。
- 内容组合工具仓：`D:/WorkSpace/Independend-Frontend-Assets`（独立 git 仓；后续已实施路由与构建工具，当前有未提交改动；原干净基线仅为历史记录）。

## 2 工作约束（来自根 AGENTS.md 与用户要求）

- 回复用中文；用户未要求时不提交、不推送。
- 只对实际改过的文件跑 `npx prettier --write <文件>`，不跑仓库级 `npm run format`。
- 用脚本改过含中文的文件后做编码检查（U+FFFD = 0、非法控制字符 = 0、JSON 可解析），命令见根 AGENTS.md。
- 交付前跑 `npm run gates`。原交接时根 AGENTS 格式失败是历史状态；后续已实际更新进度并格式化，完整 gates 已通过。仍需注意：既有测试通过不等于新增边界验收通过，修复后必须重跑。
- `knip:ratchet` 不许新增未用导出：新导出没人用时改为不导出。
- 测试 tsconfig 不支持 `.at()`，用下标访问。
- 并行工具调用的执行顺序不保证，编辑后要重新读一遍确认。

## 3 已完成的批次

### 第 1–5 批（上一会话，已全部过闸门）

- 测试档标记与准入：`src/core/story/story-context-mode.ts`；开关 `settings.storyContextV2Enabled`，默认关闭。
- 五区占位条目：`src/core/prompts/story-zone-placeholders.ts`；旧模式展开为空。
- 分区组装：`src/core/prompts/story-context-v2.ts`，绕过 Delta。
- 第 4 区：`src/core/memory/memory-context.ts`。
- 每回合摘要与归档判断：`story-turn-summary.ts`、`story-archive.ts`、`story-archive-detail.ts`。
- 存储：Dexie v27 `storyTurnSummaries`、v28 `storyArchives`；`commitStoryTurnMemory` 按回合整体替换。
- 召回：`src/core/memory/story-recall.ts`，复用 LLM / Embedding 两种模式。
  - 编排器用 `callStoryRecall` 处理 v2 回合的召回；Embedding 走 `memory-store.recallByEmbedding`。
  - v2 管线先跑召回，剧情前置检查等召回完成再跑。
  - 召回结果进第 5 区「相关回忆」；原文粒度由 `settings.storyRecallRawMode` 切换。
- 记忆面板：`src/ui/components/game/StoryMemoryV2Panel.vue`。

### 第 6 批：Story 侧收尾（完成，相关测试已通过）

- **摘要补建（Q10）**：`GamePipeline.backfillMissingStorySummaries`。
  - 每回合落库后补建缺摘要的回合，最多 2 个；只写摘要，不做归档判断；该回合已有的归档原样保留。
  - 补不上会提示，下一回合再试。
  - 涉及 `memory-context.findStoryTurnsMissingSummary` 和 `story-turn-summary.buildStoryTurnBackfillMessages`。
- **上下文超限**：`story-context-mode.assessStoryContextBudget`（字数 ÷ 1.5 粗估 token），超过端点的 `contextWindowTokens` 时提示各区用量。
- **调试记录**：
  - 类型在 `types.ts`：`DebugTurnRecord.storyContext?: StoryContextDebugRecord`，包含 assembly / recall / lore / backfill。
  - `StoryContextV2Diagnostics`、`StoryRecallReport`、`StoryRecallExpansionDiagnostics`、`StoryLoreSelectionDiagnostics` 已迁入 `types.ts`。`lore` 字段先定义好，留给第 9 批填。
  - 写入：`game-store.recordStoryContextDebug`、`GamePipeline.recordStoryContextDebug`。
  - 展示：`DebugPanel.vue` 新增「Story 分区」一节。
- **切换开关时退出存档**：`DeveloperSection.vue` 监听开关；当前存档在新模式下不被准入时，`clearActive`，并把 `game` 从 `ui.viewHistory` 里去掉。
- **设置说明**：`MemorySection.vue` 在新模式下显示说明卡。
- **三协议消息顺序测试**：在 `tests/core/prompts/story-context-v2.test.ts` 末尾。
- **新增文案**：`src/ui/lib/story-context-admission.ts` 加了超限、补建失败、召回失败三条提示。

### 第 7 批：条目路由与读取范围（源码完成）

- **新模块 `src/core/content/lore-routing.ts`**：
  - 可见性只由 `isLoreEntryVisibleTo` 判定：条目 `extra.lore.audiences` 优先，缺席时继承书级 `WorldBook.lore.audiences`。
  - 读取范围逐条目声明（`extra.lore.audiences`）；书级 `lore.audiences`/`section` 与旧包兼容映射（`deriveLegacyBookAudiences` / `applyLegacyLoreAudiences` / `BUILTIN_BOOK_AUDIENCES` / `DEFAULT_WORKSHOP_AUDIENCES`）已移除。
  - `collectLoreRoutingIssues` 给出诊断：无读取范围、未知 Agent、重复键、依赖缺失、依赖不可读。显式写 `audiences: []` 不算缺失。
  - 另有 `routeLoreEntriesForAgent`、`loreEntryKey`（派生值为 `书id#uid`）、`loreEntrySection`。
- **类型（`types.ts`）**：新增 `LoreSection`、`LoreActivation`、`LoreEntryMeta`、`LoreBookMeta`；`WorldBookEntry.extra.lore`、`WorldBook.lore`；删除了 `AgentConfig.worldBookIds`。
- **读取接口**：`getEntriesForAgent(agentId, books)` 改为两个参数。调用方已全部改完：`agent-templates`（`charLoreBook` 取第一本可读的书）、`placeholder-registry`、`prompt-session-assembler`、`story-context-v2`、`create-store` 的大纲路径。
- **`game-pipeline.ts`**：
  - `loadPresets()` 额外返回 `legacyBookAudiences`。
  - `loadActiveWorldBooks(legacy)` 补映射，并对无读取范围的条目打 warn。
  - `buildAgentConfigs` 不再设置 `worldBookIds`。
  - 删除了 `collectSelectedSystemCoreWorkshopBookIds` 和 `loadSystemCoreWorkshopBookIds`。
- **占位内容**：
  - `public/data/worldbooks/*.json` 写入了书级 `lore.audiences`，取值等于退役前实际生效的范围。
  - `public/data/defaults/agent-config.json` 删除了全部世界书字段。
  - `src/core/content/placeholder-hashes.json` 升到 `1.1.0`。`content/map-pack` 的 hash 一并更新：旧值本来就和仓库里的地图包不一致。

### 第 8 批：退役 Agent 世界书配置（源码完成）

- **`agent-settings.ts`**：
  - `AgentSettingsEntry` 删除了两个世界书字段；`updateAgentWorldBookIds` 已删除。
  - 新增 `retireAgentWorldBookOverrides`：把覆写层里的这两键移进暂存键 `legacyAgentWorldBookOverrides`。
  - 新增 `legacyStashBookAudiences`。
- **`settings-store.ts`**：在指纹迁移之后调用退役函数；暂存交给 `worldbook-store.adoptLegacyAgentWorldBooks`，只给**玩家自建书**写书级读取范围，成功后删除暂存。
- **`worldbook-store.ts`**：新增 `adoptLegacyAgentWorldBooks`、`setBookAudiences`。
- **工坊**：
  - `workshop-store.ts` 去掉了装书授权和卸载收回。
  - `workshop-types.ts` 删除了 `grantWorkshopBookToAgents` 和 `revokeWorkshopBookFromAgents`。
- **界面**：
  - `AgentParamsCard.vue`：世界书卡改为只读的「世界书读取范围」列表。
  - `AgentUpdateCenter.vue`：去掉了两个字段的标签。
  - `WorldBookEditor.vue`：新增「读取范围」面板，只有自建书可编辑。
  - `WorldBookSection.vue`：新建或导入的书默认 `audiences: ['story']`；导入文件自带声明时保留。
- **兼容**：`types-content.AgentProjectDefaults` 的两个世界书字段改为可选，并标为已退役；`agent-settings-migration` 的旧 map 照常折入，之后由退役函数移走。

## 4 当前状态（交接时实测）

- `npm run typecheck`、`npm run typecheck:vue`、`npm run typecheck:tools` 均为 0 错误。
- 改过的源码目录跑 lint 通过；`tests/` 目录和整仓 lint 尚未跑。
- `npm run test:run`：419 个文件，**2 个失败**，9729 个通过。两处都只是预期值没跟着改：
  1. `tests/build-placeholder-hashes.test.ts`：「byBook 与当前 public/data/worldbooks 同步」断言版本为 `1.0.0`。改成 `1.1.0`，或核对该用例的预期（版本是有意升的，见第 7 批）。
  2. `tests/ui/components/settings/agent/AgentUpdateCenter.test.ts`：「覆写字段标签中文化」期望出现「世界书开关」。从断言里去掉世界书标签，或把夹具里的覆写字段换成现存字段。
- **需要复核的测试改动**：上一会话把测试迁移交给子任务，子任务中途被用户中断。下列文件的改动里有一部分出自它，需要逐个看语义是否保留原意（尤其是「看不到某本书」类断言是否改成了读取范围排除）：
  - `tests/core/combat/coordinator.test.ts`
  - `tests/core/content/worldbook-loader.test.ts`
  - `tests/core/fixtures/prompt-session/prompt-session-fixture.ts`
  - `tests/core/prompts/agent-templates.test.ts`、`placeholder-registry*.test.ts`、`prompt-session-assembler.test.ts`、`prompt-session-store.test.ts`、`template-resolver.test.ts`
  - `tests/core/workshop/workshop-types.test.ts`
  - `tests/ui/components/settings/agent/agent-defaults.test.ts`
  - `tests/ui/stores/agent-settings.test.ts`：确认补上了 `retireAgentWorldBookOverrides` 和 `legacyStashBookAudiences` 的用例。
  - `tests/ui/lib/game-pipeline.test.ts`：确认删掉了 system/core 相关用例，并检查是否补了 `loadActiveWorldBooks` 的映射用例。
  - `tests/core/agents/agent-orchestrator.test.ts`：其余改动来自本任务前几批，已验证。
- **尚未覆盖测试的新代码**（建议补）：`lore-routing.ts` 的单元测试；`worldbook-store.adoptLegacyAgentWorldBooks`；`WorldBookEditor` 的读取范围面板；`AgentParamsCard` 的只读列表；`placeholder-content.test.ts` 是否已改为「每本占位书都有显式 `lore.audiences`，且 `agent-config.json` 没有世界书字段」。
- **文档**：第 6–8 批的内容还没写进三份计划文档和 `src/core/AGENTS.md`（`lore-routing.ts` 的索引、`getEntriesForAgent` 语义变化、退役说明）。
- `npm run build`、`lint`（整仓）、`knip:ratchet`：本会话第 6 批之后都没跑过。

## 5 剩余工作

### 第 9 批：资料选择与第 3 区（计划 P3 / 内容 C3）

上一会话拟定的方案（尚未实现）：

- **新模块 `src/core/content/lore-selection.ts`（纯函数）**：在 story 可读条目里按 `section` 分组。
  - 缺 `section` 的条目：静态条目视为 `fixed`；含 EJS 等动态内容的视为 `turn` 必选。这样旧内容在 v2 下的表现和现在一致。
  - `region` 条目：`activation.locations` 与玩家位置路径的任一完整层级逐字相同即命中。位置路径的分隔规则需核对 `location-db` / 地图模块。（🔴 2026-10-10 已裁定放宽为**包含**命中：玩家路径任一层级包含声明字串即命中，见交付说明；代码已按此裁定实施，本段为历史待办。）
  - `turn` 条目：用本轮输入、最近几回合文本、在场人物（与玩家同地点的角色，需核对 `CharacterState.location`）求 `activation`。
    - 排除词优先，且是硬条件。
    - `required` 的条目为必选，其余为候选；软条件不满足的进「补充池」。
  - `dependsOn` 只在读取范围内展开，读不到的记为 `blockedDependencyKeys`。
- **lore_select Agent**：新 agentId `lore_select`，只在 v2 管线里调用，位置在剧情前置检查之后、Story 之前。
  - 输入候选清单（编号、名称、摘要、篇幅）和补充池，输出 `{ keep, extra, reason }`。代码校验编号，补充有数量上限。
  - 没有候选时不调用。调用失败、输出认不出或未配置端点时，回退为「必选 + 全部候选」，并写诊断。
  - 端点和模型：建议复用某个现有 Agent 的配置，或在 `buildAgentConfigs` 的名单里加 `lore_select`。agent-config 默认值和 `AGENT_LIST` 的展示需要同步。
- **组装**：在 `story-context-v2.ts` 里，第 1 区放 fixed 条目，第 3 区放 region 条目，第 5 区放选中的 turn 条目和动态条目。
  - 只对选中条目跑一次 EJS（`prerenderWorldBookEntries` 需要能按条目给出结果，或对选中集合整体跑一次）。补一条「每轮 EJS 只求值一次」的测试。
  - `StoryContextV2Diagnostics.loreKeysByZone` 和调试记录里的 `lore` 由这里填写。
- **第 3 区快照键**：区域路径加内容 hash，写进诊断。排序确定，因此区域不变时字节稳定。

### 第 10 批：内容仓生成端（内容 C1）

- 条目级路由放在侧车文件（如 `data/routing/lore-routing.json`），书级读取范围可以直接写在书 JSON 里。原因：`import-character-card.mjs --apply` 会按角色卡重建条目，条目上的新字段会被清掉；书级字段由 `{...currentBook}` 保留下来。
- `build-pack.mjs`：
  - 把侧车合并进条目的 `extra.lore`；支持 `parts` 显式拆分（子项有稳定 uid / key / parent，构建只输出子项）。
  - 第 94 行的检查从「必须有 `worldBookIds`」改为「不允许再有」。
  - 新增检查：每本书或条目都有读取范围、Agent ID 合法、`section` 值合法、引用存在、依赖无环、父子正文不重复。
- `data/defaults/agent-config.json`：删除世界书字段。需要逐字节编辑：`edit-agent-config.mjs` 只能改字符串字段。改完做编码检查。
  - 书级读取范围按当前 agent-config 的实际效果推出（story 列表里有 6 个不存在的书 id，item_gen 在内容仓里是开启的，要确认）。
- `build-agent-fingerprints.mjs`：去掉两个世界书字段；默认输出路径已过期（应为引擎的 `src/core/agents/agent-defaults-fingerprints.json`）。引擎侧保留旧指纹即可。
- `tests/agent-framework/test_agent.ts`（第 274–322 行）依赖 `worldBookIds`，需要改成按读取范围取书。
- 代表性样例：一座城市加子区域、一名有种族依赖的人物、一组活动条目、一个用 `parts` 拆分的大型混合条目。
- 内容仓规则：跑 `node tools/scan-secrets.mjs .`，做编码检查。构建 pack 后，在引擎仓设置 `POEM_PACK_FILE` 并跑 `npx vitest --run tests/contract`。

### 第 11 批：文档与交付（计划 P8 / 内容 C5）

- 更新三份计划文档的勾选项与状态，并关闭 Q09、Q10、Q11、Q14、Q15 等的说明（见第 6 节）。
- 更新 `src/core/AGENTS.md`、`src/ui/AGENTS.md` 的索引。根 `AGENTS.md` 只改进度速览，不修它既有的格式问题。
- 在 `docs/CHANGELOG.md` 追加交付记录。
- 数据字典与内容作者指南：内容仓的 `README.md` 和 `data/worldbooks/README.md`，写清路由字段、读取范围与拆分规则。
- 全部闸门，以及跨仓契约测试。

## 6 已做出的临时决定（新会话需在汇报中向用户说明）

- **Q09**：正文窗口 N 继续复用正文 Agent 的「历史层数」，未设置时默认 6。
- **Q11**：普通条目的消息角色沿用临时规则（第 4 区原文之前进 system，之后进末尾 user）；归分区负责的旧占位符在新模式下渲染为空。
- **Q14**：复用现有召回。原文总量上限 12000 字，属于临时值。
- **Q15**：召回失败时输出为空，只提示、不阻断；归档被拦下时事件保持未结；摘要失败交给补建。
- **CQ01**：没有声明的第三方条目不注入，只留诊断。工坊书用工坊默认范围。玩家自建书默认只给正文，可在编辑器里改。
- **内置书**：玩家以前改过的读取清单不保留，以内容声明为准。玩家自建书会按旧设置迁移。
- **D32 原文粒度**：做成开发者设置让玩家切换，而不是由模型自动选择。

## 7 原交接待用户裁定或确认（历史）

下列三项已获得本轮确认：独立 lore_select 配置、代表性跨仓样例、沿用第 6 节临时规则。正式效果策略、归档失败可靠恢复 R01 与可选手动纠正 Q08 仍需另行裁定，不把实现临时方案当成全部产品验收。

- 第 9 批 lore_select 用哪个端点和模型；补充数量上限；回退策略是否接受「必选 + 全部候选」。
- 第 10 批要改动内容仓：属于跨仓修改，开始前最好向用户确认范围。真实语料只给书级读取范围加代表性样例，还是全量逐条复核？
- 上面第 6 节的临时决定是否需要调整。
