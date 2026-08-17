# 游玩→导出→分析→修复 调试循环操作手册

> 适用场景：主人跑一轮游戏，发现不符合预期的行为，需要 Claude 分析导出数据并定位修复。
> 本手册定义了标准化的分析流程，确保每次调试循环高效一致。

---

## 循环总览

```
┌─────────────────────────────────────────────────────────────┐
│  1. 主人跑一轮游戏 → 导出 debug JSON + log.txt               │
│  2. Claude 并行分派 Agent 分析导出数据                        │
│  3. Claude 汇总分析报告 → 按严重度排序问题                     │
│  4. 主人确认优先级 → Claude 逐个修复                          │
│  5. typecheck + 全量测试 → 循环                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Step 1：导出数据获取

主人跑一轮游戏后，需要把以下两个文件放到 `tests/realtime_export/` 下（该目录已在 `.gitignore` 里，**本机自建、不进仓库**，全新 clone 看不到它是正常的）：

| 文件 | 说明 | 来源 |
|------|------|------|
| `fated-poem-debug-*.json` | Agent 日志导出（含 7 个 Agent 的 messages、rawResponse、duration、tokensUsed） | 浏览器 F12 Console 导出 |
| `log.txt` | 浏览器 Console 日志（含 console.log/error/warn） | 浏览器 F12 Console 复制 |

**命名约定**：保持 debug JSON 自动生成的文件名不变，方便追溯。

---

## Step 2：Claude 分析 — 分派 Agent

Claude 接收到导出数据后，按以下清单**并行分派 Agent**（一个消息中同时发起多个 Agent 调用），每个 Agent 负责一个分析维度：

### 分析维度清单

| # | 分析维度 | Agent 任务描述 | 关注点 |
|---|---------|---------------|--------|
| 1 | **Story 思维链** | 读 JSON 中 story agent 的 system message + rawResponse | System prompt 是否完整？输出是否有 `<thinking>` / Step 标记？是否按 `<maintext>/<option>/...` XML 格式输出？ |
| 2 | **其他 Agent 调用** | 读 JSON 中所有 7 个 Agent 的状态 | 哪些被跳过（model 空）？哪些报错？rawResponse 是否为空？是否有 "missing field `model`" 等 API 错误？ |
| 3 | **memory_summary 质量** | 读 JSON 中 memory_summary 的 rawResponse | content 是否过于啰嗦？hiddenLine 是否在数据为空时编造内容？keywords 是否有重复？ |
| 4 | **前端 UI 行为** | 读 log.txt + 相关 Vue 组件 | `isGenerating` 是否正确切换？中断按钮是否出现？开场白是否过长？ |
| 5 | **开场白质量** | 读 log.txt 中 `openingPrompt length` + JSON 中 story 的 rawResponse | 开场白是否包含过长的命定核心全文？是否包含 `[object Object]` 等字符串污染？ |

### 并行分派示例

```
Claude: "我派 5 个 Agent 并行分析导出数据喵～"

