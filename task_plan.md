# 命定之诗 (Fated Poem) — 修正版完整实施计划 v4

> 基于 `命定之诗与黄昏之歌v4.2 绿灯命中微调版 (1).json`（492 条世界规则，排除 113 条 TavernDB）的 5 维度交叉审查
> 2026-06-15 | 架构修订: 三层子系统分流 (Craft/Combat/CharGen)

## Current Phase

**Phase 7: 前端 UI** ← 当前位置 | **1978 tests** | 编译 0 错误 | 41 test files

---

## 🆕 v4 架构: 三层子系统分流

基于正文 AI 调用 SubAgent 的三种时机模式:

```
                        ┌─ 调用时机 ──┬─ AI/C分工 ────┬─ 状态写入 ─┐
SubSystem-Craft  制作   │ 正文中阻塞   │ AI创意+Code计算 │ 即时Patch   │
SubSystem-Combat 战斗   │ Stage1后检测 │ Code循环+AI摘要 │ 批量Patch   │
SubSystem-CharGen 角色  │ Stage2异步   │ AI生成+物品Agent│ 延迟写入    │
```

**核心理由:**
- **制作**: 需要AI生成创意效果(词条/命名/描述) + Code 做DC/骰检。正文阻塞等待，类似 tool-calling 模式。
- **战斗**: 面板数据量大(每回合千token级)，独立窗口避免污染正文上下文；结束后AI生成摘要回注。
- **角色生成**: 新NPC当前回合只用外观+一句话；完整数据下回合才需要，异步后置不打断叙事。

### 完整 Pipeline (v4)

```
Stage 0:  memory_recall + plot_pre_check     (并行，不变)
Stage 1:  story (正文)                        (新增阻塞/标记)
            │
            ├─ 🛑 [onCraftIntent] → Story AI 暂停
            │    → 调用 Craft Agent (独立API)
            │    → Craft Agent: 读正文→调用$craft工具→生成创意效果
            │    → 返回结果注入正文 → 继续叙事
            │
            ├─ 🚩 [onCombatTrigger] → 正文收尾 + 输出 <combat_trigger>
            │    → 正文结束 (Stage 1 完成)
            │
            └─ 👤 [新角色出现] → 叙事中简单描述，不中断
                 → 隐式标记，vars_update 阶段处理
                         │
                         ▼
Stage 1.5: [暂存] 检测 <combat_trigger> → 暂存，等待 Stage 2
                         │
                         ▼
Stage 2:  vars_update
            ├── 应用 Craft 产生的 Patch
            ├── 🔍 检测新角色 → 异步触发 CharGen Agent
            │     └── CharGen → 调 ItemGen Agent (仅一次)
            ├── 🚩 执行暂存的 Combat Trigger (新敌人已就绪)
            │     └── 独立战斗窗口 → Combat Loop + AI摘要 + StatePatch
            └── 所有写入通过 StateManager
                         │
                         ▼
Stage 3:  char_update       (同步新角色到存档)
Stage 4:  memory_summary    (压缩记忆)
Stage 5:  plot_post_check   (世界线修正)
```

### 对应的新 Agent 列表

| Agent | 触发者 | 时机 | 职责 |
|-------|--------|------|------|
| **craft_gen** | Story AI | Stage 1 阻塞 | 判定难度/调用$craft工具/生成创意效果词条 |
| **char_gen** | vars_update | Stage 2 异步 | 名字/五维/种族/背景/登神长阶 → 调 item_gen |
| **item_gen** | char_gen | 被char_gen调用(仅1次) | 技能/装备/道具生成 → 遵循 #261442 + #265160 |
| **combat_summary** | 战斗窗口 | Stage 1.5 独立 | 战斗叙事摘要 (回合数/关键事件/战利品) |

---

## 关键架构决策 (ADR)

