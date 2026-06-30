# Agent System Prompt 配置流程

> 基于 Phase 9 实战总结。适用场景：为新 Agent 编写 system prompt、或迁移现有 Agent 的 prompt 从代码到配置文件。

---

## 架构概述

```
┌─────────────────────────────────────────────────────────────┐
│  systemPrompt 来源优先级（buildAgentMessages）               │
│                                                             │
│  1. agent-config.json 的 agents.<id>.systemPrompt (最高)    │
│  2. ST JSON 预设文件 (presetId → preset)                     │
│  3. agent-templates.ts 的 fixedSystem + fixedExamples (兜底) │
└─────────────────────────────────────────────────────────────┘
```

**数据流**：
```
agent-config.json  ──→  buildAgentMessages()  ──→  SYSTEM message
agent-templates.ts ──→  (variableContext + variableInstruction) ──→ USER message
```

**关键规则**：
- **agent-config.json 是 prompt 内容的主要存放地**（方便编辑、版本控制、前端热更新）
- **agent-templates.ts 只保留 stub + 动态上下文函数**（variableContext / variableInstruction / fixedExamples）
- 前端设置页和测试工具都必须正确注入 `systemPrompt` 字段

---

## 流程：配置一个 Agent 的 System Prompt

### Step 1: 确定 Agent 的职责与输出格式

在写 prompt 之前，先回答：

1. **这个 Agent 做什么？** 一句话职责描述
2. **输入是什么？** 从哪些上游 Agent 读数据？（通过 `ctx.agentOutputs.get('xxx')`）
3. **输出格式是什么？** XML / JSON / 纯文本？需要哪些字段？
4. **是否 Agentic？** 需要 function calling 工具吗？

### Step 2: 编写 systemPrompt 内容

**文件位置**：`data/defaults/agent-config.json` → `agents.<agentId>.systemPrompt`

**内容模板**（对标 char_gen 的完整度标准）：

```markdown
你是一个[职责描述] AI。你可以调用 **function calling 工具** 来[工具用途]。

**可用工具:**
- tool_name: 一句话说明
- ...

---
# 核心原则 — [最重要的规则]

[Agent 特有的最高优先级规则]

---
# ⚠️ [关键规则名称]（最高优先级）

[如果有容易出错的关键规则，放在这里，用 ⚠️ 标记]

---
# 思考深度要求

在调用任何工具之前，你必须先进行充足的思考（至少[X]字中文），逐条分析：

1. **[维度1]**: [具体分析内容]
2. **[维度2]**: [具体分析内容]
3. ...

（你的思考过程不需要展示给用户，但会影响生成质量。）

---
# 工作机制

1. [步骤1]
2. [步骤2]
...

---
# [数值对照表]（如有）

| 参数 | T1 | T2 | T3 | T4 | T5 | T6 | T7 |
|------|----|----|----|----|----|----|-----|
| ...  |    |    |    |    |    |    |     |

---
# [API 参考]（如是 Agentic Agent）

列出所有可用 API 的签名和参数说明。

## 可用 API（完整清单 — 没有别的了）
[函数签名和说明]

## 条件判断规则
✅ 可以用的数据源
❌ 不能用的（stub/不存在）

---
# ❌ 绝对禁止

用 ❌ 符号逐条列出禁止事项。每条必须具体（不是"不要出错"，而是"不要使用 $event.getTargets()"）。

---
# 工作流程

1. 先进行至少[X]字中文思考。**首先[关键第一步]！**
2. [步骤2]
3. ...

---
# 输出前自检

每条输出前逐项确认：
1. [检查项1]？
2. [检查项2]？
...

---
# 输出格式 (严格 [XML/JSON])

[完整的输出格式定义，含所有字段的注释]
```

### Step 3: 精简 agent-templates.ts 的 fixedSystem

旧代码：
```typescript
char_gen: {
  fixedSystem: `你是一个角色生成 AI...（10126 字长文）...`,
  fixedExamples: `示例1...示例2...`,
  variableContext: (ctx) => ...,
  variableInstruction: (ctx) => ...,
}
```

新代码：
```typescript
char_gen: {
  fixedSystem: `角色生成 (Agentic) — 完整系统提示词已通过 agent-config.json 的 systemPrompt 字段注入。`,
  fixedExamples: '',  // 如有示例也移走，或留精简版
  variableContext: (ctx) => ...,   // 保留：动态上下文
  variableInstruction: (ctx) => ..., // 保留：每轮指令
}
```

### Step 4: 确保前端正确读取

**关键代码**：`SettingsPage.vue` 中的 `selectAgent()`

