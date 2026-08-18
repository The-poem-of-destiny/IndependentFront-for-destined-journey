# Agent System Prompt 配置流程

> 基于 Phase 9→10 实战总结。Phase 10 将 Agent 的 prompt 拆为两部分：**System Prompt**（核心指令）和**上下文模板**（占位符拼接）。本文档覆盖两者的编写、修改和验证。

---

## Phase 10 架构概述

```
每个 Agent 的最终 prompt = resolveTemplate() 运行时拼装

┌─ System Prompt ──────────────┐
│ 来自 agent-config.json       │  核心指令：人格、叙事准则、输出格式、数值规则
│ systemPrompt 字段             │  里面不写 {{PLACEHOLDER}}，纯文本
│ 或：Story Agent 用预设条目拼接 │
└──────────────┬──────────────┘
               ↓
┌─ 上下文模板 ──────────────────┐
│ 来自 agent-config.json       │  纯 {{PLACEHOLDER}} + 文本
│ template 字段                 │  决定注入内容的顺序和参数
│ 未填 → 引擎默认 (getDefaultTemplate) │
└──────────────┬──────────────┘
               ↓
       resolveTemplate()
               ↓
         发给 LLM
```

**两句话记住**：
- **System Prompt** = 告诉 AI "你是谁、怎么说话、输出什么格式"（核心指令）
- **上下文模板** = 告诉引擎 "往 prompt 里注入什么数据、按什么顺序"（`{{}}` 占位符）

---

## 占位符完整列表

### 全局占位符（所有 Agent 都可用）

> 📌 **复核 2026-08-18**：三张表按 `placeholder-registry.ts` 的 `PLACEHOLDER_REGISTRY`（~L427 起）
> 与 `types.ts` 的 `DEFAULT_AGENT_PIPELINE`（~L461，2026-08-16 起 **4 层并行管线**）重新对过。
> 逐条说明见 `agent_template_guide.md` 的「占位符完整列表」，那边是这套表的详版。

| 占位符 | 运行时解析为 | 参数 |
|--------|-------------|------|
| `{{SYS_PROMPT}}` | System Prompt 内容（预设拼接 / agent-config systemPrompt） | — |
| `{{LORE_BOOK}}` | 世界书激活条目（静态区 + 动态区连拼），按 order 排序 | `:section=static\|dynamic` `:limit=N`（截断字符数） |
| `{{LORE_BOOK_STATIC}}` | 只取世界书**静态区**（字节稳定，缓存友好） | `:limit=N` |
| `{{LORE_BOOK_DYNAMIC}}` | 只取世界书**动态区**（含 EJS，装配时求值） | `:limit=N` |
| `{{NARRATIVE}}` | 最近 N 轮对话历史（user/assistant 消息对） | `:layers=N`（几轮，默认按 agent 类型；`:slice` 已废弃，不再截断） |
| `{{USER_INPUT}}` | 当前轮用户输入 | — |
| `{{CHARACTER_STATE}}` | 主角+NPC 状态（按 agent 可见性级别格式化） | — |
| `{{INVENTORY}}` | 所有角色的背包物品列表 | — |
| `{{SKILL_STATE}}` | 各角色技能清单 + 开局初始技能声明（尚未落库的那批） | — |
| `{{QUEST_STATE}}` | 当前所有任务（状态/优先级/目标/进度） | — |
| `{{GAME_TIME}}` | 存档级时钟 + 位置/天气/季节/纪元等世界键 | — |
| `{{MAP_CONTEXT}}` | `<map_context>` 块：当前地块 + 一跳邻接 + 天气 + 在途摘要（无地图包 → 空串） | — |
| `{{RANDOM_EVENTS}}` | `<random_events>` 块：本回合候选事件（池空 / 系统关 / 战斗中 → 空串） | — |
| `{{RECENT_COMBAT}}` | `<recent_combat>` 块：最近一场**已结算**战斗的事实（缺席 → 空串） | — |
| `{{ACTIVE_EFFECTS}}` | 角色身上的 Buff/Debuff | — |
| `{{MEMORY_ENTRIES}}` | Embedding 召回的记忆条目 | `:top_k=N`（限制条数） |
| `{{PLOT_EVENTS}}` | 活跃 + 待处理的剧情事件 | — |

