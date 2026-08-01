# 变更记录 (CHANGELOG)

> **本文件承载「进行中 + 近期交付」Phase 的详细记录。**
> Append-only，新条目加在顶部。已完成且稳定的旧 Phase（1-9、10a-h）细节见 `docs/phases/` + git log，不在此处重复。
>
> 指令文件（`AGENTS.md`）只保留 ≤30 行的 Phase 速览表，不写历史——历史在这里。

---

## 进行中 / 近期交付（按交付时间倒序）

### 战斗 v3 M5 — 收尾：默认翻 v3 + 退役 v2 + 文档同步 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§十四 引擎边界 / §十五 模块迁移映射表）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §8。把 v3 从「可选引擎」翻转为「默认引擎」，退役 v2 战斗运行时。**战斗 v3 全里程碑（M0→M5）收尾**。

**PR1（翻默认 + 文档，不删代码，观察一版本周期）:**

- `types.ts` `combatEngineVersion` 默认 `'v2'` → `'v3'`（A5-1）；`game-pipeline.ts` 分支点兜底 `?? 'v3'`（旧存档无字段也走 v3）
- 文档同步（A5-4）：v2 架构文档加退役横幅（保留作为纯计算规则引用）/ `combat-agent-api.md` 标 v2 专用 + 指向 v3 接口 / handoff 文档收尾 + §2 待补完表标 ✅ 指向架构节号 / AGENTS.md 架构图加 `combat-v3/` 子目录 + ADR-20/29 补战斗内走 DSL

**PR2（真正退役 v2，主人拍板选 A）:**

- 🗑 删 6 文件（含测试 12 个）：`combat-runner` / `combat-pipeline` / `combat-actions-pipeline` / `combat-modifier-inject` / `combat-resolver` / `combat-settlement-pipeline`（职责已由 v3 接管）
- 🆕 `combat-v2-types.ts`：迁移存活契约（CombatClient/CombatEvent/PipelineContext/COMBAT_EVENTS/characterToCombatParticipant），v3/agent-tools/game-store/morale-pipeline 改指
- v2 分支优雅退役：`game-pipeline.ts` 打回 'v2' → 优雅提示（不炸、无悬空 import，A5-2）；`agent-tools.ts` 删 `AGENT_TOOL_MAP['combat']` + executeCombatToolCall + 19 v2 工具（保留 `combat_v3`）；`agent-config.json` 删 combat 条目（python 精确切片，保留 combat_v3）
- ✅ 保留（v3 内核在调）：`combat-panel` / `combat-damage` / `combat-intention` / `combat-turn` / `combat-morale-pipeline` / `combat-item-validator`

**验收:** A5-1 ~ A5-4 全过（默认 v3 / v2 优雅退役可打回 / typecheck+test 全绿 / 文档 4 处同步）。全量 **5101 测试 / 174 文件全绿**（5245 - 144 v2 测试块）；typecheck 0；prettier 干净；零残留引用。

**遗留:** `game-pipeline.ts` 的 flag 分支结构保留一个版本周期（下个周期再删 'v2' 分支与 flag 本身）。

### 战斗 v3 M4 — 压力测试：7 场 fixture 全绿 + RuleKey 补全 + divinity 泛化 + eventHash 冻结 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§八 closed RuleKey 与 divinity 压制 / §九 反射专项 R1-R8 / §十三 DomainEvent）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §7。这是**最重的一个里程碑**——机制层（4 RuleKey + divinity 泛化）+ 窗口接线层（修 M3 真实缺口）+ replay harness 升级 + 7 场 fixture 端到端 + eventHash 冻结。

**机制层（A4-3/A4-4）:**

- `rule-keys.ts` — 四把 RuleKey 全注册（terminal.forceTerminal / morale.forceState / action.freezeSlot / death.threshold，各带 schema + divinity 门槛 + merge policy）+ `resolveOverride` 真正解析 + **`divinitySuppression(atk, def)`** 泛化：差 1~4 级 → ±20%/40%/60%/80%，≥5 级 → `{ certain: true }`（必成/必败，**不消费骰子**）
- `phases/attack.ts` — check.intent 意图对抗接压制（差≥5 跳过 intentCheck 骰，A4-4）+ unit.beforeDown 接 death.threshold（PreventDeath → DamagePrevented + 同批原子提交，A4-3）
- `intents.ts` — ApplyStatus.contest 接压制（守方 div 高≥5 状态抵抗）+ OverrideIntent → freezeSlotPatches
- `unit-turn.ts` — action.freezeSlot 生效（被冻结槽位不发）+ turn.open 窗口触发源
- `state.ts` — applyPending 合并 frozenSlots（max_rounds）+ applyOutcome 落 frozenSlots

**窗口接线层（修 M3 真实缺口）:**

- `attack.ts` `finalizeAttack` ⑨ damage.after **不再丢弃 evaluateWindow 结果** → `applyAfterWindow` 接 applyIntents（**M3 遗留：反射 intent 从未落地**，case-24/x1 跑不通的根因）
- **`reflectChain` 链式反伤递归**：depth 传播 + 每轮查新受击方被动 + R6 depth≥2 → `mutual_cancel` + `NarrativeCue('反射湮灭')`（case-x1 互反熔断，A4-2）
- R8 反伤命中骰 attackHit 通道 + 优势/劣势 + BeginOutput 续杯
- `windows.ts` resolveNumber 补全：parseExpression → evaluate → fallback（错误隔离不抛出），`ctx.damage.preReduction * N` 表达式可求值

**replay harness 升级（A4-1 地基）:**

- `replay.ts` — **M0 空转 → 驱动真实内核**（openCombat + dispatch 循环），RequiredInput 自动处理（BeginOutput 续杯 / PlayerCommand / CharGenRequest / EffectChoice / BoundedAdjudication）
- hash 基于 **DomainEvent 序列**（A4-5）；`fixtureBundle` 统一英文 attrs
- `reducer.ts` `adjudicate` — `terminal.forceTerminal` 落 `state.terminal`（case-09 认知剥夺终局生效）

**7 场 fixture + contract test（A4-1/A4-2）:**

| fixture                               | 断言重点                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------- |
| case-06-summon（全量）                | 召唤端到端：UnitSummoned + this_round_tail 当回合参战 + FP 300→200          |
| case-07-prevent-death（全量）         | PreventDeath 保命（death.threshold）                                        |
| case-09-concept（全量）               | damage + roundCount + forceTerminal 落 state（Adjudicate → RuleOverridden） |
| case-13-time-freeze                   | freezeSlot 端到端：理查德 TurnOpened 0 攻 0 动                              |
| case-24-reflection（全量）            | 反射 depth=1 落地 + 攻方 HP 扣减                                            |
| **case-x1-mutual-reflection**（新增） | 双方 30% 反伤 → depth 2 熔断 → 反射湮灭 + 无 depth≥2 事件                   |
| **case-x2-true-death-revive**（新增） | HP→0 → death.threshold（divinity 6）→ 保命 + DamagePrevented                |

**eventHash 冻结（A4-5）:** 7 场 fixture 的 `expected.eventHash` 从 null 升级为具体 hash（h1vj9zgo 等），contract test 断言 `result.hash === fixture.expected.eventHash`——此后任何改动导致 hash 变化必须在 PR 说明。

**顺手修的:** `applyPending` 同名 buff tick 语义（remainingTime 不同=覆盖/相同=叠层）；DamageReflected.depth 用本轮深度（修 OBO 偏移）。

**验收:** A4-1 ~ A4-6 全过（5 场全量 + 2 极端 + 4 RuleKey + divinity 泛化 + eventHash 冻结 + 第 07 场续杯）。全量 **5245 测试 / 180 文件全绿**（combat-v3 291 / 35 files）；typecheck 0；prettier 干净；no-nondeterminism 守卫通过。

### 战斗 v3 M3.5 — 开放性出口：CharGenRequest + BoundedAdjudication + prompt 改写 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§十 char_gen 战斗中调用 / §十一 BoundedAdjudication 有界裁决）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §6。把 v3 内核从「封闭战斗」打开——召唤走 char_gen（CharGenRequest），创意效果走有界裁决（BoundedAdjudication），并改写 `combat_v3` / `item_gen` / `char_gen` 三个 prompt。

**新建 3 文件:**

- `combat-v3/adjudication.ts` — `evaluateAdjudication(p, state)` 纯函数六步验证（照架构 §11.2）：divinity 硬门槛 <5 reject（**A35-4**）/ 目标合法 / RuleKey 已注册 / 不变量 / 边界 / 冲突检测；通过产 `AdjudicationAccepted` + `RuleOverridden`（或 `MiracleTriggered`）+ journal 带 reason（A35-5）
- `combat-v3/summon-pool.ts` — §6.4 预生成召唤物池最小实现（key 归一化 + `lookupSummon`），内容留空走实时 char_gen（「M3.5 不做也能验收」）
- `combat-v3/phases/spawn.test.ts` — A35-1/2/3 + actionEconomy 三态 + FP 原子扣费

**关键改动:**

