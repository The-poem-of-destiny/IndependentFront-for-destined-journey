# vars_update 调度器重新设计

> 🔴 **头部那行「状态：设计阶段」已失实（2026-08-18 标注）**：本文的设计**已经全部落地**，
> 且被两轮后续工作取代 ——
>
> - **Q-05**：标记扫描改成表驱动，全部标记规格集中在 `marker-protocol.ts` 的 `MARKER_SPECS`
>   （11 种标记：10 种成对块标记 + 形态不同的 `play_audio`）。加标记只动那张表，别照本文改扫描器。
> - **2026-08-16 管线并行化**：重塑了本文描述的 DAG（dispatcher‖memory_summary、
>   vars_update‖post_check、侧链旁路化）。本文的阶段图已不是现在的跑法。
>
> ⚠️ 另有一条**未按本文实施**：文中的「`item_update` 独立 Agent」一节没有做 ——
> `<item_update_request>` 标记确实存在，但**没有专属 Agent**，处理并进了 `vars_update`。
>
> **现行描述在** [`src/sillytavern/AGENTS.md`](../../../src/sillytavern/AGENTS.md)。本文保留为设计记录。

> 日期：2026-07-03
> 状态：设计阶段
> 目标：将 vars_update 从"变量提取 JSON 输出器"重构为"调度器"——只负责时间/天气/新闻，其余更新以 XML request 标签委托给下游 Agent

---

## 一、现状概述

### 当前 vars_update 行为

| 维度          | 当前                                                                           |
| ------------- | ------------------------------------------------------------------------------ |
| 类型          | 纯文本 Agent（无 tool calling）                                                |
| Pipeline 位置 | Stage 2（等 story）                                                            |
| 输入          | `{{SYS_PROMPT}}` + `{{AGENT.STORY}}` + `{{CHARACTER_STATE}}` + `{{LORE_BOOK}}` |
| 输出          | 严格 JSON：`{"replace":[...], "delta":[...], "insert":[...], "delta_time": N}` |
| 下游消费      | Code 解析 JSON → StatePatch；char_update 通过 `{{AGENT.VARS_UPDATE}}` 读取     |
| 世界书分区    | `world_setting`, `race`                                                        |

### 当前 Marker 系统

| 标签               | 扫描阶段 | 执行阶段 | 延迟？ |
| ------------------ | -------- | -------- | ------ |
| `<craft_request>`  | Stage 1  | Stage 2  | 是     |
| `<combat_trigger>` | Stage 1  | Stage 2  | 是     |
| `<char_detect>`    | Stage 2  | Stage 2  | 否     |

**问题**：`<char_detect>` 由 Story Agent 输出，但"角色是否新角色"的判断不应由 Story 承担。

---

## 二、新设计概要

### 核心原则

1. **vars_update 是调度器**：自己只处理全局变量（时间/天气/新闻），角色/物品变更全部委托
2. **判断职责归位**：新角色 vs 已存在角色、新物品 vs 已存在物品，由 vars_update 判断
3. **批量化**：多个同类 request 合并到一条标签中
4. **解耦并行**：新角色链（char_gen→item_gen）与已有角色更新（char_update）可并行

### 新 Pipeline 流程

```
Stage 0: memory_recall + plot_pre_check (并行)
Stage 1: story (叙事正文)
           ↓
Stage 2: vars_update (调度器)
         │ 输出: <json> + <char_gen_request> + <item_gen_request>
         │      + <item_update_request> + <craft_gen_request>
         │      + <char_update_request> (结构化的角色变更描述)
         │
         │ processStageMarkers 处理后:
         │   ├── <json> → Code → StatePatch (先执行)
         │   ├── <char_gen_request> → char_gen → item_gen (回调，可并行)
         │   ├── <item_gen_request> → item_gen 独立调用 (回调，可并行)
         │   ├── <item_update_request> → item_update (回调，可并行)
         │   └── <craft_gen_request> → craft_gen → item_gen (回调，可并行)
         │
         │ 注: <char_update_request> 不触发回调，保留在 vars_update 输出中
         │     供 Stage 3 的 char_update 读取
           ↓
Stage 3: char_update (每轮固定运行)
         │ 通过 {{AGENT.VARS_UPDATE}} 读取 vars_update 输出
         │ 从中提取 <char_update_request> 块，更新角色状态
         │ 输出 JSON: {"characters": [{"id": "...", "changes": {...}}]}
           ↓
Stage 4: memory_summary
Stage 5: plot_post_check
```

