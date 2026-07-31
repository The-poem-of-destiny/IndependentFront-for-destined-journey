# 战斗 v3 真实样本压测报告 + 补丁 RFC

> 📌 **文档定位**：本喵瞄总指挥用 5 个真实战斗对话样本（`reference/战斗对话样本/`），反向压测 Codex 的 `gpt-5.6-sol` v3 提案（[`combat-kernel-v3-proposal.md`](./2026-07-30-combat-kernel-v3-proposal.md) + [`战斗架构设计参考.txt`](../../reference/战斗架构设计参考.txt)），找出 v3 在实机上的执行问题，并给出补丁方案。
>
> **方法**：5 个 opus 子 agent 并发，每个负责 1 个真实案例，按"v3 复现方案（CombatCommand 序列 + EffectAutomaton 伪代码 + 流程时间线）→ 架构执行问题清单 → 判定"结构脑测。
>
> **决策来源**：2026-07-31 主人拍板 —— 缺口 C 用"战斗中调 char_gen"解决、缺口 F 用"战斗 Agent 有界裁决接口"解决、其余（A/B/D/E + 跨案例共识）打补丁。
>
> 🔗 **关联**：[`combat-system-architecture.md`](../reference/combat-system-architecture.md)（v2 现状）、[`combat-event-system-review.md`](./2026-07-30-combat-event-system-review.md)（审查报告）、[ADR-11/19/20/28/29](../../AGENTS.md)

---

## 0. 结论速览

**v3 架构方向正确**（收拢控制流 / 原子提交 / 受限 EffectIntent / DiceTape 可重放），数值严谨性确实强于 v2。但提案目前是**骨架级**——EffectIntent 只是分类大纲，schema 字段 / ReactionWindow 清单 / closed RuleKey 内容 / 跨边界协议全部留白。5 个真实样本全部判 🟡 部分能，卡点都不是写法问题，而是 6 类系统性缺口。

**好消息**：6 类缺口里 4 类是工程补丁（schema/window/RuleKey/跨边界），1 类用 char_gen 战斗中调用解决，1 类用战斗 Agent 有界裁决接口解决。**不需要推翻 v3 方向，也不需要重写**——补完这批补丁，v3 能 hold 住 5 场 + 覆盖绝大多数玩法。

---

## 1. 评估方法

### 1.1 案例选取

从 24 场战斗样本中，按"稀有压测机制"精确定位 5 场，每场专门压测 v3 EffectIntent 词汇表里最刁钻的一个 intent：

| 场 | 强度 | 回合 | 压测 intent | 稀有机制（样本行号） |
|---|---|---|---|---|
| 07 | 713 | 7 | PreventDeath | 濒死免死（诺娅 HP→1+击飞，行 1315）+ 生机重燃解除濒死（行 1561/2225） |
| 06 | 505 | 5 | SpawnOrDespawn | 召唤 2 食尸鬼持续 3 回合（行 1190-1193）+ 概率召狼（行 695-697） |
| 24 | 316 | 3 | Schedule（反射） | 虚数反弹反伤（行 131/270/471/767）+ 复活背景（行 45） |
| 13 | 290 | 4 | Permission | 时间暂停+禁忌之门（行 1436/1615/1860） |
| 09 | 253 | 4 | Override RuleKey | 概念崩坏强制濒死（行 821/981）+ 认知剥夺判胜（行 1086-1116） |

### 1.2 脑测维度

每个子 agent 必须落到实机：给出 CombatCommand 序列、代表性技能/物品的 EffectAutomaton 伪代码、战斗流程时间线（phase → ReactionWindow → intent → DiceTape → DomainEvent），再列架构执行问题。

---

## 2. 5 场判定一览

