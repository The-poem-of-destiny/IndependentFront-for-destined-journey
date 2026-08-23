# Agent 占位符模板系统 — 修改指南

本文档面向需要在 Phase 10 模板系统中**修改占位符内容、解析逻辑，或编辑 Agent 配置**的开发者（包括 AI Agent 和人类）。

## 快速导航

| 你想做什么 | 去哪里改 |
|------------|----------|
| 修改某个 Agent 的占位符**排列顺序** | `public/data/defaults/agent-config.json` → 对应 Agent 的 `template` 字段 |
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
| `src/sillytavern/placeholder-registry.ts` | **31 个 resolver**（复核 2026-08-18；17 全局 + 6 Agent 通信 + 8 链） + `getDefaultTemplate()` + `setPlaceholderGlobals()` |
| `src/sillytavern/template-resolver.ts` | **解析引擎** — `resolveTemplate()` + `resolveTemplateWithGlobals()` |
| `src/sillytavern/agent-templates.ts` | **入口** — `buildAgentMessages()` 选模板 → 调 resolver |
| `src/sillytavern/preset-loader.ts` | **预设适配** — `assemblePresetContent()` + 自动补 `📥动态注入` |
| `public/data/defaults/agent-config.json` | **配置** — 13 Agent 的 `systemPrompt` + `template` + LLM 参数（🔴 磁盘路径带 `public/`，运行期 URL 仍是 `/data/defaults/agent-config.json`） |
| `src/ui/components/settings/SettingsPage.vue` | **UI** — 模板编辑器 + Story 预设面板 + 预览 |
| `src/ui/components/settings/TemplatePreview.vue` | **UI 组件** — 彩色占位符标签渲染 |

---

## Delta 会话：template 只控制首轮完整 prompt（2026-08-23 起）

主 DAG 普通 chat/chatStream 接入 delta session 后，**template（及 story 预设）只控制首轮完整
prompt 的拼装顺序与注入内容**。首轮 / 重基线仍由 `buildAgentMessages` 照你配置的 template 完整
渲染；后续轮不再重新渲染模板，而是复用上一次实际 wire messages，只追加一条 user 增量消息
（`<context_delta>` + `<turn_context>` + 可选 `tailPrompt`）。

**后续轮的增量如何产生**：`prompt-session-assembler.ts` 会从当前 template / story 预设原文提取
占位符，并按**代码固定的四类清单**（`prompt-session-assembler.ts` 内的分类表）决定每一类的去留：

| 类别 | 占位符 | 后续回合行为 |
| ---- | ------ | ------------ |
| baseline-only | `SYS_PROMPT`、`LORE_BOOK`、`LORE_BOOK_STATIC` | 只存在于完整 baseline；原文或可见配置变化时重基线 |
| projection-backed | `CHARACTER_STATE`、`INVENTORY`、`SKILL_STATE`、`QUEST_STATE`、`GAME_TIME`、`MAP_CONTEXT`、`ACTIVE_EFFECTS`、`MEMORY_ENTRIES`、`PLOT_EVENTS`、`LORE_BOOK_DYNAMIC` | 从当前权威状态生成幂等 delta（`prompt-state-projection.ts`），变化进 `<context_delta>` |
| append-cursor | `NARRATIVE` | baseline 按 `historyLayers` 播种；后续只追加尚未表示的持久消息 |
| ephemeral | `USER_INPUT`、`RANDOM_EVENTS`、`RECENT_COMBAT`、`AGENT.*` 与链占位符 | 每轮按 template 出现顺序放入 `<turn_context>` |

这条分类**不是第二种模板语言、也不允许配置**——你仍只编辑现有 template / 预设；未注册的
占位符按既有规则原样保留在 baseline。改动 template 会进 baseline signature，自动触发重基线，
所以「改了模板想立即生效」照旧成立，无需额外步骤。

---

## 占位符完整列表

### 全局占位符（17 个，所有 Agent 可用）

