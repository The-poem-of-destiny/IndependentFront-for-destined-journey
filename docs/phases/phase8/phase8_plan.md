# Phase 8: Agent 上下文可见性 & Prompt 体系

> 基于 `docs/planning/task_plan.md` Phase 8 章节
>
> 日期：2026-06-19

---

## 一、概述

<!-- TODO: 主人填写 -->

我们把agent提示词中的内容分为四个部分。

预设：不共享，这个内容定义了每个agent的职责，思维链，格式化输出，也可以放在提示词前面

世界书：部分共享，我后面的计划中，我们需要把世界书分成多个部分：世界总览，数值化设计，角色详细，地区详细，变量更新等，不同的agent共享部分的世界书。基本不变，所以可以放在提示词前面

变量区：每次对话都有变动的位置，不同的agent都会把不同的内容注入到变量区内，内容部分共享

正文/用户输入：真正叙事发生的地方，大部分agent都需要这个内容来判断上文, 正常工作。

### 现有 Agent 清单（共 11 个）

以下是当前引擎中所有已注册的 Agent，按 Pipeline 阶段顺序排列。每个 Agent 的"上下文可见性"描述了它应该看到什么、不应该看到什么。

---

**1. memory_recall（记忆召回）**

- **阶段**: Stage 0（与 plot_pre_check 并行）
- **职责**: 根据用户输入和最近对话，从记忆库中召回最相关的记忆条目，输出 MEM ID 列表和相关度评分。
- **当前可见**: 记忆库全文 + 最近 5 轮对话 + 用户输入
- **应可见**:
  - ✅ 全部记忆条目（content / hiddenLine / keywords / importance）
  - ✅ 最近对话历史
  - ✅ 用户输入
  - ✅ 角色列表（知道谁在场）
- **应屏蔽**:
  - ❌ 剧情大纲（防止召回偏差——AI 不能因为"知道剧情方向"而选择性召回匹配的记忆）
  - ❌ 世界书全文
  - ❌ 完整变量区

---

**2. plot_pre_check（剧情触发检查）**

- **阶段**: Stage 0（与 memory_recall 并行）
- **职责**: 在正文生成之前，根据剧情大纲和当前状况，判断哪些 pending 事件应该转为 active，生成需要注入正文的剧情背景信息。
- **当前可见**: 活跃剧情事件 + 召回的记忆 + 角色状态 + 最近 8 轮对话 + 用户输入
- **应可见**:
  - ✅ 完整剧情大纲（这是唯一需要大纲全貌的 Agent，用于判断事件触发条件）
  - ✅ 活跃/待触发剧情事件
  - ✅ 召回的记忆列表
  - ✅ 角色当前状态
  - ✅ 最近对话
  - ✅ 用户输入
  - ✅ 世界书（地域/势力相关部分）
- **应屏蔽**:
  - ❌ 记忆详细正文（只需要知道摘要——防止被细节干扰触发判断）
  - ❌ 变量区完整数据（只需与触发条件直接相关的变量）

---

**3. story（正文 AI）**

- **阶段**: Stage 1（核心叙事）
- **职责**: 生成下一段剧情正文，输出 XML 格式（thinking/maintext/option/sum/vars）。是唯一面向玩家的输出。
- **当前可见**: 世界书匹配 + 召回记忆全文 + 活跃剧情事件 + 角色状态 + 当前变量 + 最近 15 轮对话 + 用户输入
- **应可见**:
  - ✅ 角色状态（在场角色/NPC/怪物，含 HP/MP/SP/位置/状态效果）
  - ✅ 本轮召回的记忆全文
  - ✅ 世界书匹配条目（当前场景/地点/势力相关）
  - ✅ 当前变量（位置/天气/时间等叙事直接需要的字段）
  - ✅ 最近对话历史
  - ✅ 用户输入
  - ✅ 剧情前置检查结果（"当前章节目标"的 100 字摘要）
- **应屏蔽**:
  - ❌ 完整剧情大纲 ← **最关键！只给 100 字章节目标摘要，防止全知叙事**
  - ❌ 其他 Agent 的思维链/thinking
  - ❌ 未触发的剧情事件细节
  - ❌ 记忆暗线（hiddenLine）
  - ❌ 角色内部的数值化设计（如世界书 #417617 核心数值表）