### Agent 间通信占位符（从上游 Agent 输出读取）

> 🪦 `{{AGENT.CHAR_UPDATE}}` 已删：char_update 这个 Agent 已并入 `vars_update`
> （`agent-templates.ts` ~L464），registry 里没有这个 key。现役第六条是
> `{{AGENT.REQUEST_DISPATCHER}}`。

| 占位符 | 来源 | 产出阶段 | 可用时机 |
|--------|------|:---:|----------|
| `{{AGENT.MEMORY_RECALL}}` | memory_recall | Stage 0 | Stage 1+ |
| `{{AGENT.PLOT_PRE_CHECK}}` | plot_pre_check | Stage 0 | Stage 1+ |
| `{{AGENT.STORY}}` | story | Stage 1 | Stage 2+ |
| `{{AGENT.REQUEST_DISPATCHER}}` | request_dispatcher | Stage 2 | Stage 3+ |
| `{{AGENT.MEMORY_SUMMARY}}` | memory_summary | Stage 2 | Stage 3+ |
| `{{AGENT.VARS_UPDATE}}` | vars_update | Stage 3 | 主 DAG 内无下游（侧链/调试可读） |

### 链占位符（由编排层注入，不出现在普通模板中）

| 占位符 | 注入方 | 消费者 |
|--------|--------|--------|
| `{{IMAGE_REQUEST}}` | scene-image-store 的 `runPromptAgent` 缝 → `callImagePromptAgent` | image_prompt |
| `{{CRAFT_REQUEST}}` | craft-gen-chain | craft_gen |
| `{{CHAR_DETECT}}` | char-gen-agent | char_gen |
| `{{ITEM_REQUEST}}` | craft-gen-chain / char-gen-agent | item_gen |
| `{{CHAR_GEN_RESULT}}` | char-gen-agent | item_gen |
| `{{CRAFT_RESULT}}` | craft-gen-chain | item_gen |
| `{{COMBAT_BRIEF}}` | game-pipeline.handleCombatTriggerV3 → combat-v3/coordinator | combat_v3 |
| `{{COMBAT_ROSTER}}` | game-pipeline.handleCombatTriggerV3 → combat-v3/coordinator | combat_v3 |

---

## 编辑方式（3 种途径）

### 途径 1：前端设置页（推荐日常使用）

**非 Story Agent**（craft_gen / char_gen / item_gen / vars_update / ...）：
```
设置 → Agent 配置 → 选择 Agent →
  ┌─ System Prompt ──┐  ← 编辑核心指令（纯文本）
  │ textarea          │
  ├─ 上下文模板 ──────┤  ← 编辑 {{PLACEHOLDER}} 模板
  │ textarea          │
  │ [badge] [badge]   │  ← 点击彩色 badge 插入占位符
  ├─ 🔍 模板预览 ────┤  ← 彩色标签展示模板结构
  └──────────────────┘
→ 保存为默认 → 写入 agent-config.json
```

**Story Agent**（使用预设系统，不走模板编辑器）：
```
设置 → Agent 配置 → story →
  ┌─ 预设管理 ───────┐
  │ 选择/导入预设     │
  │ 条目列表          │  ← 每个条目是一个提示词片段
  │  📥 动态注入      │  ← 这个条目放 {{PLACEHOLDER}} 占位符
  │ 🔍 模板预览       │  ← 预览 📥 动态注入 条目内容
  └──────────────────┘
```

### 途径 2：直接编辑 agent-config.json（批量修改 / 程序化更新）

```bash
# 文件位置（磁盘路径带 public/，运行期 URL 仍是 /data/defaults/agent-config.json）
public/data/defaults/agent-config.json
```

每个 Agent 有两个关键字段：

```json
{
  "agents": {
    "craft_gen": {
      "systemPrompt": "你是一个制作系统 AI。你可以调用 function calling 工具……（核心指令全文）",
      "template": "{{SYS_PROMPT}}\n\n<世界设定>\n{{LORE_BOOK}}\n</世界设定>\n\n<制作者状态>\n{{CHARACTER_STATE}}\n</制作者状态>\n\n<可用材料>\n{{INVENTORY}}\n</可用材料>\n\n<本次制作需求>\n{{CRAFT_REQUEST}}\n</本次制作需求>\n\n<当前剧情>\n{{NARRATIVE:layers=1:slice=800}}\n</当前剧情>"
    }
  }
}
```

