# Plan: 修复 GamePipeline 未注入 story 预设与内置世界书

> 状态: **只读 plan，未动代码**。留待新对话开工。
> 根因来源: 2026-07-15 实际游玩导出 `tests/realtime_export/fated-poem-debug-3acc4d33-1784079233671.json` + `log.txt`。
> 关联记忆: `gamepipeline-missing-preset-worldbook.md`、`itemgen-chain-design.md`

---

## 一、根因（已核实，file:line 准确）

### 1. Story Agent 拿不到完整 systemPrompt（思维链缺失）

- `data/defaults/agent-config.json` 中 **只有 `story`** 的 `systemPrompt` 和 `template` 为空字符串；其它 10 个 Agent 都有内容。
- story 靠 `presetId: "8431782f-c4d3-4c8a-bb21-c6f68d4600bb"` 指向一个 SillyTavern 预设，`preset.settings.prompts` 有 **101 条** prompts，运行时由 `assemblePresetContent` 装配成 SYS_PROMPT。
- `agent-templates.ts:325` `if (agentId === 'story' && presets && config?.presetId)` 才装配预设；`presets` 必须由 `buildAgentMessages` 的 `presets` 参数传入。
- `buildAgentMessages` 在 `agent-templates.ts:312` 取 `config?.template`，story template 空 → 走 `getDefaultTemplate('story')`（`placeholder-registry.ts:280`：`{{SYS_PROMPT}}\n{{AGENT.MEMORY_RECALL}}\n...{{USER_INPUT}}`）。这条路径只装配 `{{SYS_PROMPT}}` 局部为预设法，它 fallback 链（`agent-templates.ts:325→333→338`）依次尝试：preset 装配 → `config.systemPrompt`（空）→ `fixedSystem` stub（162 行「命定之诗叙事引擎…完整提示词见 agent-config.json」）。
- **结果**: 运行时 `presets` 为空 → story SYS_PROMPT 退化为单行 stub。思维链要求/输出格式规范/叙事规则从未注入。导出 `_msg_story.json` 已证实 —— system 消息开头就是那行 stub，后面跟 `[object Object]` 和 character state。

### 2. Orchestrator 拿不到 presets，也拿不到内置世界书

- `src/sillytavern/agent-orchestrator.ts:31-36` `OrchestratorOptions` 接口**只有** `pipeline / context / agentConfigs / endpoints / saveId` —— **没有 presets、没有 worldBooks 字段**。
- `agent-orchestrator.ts:127-128` 构造时 `this.worldBooks = options.worldBooks ?? []`、`this.presets = options.presets ?? []` —— 写了用 `options.*` 但接口没声明这两个字段，永远是 `[]`。
- `src/ui/lib/game-pipeline.ts:85-91` 构造 orchestrator 的 `options` 对象里**没传 presets / worldBooks**。
- `game-pipeline.ts:219 buildContext` 里 `worldBooks: []` 写死。
- `buildAgentMessages` 调用处 `agent-orchestrator.ts:356-363`：`buildAgentMessages(config.agentId, this.context, configsArr, this.worldBooks, this.presets, undefined)` —— 传的就是 orchestrator 的空 `this.presets`/`this.worldBooks`。
- **结果**: 所有 Agent 的 `{{LORE_BOOK}}` 注入空；存档 `enabledWorldBookEntries` 里 `system_core:413`（命定核心）、`character:3xx` 等条目**从未注入任何 Agent**。命定核心即使写进开场白，story 也读不到世界书层的核心设定。

### 3. 已具基础设施（不用新建，runtime 接上即可）

- **预设已 seed 进 DB**：`src/ui/stores/settings-store.ts:273-290` `loadAgentProjectDefaults` 首次启动会把 `entry.preset` 写进 IndexedDB `presets` 表。`src/sillytavern/database.ts:368 getPresets()` 返回 `ChatPreset[]`（`ChatPreset` 含 `id` + `settings.prompts`，即 `assemblePresetContent` 实际读取的形态）。
  - ⚠️ 类型陷阱：`preset-loader.ts:213 getPreset(id, presets)` 签名要 `AgentPreset[]`（旧简化结构，只有 fixedSystem/fixedExamples），但 `assemblePresetContent:231` 内部用 `(preset as any).settings?.prompts` 读 ChatPreset 形态 —— 实际靠 `as any` 蹭。**plan 里传 `getPresets() as unknown as AgentPreset[]` 给 orchestrator 即可**，同样靠 `getPreset` 按 `p.id` 匹配 + `assemblePresetContent` 按 `settings.prompts` 装配。
- **内置世界书已有加载器**：`src/sillytavern/builtin-worldbooks.ts:30 loadBuiltInWorldBooks()` 返回 `WorldBook[]`（含 `partition`/`entries[].uid`）。`create-store.ts:311` 已在用。
- **worldbook 过滤管线已存在**：`worldbook-loader.ts:76 getEntriesForAgent(agentId, configs, books)` 按 `config.worldBookIds`（世界书 id 白名单）筛书 → `worldbook-loader.ts:101 filterActiveEntries` 按 constant/keyword 激活。⚠️ 注意 `enabledWorldBookEntries`（存档级，键格式 `partition:uid`，如 `system_core:413`）和 `config.worldBookIds`（世界书 id）是两套不同的过滤维度 —— 见下方「坑 2」。