---

**4. vars_update（变量更新）**

- **阶段**: Stage 2
- **职责**: 根据 Story AI 输出，提取需要更新的变量（replace/delta/insert/delta_time），生成 VarsPatch JSON。同时检测 char_detect 标记触发角色生成链。
- **当前可见**: 当前变量 + 角色状态 + Story 输出
- **应可见**:
  - ✅ Story AI 的完整输出（maintext/sum/vars）
  - ✅ 当前变量完整快照
  - ✅ 角色列表（姓名 + ID 即可，用于变量路径引用）
  - ✅ 世界书（变量更新相关部分——如变量命名约定、合法值域）
- **应屏蔽**:
  - ❌ 剧情大纲
  - ❌ 记忆详情
  - ❌ 角色详细五维/登神长阶（不需要知道角色背景来做变量更新）

---

**5. char_update（角色更新）**

- **阶段**: Stage 3（N 个角色并行）
- **职责**: 根据 Story AI 输出，更新每个角色的 HP/MP/SP/状态效果/装备/技能/位置/金钱/关系。每个活跃角色独立调用一次（并行）。
- **当前可见**: 角色完整状态 + 当前变量 + Story 输出
- **应可见**:
  - ✅ Story AI 的完整输出
  - ✅ **当前角色**的完整 CharacterState（五维/装备/技能/背包/状态效果/登神长阶）
  - ✅ 其他角色的基础信息（姓名/位置/关系——用于判断互动影响）
  - ✅ 世界书（角色/种族/状态效果相关部分）
- **应屏蔽**:
  - ❌ 剧情大纲
  - ❌ 记忆详情
  - ❌ 其他角色的完整五维/背包/技能（除非发生直接互动——如交易/战斗）
  - ❌ 完整变量区

---

**6. memory_summary（记忆总结）**

- **阶段**: Stage 4
- **职责**: 为本轮对话生成一条结构化记忆（≥200 字正文 + 暗线 + 关键词 + 重要度评分）。
- **当前可见**: 最近 10 轮对话 + 变量状态 + 活跃剧情事件 + Story 输出 + 用户输入
- **应可见**:
  - ✅ Story AI 完整输出
  - ✅ 最近对话历史
  - ✅ 用户输入
  - ✅ 活跃剧情事件（用于标记记忆与剧情的关联）
  - ✅ 当前变量（时间/地点等元信息）
  - ✅ 已有记忆列表（最近的 5-10 条，用于判断是否需要合并/去重）
- **应屏蔽**:
  - ❌ 完整剧情大纲（防止记忆总结"预知"未来方向导致暗线偏差）
  - ❌ 完整变量区（只需时间/地点等元信息）
  - ❌ 角色详细五维（只需名字/身份）

---

**7. plot_post_check（剧情修正）**

- **阶段**: Stage 5
- **职责**: 分析本轮剧情是否导致世界线变动，更新事件状态（complete/fail/skip），必要时生成子事件或修改大纲。
- **当前可见**: 活跃剧情事件 + 召回记忆 + 角色状态 + 最近 8 轮对话 + Story 输出 + 用户输入
- **应可见**:
  - ✅ 完整剧情大纲（需要判断是否需要修正）
  - ✅ 所有活跃/已完成/待触发事件
  - ✅ Story AI 完整输出
  - ✅ 最近对话
  - ✅ 用户输入
  - ✅ 角色状态摘要（谁参与了本轮剧情）
  - ✅ 本轮记忆总结结果
- **应屏蔽**:
  - ❌ 记忆详细正文（只需摘要——和 plot_pre_check 一致）
  - ❌ 变量区完整数据
  - ❌ 制作/战斗的内部结算细节

---

**8. plot_outline（大纲生成）**

- **阶段**: 按需触发（非每轮运行）
- **职责**: 根据剧情配置、世界观和角色信息，生成完整剧情大纲（章节划分 + 关键事件 + 自检报告）。
- **当前可见**: 角色信息 + 剧情事件 + 当前变量 + 用户输入
- **应可见**:
  - ✅ 角色完整信息（姓名/种族/背景/身份）
  - ✅ 世界书（世界观/地理/势力/种族——这些是剧情生成的素材）
  - ✅ 剧情配置（模式/年份/难度层级/剧情偏向）
  - ✅ 已有剧情事件（如果续写大纲）
