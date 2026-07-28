# 战斗系统 v2 实施计划

> 📅 **日期**：2026-07-28
> 📌 **目标**：按 [`combat-system-architecture.md`](../reference/combat-system-architecture.md) v2 落地新战斗架构
> 🔗 **参考**：v2 架构文档（中央参考）、世界书 #837805 / #265160 / [状态规则]
> ⚠️ **原则**：魔改不照抄、趣味优先 + 代码兜底、文字↔程序语言对接

---

## 0. 架构要点回顾（实施前提）

实施前必须吃透 v2 文档的几个核心机制：

| 机制 | 要点 | 实施关键 |
|------|------|---------|
| 管道 + 中间件 | 主函数触发 event → 脚本链式处理参数 → 主函数仲裁 | EventBus 要支持「返回值链」 |
| 同构契约 | 物品/buff/技能/天赋同一脚本契约 | 声明式注册替代 init/cleanup |
| 6 大效果类别 | 固伤/百分比/资源/检定/附加效果/特殊机制 | modifier 类型枚举 + 管线分发 |
| 登神 9 级 priority | 普通→微弱要素→...→神国，高阶压低阶 | divinity 字段 + 冲突仲裁 |
| buff 6 字段 + id 去重 | id = `[上级.]状态名`，同源刷新/异源独立 | 对齐 [状态规则] |
| 结算时机 | 增益 round.start / 减益 round.end | 两个 event 分工 |
| 19 个 event | 战斗生命周期/回合/单位/攻击/战术/战意/结算 | event 名单见 v2 §6.4 |
| 计算分工 | 代码管数值红线，AI 管创造性 | HP 扣减/生死必须代码 |

---

## 1. 实施批次总览

按依赖关系分 6 个批次（M1→M6），每个批次可独立验证：

```
M1 事件管道基础设施（EventBus 改造 + 声明式契约）
   ↓ 依赖
M2 效果与 Buff 系统（6 大类 + modifier 收集 + buff 去重）
   ↓ 依赖
M3 战斗管线重构（combat-resolver 管道化 + 19 event + 8 步注入）
   ↓ 依赖
M4 Agent 层改造（Combat Agent + item_gen + Story + dispatcher）
   ↓ 依赖
M5 前端战斗面板（CombatPanel + 对话流 + 正文暂停）
   ↓
M6 集成测试与交付（单元 + 集成 + Agent + 真机）
```

**预估工作量**：M1-M3 是引擎核心（最重），M4-M5 是接入层（中），M6 是验收（轻）。总周期建议 3-4 周。

---

## 2. M1：事件管道基础设施

**目标**：把现有 pub/sub 式 EventBus 改造成支持「管道链式返回值」的模式，并落地声明式脚本契约。

### 任务清单

| # | 任务 | 涉及文件 | 产出 | 验收 |
|---|------|---------|------|------|
| 1.1 | EventBus 支持「链式返回值」 | `game-event.ts` | 新增 `emitChain(event, initialParams)` 方法，按订阅顺序调用 handler，前一个返回值作后一个输入，最终返回 | 单元测试：3 个 handler 链式改参数，最终值正确 |
| 1.2 | 在场过滤机制 | `game-event.ts` / `subscription-manager.ts` | emit 时检查订阅者 owner 是否在上下文参战者列表，不在则跳过 | 单元测试：远在场外的脚本不触发 |
| 1.3 | 声明式脚本契约 | `script-executor.ts` / 新增 `script-registry.ts` | 支持注册 `{event, source, owner, handler, condition, priority}` 结构，替代裸 `$event.on` | 单元测试：物品装备时自动注册整份清单 |
| 1.4 | 套娃深度限制 | `subscription-manager.ts` | 战斗场景深度 ≤5（现有 ≤10 保留为非战斗默认） | 单元测试：6 层套娃第 6 层被拦截 |
| 1.5 | ctx 只读 API | `script-executor.ts` | `$resource.getHp(owner)` / `$char.getAttr(owner,'str')` 等只读函数暴露给脚本（最小集） | 单元测试：脚本能读不能写 HP |
| 1.6 | 旧 `$event.on/off` 兼容层 | `script-executor.ts` | 保留命令式 API 但内部映射到声明式注册，向后兼容 | 现有测试全绿 |

### 风险