| 字段 | 说明 | 不填时的行为 |
|------|------|-------------|
| `systemPrompt` | 核心指令，纯文本 | 回退到 `agent-templates.ts` 的 `fixedSystem`（stub） |
| `template` | 上下文模板，含 `{{}}` | 回退到 `placeholder-registry.ts` 的 `getDefaultTemplate(agentId)` |

**改完 JSON 后前端硬刷新**（Ctrl+Shift+R）才能看到更新。

### 途径 3：改代码中的默认值（新增 Agent / 改引擎行为）

- 占位符解析逻辑：`src/sillytavern/placeholder-registry.ts` → 对应的 resolver
- 默认模板：`placeholder-registry.ts` → `getDefaultTemplate()`
- 预设拼接 + 自动补全：`src/sillytavern/preset-loader.ts` → `assemblePresetContent()`

改完必须 `npm run test -- --run` 全绿。

---

## 各 Agent 默认模板

以下是引擎内置的默认模板（即 `getDefaultTemplate()` 的返回值）。用户可以在设置页覆盖。

> 📌 **本表 2026-08-18 按 `placeholder-registry.ts` 的 `DEFAULT_TEMPLATES`（~L805 起）逐条重生成**。
> 三处与旧表的实质差异：①story 的 `{{LORE_BOOK}}` 已拆成 **STATIC 在 `{{CHARACTER_STATE}}` 之前、
> DYNAMIC 在其之后**，并多了 `{{RANDOM_EVENTS}}`；②`char_update` 行**删除**——该 Agent 已并入
> `vars_update`（`agent-templates.ts` ~L464），registry 里没有它的模板；③补上 `request_dispatcher`
> 与 `image_prompt` 两行。另外 `:slice=N` 参数整体废弃（`{{NARRATIVE}}` 不再截断），故表中只留 `layers`。