| 场 | 判定 | 最致命卡点 |
|---|---|---|
| 07（濒死免死） | 🟡 部分能 | `damage.preview` window 缺失 → 格挡（受击后改伤害）表达不出 |
| 06（召唤物） | 🟡 部分能 | 召唤物"下轮才进先攻" vs 原版"当回合参战"（样本打脸）+ 定时消失无表达 + 概率召唤抢骰子 |
| 24（反伤+复活） | 🟡 部分能 | 反伤缺 `isReaction` 标记会被误扣攻击槽 + 反射 depth 熔断策略完全空白 |
| 13（时间暂停） | 🟡 部分能 | "暂停敌方攻势"=grantActionSlot 语义造假（≠冻结敌方）+ "奇迹"开放性塞不进 closed 词汇 |
| 09（概念抹杀） | 🟡 部分能 | 认知剥夺"状态→判胜"无终局规则（HP 5472 没清空，战斗不结束）+ FP 跨边界原子性 |

---

## 3. v3 胜场（5 个 agent 一致认可，应保留）

以下机制 v3 比 v2 **更严谨**，能干净复现，RFC 不动：

- 普通攻击 / 8 步伤害管线 / 集群修正×1.5 / 范围结算 min(范围上限, 剩余数)
- buff 施加与到期 tick / 精神伤害减免（精×0.8%）
- 意图对抗失败降级 / 战意崩溃→处决保底
- 多段连击（÷N 再 ×N）
- **DiceTape 顺序消费**对齐原版骰池语义（v2 emitChain 里脚本可能 Math.random，不可重放）
- **FP/HP/MP 同一原子提交**（v2 里 FP 走 vars_update 单独事务，崩溃会不一致）
- intent batch 原子范围 + 非法整批拒绝但不取消合法核心攻击
- `commandId + expectedRevision` 串行化、拒绝 stale、零状态变化零骰子消费

**v3 实机写法通用模式**（5 场常规部分都跑通）：

```ts
automaton "技能/物品名" {
  subscribe: "ReactionWindow"        // damage.before / check.hit / collect_mods / unit.beforeDown / damage.after
  trigger: { 条件 AST }
  read: ctx.snapshot                  // 只读 immutable，不改共享对象
  return intent batch: [              // 受限 EffectIntent，原子范围
    SpendResource(...), Outcome.DealDamage(...),
    ApplyStatus(...), ScheduleIntent(...), ...
  ]
}
```

与 v2 的差异：v2 用 `scripts[]` + `$event.on` + handler 改共享 params；v3 用声明式 automaton + 订阅 typed window + 返回 intent batch（内核验证后解释），**不再有 `modifyHp()` / `nextTurn()` / 任意 JS**。

---

## 4. 6 类系统性缺口 + 决策

### 缺口 A：ReactionWindow 清单不全（响应式战术动作表达不出）

- **现象**：07 场格挡（受击 487 已算出 → 插入格挡 → 改成 97），需要"伤害算出未提交"的预览 window。提案只列了 `damage.after`（结算后改不了）。
- **影响**：格挡 / 招架 / 闪避反应这类核心战术动作全卡死。
- **决策**：✅ **打补丁** —— 新增 `damage.preview` typed window（见 §5.4）。

### 缺口 B：EffectIntent schema 字段缺失

- **现象**：
  - 07 场 `DealDamage` 缺 `damageType:'true' + bypass[]` → 真实伤害被装备减免/DR 误减
  - 24 场 `DealDamage` 缺 `isReaction/doesNotConsumeSlot` → 反伤被误扣攻击槽
  - 06 场 `SummonUnit` 缺 `duration` + `joinTiming` → 召唤物定时消失 + 当回合参战表达不出
  - 09 场 `ApplyStatus` 对抗缺 divinity 加成；`AddModifier` 缺 `scope`（连击每发 vs 整体）
- **决策**：✅ **打补丁** —— 扩展 EffectIntent schema（见 §5.3）。

### 缺口 C：不变量 vs 原版玩法语义冲突 —— ⚠️ 拆分处理

> 主人原方向："战斗中调用一次 char_gen"。本喵瞄严谨拆解后，三个子项归属不同：

| 子项 | 归属 | 处理 |
|---|---|---|
| 召唤物"当回合参战" vs v3 "下轮才进先攻" | **真·C** | ✅ **char_gen 战斗中调用**（见 §5.1）—— 新单位生成归 AI，参战时机由 char_gen 产出的单位定义声明 |
| 反伤豁免攻击槽 | 实为 B | ✅ 归 schema 补丁（`isReaction` 字段豁免不变量①） |
| PreventDeath 改 v2 死亡红线 | 实为 D | ✅ 归 RuleKey Override（`death.threshold` + divinity≥法则级） |

