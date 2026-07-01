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

| 占位符 | 运行时解析为 | 参数 |
|--------|-------------|------|
| `{{SYS_PROMPT}}` | System Prompt 内容（预设拼接 / agent-config systemPrompt） | — |
| `{{LORE_BOOK}}` | 世界书 keyword 激活条目，按 order 排序 | `:limit=N`（截断字符数） |
| `{{NARRATIVE}}` | 最近 N 轮对话历史（user/assistant 消息对） | `:layers=N`（几轮，默认按 agent 类型）`:slice=N`（每条截断字数） |
| `{{USER_INPUT}}` | 当前轮用户输入 | — |
| `{{CHARACTER_STATE}}` | 主角+NPC 状态（按 agent 可见性级别格式化） | — |
| `{{INVENTORY}}` | 所有角色的背包物品列表 | — |
| `{{GAME_TIME}}` | 时间/位置/天气/纪元（从 variables 提取） | — |
| `{{ACTIVE_EFFECTS}}` | 角色身上的 Buff/Debuff | — |
| `{{MEMORY_ENTRIES}}` | Embedding 召回的记忆条目 | `:top_k=N`（限制条数） |
| `{{PLOT_EVENTS}}` | 活跃 + 待处理的剧情事件 | — |

### Agent 间通信占位符（从上游 Agent 输出读取）

| 占位符 | 来源 | 可用时机 |
|--------|------|----------|
| `{{AGENT.MEMORY_RECALL}}` | memory_recall | Stage 1+ |
| `{{AGENT.PLOT_PRE_CHECK}}` | plot_pre_check | Stage 1+ |
| `{{AGENT.STORY}}` | story | Stage 2+ |
| `{{AGENT.VARS_UPDATE}}` | vars_update | Stage 3+ |
| `{{AGENT.MEMORY_SUMMARY}}` | memory_summary | Stage 5+ |
| `{{AGENT.CHAR_UPDATE}}` | char_update | Stage 4+ |

### 链占位符（由编排层注入，不出现在普通模板中）

| 占位符 | 注入方 | 消费者 |
|--------|--------|--------|
| `{{CRAFT_REQUEST}}` | craft-gen-chain | craft_gen |
| `{{CHAR_DETECT}}` | char-gen-agent | char_gen |
| `{{ITEM_REQUEST}}` | craft-gen-chain / char-gen-agent | item_gen |
| `{{CHAR_GEN_RESULT}}` | char-gen-agent | item_gen |
| `{{CRAFT_RESULT}}` | craft-gen-chain | item_gen |

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
# 文件位置
data/defaults/agent-config.json
```

每个 Agent 有两个关键字段：

```json
{
  "agents": {
    "craft_gen": {
      "systemPrompt": "你是一个制作系统 AI。你可以调用 function calling 工具……（核心指令全文）",
      "template": "{{SYS_PROMPT}}\n{{CRAFT_REQUEST}}\n{{INVENTORY}}\n{{CHARACTER_STATE}}\n{{LORE_BOOK}}\n{{NARRATIVE:layers=1:slice=800}}"
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

| Agent | 默认模板 |
|-------|---------|
| **story** | `{{SYS_PROMPT}}` `{{AGENT.MEMORY_RECALL}}` `{{AGENT.PLOT_PRE_CHECK}}` `{{LORE_BOOK}}` `{{CHARACTER_STATE}}` `{{GAME_TIME}}` `{{NARRATIVE}}` `{{USER_INPUT}}` |
| **memory_recall** | `{{SYS_PROMPT}}` `{{MEMORY_ENTRIES}}` `{{NARRATIVE:layers=3:slice=800}}` `{{USER_INPUT}}` |
| **plot_pre_check** | `{{SYS_PROMPT}}` `{{PLOT_EVENTS}}` `{{AGENT.MEMORY_RECALL}}` `{{NARRATIVE:layers=3:slice=1000}}` `{{USER_INPUT}}` |
| **vars_update** | `{{SYS_PROMPT}}` `{{AGENT.STORY}}` `{{CHARACTER_STATE}}` `{{LORE_BOOK}}` |
| **char_update** | `{{SYS_PROMPT}}` `{{AGENT.STORY}}` `{{AGENT.VARS_UPDATE}}` `{{CHARACTER_STATE}}` `{{NARRATIVE:layers=1:slice=800}}` |
| **memory_summary** | `{{SYS_PROMPT}}` `{{AGENT.STORY}}` `{{NARRATIVE:layers=4:slice=1500}}` |
| **plot_post_check** | `{{SYS_PROMPT}}` `{{AGENT.STORY}}` `{{AGENT.MEMORY_SUMMARY}}` `{{PLOT_EVENTS}}` `{{CHARACTER_STATE}}` `{{NARRATIVE:layers=4:slice=1000}}` |
| **plot_outline** | `{{SYS_PROMPT}}` `{{PLOT_EVENTS}}` `{{NARRATIVE:layers=3:slice=1000}}` |
| **craft_gen** | `{{SYS_PROMPT}}` `{{CRAFT_REQUEST}}` `{{INVENTORY}}` `{{CHARACTER_STATE}}` `{{LORE_BOOK}}` `{{NARRATIVE:layers=1:slice=800}}` |
| **char_gen** | `{{SYS_PROMPT}}` `{{CHAR_DETECT}}` `{{CHARACTER_STATE}}` `{{LORE_BOOK}}` `{{NARRATIVE:layers=1:slice=800}}` |
| **item_gen** | `{{SYS_PROMPT}}` `{{ITEM_REQUEST}}` `{{CHAR_GEN_RESULT}}` `{{CRAFT_RESULT}}` `{{INVENTORY}}` |

---

## 流程：编写一个 Agent 的 System Prompt

### Step 1: 确定职责与输出格式

1. **这个 Agent 做什么？**
2. **输入是什么？** 从上游 Agent 读什么（对应 `{{AGENT.xxx}}` 占位符）
3. **输出格式？** XML / JSON / 纯文本？
4. **是否 Agentic？** 需要 function calling 工具？

### Step 2: 编写 systemPrompt（核心指令）

**两种方式**：

**A. 前端写**（推荐）：设置 → Agent 配置 → System Prompt textarea → 保存为默认

**B. 直接写 JSON**：编辑 `data/defaults/agent-config.json` → `agents.<agentId>.systemPrompt`

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

新代码（~10 行）：
```typescript
char_gen: {
  fixedSystem: `角色生成 (Agentic) — 完整 systemPrompt 已通过 agent-config.json 注入。`,
  fixedExamples: '',
  variableContext: () => '',    // Phase 10: 由模板占位符替代
  variableInstruction: () => '', // Phase 10: 由模板占位符替代
}
```

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
node -e "JSON.parse(require('fs').readFileSync('data/defaults/agent-config.json','utf8')); console.log('OK')"
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
{{LORE_BOOK}}
{{CHARACTER_STATE}}
{{GAME_TIME}}
{{NARRATIVE}}
{{USER_INPUT}}"
```
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
