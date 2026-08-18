# 战斗 v3 架构交接地图（给 plan 作者）

> ✅ **已完成历史使命（2026-08-01，M5 收尾）**：v3 实施计划已按本地图写完并落地（M0→M5 全部合并）。§2「待补完」6 项已在 `docs/reference/combat-system-architecture-v3.md` 补齐（D1-D6）并由各 M 实现——**架构见 v3 文档，本文件仅供追溯 plan 编写过程**。
>
> 📌 本文件是给**写实施 plan 的开发者**的导航地图。v3 架构资料现在散在 4 份文档 + 本喵瞄刚落的 RFC/案例集，本地图帮你快速定位"架构现在在哪、还缺什么、v2 现状、前后端边界、写 plan 从哪切入"。
>
> **自包含**：读这一份就能上手写 plan，按需查链接的详细文档。
>
> 🔗 配套：压测+补丁 RFC（`2026-07-31-combat-v3-real-sample-stress-test-rfc.md`）与 5 场脑测案例集（`2026-07-31-combat-v3-stress-test/`）——均已移入私有内容仓 `fated_poem_independent_assets/docs/planning/`，公开仓侧不可见。

---

## 0. 一句话定位

v3 = 把 v2「Agent 主持流程、代码辅助结算」翻转为「**代码内核主持流程、Agent 辅助决策与叙事**」。不是从零重写——纯计算函数（伤害管线/意图/先攻/士气）保留，重写的是**控制流接线层**（runner/pipeline/EventBus emitChain/script-executor）。

---

## 1. v3 架构资料清单（按读的顺序）

| 顺序 | 文档                                                                                                                                                                                | 定位                                      | 读它拿什么                                                                                                             |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ①    | [`docs/reference/combat-system-architecture.md`](../../reference/combat-system-architecture.md)                                                                                     | **v2 现状架构**（真源）                   | 当前 19 event / 6 大效果类别 / 8 步管线 / buff 系统 / 核心数值。**写 plan 的 v2 基线**                                 |
| ②    | [`docs/archive/planning/2026-07-30-combat-event-system-review.md`](./2026-07-30-combat-event-system-review.md)                                                                      | **v2 对抗式审查报告**                     | 7 Critical / 15 Major / 9 Minor —— v3 要解决的 v2 断点清单                                                             |
| ③    | [`docs/archive/planning/2026-07-30-combat-kernel-v3-proposal.md`](./2026-07-30-combat-kernel-v3-proposal.md) + `reference/战斗架构设计参考.txt`（已移入私有内容仓，公开仓侧不可见） | **v3 提案骨架**（Codex 原作）             | dispatch 单入口 / EffectIntent 词汇 / 5 不变量 / 状态机 / 迁移映射表。**注意：骨架级，schema/window/RuleKey 内容留白** |
| ④    | `2026-07-31-combat-v3-real-sample-stress-test-rfc.md`（已移入私有内容仓 `fated_poem_independent_assets/docs/planning/`，公开仓侧不可见）                                            | **本喵瞄压测+补丁 RFC**                   | 6 类缺口分析 + §5 补丁详案（5.1-5.7）+ §7 调整后 M0-M5 落地路线。**写 plan 的核心依据**                                |
| ⑤    | `2026-07-31-combat-v3-stress-test/`（已移入私有内容仓 `fated_poem_independent_assets/docs/planning/`，公开仓侧不可见）                                                              | **5 场脑测案例集**                        | 每场 EffectAutomaton 伪代码 / Command 序列 / 时间线 / 卡点。**写 plan 时验证覆盖度的实证库**                           |
| ⑥    | [`docs/reference/combat-system-architecture-v3.md`](../../reference/combat-system-architecture-v3.md)                                                                               | **战斗 v3 正式架构（真源，取代 ③ 骨架）** | ③+④ 整合完成体 + D1-D6 拍板决策 + 5 处代码现状修正 + 双投影/迁移映射/引擎边界。**写 plan 直接读这份，③ 只作历史参考**  |

⚠️ **重要**：③ 是骨架，**不是完整架构**；④ 的 §5 是对 ③ 的补丁。二者已于 2026-07-31 整合为 ⑥《战斗系统架构 v3》——**写 plan 以 ⑥ 为准**，③ 仅作历史参考。本文档 §2 的「待补完」项已在 ⑥ 中补齐（D1-D6），§3 的迁移映射表已被 ⑥ §十五 校正（`combat-panel.ts` 实为 LLM 文本面板格式化器，不是 UI adapter）。

---

## 2. v3 架构「已定 vs 待补完」地图

### ✅ 已定（提案 + RFC 补丁，可直接进 plan）