**只有"战斗中新增单位 + 参战时机"这块走 char_gen 方案**。反伤/复活不是"新单位生成"问题，归各自 schema/RuleKey 补丁。

### 缺口 D：closed RuleKey 覆盖不全（概念级 / 终局 / 特殊判定）

- **现象**：
  - 09 场 🔴最致命：认知剥夺造成 **0 伤害**，靠"施加认知丧失状态→判永久失能→判胜"，但 HP 5472 没清空。v3 终局 RuleKey 只有 `HP≤0` 和 `战意溃逃`，**没有 forceTerminal** → 战斗不结束，卡死。
  - 09 场：概念崩坏强制濒死反扑（无视 HP 阈值），morale RuleKey 没 forceState override。
  - 13 场：时间暂停只能 grantActionSlot 给己方，**无法冻结敌方 action 槽** → "暂停时间"语义造假。
  - 09 场：divinity 差值压制表只覆盖穿透/DR（Step3/7），状态对抗/意图对抗没覆盖。
- **决策**：✅ **打补丁** —— 预置关键 closed RuleKey（见 §5.5）。

### 缺口 E：跨边界（战斗态↔存档态）原子性未设计

- **现象**：
  - 06/09 场：FP 是**存档级元货币**（SaveProfile，ADR-22），v3"所有变化同一原子提交"在 SaveProfile 边界没设计。战斗中途崩溃，已扣的 800FP 幂等怎么保证？FP 余额预检查哪个权威？
  - 13 场：RequestChoice 中断恢复期间，代价扣费何时落库（中途退出扣不扣？）不明。
- **决策**：✅ **打补丁** —— FP 跨边界协议（见 §5.6）。

### 缺口 F：开放性创意塞不进 closed 词汇 —— ✅ 战斗 Agent 有界裁决接口

- **现象**：
  - 13 场：禁忌之门"代价换奇迹"——奇迹是剧情级开放性（妲丽安瞬间收容幻书），EffectIntent 全是战斗内维度，没有"跨战斗推进剧情"的 intent。
  - 09 场：认知剥夺"褫夺存在概念"——能表达 ApplyStatus，但"状态→判胜"闭环要终局判定。
- **决策**：✅ **接口留给战斗 Agent** —— 用 v3 提案已有的 `RequiredInput.BoundedAdjudication`，战斗 Agent 自己判开放性效果，内核只验证边界（见 §5.2）。符合 ADR-11。

---

## 5. 关键技术设计（补丁详案）

### 5.1 char_gen 战斗中调用机制（解缺口 C 的"召唤物当回合参战"）

**问题**：v3 不变量①"召唤物下轮才进先攻" vs 原版样本（行 1202-1209）"当回合参战"。

**方案**：召唤物 = 新单位生成 = 创造性逻辑 → 归 char_gen Agent（ADR-11）。战斗内核只负责"把 char_gen 产出的单位插进战场"。

**接口设计**：

```ts
// v3 新增 RequiredInput 类型
type RequiredInput =
  | PlayerCommand
  | EffectChoice
  | BoundedAdjudication
  | BeginOutput
  | CharGenRequest          // 🆕 战斗中生成新单位

// SpawnUnit intent 触发时，若召唤物模板未预置（AI 创造性召唤），
// 内核暂停 dispatch，发起 CharGenRequest
type CharGenRequest = {
  prompt: { 种族/层级/定位/来源物品/召唤者意图 }
  constraints: { divinity上限, 属性预算, 持续回合数? }
}

// char_gen Agent 返回的单位定义（扩展）
type SummonedUnitDefinition = {
  /* 原有 char_gen 字段：姓名/属性/HP/MP/SP/技能/装备/... */
  combatParticipation: {
    joinTiming: 'this_round_tail' | 'next_round_head'   // 🆕 参战时机由 AI 判定
    duration?: { rounds: number }                        // 🆕 定时消失
    actionEconomy: 'full' | 'partial' | 'no_action'     // 🆕 本轮行动预算
  }
  divinity: number
}
```