| Agent | 默认模板 |
|-------|---------|
| **story** | `{{SYS_PROMPT}}` `{{AGENT.MEMORY_RECALL}}` `{{AGENT.PLOT_PRE_CHECK}}` `{{LORE_BOOK_STATIC}}` `{{CHARACTER_STATE}}` `{{LORE_BOOK_DYNAMIC}}` `{{GAME_TIME}}` `{{RANDOM_EVENTS}}` `{{NARRATIVE}}` `{{USER_INPUT}}`（🔴 `{{RANDOM_EVENTS}}` 刻意排在动态区之后、对话历史之前：它每回合都可能变，放前面会打碎前缀缓存；块自带 `<random_events>` 外壳，别再包中文标签） |
| **memory_recall** | `{{SYS_PROMPT}}` `{{MEMORY_ENTRIES}}` `{{NARRATIVE:layers=3}}` `{{USER_INPUT}}` |
| **plot_pre_check** | `<剧情事件库>` `{{PLOT_EVENTS}}` → `<记忆召回>` `{{AGENT.MEMORY_RECALL}}` → `<最近对话>` `{{NARRATIVE:layers=3}}` → `<用户输入>` `{{USER_INPUT}}` ★（`{{PLOT_EVENTS}}` 在管线里被 `localParams` 覆盖成富上下文块） |
| **request_dispatcher** | `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<已有角色>` `{{CHARACTER_STATE}}` → `<已有物品>` `{{INVENTORY}}` → `<已有技能>` `{{SKILL_STATE}}` → `<动态状态>` `{{LORE_BOOK_DYNAMIC}}` → `{{RECENT_COMBAT}}`（自带外壳，不包标签）→ `<正文内容>` `{{AGENT.STORY}}` → `<用户输入>` `{{USER_INPUT}}` ★ |
| **vars_update** | `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<已有角色>` `{{CHARACTER_STATE}}` → `<已有物品>` `{{INVENTORY}}` → `<动态状态>` `{{LORE_BOOK_DYNAMIC}}` → `<调度器输出>` `{{AGENT.REQUEST_DISPATCHER}}` → `<正文内容>` `{{AGENT.STORY}}` → `<最近对话>` `{{NARRATIVE:layers=1}}` ★ |
| **memory_summary** | `{{SYS_PROMPT}}` `{{AGENT.STORY}}` `{{NARRATIVE:layers=4}}` |
| **plot_post_check** | `<剧情事件库>` `{{PLOT_EVENTS}}` → `<角色状态>` `{{CHARACTER_STATE}}` → `<最近对话>` `{{NARRATIVE:layers=4}}` → `<用户输入>` `{{USER_INPUT}}` → `<本轮正文>` `{{AGENT.STORY}}` → `<本轮记忆总结>` `{{AGENT.MEMORY_SUMMARY}}` ★ |
| **plot_outline** | `<角色背景>` `{{CHARACTER_STATE}}` → `<剧情配置>` `{{PLOT_EVENTS}}` → `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<动态状态>` `{{LORE_BOOK_DYNAMIC}}` → `<用户指令>` `{{USER_INPUT}}` ★ |
| **craft_gen** | `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<制作者状态>` `{{CHARACTER_STATE}}` → `<可用材料>` `{{INVENTORY}}` → `<动态状态>` `{{LORE_BOOK_DYNAMIC}}` → `<本次制作需求>` `{{CRAFT_REQUEST}}` → `<当前剧情>` `{{NARRATIVE:layers=1}}` ★ |
| **char_gen** | `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<已有角色>` `{{CHARACTER_STATE}}` → `<动态状态>` `{{LORE_BOOK_DYNAMIC}}` → `<当前剧情场景>` `{{NARRATIVE:layers=1}}` → `<新角色描述>` `{{CHAR_DETECT}}` ★ |
| **item_gen** | `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<可用物品库>` `{{INVENTORY}}` → `<动态状态>` `{{LORE_BOOK_DYNAMIC}}` → `<角色生成结果>` `{{CHAR_GEN_RESULT}}` → `<制作结果>` `{{CRAFT_RESULT}}` → `<物品需求>` `{{ITEM_REQUEST}}` ★ |
| **image_prompt** | `<世界设定>` `{{LORE_BOOK_STATIC}}` → `<本次插画需求>` `{{IMAGE_REQUEST}}` ★（图像 v1 的 G 阶段侧链，由情景插画队列唤起、**不走主 DAG**；刻意短——挂便宜快模型，机械转换不需要整套世界观，世界书默认关） |
| **combat_v3** | `<战斗指令>` `{{COMBAT_BRIEF}}` → `<参战方>` `{{COMBAT_ROSTER}}` → `<世界设定>` `{{LORE_BOOK_STATIC}}` ★（真源为 `agent-config.json` 的 `combat_v3.template`，未注册 `getDefaultTemplate`；由 `renderOpeningCombatMessage` 三级回退取用。2026-08-10 真机 debug 后删除全部玩家视角区——`<玩家输入>`/`<触发正文>`/`<最近对话>` 不再注入敌方 Agent，防止它替玩家做决定） |

> ★ 标记的为 Phase 10 模板系统已完成结构化的 Agent（含 XML 分区标签 + 注释）。占位符按缓存优化顺序排列：稳定在上、高频动态在下。

---

## 结构化模板设计规范（Phase 10 新增）

### 设计原则

模板不只是占位符的简单拼接。一个结构良好的模板 = **XML 分区标签** + **注释** + **缓存优化排序**。

### 规则 1: `{{SYS_PROMPT}}` 不加任何包装

```
{{SYS_PROMPT}}        ← 裸放。systemPrompt 本身就是完整的操作手册。
```

### 规则 2: 其他所有占位符用 XML 标签分区 + 注释

```xml
<数据区块名>
{{PLACEHOLDER}}
</数据区块名>
<!-- 注释说明三要素:
     ① 这是什么数据，从哪来的
     ② AI 应该怎么用它
     ③ 如果不够怎么办（是否需要调用工具补充）
-->
```

**注释必须包含**：
- **源头**：数据来源（世界书 / 角色状态 / 上游 Agent 输出 / 正文标记）
- **用途**：AI 应该怎么理解和使用这些数据
- **补充策略**：Agentic Agent 如果有工具，说明"优先查阅这里，不够再调 xxx"