- `coordinator.ts` — 替换 M2 两处 `throw UnsupportedInM2`：**CharGenRequest** 路由（③a 先查池 → ③b `await runCharGenForCombat` → ④ 解析校验 `SummonedUnitDefinition`（divinity≤cap clamp / 属性总和≤budget 等比缩放 / joinTiming 缺省 next_round_head / automaton 走 compileEffectProgram 失败剔除不阻断）→ ⑤ 提交 `SupplyUnit`）；**BoundedAdjudication** 路由（调 evaluateAdjudication，reject → EffectRejected(ADJUDICATION_REJECTED) 流回；通过 → 提交 `Adjudicate`）。**EffectChoice 保留 throw**（plan §6.7 只要求替换另两路）
- `reducer.ts` — `SupplyUnit` frame 恢复分支（plan §6.2 ⑥）：从冻结 frame 续跑 → 插 state.units → joinTiming='this_round_tail' `draw(initiative,1)` 插先攻序列尾部 / 'next_round_head' 下轮参与 → actionEconomy 三态槽位 → duration → `ApplyStatus('召唤时限', rounds)` → automaton 增量进 ActiveEffectIndex → **与 SpendResource(FP,100) 同一次原子提交**（不变量④）→ `UnitSummoned` + `ResourceSpent`；`Adjudicate` 内核重锤验证（持完整 CombatState 验 target.divinity）产事件 + journal
- `phases/action.ts` — `SpawnOrDespawnIntent` 且 `templateRef` 缺省 ⇒ freeze spawn frame 返回 `RequiredInput.CharGenRequest`（A35-1，内核不存 Promise）；命中 ⇒ 直接产 UnitSummoned
- `phases/round.ts` — 召唤时限到期 `round.close` 移除 → `UnitDespawned` + updateIndex 摘 automaton（A35-3）
- `char-gen-agent.ts` — 新增 `runCharGenForCombat`（战斗中、单个、**不落库**，复用现有链跳过 buildPatches/DB）；与 `runCharGenChain` 并列，不改现有入口
- `types.ts` — 定型 `Adjudicate`/`SupplyUnit` payload、`RequiredInput.CharGenRequest`/`BoundedAdjudication` 完整形状、新增 `SummonedUnitDefinition`/`ProposedAdjudication`/`AdjudicationResult`
- `state.ts` / `phases/outcome.ts` — `removeUnitIds`/`activeEffects` 收进 `applyOutcome`；修 `applyPending` 同名 buff tick 语义（remainingTime 不同=覆盖，相同=叠层）

**prompt 改写（`data/defaults/agent-config.json`，raw slicing 禁 prettier）:** `combat_v3` 删除掷骰指令（骰值由内核提供）+ 删除判输赢调 combat_end（终局内核判）+ 改为逐步决策模式（每次一个 Command）+ 新增「无法用标准动作表达 ⇒ submit_adjudication，且仅当 divinity ≥ 法则级」+ 保留叙事摘要（write_summary ≤500 字）；`item_gen` 输出改 `<automaton>` JSON 块 + 格式约束段（subscribe 窗口清单 / trigger 封闭文法 / intents 8 大类 / divinity ≤ 物品声明）；`char_gen` 新增 `combatParticipation` 输出段。**采 additive**：新增段为可选，保留 `<script>` 主链（避免破坏 assembleCharacterState 与既有测试）。

**`reference/agent流程测试/agent预期分析.md`:** 新增 §5.5 combat_v3 完整输出追踪（思维链 → 工具调用序列 → JSON）+ 下游解析链路。

**验收:** A35-1 ~ A35-5 全过（templateRef 缺省触发 / joinTiming 时序 / 时限到期移除 / divinity<5 reject / 通过产事件+journal）。全量 **5191 测试 / 169 文件全绿**（新增 25）；typecheck 0 错误；prettier 干净。

**已知遗留（M4 对齐）:** 第 06 场 fixture 端到端（A35-6）未做——fixture 是 concept 版（`_synthetic`，用老 DeclareAction+summon payload 结构），与 SpawnOrDespawnIntent 内核流不对接，M4 重做；`<automaton>` JSON 实装消费（compile → windows 求值）归 M4；`runCharGenForCombat` 召唤物防御/DR 用保守默认 0，后续精化。

### 战斗 v3 M3 — 效果系统：DSL + 编译链 + windows 实装 + damage.preview ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§五 ReactionWindow / §六 EffectIntent / §七 EffectAutomaton DSL + 编译链 / §九 反射专项）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §5。把「效果」从 v2 的任意 JS 脚本（`new Function` 执行）翻转为**声明式 automaton + 封闭微文法表达式**，`windows.ts` 从空转变实装。**战斗内全链路零 `new Function` / `eval`**（铁律 2，C1 战斗内消解）。

**新建 `combat-v3/automata/` 子目录 + 2 文件:**

- `automata/parser.ts` — 递归下降 parser：token 集封闭、词法期拒绝白名单外 token（`=`/`[`/`{`/反引号/`;`/`new`/`function`/`this`/未知标识符）、`ctx.` 点分路径合并、`parseCmp` 非结合（`a<b<c` 报错）、**`ExprSyntaxError` 带 1-based 列号**（A3-1）
- `automata/interpreter.ts` — 零 eval AST 解释器：字面量/路径/白名单函数（min/max/floor/ceil/abs/percent/has）/一元/二元；除零返回 0；未定义 ctx 路径抛 `ExprEvalError`（错误隔离）
- `automata/compile.ts` — `compileEffectProgram` 三来源编译链（① `modifiers[]` → push-handler automaton（ADR-29）/ ② `ParsedEffect` → 内建 adapter / ③ AI automaton JSON）+ **9 条编译期校验**（窗口存在/trigger 文法/kind∈8 大类/RuleKey 白名单/divinity≤所有者/数值 clamp/ctx 路径根段/五维直改/前缀，A3-3）
- `automata/builtins.ts` — 15 条内建映射（固伤/伤害%/受到伤害-%（修 M-6）/命中/闪避/先攻/DR/穿透/反伤/吸血/护盾/DoT/HoT/暴击率/次数）
- `automata/index-active.ts` — `buildIndex`/`updateIndex`：按窗口分组并按 §5.3 排序、离场移除
- `automata/reflection.ts` — 反射专项（§九）：R4 preReduction 基准 / R6 depth=2 熔断产 `NarrativeCue('反射湮灭')` / R7 基准不放大 / R8 attackHit 通道
- `intents.ts` — `validateBatch`（batch 内一个非法 ⇒ 整批 reject + `EffectRejected`，**不取消**核心攻击与同窗口其他 automaton，A3-7）+ `applyIntents` 解释执行
- `windows.ts`（实装）— 求值顺序（窗口→divinity→priority→stable id）/ 在场过滤 / charges 耗尽跳过 / trigger 错误隔离 / batch 原子性 / **预算 64 截断 + BUDGET_EXCEEDED**

**damage.preview 全流程（§5.4）:** `phases/attack.ts` 步骤⑥ 接 `RequestChoice`：`hasSubscribers` 判空 → 有订阅者则冻结 `ResolutionFrame` → 返回 `RequiredInput.EffectChoice`；`reducer.ts` 加 `DeclareBlock` frame 恢复分支 → 格挡 intent batch → **回到 `damage.compute` 重算**（不在 final 上打折）→ 487→97 比例。无订阅者**不暂停**（A3-6）。

**修改文件:** `combat-item-validator.ts` 新增 v3 共享常量（`V3_WINDOW_KEYS`/`V3_INTENT_KINDS`/`V3_RULE_KEYS`），**v2 运行时入口保留不删**；`phases/outcome.ts`/`round.ts`/`action.ts` 适配 Windows ctx；`state.ts` 加 `freezeFrame`/`restoreFrame`。

**验收:** A3-1 ~ A3-8 全过（parser 列号 / evaluate 零 eval / 编译期剔除 / modifier push-handler / 487→97 重算 / 无订阅不暂停 / batch 原子性 / 第 24 场反伤 depth=2 熔断）。全量 **5166 测试 / 166 文件全绿**；typecheck 0 错误；lint 0 error。

**M3 修复的 Critical/Major:** C1（战斗内消解：全链路零 `new Function`）/ M-6（守方百分比进 `collect_defender_mods`）/ M-2（ActiveEffectIndex 通电）/ M-12（窗口递归 ≤5 + 反射 depth ≤2 + 预算 64）/ M-15（automaton 返回 undefined 视为空 batch）。

**已知遗留（M3.5 对齐）:** Coordinator 的 `EffectChoice` 路由仍 `throw UnsupportedInM2`（M3 只做内核，M3.5 接 game-store→UI 格挡询问）；`makeWindowRuntimeCtx.resolveNumber` 对非数字表达式返回 fallback（M3 范围限于 damage.preview 全量求值，其余窗口表达式求值 M3.5/M4 补全）；`reflection`/`charges` 内建特判。

### 战斗 v3 M2 — 接线：Coordinator + feature flag + 双投影 + 前端桥 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§十三 双投影 / §十四 引擎边界 + Coordinator + feature flag + 四态 UI / §十二 FP 协议）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §4。把 M1 的内核骨架接到真实业务路径：Coordinator 驱动完整战斗循环、feature flag 整场切换、投影 A（UI）/B（Agent 文本面板）、前端 Command 桥。v2 路径一行未删（flag 默认 `'v2'`）。

**新建文件（`combat-v3/`）:**