- **应屏蔽**:
  - ❌ 记忆详情（大纲生成不应受历史记忆影响——那是"已经发生的事"，不应限制"可以设计的事"）
  - ❌ 当前变量快照
  - ❌ 对话历史

---

**9. craft_gen（制作效果生成）**

- **阶段**: Stage 1 阻塞注入（正文中检测到 `<craft_request>` 时触发）
- **职责**: 判断制作难度、生成创意效果词条和叙事风味描述。Code 层做 DC/骰检，AI 层做创意。
- **当前可见**: 世界书 + 角色状态 + 当前变量 + 含 craft_request 标记的 Story 输出
- **应可见**:
  - ✅ Story AI 正文（含 craft_request 标记块）
  - ✅ 制作角色完整状态（五维/技能/装备/材料背包）
  - ✅ 世界书（制作系统/品质/材料/词条相关部分）
  - ✅ 当前变量（用来查 DC 参考值）
- **应屏蔽**:
  - ❌ 剧情大纲
  - ❌ 记忆详情
  - ❌ 其他角色信息（除非作为材料提供者参与制作）
  - ❌ 不在场的角色

---

**10. char_gen（角色生成）**

- **阶段**: Stage 2 异步（vars_update 检测到 `<char_detect>` 后触发）
- **职责**: 从叙事上下文中提取新 NPC/怪物/召唤物的完整数据（名字/五维/种族/背景/登神长阶）。
- **当前可见**: 已有角色列表 + 世界书 + 当前变量 + 含 char_detect 标记的 Story 输出
- **应可见**:
  - ✅ Story AI 正文（含 char_detect 标记块）
  - ✅ 已有角色列表（避免重名 + 判断新角色与已有角色的关系）
  - ✅ 世界书（种族/血脉/势力/地理——用来生成符合世界观的 NPC）
  - ✅ 当前变量（时间/地点——用于生成背景故事）
- **应屏蔽**:
  - ❌ 剧情大纲
  - ❌ 记忆详情
  - ❌ 其他角色的详细五维/背包

---

**11. item_gen（物品生成）**

- **阶段**: Stage 2 被 char_gen 链式调用（仅 1 次，ADR-26）
- **职责**: 基于 char_gen 生成的 NPC 数据，为其创建合适档次的技能、装备和背包物品。
- **当前可见**: 角色状态 + 当前变量 + char_gen 输出 + Story 输出
- **应可见**:
  - ✅ char_gen 的完整输出（目标角色的完整数据）
  - ✅ Story AI 正文（理解该 NPC 的登场上下文）
  - ✅ 世界书（物品/装备/技能/品质/词条相关部分）
  - ✅ 当前变量（时间/地点/势力——影响物品风格）
- **应屏蔽**:
  - ❌ 剧情大纲
  - ❌ 记忆详情
  - ❌ 目标角色以外的其他角色信息
  - ❌ 完整变量区

### 变量区数据结构设计

变量区定义为"叙事中会发生改变的一切数据"，每个 zone 是一个自描述的三层容器：

```
zone_name → {
  config:     { orderBy?, limit?, injectAs? },   // 注入行为控制
  visibility: ['agentA', 'agentB', ...],          // 哪些 Agent 可见
  content:    { key: value, ... }                 // 纯字典，实际数据
}
```

- **config**: 控制注入方式。`orderBy` 按需排序（如记忆按 importance），`limit` 截断，`injectAs` 决定渲染格式（json/list/table）。大部分 zone 无需 config。
- **visibility**: 声明式可见性白名单。`buildAgentMessages()` 遍历所有 zone，只注入当前 Agent 在 visibility 列表中的 zone。
- **content**: 纯字典。无排序语义，排序是注入时的渲染行为，不改变存储。

**已有 zone 规划**（按现有系统映射）：

