# Plan 4: 集成验证 — 端到端手动验证 + 调试面板

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 手动验证全流程可行性 — 从创角到实际游玩，确保前端、引擎、存档三端连通。使用调试面板观察每个环节的数据流，发现并修复问题。

**Architecture:** 不写自动化测试（AI API 无法 mock）。通过真实 AI API 调用，逐环节验证数据流：创角→写 DB→游戏页加载→开场 Prompt→AI 叙事→用户输入→多轮对话→刷新恢复。调试面板（Alt+Shift+D）提供运行时状态查看。

**Tech Stack:** Chrome DevTools + IndexedDB inspector + 调试面板

## Global Constraints

- 不需要 plot 模块（`plotSettings.mode='off'`）
- 不需要战斗模块（combat_trigger 回调返回 null）
- 配置 DeepSeek API endpoint + model 后方可验证
- `npm run build` 必须通过

---

### Task 1: 前置检查清单

- [ ] **Step 1: 确认 API 配置正确**

打开设置页 → API 配置板块，确认：
- 至少一个 API endpoint 已配置（DeepSeek / 硅基流动 等）
- model 列表已获取
- 连接测试通过

- [ ] **Step 2: 确认 Agent 配置正确**

打开设置页 → Agent 配置板块，确认：
- story / memory_recall / request_dispatcher / vars_update / memory_summary 五个 Agent 都已配置 model
- 每个 Agent 的 systemPrompt 不为空（从 `data/defaults/agent-config.json` 加载）
- Embedding API（memory_recall 的向量召回）可选 — 没有也不阻塞

- [ ] **Step 3: 确认世界书已加载**

打开设置页 → 世界书板块（或 DevTools → localStorage），确认：
- `fated-poem-settings` 中的 `worldBooks` 数组不为空
- 至少 `system_core` 和 `character` 两本书存在

- [ ] **Step 4: 确认 build 通过**

```bash
npm run build
```

Expected: 无编译错误，dist 正常生成。

- [ ] **Step 5: Commit（如有修复）**

```bash
git add -A
git commit -m "chore: Plan 4 前置检查 — API / Agent / 世界书 / Build 确认"
```

---

### Task 2: 创角→存档 验证

- [ ] **Step 1: 启动 dev server**

```bash
npm run dev
```

打开浏览器访问首页 → 点击「开始旅程」进入捏人页。

- [ ] **Step 2: 完成创角全流程**

| 步骤 | 操作 | 验证点 |
|------|------|--------|
| 0 难度 | 选择一个难度 | 转生点数条正确显示 |
| 1 基础信息 | 填写名称/性别/年龄/种族/身份/地点，分配属性 | BP/AP 余额正确，HP/MP/SP 预览合理 |
| 2 命定核心 | 从世界书加载的列表中选择一个核心 | **验证点 A**: 列表非空，来自 system_core 世界书 |
| 3 角色启用 | 勾选几个角色 | **验证点 B**: 列表非空，来自 character 世界书 |
| 4 装备 | 选择初始装备/技能/物品 | 消耗正确计入总费用 |
| 5 背景 | 选一个背景故事 | 条件检查正常工作 |
| 6 规划 | 跳过（剧情模块 off） | — |
| 7 确认 | 点击「开始命运之旅」 | 跳转到游戏页 |

- [ ] **Step 3: 验证存档已正确写入**

打开 Chrome DevTools → Application → IndexedDB → `SillyTavernWebDB`：

**characters 表:**
```
□ 1 条记录，type='player'，name/race/tier/attributes 正确
```

**saves 表:**
```
□ 1 条记录
□ metadata.enabledWorldBookEntries 包含 system_core:xxx 和 character:xxx
□ metadata.openingPrompt 非空字符串
□ metadata.openingPromptConsumed = false
```

