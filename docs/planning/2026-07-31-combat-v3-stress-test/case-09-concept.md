# 压测案例 ⑤：Override 概念抹杀+FP 大额消耗（第 09 场）

> 📌 本文件是 v3 真实样本压测的详细脑测报告。v3 提案核心速览见 [README](./README.md)。
> 源样本：[`reference/战斗对话样本/第09场_行431-438_2026-03-30_强度253.md`](../../../../reference/战斗对话样本/第09场_行431-438_2026-03-30_强度253.md)（4 回合，强度 253）
> 压测 intent：**Override（closed RuleKey）+ SpendResource（FP）**
> 判定：🟡 **部分能**（数值严谨性强于 v2，但"认知剥夺状态→判胜"无终局规则 + FP 跨边界原子性）

---

## 1. 案例摘要

理查德（第三层级法师，FP 46480）单挑 A 级幻书残卷「被啃噬的求知欲」—— 4 回合内通过"起源炼金造物投喂 → 真理火球轰击（200FP/发×3）→ 硬吃濒死精神反扑 → 800FP 认知剥夺收尾"结束战斗。

**关键机制点（带行号）**：
- 起源炼金造"异界冗余信息黑盒"（稀有，固伤 800+逻辑死锁词条）投喂，造成 800 伤害+认知宕机状态（被豁免）（行 280-295）。
- 🔥 **真理火球**：200FP+400MP，火球术威力+1500 真伤，分 3 段/单段投送（行 494-514、636-651、730-751、946-967）。
- 🔥 Boss **认知切割**（精神伤害，意图"抹杀/概念抹除"）：意图对抗失败降级常规，造成 1523 精神伤害（行 992-1011），尝试施加"认知剥落"（被豁免）。
- 🔥 **战意判定：HP 5472/15000=36%，30% 阈值未达成，但因"概念崩坏"强制进入濒死反扑**（行 979-985）。
- 🔥 **认知剥夺（《无面者狂想曲》，800FP）**：基础伤害=0，意图对抗失败降级，最终**伤害 0**，但状态对抗成功 → 施加"认知丧失" → 战斗判定胜利"永久性概念宕机"（行 1086-1116、1279-1299）。

**⚠️ 重大实情发现（影响评估的关键）**：本场的"认知剥夺"在原文数值层面**不是直接抹杀目标存在的 HP 删除**，而是：①伤害=0 ②靠施加一个"认知丧失"状态（持续 1 回合）③靠 AI 据此判定"目标已失去行动逻辑 → 战斗胜利"。HP 5472 根本没清空。这跟"概念级抹杀"的设想有偏差——它更接近一个**带极高叙事权重的状态施加 + 终局判定**。

---

## 2. v3 复现方案

### 2.1 CombatCommand 序列