**语义**：
- 内核**默认**召唤物 `next_round_head`（保不变量①纯洁）
- 但 char_gen 可声明 `this_round_tail`（原版语义：亡灵/即战力召唤）——**参战时机是创造性判定**（取决于召唤物性质），归 AI
- 战斗面板在 CharGenRequest 期间显示"召唤中…"，char_gen 返回后插入先攻序列尾部

**时序**：char_gen 是异步 AI 调用，dispatch 同步推进到 `CharGenRequest` 暂停（和 BeginOutput 一样是 RequiredInput），不存 Promise。这和 v3 的 dispatch 模型兼容。

**ADR-11 对齐**：单位属性/参战时机/持续时间 = 创造性（char_gen）；插入先攻/扣血/到期移除 = 确定性（内核）。

### 5.2 战斗 Agent 有界裁决接口（解缺口 F 的奇迹/概念抹杀）

**问题**：奇迹/概念抹杀是开放性创意，硬塞 EffectIntent 会破坏 v3 封闭性，也表达不了。

**方案**：明确 v3 提案已有的 `RequiredInput.BoundedAdjudication` 语义用于"开放性创意效果的有界裁决"。战斗 Agent 自己判创造性，内核只验证边界。

**接口设计**：

```ts
// 战斗 Agent 在 ReactionWindow 遇到"无法用标准 intent 表达的创意效果"时
// 提交 ProposedAdjudication（不是 ProposedEffectPlan，强调"裁决"而非"效果"）
type ProposedAdjudication = {
  effectDescription: string                    // 自然语言效果描述（如"认知丧失→永久失能"）
  divinity: number                             // 神性优先级（内核验证是否够压目标）
  verifiableBounds: {                          // 🆕 可验证边界 —— 内核只验这部分
    targetLegal: boolean
    numericalRange?: { min, max }              // 数值影响范围
    invariantCompliant: InvariantCheck[]       // 是否违反 5 不变量
  }
  requestedRuleOverride?: ClosedRuleKeyHandle  // 如 forceTerminal / freezeSlot
  reason: string                               // 裁判理由（供审计/回放）
}

// 内核流程
function evaluateAdjudication(p: ProposedAdjudication): AdjudicationResult {
  // 1. 验证边界（不验证创造性）
  if (!p.verifiableBounds.targetLegal) return Reject('目标非法')
  if (p.divinity < target.divinity) return Reject('神性不足')
  if (!p.verifiableBounds.invariantCompliant.every(Boolean)) return Reject('违反不变量')
  // 2. 边界通过 → 执行（产 DomainEvent）
  return Execute({ ruleOverride: p.requestedRuleOverride, narrative: p.effectDescription })
}
```

**用例**：
- **09 场认知剥夺**：Agent 判"认知丧失→目标永久失能→判胜"，提交 `ProposedAdjudication(requestedRuleOverride: terminal.forceTerminal, divinity: 6, reason: "概念宕机")`。内核验证 divinity≥法则级 且目标确有"认知丧失"状态 → 执行终局。
- **13 场禁忌之门奇迹**：Agent 判"奇迹触发，妲丽安收容幻书"，提交 `ProposedAdjudication(effectDescription: "强制收容幻书", divinity: 7, verifiableBounds: {...})`。内核验证边界 → 产 `MiracleTriggered` DomainEvent 投影给 Story Agent 展开。

**ADR-11 对齐**：奇迹是否触发 / 概念抹杀是否成立 = 创造性判定（Agent）；数值边界 / 不变量 / divinity = 确定性（内核）。战斗内核不背开放性创意的锅。

### 5.3 EffectIntent schema 扩展（解缺口 B）