- 🔴 `emitChain` 是核心改造，改不好会击穿整个脚本系统。建议先写完整 RFC 再动代码
- 🟡 现有 154 个战斗测试依赖旧的 pub/sub，需要全量回归

### 产出

- `game-event.ts` v2（链式 + 在场过滤）
- 新增 `script-registry.ts`（声明式注册）
- `subscription-manager.ts` 增强
- `script-executor.test.ts` 补充链式/在场/套娃测试

### ✅ 实施结果（2026-07-28）

M1 全 6 任务完成。方案 B：主线预备 `ReadonlyHookSet` → 两 code-writer agent 并行 1.1/1.5 → 主线串行 1.4/1.3/1.6。

| 任务 | 产出 | 测试 |
|------|------|------|
| 1.1 emitChain | `EventBus.emitChain/subscribeChain` 链式返回值，分离注册表 `chainHandlers`，稳定排序+错误隔离 | 19 |
| 1.2 在场过滤 | emitChain 入口 `ctx.combatants` 过滤 `owner`（1.1 顺手交付） | 含 1.1 |
| 1.3 声明式 registry | `script-registry.ts`（register/registerAll/unregisterOwner/clear，按 ownerKey 分组） | 11 |
| 1.4 套娃深度 | emitChain per-chain `ctx.maxDepth`（内层继承）+ SubscriptionManager `setMaxDepth` | 4 |
| 1.5 ctx 只读 API | ScriptContext `readHooks`（$resource/$char 只读，缺省 0 兼容旧测试） | 9 |
| 1.6 兼容层 | 分离注册表保证（声明式 emitChain ↔ 命令式 publish 互不串台） | 含 1.3 |

**类型新增**（types.ts）：`AttributeName`（str/dex/con/int/spi）、`ReadonlyHookSet`（10 只读方法）。

**D2 实施修正**：RFC 原推荐「统一注册表」，实施改「分离注册表」（选项 A）——现有测试断言 handler 收完整 GameEvent，链式 handler 收 params+ctx 签名差异大，分离零破坏。

**验收**：M1 四件套 130 tests passed；全量 3376/3377（唯一失败 SelectableCard 是预存 CSS 变量问题，与 M1 无关）。生产代码零调用 EventBus，M1 为「未通电基础设施」，端到端验证在 M3/M6。

---

## 3. M2：效果与 Buff 系统

**目标**：落地 6 大效果类别 + modifier 收集分发 + buff 6 字段契约 + 去重规则。

### 任务清单

| # | 任务 | 涉及文件 | 产出 | 验收 |
|---|------|---------|------|------|
| 3.1 | modifier 6 大类定义 | `types.ts` / 新增 `effect-types.ts` | `EffectCategory` 枚举（固伤/百分比/资源/检定/附加效果/特殊机制）+ 各类型接口 | 类型检查通过 |
| 3.2 | 登神 9 级 divinity | `types.ts` | `DivinityLevel` 枚举（普通/微弱要素/.../神国）+ 冲突仲裁函数 `resolveDivinityConflict(a, b)` | 单元测试：神位压常规、同级不压 |
| 3.3 | collect_mods 事件机制 | `combat-damage.ts` / 新增 `modifier-collector.ts` | `collectAttackerMods()` / `collectDefenderMods()`，按订阅收集 modifier 列表 | 单元测试：5 戒指各声明，收集到 5 个 |
| 3.4 | modifier 按类分发到管线 | `modifier-collector.ts` | 固伤→Step6a、百分比→Step6、检定→检定阶段、特殊→DR/穿透各归位 | 单元测试：各类 modifier 进对应 step |
| 3.5 | buff 6 字段结构 | `types.ts`（重构 StatusEffect） | 效果名称/类型/层数/剩余时间/来源/效果 六字段，对齐 [状态规则] | 类型检查通过 |
| 3.6 | buff id 去重 | 新增 `buff-registry.ts` | id = `[上级.]状态名`，实例 = `(owner, id)`；同源刷新+增层，异源独立 | 单元测试：同源叠加、异源共存、无上级裸名 |
| 3.7 | buff 4 种生命周期 | `buff-registry.ts` | 战斗型(X回合) / 持续型(永久) / 触发型(直至触发) / 条件型(直至条件消失) | 单元测试：4 种都能正确移除 |
| 3.8 | 结算时机 | `combat-turn.ts` / `morale-system.ts` | 增益在 `round.start` 结算、减益/DoT 在 `round.end` 结算 | 单元测试：流血在 round.end tick |
| 3.9 | layer 作为自由参数 | `buff-registry.ts` | handler 可读写 `params.layers`，架构不规定语义 | 单元测试：流血每层 +X |
| 3.10 | `$status` API | 新增 `status-api.ts` | `$status.apply(target, buffDef)` / `.remove` / `.query`，apply 自动走 id 去重 | 单元测试：apply 同源刷新 |