> 📌 **复核 2026-08-18**：本表按 `PLACEHOLDER_REGISTRY`（`placeholder-registry.ts` ~L427 起）逐条重新对过。
> 原表只列了 10 个，缺 `LORE_BOOK_STATIC` / `LORE_BOOK_DYNAMIC` / `SKILL_STATE` / `QUEST_STATE` /
> `MAP_CONTEXT` / `RANDOM_EVENTS` / `RECENT_COMBAT` 七条。
> 🔴 文件头注释里那句「18 个」同样是陈旧数字，**以代码里那张表为准**。

| 占位符 | 解析来源 |  resolver 位置 | 参数 |
|--------|----------|:---:|------|
| `{{SYS_PROMPT}}` | Story: 预设拼接；其他: `config.systemPrompt` | registry ~L431 | — |
| `{{LORE_BOOK}}` | `resolveLoreBookSection`（静态区 + 动态区连拼） | registry ~L440 | `:section=static\|dynamic` `:limit=N` |
| `{{LORE_BOOK_STATIC}}` | 同上，只取**静态区**（裸名写法，能穿过 story 预设链路的正则闸门） | registry ~L453 | `:limit=N` |
| `{{LORE_BOOK_DYNAMIC}}` | 同上，只取**动态区**（含 EJS 的条目） | registry ~L461 | `:limit=N` |
| `{{NARRATIVE}}` | `ctx.history` 从底部数 N 层 | registry ~L465 | `:layers=N`（`:slice` 已废弃，不再截断） |
| `{{USER_INPUT}}` | `ctx.userInput` | registry ~L477 | — |
| `{{CHARACTER_STATE}}` | `buildZoneContext` → `filterZoneContent` (npc zone, agent 可见性级别) | registry ~L482 | — |
| `{{INVENTORY}}` | 遍历 `ctx.characters[*].inventory` | registry ~L493 | — |
| `{{SKILL_STATE}}` | 各角色 `skills` + 开局 `--- 初始技能 ---` 声明段 | registry ~L512 | — |
| `{{QUEST_STATE}}` | `ctx.quests`（Phase 10g） | registry ~L554 | — |
| `{{GAME_TIME}}` | `formatGameTime(ctx.gameTime)` 优先，`ctx.variables` 的世界键补天气/季节等 | registry ~L582 | — |
| `{{MAP_CONTEXT}}` | `buildMapSnapshot` → `<map_context>` 块（**没装地图包时是空串**） | registry ~L623 | — |
| `{{RANDOM_EVENTS}}` | 候选池 → `<random_events>` 块（池空/系统关闭/**战斗会话活跃**时空串） | registry ~L652 | — |
| `{{RECENT_COMBAT}}` | `ctx.recentCombat` → `<recent_combat>` 块（缺席即空串） | registry ~L673 | — |
| `{{ACTIVE_EFFECTS}}` | 遍历 `ctx.characters[*].statusEffects` | registry ~L691 | — |
| `{{MEMORY_ENTRIES}}` | `ctx.memories` 格式化 | registry ~L709 | `:top_k=N` |
| `{{PLOT_EVENTS}}` | `ctx.plotEvents` (active + pending) | registry ~L721 | — |

> 🔴 `MAP_CONTEXT` / `RANDOM_EVENTS` / `RECENT_COMBAT` 三块**自带 XML 外壳**，模板里不要再包一层中文标签——
> 包了就会在子系统未启用时留下一对空标签，把「零 token」那条设计意图静默作废。

### Agent 通信占位符（6 个，从 `ctx.agentOutputs` 读取）

> 📌 **复核 2026-08-18**：`{{AGENT.CHAR_UPDATE}}` 已删——char_update 这个 Agent 本身在
> `agent-templates.ts` 里已并入 `vars_update`（见该文件 ~L464 的注释），registry 里没有这个 key。
> 现役第六条是 `{{AGENT.REQUEST_DISPATCHER}}`（vars_update 的默认模板正在用它）。
> 「可用时机」按 `DEFAULT_AGENT_PIPELINE`（`types.ts` ~L461，2026-08-16 起 **4 层**）重算。

| 占位符 | 来源 Agent | 产出阶段 | 可用时机 |
|--------|-----------|:---:|----------|
| `{{AGENT.MEMORY_RECALL}}` | memory_recall | Stage 0 | Stage 1+ |
| `{{AGENT.PLOT_PRE_CHECK}}` | plot_pre_check | Stage 0 | Stage 1+ |
| `{{AGENT.STORY}}` | story | Stage 1 | Stage 2+ |
| `{{AGENT.REQUEST_DISPATCHER}}` | request_dispatcher | Stage 2 | Stage 3+ |
| `{{AGENT.MEMORY_SUMMARY}}` | memory_summary | Stage 2 | Stage 3+ |
| `{{AGENT.VARS_UPDATE}}` | vars_update | Stage 3 | 主 DAG 内无下游（侧链/调试可读） |

### 链占位符（8 个，由编排层 `localParams` 注入）

| 占位符 | 谁注入 | 消费者 | 注入方式 |
|--------|--------|--------|----------|
| `{{IMAGE_REQUEST}}` | scene-image-store → `callImagePromptAgent` | image_prompt | `resolveTemplate` 的 `localParams` 参数 |
| `{{CRAFT_REQUEST}}` | craft-gen-chain | craft_gen | 同上 |
| `{{CHAR_DETECT}}` | char-gen-agent | char_gen | 同上 |
| `{{ITEM_REQUEST}}` | craft-gen-chain / char-gen-agent | item_gen | 从上游输出 XML 提取 |
| `{{CHAR_GEN_RESULT}}` | char-gen-agent | item_gen | `ctx.agentOutputs` |
| `{{CRAFT_RESULT}}` | craft-gen-chain | item_gen | `ctx.agentOutputs` |
| `{{COMBAT_BRIEF}}` | game-pipeline.handleCombatTriggerV3 → combat-v3/coordinator | combat_v3 | 开局消息渲染的 `localParams`（`renderOpeningCombatMessage`） |
| `{{COMBAT_ROSTER}}` | game-pipeline.handleCombatTriggerV3 → combat-v3/coordinator | combat_v3 | 同上（从 `<combat_trigger>` 的 allies/enemies 组装「我方/敌方」名单） |

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

### B. 修改其他 Agent 的模板（Phase 10 结构化模板）

**Phase 10 推荐格式**：用 XML 标签分区 + 注释替代裸占位符拼接。

```
{{SYS_PROMPT}}                     ← 裸放，不加包装

<世界设定>                          ← XML 分区标签
{{LORE_BOOK}}
</世界设定>
<!-- 注释说明: 数据来源、AI 应该怎么用、不够怎么办 -->   ← 必需的注释

<当前需求>
{{CRAFT_REQUEST}}
</当前需求>                         ← 动态数据放最下面，提高缓存命中率
```

**缓存优化规则**：`{{SYS_PROMPT}}` 最上 → 静态数据上半 → 高频动态数据最底部。

**注释三要素**：
- 数据来源和含义
- AI 应该如何理解和使用
- Agentic Agent 需补充：如果区块数据不够，调用什么工具

1. 设置页 → Agent 配置 → 选择对应 Agent
2. 在模板编辑区的 textarea 里直接编辑（或直接改 `agent-config.json`）
3. 点击下方彩色 badge 插入占位符，用 XML 标签包裹
4. 🔍模板预览 确认
5. **保存为默认** → 写入 `agent-config.json` 的 `template` 字段

**⚠️ 联动修改提醒**：如果新增/重命名了 XML 分区标签，必须同步更新该 Agent 的 systemPrompt —— 工作流程中引用对应的标签名。详见 `agent_system_prompt_guide.md` 的「结构化模板设计规范」。

### C. 直接编辑 agent-config.json

对于批量修改或程序化更新：

```bash
# 文件位置（磁盘路径带 public/，运行期 URL 是 /data/defaults/agent-config.json）
public/data/defaults/agent-config.json

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
2. 找到 `GAME_TIME: (ctx, _config, _params) => { ... }` (~line 582，复核 2026-08-18)
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
---

## Story Agent 预设中的 ST 占位符（正文 AI 专用）

Story Agent 从旧的 SillyTavern 导入的预设中，条目内容里大量使用 `{{...}}` 格式的 **ST 专属占位符**。这些占位符在引擎运行时会被预处理——在 Code 层完成替换/剥离，使发往 LLM 的 prompt 是干净的纯文本。

### 预处理管线

两遍扫描，在 `preset-loader.ts` 的 `assemblePresetContent()` 中执行：

```
Pass 1 — 收集 setvar 变量表
  遍历所有 enabled 条目 → parseSetvars() → {key: value} map (同名后者覆盖)

Pass 2 — 逐条目替换/剥离
  ① {{char}}/{{user}} → 替换为角色名/用户名
  ② {{getvar::name}} → 查变量表替换
  ③ {{random::A,B,C}} → 运行时随机选一个
  ④ {{setvar::...}} → 剥离标签
  ⑤ {{//注释}} / {{roll ...}} / 未知 {{...}} → 剥离
  ⑥ 系统+EJS 保留原样
```

### 占位符详细说明

#### 1. `{{setvar::变量名::变量值}}` — 变量声明/赋值

**无值声明**：`{{setvar::抢话::}}` — 声明变量但暂不赋值。被剥离，不写入变量表。

**有值赋值**：`{{setvar::抢话::允许代替<user>做选择和行动}}` — 将变量"抢话"设为右值。**写入变量表（同名后者覆盖），标签本身被剥离**（setvar 是 ST 内部机制，LLM 不需要看到它）。

```plaintext
条目 0  🛑宏(不要关):  {{setvar::抢话::}}{{setvar::转述::}}
                        ↑ 声明两个变量，初始无值，标签全部剥离

条目 2  ⚙️抢话:         {{setvar::抢话::允许代替<user>进行选择、对话与行动}}
                        ↑ 赋值"抢话"，变量表 → {抢话: "允许代替..."}，标签剥离

条目 3  ⚙️不抢话弱:      {{setvar::抢话::禁止替<user>做重要决定}}
                        ↑ 同名覆盖 → {抢话: "禁止替..."}
```

**互斥条目语义**：同一组里只开一个，后开的覆盖前面的值。用户在前端开关条目来控制。

**多行值**：setvar 的值可以跨多行：

```plaintext
{{setvar::防全知g::
生成前，强制执行以下分步排查：

0. 隐藏身份绝罚排查...
1. 旁白全知排查...
   ...
}}
```

#### 2. `{{getvar::变量名}}` — 读取变量值

在条目内容中引用之前 setvar 声明的变量。**引擎运行时替换为变量表中对应的值。**

```plaintext
条目 54 ⚙️思维预算:   {{setvar::思维预算c::No more than 4096 words.}}
                       {{setvar::思维预算d::3000字以上}}

COT 条目:             思维链预算: {{getvar::思维预算c}}
                       ↓ 替换后 ↓
                      思维链预算: No more than 4096 words.
```

**表里找不到的 key** → 替换为空字符串。

**尾双冒号** → `{{getvar::转述::}}` 也正常匹配，key 为"转述"。

#### 3. `{{random::选项A,选项B,选项C}}` — 随机选择

逗号分隔选项，运行时 `Math.random()` 随机选一个替换整个标签。

```plaintext
{{random::1,2,3,4,5,6,7,8,9}}   → 可能是 "5"
{{random::A,B,C,D,E,F}}          → 可能是 "C"
```

#### 4. `{{//注释内容}}` — ST 注释

被**完整剥离**，不写入最终 prompt。用于在预设中给人类看说明。

```plaintext
{{//c是claude，g是Gemini，d是ds，不是越多越好}}  → 剥离
{{//可以自己改，改用其他文字系统}}                → 剥离
```

#### 5. `{{char}}` / `{{user}}` — 角色/用户占位符

替换为具体的角色名/用户名（由引擎运行时传入），或如果未提供则替换为占位符 `{{CHARACTER_NAME}}` / `{{USER_NAME}}`。

```plaintext
{{char}} talks to {{user}}  →  艾丽莎 talks to 冒险者
```

#### 6. `{{roll NdM+X}}` — 骰子声明

ST 原生的骰子声明。**剥离**。引擎有自己的骰子系统（`$dice`），不需要在 prompt 里声明。

```plaintext
{{roll 1d99999+1000}}  →  剥离
```

#### 7. 其他未知 `{{...}}` — 通用剥离

不属于以上任何类型、也不是系统占位符的 `{{...}}` 全部剥离。

```plaintext
{{生成菜单美化，用<style>包裹css，用<item_info>包裹菜单内容}}  → 剥离
{{lastUsermessage}}                                            → 剥离
```

#### 8. `<%...%>` EJS 模板块 — 原样保留

ST 预设中 COT（思维链）条目大量使用 EJS 条件模板来控制不同 AI 模型的行为：

```ejs
<%_ if (getvar('ai模型') === 'Gemini') { _%>
  <think_format>...</think_format>
<%_ } else if (getvar('ai模型') === 'Deepseek') { _%>
   thinking...
<%_ } else if (getvar('ai模型') === 'Claude') { _%>
  ...
<%_ } _%>
```

引擎**不执行 EJS**（这不是我们的职责），但会先做 setvar/getvar 文本替换。所以如果 `ai模型` 被 setvar 设为 `Deepseek`，COT 中的 `getvar('ai模型')` 在 EJS 代码块内也会被替换为 `Deepseek`，AI 看到的就是已替换过的条件分支。

#### 9. 系统占位符 — 保留不动

`{{NARRATIVE}}`、`{{USER_INPUT}}`、`{{AGENT.MEMORY_RECALL}}` 等我们自己的系统占位符完整保留，由后续的 `placeholder-registry.ts` 处理。

### 编辑指南

用户在设置页 → Story Agent → 预设管理 → 展开条目 → ✎ 编辑，可以自由使用上述占位符。常用的模式：

**声明一组互斥选项**：
```
条目A: {{setvar::抢话::允许扮演<user>}}      ← 只开这个 → 允许扮演
条目B: {{setvar::抢话::禁止替<user>做决定}}   ← 或只开这个 → 禁止扮演
```

**在 COT 或指令条目中引用**：
```
根据设定：{{getvar::抢话}}
当前字数要求：{{getvar::字数}}
```

**随机注入**：
```
今天的天气：{{random::晴朗,多云,小雨,暴风雨}}
```

### 实现文件

| 函数 | 文件 | 行数 |
|------|------|------|
| `parseSetvars()` | `preset-loader.ts` | ~49 |
| `resolveGetvars()` | `preset-loader.ts` | ~68 |
| `resolveRandoms()` | `preset-loader.ts` | ~87 |
| `replaceCharUser()` | `preset-loader.ts` | ~139 |
| `preprocessEntry()` | `preset-loader.ts` | ~155 |
| `assemblePresetContent()` | `preset-loader.ts` | ~206 |

### 测试

```bash
npx vitest run src/sillytavern/preset-loader.test.ts  # 48 tests，覆盖所有占位符类型
```

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
6. **模板改完要联动 systemPrompt**——如果模板中新增/重命名了 XML 分区标签（如 `<制作者状态>`），对应 Agent 的 systemPrompt 必须引用这些标签名
7. **缓存排序是模板设计的一部分**——`SYS_PROMPT` → 静态数据 → 半稳定数据 → 高频动态数据。每次改模板顺序时都要考虑缓存命中率