Agent 1: 分析 story 思维链 → 读 tests/realtime_export/fated-poem-debug-*.json
Agent 2: 分析其他 Agent 调用 → 同上
Agent 3: 分析 memory_summary → 同上
Agent 4: 分析前端 UI 行为 → 读 tests/realtime_export/log.txt + InputBar.vue + GamePage.vue + game-pipeline.ts
Agent 5: 分析开场白 → 读 tests/realtime_export/log.txt + create-store.ts
```

**关键原则**：
- 每个 Agent 聚焦单一维度，避免分析范围过大
- 5 个 Agent 在同一个消息中发起，并行执行
- Agent 返回后 Claude 汇总，按严重度排序

---

## Step 3：汇总报告 → 确定优先级

Claude 汇总各 Agent 的分析结果，按以下优先级排序：

| 优先级 | 标签 | 含义 | 示例 |
|--------|------|------|------|
| 🔴 P0 | 阻断性 | 游戏完全无法正常运转 | 无法中断生成、API 调用全部失败 |
| 🔴 P1 | 严重 | 核心功能缺失或数据错误 | story 预设未注入、memory 编造内容 |
| 🟡 P2 | 中等 | 影响体验但不阻断 | 开场白过长、UI 显示异常 |
| 🟢 P3 | 轻微 | 可优化但不紧急 | 格式不遵守、内容稍微啰嗦 |

**报告格式**（每次必须用这个表格）：

```markdown
| # | 优先级 | 问题简述 | 根因 | 修法 | 涉及文件 |
|---|--------|---------|------|------|---------|
| 1 | P0 | ... | ... | ... | ... |
| 2 | P1 | ... | ... | ... | ... |
```

---

## Step 4：修复

主人确认优先级后，Claude 开始修。**每次修复遵守以下规则**：

### 修复规则

1. **一次一个，顺序修复**。不要并行修多个不相关的 bug。
2. **每次修改后立即 typecheck + 全量测试**。
3. **修完所有 bug 后跑一次全量测试确认**。
4. **涉及 prompt 的修改**（`agent-config.json` 中的 systemPrompt/template）：确保修改前后格式一致，不要破坏 JSON 结构。
5. **涉及类型/接口的修改**：TypeScript 类型检查必须 0 错误。

### 常见修复模式速查

| 问题类型 | 典型根因 | 典型修法 | 检查点 |
|---------|---------|---------|--------|
| Agent 输出为空/格式不对 | `config.systemPrompt` 空 | 检查 agent-config.json 对应字段 | `buildAgentMessages()` |
| Agent 被跳过 | model 配置为空字符串 | 设置页选择模型 | agent-config.json `model` 字段 |
| API 调用报 missing field `model` | `endpoint.defaultModel` 为 undefined | `buildEndpoints()` vs 原始类型转换 | `agent-client.ts:493` |
| 预设未注入 | `config.presetId` 为空 | `buildAgentConfigs()` 读 `projectAgentDefaults` | `agent-templates.ts:325` |
| 世界书未注入 | `OrchestratorOptions.worldBooks` 为空 | `loadActiveWorldBooks()` → `filterBooksByEnabledEntries()` | `game-pipeline.ts` |
| `{{LORE_BOOK}}` 为空 | `placeholder-registry` 全局变量未设 | `resolveTemplateWithGlobals()` → `setPlaceholderGlobals()` | `placeholder-registry.ts:31-32` |
| `[object Object]` 字符串污染 | placeholder resolver 返回了对象 | `String()` 包裹之前检查类型 | `placeholder-registry.ts` 各 resolver |
| 前端按钮不切换 | state ref 没更新 | 设 `isGenerating = true` | `game-pipeline.ts:run()` |
| 旧存档数据残留 | `loadSave()` 条件覆盖守卫 | `clearActive()` 无条件清空 + 始终覆写 | `game-store.ts` |

---

## Step 5：验证

每次修复后执行：

```bash
npm run typecheck    # TypeScript 类型检查，必须 0 错误
npm run test -- --run  # 全量测试，必须全部通过
```

**注意**：如果改动改变了现有行为，必须同步更新对应测试用例。

---

## Agent 分派模板

以下是可以直接复制使用的 Agent 分派模板，每次调试时根据实际情况调整文件路径即可：

### 分析维度 1：Story Agent 思维链

```
Read `tests/realtime_export/fated-poem-debug-*.json`. 
Focus on the story agent (agentId: "story").
1. Extract the first 300 and last 300 chars of the system message.
2. Does the system prompt contain thinking chain requirements (Step 1/2/3, CoT)?
3. Does the story output contain <thinking>, <maintext>, <option>, <sum>, <vars> XML?
4. Does the output follow the requested XML format?
5. Is there a literal "[object Object]" string in the system prompt?
```

### 分析维度 2：各 Agent 调用状态

```
Read `tests/realtime_export/fated-poem-debug-*.json`.
Check ALL agents: memory_recall, plot_pre_check, story, request_dispatcher, 
vars_update, memory_summary, plot_post_check.
For each: success or failure? rawResponse length? duration? error messages?
Also check the log.txt for API errors like "missing field `model`".
```

### 分析维度 3：memory_summary 质量

```
Read `tests/realtime_export/fated-poem-debug-*.json`.
Focus on the memory_summary agent.
1. Extract the full rawResponse. How long is it?
2. Does hiddenLine fabricate content when plot events / game time are empty?
3. Is the content overly verbose? Can it be condensed?
4. Are keywords duplicated or too many?
```

### 分析维度 4：中断按钮与 UI

```
Read `src/ui/components/game/InputBar.vue`, `src/ui/components/game/GamePage.vue`,
`src/ui/stores/game-store.ts`, and `src/ui/lib/game-pipeline.ts`.
Check: does InputBar have stop button UI? Is `isGenerating` properly set to true?
What prevents the send button from switching to stop during generation?
```

### 分析维度 5：开场白质量

```
Read `tests/realtime_export/log.txt` for openingPrompt length.
Read `src/ui/stores/create-store.ts` `buildOpeningPrompt()` function.
Check: is the destiny core full text injected into the opening prompt?
Should it be shortened to a brief reference since world books already include it?
```

---

## 关键文件速查

| 文件 | 内容 | 何时查阅 |
|------|------|---------|
| `public/data/defaults/agent-config.json` | 11 个 Agent 的 systemPrompt + template + preset | Agent 行为异常 |
| `src/sillytavern/agent-templates.ts` | buildAgentMessages + fallback 逻辑 | 预设/SYS_PROMPT 未注入 |
| `src/sillytavern/agent-orchestrator.ts` | 编排引擎 + OrchestratorOptions | 世界书/预设传递断裂 |
| `src/sillytavern/agent-client.ts` | API 调用 + chatWithTools + SSE 流式 | API 调用错误 |
| `src/sillytavern/worldbook-loader.ts` | 世界书加载/过滤/格式化 | 世界书注入异常 |
| `src/sillytavern/placeholder-registry.ts` | {{PLACEHOLDER}} 解析 + 默认模板 | 占位符未替换或 [object Object] |
| `src/sillytavern/template-resolver.ts` | resolveTemplateWithGlobals | 模板解析异常 |
| `src/sillytavern/preset-loader.ts` | 预设加载 + assemblePresetContent | 预设装配异常 |
| `src/sillytavern/memory-summarizer.ts` | 记忆摘要解析 | memory_summary 输出格式 |
| `src/ui/lib/game-pipeline.ts` | 前端→引擎桥接 + AgentConfig 构建 | pipeline 配置/注入断裂 |
| `src/ui/stores/game-store.ts` | Pinia 游戏状态 | 消息残留/isGenerating |
| `src/ui/stores/create-store.ts` | 捏人页 + buildOpeningPrompt | 开场白内容 |
| `src/ui/stores/settings-store.ts` | 设置持久化 + projectAgentDefaults | Agent/API 配置 |
| `src/sillytavern/char-gen-agent.ts` | char_gen→item_gen 链 | char_gen 调用失败 |
| `src/sillytavern/craft-gen-chain.ts` | craft_gen→item_gen 链 | craft_gen 调用失败 |
| `src/sillytavern/item-gen-chain.ts` | item_gen 独立链 | item_gen 调用失败 |

---

## 补充说明

### 关于热重载 vs 重启

项目使用 Vite HMR（热模块替换），大部分代码修改后会自动热重载。但以下情况需要手动刷新浏览器：
- `public/data/defaults/agent-config.json` 的修改（静态文件，Vite 可能缓存旧版本）
- IndexedDB 结构变更（需要清除浏览器 IndexedDB 或在 DevTools 中删库重建）

**建议**：每次修完一轮 bug 后，刷新浏览器页面再跑一轮测试。

### 关于 token 效率

导出 JSON 文件通常 1MB+，**不要一次读完整个文件让 Claude 主线程分析**。应该：
1. 先用 `grep -n` / `wc -c` 摸清文件结构（行数、Agent 数量）
2. 按 Agent 分块（每个 Agent 的 messages/rawResponse 独立），派 Agent 分段读
3. 控制每个 Agent 的 single-context 不超过 ~2000 行