### 风险

- 🔴 StatusEffect 重构会影响现有所有用到状态效果的代码（craft/morale/affection 等），需要全量梳理引用
- 🟡 item_gen 生成的 buff 定义要和这里的契约一致，M4 要对齐

### 产出

- 新增 `effect-types.ts` / `modifier-collector.ts` / `buff-registry.ts` / `status-api.ts`
- `types.ts` StatusEffect 重构
- 完整单元测试覆盖

### ✅ 实施结果（2026-07-28）

M2 全 10 任务完成。方案 B：主线组 A（types.ts 加 3 字段 + DivinityLevel + effect-types.ts）→ 两 code-writer agent 并行组 B（buff 引擎）+ 组 C（modifier collect）。

| 任务 | 产出 | 测试 |
|------|------|------|
| 3.1 modifier 6 大类 | `effect-types.ts`（EffectCategory + 6 接口 + Modifier 联合） | 17 |
| 3.2 登神 divinity | `effect-types.ts` DivinityLevel + resolveDivinityConflict（差值压制表） | 含上 |
| 3.3 collect_mods | `modifier-collector.ts`（collectAttackerMods/collectDefenderMods，复用 emitChain） | 11 |
| 3.4 modifier 分发 | `effect-types.ts` classifyModifier + 聚合工具（sumFixedDamage/sumPercentages/collectChecks/...） | 含 3.1 |
| 3.5 buff 6 字段 | `types.ts` StatusEffect +3 可选字段（sourceKey/lifecycle/divinity） | 类型 |
| 3.6 buff id 去重 | `buff-registry.ts`（buffIdOf/applyBuff：同源刷新+增层/异源独立） | 35 |
| 3.7 buff 4 生命周期 | `buff-registry.ts` lifecycleOf + tick（战斗型递减/持续型不动） | 含上 |
| 3.8 结算时机 | `buff-registry.ts` tick（round.start 增益/round.end 减益） | 含上 |
| 3.9 layer 自由参数 | `$status.apply` 透传 stacks 给 handler | 含 3.10 |
| 3.10 $status API | `status-api.ts`（applyStatusIntents/removeStatusIntents）+ 沙盒 $status 扩展 | 13+22 |

**关键降风险**：StatusEffect **未重构现有字段**（D5 选 A，只加 3 可选字段）；craft/morale/affection **实际不在引用面**（grep 实测，计划风险栏过虑）。

**验收**：M2 五件套 ~140 tests passed；全量 3465/3466（唯一失败 SelectableCard 预存 CSS 变量问题，与 M2 无关）。runDamagePipeline **未接入**（M3 任务 4.4）。

---

## 4. M3：战斗管线重构

**目标**：把 combat-resolver 改造成管道模式，落地 19 个 event 触发点，8 步管线接入 modifier。

### 任务清单