| ID | 决策 | 版本 |
|----|------|------|
| ADR-04 | EJS 由 Code 层在提示装配时评估，注入 variableContent（**v2 修正: 不再静态预渲染**） | v2 |
| ADR-11 | Prompt vs Code 边界：确定性逻辑→Code，创造性推理→Prompt | v1 |
| ADR-19 | $ API 语义级抽象：AI 调 `$combat.attack()`，Code 内部执行公式 | v1 |
| ADR-20 | 声明式优先：VarsPatch + StatusEffect，覆盖率 <90% 才引入 DSL | v1 |
| ADR-21 | StateManager 为唯一写入入口 (`commitChatState`) | v1 |
| ADR-22 | FP 是存档级元货币，独立于 CharacterState（SaveProfile 概念） | v3 |
| ADR-23 | namespace-normalizer: `stat_data.*` ↔ 语义命名空间双向映射 | v3 |
| ADR-24 | 三层子系统分流: Craft(正文阻塞Agent)/Combat(独立窗口)/CharGen(异步后置) | 🆕 v4 |
| ADR-25 | Marker Protocol: 正文通过 XML 标记与引擎通信 (craft_request/combat_trigger/new_char_detect) | 🆕 v4 |
| ADR-26 | SubAgent 链: char_gen → item_gen (仅1次调用，防高并发浪费token) | 🆕 v4 |

---

## Phase 1: 架构设计 & 可行性验证 ✅

- [x] 完整梳理前端需求（页面结构、组件树、数据流）
- [x] 完整梳理后端需求（Agent 管线、Prompt 模板、缓存策略）
- [x] 设计 Agent 编排引擎数据结构（AgentDefinition / Pipeline / AgentContext）
- [x] 评估现有代码复用率（13 文件逐文件评估，30% 复用 / 70% 新建）
- [x] 设计多角色可插拔架构（NPC/主角/怪物统一 CharacterState 接口）
- [x] 设计 EJS 模板兼容方案（→ ADR-04，后修正为 v2）
- [x] 设计 DeepSeek 多 userID 缓存隔离方案（`fp|{saveId}|{agentId}`）
- [x] 写入 findings.md，产出 15 条 ADR (ADR-01~ADR-15)
- [x] 创建 ARCHITECTURE_TEMPLATE.md + 用户填写需求
- [x] 分析 Prompt vs Code 边界（ADR-11: 确定性→Code，创造性→Prompt）
- [x] 组件树调整（状态栏移至右侧栏 + 新增 MapTopologyPanel）
- [x] API 总控设计（ApiEndpoint + AgentConfig 分离）
- [x] 角色卡导入格式设计（CharacterCard + _engine 元数据）
- **Status:** complete ✅ | 2026-06-13

---

## Phase 2: 核心数据结构 & 数据库设计 ✅

- [x] 扩展 types.ts: CharacterState / ElementDetail / AuthorityDetail / LawDetail / EquipmentSlot / Skill / InventoryItem / StatusEffect / CharacterCard / MemoryRecord / PlotEvent / Snapshot / SaveSlot / ApiEndpoint / AgentConfig / AgentDefinition / AgentPromptTemplate / Pipeline / PipelineStage / AgentContext / AgentResult / OrchestratorRun / MapTopology / TopologyEdge 等 ~20 个接口
- [x] 新增 createDefaultCharacterState() / resolvePlotTree() 辅助函数
- [x] AppSettings 扩展 6 字段: apiEndpoints / agentConfigs / agentPipeline / cacheStrategy / maxSnapshotsPerSave / maxMemoriesRecall
- [x] VarsPatch 扩展: replace / delta / insert 三种 mvu_update 操作
- [x] PlotEvent 扁平存储设计: childrenIds 替代递归 children
- [x] database.ts DB_VERSION 3→4，新增 6 表: memories / plotEvents / characters / snapshots / saves / apiEndpoints
- [x] v3→v4 迁移脚本: 自动补全 Settings v4 字段默认值
- [x] 20+ CRUD 函数: getMemories / saveMemory / getPlotEvents / savePlotEvent / getCharacters / saveCharacter / getSnapshots / saveSnapshot / trimSnapshots / getSaves / saveSaveSlot / deleteSaveSlot / getApiEndpoints 等
- [x] FullBackup + exportAllData / importAllData 扩展至 10 表（3 transaction 拆分）
- [x] DEFAULT_AGENT_PIPELINE 常量（7 Agent DAG 管线）
- [x] ADR-16: PlotEvent 扁平存储 / ADR-17: SaveSlot 级联删除 / ADR-18: importAllData 3-transaction 拆分
- **Status:** complete ✅ | 2026-06-13