| # | 回合 | Command | 成本 | revision | DiceTape 消费 |
|---|------|---------|------|----------|--------------|
| C1 | R1 | `BeginOutput`（注入 60×d20） | — | r0→r1 | — |
| C2 | R1 | `TacticalAction(理查德, craft→异界黑盒)` | 动作槽 1 | r1→r2 | 1×d20（制作检定 d20=9） |
| C3 | R1 | `Attack(理查德→残卷, 投掷异界黑盒, intent=常规)` | 攻击槽 1 | r2→r3 | 2×d20（劣势取低 13,14→13） |
| C4 | R1 | `Attack(残卷→理查德, 吞噬本能, 本能反击)` | 残卷攻击槽 1 | r3→r4 | 0（吞食触发道具，无检定） |
| C5 | R2 | `BeginOutput` | — | r4→r5 | — |
| C6 | R2 | `Attack(理查德→残卷, 星屑连袭+焚烬之理, intent=猛烈)` | 攻击槽 1，**SpendResource(FP=200, MP=280)** | r5→r6 | 3×d20（19,19,14 多段）+1（先攻9） |
| C7 | R2 | `TacticalAction(残卷→理查德, 概念重组反噬, 施加认知扭曲)` | 残卷动作槽 1 | r6→r7 | 0 |
| C8 | R3 | `BeginOutput` | — | r7→r8 | — |
| C9 | R3 | `TacticalAction(理查德, 移形幻影, 自身位移+闪避buff)` | 动作槽 1，SpendResource(MP=420) | r8→r9 | 1×d20（先攻9） |
| C10 | R3 | `Attack(理查德→残卷, 真理·火球术+焚烬之理, intent=猛烈)` | 攻击槽 1，**SpendResource(FP=200, MP=400)** | r9→r10 | 1×d20（19） |
| C11 | R4 | `BeginOutput` | — | r10→r11 | — |
| C12 | R4 | `Attack(理查德→残卷, 真理·火球术+焚烬之理, intent=猛烈)` | 攻击槽 1，**SpendResource(FP=200, MP=400)** | r11→r12 | 1×d20（19）+1（先攻18） |
| C13 | R4 | **Morale/战意触发**：内核检测 HP 5472/15000，**Override(closedRuleKey=濒死反扑)** → 残卷 `Attack(残卷→理查德, 认知切割, intent=抹杀→概念)` | 残卷攻击槽 1，SpendResource(MP=800) | r12→r13 | 2×d20（意图对抗 攻方2+守方9）+1（命中15） |
| C14 | R5 | `BeginOutput` | — | r13→r14 | — |
| C15 | R5 | `Attack(残卷→理查德, 概念冲撞, intent=常规)` | 残卷攻击槽 1 | r14→r15 | 1×d20（先攻10）+1（命中16） |
| C16 | R5 | **`Attack(理查德→残卷, 认知剥夺+无面者狂想曲, intent=抹杀→概念)`** | 攻击槽 1，**SpendResource(FP=800)** | r15→r16 | 2×d20（意图对抗 攻方20+守方2）+1（命中8）+1×d20（状态对抗理查德13+残卷12） |
| C17 | R5 | `Settlement`（内核终局，幂等 settlementId） | — | r16→terminal | 0 |

> 每回合 BeginOutput 单独是 RequiredInput，战斗消耗 5 批 60×d20（与原文 5 个骰子池声明对齐）。

---

### 2.2 物品/技能脚本怎么写（v3 EffectAutomaton 伪代码）

#### (1) 《焚烬之理》真理火球（FP 消耗两段式）

**关键点**：原文是"召唤幻书(200FP) → 释放火球术(400MP)"两步，被合并成**一个攻击 Command**。v3 下也必须是 1 个 Command（否则消耗两个行动槽，原文只消耗 1 攻击槽）。

```ts
automaton "焚烬之理·真理火球" {
  window: "damage.before"
  triggers: { skillId: "火球术", tag: "焚烬之理·附魔" }
  intents: [
    // ① FP 消耗（SpendResource）
    SpendResource({
      target: attacker, resource: "FP", amount: 200,
      idempotencyKey: "焚烬之理.召唤.${commandId}"      // ⚠ FP 存档级元货币，见 Q4
    }),
    // ② MP 消耗
    SpendResource({ target: attacker, resource: "MP", amount: 400 }),
    // ③ 附加 1500 真伤（焚烬之理核心效果），作为 Outcome 声明，仍走伤害窗口
    Outcome.DealDamage({
      target: defender, amount: 1500, type: "真实",      // 真实伤害无视减免（Step5 系数0）
      divinity: 5,                                       // 微弱法则级（史诗幻书，法则火）
      sourceTag: "焚烬之理", rootActionId: ctx.actionId
    }),
    // ④ 火球术能量伤害（1310基础→1110减免后）由核心 attack.request 跑 Step1-8
    EmitNarrativeCue({ flavor: "真理之火·概念穿透" })
  ]
}
```