| Zone     | 写入方                           | 可见范围                                                | 内容                               |
| -------- | -------------------------------- | ------------------------------------------------------- | ---------------------------------- |
| `memory` | memory_summary（每轮写入一条）   | `[memory_recall]`                                       | `{MEM0001: {...}, MEM0002: {...}}` |
| `npc`    | char_update / char_gen           | `[story, char_update, vars_update, memory_recall]`      | `{player: {...}, npc_001: {...}}`  |
| `world`  | vars_update                      | `[story, plot_pre_check, plot_post_check, vars_update]` | `{time, location, weather, ...}`   |
| `quest`  | plot_post_check / plot_pre_check | `[story, plot_pre_check, plot_post_check]`              | `{quest_001: {...}, ...}`          |
| `craft`  | craft_gen / vars_update          | `[story, craft_gen]`                                    | `{project_001: {...}, ...}`        |
| `combat` | combat-resolver（引擎直写）      | `[story, vars_update]`                                  | `{active_combat: {...}}`           |

### 主角合并入 NPC 区域

主角作为一个 `type: 'player'` 的特殊条目放入 `npc` zone，与 NPC/怪物/召唤物共用 `CharacterState` 结构体。

- **数据层面**: `npc.content.player` 就是主角，装备/技能/背包/五维/登神长阶与 NPC 结构完全一致
- **写入口径**: char_update 在 Stage 3 并行处理所有角色（不再区分"先主角后 NPC"）
- **主角独有数据**: FP 存在 `SaveProfile`（存档级元货币），不挂在任何 CharacterState 上。登神长阶 NPC 也有（Lv.13+ 开启），不是主角独有
- **visibility 控制**: `npc` zone 对所有需要角色信息的 Agent 开放，Agent 通过 `type` 字段区分主角和 NPC

### 世界书分区 & 存储

**决策**: 废除关键词扫描匹配，改为多世界书 + 直接开关注入。每个世界书是独立文件，存储在 `data/worldbooks/`。

**目录结构**:

```
data/
├── worldbooks/
│   ├── world_overview.json      # 世界总览 → story, plot_pre/post
│   ├── numerical_design.json    # 数值化设计 → vars_update, craft_gen
│   ├── character_detail.json    # 角色详细 → char_update, char_gen, item_gen
│   ├── region_detail.json       # 地区详细 → story, plot_pre/post
│   └── var_update.json          # 变量更新规则 → vars_update
└── presets/                     # ST 预设 JSON（后续）
```

**世界书文件结构**:

```json
{
  "id": "world_overview",
  "name": "世界总览",
  "partition": "world_overview",
  "description": "...",
  "entries": [{ "id": "...", "content": "...", "comment": "...", "enabled": true, "order": 100 }]
}
```

**条目结构（大幅简化）**:

- 无关键词、无 keyword matching、无递归扫描
- 只有 `content` + `enabled` 开关 + `order` 排序
- 每次注入内容完全固定 → 缓存命中率 100%

**Agent ↔ 世界书关联**:

- `AgentConfig.worldBookIds: string[]` — 该 Agent 挂载的世界书 ID 列表
- 设置页 → Agent 配置 → 勾选要注入的世界书
- 注入时按 `order` 排序拼接 → 进 prompt 的"世界书"部分

---

### 制作/战斗流程：Marker 协议 + 自动继续

**决策**: 不使用 OpenAI function calling，改用 Marker 协议（XML 标记 + Code 层后处理）。

**理由**:

- function calling 会在对话历史里遗留 `content: null` 和 `role: "tool"` 消息
- `<content>` 标签会被截断，AI 跨请求续写不可靠
- Marker 协议让 Story AI 一次输出完整 `<content>`，标记在 `</content>` 外面

**流程**:

```
User: "打一把长剑"

Story AI 一次输出:
  <content>你走进铁匠铺，向铁匠描述了想要的长剑样式。
  铁匠从矿石堆里挑出几块精炼铁矿石，示意你稍等片刻。</content>
  <craft_request industry="锻造" product="长剑" materials="铁矿石×3"/>

Code 层拦截:
  1. 检测到 </content> 后跟了 <craft_request/>
  2. 剥离 craft_request（不展示给用户）
  3. 调用 craft_gen Agent 生成创意效果 + 引擎 $craft API 结算
  4. 生成美化后的结果卡片，作为独立消息注入对话历史（AI 可见）

Code 自动继续:
  5. 自动再调 Story AI（无需用户触发）
  6. Story AI 看到 craft 结果 → 自然接续叙事

User 看到:
  ┌─ assistant ─────────────────────────┐
  │ 你走进铁匠铺...示意你稍等片刻。     │
  └─────────────────────────────────────┘
  ┌─ craft_result ─────────────────────┐
  │ ⚒ 锻造完成：精铁长剑              │
  │ 品质: 优良 | 攻击力+15             │
  └────────────────────────────────────┘
  ┌─ assistant ─────────────────────────┐
  │ "不错的手艺，"铁匠把剑递给你...     │
  └─────────────────────────────────────┘
```