---

## Phase 3: Agent 编排引擎 ✅

- [x] 实现 `agent-client.ts` — AgentClient 类，OpenAI 兼容 /chat/completions 客户端
- [x] 每 Agent 独立 userId（`fp|{saveId}|{agentId}`）— DeepSeek 缓存隔离核心
- [x] 自动重试 + 指数退避（1s, 2s, 4s...）
- [x] 超时控制 + AbortSignal 外部取消
- [x] 缓存命中检测（cache_hit / prompt_cache_hit_tokens / x-ds-cache-hit header）
- [x] buildUserId() / parseUserId() 工具函数
- [x] 实现 `agent-templates.ts` — 7 Agent Prompt 模板（memory_recall / plot_check / story / vars_update / char_update / memory_summary / plot_correct）
- [x] 固定前缀（fixedSystem + fixedExamples）→ 缓存命中关键
- [x] 可变后缀（variableContext + variableInstruction）→ 每轮动态注入
- [x] 辅助函数: formatHistory / formatCharacters / formatMemories / formatPlotEvents / formatVariables / formatLorebook
- [x] buildAgentMessages() — 一键构建 system+user messages
- [x] 实现 `agent-orchestrator.ts` — DAG 编排引擎核心
- [x] 按 Pipeline.stages 顺序执行，同阶段 Agent 并行（Promise.allSettled）
- [x] 流程单向性: 上游输出 → context.agentOutputs → 下游读取（不可回写）
- [x] regenerateAgent() — 手动重生成指定 Agent
- [x] 管线验证: 未知 Agent / 缺失依赖 / DAG 合法性
- [x] stageDependenciesMet() — 依赖检查，失败则跳过下游阶段
- [x] onlyAgents 过滤器 + 禁用 Agent 跳过
- [x] 事件回调: onStageStart / onAgentStart / onAgentComplete / onAgentError / onStageComplete
- [x] **161 tests** 全部通过（agent-client 15 + agent-templates 50 + agent-orchestrator 16 + types/db 80）
- **Status:** complete ✅ | 2026-06-13

---

## Phase 4: 记忆系统 & 剧情规划 ✅

- ✅ types.ts: PlotOutline / PlotSettings / MemoryRecord.embedding + Pipeline 更新
- ✅ database.ts: v5 升级 + plot_outlines 表
- ✅ agent-templates.ts: plot_pre_check / plot_post_check / plot_outline
- ✅ memory-store.ts: Embedding 召回 + 余弦相似度 + 压缩触发
- ✅ memory-summarizer.ts: MEM 编号 + 校验 + 持久化
- ✅ plot-outline.ts: 大纲 AI 生成 / 自检 / →事件树 / 版本管理
- ✅ plot-engine.ts: pre-check / post-check / 条件评估 / 世界线传播
- **369 tests** | 新增 201 tests

---

## Phase 4.5: 事件系统基础设施 ✅

- ✅ dice.ts: d20/d100/优势劣势/DC判定/临界 + $dice
- ✅ state-manager.ts: ADR-21 唯一写入入口，20 种 Patch 操作
- ✅ effect-runtime.ts: 声明式效果引擎，6 种效果分发
- ✅ game-event.ts: EventBus 按存档隔离 + 7 事件工厂
- ✅ types.ts: GameEvent / StatePatch / EffectDefinition / DiceRollResult 等
- **607 tests** | 新增 238 tests