| # | 任务 | 涉及文件 | 产出 | 验收 |
|---|------|---------|------|------|
| 4.1 | combat-resolver 管道化 | `combat-resolver.ts` | `resolveAttack` 重构为管道，每个关键步骤触发对应 event | 现有 154 测试迁移通过 |
| 4.2 | 19 event 触发点接入 | `combat-resolver.ts` / `combat-turn.ts` | 按v2 §6.4 清单，在每个步骤 emit 对应 event | 集成测试：攻击走完整 event 链 |
| 4.3 | 随机数事件化 | `dice.ts` / 新增 `dice-event.ts` | `rollDice()` 触发 `combat.dice.roll` 事件，脚本可改骰值 | 单元测试：幸运戒指+2、诅咒取低 |
| 4.4 | 8 步管线 modifier 注入 | `combat-damage.ts` | 在 Step 1/3/6/6a/7 等位置插入 modifier 收集点，按类分发 | 单元测试：固伤进 6a、百分比进 6 |
| 4.5 | 登神 priority 仲裁 | `combat-damage.ts` | 攻防 divinity 比较，高阶压制低阶（等效穿透/无视 DR） | 单元测试：神位伤无视常规防 |
| 4.6 | HP 扣减 + 生死判定红线 | `combat-resolver.ts` | HP 扣减必须代码执行（AI 不可直接动），HP≤0 强制死亡 | 单元测试：AI 输出再离谱也 clamp |
| 4.7 | `$combat` API 扩展 | `combat-resolver.ts` | 补全 `useSkill` / `useItem` / `block` / `move` / `focus`（v2 §13 h 项） | 单元测试：每个 API 可调 |
| 4.8 | 战意判定接线 | `morale-system.ts` | HP<阈值触发 `combat.morale.check` → AI 返回 → `morale.result` 应用 | 集成测试：B HP<30% 触发 |
| 4.9 | 战斗结算管线 | `combat-resolver.ts` | `combat.end` → EXP 计算 → `settle.loot` → `settle.complete` | 集成测试：胜利正确给 EXP |
| 4.10 | 集群系统适配 | `cluster-system.ts` | "同类"判定归 AI（char_gen 只生成 1 个代表），属性/资源 ×N | 单元测试：集群资源正确 |

### 风险

- 🔴 combat-resolver 重构是最大改动，建议保留旧版作 `combat-resolver.legacy.ts` 直到新版稳定
- 🟡 19 event 的触发顺序要严格按 v2 §6.3，错一个就整个流程乱
- 🟡 现有 `combat-integration-scenario.test.ts` 要重写为新流程

### 产出

- `combat-resolver.ts` v2（管道化）
- `combat-damage.ts` v2（modifier 注入）
- 新增 `dice-event.ts`
- 154 测试迁移 + 新增覆盖

---

## 5. M4：Agent 层改造

**目标**：新增 Combat Agent、增强 item_gen、调整 Story 和 request_dispatcher。

### 任务清单

| # | 任务 | 涉及文件 | 产出 | 验收 |
|---|------|---------|------|------|
| 5.1 | Combat Agent 定义 | `agent-config.json` / `types.ts` | 新增第 14 个 Agent「combat」，主持人定位 systemPrompt（四步流程 + 函数调用规则 + 摘要规则） | Agent 配置加载正常 |
| 5.2 | Combat Agent 接入 orchestrator | `agent-orchestrator.ts` | combat_trigger 唤起 Combat Agent，独立战斗循环（不走主 DAG） | 集成测试：trigger 正确唤起 |
| 5.3 | Combat Agent 工具白名单 | `agent-tools.ts` / `AGENT_TOOL_MAP` | `$combat.*` / `$status.*` / `$dice.*` / `$resource.*`(只读) 对 combat 开放 | 工具调用成功 |
| 5.4 | item_gen systemPrompt 增强 | `agent-config.json` | 生成装备/技能时：效果必须归 6 大类、按转化表翻译、带 divinity、buff id 带物品前缀、脚本契约格式 | 测试：生成的物品合规 |
| 5.5 | item_gen 输出 schema 校验 | `char-gen-agent.ts` / `craft-gen-chain.ts` | 解析 item_gen 输出时校验 6 大类 + divinity + 脚本契约，不合规打回 | 测试：违规输出被拒 |
| 5.6 | Story 调整（摘要接收） | `agent-config.json`（story） | 战斗摘要作为用户消息注入，Story 知道接续战斗后剧情 | 集成测试：摘要正确接续 |
| 5.7 | request_dispatcher 调整 | `agent-config.json` / `agent-orchestrator.ts` | combat_trigger 路由到 Combat Agent（现有 onCombatTrigger 复用） | 集成测试：路由正确 |
| 5.8 | combat_summary Agent 复用 | `agent-orchestrator.ts` | 现有 combat_summary Agent 并入 Combat Agent 第 4 步（或保留独立） | 集成测试：摘要生成正常 |

### 风险

- 🔴 Combat Agent 是全新 Agent，systemPrompt 设计是重点（参考 [`agent_system_prompt_guide.md`](../reference/agent_system_prompt_guide.md)）
- 🟡 item_gen 改动影响所有物品生成，需要回归现有物品生成测试
- 🟡 战斗中的多轮 Agent 调用（每回合一次）要注意 token 消耗和 cache

### 产出

