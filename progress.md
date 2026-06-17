# Progress Log

## Session: 2026-06-13

### Phase 1: 架构设计 & 可行性验证
- **Status:** complete ✅
- **Started:** 2026-06-13
- **Completed:** 2026-06-13
- **Revised:** 2026-06-13（用户反馈 4 点修正）
- Actions taken:
  - 安装了 tavernlike skill（/sillytavern-web）
  - 初始化 npm 项目 + 安装 dexie + TypeScript
  - 生成 10 个核心 TypeScript 模块到 src/sillytavern/
  - 创建 Vanilla Store (src/vanilla/sillytavern-store.ts)
  - 创建演示页面 (src/components/SillyTavern/index.html)
  - TypeScript 编译零错误验证
  - 写入 CLAUDE.md（含人格扮演指令 + v4 架构演进方向）
  - 备份 ARCHITECTURE.md → ARCHITECTURE_backup_20260613.md
  - 创建 ARCHITECTURE_TEMPLATE.md + 用户填写需求
  - 分析现有架构 vs 需求（30% 复用 / 70% 新建）
  - 提取 v4.2.1 角色卡关键脚本（首页/捏人/状态栏）
  - 提取 lorebook JSON 关键条目（战斗协议/mvu_update/状态规则）
  - **Phase 1 架构设计**：
    - ✅ 前端：路由 / 三栏组件树 / Store→UI 数据流
    - ✅ 后端：7 Agent DAG 管线 / Prompt 模板 / 缓存策略
    - ✅ Agent 编排引擎：AgentDefinition / Pipeline / AgentContext / OrchestratorRun 数据结构
    - ✅ 代码复用：13 文件逐文件评估（保留2/扩展8/重写3/新建17）
    - ✅ 角色可插拔：统一 CharacterState 接口 + CharacterCard 导入格式
    - ✅ EJS 兼容：导入时静态化（禁用世界书动态 EJS）
    - ✅ DeepSeek 缓存隔离：独立 userId + 固定前置/可变后置 + 预期收益表
    - ✅ 10 条架构决策记录 (ADR-01 ~ ADR-10)
  - **Phase 1 修正 (v2)**：
    - ✅ CharacterState 补充登神长阶/要素/权能/法则/神位/神国（来自 InitVar YAML）
    - ✅ Prompt vs Code 边界定义：确定性→code，创造性→prompt
    - ✅ EJS 策略修正：禁用世界书 EJS → 导入时静态化（ADR-04 更新，缓存命中率↑）
    - ✅ 组件树修正：状态栏移至右侧栏顶部 + 新增 MapTopologyPanel
    - ✅ API 总控设计：ApiEndpoint + AgentConfig 分离，设置页 UI 布局
    - ✅ 新增 ADR-11 ~ ADR-15