**关键原则**:

- `<content>` 从不被截断，每次都是完整闭合的标签
- 标记在 `</content>` 外面，不污染正文
- craft/combat 结果作为带美化的系统卡片注入历史，AI 可见
- 不依赖 OpenAI function calling，parser 完全在 Code 层
- 战斗同理：`</content><combat_trigger/>` → Code 执行战斗 → 结果注入 → 自动继续

**auto-continue 机制**:

- craft/combat 结果注入后，Code 自动以"系统透传"方式触发下一轮 Story AI
- 对用户来说是一次完整的回合（一次输入 → 完整叙事 + 制作结果 + 后续叙事）
- 与战斗 Marker 协议现有的 `pendingCombatMarkers` 暂存机制兼容，执行时机统一在 Stage 2 后

---

## 二、上下文可见性模型 (`context-visibility.ts`)

<!-- TODO: 主人填写 -->

---

## 三、世界书格式 & 注入架构

### 3.1 世界书文件格式

兼容 SillyTavern 格式，精简字段：

```json
{
  "id": "world_overview",
  "name": "世界总览",
  "partition": "world_overview",
  "description": "...",
  "entries": [
    {
      "uid": 822383,
      "content": "注入正文（原版世界书内容原样保留）",
      "comment": "来源: #822383 [世界主设定]",

      "enabled": true,
      "constant": false,
      "key": ["阿斯塔利亚", "虚海"],
      "keysecondary": [],
      "selectiveLogic": 0,
      "order": 100,
      "position": 0
    }
  ]
}
```

**字段说明**:

| 字段             | 类型     | 用途                                              |
| ---------------- | -------- | ------------------------------------------------- |
| `uid`            | number   | 唯一标识（来自原版世界书 UID）                    |
| `content`        | string   | 注入正文，原版内容原样保留                        |
| `comment`        | string   | 人类备注，标注来源                                |
| `enabled`        | boolean  | 开关                                              |
| `constant`       | boolean  | 永久注入（跳过关键词扫描，始终生效）              |
| `key`            | string[] | 关键词（保留 ST 格式，后续可能用）                |
| `keysecondary`   | string[] | 辅助关键词                                        |
| `selectiveLogic` | 0/1/2/3  | 关键词逻辑：AND_ANY / NOT_ALL / NOT_ANY / AND_ALL |
| `order`          | number   | 排序：越大越靠后 → 对 AI 影响越大（ST 兼容）      |
| `position`       | number   | 世界书内的注入位置分组（保留 ST 兼容）            |

**砍掉的字段**: `vectorized`, `sticky`, `cooldown`, `delay`, `probability`, `useProbability`, `group`, `groupWeight`, `priorityInclusion`, `useGroupScoring`, `recursive`, `preventRecursion`, `delayUntilRecursion`, `recursionLevel`, `characterFilter`, `trigger`, `additionalMatching`, `depth`, `role`, `matchPersonaDescription`, `matchCharacterDescription`, `matchCharacterPersonality`, `matchCharacterDepthPrompt`, `matchScenario`, `matchCreatorNotes`, `caseSensitive`, `matchWholeWords`, `scanDepth`, `automationId`, `outletName`, `excludeRecursion`, `ignoreBudget`

### 3.2 注入逻辑

每个 Agent 通过 `AgentConfig.worldBookIds: string[]` 挂载世界书。注入时：

```
buildPrompt(agentId, ctx):
  worldBooks = loadWorldBooks(agentConfig.worldBookIds)

  for each book in worldBooks:
    for each entry in book.entries:
      1. !enabled → 跳过
      2. constant → 直接注入
      3. key 非空 → 关键词扫描 ctx 文本，命中则注入
      4. 否则 → 不注入

  按 order 升序拼接 → 插入 prompt 的「世界书」部分
```