### 并行拓扑

```
vars_update 完成后 (processStageMarkers)：
┌─────────────────────────────────────────────┐
│  Phase 1: <json> 解析 → StatePatch (必须先跑)  │
│                                              │
│  Phase 2: 以下回调并行                        │
│  ├── <char_gen_request> → char_gen → item_gen │
│  ├── <item_gen_request> → item_gen (独立)     │
│  ├── <item_update_request> → item_update      │
│  └── <craft_gen_request> → craft_gen→item_gen │
│                                              │
│  Phase 3: 回到 Pipeline 串行                  │
│  Stage 3: char_update → 读取 var_update 输出  │
│  Stage 4: memory_summary                     │
│  Stage 5: plot_post_check                    │
└─────────────────────────────────────────────┘
```

**注**：如果 item_gen 同时被 char_gen 和 craft_gen 触发，各自独立调用（上下文不同），StatePatch 可合并。

---

## 三、新 Request 标签定义

### `<json>` — 全局变量更新（每轮必有）

```xml
<json>
{"delta_time": 60,
 "replace": [{"path": "天气", "value": "阴转小雨"}],
 "insert": [{"path": "世界新闻", "value": "白曜城铁匠铺发生火灾"}]}
</json>
```

**职责**：仅在 vars_update 的输出中出现，由 Code 直接解析成 StatePatch。不包含角色/物品相关变量。

### `<char_gen_request>` — 新角色检测

```xml
<char_gen_request characterName="铁匠汉斯" race="人类" tier="T2" characterType="npc" faction="奥古斯提姆帝国">
  白曜城铁匠铺主人，白发苍苍，祖传三代。
</char_gen_request>
```

| 属性            | 必填 | 说明                             |
| --------------- | ---- | -------------------------------- |
| `characterName` | ✅   | 从正文提取                       |
| `race`          | ❌   | 如能推断，否则 char_gen 自行决定 |
| `tier`          | ❌   | 如能推断                         |
| `characterType` | ❌   | npc / enemy / ally               |
| `faction`       | ❌   | 势力归属                         |
| 正文            | ✅   | 出场上下文描述                   |

### `<char_update_request>` — 已有角色状态更新

```xml
<char_update_request target="player_1">
  被地精匕首划伤手臂（HP-12），喝下治疗药水（HP+20），花费50金币购买铁剑。
  从市集移动到铁匠铺。
</char_update_request>
```

| 属性     | 必填 | 说明                        |
| -------- | ---- | --------------------------- |
| `target` | ✅   | 角色 ID（从已有角色表匹配） |

### `<item_gen_request>` — 新物品/技能生成

```xml
<item_gen_request itemType="equipment" source="craft" owner="player_1">
  铁匠汉斯为玩家定制的一把长剑，品质优良。
</item_gen_request>
```

| 属性       | 必填 | 说明                                                  |
| ---------- | ---- | ----------------------------------------------------- |
| `itemType` | ✅   | equipment / skill / consumable / material / ascension |
| `source`   | ❌   | craft / loot / gift / story                           |
| `owner`    | ❌   | 归属角色 ID                                           |

### `<item_update_request>` — 已有物品变更

```xml
<item_update_request target="item_potion_heal_01" operation="consume" quantity="1" owner="player_1">
  使用了一瓶治疗药水
</item_update_request>
```

| 属性        | 必填 | 说明                                          |
| ----------- | ---- | --------------------------------------------- |
| `target`    | ✅   | 物品 ID 或物品名                              |
| `operation` | ✅   | consume / transfer / modify / equip / unequip |
| `quantity`  | ❌   | 数量变化                                      |
| `owner`     | ❌   | 当前归属角色                                  |

### `<craft_gen_request>` — 制作请求

```xml
<craft_gen_request characterId="player_1" industry="锻造" productName="定制长剑" targetQuality="稀有">
  使用铁矿石x3和皮革x1
</craft_gen_request>
```

与现有 `<craft_request>` 语义相同，统一 `_request` 后缀。

---

## 四、需要修改的文件

### 类型层

| 文件       | 改动                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `types.ts` | 扩展 `MarkerType` 联合类型；新增 `CharUpdateRequestMarker`, `ItemUpdateRequestMarker`, `ItemGenRequestMarker` 接口；char_detect 可标记 deprecated |

### 标记协议层