```ts
// DealDamage 补字段
interface DealDamage {
  /* 原有 */
  damageType: 'physical' | 'energy' | 'mental' | 'true'    // 🆕 'true' 在 8 步管线短路 Step3-7
  bypass?: ModifierSlot[]                                  // 🆕 真伤绕过 equip_bonus/crit/dr/attribute_reduce
  isReaction?: boolean                                     // 🆕 反射伤害标记
  doesNotConsumeSlot?: boolean                             // 🆕 豁免不变量①槽位统计（reaction 用）
  rootChainId?: string                                     // 🆕 反射链根动作
  depth?: number                                           // 🆕 反射深度
}

// SummonUnit 补字段（与 §5.1 char_gen 协同）
interface SummonUnit {
  /* 原有 */
  duration?: { rounds: number }                            // 🆕 定时消失
  joinTiming: 'this_round_tail' | 'next_round_head'       // 🆕 参战时机
}

// AddModifier 补 scope
interface AddModifier {
  scope: 'whole_action' | 'per_hit' | 'per_target'        // 🆕 连击每发 / 整体 / 每目标
}

// ApplyStatus 对抗加 divinity 加成（见 §5.5 divinity 泛化）
```

### 5.4 新增 typed ReactionWindow（解缺口 A）

明确 v3 的 typed ReactionWindow 完整清单（提案只列了部分）：

| Window | 时机 | 典型用途 |
|---|---|---|
| `round.open` / `round.close` | 回合开/闭 | buff tick |
| `initiative.before` / `initiative.after` | 先攻掷骰前后 | 改先攻 |
| `turn.open` / `turn.close` | 单位回合开/闭 | 行动预算 |
| `action.declared` | 战术动作声明 | 道具/格挡/移动 |
| `check.intent` / `check.hit` | 意图对抗 / 命中检定 | 检定修正 |
| `collect_attacker_mods` / `collect_defender_mods` | modifier 收集 | 装备声明 |
| **`damage.preview`** 🆕 | **伤害算出未提交** | **格挡/招架/闪避反应（RequestChoice）** |
| `damage.compute` | 伤害管线 Step1-8 | 真伤注入、反伤基准读取 |
| `damage.after` | 伤害结算后 | 反伤 Schedule、状态施加 |
| `unit.beforeDown` | HP 即将≤0 | PreventDeath、复活 |
| `morale.before` / `morale.after` | 战意判定前后 | forceState override |
| `settlement.before` | 终局结算 | EXP/FP 幂等 |

**关键**：`damage.preview` 允许返回 `RequestChoice` 触发 `RequiredInput.EffectChoice`，支持响应式战术动作。只有装备了反应类 automaton 的单位才触发暂停，避免每次受击都打断节奏。

### 5.5 closed RuleKey 扩充清单（解缺口 D）

预置以下 closed RuleKey（每个独立 schema/scope/权限/divinity/merge policy）：

| RuleKey | 用途 | Override 选项 | divinity 门槛 |
|---|---|---|---|
| `morale.forceState` | 概念崩坏等强制濒死反扑 | `{ state: '濒死反扑', ignoreHpThreshold: true }` | ≥法则级 |
| `terminal.forceTerminal` | 概念级终局（非 HP 清空判胜） | `{ reason: string }` | ≥法则级 |
| `action.freezeSlot` | 时间暂停冻结敌方槽 | `{ targetId, slotType, rounds }` | ≥法则级 |
| `death.threshold` | PreventDeath 复活 | `{ alive: true, hp: percent }` | ≥法则级（显式修订 v2 红线） |

**divinity 差值压制表泛化**：从"只在穿透/DR（Step3/7）"扩展到状态对抗 / 意图对抗：

```
状态对抗 / 意图对抗时：
  攻方 divinity 高于守方 → 攻方对抗检定获加值（或守方获减值）
  差 1 级 ±20%，差 2 级 ±40%，... 差 ≥5 级 ±100%（必成/必败）
```

**v2 死亡红线显式修订**：v2 §7.1「HP≤0=死亡不可协商」→ v3 声明「由 `unit.beforeDown` + `death.threshold` Override 提供合法出口，仅 divinity≥法则级 可激活，HP 恢复与 ConsumeCharge 同原子提交」。这是对 v2 红线的**显式修订**，不是违反。

### 5.6 FP 跨边界协议（解缺口 E）