| 维度                    | 已定内容                                                                                                                                                                                                                                   | 出处                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------- |
| **控制模型**            | `CombatSession.dispatch(command): CombatTransition` 单入口；纯 reducer 内部；唯一 CombatState；一次原子提交                                                                                                                                | 提案                      |
| **EffectIntent 词汇**   | 14 类：Modifier/Outcome/Override/Permission/SelectOrRetarget/Schedule/SpawnOrDespawn/RequestChoice/PreventDeath/ConsumeCharge/SummonUnit/EmitNarrativeCue 等                                                                               | 提案 + RFC §5.3 补 schema |
| **5 不变量**            | ①1攻击+1动作 ②额外行动仅 GrantActionSlot ③骰子仅 DiceTape ④变化同原子提交 ⑤结算幂等                                                                                                                                                        | 提案                      |
| **原版状态机**          | RoundOpen→正面tick→战况总览→先攻→UnitTurnOpen→士气→UnitTurnClose→RoundClose→Terminal→Settlement                                                                                                                                            | 提案                      |
| **ReactionWindow 清单** | round.open/close, initiative.before/after, turn.open/close, action.declared, check.intent/hit, collect_attacker/defender_mods, **damage.preview**🆕, damage.compute, damage.after, unit.beforeDown, morale.before/after, settlement.before | RFC §5.4                  |
| **DealDamage schema**   | + damageType / bypass / isReaction / doesNotConsumeSlot / rootChainId / depth                                                                                                                                                              | RFC §5.3                  |
| **SummonUnit schema**   | + duration{rounds} / joinTiming（与 char_gen 协同）                                                                                                                                                                                        | RFC §5.1/5.3              |
| **closed RuleKey**      | morale.forceState / terminal.forceTerminal / action.freezeSlot / death.threshold                                                                                                                                                           | RFC §5.5                  |
| **divinity 压制**       | 差值压制表（差1级20%...差≥5级100%），泛化到状态对抗/意图对抗                                                                                                                                                                               | RFC §5.5                  |
| **DiceTape**            | 分通道：initiative/attackHit/statusContest/procCheck/intentCheck 各独立 cursor                                                                                                                                                             | RFC §5.7                  |
| **FP 跨边界**           | 战斗开始快照进 CombatState；终局 diff 回 SaveProfile；journal idempotencyKey                                                                                                                                                               | RFC §5.6                  |
| **反伤专项**            | MAX_REFLECTION_DEPTH=2；超限互相抵消；depth≥2 基准取 rootChain 原伤害                                                                                                                                                                      | RFC §6                    |
| **char_gen 战斗中调用** | `RequiredInput.CharGenRequest`；SummonedUnitDefinition 带 joinTiming/duration/actionEconomy                                                                                                                                                | RFC §5.1                  |
| **BoundedAdjudication** | 战斗 Agent 提 ProposedAdjudication；内核验边界（divinity/目标/数值/不变量）不验创造性                                                                                                                                                      | RFC §5.2                  |

### ✅ 已补完（→ 架构 v3 文档节号，M0-M5 已落地）

| 维度                            | 补完落点（架构 v3）                                                               | 落地里程碑 |
| ------------------------------- | --------------------------------------------------------------------------------- | ---------- |
| **CombatSession 生命周期**      | §二 核心控制模型（openCombat/dispatch/RequiredInput）+ §三 原子提交               | M1         |
| **EffectAutomaton DSL 语法**    | §七 7.3 表达式微文法（parser/interpreter）+ `automata/parser.ts`                  | M3         |
| **EffectProgram 编译链**        | §七 7.4 编译链（compileEffectProgram 9 校验）+ `automata/compile.ts`              | M3         |
| **DomainEvent → UI projection** | §十三 双投影（projection-ui / projection-agent）+ 29 事件清单                     | M2         |
| **contract test 黄金参照系**    | §四 4.6 replay 语义 + 7 场 fixture（case-06/07/09/13/24/x1/x2）contract test 全绿 | M4         |
| **DiceTape 通道预算分配**       | §四 4.1 五通道 32/10/7/6/5 + `dice-tape.ts` splitSixty                            | M0         |

---

## 3. v2 现状摸底（写 plan 的改动清单）

### 3.1 后端（`src/sillytavern/combat-*.ts`）