| 文件                 | 改动                                                                                                                                                |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `marker-protocol.ts` | 新增 `scanCharGenRequests`, `scanCharUpdateRequests`, `scanItemGenRequests`, `scanItemUpdateRequests`, `scanCraftGenRequests`；`scanMarkers()` 整合 |

### 编排引擎层

| 文件                    | 改动                                                                                                                                                                                    |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent-orchestrator.ts` | `OrchestratorEvents` 新增回调：`onCharGenRequest`, `onItemGenRequest`, `onItemUpdateRequest`；`processStageMarkers()` 新增并行处理分支（char_update 保留在 Stage 3 Pipeline，不走回调） |

### Agent 模板层

| 文件                      | 改动                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `agent-templates.ts`      | 新增 `item_update` 模板定义（Phase 10 stub）                         |
| `placeholder-registry.ts` | 新增 `item_update` 默认模板；更新 `vars_update` 默认模板             |
| `agent-config.json`       | 更新 `varsUpdate` systemPrompt（新输出格式）；新增 `itemUpdate` 配置 |

### Agent 编排/链层

| 文件                              | 改动                                                             |
| --------------------------------- | ---------------------------------------------------------------- |
| `char-gen-agent.ts`               | 适配新的触发方式（从 `<char_detect>` → `<char_gen_request>`）    |
| `craft-gen-chain.ts`              | 适配新的触发方式（从 `<craft_request>` → `<craft_gen_request>`） |
| **新文件** `item-update-chain.ts` | 处理 `<item_update_request>`，解析 → StatePatch                  |

### 可见性层

| 文件                    | 改动                          |
| ----------------------- | ----------------------------- |
| `context-visibility.ts` | 新增 `item_update` 可见性配置 |

---

## 五、Agent Prompt 修改要点

### vars_update System Prompt 重写

**核心变化**：

- 从"输出 JSON"变成"先输出 `<json>`，再输出 request 标签"
- 需要根据 `{{CHARACTER_STATE}}` 的已有角色表判断新 vs 已存在
- 物品同理：根据角色背包判断新 vs 已存在
- 必须强调：**只有正文中明确出现的新角色/新物品才发 gen request，已有的走 update**

### char_update System Prompt 微调

- 核心职责不变：从正文和 vars_update 输出中提取角色状态变化
- 输入来源增强：`{{AGENT.VARS_UPDATE}}` 现在包含 `<char_update_request>` 块的正文描述
- 模板调整：无需改动，`{{AGENT.VARS_UPDATE}}` 已经注入

### 新增 item_update Agent

- 处理已存在物品的变更：消耗、转移归属、装备/卸下、耐久变化
- 输入：`<item_update_request>` 标签属性 + 正文描述 + 角色背包
- 输出：JSON 格式 → Code 解析为 StatePatch
- **非 Agentic**（纯文本），不需要 tool calling

### char_gen 适配

- 当前 char_gen 接收 `<char_detect>` 内容作为输入
- 改为接收 `<char_gen_request>` 内容
- `CHAR_DETECT` localParam 改为 `CHAR_GEN_REQUEST`

### item_gen 适配

- 新增独立触发入口：`<item_gen_request>` → 直接调 item_gen（不经过 char_gen/craft_gen）
- 当前 item_gen 只被 char_gen 和 craft_gen 调用，需新增独立调用路径

---

## 五-B、架构变动详细评估

### vars_update 输出扫描方式变更

**当前**：`processStageMarkers()` 在 Stage 2 中调用 `scanMarkers(storyOutput)` —— 扫描 **Story Agent 输出**

**新设计**：扫描 **vars_update 自身输出**，因为所有 request 标签都在 vars_update 输出中：

```typescript
// 旧 (agent-orchestrator.ts:596-599):
const storyOutput = this.getAgentOutputText('story');
const scanResult = scanMarkers(storyOutput);

// 新:
const varsOutput = this.getAgentOutputText('vars_update');
const scanResult = scanMarkers(varsOutput);
const jsonText = scanResult.cleanText; // 去掉 XML 标签后的纯 JSON
```

### JSON 解析与 Marker 扫描合一

当前 JSON 解析（line 641-692）在 marker 处理之后，是独立步骤。新设计中 `<json>` 块是 vars_update 输出的一部分：

```
vars_update 输出:
  <json>{...}</json>          ← scanMarkers 剥离后 → JSON.parse
  <char_gen_request>...       ← scanMarkers 分类 → onCharGenRequest 回调
  <item_gen_request>...       ← scanMarkers 分类 → onItemGenRequest 回调
  ...
