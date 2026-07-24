# 2026-07-24 更新日志

## 回退机制 + Story 稳定性 + 角色状态口径修复

本日更新主要围绕三条线展开：一是新增快照/回退/重发能力，二是修复 Story Agent 上下文与正文输出稳定性，三是将角色资源公式和「在场」判定口径对齐世界书与真实游戏语义。

### 快照面板 + 右键回退重发

新增一套完整的回退机制，覆盖重新生成、编辑重发、历史回退三类需求。

- `SnapshotPanel.vue`：左侧工具栏新增「快照」入口，可查看历史保存点并恢复到任意快照。
- `ChatFlow.vue`：最新 AI 消息支持右键菜单：
  - 「回退本轮」：恢复到上一轮快照，并把本轮玩家输入回填到输入框。
  - 「复制」：复制当前 AI 消息正文。
- `game-store.ts`：新增 `rollbackOneTurn()`，串联输入捕获、快照恢复、输入回填与状态刷新。
- `state-manager.ts`：`createSnapshot()` 捕获 `plotEvents`；`restoreSnapshot()` 支持恢复剧情事件、清理快照时间之后的记忆、同步 `totalTurns`。
- `database.ts`：`trimSnapshots()` 支持保留模式：
  - `tiered`：最近 5 轮全留，旧快照按 4/8/10 回合阶梯稀疏保留，非 turn 档受保护。
  - `dense`：每轮都留。
- `SettingsPage.vue` / `settings-store.ts` / `game-pipeline.ts`：设置页新增「快照保留模式」，并在每轮管线运行前同步到数据库设置。

相关测试覆盖数据库快照裁剪、状态恢复、回退本轮等关键路径。

### Story 预设占位符修复 + 缓存命中优化

修复 Story Agent 走 SillyTavern 预设路径时，预设内部系统占位符不递归解析的问题。

此前 `story` 是唯一通过 `assemblePresetContent()` 组装 `SYS_PROMPT` 的 Agent。预设内部的 `{{LORE_BOOK}}`、`{{CHARACTER_STATE}}`、`{{NARRATIVE}}`、`{{USER_INPUT}}`、`{{AGENT.MEMORY_RECALL}}` 等占位符会裸奔成字面文本，导致 Story 实际拿不到玩家输入、角色状态、世界书、记忆等关键上下文。

本次修复：

- `agent-templates.ts`：Story 分支在组装预设后检测系统占位符，并预跑 `resolveTemplateWithGlobals()`，将预设内部占位符就地渲染成真实数据。
- Story 默认 template 简化为 `{{SYS_PROMPT}}`，避免「预设内部 + template 追加」重复注入。
- 保留无预设、预设无系统占位符、自定义 template 三种场景的原有兜底行为。
- 修复动态记忆区块位置导致的大段 prompt cache miss：避免每轮记忆变化打断 25 万字世界书之后的缓存命中。

回归测试验证：规范预设路径占位符不裸奔，用户输入只出现一次。

### Story 正文救援兜底

新增 `story-rescue.ts`，兜底修复两类真机中出现的 AI 输出缺陷：

1. **正文吞进 reasoning**：`raw` 为空，但 reasoning 里存在最后一个 `<maintext>` 正文。
2. **思维链泄漏到正文**：`raw` 非空但在 `<maintext>` 前混入前导思维链。

实现要点：

- `rescueStoryOutput()` 只对 `story` Agent 生效。
- raw 空门控：只救坏轮，避免误处理正常输出。
- 取最后一个 `<maintext>`：避开 reasoning 前部对格式的说明性提及。
- 注入点在 `agent-orchestrator.ts` 的 `callAgent` 末尾，流式与非流式结果都覆盖最终 `AgentResult`。
- 局限：只修最终结果，不重写流式增量内容。

新增 11 个单元测试覆盖正文提取、防误判与 story 守卫。

### 角色资源公式对齐世界书

修复 NPC 与捏人预览的 HP / MP / SP 计算公式，统一对齐世界书 `[角色生成]` 与 `[核心数值表]`。

- `tier-constants.ts`：废弃旧的 `calcHP()` / `calcMP()` / `calcSP()` 死公式，新增统一 `calcResources(tier, attrs)`：
  - HP = 体 × 100 × hpMul + 五维和
  - MP = (智 + 精) × 50 × mpMul
  - SP = (力 + 敏) × 50 × mpMul
- `char-gen-agent.ts`：NPC 生成改用 `calcResources()`，并补 `expToNext = tierConfig.expCap`。
- `create-store.ts`：捏人预览切换到 `calcResources()`，补中文属性键到英文键的映射。
- 示例修正：妲丽安 T3 资源从 HP 24 / MP 54 / SP 60 修正为 HP 2442 / MP 5700 / SP 5100，`expToNext` 从 100 修正为 4000。

相关测试覆盖公式、创角预览、角色生成、上下文模板与战斗引用路径。

### `location` / `present` 语义拆分

拆分「角色所在地点」与「角色是否在场」两个概念，解决用 `location` 前缀匹配判断在场导致的显示错误。

- `types.ts`：`CharacterState` 新增 `present: boolean`，默认 `true`。
- `state-manager.ts`：`UPDATE_CHAR_WHITELIST` 允许 AI 写入 `present`。
- `char-query.ts`：新增 `isPresent()`；`getPresentCharacters()` 改为严格判断 `present === true`，不再依赖 `location` 前缀；`summarizeChar()` 显示 `[在场/离场]`。
- `ScenePanel.vue` / `CharacterListPanel.vue`：前端统一按 `present === true` 展示在场角色。
- `char-gen-agent.ts`：新生成 NPC 从上下文继承玩家 `location`，并默认 `present: true`。
- `agent-config.json`：`vars_update` systemPrompt 补充 `present` 字段说明，进场写 `true`，离场写 `false`。
- `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md`：补充 `present` 字段规范。

### 网页品牌与图标

- `index.html`：页面标题从 `IndependentFront for Destined Journey` 改为「命定之诗与黄昏之歌」。
- `public/favicon.png`：新增 256×256 favicon，并配置 `rel=icon` 与 `apple-touch-icon`。

### 配置与仓库维护

- `.claude/agents/code-writer.md`：新增项目专用 `code-writer` 自定义 subagent 定义。
- `.gitignore`：忽略 `tmp/` 新文件、`tests/realtime_export/*.json`、`tests/realtime_export/log.txt` 等真机调试导出；历史已追踪脚本保留。
- `agent-config.json`：用户手动调整 6 处 `setvar` 词汇条目，细化词汇表配置。

### 验证状态

- Story 预设占位符修复：`typecheck` 0 错误，全量测试 2911/2912 通过，1 个预存 `SelectableCard` CSS 失败与本改动无关。
- 角色资源与在场字段修复：2917/2919 通过，2 个预存失败无关（`game-store` 剧情 flaky + `SelectableCard` CSS 主题化）。