### 4. `[object Object]` 与开场白重复注入（疑似同根，需开工时追）

- 导出 `_msg_story.json` 第一段 stub 之后出现字面量 `[object Object]` → 某个 placeholder resolver（很可能 `{{AGENT.MEMORY_RECALL}}` / `{{AGENT.PLOT_PRE_CHECK}}` / `{{GAME_TIME}}` 在空数据时返回了对象被 `String()` 拼接）需要开工时在 `placeholder-registry.ts` 定位。
- 开场白 user 消息在 system 消息里**重复注入两次**（一次在 character state 后，一次在末尾）→ `{{NARRATIVE}}` + `{{USER_INPUT}}` 在首回合都灌了同一份开场白。可在 `placeholder-registry.ts` 的 `NARRATIVE` / `USER_INPUT` resolver 首回合行为里追。

---

## 二、要修的文件与改动

### 改动 A — OrchestratorOptions 增加 presets / worldBooks 字段

**文件**: `src/sillytavern/agent-orchestrator.ts`

- `OrchestratorOptions`（31-36 行）增加两字段：
  ```ts
  worldBooks?: WorldBook[];
  presets?: AgentPreset[];   // 实际传 ChatPreset[] as unknown as AgentPreset[]
  ```
  （需 import `AgentPreset`、确认 `WorldBook` 已 import，应已 import @ line 113 `private worldBooks: WorldBook[]`。）
- 构造函数 127-128 已有 `?? []` 兜底，逻辑无需改 —— 加字段后即可从 options 拿到。
- **测试影响**: `agent-orchestrator.test.ts` 可能构造了 `OrchestratorOptions` 对象 —— 新增可选字段不会破坏既有用例，但新测试要覆盖「传了 presets/worldBooks 后 buildAgentMessages 能用到」。

### 改动 B — GamePipeline 从 DB 加载预设 + 从内置世界书加载，传给 orchestrator

**文件**: `src/ui/lib/game-pipeline.ts`

- `buildContext`（219）不再把 `worldBooks: []` 写死，但 worldBooks 属 orchestrator 级而非 AgentContext 级 —— 建议保留 `AgentContext.worldBooks: []` 不动（agent-templates 走的是参数注入而非 ctx.worldBooks），把世界书通过 `OrchestratorOptions.worldBooks` 传。
- `run()`（67）里构造 `options`（85-91）前，加异步加载：
  ```ts
  const presets = await this.loadPresets(); // getPresets() as unknown as AgentPreset[]
  const worldBooks = await this.loadActiveWorldBooks(); // 按 save.enabledWorldBookEntries
  ```
  然后把 `presets`、`worldBooks` 放进 `options`。
- 新增私有方法 `loadPresets()`：`const { getPresets } = await import('@engine/database'); return (await getPresets()) as unknown as AgentPreset[]`
- 新增私有方法 `loadActiveWorldBooks(): Promise<WorldBook[]>`：
  1. `const all = await loadBuiltInWorldBooks()`（import `@engine/builtin-worldbooks`）
  2. 读存档级 `enabledWorldBookEntries`：`this.game.activeSave?.metadata?.enabledWorldBookEntries ?? []`（键 `partition:uid`）
  3. 用 `enabledWorldBookEntries` 过滤 `all`：保留 partition+uid 命中的 book，并可能只保留命中的 entry（见坑 2 决策）。
  4. 返回过滤后的 `WorldBook[]`。
- ⚠️ `run()` 当前不是 async 的全部前置加载都已 await（buildAgentConfigs/buildEndpoints/buildContext 同步）—— 加两个 `await` 没问题，`run` 已是 async。

### 改动 C — 确认 enabledWorldBookEntries (partition:uid) 与 worldBookIds 的协同

**坑 2 决策点（开工时定）**：两个维度并存：

- `config.worldBookIds`（`game-pipeline.ts:187`，来自 `s.agentWorldbookIds[agentId]`）：每 Agent 的世界书 **book id** 白名单。`getEntriesForAgent` 按它筛书。
- `save.metadata.enabledWorldBookEntries`（存档级，键 `partition:uid`）：创角时勾选的具体**条目**。

当前 `getEntriesForAgent`（worldbook-loader.ts:76-95）只用 `config.worldBookIds` 筛书，**完全没看 `enabledWorldBookEntries`**。这意味着内置世界书里 partition=`system_core`/`character` 的条目，只要 book id 在某 Agent 的 `worldBookIds` 里就会激活 —— 没用到存档级的精细勾选。

**方案二选一（开工时与主人确认）**：