```ts
// 战斗开始：FP 快照进 CombatState（本地权威副本）
interface CombatState {
  /* 原有 */
  resourceSnapshots: {
    FP: number                    // 🆕 从 SaveProfile 快照，战斗内权威
    /* HP/MP/SP 本来就在 */
  }
}

// 流程
openCombat():
  1. 从 SaveProfile 读 FP → 写入 CombatState.resourceSnapshots.FP
  2. 战斗内所有 FP 操作对副本，走原子提交（不变量④）

settlement(combatId, settlementId):
  1. 计算 FP 净变动 = snapshot.FP - 初始 FP
  2. 按 combatId + settlementId 幂等 diff 回 SaveProfile（不变量⑤）
  3. journal 记 FP diff 的 idempotencyKey 防重放

// 战斗中途退出（非终局）：FP 不落库（保护玩家）
```

**FP 余额预检**：Command 校验"FP≥800"直接读 CombatState.resourceSnapshots.FP，不实时查 SaveProfile。

### 5.7 DiceTape 分通道（跨案例共识，06/24 场独立提出）

**问题**：概率召唤、反伤命中的 d20 和普通命中 d20 共用 cursor 会**错位整场后续命中结果**，replay 无法对齐样本。

**方案**：DiceTape 拆多通道，各通道独立 cursor：

```ts
interface DiceTape {
  channels: {
    initiative:    D20Stream     // 先攻骰
    attackHit:     D20Stream     // 命中/伤害骰
    statusContest: D20Stream     // 状态对抗骰
    procCheck:     D20Stream     // 概率触发判定骰（召唤/特效）
    intentCheck:   D20Stream     // 意图对抗骰
  }
}
// BeginOutput 注入时按通道预分配（如各 12 颗 = 60 颗）
```

**反伤/概率召唤**的骰子走对应通道（procCheck / attackHit），不互相污染。

---

## 6. 反射（反伤）专项规范（解 24 场多个卡点）

24 场反伤暴露了多个细节，单独成节：

```ts
interface ReflectionPolicy {
  MAX_REFLECTION_DEPTH: 2        // 反射→反射→终止（符合"反弹一次"直觉）
  overflowStrategy: 'mutual_cancel'  // 超限 → EmitNarrativeCue("反射湮灭") + 双方反伤互相抵消
  baseRule: 'root_chain'         // depth≥2 的反伤基准固定取 rootChain 原始伤害（不放大）
}
```

- **反伤 intent**：`DealDamage(damageType: 'true', isReaction: true, doesNotConsumeSlot: true, rootChainId, depth)`
- **反伤窗口**：`damage.after`，用 `ScheduleIntent(delay: 0)` 排入**同一原子提交**的子结算（不排到后续 Command）
- **反伤必须掷骰**：样本行 139/278/479/775 反伤都有优势 d20 命中检定，`hitPolicy.consumeDice` 必须显式声明，走 `attackHit` 通道
- **反伤基准**：取 `rawDamage.preReduction`（Step1 初始伤害），非最终伤害 —— `damage.after` snapshot 必须暴露三档伤害值（preReduction / postStep6 / final）
- **owner 语义**：反伤 automaton 的 owner 标"被反伤保护的角色 id"，反伤 DealDamage 的 targetId 进管线前强制校验在场，离场则 silently drop

---

## 7. 补丁优先级与落地路线（建议）

### 7.1 优先级

| 优先级 | 补丁 | 解缺口 | 工作量 |
|---|---|---|---|
| **P0** | DealDamage schema（isReaction/bypass/damageType/rootChainId/depth） | B | 小 |
| **P0** | `damage.preview` typed window + RequestChoice | A | 中 |
| **P0** | DiceTape 分通道 | 共识 | 中 |
| **P0** | FP 跨边界协议（快照 + 幂等 diff） | E | 中 |
| **P0** | `terminal.forceTerminal` + `morale.forceState` RuleKey | D | 中 |
| **P1** | char_gen 战斗中调用（CharGenRequest + SummonedUnitDefinition） | C | 大 |
| **P1** | BoundedAdjudication 接口 | F | 中 |
| **P1** | SummonUnit duration/joinTiming + AddModifier scope | B | 小 |
| **P1** | 反射专项规范（depth 熔断 + 基准取值 + owner） | 24场 | 中 |
| **P2** | `action.freezeSlot` + `death.threshold` RuleKey | D | 小 |
| **P2** | divinity 压制表泛化到状态/意图对抗 | D | 中 |