- `index.ts` — **唯一公共出口**：`openCombat(NewCombat | RestoreCombat): CombatSession` + 公共类型 + `runCombatV3`（coordinator 公共 seam）。internal 一律不导出（架构 §十四 14.1）
- `coordinator.ts` — `runCombatV3(opts)` 协调循环：openCombat → 首注骰 → dispatch 循环（无 requiredInput 则自动推进）→ 终局 RequestSettlement → **一次 `commitChatState`**（A2-1）。`routeRequiredInput` 四路由穷尽 switch（`default: never` 兜底，A2-3）：PlayerCommand（玩家→store / 敌方→Agent）/ BeginOutput（注骰）/ EffectChoice·BoundedAdjudication·CharGenRequest（M2 `throw UnsupportedInM2`）。`abandon()`：session 丢弃、FP 不落库、解除 isGenerating（**C4**）。敌方 Agent 工具预算 `MAX_TOOL_ROUNDS=8`，超限自动 pass
- `projection-ui.ts` — 投影 A：`projectToUi(events)` 对 **29 个 DomainEvent 穷尽 switch**（A2-6，漏一个编译不过）。v3 新增映射为 `v3_*` CombatEvent 变体（扩展 `combat-runner.ts` 的 CombatEvent 联合），v2 分支保留
- `projection-agent.ts` — 投影 B：`projectToAgent(view)` 从唯一 CombatView 生成 `<action_info>` 文本面板（M2 基于 CombatView 而非内部 CombatState——kernel 闭包藏 state，已标注为 M3 若需完整状态再调整）
- `fixtures/case-09-concept.fixture.json` + `case-09.test.ts` — 第 09 场端到端（真理火球 / 处决人 / FP 2400），断言 `roundCount` / `damage` / `terminal.reason: 'force_terminal'` / `fpDelta`

**修改文件:**

- `game-pipeline.ts` — `handleCombatTrigger` 加 **feature flag 分支点**（唯一，架构 §十四 14.5）：`combatEngineVersion === 'v3'` 走 `runCombatV3`，`'v2'` 走现有 `runCombat`（:1196-1225 保留）。v3 分支组装 bundle（`characterToCombatParticipant` 复用 combat-resolver）+ 前端 Command 桥（pending resolver）+ coordinator 句柄暴露给 store
- `game-store.ts` — 新增 `v3ActiveCombat` / `combatCoordinator` 句柄 / `submitCombatCommand`（自动补 `commandId`+`expectedRevision`）/ `abandonCombat` / `applyCombatEvent` v3 变体分支；v2 分支保留
- `agent-tools.ts` — 新增 `AGENT_TOOL_MAP['combat_v3']`（6 工具 + 4 只读，§4.4）；**不动** `['combat']`（v2 回滚要用）
- `agent-config.json` — 新增 `combat_v3` agent 条目（最小可用：逐 Command 决策、不掷骰、不判终局）
- `combat-runner.ts` — `CombatEvent` 联合扩展 v3 变体（`v3_*`），v2 变体原样保留

**验收:** A2-1 ~ A2-6 全过（v3 端到端一次 commitChatState / v2 行为完全一致 / RequiredInput 四路由穷尽 / abandon 不落库 / 摘要回注 / 29 DomainEvent 全映射）。全量 **5050 测试 / 157 文件全绿**；typecheck 0 错误；vue-tsc 0 错误；lint 0 error。

**M2 修复的 Critical/Major:** C4（abandon 流程）。M1 已修的 C3/C5/C6/C7/M-1/M-3/M-4/M-9 由 A2-1 端到端验证。

**已知遗留（M3 对齐）:** 前端 Vue 组件（CombatActionBar/CombatPanel 等）留最小改动、当前仍走 v2 渲染路径（标注 M2.5 前端完善）；`projectToAgent` 基于 CombatView 而非完整 CombatState（kernel 闭包藏 state）；`toPatches` 只算 FP 结算 patch（EXP/战利品 M4 settlement.before 补）；EffectChoice / BoundedAdjudication / CharGenRequest 三路由 `throw UnsupportedInM2`。

### 战斗 v3 M1 — 内核骨架：状态机 + 行动槽 + 原子提交 + 唯一终局 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§二 核心控制模型 / §三 CombatState 与原子提交 / §十三 DomainEvent）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §3。M0 的地基（分通道骰带 + replay harness）之上，把 v2 的「Agent 主持流程」翻转为「代码内核主持流程」的**内核骨架**——所有变更走 `CombatSession.dispatch(command)` 单一入口，v2 代码仍不删（flag 默认 `'v2'`）。

**新建内核文件（全部在 `combat-v3/`）:**

- `types.ts`（扩）— 追加 `CombatPhase`（10 相位）/ `CombatUnitState` / `CombatState` / `CombatView`（只读投影）/ `ResolutionFrame` / `JournalEntry` / `RequiredInput` / `CombatTransition` / `CombatSession` / `CommandRejection` / `TerminalReason` / `DomainEvent`（M1 子集）/ `ReactionWindow`（18 窗口）/ `ActiveEffectIndex` / `PendingChangeSet` / `CombatDefinitionBundle`。M0 类型保留不动
- `state.ts` — `createCombatState`（bundle→units + FP 快照 + provenance）/ `toView`（脱敏只读投影）/ `applyPending`（**唯一状态写入**，revision 单调递增、HP clamp `[0,maxHp]`）/ `applyOutcome`（把 `PhaseOutcome` 一次性落 state，rejection 时零变更）
- `kernel.ts` — `createSession`：持有 state + `Map<commandId, CombatTransition>` 幂等缓存 + dispatch（调 reduce，经 `transition.next` 采纳完整权威状态）+ 熔断 200 微步骤抛 `KernelStuckError`
- `reducer.ts` — `reduce` 唯一入口：stale revision / Terminal 只收 `RequestSettlement` / 目标在执行者早期校验（A1-2 拒绝须零事件）/ `AUTO_PHASES` 推进表（数据驱动非 if-else）/ `commandUsed` 标志（一次 dispatch 一个 PlayerCommand）/ SupplyDice 续杯 / 一次 Command 一次 revision
- `phases/round.ts` — 增益 tick（round.open）/ 减益+DoT（round.close）+ buff `remainingTime` 真实递减到期移除（**M-1**）
- `phases/initiative.ts` — initiative 通道掷骰 → v2 `rollInitiative` → 总值降序、平手字典序；**不调 `rollAndSortInitiative`**（避开其 `Math.random` 兜底）
- `phases/unit-turn.ts` — 开槽（`canAct && hp>0` 才发槽，**M-3**）/ `consumeSlot`（cost 验证+消费）/ 士气 d20 从 `statusContest` 通道取（**M-4**）/ 线性推进到下一单位或 RoundClose
- `phases/attack.ts` — 微步骤链 §3.4：① check.intent 取 `intentCheck` **两颗**独立骰 → resolveIntention（**C5**）→ ②③④ collect_mods/check.hit 窗口 → ⑤ damage.compute 管线 + clamp≥0（**C7**）→ ⑥ damage.preview 窗口（M1 空转）→ ⑦ checkNonLethal（**C6**，HP 锁 1 + 昏迷）→ ⑧⑨ beforeDown/damage.after 窗口 → ⑩ 攻守双方资源同批提交（**M-9**）
- `phases/action.ts` — DeclareAction（道具/移动/专注/防御）+ Flee（statusContest 检定）
- `phases/terminal.ts` — 终局四出口 `checkTerminal`（HP 全灭/士气溃逃/逃跑成功/forceTerminal）+ `settle` 按 `settlementId` **幂等**（**C3**，同 id 二次调用返回既有结果不产第二套奖励）
- `rule-keys.ts` — 只注册 `terminal.forceTerminal` RuleKey（divinity≥5），其余三个 M4 补
- `windows.ts` — **空转版** evaluator：遍历 `ActiveEffectIndex`（此时恒空）返回空 intent 数组；round/attack/unit-turn 各窗口**调用点全就位**，M3 接入时只填索引不用改调用点

**验收:** A1-1 ~ A1-10 全过（行动槽强制/非法命令零事件零骰/同 commandId 幂等/原子提交/round tick/终局四出口/settle 幂等/双意图骰/非致死锁1/负 modifier 不治疗）+ §3.9 熔断。全量 **4792 测试 / 149 文件全绿**；typecheck 零错误；lint 零 error（3 个 `prefer-const` 已 `--fix`）。combat-v3 新增 92 测试（kernel 24 + reducer 22 + phases 28 + terminal 9 + state 9）。

**M1 修复的 Critical/Major:** C3（settle 幂等）/ C5（意图双骰）/ C6（非致死锁 1）/ C7（伤害 clamp≥0）/ M-1（buff tick）/ M-3（行动槽强制）/ M-4（士气骰真源）/ M-9（攻守资源同批）。

**已知遗留（M2 对齐）:** `phases/action.ts` 的 DeclareAction 尚未实现「道具消耗/移动范围/专注」等子类型的具体效果（M1 只消费动作槽 + 产事件）；`fixtures/case-06` 的 command kind `UseSkill`（非架构 §二 2.2 枚举）留待 M2 改 `DeclareAction`；EXP/战利品结算在 `settle` 只算 FP 净值，M2 settlement.before 窗口补全。

### 战斗 v3 M0 — 地基：分通道骰带 + replay harness + 纯函数签名改造 ｜ ✅ 完成（2026-08-01）

架构真源: `docs/reference/combat-system-architecture-v3.md`（§四 DiceTape / §1.4 五处代码修正）；实施计划: `docs/planning/2026-07-31-combat-v3-implementation-plan.md` §2。把 v2 的「Agent 主持流程」翻转为「代码内核主持流程」的地基——所有新代码落 `src/sillytavern/combat-v3/`（deep module，唯一公共出口 `index.ts` 留待 M1），v2 代码 M5 前一行不删，靠 feature flag 整场切换。