| v2 文件                         | v3 命运                                      | 说明                                                                                   |
| ------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------- |
| `combat-runner.ts`              | 🔻 **降为 CombatSessionCoordinator adapter** | 连接 UI/Agent/内核；不再主持流程；移除 `awaitPlayerInput()` 挂起                       |
| `combat-pipeline.ts`            | 🔻 **CombatKernel 内部 implementation**      | 不再独立存在                                                                           |
| `combat-resolver.ts`            | 🔻 **CombatKernel 内部 implementation**      | DAG 编排逻辑进内核                                                                     |
| `combat-damage.ts`              | ✅ **保留**（纯函数）                        | 8 步伤害管线 / 评级 / 防御计算。提案明确保留。真伤走 `damageType:'true'`+`bypass` 短路 |
| `combat-intention.ts`           | ✅ **保留+修正**（纯函数）                   | 意图对抗公式保留，改为消费两颗独立骰（DiceTape.intentCheck 通道）+ 补回非致死结算      |
| `combat-turn.ts`                | ✅ **保留**（纯函数）                        | 先攻公式 + 行动槽模型保留，**必须由内核实际调用**（v2 没接线）                         |
| `combat-panel.ts`               | 🔻 **DomainEvent projection adapter**        | 从唯一 CombatState 生成 UI 投影，替代多条状态源                                        |
| `combat-modifier-inject.ts`     | 🔻 **EffectIntent 数值层**                   | modifier 六大类别编译为 EffectProgram                                                  |
| `combat-actions-pipeline.ts`    | 🔻 **战术动作 command 处理**                 | 道具/格挡/移动/专注/逃跑 → CombatCommand                                               |
| `combat-morale-pipeline.ts`     | ✅ **保留纯函数 + 加 forceState override**   | 士气阈值/战斗类型/随机规则保留；加 `morale.forceState` closed RuleKey                  |
| `combat-settlement-pipeline.ts` | 🔻 **settlement（幂等）**                    | 挂 `combatId + settlementId` 保证幂等；FP diff 终局提交                                |
| `combat-item-validator.ts`      | 🔻 **EffectAutomaton 编译时校验**            | 验证目标/品质/神性/次数/资源/数值范围                                                  |

### 3.2 后端相关（非 combat-*.ts 但要改）

| v2 文件                                  | v3 命运                            | 说明                                                                                              |
| ---------------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| `game-event.ts`                          | 🔻 **拆分**                        | 战斗内 `emitChain` → ReactionWindowEvaluator；战斗外 `publish` → 保留 GameEvent（剧情/任务/地点） |
| `script-executor.ts`                     | 🔻 **声明式 DSL interpreter 替换** | `new Function` 路径由 EffectProgram interpreter 替换                                              |
| `state-manager.ts`                       | 🔻 **持久化 adapter**              | 战斗外权威保留；战斗内不再是第二状态权威                                                          |
| `subscription-manager.ts`                | 🔻 **ActiveEffectIndex**           | 从装备/技能/状态派生；进入/离开/过期统一更新                                                      |
| `effect-parser.ts` / `effect-runtime.ts` | 🔻 **EffectProgram 编译链**        | 现有 ScriptEffects 演进为 EffectIntent                                                            |
| `char-gen-agent.ts`                      | 🔧 **扩展战斗中调用入口**          | 新增 CharGenRequest 处理（RFC §5.1）                                                              |

### 3.3 前端（`src/ui/components/game/combat/`）

提案明确：**前端展示层不必重写，改为订阅 DomainEvent projection**。

| v2 组件                            | v3 改动                      | 说明                                                                 |
| ---------------------------------- | ---------------------------- | -------------------------------------------------------------------- |
| `CombatPanel.vue`（主面板）        | 🔧 数据源改 projection       | 从 CombatSessionCoordinator 拿 CombatView，不再直接读 v2 combatState |
| `CombatActionBar.vue`（行动栏）    | 🔧 输出改 PlayerCommand      | 用户/敌人行动输入 → CombatCommand（带 commandId + expectedRevision） |
| `CombatActionCard.vue`（行动卡片） | ✅ 基本不动                  | 渲染 DomainEvent 投影                                                |
| `CombatHeader.vue`（头部）         | 🔧 数据源改 CombatView       | 投影唯一 CombatState                                                 |
| `CombatMessageFlow.vue`（消息流）  | 🔧 订阅 DomainEvent 叙事投影 | 含 MiracleTriggered / ForbiddenGateOpened 等新事件                   |
| `CombatUnitCard.vue`（单位卡片）   | 🔧 投影 CombatState.units    | 支持召唤物动态加入/消失（UnitSummoned/UnitDespawned 事件）           |

⚠️ 前端要新增的交互：`RequiredInput` 类型的等待 UI（EffectChoice 格挡询问 / BoundedAdjudication 玩家确认 / BeginOutput 加载态 / CharGenRequest 召唤中态）。

---