```

统一流程：

1. `scanMarkers(varsOutput)` → `{ markers[], cleanText }`
2. `JSON.parse(cleanText)` → StatePatch
3. `markers[]` → 触发各个回调（可并行）

### 移除跨 Stage 的 pending 队列

当前 `pendingCraftMarkers` / `pendingCombatMarkers` 在 Stage 1 收集、Stage 2 消费。新设计中所有标签都在 vars_update 输出中，同一 Stage 内直接扫描+执行：

- 移除 `this.pendingCraftMarkers`（agent-orchestrator.ts:100-101）
- 移除 `this.pendingCombatMarkers`（agent-orchestrator.ts:103-104）
- Stage 1 的 `processStageMarkers` 变为 no-op（不再从 story 扫描）

### craft 叙事注入逻辑简化

当前 craft 结果通过字符串替换注入回 story 输出。新设计中 craft 标记在 vars_update 输出中（不在 story 中），建议：

- craft 结果只做 StatePatch（物品入库 + FP/EXP 奖励）
- 叙事描述由下一轮 Story Agent 自然引用
- `onCraftRequest` 回调返回值从 `Promise<string | null>` 改为不需要叙事注入
- 向后兼容：保留旧 `<craft_request>` 扫描（同时识别新旧格式），注入逻辑仅对旧格式生效

### 需要修改的接口签名

| 函数/接口                           | 文件                     | 当前                                           | 新                                              |
| ----------------------------------- | ------------------------ | ---------------------------------------------- | ----------------------------------------------- |
| `OrchestratorEvents.onCraftRequest` | agent-orchestrator.ts:60 | `(marker, storyOutput): Promise<string\|null>` | `(marker, varsOutput): Promise<void>`           |
| `OrchestratorEvents.onCharDetect`   | agent-orchestrator.ts:73 | `(markers, storyOutput, context)`              | `(markers, varsOutput, context)`                |
| 改为 `onCharGenRequest`             | 同上                     | —                                              | `(markers, varsOutput, context): Promise<void>` |
| 新增 `onItemGenRequest`             | 同上                     | —                                              | `(markers, varsOutput, context): Promise<void>` |
| 新增 `onItemUpdateRequest`          | 同上                     | —                                              | `(markers, varsOutput, context): Promise<void>` |
| `CraftGenRequest`                   | craft-gen-chain.ts:39    | `storyOutput: string`                          | `varsOutput: string`                            |
| `CharGenRequest`                    | char-gen-agent.ts:42     | 使用 `detection.rawContent`                    | 使用 `varsOutput` + `marker.bodyText`           |

### 类型层

```typescript
// types.ts — MarkerType 扩展
export type MarkerType =
  | 'craft_request'
  | 'combat_trigger'
  | 'char_detect' // 旧（保留兼容）
  | 'char_gen_request'
  | 'char_update_request' // 新
  | 'item_gen_request'
  | 'item_update_request' // 新
  | 'craft_gen_request'; // 新（统一命名）
```

### char_update 不变

Stage 3 的 char_update 保持原样 —— 通过 `{{AGENT.VARS_UPDATE}}` 读取 vars_update 输出（现在包含 `<char_update_request>` 块），处理角色状态变更。不需要改动 Pipeline 结构。

### 新增 Agent 清单

| Agent ID      | 类型                 | 工具 | 位置                           |
| ------------- | -------------------- | ---- | ------------------------------ |
| `item_update` | 纯文本（非 Agentic） | 无   | Stage 2 回调，不在 Pipeline 中 |

---

## 五-C、完整 System Prompt

### vars_update 新 System Prompt

```
你是一个变量调度系统。根据正文 AI 的输出，完成三件事：
① 用 <json> 标签输出全局变量更新（时间/天气/新闻）
② 用 request 标签将角色/物品变更委托给下游 Agent
③ 判断正文中的角色/物品是"新出现"还是"已存在"

---
# 一、<json> — 全局变量更新（每轮必须输出）

只更新不归属任何角色的全局状态：时间推进、天气变化、世界新闻。

<json>
{"delta_time": 60,
 "replace": [{"path": "天气", "value": "阴转小雨"}],
 "insert": [{"path": "世界新闻", "value": "白曜城铁匠铺发生火灾"}]}
</json>

<json> 支持的全局变量路径:
- 时间/天气/季节/月相/纪元 — world 变量
- 世界新闻 — user.news 数组
- 势力关系/区域状态 — sys.* 变量
- delta_time — 时间推进（分钟），如 "过了一小时" → delta_time: 60