火球术能量伤害部分由核心攻击管线结算，automaton 只负责"额外塞进去的 1500 真伤"。多段分割（/3）由核心管线 Step2 处理。

#### (2) 《无面者狂想曲》认知剥夺（概念抹杀 — 本场最关键）

**关键发现**：原文这个技能**伤害=0**，靠"状态施加成功 → AI 判定胜利"。所以它不是 DealDamage 主导，而是 ApplyStatus 主导。

```ts
automaton "无面者·认知剥夺" {
  window: "damage.after"   // 在伤害结算后施加状态
  triggers: { skillId: "认知剥夺", tag: "概念抹杀" }
  intents: [
    // ① FP 消耗 800
    SpendResource({
      target: attacker, resource: "FP", amount: 800,
      idempotencyKey: "无面者.认知剥夺.${commandId}"
    }),
    // ② 核心：施加"认知丧失"状态（带神性优先级）
    //    divinity 标"完整法则(6)"
    Outcome.ApplyStatus({
      target: defender, status: "认知丧失",
      duration: { turns: 1 }, divinity: 6,
      sourceTag: "无面者狂想曲",
      // 状态对抗由内核在 ApplyStatus 窗口跑：攻方智力18+修订3+d20 vs 守方精神18+d20
      contest: {
        attackerRoll: { stat: "智力", bonus: 3 },       // +d20
        defenderRoll: { stat: "精神" }                   // +d20
      }
    }),
    // ③ 伤害=0（核心攻击伤害本身为 0，因为意图对抗失败降级且基础 0），不需声明 DealDamage
    EmitNarrativeCue({ flavor: "概念消融·灰白波纹" })
  ]
}
```

**"概念抹杀走哪条路"的回答**：
- **不走 Override RuleKey**：不是"修改内核某已有规则"，而是施加新状态。
- **不走 ProposedEffectPlan**：ApplyStatus + divinity + 状态对抗这套组合 v3 词汇已能表达。
- **走 DealDamage(特殊标签)？不是**：原文伤害本来就是 0，主路径是 ApplyStatus。
- **divinity 标法**：标 `完整法则(6)`，让"认知丧失"在状态对抗时压过 Boss（A 级幻书≈微弱法则5~完整法则6）。理查德认知剥夺"褫夺存在概念"应略高于 Boss 位格，对抗成功（34 vs 30）。
- **真正决定胜负的不是状态本身**，而是"状态施加成功 → AI 判定残卷永久失能 → 触发终局"。见 Q2。

#### (3) Boss 认知切割（精神伤害，意图抹杀）

```ts
automaton "残卷·认知切割" {
  window: "damage.before"
  triggers: { skillId: "认知切割", requiresMorale: "濒死反扑" }
  intents: [
    SpendResource({ target: attacker, resource: "MP", amount: 800 }),
    // 精神伤害（基础 1700 = 智力20×10×4.0 + 900）
    // 意图=抹杀→概念，但意图对抗失败降级常规（×1.0 系数）
    Outcome.DealDamage({
      target: defender, amount: "core_formula", type: "精神",   // Step5 走 精×0.8%
      divinity: 5, intent: { level: "抹杀", adversarial: true }
    }),
    Outcome.ApplyStatus({
      target: defender, status: "认知剥落", divinity: 5,
      contest: { /* 幻书20+15 vs 理查德13+15 → 失败 */ }
    })
  ]
}
```

精神伤害 Step5 走 `(精)×0.8%`，理查德精13→10.4% 减免，1700×0.896=1523。**v3 的 8 步管线 Step5 仍认精神伤害类型**（v2 §9.4 已定义，v3 没动伤害公式）。这里没问题。

---

### 2.3 战斗流程时间线

#### 时间线 A：真理火球（FP 消耗）—— 回合 3 C10