---

## Phase 5: $ API 命名空间 ✅

- ✅ validate.ts: Layer 1 数值约束 + $validate
- ✅ time-system.ts: Layer 2 游戏时间 + $time
- ✅ resource-calc.ts: Layer 2 资源计算 + $resource
- ✅ char-query.ts: Layer 2 角色查询 + $char
- ✅ var-resolver.ts: Layer 2 变量命名空间隔离 + $var
- **972 tests** | 新增 365 tests

---

## Phase 4.6: Foundation Layer（P0 缺口修正） ✅

### 4.6.1 SaveProfile (`save-profile.ts`)
- 新增类型: SaveProfile / FPTransaction / FateContract
- database.ts: v6 升级 + saveProfiles 表 + CRUD
- getFP() / addFP() / spendFP() / addContract() / addAchievement()

### 4.6.2 FP 系统 (`fp-system.ts`)
- calcContractCost(T1:200→T6:150000) / calcFPFromTask() / calcFPFromIntimacy()
- $fp namespace

### 4.6.3 EJS 运行时 (`ejs-runtime.ts`)
- 沙盒 eval: `new Function('getMessageVar', 'setMessageVar', 'Math', 'JSON')`
- Token 化解析 + 错误隔离 + 批量渲染

### 4.6.4 Effect 声明解析器 (`effect-parser.ts`)
- `parseEffectDeclaration("攻击力: +50, DR: 5%")` → ParsedEffect[]
- 中→英键映射（50+ 条）

### 4.6.5 变量持久化修复
- StateManager: set_variable/delta_variable 不再 stub，真正写入
- StatePatchOp 扩展: remove_variable / move_variable / insert_variable
- var-resolver: moveVar() + applyVarsPatch 扩展

**1176 tests** | 新增 204 tests

---

## Phase 5 (EXPANDED): 数据层 ✅

### 5.1 命名空间规范化 (`namespace-normalizer.ts`)
- flatToEngine() / engineToFlat(): `stat_data.主角.HP` ↔ `char.player.hp`
- 50+ 条映射表 + normalizeVariables() / denormalizeVariables()

### 5.2 核心数值表 (`tier-constants.ts`)
- TIER_CONFIGS[7]: HP/MP/SP 乘数、战斗系数、EXP 上限、品质上限
- calcHP() / calcMP() / calcSP() / calcExpToNext() / canBreakthrough()

### 5.3 血脉系统 (`bloodlines.ts`)
- 23 种已知血脉静态数据 + calcBloodlineModifiers()
- 4 大分类：智人种/亚人种/幻身种/异界种（对齐世界书 #906373）
- 觉醒/继承/复合机制由 AI 叙事演绎（ADR-11）

### 5.4 死亡检测 (`death-system.ts`)
- 最小实现: detectDeath() + detectDeaths()
- 复活机制（延迟/FP补偿/状态恢复）由 AI 世界书规则演绎（ADR-11）

**1310 tests** | 新增 134 tests

---

## Geography Phase: 位置系统 ✅

**目标**: 位置数据库 + 拓扑连通性查询
**预估**: 1 模块 | ~50 tests | 累计 ~1362 tests

### G.1 位置数据库 (`location-db.ts`)
- `DEFAULT_LOCATIONS` 嵌入式世界地图（**32 节点，10 势力**，5 层级：大陆→势力→城市→区域）
- 10 势力：奥古斯提姆帝国/诺斯加德联盟/萨赫拉联邦/赛瑞利亚/翡翠之心/翼民圣都梵尼亚/永夜盟约/瓦伦蒂亚/索伦蒂斯王国/兽族联盟（对齐世界书）
- `buildAdjacency()` 构建双向邻接表 / `getLocationNode()` 按 ID 查找
- `getChildren()` 层级子节点 / `getNeighbors()` 图邻居 / `getContinent()` 向上追溯大洲
- `getLocationPath()` 完整层级路径 / `areAdjacent()` 直连判断 / `getEdge()` 边详情
- `$location` AI 可见查询 API
- ✅ 48 tests