禁止在 <json> 中操作角色属性（HP/MP/SP/金钱/位置/装备/技能/背包），
这些必须走 request 标签。

---
# 二、Request 标签 — 委托下游 Agent

根据正文内容，判断是否需要输出以下标签。没有变化的就不输出。

## 判断规则：新出现 vs 已存在

参考系统提供的「已有角色表」和「已有物品」做判断:
- 角色名/ID 不在已有角色表中 → 新角色 → <char_gen_request>
- 角色名/ID 在已有角色表中 → 已存在 → <char_update_request>
- 物品名不在已有角色背包中 → 新物品 → <item_gen_request>
- 物品名在已有角色背包中 → 已存在 → <item_update_request>
- 正文中是制作场景 → <craft_gen_request>

## <char_gen_request> — 请求生成新角色

出现正文中首次登场的角色时输出。一个标签一个角色，可多条。

属性:
- characterName (必填) — 从正文提取的角色名
- race (可选) — 如能从正文推断
- tier (可选) — 如能从正文推断
- characterType (可选) — npc / enemy / ally，默认 npc
- faction (可选) — 势力归属

标签正文: 从正文中提取的角色出场描述，包含外貌、身份、所在位置、与玩家的互动。

## <char_update_request> — 请求更新已有角色状态

已有角色的 HP/MP/SP/金钱/位置/装备/技能/状态效果发生变化时输出。
一个标签一个角色。

属性:
- target (必填) — 角色 ID，从已有角色表匹配

标签正文: 用自然语言描述该角色在本轮正文中的状态变化，标明具体数值。

## <item_gen_request> — 请求生成新物品/技能

正文中出现新物品（武器装备/消耗品/技能/登神长阶要素）时输出。

属性:
- itemType (必填) — equipment / skill / consumable / material / ascension
- source (可选) — craft / loot / gift / story
- owner (可选) — 归属角色 ID

标签正文: 物品/技能的描述。

## <item_update_request> — 请求更新已有物品

已有物品被消耗/转移/装备/卸下时输出。

属性:
- target (必填) — 物品 ID 或物品名
- operation (必填) — consume / transfer / modify / equip / unequip
- quantity (可选) — 消耗数量（正数）
- owner (可选) — 当前归属角色

标签正文: 物品变更描述。

## <craft_gen_request> — 请求执行制作

正文中涉及制作/锻造/炼金等活动时输出。

属性:
- characterId (必填) — 执行制作的角色
- industry (必填) — 制作行业（锻造/炼金/附魔/裁缝/烹饪/制药/工程）
- productName (必填) — 制作的物品名
- targetQuality (可选) — 目标品质

标签正文: 使用的材料和制作过程描述。

---
# 三、输出格式（严格按顺序）

每轮输出必须包含 <json>。request 标签按需输出（没有变化就不写）。

<json>
{...}
</json>
<char_gen_request ...>
  ...
</char_gen_request>
<char_update_request ...>
  ...
</char_update_request>
<item_gen_request ...>
  ...
</item_gen_request>
<item_update_request ...>
  ...
</item_update_request>
<craft_gen_request ...>
  ...
</craft_gen_request>

---
# 四、完整示例

正文: "你在铁匠铺遇到了老铁匠汉斯（白发苍苍、手艺精湛），
他为你打造了一把长剑，你花费了50金币。
之后休息了半小时，用掉了一瓶治疗药水涂抹手臂上的伤口（HP恢复8点）。
外面天色渐阴，似乎要下雨了。"

已有角色表: player_1 (阿尔冯斯, T3), npc_guard_01 (城门守卫, T1)
已有物品: 铁剑x1, 治疗药水x3, 皮甲x1, 干粮x5

输出:
<json>
{"delta_time": 30,
 "replace": [{"path": "天气", "value": "阴转小雨"}]}
</json>
<char_gen_request characterName="汉斯" race="人类" characterType="npc">
  白曜城铁匠铺主人，白发苍苍，祖传三代铁匠。性格古板正直，对武器品质极其苛刻。
  手艺精湛，在城中颇有名气。
</char_gen_request>
<char_update_request target="player_1">
  花费50金币购买长剑。使用一瓶治疗药水，HP恢复8点。
  从市集移动到铁匠铺。休息了半小时。