```
phase: UnitTurnOpen (理查德)
  → ReactionWindow: turn.open
  → EffectAutomaton 收集（装备"奥术导师法袍"声明 +12% 能量伤害 modifier）

Command C10: Attack(理查德→残卷, 火球术, intent=猛烈, 附魔焚烬之理)
  → 校验：攻击槽1可用 ✓ | MP≥400 ✓ | FP≥200 ✓（FP 查询见 Q4）
  → ReactionWindow: check.intent → 常规意图无需对抗，直接过
  → ReactionWindow: damage.before
     → EffectAutomaton「焚烬之理·真理火球」返回 intents:
        [SpendResource(FP=200), SpendResource(MP=400),
         DealDamage(1500,真实,div=5), NarrativeCue]
     → 装备 modifier: 法袍 +12% 能量（百分比类，进 Step6 系数）
  → DiceTape.consume(1) → d20=19
  → 公式结算（核心 8 步）:
     Step1: 18×10×4.0 + 400 + 190 = 1310 能量
     Step2: 单段（火球术非多段，不分割；星屑连袭才÷3）
     Step3-4: 装备减免 0
     Step5: 能量减免 (精18+智20)×0.4% = 15.2% → 1310×0.848 = 1111
     Step6: ×1.0(有效) × 1.12(法袍) = 1243
     Step6a: + 1500 真伤（焚烬之理 Outcome，不走减免）
     Step7-8: 0
     合计: 2743
  → ReactionWindow: damage.after（无反伤订阅）
  → 原子提交（一次）:
     - 残卷 HP 10958 → 8215
     - 理查德 MP -400, FP -200
     - 残卷 MP -50（法力燃烧额外效果）
  → DomainEvent: [DamageApplied(2743), ResourceSpent(FP=200),
                  ResourceSpent(MP=400), StatusApplied(法力燃烧)]
```

**关键观察**：FP 扣减（-200）和 HP 扣减、MP 扣减在**同一原子提交**。这是 v3 强项——v2 里 FP 是 SaveProfile 字段要靠 vars_update 单独走，战斗中扣 FP 和扣 HP 不在同一事务，崩溃恢复可能不一致。v3 要求"所有变化同一原子提交"，**但 FP 跨越战斗态↔存档态边界**，见 Q4。

#### 时间线 B：认知剥夺（概念抹杀）—— 回合 5 C16

```
phase: UnitTurnOpen (理查德, HP 1628/4042=40%, 鼻血状态)
  → ReactionWindow: turn.open

Command C16: Attack(理查德→残卷, 认知剥夺, intent=抹杀→概念, 武器=无面者狂想曲)
  → 校验：攻击槽1可用 ✓ | FP≥800 ✓ (46480-200×3=45880 ≥ 800)
  → ReactionWindow: check.intent
     → 意图对抗（抹杀=概念级，难度20）:
        攻方: 3层×5 + d20(20) = 35
        守方: 3层×5 + d20(2) + 难度20 = 37
        DiceTape.consume(2) → [20, 2]
        结果: 35 < 37 → 失败 → 降级为常规（×1.0）
  → ReactionWindow: damage.before
     → EffectAutomaton「无面者·认知剥夺」返回 intents:
        [SpendResource(FP=800), ApplyStatus(认知丧失,div=6,contest), NarrativeCue]
     → 注意：没有 DealDamage intent（基础伤害 0）
  → DiceTape.consume(1) → d20=8（命中检定，"勉强0.8"，但伤害 0×0.8=0）
  → 公式结算: 基础伤害 0 → 最终伤害 0
     → 残卷 HP 5472 → 5472（不变）
  → ReactionWindow: status.apply（ApplyStatus 的对抗窗口）
     → 状态对抗:
        攻方: 智力18 + 真理修订3 + d20(13) = 34
        守方: 精神18 + d20(12) = 30
        DiceTape.consume(2) → [13, 12]
        divinity 比较: 认知丧失 div=6（完整法则）vs 残卷本体 div=5（微弱法则，A级幻书）
        → 6 > 5，压制生效（差1级，按 v2 §13.1c 差值压制表，差1级压制20%——
          但这里是状态施加不是穿透/DR，压制表是否适用存疑，见 Q5）
        → 对抗成功 34 > 30 → 施加成功
  → 原子提交:
     - 残卷 HP 不变
     - 理查德 FP -800
     - 残卷 获得"认知丧失"状态（1 回合）
  → DomainEvent: [ResourceSpent(FP=800), StatusApplied(认知丧失,div=6)]

→ 攻击槽1耗尽 → UnitTurnClose

→ 🔴 这里发生关键的事：内核并不会自动判胜利
   "认知丧失"状态本身在 v3 里只是"持续 1 回合、失去行动逻辑"的状态
   残卷 HP 还有 5472，没有触发 PreventDeath/UnitDowned
   → 战斗不会自然结束
   → 需要战斗 Agent 在叙事层判定"残卷已成死物"→ 提 BoundedAdjudication(forceTerminal)
   → 或者需要一个额外的"概念宕机=死亡"规则（见 Q2）
```