### 设计决策
- ❌ 不做路径规划/旅行时间计算 — 叙事 AI 的职责
- 静态嵌入数据，无需 DB 表，遵循 bloodlines.ts 模式
- 旧死代码 MapTopology/TopologyEdge 已删除
- 势力间拓扑边来自世界书条目 #580370 [地理拓扑优化]

---

## Phase 6a: 战斗系统（EXPANDED） ⬜

**数据来源**: 世界书 #837805 [战斗协议] + #884517 [随机池] + #265160 [品质效果限定]
**硬依赖链**: 类型扩展 → CombatIntention → CombatDamage → CombatTurn → CombatResolver
**预估**: 5 模块 | ~275 tests | 累计 ~1637 tests

### 6a.0 战斗类型 & 数据结构 (`types.ts` 扩展)
- `CombatType`: 切磋 / 竞技 / 镇压 / 死斗 / 标准（5 种，影响士气阈值和集群行为）
- `CombatActionRequest` 扩展: `combatType` + `round` + `participants`
- 世界书伤害公式: `关联属性×10×层级系数 + 技能威力 + 武器攻击力`

### 6a.1 战斗意图解析 (`combat-intention.ts`)
- 6 级意图: 常规→战术→机能→核心→抹杀→概念
- `resolveIntention()`: 中文输入解析 + 层级对抗检定 `(攻方T×5+d20) vs (守方T×5+d20+意图难度)`
- 层级压制（攻方T < 守方T-1 → 强制失败）/ 非致死判定 / 失能处决自动成功

### 6a.2 伤害管线 (`combat-damage.ts`)
- 8 步计算: 基础→多段分割→穿透→装备减免→类型减免→评级系数→DR→最终
- 7 级命中评级（超暴击2.0≥30 / 强暴击1.6≥25 / 暴击1.3≥20 / 有效1.0(11-19) / 勉强0.8(8-10) / 擦伤0.3(4-7) / 失手0≤3）+ 4 伤害类型（physical/energy/spirit/true）

### 6a.3 回合管理 (`combat-turn.ts`)
- `rollInitiative()`: `(敏捷×(1+速度修正%)) + d20 + 固定修正`（对齐世界书公式）
- 每单位 1 攻击 + 1 动作/回合

### 6a.4 战斗面板生成 (`combat-panel.ts`)
- `<action_info>` XML: `{战况总览}` + `| 数据行 |`（对齐世界书格式）

### 6a.5 战斗解析器 (`combat-resolver.ts`)
- 整合意图→先攻→攻击→伤害→面板→StatePatch 完整管线

---

## Phase 6b: 制作系统 ✅

**Status: complete ✅ | 1671 tests | 155 新增 craft tests**

### 已完成模块
- ✅ `types.ts` 扩展: +~220 行 (QualityLevel/CraftIndustry(4种)/CraftStage(3级)/CraftRating(4级)/DC基准/产能加成/CraftMaterial/CraftCheckBreakdown/CraftSettlementBreakdown)
- ✅ `craft-quality.ts` (新建, ~270行): 品质继承/逐级降级/阶段验证/DC修正生成/管制物/资源检查
- ✅ `craft-dc.ts` (新建, ~340行): 骰池(优势劣势)/品质DC公式/经验FP计算/产能加成(普通→神话)/材料节省
- ✅ `craft-resolver.ts` (新建, ~580行): 3阶段管线(准备→检定→结算) / `$craft` API (6方法)

**🆕 后续: Craft Agent (Phase 6e)** — 制作需 AI 生成创意效果(词条/命名/描述)，因此 Code 层做好后还需 Craft Agent 模板。Story AI 在正文中遇到制作意图时阻塞调用 Craft Agent，Agent 读取正文→调用 $craft 工具→生成创意效果→返回叙事。

---

