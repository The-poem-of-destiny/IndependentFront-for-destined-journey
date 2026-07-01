# Agent 占位符模板系统 — 修改指南

本文档面向需要在 Phase 10 模板系统中**修改占位符内容、解析逻辑，或编辑 Agent 配置**的开发者（包括 AI Agent 和人类）。

## 快速导航

| 你想做什么 | 去哪里改 |
|------------|----------|
| 修改某个 Agent 的占位符**排列顺序** | `data/defaults/agent-config.json` → 对应 Agent 的 `template` 字段 |
| 修改一个占位符**被解析成什么内容** | `src/sillytavern/placeholder-registry.ts` → 对应 resolver |
| 新增一个占位符 | registry + resolver 函数 + `getDefaultTemplate()` 里加 |
| 修改 Story Agent 的**预设注入顺序** | 预设面板 → 拖拽 `📥 动态注入` 条目，或在预设条目里直接编辑 content |
| 修改某个 Agent 的 `NARRATIVE` 层数/截断 | 模板中用 `{{NARRATIVE:layers=N:slice=N}}` 参数，或 `agent-config.json` → `historyLayers`/`historySlice` |
| 查看**运行时实际发出的 prompt** | 设置页 → 对应 Agent → 🔍模板预览 |

---

## 系统架构

```
用户/前端                   引擎运行时                     发给 LLM
┌──────────┐    ┌──────────────────────────────┐    ┌──────────┐
│ 预设面板   │───→│ assemblePresetContent()       │    │          │
│ (Story)   │    │   prompts[] 拼接              │    │          │
├──────────┤    │           ↓                    │    │          │
│ 模板编辑器 │───→│ resolveTemplate()             │───→│ OpenAI   │
│ (其他)    │    │   ① localParams 优先           │    │ API      │
├──────────┤    │   ② PLACEHOLDER_REGISTRY 兜底   │    │          │
│ 世界书    │───→│   ③ 未注册占位符原样保留         │    │          │
│ 配置      │    │           ↓                    │    │          │
│          │    │ buildAgentMessages()            │    │          │
└──────────┘    └──────────────────────────────┘    └──────────┘
```

## 关键文件

| 文件 | 职责 |
|------|------|
| `src/sillytavern/placeholder-registry.ts` | **16 个 resolver** + `getDefaultTemplate()` + `setPlaceholderGlobals()` |
| `src/sillytavern/template-resolver.ts` | **解析引擎** — `resolveTemplate()` + `resolveTemplateWithGlobals()` |
| `src/sillytavern/agent-templates.ts` | **入口** — `buildAgentMessages()` 选模板 → 调 resolver |
| `src/sillytavern/preset-loader.ts` | **预设适配** — `assemblePresetContent()` + 自动补 `📥动态注入` |
| `data/defaults/agent-config.json` | **配置** — 11 Agent 的 `systemPrompt` + `template` + LLM 参数 |
| `src/ui/components/settings/SettingsPage.vue` | **UI** — 模板编辑器 + Story 预设面板 + 预览 |
| `src/ui/components/settings/TemplatePreview.vue` | **UI 组件** — 彩色占位符标签渲染 |

---

## 占位符完整列表

### 全局占位符（10 个，所有 Agent 可用）

| 占位符 | 解析来源 |  resolver 位置 | 参数 |
|--------|----------|:---:|------|
| `{{SYS_PROMPT}}` | Story: 预设拼接；其他: `config.systemPrompt` | registry L85 | — |
| `{{LORE_BOOK}}` | `getEntriesForAgent` → `filterActiveEntries` → `formatWorldBookEntries` | registry L90 | `:limit=N` |
| `{{NARRATIVE}}` | `ctx.history` 从底部数 N 层 | registry L108 | `:layers=N:slice=N` |
| `{{USER_INPUT}}` | `ctx.userInput` | registry L120 | — |
| `{{CHARACTER_STATE}}` | `buildZoneContext` → `filterZoneContent` (npc zone, agent 可见性级别) | registry L125 | — |
| `{{INVENTORY}}` | 遍历 `ctx.characters[*].inventory` | registry L136 | — |
| `{{GAME_TIME}}` | `ctx.variables` 中提取时间/位置/天气/纪元键 | registry L155 | — |
| `{{ACTIVE_EFFECTS}}` | 遍历 `ctx.characters[*].statusEffects` | registry L176 | — |
| `{{MEMORY_ENTRIES}}` | `ctx.memories` 格式化 | registry L193 | `:top_k=N` |
| `{{PLOT_EVENTS}}` | `ctx.plotEvents` (active + pending) | registry L204 | — |

### Agent 通信占位符（6 个，从 `ctx.agentOutputs` 读取）

| 占位符 | 来源 Agent | 可用时机 |
|--------|-----------|----------|
| `{{AGENT.MEMORY_RECALL}}` | memory_recall | Stage 1+ |
| `{{AGENT.PLOT_PRE_CHECK}}` | plot_pre_check | Stage 1+ |
| `{{AGENT.STORY}}` | story | Stage 2+ |
| `{{AGENT.VARS_UPDATE}}` | vars_update | Stage 3+ |
| `{{AGENT.MEMORY_SUMMARY}}` | memory_summary | Stage 5+ |
| `{{AGENT.CHAR_UPDATE}}` | char_update | Stage 4+ |

### 链占位符（5 个，由编排层 `localParams` 注入）

| 占位符 | 谁注入 | 消费者 | 注入方式 |
|--------|--------|--------|----------|
| `{{CRAFT_REQUEST}}` | craft-gen-chain | craft_gen | `resolveTemplate` 的 `localParams` 参数 |
| `{{CHAR_DETECT}}` | char-gen-agent | char_gen | 同上 |
| `{{ITEM_REQUEST}}` | craft-gen-chain / char-gen-agent | item_gen | 从上游输出 XML 提取 |
| `{{CHAR_GEN_RESULT}}` | char-gen-agent | item_gen | `ctx.agentOutputs` |
| `{{CRAFT_RESULT}}` | craft-gen-chain | item_gen | `ctx.agentOutputs` |