---

## 3. 架构执行问题清单

### 🟡 Q1："概念崩坏导致濒死反扑"需要 Override RuleKey 改濒死阈值
**现象**：原文行 979-985，残卷 HP 5472/15000=36%，"30% 阈值未达成，但由于概念崩坏，本能进入濒死反扑"。这是"概念级状态强制触发濒死行为，无视 HP 阈值"。
**根因**：v3 的战意/濒死是 closed RuleKey（基于 HP 阈值+战斗类型+d20 判定，v2 §9.5）。要让"概念崩坏"绕过 HP 阈值强制触发濒死反扑，必须用 `OverrideIntent` 改这个 closed RuleKey——但提案说 Override 只能"在 closed RuleKey 上选择内核已支持的替代规则"。问题：**内核有没有"无视 HP 阈值强制触发濒死"这个替代规则？** 若只有标准阈值规则，"概念崩坏→强制濒死"表达不出来。
**建议**：内核 morale RuleKey 需支持 override 选项 `{ forceMoraleState: "濒死反扑", ignoreHpThreshold: true }`，由"概念崩坏"状态在 `morale.before` 窗口通过 OverrideIntent 注入。closed RuleKey 扩容，属"内核已支持的替代规则"范畴，应该可行——前提是设计时预置了 forceState 选项。

### 🔴 Q2："认知剥夺"的胜负判定缺口 —— 最致命
**现象**：原文认知剥夺伤害=0，靠施加"认知丧失"状态 → AI 判定"永久性概念宕机" → 战斗胜利。残卷 HP 还有 5472。
**根因**：v3 的终局触发（UnitDowned/CombatEnded）是 closed RuleKey，标准是 `HP ≤ 0` 或 `战意溃逃`。"施加一个状态 → 目标失去行动能力 → 判胜利"这条路径在 v3 里**没有对应的终局规则**。状态本身只是"持续 1 回合"，1 回合后状态消失，残卷 HP 还在，战斗应该继续——但叙事上它已经是"死物"了。
这是 v3 closed RuleKey 体系的**真实缺口**：能处理"HP 清空死亡"和"战意溃逃"，但处理不了"非致死状态导致的目标永久失能"。
**建议**（按主人决策，走 BoundedAdjudication）：要么①内核终局 RuleKey 支持 override `{ forceTerminal: true, reason: "概念宕机" }`（由高 divinity 状态触发）；要么②明确允许战斗 Agent 在判定后提交 `ProposedAdjudication(requestedRuleOverride: terminal.forceTerminal)`（内核验 divinity≥法则级 且目标确有该状态 → 执行终局）。**这是 v3 在概念级战斗上的真实软肋，必须补 forceTerminal**。