**saveProfiles 表:**
```
□ 1 条记录，saveId 与 saves 表一致
□ fp = 0, gameTime 已初始化
```

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: Plan 4 创角验证修复"
```

---

### Task 3: 游戏页→开场叙事 验证

- [ ] **Step 1: 首次加载观察**

进入游戏页后：
1. 打开调试面板（**Alt+Shift+D**）
2. 观察 Debug Panel → Messages 区域
3. 确认开场 Prompt 自动发送后，等待 AI 回复

**预期行为:**
```
□ 控制台日志: [GamePipeline] Agent 开始: memory_recall
□ 控制台日志: [GamePipeline] Agent 开始: story
□ ChatFlow 出现 AI 开场叙事（非占位符文本）
□ Debug Panel Messages 有 1 条 assistant 消息
□ loadSave 中没有再发送第二次开场 Prompt（openingPromptConsumed=true）
```

- [ ] **Step 2: 验证消息持久化**

打开 Chrome DevTools → Application → IndexedDB → `messages` 表：

```
□ 有 1 条 role='assistant' 的消息
□ 有 1 条 role='user' 的消息（开场 Prompt 以 user 身份发送）
□ saveId 与当前存档一致
□ turn 编号正确
```

- [ ] **Step 3: 验证 Agent 管线完整执行**

在控制台中搜索 `[GamePipeline]`：

```
□ memory_recall → Agent 开始 + Agent 完成
□ story → Agent 开始 + Agent 完成（rawResponse 包含叙事正文）
□ request_dispatcher → Agent 开始 + Agent 完成
□ vars_update → Agent 开始 + Agent 完成
□ memory_summary → Agent 开始 + Agent 完成
```

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: Plan 4 开场叙事验证修复"
```

---

### Task 4: 多轮对话 + 刷新恢复 验证

- [ ] **Step 1: 多轮对话**

在 InputBar 输入 2-3 轮对话：

| 轮次 | 输入 | 验证点 |
|------|------|--------|
| 1 | 任意行动描述 | AI 正常回复，ChatFlow 追加消息 |
| 2 | 另一个行动 | AI 回复包含叙事推进，非重复模板 |
| 3 | 第三个行动 | 调试面板确认 messages 数量正确增长 |

- [ ] **Step 2: 验证 chars/memory 表更新**

```
□ characters 表 — player 的 location/hp/mp 可能有变化
□ memories 表 — 有新的记忆记录（如果 memory_summary 生成）
□ messages 表 — 消息数与 ChatFlow 一致
```

- [ ] **Step 3: 刷新恢复**

F5 刷新页面：

```
□ ChatFlow 恢复了所有历史消息（从 messages 表加载）
□ 开场 Prompt 不会再次发送（openingPromptConsumed=true）
□ 可以继续输入新消息
□ pipeline 正常工作
```

- [ ] **Step 4: Commit（如有修复）**

```bash
git add -A
git commit -m "fix: Plan 4 多轮对话刷新修复"
```

---

### Task 5: 边缘情况验证 + 收尾

- [ ] **Step 1: 空输入保护**

InputBar 空文本点击发送：
```
□ 不触发 pipeline.run()
□ 无错误日志
```

- [ ] **Step 2: API 不可用时的降级**

临时把 API endpoint 的 baseUrl 改成无效地址，发送消息：

```
□ 不崩溃，不白屏
□ ChatFlow 显示降级消息: "[系统] AI 调用失败，请检查 API 配置后重试。"
□ isGenerating 正确复位为 false
□ 可以再次尝试发送
```

- [ ] **Step 3: 创角跳过角色选择**

创角时不勾选任何角色（enabledCharacterEntryUids 为空）：

```
□ startJourney 正常完成
□ metadata.enabledWorldBookEntries 只包含 system_core:xxx
□ 游戏页正常加载
```

- [ ] **Step 4: 调试面板切换**

```
□ Alt+Shift+D 打开面板
□ 再次 Alt+Shift+D 关闭面板
□ 不影响游戏页交互
```

- [ ] **Step 5: 全量测试最后一次**

```bash
npm run test -- --run
npm run build
```

```
□ 全量测试 PASS
□ build 成功
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: Plan 4 边缘情况验证完成 + 全量测试 + Build 通过"
```