### 规则 3: 缓存优化排序

LLM API 的 prompt caching 从头部做前缀匹配。把**不常变**的放上层、**每轮必变**的放底层：

| 层级 | 占位符类型 | 变化频率 | 示例 |
|------|-----------|:---:|------|
| 🟢 顶部稳定层 | `SYS_PROMPT`、`LORE_BOOK` | 几乎不变 | 系统指令、世界设定 |
| 🟡 中部半稳定层 | `CHARACTER_STATE`、`INVENTORY` | 战斗中偶尔变 | 角色属性、背包内容 |
| 🔴 底部高频层 | `CRAFT_REQUEST`、`CHAR_DETECT`、`ITEM_REQUEST`、`NARRATIVE` | 每轮都变 | 制作需求、新角色描述、对话历史 |

### 规则 4: systemPrompt 联动

模板的 XML 分区标签名 **必须在 systemPrompt 中被引用**。如果模板里有一个 `<制作者状态>` 分区，systemPrompt 的工作流程中就应该写"查阅上方的 **<制作者状态>** 区块"。

**检视清单**：
- systemPrompt 的「条件判断 / 数据来源」→ 列出上下文区块作为优先数据源
- systemPrompt 的「工作流程」→ 前几步改为"先查区块，不完整再调工具"

### 完整示例：craft_gen 模板

```
{{SYS_PROMPT}}

<!-- ────────────────────────────────────────────── -->
<!-- 以下各区块是你完成制作任务所需的完整上下文数据。-->
<!-- 请先仔细阅读各区块内容，再按工作流程逐步执行。-->
<!-- ────────────────────────────────────────────── -->

<世界设定>
{{LORE_BOOK}}
</世界设定>
<!-- 当前场景激活的世界书条目。涵盖世界观设定、种族特性、势力关系、地理信息、行业规范等。
     制作产物的外观描述、材质选择、工艺风格应与当前世界观保持一致。-->

<制作者状态>
{{CHARACTER_STATE}}
</制作者状态>
<!-- [用途] 准备阶段优先查阅此处获取核心属性值 → 不够再调 get_character -->

<可用材料>
{{INVENTORY}}
</可用材料>
<!-- [用途] 确认材料种类数量 → 不完整再调 get_inventory -->

<本次制作需求>
{{CRAFT_REQUEST}}
</本次制作需求>        ← 🔴 高频变化

<当前剧情>
{{NARRATIVE:layers=1:slice=800}}
</当前剧情>           ← 🔴 高频变化
```

### 已完成结构化的 Agent

> 📌 **复核 2026-08-18**：结构化范围早已不止三个 Agent，本表按 `DEFAULT_TEMPLATES` 重列。

| Agent | 状态 | 分区数 |
|-------|:---:|:---:|
| craft_gen | ✅ 完成 | 6 区 (<世界设定>/<制作者状态>/<可用材料>/<动态状态>/<本次制作需求>/<当前剧情>) |
| char_gen | ✅ 完成 | 5 区 (<世界设定>/<已有角色>/<动态状态>/<当前剧情场景>/<新角色描述>) |
| item_gen | ✅ 完成 | 6 区 (<世界设定>/<可用物品库>/<动态状态>/<角色生成结果>/<制作结果>/<物品需求>) |
| request_dispatcher | ✅ 完成 | 7 区 + `{{RECENT_COMBAT}}`（自带 `<recent_combat>` 外壳，不额外包标签） |
| vars_update | ✅ 完成 | 7 区 (<世界设定>/<已有角色>/<已有物品>/<动态状态>/<调度器输出>/<正文内容>/<最近对话>) |
| plot_pre_check | ✅ 完成 | 4 区 (<剧情事件库>/<记忆召回>/<最近对话>/<用户输入>) |
| plot_post_check | ✅ 完成 | 6 区 (<剧情事件库>/<角色状态>/<最近对话>/<用户输入>/<本轮正文>/<本轮记忆总结>) |
| plot_outline | ✅ 完成 | 5 区 (<角色背景>/<剧情配置>/<世界设定>/<动态状态>/<用户指令>) |
| image_prompt | ✅ 完成 | 2 区 (<世界设定>/<本次插画需求>) |
| story / memory_recall / memory_summary | ⬜ 仍为裸占位符拼接 | story 走预设系统（真源是预设条目，不在这条路上）；另两个刻意保持极简 |