### 3.3 Prompt 四部分结构

```
┌──────────────────────────────────────────┐
│  预设 (Preset)                           │  ← 不共享，per-agent 固定
│  Agent 职责 / 思维链 / 输出格式           │
├──────────────────────────────────────────┤
│  世界书 (World Books)                    │  ← 部分共享，按 partition 分配
│  constant entries + keyword-matched      │
├──────────────────────────────────────────┤
│  变量区 (Variable Zones)                 │  ← 部分共享，按 zone visibility
│  {memory, npc, world, quest, ...}        │
├──────────────────────────────────────────┤
│  正文/用户输入 (Body)                     │  ← 共享，对话历史 + userInput
│  最近 N 轮对话 + 本轮用户输入              │
└──────────────────────────────────────────┘
```

---

## 四、预设系统

### 4.1 预设文件格式

SillyTavern AI Response Preset 兼容格式：

```json
{
  "name": "默认-创意",
  "temperature": 0.7,
  "maxTokens": 2048,
  "topP": 0.9,
  "frequencyPenalty": 0.3,
  "presencePenalty": 0.1,
  "prompts": [
    {
      "name": "叙事风格指导",
      "role": "system",
      "content": "...",
      "enabled": true,
      "identifier": "style_guide"
    }
  ]
}
```

存储位置：`data/presets/*.json`

### 4.2 预设管理

- 设置页 → 正文 Agent (story) → 预设管理面板
- 导入 ST JSON → 文件名作为预设名
- 支持新建 / 导出 / 删除
- `prompts[]` 数组完整保留 ST 格式

---

## 五、实施计划

### Step 1: 世界书加载引擎

**新建**: `src/sillytavern/worldbook-loader.ts`

- 从 `data/worldbooks/` 加载所有世界书
- 按 `worldBookIds` 过滤
- 按 `enabled` + `constant` + `key` 过滤
- 按 `order` 排序 + 格式化输出
- **新建测试**: `worldbook-loader.test.ts`

### Step 2: 关键词匹配引擎（精简版）

**重构**: `src/sillytavern/lorebook-engine.ts`

- 保留 `key` / `keysecondary` / `selectiveLogic` 匹配
- 砍掉递归扫描（不再需要）
- 砍掉 position 分组（不再需要）
- 纯函数导出 `matchEntry(entry, text): boolean`

### Step 3: 预设加载器

**新建**: `src/sillytavern/preset-loader.ts`

- 从 `data/presets/` 加载预设 JSON
- 格式化为 Agent prompt 的「预设」部分
- **新建测试**: `preset-loader.test.ts`

### Step 4: Prompt 装配器（四部分拼接）

**重构**: `src/sillytavern/agent-templates.ts`

- `buildAgentMessages()` 改为四部分拼接：预设 + 世界书 + 变量区 + 正文
- 集成 `worldbook-loader` + `preset-loader`
- 每个 Agent 只拿它可见的内容

### Step 5: 设置页对接

**修改**: `SettingsPage.vue` + `settings-store.ts`

- 世界书管理：导入/新建/编辑/开关
- 预设管理：导入/新建/导出/删除（已有骨架）
- Agent 配置：勾选要挂的世界书

### Step 6: 清理旧代码

- 删除 `LorebookEngine` 类（用新的 loader 替代）
- 删除 `AgentContext.lorebookMatches`（用 `worldBooks` 替代）
- 更新 `types.ts` — `Lorebook` → 新 `WorldBook` 类型

---

## 六、验收标准

- [ ] `npm run typecheck` — 零错误
- [ ] `npm run test -- --run` — 全部通过
- [ ] 从 `data/worldbooks/` 加载 5 个世界书文件
- [ ] `constant` 条目直接注入，不受关键词影响
- [ ] `key` 条目命中关键词时注入
- [ ] `enabled: false` 条目不注入
- [ ] `order` 排序正确
- [ ] 不同 Agent 拿到不同世界书（按 `AgentConfig.worldBookIds`）
- [ ] 预设文件加载 + 拼入 prompt
- [ ] 设置页能导入/新建世界书