**新建 `combat-v3/` deep module:**

- `types.ts` — DiceChannel / DiceEpoch / DiceTapeState / CombatProvenance + CombatFixture 全类型 + `DEFAULT_CHANNEL_SPLIT`（attackHit 32 / initiative 10 / intentCheck 7 / statusContest 6 / procCheck 5，D6 实测加权，RFC §5.7「各 12 颗均分」被推翻）+ CHANNEL_ORDER
- `dice-tape.ts` — `createTape` / `draw` / `beginEpoch` / `splitSixty` 纯函数（不可变更新）。draw 只推进目标通道 cursor，耗尽不推进任何 cursor；beginEpoch 旧 epoch 进 exhausted、cursor 归零；**不做通道间借用**（架构 §一 1.6 否决项，保 replay 干净）
- `replay.ts` — `replayCombat(fixture, reducer?)` 纯函数：validateFixture 结构校验 + buildTape 验证骰带可建 + hashFixture 规范化 djb2（忽略 `_synthetic`/`_provenance` 元数据）+ reducer 注入缝（M1 起驱动 commands）
- `fixtures/case-06-summon.fixture.json` / `case-24-reflection.fixture.json` — 两场简版 fixture，含 `_provenance` 骰值对照表（样本行号→fixture 骰值）+ `_synthetic` 标记

**v2 纯函数签名改造（差分测试地基，v2 行为零变化）:**

- `performAttackCheck`: `d20Roll: number` → `rolls: [number, number?]`，删除两处 `Math.random()` 模拟第二骰（修复架构 §1.4 M-5）
- `runMoraleCheckPipeline`: `d20Roll` 改必传（修复 M-4 战意骰恒 10）
- `combat-pipeline.ts` / `combat-resolver.ts` 调用点补传 `rolls:[d20,d20]` / `d20Roll:10`（v2 行为等价）；额外修复 `combat-resolver.ts:134` 守方意图骰的 `Math.random()` 统一为同值双喂
- `AppSettings.combatEngineVersion: 'v2'|'v3'` 默认 `'v2'`（feature flag，分支点唯一 `game-pipeline.handleCombatTrigger`，M5 才翻 v3）

**反非确定性守卫:** `no-nondeterminism.test.ts` 用 `import.meta.glob` + `?raw` 扫描 `combat-v3/` 全部 `.ts`（排除 test），断言零 `Math.random` / `new Function` / `eval`（铁律 1/2，全链路根除审查报告 C1）。

**验收:** A0-1 ~ A0-8 全过。全量 4757 测试 / 144 文件全绿；typecheck 零错误。combat-v3 新增 57 测试（dice-tape 35 + no-nondeterminism 4 + replay 22，含两场 fixture milestone 断言）；v2 战斗测试 177 个零行为变化。

**已知遗留（M1 对齐）:** fixture command kind 用了 `UseSkill`（非架构 §二 2.2 枚举），M0 replay 不校验 command kind，M1 内核 dispatch 时改 fixture 为 `DeclareAction`。

### 工坊 P2 — EJS 沙盒 + 只读 stats 投影（ADR-30）｜ ✅ 待真机（2026-07-31）

设计: `docs/planning/2026-07-31-workshop-phase2-ejs-design.md`（v1.2 拷问定稿，五轮）；实施计划: `docs/planning/2026-07-31-workshop-phase2-implementation-plan.md`（波次 T1-T6）。世界书条目正文的 EJS 从「原样进上下文」变成「**提示装配期求值**」。

**两轴契约**（自主设计，不承诺 MVU/酒馆助手兼容，上游函数名仅作别名层）: `stats` 是**只读**面，纯代码推导数值（主角资源/等级/五维/命运点数/`世界.时间` = `formatGameTime` 规范串）；`vars` 是**与 AI 共写**的叙事变量空间（= `variables.sys` 草稿），EJS 与 AI 双写同一棵树，**冲突 AI 赢**。

**模块**:

- `ejs-runtime.ts` **重写**为整片编译 —— 一个条目的全部 token 编进**同一个函数体**，跨块 `if`/`for` 由此成立（旧的逐块 `new Function` 做不到，这是重写的存在理由）。tokenizer 一并重写，顺带修掉 `<%= x _%>` 的切词缺陷；含 `print()` 与 `"use strict"`；API 为 `compileEjsEntry` / `executeEjsEntry`，执行失败**回滚草稿**不留半截写入
- 新增 `ejs-lodash-shim.ts`（`_` 纯读边 17 方法 + `chain`，无任何写方法）· `stat-projection.ts`（`buildStatData` 出只读快照）· `ejs-vars-diff.ts`（草稿深 diff → `{replace,remove}` 交给 var-resolver 的 `applyVarsPatch`；`EJS_DIFF_SIZE_LIMIT = 256KB`）
- `worldbook-loader.ts` 新增 `hasDynamic`（三根针 `<%` / `{{random` / `{{getvar`）+ `renderWorldBookEntries`

**缓存分层与回退**: 静态区在前、**动态条目沉底**，使静态前缀字节稳定、前缀缓存不被动态内容击穿；编译结果按条目缓存。求值失败**按条目隔离**并注入原文（零回归兜底）。全语料冒烟 509 条目 / 61 动态 / **8 条已知回退白名单**（uid 343·353·357·358·417·421·477·505 —— 6 条依赖本引擎没有的酒馆助手 API、1 条 `await`、1 条 `{{roll}}` 宏嵌在 EJS 代码块内）。⚠️ 最后一条推翻了设计 D1 的宏剥离顺序假设，已裁定接受。

**接线与提交仲裁**: `LORE_BOOK` resolver 走 `renderWorldBookEntries` 并新增 `section=static|dynamic` 参数，`buildFallbackMessages` 同步；`AgentContext` 加 `statData`/`ejsVarsDrafts`/`ejsPass`，`AgentConfig` 加 `ejsVarsCommit`（**默认仅 story 为 true**，per-Agent 声明是前瞻扩展设计）。orchestrator 新增 `onEjsVarsFlush` 事件，在**每个 stage 跑完、`processStageMarkers` 之前**触发 → game-pipeline 算差量/护栏/落库 → `commitChatState(patches, { ejsVarsDiffs })`：**EJS 差量先落、AI 补丁后落**，同路径 AI 赢。差量顺序 = 管线阶段序 + 同阶段 `agentId` 字典序（钉死可复现）。超限**整份拒绝不截断** + toast 一次（每存档每来源）+ game-store `ejsVarsRejections` 持久诊断（DebugPanel 展示并进导出）。

**测试**: 145 files / 4928 tests 全绿；`npm run typecheck` 与 `vue-tsc` 均 0 错误。

🔴 **真机走查尚未做** —— 回退率、`cacheHitTokens` 前后对比、story 首包延迟、冰之歌跨回合链四项均未验证，状态口径按「✅ 待真机」而非「已交付」。

### 工坊 P1 — 创意工坊（= Phase 7f） ｜ ✅ 真机走查已过（2026-07-31）

设计: `docs/planning/2026-07-31-creative-workshop-compat-design.md`（v2，D1-D17）；实施计划: `docs/planning/2026-07-31-workshop-phase0-1-implementation-plan.md`。上游是【命定之诗】创意工坊（角色卡内嵌酒馆助手脚本 + Cloudflare Worker 后端），本引擎**不嵌 iframe、不跑上游 JS**，只直连其公开 REST。

**新分区 `creative_workshop`**（`WorldBookPartition` 第 16 个成员）。**所有工坊条目一律归此分区**，无论上游标成系统/角色/事件/DLC —— 分区在本引擎是**信任域边界**，不是内容学分类；上游 `tags` 仅作展示与筛选，不参与判定。除分区外工坊条目与其它条目完全一视同仁（同表、同启用机制、同样可编辑、同样进备份），无门禁无特判。

**模块**（照素材系统「纯函数出计划 / 执行器只落库」分层）:

- 引擎纯函数层 `src/sillytavern/`: `workshop-types.ts` / `workshop-manifest.ts`（上游 JSON → 内部形状，容忍字段增删）/ `workshop-regex-map.ts`（ST 正则 → BeautifierRule）/ `workshop-install-plan.ts`（★ `planInstall` 纯同步出计划：发号/转换/匹配/冲突/丢弃全在无副作用函数里算完并可完整断言）
- UI 层 `src/ui/`: `lib/workshop-client.ts`（唯一网络接触点，判别联合永不抛穿 + 超时 + 取消）/ `lib/workshop-enable.ts`（启用展开纯函数）/ `stores/workshop-store.ts`（执行器，只落库）/ `components/workshop/` 6 组件 + `format.ts`·`failure-text.ts` / `shared/WorkshopEnableList.vue` / `game/WorkshopEnablePanel.vue`（每存档「内容启用」，建档后仍可改）；入口在首页「创意工坊」按钮 + 游戏页侧栏「工坊」 + 捏人页（原「角色启用」步骤改名「内容启用」）

**关键决策**:

- **一项目一本书** —— `worldBooks` 行 `id = workshop:${projectId}`，`partition = 'creative_workshop'`。这是**多本书共用一个分区的第一例**（内置书是 `id === partition` 一一对应）
- **uid 必须在分区内重新分配** ★否则数据损坏 —— `filterBooksByEnabledEntries()` 以 partition 为键建 uid 允许表，而上游每个项目 uid 都从 0 起编，跨项目撞号是必然。安装时由分区级分配器全局单调发号；上游 uid 降级为 `extra.workshop.sourceUid` 仅溯源
- **卸载不回收号段** —— 回收会让旧存档的 `enabledWorldBookEntries` 指向新项目的条目（静默内容错位）。游标地板取「在装项目 + 现有书 + **所有存档引用过的号**」三者最大
- **启用完全走既有机制** —— 写 `SaveSlot.metadata.enabledWorldBookEntries` 的 `creative_workshop:<uid>`，与 `system_core:413` 一视同仁；不新增 SaveSlot 字段、不改 `filterBooksByEnabledEntries`、不做分区特判。真正的闸门是 Agent 可见性（新装书不自动进任何 Agent 的 `worldBookIds`，这是既有规范非工坊特例）
- **UI 粒度是项目，不做命定核心冲突拦截** —— `tags` 是上游自由文本，无可靠机器信号，猜必误伤；显著展示 tags 与简介由用户判断
- **正则原样安装、默认启用、不剥离 `<script>`/`<style>`** —— 落进现有输出美化规则库，`group: '创意工坊 · <项目名>'` + `autoEnable.worldBookIds: ['workshop:<id>']`（装了才启用，卸载即失效）。⚠️ **已知并明确接受**: `<style>` 会全局泄漏样式进主题 token 体系；`<script>` 在 `v-html` 中不执行只占字节；内联 `onclick` 会触发
- **更新按名匹配、覆盖式** —— 存活条目 uid 不变（存档引用无需重写），删除的 uid 退休，新增的领新号；逐条比对 `sourceHash`，**改动过的先弹警告**（`WorkshopConflictModal`）再覆盖
- **丢弃必须 loud** —— `promptOnly`/`placement`/`minDepth`/`maxDepth`/`substituteRegex`/`runOnEdit`/`trimStrings` 及 `{{getvar::}}` 宏一律记 `droppedNotes`，项目卡片如实展示「N 项未导入」，静默截断会让用户以为装全了

**真机走查已过**: 真实上游 279 项目 14 页，完整跑通 浏览 → 筛选 → 详情 → 安装 → 启用 → 卸载。

🔴 **Phase 2（EJS 沙盒 + 只读 stats 投影）未做** —— 工坊装进来的世界书条目里的 **EJS 目前不会被求值**，正文原样进 Agent 上下文。这不是本次新增的缺陷（内置书今天就这样：`event.json` 297 个 EJS 块、`system_core.json` 252 个），但**工坊内容因此并未真正完整生效**。

**不做（Phase 3+）**: Discord 登录、点赞、订阅、投稿。

**测试**: 135 files / 4611 tests 全绿；`npm run typecheck` 与 `vue-tsc` 均 0 错误。

#### 工坊 P1 实施后修订（2026-07-31）｜ ✅ 真机已复验

真机走查后打的两处补丁。设计文档已同步：D16 追加「实施期修订」小节、D12 追加同屏并列条目。

**① `droppedNotes` 分三类 —— 原口径在撒谎**

装「艾莉亚核心先行版 v3.2.1」时 UI 顶部写「**34 项内容未导入**」，但那 34 条 note 里只有约 14 条是真丢弃；其余 20 条描述的是**已装且已启用、只是渲染受限或有副作用**的正则（Dexie 里 5 条正则全部 `enabled`，世界书也装得好好的）。用户读到只会以为安装失败。