## 4. 前后端边界（CombatSession ↔ DomainEvent ↔ UI）

```
┌─────────────────── 后端（src/sillytavern/）───────────────────┐
│                                                                │
│  CombatSessionCoordinator（adapter，原 combat-runner）          │
│       ↕ PlayerCommand / RequiredInput                          │
│  ┌─────────────────────────────────────────────────┐           │
│  │ CombatKernel（deep module）                      │           │
│  │  ├─ dispatch(command): CombatTransition          │           │
│  │  ├─ ReactionWindow evaluator（原 emitChain）     │           │
│  │  ├─ EffectIntent validator + interpreter         │           │
│  │  ├─ DiceTape（分通道，60-d20 顺序消费）           │           │
│  │  ├─ closed RuleKey 集（含 forceTerminal 等）      │           │
│  │  └─ 纯函数保留：combat-damage/intention/turn     │           │
│  └─────────────────────────────────────────────────┘           │
│       ↕ DomainEvent（事实，不可改） + CombatView（投影）         │
│  DomainEvent → CombatEvent projection adapter（原 combat-panel）│
│                                                                │
└────────────────────────────────────────────────────────────────┘
                              ↕  (Pinia store / IPC)
┌─────────────────── 前端（src/ui/components/game/combat/）────────┐
│  CombatPanel.vue ← CombatView 投影                               │
│  CombatActionBar.vue → PlayerCommand（带 commandId+revision）    │
│  CombatMessageFlow.vue ← DomainEvent 叙事投影                    │
│  CombatUnitCard.vue ← CombatState.units 投影                     │
│  RequiredInput 等待 UI（格挡询问/裁决确认/召唤中/骰池加载）        │
└──────────────────────────────────────────────────────────────────┘
```

**关键边界契约**：

- 后端 → 前端：`CombatTransition { nextState, events, waitFor? }`，前端只读投影，不直接改状态
- 前端 → 后端：`CombatCommand { commandId, expectedRevision, cost, payload }`，带 revision 串行化
- 中断恢复：`waitFor` 触发时前端展示等待 UI，玩家提交 `Choose` 类 command，内核恢复 continuation（不重跑、不重消费骰子）

---

## 5. 三个关键方案的 plan 关注点

### 5.1 char_gen 战斗中调用（解缺口 C）

**plan 要设计**：

- CombatSessionCoordinator 检测 SpawnUnit intent 且模板未预置 → 发起 `RequiredInput.CharGenRequest`
- 等待 char_gen Agent 返回 `SummonedUnitDefinition`（含 joinTiming/duration/actionEconomy）
- 喂回内核插入先攻序列
- **与现有 `char-gen-agent.ts` / `request_dispatcher` 的协作**：现有是 Stage2 异步检测新 NPC，v3 是战斗中同步触发（dispatch 暂停），时序模型不同，要明确接线

**⚠️ 开放问题**（RFC §8.1）：char_gen 异步 3-10 秒，玩家体验？建议预生成常见召唤物池，战斗中只选不现造。

### 5.2 BoundedAdjudication 接口（解缺口 F）

**plan 要设计**：

- 战斗 Agent 在 ReactionWindow 遇"无法用标准 intent 表达的创意效果" → 提 `ProposedAdjudication`
- 内核验证流程：divinity 够不够 / 目标合法 / 数值范围 / 5 不变量 → 通过则执行，否则 EffectRejected
- 战斗内只产 DomainEvent（DamagePrevented / MiracleTriggered / ForbiddenGateOpened），奇迹效果投影给 Story Agent
- **何时走标准 intent、何时走裁决的判定流程**：建议设 divinity≥法则级 硬门槛（防滥用）

**⚠️ 开放问题**（RFC §8.2）：战斗 Agent 会不会把所有不好表达的效果都走裁决绕过 EffectIntent？

### 5.3 FP 跨边界（解缺口 E）

**plan 要设计**：

- `openCombat` 时 FP 从 SaveProfile 快照进 `CombatState.resourceSnapshots.FP`
- 战斗内所有 FP 操作对副本，走原子提交（不变量④）
- `settlement` 时计算 FP 净变动，幂等 diff 回 SaveProfile（不变量⑤）
- journal 记 FP diff 的 idempotencyKey 防重放
- 战斗中途退出（非终局）：FP 不落库（保护玩家）
- Command 校验"FP≥N"读 CombatState 副本，不实时查 SaveProfile

---

## 6. 开放问题 + 本喵瞄建议（RFC §8 补充建议）