---
3. **输出格式？** XML / JSON / 纯文本？
4. **是否 Agentic？** 需要 function calling 工具？

### Step 2: 编写 systemPrompt（核心指令）

**两种方式**：

**A. 前端写**（推荐）：设置 → Agent 配置 → System Prompt textarea → 保存为默认

**B. 直接写 JSON**：编辑 `public/data/defaults/agent-config.json` → `agents.<agentId>.systemPrompt`

内容模板（参照 craft_gen / char_gen 的标准）：

```markdown
你是一个[职责描述] AI。你可以调用 **function calling 工具** 来[工具用途]。

**可用工具:**
- tool_name: 一句话说明

---
# 核心原则

[Agent 特有的最高优先级规则]

---
# ⚠️ 关键规则（最高优先级）

[容易出错的关键规则]

---
# 思考深度要求

在调用任何工具之前，先充足思考（至少[X]字中文），逐条分析：
1. **[维度1]**: [分析内容]
2. **[维度2]**: [分析内容]

---
# 工作机制

1. [步骤1]
2. [步骤2]

---
# 数值对照表（如需）

| 参数 | T1 | T2 | T3 | T4 | T5 | T6 | T7 |
|------|----|----|----|----|----|----|-----|
| ...  |    |    |    |    |    |    |     |

---
# API 参考（如是 Agentic Agent）

列出可用 API 的签名和参数说明。

## 条件判断
✅ 可用的数据源
❌ 不能用的

---
# ❌ 绝对禁止

逐条列出禁止事项。

---
# 工作流程

1. 先进行至少[X]字中文思考
2. [步骤2]
3. ...

---
# 输出前自检

1. [检查项1]？
2. [检查项2]？

---
# 输出格式 (严格 XML/JSON)

[完整格式定义 + 字段注释]
```

### Step 3: 编写上下文模板

**前端**：设置 → Agent 配置 → 上下文模板 textarea → 点击 badge 插入占位符 → 🔍 预览

**JSON**：`agent-config.json` → `agents.<agentId>.template`

模板编辑规则：
- **只放占位符和分隔文本**（换行、标题等）
- **不要在这里写规则/指令**——那些放 systemPrompt
- 用参数控制注入量：`{{NARRATIVE:layers=3:slice=800}}`
- 不想要的占位符就删掉那一行
- 调整占位符出现顺序 → 改变 prompt 中的内容顺序

### Step 4: 精简 agent-templates.ts（Phase 10 之后基本不需要改）

旧代码（~700 行）：

```typescript
char_gen: {
  fixedSystem: `你是一个角色生成 AI...（万字长文）...`,
  fixedExamples: `示例1...`,
  variableContext: (ctx) => ...,   // 手写动态拼接
  variableInstruction: (ctx) => ...,
}
```

新代码（~4 行）：

```typescript
char_gen: {
  fixedSystem: `角色生成 (Agentic) — 完整 systemPrompt 已通过 agent-config.json 注入。`,
  fixedExamples: '',
}
```

> 🪦 **Q-04（2026-08-03）**：`variableContext` / `variableInstruction` 已从 `AgentPromptTemplate`
> **彻底删除**，不再是「留个空闭包」。原因是它们的唯一调用点 `buildFallbackMessages` 只在
> 「`config.template` 与 `DEFAULT_TEMPLATES` 双双为空」时才走，而 `DEFAULT_TEMPLATES` 现已覆盖
> 全部 Agent —— 也就是说，那两个闭包里写的提示词**永远不会进 prompt**。
> 要改动态上下文，只有两条路：改 `agent-config.json` 的 `template`，或改
> `placeholder-registry.ts` 的 `DEFAULT_TEMPLATES` / resolver。

### Step 5: 验证

```bash
# 1. 类型检查
npm run typecheck

# 2. 全量测试
npm run test -- --run

# 3. 前端验证
# 打开 localhost:5173 → 设置 → Agent 配置 → 选择 Agent
# → System Prompt 区域应显示完整核心指令
# → 上下文模板区域应显示 {{PLACEHOLDER}} 模板
# → 点击 🔍模板预览 → 彩色标签展示

# 4. JSON 合法性（如果直接改了 JSON）
node -e "JSON.parse(require('fs').readFileSync('public/data/defaults/agent-config.json','utf8')); console.log('OK')"
```

