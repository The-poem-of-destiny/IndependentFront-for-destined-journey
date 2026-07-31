# 2026-07-23 更新日志

## 缓存 token 统计 + 输出美化修复 + 崩溃修复

### 缓存 token 统计（DebugPanel）

DebugPanel 新增「本轮缓存 token 汇总」：命中 / 未命中 / 输出 token（排除记忆召回），每条 Agent 日志也独立显示这三项 + 耗时。方便直观评估 DeepSeek prompt cache 效率。

- `types.ts`：`AgentResult` + `DebugAgentEntry` 新增 `cacheHitTokens` / `cacheMissTokens` / `completionTokens`
- `agent-client.ts`：`chat` / `chatWithTools` / `chatStream` 解析 DeepSeek `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` / `completion_tokens`；**流式请求补 `stream_options.include_usage`**（否则流式末尾 chunk 不返回 usage）
- `agent-orchestrator.ts`：流式 `onComplete` 透传三字段（**此前 story 走流式恒 0/0/0**）
- `game-pipeline.ts` / `game-store.ts` / `DebugPanel.vue`：链路透传 + 汇总展示

### 输出美化修复（两个 bug）

**bug1：开局正则不生效，要去设置转一圈才好**

预设规则加载原绑死在 `BeautifierSection.onMounted`，`s.beautifierPresetRules` 默认空，要打开「设置→输出美化」才填充。提到 `settings-store` 启动初始化（世界书加载后），游戏页一进来就有规则。

**bug2：自动管理全亮 + autoEnable 信号源错误**

根因两层：

- **数据层**：`beautifier-rules.json` 18 条规则挂了 `worldBookIds:["system_core"]`，核心书因含变量系统等默认 enabled 条目而恒活跃，`resolveAutoEnable` 的 OR 逻辑短路、绕过精确 uid 匹配 → 全 locked。删除该字段（uid 本就全对，保留）。
- **信号源**（更深）：autoEnable 原以「worldBooks 条目 enabled」为信号，但那是「是否注入 prompt」的开关（核心书 480 条目几乎全 enabled），**不等于「这局选了哪个命定核心」**。命定核心是存档级单选，存于 `save.metadata.enabledWorldBookEntries`（`system_core:413` 格式）。改为以此为信号源：
  - `beautifier.ts`：`collectActiveWorldBookSignals(books)` → `collectActiveSignalsFromEntries(entries)`
  - 设置页 + 游戏页都按存档命定核心 uid 判断，只有玩家本局选的核心（如妲丽安 413）对应的美化才激活

### AgentStatusPanel 崩溃修复

`AgentStatusPanel.vue:42` 的 `game.agentStatus.label` 在 `isGenerating=true` 但 `agentStatus=null`（**Agent 切换间隙**：上一个 clear、下一个还没 update）时崩溃。给当前 Agent 行加 `v-if="game.agentStatus"`，间隙时整行不渲染（面板仍可显示已完成的 history）。

### 统计

- 修改 12 个文件，新增 1 个 changelog
- typecheck 0 错误