| #   | 开放问题                           | 本喵瞄建议                                                                                                                         |
| --- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | char_gen 战斗中调用性能（3-10 秒） | 预生成常见召唤物池（亡灵/元素/野兽等模板提前 char_gen 好），战斗中只匹配不现造；稀有/特殊召唤才实时 char_gen                       |
| 2   | BoundedAdjudication 滥用风险       | 设硬门槛：`divinity ≥ 法则级(5)` 才能提 ProposedAdjudication；低于法则级的"创意效果"必须用标准 EffectIntent 组合表达               |
| 3   | MAX_REFLECTION_DEPTH=2 是否合适    | M4 阶段补一个"双方都带反伤被动"的极端压测样本（现有 24 场无此案例）                                                                |
| 4   | 第24场复活机制未实证               | M4 阶段补一个"角色真正死亡后复活"的压测样本（AM0288 只是背景设定）                                                                 |
| 5   | DiceTape 通道预算分配              | 用本案例集 5 场样本统计：每场各通道（initiative/attackHit/statusContest/procCheck/intentCheck）的 d20 消耗比例，按比例预分配 60 颗 |

---

## 7. 写 plan 的建议切入点

### 7.1 推荐顺序

1. **先补完架构**（§2 待补完项）→ 整合一份正式《战斗架构 v3》文档（对标 `combat-system-architecture.md` 体量），取代提案骨架
2. **写 M0 RFC**（contract tests + 分通道 DiceTape + replay harness）—— 这是地基，DiceTape 必须一开始就分通道，否则返工
3. **逐 M 写 RFC + 实现**（M1 → M2 → M3 → M3.5 → M4 → M5），每个 M 对标 `combat-v2-m1-rfc.md` 的粒度（文件/接口/测试细化）

### 7.2 每个 M 的 plan 检查清单

- [ ] 改了哪些 v2 文件（查 §3.1/3.2 的"v3 命运"列）
- [ ] 前端组件改动（查 §3.3）
- [ ] 用哪几场战斗样本验证（查案例集）
- [ ] 测试策略：contract test（对齐 v2 真机）+ 单元测试 + replay 幂等
- [ ] feature flag：M2 起按整场战斗选 v2/v3（提案否决同场混用）
- [ ] 5 不变量是否守住
- [ ] 开放问题是否触发（查 §6）

### 7.3 M0-M5 速览（RFC §7.2 详）

| M    | 内容                                                                                        | 关键产出                         |
| ---- | ------------------------------------------------------------------------------------------- | -------------------------------- |
| M0   | 原版协议 contract tests + **分通道 DiceTape** + replay harness                              | 黄金参照系（v2 真机 + 5 场样本） |
| M1   | 基础攻击 + 战术动作 + 行动槽 + 回合 + 状态 tick + 唯一终局（含 forceTerminal）              | CombatKernel 骨架                |
| M2   | runner CompatibilityAdapter（feature flag v2/v3）                                           | v2/v3 可切换                     |
| M3   | modifier/buff 编译为 EffectProgram + **DealDamage 完整 schema** + **damage.preview window** | EffectIntent 落地                |
| M3.5 | 🆕 **char_gen 战斗中调用** + BoundedAdjudication 接口                                       | 缺口 C/F 解决                    |
| M4   | 反伤/免死/召唤/延迟效果/法则技能压力测试（用本案例集 5 场）                                 | 创意机制验证                     |
| M5   | v3 默认启用 + 保留 v2 回滚 → 删旧接线                                                       | 收尾                             |

---

## 8. 风险提醒

1. **不要照 v3 提案骨架直接落地**——5 场真实样本压测证明会卡在 6 类缺口（schema/window/RuleKey/跨边界/不变量冲突/开放性），必须先补 RFC §5 的补丁。
2. **DiceTape 必须一开始就分通道**——M0 不分，M3+ 攻击/状态/概率触发骰子互相错位，replay 全废，返工成本巨大。
3. **forceTerminal 是概念级战斗的刚需**——不补这个 closed RuleKey，所有"非 HP 清空判胜"的 Boss 战（认知抹杀/概念崩坏/奇迹）都卡死。
4. **v2 M6 真机建议先做**——真机能暴露脑测想不到的问题，且 v2 真机输出是 v3 contract tests 的黄金参照系（主人待定）。
5. **前后端边界要早定**——CombatTransition / CombatCommand / DomainEvent 三个契约是前后端并行开发的前提，M1 就要冻结。

---

## 变更记录

| 日期       | 变更                                                                                 | 作者   |
| ---------- | ------------------------------------------------------------------------------------ | ------ |
| 2026-07-31 | 初版：v3 架构交接地图（资料清单 + 已定/待补完 + v2 摸底 + 前后端边界 + plan 切入点） | Claude |