- Files created/modified:
  - src/sillytavern/*（10 文件，创建）
  - src/vanilla/sillytavern-store.ts（创建）
  - src/components/SillyTavern/index.html（创建）
  - CLAUDE.md（创建 + 修改，含 v4 架构演进方向）
  - ARCHITECTURE.md（备份 → 模板 → 用户填写）
  - ARCHITECTURE_TEMPLATE.md（创建）
  - ARCHITECTURE_backup_20260613.md（创建，备份）
  - task_plan.md（创建，8 Phase）
  - findings.md（创建 + Phase 1 完整设计）
  - progress.md（创建）
  - package.json（修改，含 dexie + typescript）
  - tsconfig.json（创建）

### Phase 2: 核心数据结构 & 数据库设计
- **Status:** complete ✅
- **Started:** 2026-06-13
- **Completed:** 2026-06-13
- Actions taken:
  - ✅ 扩展 types.ts：新增 CharacterState/ElementDetail/AuthorityDetail/LawDetail/EquipmentSlot/Skill/InventoryItem/StatusEffect/CharacterCard/MemoryRecord/PlotEvent/Snapshot/SaveSlot/ApiEndpoint/AgentConfig/AgentDefinition/AgentPromptTemplate/Pipeline/PipelineStage/AgentContext/AgentResult/OrchestratorRun/MapTopology/TopologyEdge 等 ~20 个接口/类型
  - ✅ 新增 createDefaultCharacterState() / resolvePlotTree() / PlotEventNode 辅助函数和类型
  - ✅ AppSettings 扩展 6 字段：apiEndpoints / agentConfigs / agentPipeline / cacheStrategy / maxSnapshotsPerSave / maxMemoriesRecall
  - ✅ VarsPatch 扩展：支持 replace/delta/insert 三种 mvu_update 操作
  - ✅ PlotEvent 扁平存储设计：childrenIds 替代递归 children，运行时 resolvePlotTree() 重建嵌套树
  - ✅ database.ts DB_VERSION → 4，新增 6 表：memories / plotEvents / characters / snapshots / saves / apiEndpoints
  - ✅ v3 → v4 迁移脚本：自动为现有 settings 添加 v4 字段默认值
  - ✅ 新增 20+ CRUD 函数：getMemories/getMemoriesByIds/saveMemory/deleteMemory/getRecentMemories/getPlotEvents/getActivePlotEvents/savePlotEvent/savePlotEvents/deletePlotEvent/getCharacters/getCharacter/getCharactersByType/saveCharacter/saveCharacters/deleteCharacter/getSnapshots/getSnapshot/getLatestSnapshot/saveSnapshot/deleteSnapshot/trimSnapshots/getSaves/getSave/getSaveBySlot/saveSaveSlot/deleteSaveSlot/getApiEndpoints/getApiEndpoint/saveApiEndpoint/deleteApiEndpoint
  - ✅ FullBackup + exportAllData/importAllData 扩展至 10 表（拆分为 3 个 transaction）
  - ✅ DEFAULT_AGENT_PIPELINE 常量（2阶段并行 + 4阶段串行，7 Agent）
  - ✅ TypeScript 编译零错误 + npm build 通过
- Files created/modified:
  - src/sillytavern/types.ts（修改，~250 行新类型 + 辅助函数）
  - src/sillytavern/database.ts（修改，~200 行新表+迁移+CRUD）

### Phase 3: Agent 编排引擎
- **Status:** complete ✅
- **Started:** 2026-06-13
- **Completed:** 2026-06-13
- Actions taken:
  - ✅ 实现 `agent-client.ts` — AgentClient 类，OpenAI 兼容 /chat/completions 客户端
  - ✅ 每 Agent 独立 userId（`fp|{saveId}|{agentId}`）— DeepSeek 缓存隔离核心
  - ✅ 自动重试 + 指数退避（1s, 2s, 4s...）
  - ✅ 超时控制 + AbortSignal 外部取消
  - ✅ 缓存命中检测（cache_hit / prompt_cache_hit_tokens / x-ds-cache-hit header）
  - ✅ `buildUserId()` / `parseUserId()` 工具函数
  - ✅ 实现 `agent-templates.ts` — 7 个 Agent 的完整 Prompt 模板
  - ✅ 固定前缀（fixedSystem + fixedExamples）→ 缓存命中关键
  - ✅ 可变后缀（variableContext + variableInstruction）→ 每轮动态注入
  - ✅ 辅助函数：formatHistory/formatCharacters/formatMemories/formatPlotEvents/formatVariables/formatLorebook
  - ✅ `buildAgentMessages()` — 一键构建 system+user messages
  - ✅ 实现 `agent-orchestrator.ts` — DAG 编排引擎核心
  - ✅ 按 Pipeline.stages 顺序执行，同阶段 Agent 并行
  - ✅ 流程单向性：上游输出 → context.agentOutputs → 下游读取（不可回写）
  - ✅ `regenerateAgent()` — 手动重生成指定 Agent
  - ✅ 管线验证：未知 Agent / 缺失依赖 / DAG 合法性
  - ✅ `stageDependenciesMet()` — 依赖检查，失败则跳过下游阶段
  - ✅ `onlyAgents` 过滤器 + 禁用 Agent 跳过
  - ✅ 事件回调：onStageStart/onAgentStart/onAgentComplete/onAgentError/onStageComplete
- Tests:
  - `agent-client.test.ts` — 15 tests（userId/成功/错误/重试/超时/AbortSignal/缓存命中）
  - `agent-templates.test.ts` — 50 tests（7 Agent 模板完整性/fixedSystem/fixedExamples/variableContext/variableInstruction/buildAgentMessages/模板质量）
  - `agent-orchestrator.test.ts` — 16 tests（管线验证/单Agent执行/多阶段串行/并行/上下文传递/错误处理/regenerateAgent/onlyAgents/禁用/事件回调/OrchestratorRun结构）
  - **全部 161 tests 通过**（83 Phase 2 + 78 Phase 3）
- Files created/modified:
  - src/sillytavern/agent-client.ts（新建，~130 行）
  - src/sillytavern/agent-templates.ts（新建，~320 行）
  - src/sillytavern/agent-orchestrator.ts（新建，~270 行）
  - src/sillytavern/agent-client.test.ts（新建，~240 行）
  - src/sillytavern/agent-templates.test.ts（新建，~200 行）
  - src/sillytavern/agent-orchestrator.test.ts（新建，~340 行）
  - src/sillytavern/types.ts（修改，OrchestratorRun.status 添加 'idle'）
  - vitest.config.ts（新建）

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| TypeScript type-check | npx tsc --noEmit | 无错误 | 0 errors | ✓ |
| npm install dexie | npm install dexie | 安装成功 | installed ^4.4.3 | ✓ |
| JSON script extraction | node -e script | 找到3个目标脚本 | 3/3 found | ✓ |
| TypeScript type-check v4 | npx tsc --noEmit | 0 errors | 0 errors | ✓ |
| npm build v4 | npm run build | 成功 | 成功 | ✓ |
| Vitest (Phase 2) | npx vitest --run | 83 passed | 83 passed | ✓ |
| Vitest (Phase 3) | npx vitest --run | 161 passed | 161 passed | ✓ |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-06-13 | TS18047 'settings' possibly null | 1 | 添加 const s = settings! 类型守卫 |
| 2026-06-13 | ENOENT node path double E: drive | 1 | 改用 E:/code/... 格式 |
| 2026-06-13 | scripts count 0 at top level | 1 | 深入 data.extensions.regex_scripts 查找 |
| 2026-06-13 | Dexie transaction() overload — 10 tables exceeds ~5-table TypeScript arg limit | 2 | 将 importAllData 拆分为 3 个 transaction 分批导入 |
| 2026-06-13 | TS2615 PlotEvent.children 循环引用导致 Dexie mapped type 无限递归 | 1 | 改用 childrenIds: string[] 扁平存储 + resolvePlotTree() 运行时重建 |
| 2026-06-13 | AgestClient AbortSignal — 外部已abort的signal注册listener不触发 | 1 | callOnce 中先检查 signal.aborted 再决定注册listener |
| 2026-06-13 | ESM require() — `const { X } = require('./types')` 在 type:module 下报错 | 2 | 统一使用顶层 import |

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 4 已完成 — 记忆系统 & 剧情规划 |
| Where am I going? | Phase 4.5 → 事件系统基础设施 (GameEvent + StateManager) → Phase 8 交付 |
| What's the goal? | 多 Agent 文字 RPG 引擎 + 可插拔角色 + 缓存优化 + 浏览器 UI |
| What have I learned? | See findings.md |
| What have I done? | Phase 1-4 全部完成 (369 tests) |

### Phase 4: 记忆系统 & 剧情规划
- **Status:** complete ✅
- **Started:** 2026-06-14
- **Completed:** 2026-06-14
- Actions taken:
  - ✅ types.ts: 新增 PlotOutline、PlotSettings、DEFAULT_PLOT_SETTINGS、MemoryRecord.embedding、AppSettings 新增 5 字段 (plotSettings/embeddingEndpointId/embeddingModel/embeddingDimension/memoryCompressionThreshold)
  - ✅ types.ts: DEFAULT_AGENT_PIPELINE 更新 — plot_check→plot_pre_check、plot_correct→plot_post_check、Stage 0/5 调整
  - ✅ database.ts: DB_VERSION 4→5，新增 plot_outlines 表 (id/saveId/updatedAt 索引)
  - ✅ database.ts: v5 升级迁移 — 自动为旧 settings 补全 Phase 4 字段
  - ✅ database.ts: 新增 5 个 PlotOutline CRUD 函数 + FullBackup/exportAllData/importAllData/deleteSaveSlot 扩展
  - ✅ agent-templates.ts: 新增 plot_pre_check (正文前触发检查)、plot_post_check (正文后世界线修正)、plot_outline (大纲生成) 完整模板
  - ✅ agent-templates.ts: plot_check/plot_correct 保留为 v3 兼容别名
  - ✅ agent-orchestrator.ts: 内置 Agent 列表更新 (添加 plot_pre_check/plot_post_check/plot_outline)
  - ✅ **memory-store.ts** (新建, ~170 行): computeEmbedding / cosineSimilarity / recallMemories / getRoundCount / checkCompressionNeeded / applyCompression / saveMemoryWithEmbedding
  - ✅ **memory-summarizer.ts** (新建, ~190 行): generateMemoryId / validateMemoryContent / parseMemorySummaryOutput / summarizeAndSave / createCompressionSummaryMemory
  - ✅ **plot-outline.ts** (新建, ~210 行): parseOutlineAgentOutput / createOutlineFromAgent / evaluateOutlineQuality / confirmOutline / parseOutlineChapters / outlineToEvents / updateOutlineVersion / shouldGenerateOutline / isSideMode / isMainMode / getActiveOutline / syncOutlineEvents
  - ✅ **plot-engine.ts** (新建, ~260 行): evaluateCondition / parsePreCheckOutput / preCheckPlot / parsePostCheckOutput / postCheckPlot / propagateWorldLineChange / eventToMemory / getPendingEventsForTrigger / autoGenerateMemoriesFromEvents
  - ✅ **4 测试文件**: memory-store.test.ts / memory-summarizer.test.ts / plot-outline.test.ts / plot-engine.test.ts
  - ✅ TypeScript 编译零错误 + npm build 通过
  - ✅ **369 tests 全部通过** (168 Phase 2-3 + 201 Phase 4)
- Files created/modified:
  - src/sillytavern/types.ts (修改: +PlotOutline/PlotSettings/DEFAULT_PLOT_SETTINGS/MemoryRecord.embedding/AppSettings新字段/Pipeline更新)
  - src/sillytavern/database.ts (修改: v5升级/plot_outlines表/CRUD/级联删除/全量备份扩展)
  - src/sillytavern/agent-templates.ts (修改: 3新模板+2兼容别名)
  - src/sillytavern/agent-orchestrator.ts (修改: 内置Agent列表)
  - src/sillytavern/memory-store.ts (新建)
  - src/sillytavern/memory-summarizer.ts (新建)
  - src/sillytavern/plot-outline.ts (新建)
  - src/sillytavern/plot-engine.ts (新建)
  - src/sillytavern/memory-store.test.ts (新建)
  - src/sillytavern/memory-summarizer.test.ts (新建)
  - src/sillytavern/plot-outline.test.ts (新建)
  - src/sillytavern/plot-engine.test.ts (新建)

### Phase 4 架构亮点

| 模块 | 行数 | 导出函数 | 职责 |
|------|------|---------|------|
| memory-store.ts | ~170 | 7 | Embedding 召回引擎: 向量计算/余弦相似度/top-K召回/压缩触发 |
| memory-summarizer.ts | ~190 | 5 | 记忆总结: MEM编号生成/Agent输出解析/校验/持久化 |
| plot-outline.ts | ~210 | 12 | 大纲管理: AI生成/自检/确认/→事件树/版本更新 |
| plot-engine.ts | ~260 | 10 | 剧情运行时: pre-check触发/post-check修正/条件评估/世界线传播 |

### 新管线 (Phase 4 DAG)
```
Stage 0: memory_recall + plot_pre_check (并行)
Stage 1: story
Stage 2: vars_update
Stage 3: char_update
Stage 4: memory_summary
Stage 5: plot_post_check
```

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| TypeScript type-check | npx tsc --noEmit | 无错误 | 0 errors | ✓ |
| npm build v5 | npm run build | 成功 | 成功 | ✓ |
| All tests (972) | npm test -- --run | 972 passed | 972 passed | ✓ |

### Phase 5: 角色 & 变量系统 + $ API 命名空间 ✅
- ✅ validate.ts (新建, ~200行): Layer 1 数值约束 — clamp/角色校验/Patch校验/物品技能校验/$validate
- ✅ time-system.ts (新建, ~180行): Layer 2 游戏时间 — parse/format/advance/compare/daytime/season/$time
- ✅ resource-calc.ts (新建, ~170行): Layer 2 资源计算 — HP%/支付检查/物品技能查询/经验公式/$resource
- ✅ char-query.ts (新建, ~180行): Layer 2 角色查询 — ID查询/位置过滤/状态摘要/战力比较/登神长阶/$char
- ✅ var-resolver.ts (新建, ~220行): Layer 2 变量系统 — 命名空间隔离/路径解析/VarsPatch应用/diff追踪/$var
- ✅ 5 测试文件: 365 tests
- ✅ 编译零错误 + 972 tests 全部通过

**9 $ API Namespace 实现进度:**

| Namespace | 状态 | 模块 |
|-----------|------|------|
| `$dice` | ✅ | dice.ts (Phase 4.5) |
| `$validate` | ✅ | validate.ts |
| `$resource` | ✅ | resource-calc.ts |
| `$char` | ✅ | char-query.ts |
| `$var` | ✅ | var-resolver.ts |
| `$time` | ✅ | time-system.ts |
| `$combat` | ⬜ | Phase 6 |
| `$craft` | ⬜ | Phase 6 |
| `$status` | ⬜ | Phase 6 |

### Phase 4.5: 事件系统基础设施 (GameEvent + StateManager) ✅
- ✅ types.ts: +~150 行 (GameEvent/StatePatch/EffectDefinition/DiceRollResult/CombatAction 等)
- ✅ dice.ts (新建, ~140行): Layer 2 骰池 — d20/d100/优势劣势/DC判定/临界/$dice namespace
- ✅ state-manager.ts (新建, ~400行): ADR-21 唯一写入入口 — 20 种 Patch 操作/自动快照
- ✅ effect-runtime.ts (新建, ~240行): 声明式效果引擎 — 6 种效果/条件评估/优先级/连锁
- ✅ game-event.ts (新建, ~240行): EventBus 按存档隔离 — 发布订阅/7 工厂函数/历史
- ✅ 4 测试文件: 238 tests
- ✅ 编译零错误 + 607 tests 全部通过

---
*Update after completing each phase or encountering errors*

### Phase 6a: 战斗系统 ✅
- **Status:** complete ✅
- **Started:** 2026-06-15
- **Completed:** 2026-06-15
- Actions taken:
  - ✅ types.ts 扩展: +~120 行 (CombatType(6种)/DamageType(4种)/HitRating(7级)/IntentionLevel(8级)/CombatParticipant/CombatState/CombatDamageBreakdown(8步)/CombatActionRequest扩展/CombatActionResult完整版)
  - ✅ combat-intention.ts (新建, ~220 行): 关键词→意图解析 / 6级意图对抗检定(攻方T×5+d20 vs 守方T×5+d20+难度) / 层级压制 / 失能自动成功 / 处决自动成功 / 非致死判定
  - ✅ combat-damage.ts (新建, ~330 行): 8步伤害管线(初始→多段分割→穿透→装备减免→类型减免→评级意图→DR→集群) / 攻击检定(优劣势/闪避无效) / 状态触发判定 / AoE集群结算
  - ✅ combat-turn.ts (新建, ~180 行): 先攻公式(敏捷×(1+速度%)+d20+固定修正) / 排序 / 回合资源追踪(1攻击+1动作) / 序列验证
  - ✅ combat-panel.ts (新建, ~270 行): <action_info> XML三阶段面板(战况总览/行动顺序/攻击行动) / 完整8步管线展开 / 简洁摘要 / AoE行
  - ✅ combat-resolver.ts (新建, ~410 行): 完整战斗管线整合 / $combat API (attack/defend/flee/initCombat/endCombat/getState) / 参与者转换
  - ✅ TypeScript 编译零错误 + npm build 通过
  - ✅ **1516 tests** 全部通过 (1362 previous + 154 new combat tests)

### Phase 6a 架构亮点

| 模块 | 行数 | 导出函数 | 职责 |
|------|------|---------|------|
| combat-intention.ts | ~220 | 5 | 意图解析: 8级意图/对抗检定/层级压制/非致死 |
| combat-damage.ts | ~330 | 15 | 伤害管线: 8步计算/命中评级/攻击检定/状态触发 |
| combat-turn.ts | ~180 | 10 | 回合管理: 先攻排序/资源追踪/序列验证 |
| combat-panel.ts | ~270 | 6 | 面板生成: 三阶段XML/完整管线展开/摘要 |
| combat-resolver.ts | ~410 | 10 | 战斗引擎: 管线整合/$combat API/参与者转换 |

### 世界书对齐
- ✅ 战斗类型: 切磋/竞技/压制/死斗/标准/守卫 (6种, 对齐 #837805)
- ✅ 六意图+非致死+处决: 对症 #837805 第三阶段 §3
- ✅ 命中评级: ≥30(超暴击,2.0)→≤3(失手,0) (7级, 对齐世界书)
- ✅ 伤害公式: 关联属性×10×层级系数 + 技能威力 + 武器攻击力
- ✅ 类型减免: 物理(体+力+敏)×0.25% / 能量(精+智)×0.4% / 精神×0.8% / 真实0
- ✅ 先攻公式: (敏捷×(1+速度%)) + d20 + 固定修正
- ✅ 装备减免: 伤害 × (有效防御 / (有效防御 + 2000))
- ✅ 集群修正: ×1.5
- ✅ d20 优劣势: 高T vs 低T → 优势; 低T vs 高T → 劣势

### Phase 6b: 制作系统 ✅
- **Status:** complete ✅
- **Started:** 2026-06-15
- **Completed:** 2026-06-15
- Actions taken:
  - ✅ types.ts 扩展: +~220 行 (QualityLevel统一类型(7级)/CraftIndustry(4种)/CraftStage(3级加工)/CraftRating(4级)/CraftDCBase表/品质产能加成表(CraftProductionBonus)/CraftMaterial/CraftActionRequest完整版/CraftActionResult完整版(含三阶段结果)/CraftCheckBreakdown/CraftSettlementBreakdown/CraftPrepResult/CraftCheckResult/CraftSettleResult)
  - ✅ craft-quality.ts (新建, ~270 行): 品质继承(至少2种同品质→降级)/逐级降级查找/阶段验证(层级上限)/DC修正生成(品质范围内随机)/管制物检测(史诗+需许可)/资源预检/品质升降级/批次模式(基础加工半成品无需图纸→可批量)
  - ✅ craft-dc.ts (新建, ~340 行): 骰池系统(T高→优势2d20取高/T低→劣势2d20取低)/品质DC公式(基础DC+材料修正-产能减免)/确定性掷骰/经验计算(基础加工0/半成品半额/成品全额/层级压制归零)/FP计算(品质乘数1-12)/产能加成(普通→神话全配置)/材料节省(d20阈值)/大失败豁免(神话)/品质提升(传说→神话d20≥18)
  - ✅ craft-resolver.ts (新建, ~580 行): 完整3阶段管线(准备→检定→结算)/$craft API(AI可见:startProject/check/validate/getBaseDC/getExpTable/getProductionBonus)/<action_info>三阶段面板生成/失败描述/StatePatch生成
  - ✅ TypeScript 编译零错误 + npm build 通过
  - ✅ **1671 tests** 全部通过 (1516 previous + 155 new craft tests)

### Phase 6b 架构亮点

| 模块 | 行数 | 导出函数 | 职责 |
|------|------|---------|------|
| craft-quality.ts | ~270 | 15 | 品质链: 继承/降级/校验/DC修正/管制/资源/批次 |
| craft-dc.ts | ~340 | 15 | DC引擎: 骰池/计算/经验FP/产能加成/材料节省 |
| craft-resolver.ts | ~580 | 8 | 制作管线: 3阶段/$craft API/面板/描述/Patch |

### 世界书对齐
- ✅ 4制作类型: 锻造(力量)/炼金(智力)/烹饪(精神)/裁缝(敏捷) (对齐 #683615)
- ✅ 3级加工: 基础加工/半成品/成品 (对齐 #683615)
- ✅ 品质DC: 普通6→神话40 (对齐 #265160)
- ✅ 品质产能加成: 普通~神话 全配置 (对齐 #265160)
- ✅ 品质经验: 普通50→神话6000 (对齐 #284017)
- ✅ 品质继承: 至少2种同品质投入物 (对齐 #683615)
- ✅ 精益求精: 批量+10%/单件额外词条 (对齐 #683615)
- ✅ 管制物: 史诗+需许可 (对齐 #683615)
- ✅ 骰池: 层级比较→优势/劣势 (对齐 #683615)
- ✅ 大失败: d20=1→100%损毁; 神话豁免 (对齐 #683615)

### Phase 6c: 集群/士气系统 ✅
- **Status:** complete ✅
- **Started:** 2026-06-15
- **Completed:** 2026-06-15
- Actions taken:
  - ✅ types.ts 扩展: +~50 行 (ClusterFormResult/ClusterAttritionResult/MoraleCheckResult/MoraleModifiers/MORALE_OUTCOME_POOL/MORALE_STATE_LABELS)
  - ✅ cluster-system.ts (新建, ~270 行): 集群形成(≥3同类合并)/HP%比例/攻击次数(80%→3/50%→2/<50%→1)/伤害修正(×1.5)/减员(按HP折算存活数)/意图免疫/范围结算/集群资格判定(T1-3)/面板格式化
  - ✅ morale-system.ts (新建, ~250 行): 4级战意状态机(steady→shaken→wavering→routing)/高阈值自动触发(切磋/竞技/压制)/低阈值d20检定(死斗/标准/守卫)/结果池(投降/溃逃等)/战意行为修正/处决条件检测/批量检测/面板格式化
  - ✅ TypeScript 编译零错误 + npm build 通过
  - ✅ **1783 tests** 全部通过 (1671 previous + 112 new Phase 6c tests)

### Phase 6c 架构亮点

| 模块 | 行数 | 导出函数 | 职责 |
|------|------|---------|------|
| cluster-system.ts | ~270 | 15 | 集群管理: 形成/HP比例/攻击次数/减员/伤害修正/意图免疫 |
| morale-system.ts | ~250 | 13 | 士气引擎: 状态机/阈值检测/自动vs检定/结果池/行为修正 |

### 世界书对齐
- ✅ 集群形成: ≥3同类低级单位自动聚合 (对齐 #837805 §1.3)
- ✅ 攻击次数: HP≥80%→3次/≥50%→2次/<50%→1次 (对齐 #837805 §3.2)
- ✅ 集群修正: ×1.5 伤害 (对齐 #837805 §3.5)
- ✅ 意图免疫: 集群无法触发意图/部位攻击 (对齐 #837805 §3.5)
- ✅ 范围结算: min(范围x, 集群n) (对齐 #837805 §3.6)
- ✅ 战意阈值: 切磋40%/竞技30%/压制50%/死斗10%/标准30%/守卫35% (对齐 #837805 §5.2)
- ✅ 高阈值自动触发 vs 低阈值d20<12检定 (对齐 #837805 §5.2)
- ✅ 战意结果池: 投降/认输/溃逃等 (对齐 #837805 §5.3)
- ✅ 处决条件: wavering/routing + 处决意图 → 自动成功 (对齐 #837805 §3.3)

### Phase 6d: 好感度系统 ✅
- **Status:** complete ✅
- **Started:** 2026-06-15
- **Completed:** 2026-06-15
- Actions taken:
  - ✅ affection-system.ts (新建, ~140 行): 精简版好感度 — 仅做钳制[-100,+100]+读写+标签(11级对齐#966681)+$affection API
  - ✅ 架构决策: Code 层只负责数值存储和边界保护，行为判断全部交给叙事 AI
  - ✅ TypeScript 编译零错误 + npm build 通过
  - ✅ **1869 tests** 全部通过 (1827 previous + 42 new affection tests)

### Phase 6d 设计哲学

| 决策 | 选择 | 理由 |
|------|------|------|
| Code 层职责 | 仅钳制 + 读写 + 标签 | 用户指示简化，行为/判断/演绎交给叙事 AI |
| $affection API | get/set/add/batch/label/simpleLabel | 6 个方法，vars_update Agent 每回合可调用 |
| 不可变操作 | 每次返回新 AffectionMap | 遵循 StateManager 不可变更新模式 |

### 世界书对齐
- ✅ 范围: -100 ~ +100 (对齐 #966681)
- ✅ 标签: 11 级命名区间 (对齐 #966681)
- ✅ 简化标签: 友好/中立/敌对 三档（供简易 UI 使用）