- (a) **最小改动**：`loadActiveWorldBooks` 把 `enabledWorldBookEntries` 命中的 book 整本返回，并把这些内置 book id 注入每个相关 Agent 的 `worldBookIds`（或直接全 Agent 注入内置书）—— 让 `getEntriesForAgent` 自然激活。简单但粒度粗（按 book 激活，不走 partition:uid 精细勾选）。
- (b) **精细改动**：在 `worldbook-loader.ts` 增加一条「存档级勾选覆盖」—— 若 `save.enabledWorldBookEntries` 非空，则 system_core/character 分区里只有 uid 命中的 entry 才激活，其它分区走原 keyword 逻辑。粒度对齐创角勾选，但触及 worldbook-loader 共享管线，测试影响大。

**推荐先做 (a) 让链路通**，(b) 作为后续 follow-up（与本 plan 记在一起的「遗留」）。

### 改动 D — 追修 `[object Object]` 与开场白重复注入

**文件**: `src/sillytavern/placeholder-registry.ts`

- 找到 `AGENT.MEMORY_RECALL` / `AGENT.PLOT_PRE_CHECK` / `GAME_TIME` resolver（导出 story 已见这些段落缺失 → 返回对象/对象字符串）。让空数据时返回 `''` 而非 object。
- 找 `NARRATIVE` / `USER_INPUT` resolver，区分首回合（开场白）行为，避免同一份开场白灌两次。
- 工程上可单独 git commit / 单测，与本主线解耦。

---

## 三、验证清单（开工后逐项过）

1. `npm run typecheck` — 0 错误。
2. `npm run test -- --run` — 65 文件全过；新增 GamePipeline 集成测试（用 fake-indexeddb + mock fetch `/data/worldbooks/*.json` 与 `/data/defaults/agent-config.json`）覆盖：orchestrator 拿到非空 presets/worldBooks → `buildAgentMessages('story')` 的 SYS_PROMPT 含真实预设内容（非 stub）。
3. **实测导出复跑**：在浏览器跑一轮开场白，F12 导出 → 检查 `agentLog[story].messages[0].content`：
   - 不再以 stub「命定之诗叙事引擎…」开头；含预设正文（思维链/格式规范段）。
   - 不再出现字面量 `[object Object]`。
   - 开场白 user 文本不再重复两次。
   - `{{LORE_BOOK}}` 段含 `system_core:413`（命定核心）activated entry。
4. story 正文能体现命定核心的世界观影响（人工肉眼）。

---

## 四、不在本 plan 范围（记为遗留，单独修）

- `applyRemoveItem`(`state-manager.ts:459`) 按 `itemId` 查 vs orchestrator `agent-orchestrator.ts:872` consume patch 传 `{name, quantity}` 的 id/name 错位 → 「消耗已有物品」路径可能落不了库。
- 装备槽位中英文混用：item_gen 输出中文 slot（武器/身体），`applyEquipItem:480` 用 `slot === 'weapon'` 判定类型。本已有 `item-gen-chain.ts` 按中文原样存能落库，但类型判定会误判。需统一槽位命名（DB 迁移或 normalization 层）。
- `buildOpeningPrompt` 命定核心已修（SystemCoreEntry 优先），本 plan 修完世界书注入后复测正文是否体现。
- 文档同步：`CLAUDE.md` 架构（新增 item-gen-chain、GamePipeline 注入预设/世界书）+ `reference/agent流程测试/agent预期分析.md` item_gen 缺口。

---

## 五、已完成的（本 plan 之前，同会话）

- ✅ 新建 `src/sillytavern/item-gen-chain.ts` + `item-gen-chain.test.ts`（11 测试）打通 `<item_gen_request>` → item_gen Agent → 落库。
- ✅ `game-pipeline.ts:346` `onItemGenRequest` stub 接通 `runItemGenChain`。
- ✅ `data/defaults/agent-config.json` 的 vars_update systemPrompt 加第 8 条禁令 + items 格式块注释，禁止 AI 自塞 `items.add`。
- ✅ `create-store.ts:758` `buildOpeningPrompt` 优先读 `selectedSystemCoreEntry`（命定核心世界书条目）写进开场白；create-store.test 加分支测试（76 测试全过）。
- ✅ typecheck 0 错误 / 全量 2593 测试 PASS（完成上述 item-gen-chain 那批时的状态；buildOpeningPrompt 改动后仅跑了 create-store.test 76 通过 + typecheck，未重跑全量）。

---

## 六、新对话开工建议顺序

1. 改动 A（agent-orchestrator.ts 接口加字段）—— 最小、纯类型。
2. 改动 C 先定方案 (a)/(b) —— 与主人确认粒度。
3. 改动 B（game-pipeline.ts 加载 + 注入）—— 主菜。
4. typecheck + 全量测试 + 新增 GamePipeline 集成测试。
5. 浏览器实测复跑导出验证（清单第 3 条）。
6. 改动 D（[object Object] + 重复注入）—— 可并行 / 最后清理。
7. 文档同步（CLAUDE.md + agent预期分析.md）。