### ⚪ Q3：真理火球/认知剥夺的"召唤幻书+释放"两段式 —— 已解决
**现象**：原文是"召唤《焚烬之理》(200FP) → 释放火球术(400MP)"两段。
**判定**：v3 下必须是**1 个 Command、消耗 1 个攻击槽**。两个 SpendResource intent（FP+MP）在同一 EffectAutomaton 的 intent batch 里原子提交。跟 v3 设计完全吻合（intent batch 原子范围）。✅ 拆成 2 个 Command 会消耗 2 个行动槽，违反原文（理查德每回合只打一发）。

### 🔴 Q4：FP 跨战斗态↔存档态的原子提交 + 崩溃恢复幂等
**现象**：FP 是 v2 里的**存档级元货币**（SaveProfile 字段，ADR-22）。本场消耗 200×3+800=1400 FP。v3 要求"所有 HP/资源/状态变化同一原子提交"。
**根因**：v3 的 CombatState 是战斗内权威，但 FP 真源在 SaveProfile（持久化层）。v3 提案说"StateManager 保留为持久化 adapter，战斗内每步写 journal，终局再幂等提交"。问题：
- **战斗中途崩溃**：认知剥夺扣了 800FP，但战斗没结束就崩了。恢复时 FP 扣减幂等怎么保证？`idempotencyKey` 在 journal replay 时能识别"这 800FP 已扣"，但 SaveProfile 写入是终局提交，中途崩溃时 SaveProfile 没扣 FP，重跑会再扣一次——除非 journal 也记录"已对 SaveProfile 应用的 diff"。
- **FP 不足预检**：800FP 认知剥夺前，内核查 FP 余额。FP 不在 CombatState（在 SaveProfile），v3 Command 校验"FP≥800"怎么查？
**建议**：FP 这种存档级资源需①战斗开始时 FP 快照进 CombatState（本地权威副本），战斗内所有 FP 操作对副本进行，终局一次性 diff 回 SaveProfile；②journal 记录 FP diff 的 idempotencyKey 防重放。详见交接地图 §FP 跨边界。

### 🟡 Q5：divinity 差值压制表在"状态施加"场景的适用性
**现象**：v2 §13.1c 的 divinity 差值压制表（差1级压20%防御…差≥5级100%无视）明确定义在"穿透/DR"阶段（Step3/7）。但认知剥夺是**状态施加**，不走伤害管线。
**根因**：认知剥夺的"认知丧失"div=6，残卷本体 div=5，对抗检定 34 vs 30 已成功。但"高 divinity 状态压过低 divinity 目标"在 v3 里怎么体现？提案说"概念免疫通过带神性优先级的 effect-acceptance rule 拒绝匹配标签"——这是反向（高 divinity 拒绝低 divinity 效果）。正向"高 divinity 状态强制施加给低 divinity 目标，无视豁免"在提案里**没有明确规则**。原文靠纯对抗检定成功（34>30），没靠 divinity 压制。但若残卷精神更高、对抗失败呢？v3 缺一个"divinity 差值补偿对抗结果"的规则。
**建议**：divinity 优先级机制从"只在穿透/DR"扩展到"状态对抗/意图对抗"——高 divinity 攻方在对抗检定时获加值（或低 divinity 守方获减值）。提案"神性优先级"语义需明确定义在所有冲突窗口。

### ⚪ Q6：精神伤害类型减免 —— 无问题
**判定**：v3 没动 8 步管线和伤害类型减免公式（提案明确保留 combat-damage.ts 纯函数）。精神伤害=精13×0.8%=10.4% 减免，1700×0.896=1523。✅ 完全复现。认知剥夺伤害=0 也不走减免（本身就是 0）。"认知剥落"状态施加被豁免是对抗失败，不是伤害减免。