### 7.2 建议落地顺序（在 v3 提案 M0-M5 基础上调整）

> 前提：先按 v3 提案 M0 做 contract tests + DiceTape + replay harness，**但 DiceTape 必须一开始就分通道**（§5.7），否则后续返工。

1. **M0**：原版协议 contract tests + 分通道 DiceTape + replay harness
2. **M1**：基础攻击 + 战术动作 + 行动槽 + 回合 + 状态 tick + 唯一终局（含 `forceTerminal`）
3. **M2**：runner CompatibilityAdapter（feature flag v2/v3）
4. **M3**：modifier/buff 编译为 EffectProgram + **DealDamage 完整 schema + `damage.preview` window**
5. **M3.5**：🆕 char_gen 战斗中调用（CharGenRequest）+ BoundedAdjudication 接口
6. **M4**：反伤/免死/召唤/延迟效果/法则技能压力测试（用本报告 5 场样本做 contract）
7. **M5**：v3 默认启用 + 保留 v2 回滚 → 删除旧接线

---

## 8. 开放问题（待主人后续确认）

1. **char_gen 战斗中调用的性能/节奏**：char_gen 是异步 AI 调用，可能 3-10 秒。战斗中召唤物生成要等这么久，玩家体验如何？是否要预生成召唤物池（常见召唤物提前 char_gen 好，战斗中只选）？
2. **BoundedAdjudication 的滥用风险**：战斗 Agent 会不会把所有不好表达的效果都走裁决接口，绕过 EffectIntent？要不要设"裁决接口只能由 divinity≥法则级 触发"的硬门槛？
3. **反伤 MAX_REFLECTION_DEPTH=2 是否合适**：样本只有单次反伤（处刑人/查加尔都没反伤被动），缺乏"反伤对反伤"实证。需要在 M4 补一个双方反伤的极端压测样本。
4. **第24场复活机制未实证**：样本里理查德全程未濒死，复活（AM0288）只是背景设定。PreventDeath 复活的 HP 恢复比例 / ConsumeCharge 充能数 / divinity 门槛需要在 M4 单独压测。
5. **DiceTape 分通道后 BeginOutput 的骰子预算**：60 颗按通道怎么分（initiative/attackHit/statusContest/procCheck/intentCheck 各多少）？需要统计真实样本的通道消耗比例。

---

## 9. 附录：5 场关键机制行号索引

供后续实现时交叉核对（文件均在 `reference/战斗对话样本/`）：

| 场 | 文件 | 关键行号 |
|---|---|---|
| 07 | `第07场_行332-352_2026-03-28_强度713.md` | 濒死免死 1315/2011；生机重燃 1561/2225；格挡 2109/2338；真实伤害 2153/2419；9 次骰池续杯 |
| 06 | `第06场_行274-286_2026-03-27_强度505.md` | 召唤食尸鬼 1190-1193/1347-1350；概率召狼 695-697/922-924；召唤物当回合参战 1202-1209；FP 消耗 1287 |
| 24 | `第24场_行1596-1600_2026-04-16_强度316.md` | 反伤（虚数反弹）131/270/471/767；复活背景 45；反伤掷骰 139/278/479/775；反伤取原伤害1130 136 |
| 13 | `第13场_行784-798_2026-04-03_强度290.md` | 危机响应机制 1436/1615/1860；禁忌之门 1803-1839；玩家选择 1845；FP 2400 过载 1456-1460 |
| 09 | `第09场_行431-438_2026-03-30_强度253.md` | 概念崩坏强制濒死 821/981；真理火球 876/946-967；认知剥夺判胜 1086-1116/1279-1299；濒死反扑 1019/1238 |

---

## 变更记录

| 日期 | 变更 | 作者 |
|---|---|---|
| 2026-07-31 | 初版：5 真实样本压测 + 6 类缺口分析 + 补丁 RFC（C 用 char_gen、F 用 BoundedAdjudication、其余打补丁） | Claude（5 opus 子 agent 并发脑测 + 总指挥汇总） |