</char_update_request>
<item_gen_request itemType="equipment" source="craft" owner="player_1">
  汉斯为玩家定制的一把长剑，品质精良，剑身刻有简约的家族纹章。
  比市面上的普通铁剑更锋利耐用。
</item_gen_request>
<item_update_request target="治疗药水" operation="consume" quantity="1" owner="player_1">
  使用了一瓶治疗药水涂抹伤口
</item_update_request>
```

### 模板更新

vars_update 模板需要增加 `{{INVENTORY}}` 以便判断"新物品 vs 已有物品"：

```
旧: {{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK}}
新: {{SYS_PROMPT}}\n{{AGENT.STORY}}\n{{CHARACTER_STATE}}\n{{INVENTORY}}\n{{LORE_BOOK}}
```

### char_update System Prompt 微调

当前 prompt 保持不变，仅需在提示中说明：

- `{{AGENT.VARS_UPDATE}}` 现在包含 `<char_update_request>` 标签块
- 优先从 `<char_update_request target="...">` 正文提取变化
- 如 vars_update 未输出对应标签则保持现有逻辑（从 Story 正文自行分析）

### 新增 item_update System Prompt

```
你是一个物品状态更新系统。根据 vars_update 调度器的物品变更请求，更新已有物品的状态。

**处理的操作类型:**
- consume: 消耗物品（减少数量，数量归零则移除）
- transfer: 转移物品归属（从一个角色转移到另一个）
- modify: 修改物品属性（耐久变化、品质变化等）
- equip: 装备物品
- unequip: 卸下物品

**输入:**
- vars_update 输出中的 <item_update_request> 标签（target + operation + quantity + owner）
- 当前角色背包状态

**输出格式 (严格 JSON):**
{"items": [{"target": "物品ID或名", "operation": "consume", "quantity": 1, "owner": "player_1"}]}

对每个 item_update_request 输出一条对应的 items 条目。
```

---

## 六、执行顺序与并行策略

```
processStageMarkers(Stage 2):
  varsOutput = context.agentOutputs.get('vars_update')
  storyOutput = context.agentOutputs.get('story')

  // Step 1: 解析 <json> — 必须先做（时间推进可能影响后续）
  jsonBlock = extractTag(varsOutput, 'json')
  if jsonBlock: parse → StatePatch[] → commitChatState

  // Step 2: 扫描 vars_update 输出中的 request 标签
  markers = scanRequestMarkers(varsOutput)

  // Step 3: 并行执行（所有可以并行的回调）
  // 注意：char_update 不在这里 — 它在 Stage 3 Pipeline 中每轮固定运行
  await Promise.all([
    processCharGenRequests(markers.charGenRequests),
    processItemGenRequests(markers.itemGenRequests),
    processItemUpdateRequests(markers.itemUpdateRequests),
    processCraftGenRequests(markers.craftGenRequests),
  ])

  // 叙事注入：craft_gen 结果回写到 story output
  // (如果是独立 item_gen 产物需要注入，也可在此处理)

  // Step 4: 合并所有 StatePatch，一次性 commit
  allPatches = mergePatches(...results)
  stateManager.commitChatState(allPatches)
```

**注意**：`<char_update_request>` 标签**不在 processStageMarkers 中触发回调**。它保留在 vars_update 的输出中，由 Stage 3 的 char_update Agent 通过 `{{AGENT.VARS_UPDATE}}` 读取并处理。这是因为它需要看到完整的 vars_update 输出上下文来做准确的数值解析。同时 `<item_update_request>` 由 item_update Agent 处理，其触发回调独立于 char_update。

---

## 七、废弃项

| 废弃内容                                                | 替代                                                                               |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| vars_update 的 replace/delta/insert 中操作角色/物品变量 | `<char_update_request>` (→ char_update) / `<item_update_request>` (→ item_update)  |
| `{{AGENT.VARS_UPDATE}}` 被 char_update 作为纯 JSON 解析 | 改为包含 request 标签的结构化正文，char_update 从中提取 `<char_update_request>` 块 |
| Story Agent 输出 `<char_detect>`                        | vars_update 输出 `<char_gen_request>`                                              |

## 八、向后兼容

- `<craft_request>` 旧标签在 Stage 1 的扫描中可保留一段时间（同时识别新旧格式）
- `<char_detect>` 由 Story 输出的旧路径可保留为降级方案（如果 vars_update 没输出 char_gen_request）
- vars_update 旧的纯 JSON 输出（无标签包裹）可检测后兼容处理