### 🟡 Q7：起源炼金造物投喂（道具内置伤害触发）
**现象**：行 280-295，理查德投掷"异界冗余信息黑盒"，残卷"吞噬本能"吞下后触发道具内置 800 伤害+逻辑死锁状态（对抗失败）。
**根因**："道具被目标吞噬后触发内置效果"的特殊机制。v3 里投掷道具是 `Attack(投掷)`，但伤害来源是"道具被吞食后内部触发"，不是标准攻击检定。原文意图判定"无需判定"（道具必中被吞噬）。
**建议**：v3 的 Attack command 支持 `{ attackType: "thrown_consumable", bypassHitCheck: true }`，道具 EffectAutomaton 在 `damage.before` 声明 DealDamage(800,真实)+ApplyStatus(认知宕机, contest)。v3 能表达（Outcome.DealDamage+ApplyStatus 组合），但"吞噬触发"时序需内核支持"目标主动消费道具"command——不在标准 Attack/TacticalAction 里，可能需扩展。边界场景，不致命。

---

## 4. 判定

**🟡 部分能**。

**能顺畅复现的部分**（约 70%）：FP 消耗两段式技能（SpendResource batch 原子提交，1 Command 1 行动槽）、精神伤害减免（8 步管线保留）、真理火球的能量+真伤双轨（核心管线+automaton Outcome）、多段分割、意图对抗降级——这些 v3 都能干净复现，甚至比 v2 更严谨（FP/HP/MP 同一原子提交）。

**真实卡点**（约 30%）：
1. 🔴 **Q2 认知剥夺的胜负判定缺口**——"施加状态 → 目标永久失能 → 判胜利"在 v3 closed RuleKey 体系里没有对应终局规则。这是最致命的：案例的收尾机制本身在 v3 里表达不全。按主人决策走 BoundedAdjudication（战斗 Agent 判 + forceTerminal RuleKey）可解。
2. 🔴 **Q4 FP 跨边界原子性**——FP 是存档级元货币，v3"同一原子提交"在战斗态↔存档态边界没明确设计，崩溃恢复幂等存疑。
3. 🟡 **Q1 概念崩坏强制濒死**——需 morale RuleKey 预置 forceState override 选项。
4. 🟡 **Q5 divinity 压制表只覆盖穿透/DR**——状态施加/意图对抗场景的 divinity 优先级语义缺失。

**最小补丁建议**：
1. **终局 RuleKey 扩容**：内核终局规则增加 override 选项 `forceTerminal(reason, divinity)`，允许高 divinity 状态（如"认知丧失"div=6）施加成功后于 `unit.beforeDown` 或新增窗口强制触发终局。或按主人决策走 BoundedAdjudication。这是 v3 处理概念级战斗的**必备能力**，不是可选增强。
2. **FP 跨边界方案**：战斗开始 FP 快照进 CombatState 作本地权威，终局 diff 回 SaveProfile；journal 记 FP diff 的 idempotencyKey 防重放。RFC 明确这个边界协议。
3. **morale RuleKey 预置 forceState 选项**：让"概念崩坏"等高 divinity 状态能 override 战意阈值。
4. **divinity 优先级泛化**：把差值压制表从"穿透/DR"扩展到状态对抗/意图对抗（高 divinity 攻方在对抗检定获加值）。

**对总指挥的客观结论**：v3 在"数值严谨性"上确实强于 v2（FP/HP/MP 原子提交、骰池可重放、意图对抗归内核），70% 的案例流程能干净跑通。但 v3 的 closed RuleKey + UnsupportedCapability 升级机制在**概念级战斗的终局判定**上存在真实缺口——案例最核心的"认知剥夺褫夺存在概念"这一下，v3 能表达"施加状态"但表达不了"状态 → 永久失能 → 判胜"的完整闭环。这不是"独一无二技能塞不进词汇表"的问题（认知剥夺本身能用 ApplyStatus 表达），而是"closed RuleKey 没有覆盖非致死终局"的问题。按主人决策走 BoundedAdjudication 可解。**建议 v3 落地前补齐终局 RuleKey 的概念级覆盖，否则概念级 Boss 战都会卡在"状态施加成功但战斗不结束"的尴尬态**。