- `agent-config.json` 新增 combat + 改 item_gen / story / request_dispatcher
- `agent-orchestrator.ts` 接入 Combat Agent
- `agent-tools.ts` 工具白名单更新
- Agent 提示词审查文档

---

## 6. M5：前端战斗面板

**目标**：落地独立战斗 UI，支持 Agent 对话流、角色选择、正文暂停。

### 任务清单

| # | 任务 | 涉及文件 | 产出 | 验收 |
|---|------|---------|------|------|
| 6.1 | CombatPanel 主组件 | 新增 `src/ui/components/game/CombatPanel.vue` | 独立战斗界面，从上/下方滑入，覆盖正文 | 手动：面板正确滑入 |
| 6.2 | 敌我角色展示区 | `CombatPanel.vue` 子组件 | 暴露敌方/我方角色 + 三属性（HP/MP/SP 或选定三属性） | 手动：数值正确显示 |
| 6.3 | 战斗对话流 | 新增 `CombatChatFlow.vue` | 类似 ChatFlow 但战斗专用，显示 Combat Agent 叙事 + 数值面板 | 手动：叙事正确渲染 |
| 6.4 | 输入区 + 角色选择 | `CombatPanel.vue` 子组件 | 对话框 + 上方选我方角色 → 暴露技能/装备 + 普通攻击入口 | 手动：选角色后技能暴露 |
| 6.5 | 战斗状态 store | 新增 `src/ui/stores/combat-store.ts` | 战斗状态管理（CombatState / 参与者 / 回合 / 日志） | 单元测试：状态正确流转 |
| 6.6 | 正文暂停机制 | `game-store.ts` / `GamePage.vue` | 战斗期间正文流暂停，战斗面板接管 | 手动：战斗时正文不动 |
| 6.7 | pipeline 桥接 | `src/ui/lib/game-pipeline.ts` | combat_trigger → 唤起 Combat Agent → 回调驱动面板更新 | 集成测试：端到端 |
| 6.8 | 数值面板渲染 | `CombatPanel.vue` | 替代 `<action_info>` XML，前端组件化渲染（评级/伤害分解/状态） | 手动：数据对齐 |
| 6.9 | 战斗结束 + 摘要注入 | `CombatPanel.vue` / `game-pipeline.ts` | 战斗结束 → 面板滑出 → 摘要作为用户消息进 ChatFlow | 集成测试：摘要接续 |
| 6.10 | 样式与设计规范对齐 | CombatPanel 全套 | 遵循 [`docs/design.md`](../design.md)（间距/品质色/动画） | 设计审查 |

### 风险

- 🔴 战斗面板是大组件，需要拆分子组件 + 状态管理，避免一团乱麻
- 🟡 正文暂停机制要和现有 ChatFlow 协调好，不能破坏主对话流
- 🟡 战斗中的实时更新（HP 条变化）要考虑性能

### 产出

- `src/ui/components/game/CombatPanel.vue` + 子组件
- `src/ui/stores/combat-store.ts`
- `game-pipeline.ts` 战斗桥接
- 设计审查通过

---

## 7. M6：集成测试与交付

**目标**：全链路验证 + 真机 debug loop。

### 任务清单

| # | 任务 | 涉及文件 | 产出 | 验收 |
|---|------|---------|------|------|
| 7.1 | 端到端场景测试 | 新增 `combat-e2e-scenario.test.ts` | 按 v2 文档的「幽怨之剑砍 B」例子完整跑一遍 | 全 event 触发、数值正确 |
| 7.2 | buff 套娃测试 | 同上 | 流血触发大出血、深度限制生效 | 套娃正确、超深拦截 |
| 7.3 | 登神压制测试 | 同上 | 神位伤 vs 常规防，DR 被压制 | 数值符合预期 |
| 7.4 | miss/救场测试 | 同上 | miss 不挂 buff、赫卡忒式救场在 damage 事件触发 | 行为正确 |
| 7.5 | item_gen 合规测试 | `item-gen.test.ts` 增强 | 各品质物品生成都符合 6 大类 + divinity + 转化表 | 违规输出被拒 |
| 7.6 | Combat Agent 流程测试 | `combat-agent.test.ts` | 四步流程（初始化/回合/判赢/结算）完整 | 流程正确 |
| 7.7 | 前端组件测试 | CombatPanel 单元测试 | 角色选择/技能暴露/数值渲染/暂停恢复 | 组件行为正确 |
| 7.8 | 真机 debug loop | 按 [`debug-loop-handbook.md`](../reference/debug-loop-handbook.md) | 主人实机游玩 → 导出 → 分析 → 修复 | 5 轮内无重大 bug |
| 7.9 | 文档同步 | `CLAUDE.md` / v2 架构文档 | 更新进度、补真机记录、CLAUDE.md 文档导航加 v2 | 文档检查通过 |
| 7.10 | 旧版清理 | 删 `combat-resolver.legacy.ts` | M3 保留的旧版确认稳定后删除 | 无引用残留 |