---

## Story Agent 的特殊处理

Story Agent 用**预设系统**替代 plain text systemPrompt。预设 = `prompts[]` 条目数组，每个条目有 `name`、`content`、`enabled`、`injection_order`。

### 编辑 Story Agent 的 System Prompt

1. 设置 → Agent 配置 → story → 预设管理
2. 选择预设 → 点击条目 ✎ 编辑 → 修改 content
3. 新建条目：+ 新建预设 或 + 新建条目

### 编辑 Story Agent 的上下文模板

找到预设条目列表中的 **📥 动态注入** 条目：
```
name: "📥 动态注入"
content: "{{AGENT.MEMORY_RECALL}}
{{AGENT.PLOT_PRE_CHECK}}
{{LORE_BOOK_STATIC}}
{{CHARACTER_STATE}}
{{LORE_BOOK_DYNAMIC}}
{{GAME_TIME}}
{{NARRATIVE}}
{{USER_INPUT}}"
```

> 📌 **复核 2026-08-18**：上面这段就是 `preset-loader.ts` 的 `DEFAULT_STORY_CONTEXT_BLOCK`
> （旧预设缺 `📥 动态注入` 条目时引擎自动追加的那一份），世界书已按静/动两区拆开。
> 引擎给 story 的**默认模板**（`getDefaultTemplate('story')`）比它多一个 `{{SYS_PROMPT}}` 和一个
> `{{RANDOM_EVENTS}}`。自动追加块里没有随机事件占位符，但**不必手动补**——
> `agent-templates.ts` (~L754) 对 story 有一条兜底：渲染路径里找不到 `{{RANDOM_EVENTS}}` 时，
> 引擎在结果末尾追加该块（空池返空串，零 token）。想控制它出现的**位置**才需要自己写这一行。
编辑这个条目的 content 即可调整注入顺序和参数。

### 旧 ST 预设兼容

如果导入的旧预设没有 `📥 动态注入` 条目，引擎在运行时自动追加默认上下文块（`preset-loader.ts` → `assemblePresetContent()`）。无需手动添加。

---

## 踩过的坑

### 坑 1（Phase 9）：前端展示的是 stub 而不是完整 prompt

**现象**：设置页 System Prompt 显示 "完整提示词已通过 agent-config.json 注入"。

**根因**：`selectAgent()` 直接读 `getAgentTemplate().fixedSystem`（stub），绕过了 `agent-config.json`。

**修复**：`selectAgent()` 优先读 `cfg.projectAgentDefaults?.agents?.[agentId].systemPrompt`。

### 坑 2（Phase 9）：dry-run 输出也是 stub

**根因**：测试工具构建 `_agentConfig` 时没传 `systemPrompt` 字段。

**修复**：加上 `systemPrompt: acfg.systemPrompt || ''`。

### 坑 3（Phase 9）：agent-config.json 修改后前端不更新

**修复**：浏览器硬刷新 Ctrl+Shift+R，或重启 Vite dev server。

### 坑 4（Phase 10）：Vue 模板中 `{{ }}` 解析错误

**现象**：页面报 `Unterminated string constant`。

**根因**：Vue 模板解析器把 `{{ '{' + '{'` 里的 `{{` 当成表达式开始。

**修复**：用 JS 函数返回 `{` + `{` 拼接结果，不在模板里内联写 `{{`。`TemplatePreview.vue` 用 `badgeText(seg)`，`SettingsPage.vue` 用 `phLabel(key)`。

### 坑 5（Phase 10）：上下文模板和 System Prompt 混淆

**现象**：用户把 `{{NARRATIVE}}` 写进 System Prompt textarea 里。

**正确做法**：System Prompt = 纯指令文本，不写占位符。占位符全放上下文模板 textarea。

---

## 参考文档

- 占位符系统详细修改指南：`docs/reference/agent_template_guide.md`
- 架构总览：`docs/ARCHITECTURE.md`
- 前端 UI 计划：`docs/phases/phase8/phase8_plan.md`