| kind         | 含义                                  | 覆盖                                                                                                                         |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `dropped`    | ST 字段本引擎无对应物，**确实没导入** | `placement` · `maxDepth` · `minDepth` · `runOnEdit` · `promptOnly`（整条跳过）· `substituteRegex` · `trimStrings` · 退休条目 |
| `degraded`   | **已装**，但渲染不完整                | ` ```html ` 围栏无渲染器 · 完整 HTML 文档被解析器截断 · `<script>` 惰性 · `{{宏}}` 无替换环节 · 上游重名本地改名             |
| `sideEffect` | **已装**，且有规则自身之外的副作用    | `<style>` 全局生效、可能覆盖应用主题 token                                                                                   |

- `types.ts` 新增 `WorkshopNoteKind` / `WorkshopNote` / `WorkshopNoteLike`
- `workshop-types.ts` 新增纯函数 `workshopNote` / `normalizeWorkshopNote(s)` / `groupWorkshopNotes` —— ★**向后兼容**：已装项目在 Dexie 里存的是旧 `string[]`，裸字符串与脏 `kind` 一律退回 `dropped`，**绝不抛**
- `workshop-regex-map.ts` / `workshop-install-plan.ts` 打 kind；文案口径统一在 `components/workshop/format.ts`
- `WorkshopInstalledList.vue` 折叠行三段分计数（`sideEffect` 带 ⚠ 且最显眼）；`WorkshopPage.vue` toast 同口径
- **已知后果一条未变** —— 改的只是停止把「已装但受限」误报成「未导入」。「丢弃必须 loud」不变，但 loud 的对象要分得清：把不同性质的事混成一个数字本身就是另一种静默截断
- **真机复验**：同一批 note 现显示「14 项未导入 · 15 项已装但效果受限 · ⚠ 5 项有全局副作用」，合计仍是 34

**② 捏人页工坊选择挪到「命定核心」步骤**

原先工坊多选在后面的「内容启用」步骤，与命定核心单选隔了一屏。现把工坊区从 `CreateStepCharacters.vue` 挪到 `CreateStepDestinyCore.vue`，拆成并列两轴（`一 · 命定核心` 单选·必选 / `二 · 工坊项目` 多选·可选），步骤名「内容启用」改回「**角色启用**」（即上文 P1 条目中「原『角色启用』步骤改名『内容启用』」一句已被撤回）。

**纯 UI 位置调整** —— `create-store` 三条轴逻辑与 `buildEnabledWorldBookEntries()` 输出**逐字未变**（有测试钉住）。D12「不做命定核心冲突拦截、只显著展示 tags 由用户判断」不变；同屏之后反而更好落实：用户能同时看到两边的 tags 与简介。

🔴 **Phase 2 仍未做** —— 工坊条目正文里的 EJS 依然不求值，本次修订与之无关。

**测试**: 138 files / 4645 tests 全绿；`npm run typecheck` 与 `vue-tsc` 均 0 错误。

### 工坊 P0b — 美化规则迁出 localStorage ｜ ✅

**起因同 P0**: 内置美化规则 22 条 = 386,645 字符（≈378 KB）每次启动都从磁盘重算，却仍被完整写进 localStorage；工坊正则落地后还要再加 ≈494 KB。这一阶段是**实施期间新增的前置**，设计定稿（v2）时未预见。

- Dexie **v15** 新增 `beautifierRules` 表；新增 `beautifier-store.ts`（Dexie 唯一入口）+ `beautifier-migration.ts`（复用 P0 的六步迁移）
- **`AppSettings.beautifierPresetRules` 字段整个删除** —— 派生缓存不该有持久化字段位，改为纯内存 ref（启动时从磁盘算）
- `beautifierBuiltinDisabled` 体积小且是真用户意图，**留在 settings 不迁**
- `FullBackup` 新增 `beautifierRules`（只含用户规则，内置预设不进备份）
- `beautifier.ts` 的 `processRules` / `mergeRules` **一行未动** —— 换的是存储层，不是规则语义

### 工坊 P0 — 世界书迁出 localStorage ｜ ✅

设计: 同上文档 D1-D5。**起因是三个后果，其中第三个是真缺陷**:

| 问题             | 实测                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 配额压力         | 内置世界书紧凑序列化 889,962 字符（≈0.85 MB；localStorage 按 UTF-16 计约 1.7 MB），配额通常 5 MB，且溢出**静默 catch**             |
| 写放大           | deep watch 在**任何**设置变更时重新 `JSON.stringify` 整个 ≈2 MB 设置对象                                                           |
| **备份不覆盖** ★ | `exportAllData()` 只做 `db.*.toArray()`，**从不读 localStorage** —— 世界书根本不进备份，而设置页却标注「IndexedDB + localStorage」 |

- Dexie **v14** 新增 `worldBooks` / `workshopProjects` 两表。**死表 `lorebooks`/`settings` 原样保留不删** —— 删表要写 `表名: null`，会永久抹掉老用户可能仍存的 v1–v3 行；放着不花钱，导出也只是空数组
- 新增 `worldbook-store.ts`（Dexie 唯一入口）+ `worldbook-migration.ts`：**标志位判定**（`worldBooksMigratedAt`，不以「表里有没有行」判定——半失败会留下行看着像完成）→ 单事务 `bulkPut` → **回读逐本校验**（书数 + 条目数）→ 通过才删 localStorage 副本 → 任何一步失败**一律不动**、下次启动重试。不留 localStorage 回滚副本（留着就没释放配额，而释放配额正是迁移目的）
- 启动顺序：内置书合并必须在迁移**之后**、针对 Dexie 执行，否则源数组在迁移脚下漂移
- 消费端全部切换: `game-pipeline` / `SettingsPage` / `create-store` / `App.vue`；`filterBooksByEnabledEntries` 及下游不动，只是拿到的数组变长
- `FullBackup` 加 `worldBooks` + `workshopProjects` 两字段并递增版本，import 采**三态语义**: 字段缺席 → 整表不动（旧备份）· `[]` → 清空 · 有数据 → 覆盖

🔴 **独立审查发现并修复两个会丢数据的缺陷**:

1. **重复 id 的书在迁移中被静默合并** —— `bulkGet(['x','x'])` 对同一行返回两次，数量校验被骗过，`bulkPut` 只写进一行。已加 `dedupeIds`
2. **导入 pre-v14 旧备份会清空整张 worldBooks 表** —— `Array.isArray` 守卫写在 `clear()` 之后，旧备份没这个字段时表已经被清空了。已改为守卫先行（📌 加表进 FullBackup 时别照抄 clear-then-guard）

### 战斗 v2 — 战斗系统架构 v2 重构 ｜ ✅ M5 完成，待 M6 真机

战斗系统架构 v2 重构（管道+中间件+同构契约+6 大类效果对齐 #265160+buff 规则对齐 [状态规则]+19 event+Combat Agent+独立战斗面板+计算分工）。魔改不照抄世界书，趣味优先+代码兜底。架构: `docs/reference/combat-system-architecture.md`；计划: `docs/planning/2026-07-28-combat-system-v2-plan.md`。M1-M6 六批次，§十三 待确认清单已全收口。

- **M1 ✅**（emitChain + script-registry，130 tests）
- **M2 ✅**（modifier 6 大类 + buff 去重，~140 tests）
- **M3 ✅**（管道版 + 19event + 登神 + HP 红线，~80 tests）
- **M4 ✅**（combat systemPrompt + 13 工具注册 + executeCombatToolCall 独立通道（B 方案）+ combat-runner 跨回合循环 + item_gen 6 大类契约 + 校验纯函数 54 测 + combat-agent-api.md 接口规格文档；agent-tools 58 测）
- **M5 ✅**（runner 路径 X 回合调度: 按行动轴逐单位 + 敌方自主/我方暂停等玩家 + 激活死字段 currentTurnIndex + 7 类 CombatEvent 事件流 + pendingResolver 暂停恢复 + hp 同步修正 + combat-store（combatLog/awaiting/submit）+ pipeline 桥接（enter/exit/applyCombatEvent）+ CombatPanel 覆盖层 + 4 子组件（CombatUnitCard/CombatActionCard/CombatMessageFlow/CombatActionBar）B+C 按钮注入文本框 + CombatHeader + useBeautify composable 抽取；combat-runner 7 测；M5 plan+RFC 文档）｜ 待真机验证

### 素材 — 素材管理系统 v1.0 ｜ ✅ 已实现 + 渲染面接通 + 大画像/裁剪台/画像弹窗

设计: `docs/planning/2026-07-29-asset-management-system-design.md`（D1-D22 决策表 + §12 风险与已知缺陷 + §13 反转理由 + §14 审查记录 + §15 实现纪要/两轮审查/渲染面落地 §15.9/大画像与裁剪台 §15.10（🔴 其真机记录只对 `e818b61` 版有效）/画像弹窗与审查轮 §15.11）。**行为参考 RP Terminal 素材系统，但刻意不移植代码**（架构差异过大）。

**v1 范围**: 三类型 `头像/立绘/立绘bg` 全部可导入 + 一键 zip 导入（素材与音频同一个导入器，按扩展名分流；`.webm` 仍归音频）+ zip 导出（**仅 blob 源音频，内置 57 首与本地文件夹源刻意排除**）。

**关键决策**:

- **命名约定** `<name>[_<type>][_<variant>].<ext>`，type 可省默认头像（文件名即 zip 格式）
- **严格 `===` 匹配不归一化**（对齐 state-manager.findByName，刻意不用 audio 的 normalizeAudioName）
- **命名不变式**: name 与 variant 的任何分段都不得等于类型 token（否则 format→parse 不是双射，`(苏婉,头像,立绘)` 会回读成 `(苏婉_头像,立绘)`）
- **与存档/characters 表零耦合**（无角色名册、无覆盖率计、无未匹配列表）
- **单存储层 IndexedDB Blob** + 走 audio 的 loadBlob 注入缝
- **mp4 只准用在不需要 alpha 的类型**（头像圆形裁切/立绘bg 整屏 ✅；立绘是抠图要合成 ❌）
- **永不覆盖，冲突编号进 variant 槽**（编进 name 会脱钩角色）
- 导入哈希去重（素材按 `(name,type)`，音频按归一化名）
- plan/execute 拆分（纯 `asset-import-plan.ts` 出计划，store 只执行）

**已实现 (2026-07-29)**: 5 纯引擎模块（asset-types/filename/index/resolve/import-plan）+ Dexie v13 两表 + `src/ui/lib/` 三件（asset-zip/media-hash/asset-url）+ asset-store.ts + AssetSection.vue 及 4 子组件 + 存档数据文案。332 tests / 12 files 全绿。

**合并后审查轮 (§15.6)**: 对 `97e5900` 对抗式审查，查出 7 条缺陷全部收口，修的过程中又自查出 5 条。要点: ①`allocateSlot` 文件名往返有损 ②新增 D19（名字经 zip 条目名往返的门）③`buildAssetIndex` 原型污染改 `Object.create(null)` ④补单文件导入 ⑤音频批内去重 hash 键 ⑥toast 文案修正。

**渲染面落地 (2026-07-29，§15.9)**: D4「只管理不渲染」**正式反转** —— 新增 `useAssetImage.ts`（唯一渲染缝）与 `AssetMedia.vue`；五个渲染位接通（StatusOverview 玩家 1:1 方框 / CreateStepConfirm / CharacterListPanel ×2 / ScenePanel 46×58 立牌位），全部保留原首字母兜底。🔴 修掉两个 v1 看不见的缺陷: ①`resolveAsset` 死代码（显式类型不降级）→ 改两条相反链 ②`asset-url.ts` 无引用计数 → NPC 同时出现两面板会死图，已改引用计数。

**大画像 + 取景 + 裁剪台 (2026-07-29，§15.10 / D21·D22)**: ①右栏大画像 `CharacterPortrait.vue`（判据是链上命中的那一档，不是"有没有图"）②裁剪台 `AssetCropEditor.vue`：一张源图烘出 `立绘 + 头像` 两份真字节，每类型三态 裁剪/整图/不生成（D22 两字段必填）③framing 逐行持久化 + 进 zip manifest（D21，显示元数据，非对象丢弃不夹逼，只落新建行）。

**画像位收干净 + 身份条 (2026-07-30，§15.11)**: ①`ad612d5` 画像上不再有任何家具，旋钮与相机徽章全收进 `PortraitSettingsDialog.vue`，`CharacterPortrait.vue` 退化成纯呈现组件 ②`a2411f3` 身份条盖到大立绘顶端（scrim 恒黑、字恒浅、刻意不用主题变量）③`1875d1c` 裁剪台两栏靠拢 + dev.bat IPv6 修复 ④`96b87ce`+`a12926b` 🔴 首页 🧪 快速测试按钮一直在调 `clearAllData()` 清空整个 IndexedDB（连全局素材库/音频库一起没），已修。

🔴 **真机验证记录只对 `e818b61` 那一版有效，现行 UI（`ad612d5` 之后）未经真机走查**。仍未验: 带 framing 的 zip 真文件往返 / mp4 两条路 / 素材库裁剪再编辑 / 不生成档端到端 / 键盘调裁剪框 / 四个 NPC 渲染位真机出图。4259 passed / 1 failed（同一条 SelectableCard 基线，与素材无关）。

⚠️ **两个顺带发现、刻意只记不修的真缺陷** (§12): ①`asset-store.compareRows` 把变体当字符串排（`_10` 排在 `_2` 前），`AssetCharacterDrawer` 打了 `{numeric:true}` 本地补丁——本地补丁盖共享比较器是走散的标准剧本 ②`SettingsPage.vue` 独占全仓 32 条 vue-tsc 错误里的 18 条（`PresetItem.settings`/`.template` 类型上不存在），结构上对 `npm run typecheck` 隐形（裸 tsc 不解析 .vue）。

### 真机迭代 — debug loop ｜ 🔄 持续验证中

debug loop 5 轮修复: 物品/角色零落库根因链（AI 输出 JSON 形状漂移 → 解析器 XML+JSON 双兜底）/ 侧链 systemPrompt + 世界书注入根治（此前恒 stub 裸奔）/ maxTokens 2048 兜底截断 / 创角初始装备改走 item_gen 链（不直接落库，交 item_gen 生成 stats）+ 自定义装备战斗数值输入 + 自定义物品编辑管理 / characterName 属性传递 / 嵌套标签剥离 / activePresetId 运行时尊重 / 世界书 ST 宏噪音清理。ST 预设 setvar/getvar 配对机制排查经验见 debug 记录。story 正文救援兜底（rescueStoryOutput: 正文吞思维链 raw 空 → 从 reasoning 抠 / 思维链泄漏进正文 → 截 maintext 前；空门控 + 取最后 maintext + story 守卫）。

### Audio — 音频系统 v1.0 ｜ ✅

说明书: `docs/reference/audio_system.md`（← 改音频必读）。audio-channels.ts（MusicChannel 音序器 + SfxChannel 声池，69 tests）+ audio-manager.ts（音轨库注册表/主音量/手势解锁/playByTag AI 钩子，54 tests）+ audio-fakes.ts 测试替身 + Dexie 三表（audioTracks/audioBlobs/audioPlaylists，全局非存档级，排除于 FullBackup）+ types.ts 7 类型 + audio-singleton.ts/audio-store.ts 桥接 + AudioSection.vue/MiniPlayer.vue。v1 不做远程 URL 音源/解码缓存/真交叉淡入；**SFX 基建完备但刻意无触发方**；`public/audio/manifest.json` 内置库刻意空载（授权未清）。

**本地音乐文件夹增补 (2026-07-27)**: audio-folder.ts（File System Access 唯一接触点，27 tests）+ Dexie v12 audioHandles 表（持久化目录句柄）+ AudioSourceKind 增 `'file'`。三后端并存；权限不跨浏览器重启需每会话一次手势；扫描永不删行。**引擎零改动**——整个新存储后端由既有 loadBlob 注入缝吸收。增补: `docs/planning/2026-07-27-audio-local-files-addendum.md`

**按名称寻址 + 名称唯一性**: audio-names.ts（normalizeAudioName 四步归一化 / findByName 稳定取最早 / isNameTaken + uniqueAudioName，40 tests）。导入路径自动编号永不失败、手动录入拒绝重名；约束仅作用于新写入，存量重名不动。

**审查后修复 + 拆分 + 新功能 (2026-07-27)**: ①加载竞态收口（自增世代号 + 每个 await 后 isStale）②时长广播 ③store 错误处理族（forgetFolder 改返 boolean / rescanFolder / uploadFiles / markMissing 按 trackId 去重）④types-audio.ts 收纳 ⑤AudioSection.vue 1502 行拆壳层 + 5 子组件 ⑥播放列表拖拽排序 + 曲库多选与批量操作 ⑦database.ts 音频 reader 补 await。🔴 自动化测试全部跑在注入替身上。

**内置曲库上架 + 按地点选曲 (2026-07-27)**: `public/audio/bgm/` 收录 57 首（35 地点 A/B + 13 通用场景 + 9 人物主题，~267MB；无尽树海 B 源站 404 缺失），manifest 走 `source:'builtin'` 零代码改动上架；素材作者 Aoo；`license = PLACEHOLDER-PENDING-REVIEW`（测试占位，发布前需复核）。audio-tags.ts（四维标签，18 tests）+ audio-scene.ts（七段路径逐级回退 + 四维加权打分，42 tests）+ store playByScene()/playByLocation()（9 tests）。

**AI 接线 · Code 侧 (2026-07-27)**: `<play_audio situation mood variant action>` → marker-protocol 扫描 → orchestrator `onPlayAudio` → GamePipeline Stage1 只暂存、run() 末尾 refreshFromDb 后 flush → `playByScene`。AI 不写地点与在场角色；正文入库前 stripPlayAudioMarkers 剥标记。⚠️ AI 标记的 prompt 侧刻意留空。

**场景配乐接通 (v1 收尾)**: 三条来源——⓪界面切换（view-audio.ts + App.vue watch）①地点变化（主路径）②AI 标记。手势解锁监听上提到 main.ts。设置→音频→混音台「场景配乐」开关（`audioSceneAutoPlay`，默认开）。📌 免手势自动播放是平台约束非缺陷。✅ 真机验证已过（地点换歌/界面换歌/试听出声/手势解锁时机）；❌ 音效与 AI 标记无从验起。

**内置 mp3 移出仓库 (2026-07-28)**: 57 首（267MB）随音频系统误提交并推送。已 `git rm --cached public/audio/bgm/` + `.gitignore` 加音频扩展名规则；manifest.json 与 README.md 继续 tracked。后果: 全新 clone 会列出 57 首但点不响（文件 404）——把 mp3 放回即恢复。历史提交仍含字节，彻底瘦身需重写历史（本次刻意不做）。

### 10k — 快照面板 + 右键回退重发 ｜ ✅ 待真机验证

左侧 SideToolbar「快照」按钮（SnapshotPanel 历史快照恢复）+ 最新 AI 消息右键「回退本轮/复制」（回退 = restoreSnapshot 上一轮 + 回填本轮输入 → 重发即重生成 / 编辑重发）+ Snapshot 阶梯保留（trimSnapshots tiered: 最近 5 全留 + 旧层 4/8/10 稀疏，非 turn 档受保护）+ restoreSnapshot 增强（plotEvents 捕获 + 覆写 / memories 清理 / totalTurns 对齐）+ 设置「快照保留模式」可配置（pipeline 搭桥同步 AppSettings）。计划: `docs/planning/2026-07-23-snapshot-rollback-plan.md`

### 10j — 剧情系统接线 ｜ ✅ 待真机验证

9 断点收口 + 三 Agent systemPrompt 重写（含雷点注入 + 修改模式）。计划: `docs/planning/2026-07-19-plot-system-plan.md`；大纲仅捏人页生成（main + side），游戏内零生成，演化归 post_check.outlineChanges；plotYearlyGeneration 退役。

### 10i — 输出美化规则库 ｜ ✅

beautifier-rules.json 预设规则（22 条: 2 内置 + 20 远程）+ 世界书/角色 auto-enable 绑定 + BeautifierSection 三段式 UI + ChatFlow 合并规则渲染 + 远程 regex.json 导入脚本。

### 10h — ST 预设占位符适配 ｜ ✅

`{{setvar}}`/`{{getvar}}`/`{{random}}` 解析替换管线 + 前端条目开关可点自动保存。

### M1-M6 — 数据字段规范迁移 ｜ ✅（2787 tests 首次 100% 全绿）

52 项收口:

- **M1** 类型库层
- **M2** StateManager 按名寻址
- **M3** 翻译层零 id
- **M4** Prompt 契约对齐 + 过渡拆除
- **M5** SSOT（变量迁家 + 快照重建 + 新闻好感接线）
- **M6** 读方切换 + 双写退役 + 收官

规范: `docs/superpowers/specs/2026-07-16-data-field-conventions-design.md` + `2026-07-16-entity-field-audit.md`。核心铁律: 逻辑键=名字（AI 永不产 id）· 名字解析唯一入口 · AI 填叙事字段 Code 补账务字段 · 每类数据唯一真源 · 枚举中文集中定义。

---

### 2026-07-31 — 修复：选工坊命定核心卡在捏人第 3 步

**症状**：新建存档 → 命定核心步骤 → 选一个工坊的命定核心 → **下一步按钮永不亮起**，
且没有任何提示说明缺什么。

**根因**：`stepValid[2]` 只认 `selectedSystemCoreEntryUid`（内置 `system_core` 条目的
uid）。工坊项目走的是另一条轴（项目级多选 `enabledWorkshopProjectIds`），选中它不会
写那个 uid，闸门自然一直关着。上一轮把工坊多选挪到本步同屏时，只搬了位置，没有把
「工坊系统项目也是命定核心候选」这件事接进闸门。

**修法**（按主人指定）：标了「系统」标签的工坊项目**并入命定核心那份单选名单**，
与内置核心同等对待 —— 同一个单选槽、互斥、同样满足必选闸门。

- `workshopSystemOptions` / `workshopExtraOptions`：按 `tags.includes('系统')` 一分为二
- `selectedWorkshopCoreProjectId`：工坊核心的单选槽，与 `selectedSystemCoreEntryUid`
  **双向互斥**（命定核心只有一枚，选一个就清另一个）
- `stepValid[2]`：两者任一非空即放行
- `buildEnabledWorldBookEntries`：工坊核心与附加项目**合流**后交给
  `applyWorkshopSelection` —— 存储上二者没有区别（都是 `creative_workshop:<uid>`），
  区别只在捏人页的选择语义，下游 `filterBooksByEnabledEntries` 无需知情
- 下方多选区改用 `workshopExtraOptions`，同一个项目不会同屏出现两次

涉及文件: `create-store.ts` · `CreateStepDestinyCore.vue`（+ 两处测试）

验证: 141 文件 / 4700 测试全绿（+7）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 仍未真机走查。

---

### 2026-07-31 — 工坊评审修复 + 减动效开关 + 工坊书对 Agent 可见

Fable 评审（`ed28320..107f80b`）的 7 项发现全部修掉，另加两个功能。

**🔴 三处「我说过的话是错的」**

1. `WorkshopDetailModal` 的 docblock 声称装前预告与装后报告「不可能分家」——**假的**。
   `mapWorkshopRegexes` 是**索引敏感**的（未命名正则兜底成 `未命名正则 ${序号+1}`），
   逐条单独调用时序号恒为 0，同一条正则装前显示「未命名正则 1」、装后显示
   「未命名正则 3」。修：`RegexMapContext` 加 `indexBase`，检视侧传真实序号。
   （评审用一个失败用例证明的，不是推测。）
2. 「防抖动」的 `gridKey` **自己就是抖动源**：它由 `sort|tag|search|page` 拼成，
   全是**输入**，在请求发出前就变了。打字（350ms 防抖）会在一发请求都没出去时
   重建网格三次并重放入场动画；翻页则先拿上一页卡片演一遍、数据到了再演一遍。
   修：改成结果落地时 +1 的 `renderSeq`。
3. 上一条 changelog 说全局减动效规则「兜住了」—— 只兜住一半。它没覆盖
   `animation-delay`，于是带 `both` 的交错入场在减动效下变成「隐身 280ms 再逐个弹出」，
   恰好砸在最不想看动效的人脸上。修：全局规则补 `animation-delay` /
   `transition-delay` / `scroll-behavior`。

**其余修复**

- 两个确认模态的忙碌态是**死代码**：`confirmOverwrite` / `confirmUninstall` 都先关模态
  再 await，「正在覆盖…」「卸载中…」永远没机会渲染。改成跑完再关，并在写入期间
  禁掉取消与遮罩关闭（写入不可中断，留个假出口不如禁掉）。
- 本地文件导入**绕过了忙碌闸门**，能在 60s 载荷下载途中并发跑第二个 commit，
  先收工的那个把忙碌态清掉、按钮提前解禁。补 `if (busyId) return`。
- 折叠行收起后**仍在无障碍树里**（0fr + overflow:hidden 只是视觉隐藏），且里面
  `overflow: auto` 的代码块在 Chrome 下可被 Tab 聚焦。补 `visibility`（延迟到动画
  结束）+ `aria-controls`。
- 上游正则 **id 可重复**（不可信输入）：撞号时 `workshopRuleId` 会让后一条静默盖掉
  前一条（「装了 5 条」实际只有 4 条）。`workshop-manifest` 加 `dedupeRegexIds`，
  首次出现者保留原 id。
- 详情模态主按钮不再「卸载时装按钮转圈」（补 `busyAction`）。

**🆕 减少动态效果开关**（设置 → 外观主题，**默认关**）

`settings.reducedMotion` → `<html data-reduced-motion>` → CSS 全站关动画。系统的
`prefers-reduced-motion` 仍**独立生效**，本开关只做「额外强制开启」，不做「强制关闭
系统偏好」。JS 侧不受 CSS 管辖的动作（平滑滚动）走 `lib/reduced-motion.ts` 同一判定。

**🆕 工坊书对所有 Agent 可见**

★ 此前是**装了等于没装**：Agent 只读 `AgentConfig.worldBookIds` 点过名的书，而工坊书
带的是新 id（`workshop:<projectId>`），不在任何 Agent 清单里 —— 于是「装了 + 存档里
勾了启用」的工坊内容，一个 Agent 都读不到。安装时 `grantWorkshopBookToAgents` 把书
挂进所有 Agent，卸载时 `revokeWorkshopBookFromAgents` 收回（不收回会积一串死 id）。

只动 `worldBookIds` 名单，**不碰** `agentWorldbookEnabled` —— 那是另一条轴（「这个
Agent 到底用不用世界书」），项目默认里 memory_recall / plot_pre_check / item_gen /
combat 是刻意关掉的，替用户翻开会让它们凭空吃下整包工坊内容。条目自身的 `enabled`
与存档级 `enabledWorldBookEntries` 仍照常过滤。

涉及文件: `workshop-regex-map.ts`(+`indexBase`) · `workshop-manifest.ts`(+去重) ·
`workshop-types.ts`(+两个 grant/revoke 纯函数) · `workshop-store.ts` ·
`WorkshopPage.vue` · `WorkshopBrowseModal.vue` · `WorkshopDetailModal.vue` ·
`WorkshopConflictModal.vue` · `settings-store.ts` · `SettingsPage.vue` · `App.vue` ·
`themes/variables.css` · 新增 `lib/reduced-motion.ts`

验证: 141 文件 / 4693 测试全绿（+26）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 仍**未做真机走查**（预览面板不合成帧、Chrome 扩展未连接）。

---

### 2026-07-31 — 加载态动画：AppButton 忙碌态 + 水合骨架

补的是「按下去之后什么都没发生」的那段沉默。工坊一次安装要下几百 KB 载荷，
这段沉默可以长达几十秒。

**`AppButton` 新增 `loading`**（共享组件，可选 prop，不影响既有调用点）

- 转圈 + 自动禁用 + `aria-busy`；转圈用 `em` 与 `currentColor`，三档尺寸 ×
  四个 variant × 10 主题都不必另配
- ★ 与 `disabled` **语义不同**，别拿 disabled 顶替：disabled 是「不能做」，
  loading 是「正在做」。两者长一个样时，用户按下按钮后只看到它变灰，分不清是
  自己点漏了、还是被拒绝了、还是在跑。故 loading 有自己的压暗度（0.8，
  btn-disabled 的 0.5 会把转圈也压得看不清）

**转圈只落在按下的那个按钮上**：`WorkshopPage` 的 busy 状态从「项目 id」扩成
「id + 动作」（`beginBusy`/`endBusy` 成对）。一行并排三个按钮，只按 id 判定会三个
一起转，用户看不出跑的是「查更新」还是「卸载」—— 卸载不可逆，让它看起来在跑而
实际在跑别的是会吓到人的。

**🔴 水合骨架（顺带修掉一个真错）**：`WorkshopPage` 此前不看 `store.ready`，
于是每次进页面的头一瞬都渲染「尚未安装任何工坊项目」+「已安装（0）」——
对一个装了十个项目的用户来说这两句都是假的。现在水合中渲染骨架行。

**详情模态首屏骨架**替掉一行「正在取详情…」：文字态只有一行高，详情到位后整个模态
从一行猛涨到满屏，那一下窜动比等待本身更让人不适。

**减动效**：删掉本轮新写的 `animation: none` 局部覆盖，统一交给
`themes/variables.css` 的全局规则（`animation-duration: .01ms !important` +
`animation-iteration-count: 1 !important`）。★ 它比 `animation: none` 正确：后者会连
`both` 的终态一起撤销（卡片会停在 `opacity: 0`，减动效用户看到一片空网格），
前者是「瞬间跑完一轮」，天然停在终态。

涉及文件: `AppButton.vue`(+`loading`) · `WorkshopPage.vue` · `WorkshopInstalledList.vue`
(+`busyAction`/`hydrating`) · `WorkshopDetailModal.vue` · `WorkshopConflictModal.vue` ·
新增 `AppButton.test.ts`

验证: 140 文件 / 4667 测试全绿（+9）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 同上：**未做真机走查**，动画观感待确认。

---

### 2026-07-31 — 工坊 P1 增补：装前检视 / 服务端排序 / 恒定标签条 + 抗抖动

对齐上游插件（`AkabaneSaki/myrepo`）功能盘点后补的三处差距，外加浏览模态的抖动治理。

**装前检视（详情模态）**

- 世界书条目与正则**逐条可展开**，不再只报一个总数。条目展开后给主/次关键词、
  匹配逻辑、order/position 与完整正文；正则给 pattern、replacement。
- ★ 每条正则带**处置预告**（不会生效 / 全局副作用），走的是安装时那个
  `mapWorkshopRegexes` —— 与装后已装列表**同源**。这是本屏比上游多出来的一件事：
  上游把 ST 字段搬进 ST，没有东西会丢，只需展示 pattern；我们的美化库不是 ST 正则
  引擎，与其装完再说「N 项未导入」，不如装之前就在每一条上标出来。
  🔴 若将来有人在这里另写一套判定，用户就会遇到「装前说好好的、装完说没导入」。
- 长列表先渲 25 行，其余按需 —— 上游有几百条目的项目，一次性展开会让模态卡一拍。

**服务端排序**：`WORKSHOP_SORT_MODES`（published/updated/likes/subscribes/downloads）。
排序必须服务端做且回到第 0 页，否则会排出「第 2 页的热门项目排在第 1 页的冷门项目之前」。
社交**计数**仍不消费（Phase 3+），按它们排序只是一个查询参数。

**恒定标签条**：`WORKSHOP_BASE_TAGS`（系统/扩展/角色/事件）替掉「从当前页现采」。
现采有两处害：翻到不含某标签的页时该标签会消失；条的行数随内容变化，每次翻页都把
下方整个网格顶上顶下。

**抗抖动 + 动画**（design.md §6.1 口径）

- 结果区 `min-height: 420px` —— 末页条数少时模态不再先塌后弹
- 首次加载用**骨架屏**替掉一行文字，先把最终布局占住
- 在飞时旧结果压暗（只动 opacity）而非抽走，屏幕上始终有内容
- 卡片入场 opacity + translateY(12px)/0.35s，逐格递延 40ms 至第 8 格封顶
- 折叠行展开走 `grid-template-rows: 0fr→1fr`（禁止 max-height 过渡）
- 翻页后滚回结果区顶部
- 全部配 `prefers-reduced-motion`（入场动画关掉时显式把卡片摁回可见，
  否则 `animation: none` 会连 `both` 的终态一起撤销 → 一片空网格）

涉及文件: `workshop-types.ts`(+`WORKSHOP_BASE_TAGS`) · `workshop-client.ts`
(+`WORKSHOP_SORT_MODES`) · `WorkshopBrowseModal.vue` · `WorkshopDetailModal.vue` ·
`format.ts` · 新增 `WorkshopDetailModal.test.ts`

验证: 139 文件 / 4658 测试全绿（+13）· typecheck & vue-tsc 0 错误 · lint 0 error。
🔴 **未做真机走查** —— 预览面板不合成帧（Vue `<Transition>` 依赖 rAF，导航卡在
leave 阶段），Chrome 扩展未连接。视觉与动画观感待真机确认。

---

## 历史速览

已完成且稳定的旧 Phase（1-9、10a-g、6x、Geography、Audit Fix）细节由 `docs/phases/` 各计划文档 + git log 承载，不再在此处展开。状态见 `AGENTS.md`「当前进度」速览表。

---

## 未来条目

新 PR 在此处按日期倒序追加，格式:

```
### YYYY-MM-DD — <PR 标题 / Phase>
- 变更内容
- 涉及文件
- 验证方式（测试 / 真机 / 仅编译）
```