## Phase 6c: 集群/士气系统 ✅

**Status: complete ✅ | 1783 tests | +112 tests**

**数据来源**: 世界书 #837805 [战斗协议]

### 6c.1 集群系统 (`cluster-system.ts`) ✅
- ≥3 同类敌人自动合并，HP%决定攻击次数(≥80%→3次/≥50%→2次/≥30%→1次)，×1.5 伤害修正
- 集群减员按 HP% 折算存活数 / 意图免疫 / 范围结算 min(范围, 集群数) / T1-3 资格判定

### 6c.2 士气系统 (`morale-system.ts`) ✅
- 4 状态: steady→shaken→wavering→routing
- 基于战斗类型的士气阈值: 切磋40%/竞技30%/压制50%/死斗10%/标准30%/守卫35%
- 高阈值自动触发 / 低阈值 d20<12 检定 / 结果池(投降/溃逃等) / 处决条件检测
- 批量士气检测 + 战意行为修正(攻击惩罚/闪避无效/可被处决)

---

## Phase 6d: 好感度系统 ✅

**Status: complete ✅ | 1869 tests | +42 tests**

**数据来源**: 世界书 #966681 [好感度]

### 6d.1 好感度引擎 (`affection-system.ts`) ✅
- 精简版: 仅钳制[-100,+100] + 读写 + 11级标签(对齐#966681)
- `$affection` API: get/set/add/batch/label/simpleLabel (6方法)
- 架构决策: Code 层只做数值存储+边界保护，行为判断全交给叙事 AI

---

## 🆕 Phase 6e: Marker Protocol + SubAgent 系统 ✅

**Status: complete ✅ | 1978 tests | +108 tests | +2 test files**

### 已完成模块
- ✅ `types.ts` 扩展: +~130 行 (MarkerType/DetectedMarker/CraftRequestMarker/CombatTriggerMarker/CharDetectMarker/CraftAgentOutput/CharGenOutput/ItemGenOutput/CharGenChainResult/CombatSummaryResult + `add_character` StatePatchOp)
- ✅ `marker-protocol.ts` (新建, ~220行): scanMarkers/scanCraftRequests/scanCombatTriggers/scanCharDetects/stripMarkers/classifyMarker/parseTagAttributes/isMarkerTag — 纯函数模块，正则检测
- ✅ `agent-templates.ts` 扩展: 3 新模板 craft_gen/char_gen/item_gen，REGISTERED_AGENT_IDS 10→13
- ✅ `char-gen-agent.ts` (新建, ~300行): detectNewCharacters/runCharGenChain/callCharGenAgent/callItemGenAgent/assembleCharacterState/buildCharGenPatches + $chargen API
- ✅ `agent-orchestrator.ts` 扩展: 3 新回调 (onCraftRequest/onCombatTrigger/onCharDetect) + processStageMarkers + pendingCombatMarkers 暂存 + validatePipeline 已知Agent 10→14
- ✅ `index.ts`: 导出新模块 + VERSION 3.0.0→4.0.0

### 架构决策 (实施修正)
- **Combat 延迟到 Stage 2 后**: Stage 1 暂存 combat_trigger → Stage 2 char_gen 先执行 → 再执行 combat（确保新敌人已生成）
- **Craft 阻塞注入**: Stage 1 post-processing 中扫描 craft_request → 调 Craft Agent → 用 position 精确替换标记块
- **Marker 检测用正则**: 非 StreamTagParser 扩展，标记检测在已完成文本上进行
- **SubAgent 链遵循 ADR-26**: char_gen → item_gen 仅1次调用

---

## Phase 6f: 世界书对齐审计修复 ✅

**目标**: 修正代码与世界观设定之间的冲突，确保数值/地理/品质/血脉与世界书一致
**预估**: ~10 tests（现有测试更新）| 累计 ~1362 tests

### 修复内容
- P0: tier-constants.ts 数值全量对齐世界书 #417617
- P0: validate.ts ATTR_RANGE.max 999→20
- P1: location-db.ts 用真实世界书地理重写（32节点/10势力）
- P1: 品质命名统一为 普通/优良/稀有/史诗/传说/神话/唯一
- P1: bloodlines.ts 10→23 种族（对齐世界书 #906373）
- P2: StatusEffect 添加 category/timeUnit 字段
- P2: 纪元名 光辉纪元→复兴纪元, 好感度范围 -50→-100

---

## Phase 7: 前端 UI ⬜
- 首页/捏人/游戏三栏/设置/地图/世界书编辑器
- Vanilla TS + HTML，~100 UI 测试
- **预估**: ~100 tests | 累计 ~2089 tests

---

## 🆕 Phase 8: Agent 上下文可见性 & Prompt 体系 ⬜

**目标**: 建立 Agent 间信息隔离机制，防止"全知叙事"，编写高质量 System Prompt
**预估**: 2 模块 | ~50 tests | 累计 ~2139 tests

> ⚠️ **本 Phase 放在前端之后** — 需要完整系统跑起来才能迭代调校 Prompt 效果。
> 主人主导 Prompt 内容编写，Code 层提供可见性过滤基础设施。

### 8.1 上下文可见性模型 (`context-visibility.ts`)

**核心问题**: 正文 AI 如果看到完整剧情大纲 → "全知 narrator" → 破坏悬念和玩家体验

```
┌─────────────────────────────────────────────────────┐
│  信息可见性矩阵 (Need-to-Know Principle)              │
│                                                      │
│  Story AI:                                           │
│    ✅ 角色状态 / 当前记忆 / 世界书匹配 / 位置信息       │
│    ❌ 完整剧情大纲 (仅给"当前章节目标")                 │
│    ❌ 其他 Agent 的思维链                              │
│                                                      │
│  Plot Check AI:                                      │
│    ✅ 完整剧情大纲 / 世界线状态 / 事件触发条件          │
│    ❌ 记忆细节 / 角色内心独白                          │
│                                                      │
│  Memory Recall AI:                                   │
│    ✅ 全部记忆 / 角色关系 / 历史对话                   │
│    ❌ 剧情大纲 (防止召回偏差)                          │
│                                                      │
│  Vars Update AI:                                     │
│    ✅ Story 输出 / 当前变量状态 / 角色列表             │
│    ❌ 剧情大纲 / 记忆详情 (只需知道"发生了什么")        │
└─────────────────────────────────────────────────────┘
```

- `AgentVisibilityConfig` — 每个 Agent 的可见字段声明
- `filterContextForAgent(agentId, fullContext)` → 裁剪后的上下文
- 可见性白名单: `{ allowFields: [...], blockFields: [...] }`
- Story AI 特殊处理: `plotOutline` → 压缩为 `currentChapterGoal` (100字摘要)

### 8.2 Prompt 模板体系 (`prompt-templates.ts` / 重写 `agent-templates.ts`)

**当前问题**: 现有 7 个 Agent 模板(Phase 3)是骨架版本，需要：
1. 注入"你只能看到 X，你不知道 Y"的边界声明
2. 防止 Story AI 的"预知"倾向（不能提前写后续剧情）
3. 防止 Plot AI 的"过度规划"（不能强制 Story AI 走向）
4. 各 Agent 的输出格式严格化

**产出结构**:
```
agent-templates.ts  (Code 层: 模板结构 + 占位符)
  ├── fixedSystem       ← 主人编写 (缓存敏感, 不变)
  ├── fixedExamples     ← 主人编写 (Few-shot)
  ├── variableContext   ← Code 注入 (过滤后的上下文)
  └── variableInstruction ← Code 注入 (本轮指令)
```

**主人负责**:
- 每个 Agent 的 `fixedSystem` 内容（角色定义/世界观/边界声明/输出格式）
- Few-shot 示例 (`fixedExamples`)
- Story AI 的叙事风格指导
- 反"全知"约束措辞

**Code 负责**:
- `variableContext` 的自动填充（根据可见性规则裁剪）
- `variableInstruction` 的本轮指令拼接
- 模板变量替换 (`{{charName}}`, `{{currentLocation}}` 等)

### 8.3 思维链隔离

- 每个 Agent 的 `reasoning/thinking` 块不传递给下游
- `agentOutputs` 只暴露结构化结果 (JSON)，不暴露原始思维过程
- Story AI 的创作思考 ≠ Plot AI 的规划思考，互不污染

### 8.4 Pipeline 信息流正式化

- 文档化 DAG 每个边的数据格式
- 上游→下游: 声明式字段映射 (不是整个 context 全传)
- ADR-27: Agent Context Need-to-Know Principle (新增)

---

## Phase 9: 集成 & 交付 ⬜
- E2E 流程测试 / 缓存命中率基准 / 角色卡可插拔验证 / 确定性回放 / 性能基准
- ~40 tests | 累计 ~2179 tests

---

## 垂直切片策略

每个 Phase 产出**可测试的能力**，避免长链非功能性交付:

| 里程碑 | 可测能力 |
|--------|---------|
| Phase 4.6 完成 ✅ | FP 读写、EJS 渲染、Effect 解析、变量持久化 |
| Phase 5 完成 ✅ | 命名空间映射、核心数值查询、血脉/死亡检测 |
| Geography 完成 | 10势力拓扑连通性查询 |
| Phase 6a.2 完成 | 任意两角色伤害计算 |
| Phase 6a.5 完成 | **首个完整游戏能力**: 提交动作→面板+Patch |
| Phase 7 完成 | **首个玩家可见产物** |

---

## 测试进度

| Phase | 新增 Tests | 累计 | 状态 |
|-------|-----------|------|------|
| Phase 1-3 | 161 | 161 | ✅ |
| Phase 4 | 201 | 369 | ✅ |
| Phase 4.5 | 238 | 607 | ✅ |
| Phase 5 | 365 | 972 | ✅ |
| Phase 4.6 | 204 | 1176 | ✅ |
| Phase 5 (EXPANDED) | 134 | 1310 | ✅ |
| Geography | 48 | 1358 | ✅ |
| Audit Fix | 4 | 1362 | ✅ |
| 6a (战斗) | 154 | 1516 | ✅ |
| 6b (制作) | 155 | 1671 | ✅ |
| 6c (集群/士气) | 112 | 1783 | ✅ |
| 6d (好感度) | 42 | 1869 | ✅ |
| 6d.5 (集成场景) | 44 | 1869 | ✅ |
| 6e (Marker+Agent) | 108 | 1978 | ✅ |
| 7 (前端 UI) | ~100 | ~2078 | ⬜ |
| 8 (上下文可见性) | ~50 | ~2139 | ⬜ |
| 9 (集成交付) | ~40 | ~2179 | ⬜ |

---

## 9 $ API 实现进度

```
✅ $dice      ✅ $validate   ✅ $resource
✅ $char      ✅ $var        ✅ $time
✅ $location  ✅ $fp         ✅ $affection
✅ $combat    ✅ $craft      ⬜ $status
```

## V3 代码复用

| 文件 | 状态 | 说明 |
|------|------|------|
| lorebook-engine.ts | 可复用 | 关键字扫描器完整，需添加模板解析钩子 |
| stream-parser.ts | 可复用 | 通用 XML 解析器，添加 `action_info` 标签即可 |
| vars-merger.ts | 可复用 | deepMerge 可用，parseVarsBlock 需扩展 |
| variables.ts | 可复用 | aggregateEvents 可用，需新标签处理器 |

---

## 验证策略

每个 Phase 完成后:
1. `npm run typecheck` — 零错误
2. `npm run build` — 编译成功
3. `npm run test -- --run` — 全部通过
4. `bash scripts/notify.sh "Phase X 完成!" "N tests | 编译 0 错误"`