```typescript
function selectAgent(agentId: string) {
  const custom = s.agentPrompts[agentId]  // 用户自定义的覆盖
  if (custom) {
    agentPromptDraft.value = custom
  } else {
    // ✅ 正确：先查 agent-config.json
    const pd = cfg.projectAgentDefaults?.agents?.[agentId]
    if (pd?.systemPrompt) {
      agentPromptDraft.value = pd.systemPrompt
    } else {
      // ⬇ 兜底：agent-templates.ts
      const tpl = getAgentTemplate(agentId)
      agentPromptDraft.value = tpl ? (tpl.fixedSystem + '\n\n' + (tpl.fixedExamples || '')).trim() : ''
    }
  }
}
```

### Step 5: 确保测试工具正确注入

**关键代码**：`test_agent.ts` 中的 dry-run 和 live mode 都要注入 `systemPrompt`

```typescript
// dry-run 模式：
const _agentConfig: any = { 
  agentId: AGENT_ID, 
  worldBookIds: acfg.worldBookIds || [], 
  systemPrompt: acfg.systemPrompt || ''  // ← 关键！
};

// live 模式：
cfg.systemPrompt = ag.systemPrompt;  // ← 关键！
```

### Step 6: 验证

```bash
# 1. 类型检查
npm run typecheck

# 2. 单元测试
npm test -- --run

# 3. dry-run 验证 prompt 注入正确
npx tsx tests/agent-framework/test_agent.ts -a <agentId> -s <fixture> --dry-run

# 4. 前端验证：打开 localhost:5173 → 设置 → Agent 配置 → 选择 Agent → 拉到 System Prompt 区域
# 应该看到完整的 prompt（不是 "完整提示词已通过 agent-config.json 注入" 这种 stub）

# 5. live test（需要 API）
npx tsx tests/agent-framework/test_agent.ts -a <agentId> -s <fixture> -v
```

---

## 踩过的坑

### 坑 1：前端展示的是 stub 而不是完整 prompt

**现象**：打开设置页 → Agent 配置 → 物品生成，System Prompt 区域只显示 "完整的系统提示词已通过 agent-config.json 的 systemPrompt 字段注入。"

**根因**：`selectAgent()` 函数直接从 `getAgentTemplate()` 读取 `fixedSystem`，完全绕过了 `agent-config.json`

**修复**：在 `selectAgent()` 中优先检查 `cfg.projectAgentDefaults?.agents?.[agentId].systemPrompt`

### 坑 2：dry-run 输出也是 stub

**现象**：`npx tsx test_agent.ts -a item_gen --dry-run` 输出的 SYSTEM 部分也是 stub

**根因**：测试工具在 dry-run 模式下构建 `_agentConfig` 时没有传 `systemPrompt` 字段

**修复**：在 dry-run 分支的 `_agentConfig` 构造中加上 `systemPrompt: acfg.systemPrompt || ''`

### 坑 3：data/defaults/ 下的文件修改后前端不更新

**现象**：改了 `agent-config.json`，前端设置页还是旧内容

**根因**：Vite 在 dev mode 下会缓存 `public/` 或 `data/` 下的静态文件

**修复**：刷新浏览器（硬刷新 Ctrl+Shift+R），或重启 Vite dev server

### 坑 4：systemPrompt 太简陋，Agent 输出质量差

**现象**：item_gen 虽然分类判定正确，但整体 prompt 只有 char_gen 的 1/3 结构

**根因**：第一次写 prompt 时只关注了"约束"（❌ 禁止事项），忽略了 char_gen 有的"指导"部分（思考深度要求、数值对照表、完整工作流程）

**修复**：参照 char_gen 的节结构补齐：
- 思考深度要求（至少 X 字，N 个维度）
- 数值对照表（Tier 1-7）
- 编号的工作流程
- 输出前自检清单

### 坑 5：agent-templates.ts 被改后 typecheck 报错

**现象**：编辑 `agent-templates.ts` 后 `npm run typecheck` 报错

**根因**：模板字符串中包含反引号、`${}` 等特殊字符，TypeScript 解析失败

**修复**：确保 `fixedSystem` 的内容只有简短 stub（1-2 行），长内容放 `agent-config.json`。如果模板字符串里有 `$` 符号，确保用 `\$` 转义只在 JSON 字符串里需要，TypeScript 模板字符串里直接写 `$` 就行

---

## 检查清单

配置一个新 Agent 或修改现有 Agent 的 prompt 时：

- [ ] `agent-config.json` 中 `agents.<id>.systemPrompt` 有完整内容（不是空字符串或 stub）
- [ ] `agent-templates.ts` 中 `fixedSystem` 已精简为 1-2 行 stub
- [ ] `fixedExamples` 已清空或精简（长示例移入 systemPrompt）
- [ ] `variableContext` 和 `variableInstruction` 保留（动态上下文不能移）
- [ ] 前端 `selectAgent()` 优先读 `agent-config.json`
- [ ] 测试工具 dry-run 和 live 模式都注入 `systemPrompt`
- [ ] `npm run build` 通过（前端能读取到最新 JSON）
- [ ] `npm run test -- --run` 全部通过
- [ ] 前端设置页能看到完整 prompt
- [ ] dry-run 输出的 SYSTEM 中包含完整 prompt