**重要**: 链占位符不出现在 `PLACEHOLDER_REGISTRY` 的正常解析路径中——registry 只返回空串 fallback。实际值由 `resolveTemplate()` 的 `localParams` 参数接管（优先级高于 registry）。

---

## 编辑 Agent 模板的具体步骤

### A. 修改 Story Agent 的上下文注入顺序

1. 打开设置页 → Agent 配置 → 选择 **story**
2. 找到 **📥 动态注入** 条目（预设列表最后一个）
3. 点击 ✎ 编辑 → 修改 `content` 字段
4. 例如想把角色状态放世界书前面：
   ```
   改为: {{CHARACTER_STATE}}\n{{LORE_BOOK}}\n...
   ```
5. 不想用某个占位符：删掉那一行
6. 保存 → 🔍模板预览 查看效果
7. **保存为默认** → 写入 `agent-config.json`

### B. 修改其他 Agent 的模板

1. 设置页 → Agent 配置 → 选择对应 Agent
2. 在模板编辑区的 textarea 里直接编辑
3. 点击下方彩色 badge 插入占位符
4. 🔍模板预览 确认
5. **保存为默认** → 写入 `agent-config.json` 的 `template` 字段

### C. 直接编辑 agent-config.json

对于批量修改或程序化更新：

```bash
# 文件位置
data/defaults/agent-config.json

# 结构
{
  "agents": {
    "agent_id": {
      "systemPrompt": "核心指令文本...",
      "template": "{{SYS_PROMPT}}\n{{LORE_BOOK}}\n...",
      "historyLayers": 1,
      "historySlice": 800,
      ...
    }
  }
}
```

**`template` 字段**：如果不填，引擎自动 fallback 到 `placeholder-registry.ts` 的 `getDefaultTemplate(agentId)`。

### D. 修改占位符解析逻辑

例如想让 `{{GAME_TIME}}` 还输出当前 NPC 数量：

1. 打开 `src/sillytavern/placeholder-registry.ts`
2. 找到 `'GAME_TIME': (ctx, config, params) => { ... }` (~line 155)
3. 修改解析函数，返回你想要的文本
4. `npm run test -- --run` 确认通过
5. 如果改了签名或逻辑，同步更新 `placeholder-registry.test.ts`

---

## 预设系统兼容性

旧 ST 导入的预设（不含 `📥 动态注入` 条目）会在运行时自动追加默认上下文注入块。判断逻辑在 `preset-loader.ts` 的 `assemblePresetContent()`：

```typescript
// 检测是否已有我们的占位符
const hasOurPlaceholders = /\{\{(?:SYS_PROMPT|NARRATIVE|USER_INPUT|LORE_BOOK|...)\b/.test(content);

// 没有 → 自动追加 DEFAULT_STORY_CONTEXT_BLOCK
if (!hasOurPlaceholders) {
  content += '\n' + DEFAULT_STORY_CONTEXT_BLOCK;
}
```

这意味着：
- **旧预设 100% 兼容**，不需要人工添加条目
- **新预设**在编辑时编辑 `📥 动态注入` 条目即可接管注入顺序
- 删除 `📥 动态注入` 条目 → 引擎自动补回默认块

---

## ST `{{setvar}}` 语法的处理

ST 预设中使用的 `{{setvar::VOID2::}}`、`{{char}}`、`{{user}}` 等**小写开头**的占位符 **不会被我们的解析引擎处理** —— 它们原样保留在最终 prompt 中，由 ST 的正则脚本在另一端处理。

我们的 regex 只匹配以**大写字母开头**的占位符（`/[A-Z][A-Z_.]*/`），因此两种语法不冲突。

---

## 调试技巧

### 查看运行时实际发出的 prompt

```typescript
// 在 buildAgentMessages() 返回前加 log
const resolved = resolveTemplateWithGlobals(template, agentId, tplCtx, config, wbs, cfgs, allLocalParams);
console.log(`[Phase10] ${agentId} resolved prompt:`, resolved.slice(0, 500) + '...');
```

### 查看某个占位符的解析值

```typescript
// 直接调 registry
import { PLACEHOLDER_REGISTRY } from './placeholder-registry';
const result = PLACEHOLDER_REGISTRY['NARRATIVE'](ctx, config, { layers: '3', slice: '800' });
console.log(result);
```

### 前端预览

设置页 → 任何 Agent → 🔍模板预览 → 看到所有占位符的彩色标签渲染。这个面板展示的是**模板本身**（不是解析后的内容），用于确认占位符顺序和参数。

---

## 注意事项

1. **不要删掉 `PLACEHOLDER_REGISTRY` 中的 resolver**——即使某个 Agent 目前不用它，其他 Agent 可能在用
2. **新增加占位符时**，必须同时在 registry、`getDefaultTemplate()`、`SettingsPage.vue` 的 `ALL_PLACEHOLDER_META` 数组中添加条目
3. **修改 resolver 后必须跑测试**——`npm run test -- --run placeholder-registry` 确保 80 tests 通过
4. **SYS_PROMPT 是特殊的**——Story Agent 通过 `localParams['SYS_PROMPT']` 注入（预设拼接结果），绕过 registry。其他 Agent 走 registry
5. **TemplatePreview 渲染 `{{ }}` 用 `badgeText()` / `phLabel()` 函数**——不要在 Vue 模板里直接写 `{{ '{' + '{'`，会触发解析错误