### 产出

- 完整测试套件（单元 + 集成 + e2e）
- 真机验证记录
- 文档更新

---

## 8. 依赖关系图

```
M1 ── EventBus 管道 + 声明式契约
 │
 ├─→ M2 ── 6 大类 + modifier + buff 系统
 │    │
 │    └─→ M3 ── 战斗管线 + 19 event + 8 步注入
 │         │
 │         ├─→ M4 ── Combat Agent + item_gen + Story
 │         │    │
 │         │    └─→ M5 ── 前端战斗面板
 │         │         │
 │         │         └─→ M6 ── 集成测试 + 真机
 │         │
 │         └─→ M6（部分前端测试可提前）
 │
 └─→ M6（M1/M2 的单元测试在各自批次内）
```

**可并行项**：
- M4 的 item_gen 增强（5.4-5.5）可在 M3 进行中并行（依赖 M2 的 6 大类即可）
- M5 的组件静态部分（6.1-6.4）可在 M4 进行中并行（不依赖 Agent）
- M6 的测试用例编写可与各 M 并行

---

## 9. 待确认清单（从 v2 §十三 同步）

以下点不阻塞计划启动，但在对应 M 实施前需要主人拍板：

| 点 | 阻塞哪个 M | 本喵倾向 |
|----|-----------|---------|
| 嵌套上级取根源 vs 直接 | M2（buff id） | 根源 |
| 链执行顺序规则 | M1（emitChain） | 类型优先级 + order |
| 登神 priority 与穿透映射 | M3（4.5） | 神位+无视常规防，中间级别按比例 |
| divinity 挂整件装备还是单 modifier | M2（3.2）/ M4（5.4）| 整件装备 |
| ctx 暴露字段 | M1（1.5） | 最小集起步 |
| 战术动作具体函数 | M3（4.7） | 按 #837805 §4 |
| buff 默认 duration/layers | M2（3.7） | 按 [状态规则] |
| clamp vs 重算 | M3（4.6） | clamp |

---

## 10. 全局风险与注意事项

### 🔴 高风险

1. **EventBus 链式改造**（M1）：核心基础设施，改错全盘崩。建议先出 RFC
2. **combat-resolver 重构**（M3）：154 个测试受影响，建议保留 legacy 并行
3. **StatusEffect 重构**（M2）：影响 craft/morale/affection 等多处引用
4. **Combat Agent systemPrompt**（M4）：新 Agent 的提示词设计是大工程

### 🟡 中风险

5. **item_gen 改动回归**（M4）：影响所有物品生成，需回归测试
6. **前端战斗面板复杂度**（M5）：大组件，需拆分 + 状态管理
7. **多轮 Agent 调用性能**（M4）：战斗中每回合一次 Agent，token 消耗大
8. **真机稳定性**（M6）：管道链 + 套娃在真机可能触发边界 bug

### ⚠️ 注意事项

- 每个 M 完成后必须跑全量测试（`npm test`），不能只跑本批次的
- 提交前检查 [`CLAUDE.md`](../../CLAUDE.md) 的「提交前文档检查」清单
- 真机 debug 按照手 [`debug-loop-handbook.md`](../reference/debug-loop-handbook.md) 流程
- Agent 提示词改动遵循 [`agent_system_prompt_guide.md`](../reference/agent_system_prompt_guide.md)
- 世界观/数值改动必须回 [`world_book_index.md`](../../reference/world_book_index.md) 核对
- 数据字段改动对齐 [`data-field-conventions-design.md`](../superpowers/specs/2026-07-16-data-field-conventions-design.md)

---

## 11. 变更记录

| 日期 | 变更 | 作者 |
|------|------|------|
| 2026-07-28 | 初版：基于 v2 架构文档，分 M1-M6 六批次 | Claude（计划）|
