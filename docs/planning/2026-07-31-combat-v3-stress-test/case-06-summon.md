# 压测案例 ②：SpawnOrDespawn 召唤物（第 06 场）

> 📌 本文件是 v3 真实样本压测的详细脑测报告。v3 提案核心速览见 [README](./README.md)。
> 源样本：[`reference/战斗对话样本/第06场_行274-286_2026-03-27_强度505.md`](../../../reference/战斗对话样本/第06场_行274-286_2026-03-27_强度505.md)（5 回合，强度 505）
> 压测 intent：**SpawnOrDespawn + SummonUnit**（+ 概率召唤的 DiceTape 通道竞争）
> 判定：🟡 **部分能**（召唤机制 v3 有 3 个结构性缺口，不补丁无法忠实复现）

---

## 1. 案例摘要

5 回合、强度 505 的多单位遭遇战（官道 6 狼集群 → 巢穴头狼+8 狼集群 → 死灵召唤介入 → 法则打断翻盘）。核心压测 v3 的**召唤机制**。

**关键机制点（带行号）**：

- 🔥 **召唤物定时消失**：《死灵之书-残篇》消耗 100FP 召唤 2 只腐化食尸鬼，HP 350，**状态标注"召唤物(持续 3 回合)"**（行 1190-1193、1287、1347-1350）。v3 的 SummonUnit 要求"新单位本轮无行动，下轮才进先攻"，但本案还有"3 回合后自动消失"。
- 🔥 **概率召唤**：霜爪座狼头狼"唤狼嗥"—— 给周围座狼上[狂暴]（攻击+15%/受伤+10%/持续 4 回合，行 924），**有概率**把隐藏/未参战狼群召唤至战场（行 697）。同时涉及 ApplyStatus + 概率性 SpawnOrDespawn（d20≥阈值）。
- ⚠️ **关键观察**：样本里召唤物**召唤当回合就进了先攻序列并执行攻击**（行 1202-1209：食尸鬼 A 骰 8 得 14、B 骰 3 得 9，序列含二者；行 1387-1392 食尸鬼同回合扑头狼）。而 v3 提案明文"新单位本轮无行动，下轮才进入先攻" —— **v3 约束与原版叙事事实正面冲突**。
- 集群目标、范围攻击多目标掷骰、buff 多回合到期、FP 大额消耗（100+150+800=1050 FP）。

---

## 2. v3 复现方案

### 2.1 CombatCommand 序列

| 回合            | Command                              | 成本                     | 骰耗（DiceTape）               | 说明                                |
| --------------- | ------------------------------------ | ------------------------ | ------------------------------ | ----------------------------------- |
| R1-init         | `BeginOutput`→隐式 initiative        | —                        | 3×d20（敏捷+骰）               | 火元素13/菲19/理26                  |
| R1 菲希芙       | `UseSkill(暗影沼泽)`                 | attack×1，180 MP         | 2d20(优势取高6)+1d20(束缚对抗) | 1566 伤+束缚 2 回合                 |
| R1 理查德       | `UseSkill(星屑连袭)`                 | action×1，280 MP，200 FP | 3×1d20(连击三发)               | 8535 伤+1/3 减员                    |
| R1 火元素       | `UseSkill(熔岩投掷)`                 | attack×1，250 SP         | 2d20(劣势取低9)+1d20(灼烧对抗) | 296 伤+灼烧                         |
| R2 理查德       | `UseSkill(星屑连袭·核心)`            | attack×1，280 MP         | 1d20(命中10)+1d20(意图)        | 2236 伤致死，全歼                   |
| R2-结算         | `combat_end`                         | —                        | —                              | EXP+700/FP+150                      |
| **R2末★召唤**   | **`DeclareAction(死灵之书-残篇)`**   | **action×1，FP100**      | 0（静态生成）                  | **SummonUnit×2 + 召唤时限 buff**    |
| R2 理查德       | `DeclareAttack(灼热射线)`            | attack×1，MP100          | 2d20(劣势取低3)                | 失手                                |
| R2 头狼         | `DeclareAttack(凛风吐息, 区域4目标)` | attack×1，MP450          | 4 套劣势骰 + 迟缓对抗          | 食尸鬼 B 被秒杀(500伤)              |
| R3 理查德       | `DeclareAttack(深渊的低语)`          | attack×1，FP150          | 2d20(劣势取低3)                | 精神 800，失手，渊化不触发          |
| R3 菲希芙       | `DeclareAction(战术脱离/逃跑)`       | action×1                 | 1d20(敏捷对抗)                 | 脱战成功                            |
| R3 头狼         | `DeclareAttack(霜碎利爪, 暴击)`      | attack×1，SP300          | 2d20(优势取高20)               | 理查德 HP -490，濒死 → 触发危机响应 |
| **R4 法则打断** | `DeclareAttack(重力崩塌断章)`        | attack×1，**FP800**      | 2d20(意图)+2d20(命中优势取20)  | 真实 2000，意图降级，2600 伤        |
| R4 战意         | 内核自动 morale check                | —                        | 1d20(4)<12                     | 头狼溃逃                            |
| R4-结算         | `EndCombat`+`Settlement`             | —                        | —                              | 幂等 EXP/FP                         |

> 召唤物时限 3 回合在本案**从未真正到期**（食尸鬼 B 回合 2 被秒杀，A 在头狼溃逃后战斗结束）—— 是未被样本验证的代码路径，脑测只能推演。

---

### 2.2 物品/技能脚本怎么写（v3 实机写法）

#### ① 《死灵之书-残篇》（召唤 2 食尸鬼，持续 3 回合，消耗 100FP）★核心★

难点是**"持续 3 回合后自动消失"**。`SummonUnit` 本身只表达"召唤"动作，**定时消失必须靠组合**（ApplyStatus 时限 buff + round.close tick + onExpire→Despawn），或靠 ScheduleIntent。

```ts
automaton "necronomicon_fragment" {
  on window: "action.declared"
  trigger: { item: "死灵之书-残篇", intent: "summon" }
  read: {
    caster: ctx.actor,
    fpCurrent: ctx.resource(caster, "FP"),
    summonDef: SUMMON_TEMPLATE["腐化食尸鬼"]   // HP350/SP200/力5敏6体5/层级1
  }
  return intent batch: [
    // 1. 扣 100 FP
    SpendResource({ target: caster, kind: "FP", amount: 100 }),
    // 2. 召唤 2 只食尸鬼
    SummonUnit({
      template: summonDef, side: "player", count: 2,
      joinsInitiativeNextRound: true,          // v3 不变量（但与样本冲突，见 Q1）
      ownerId: caster.id, sourceId: "死灵之书-残篇",
      instanceTag: "summoned"
    }),
    // 3. 定时消失：给每只召唤物挂"召唤时限"buff（★ v3 词汇缺口，见 Q2）
    ApplyStatus({
      target: "<each_summoned_unit>",
      statusId: "死灵之书-残篇.召唤时限",
      duration: { rounds: 3 }, layers: 1,
      onExpire: SpawnIntent({ kind: "Despawn", target: "<self>" })   // ⚠ 嵌套 intent，提案未明确
    }),
    EmitNarrativeCue({ kind: "summon_flavor", text: "骨骼摩擦的刺耳声响..." })
  ]
}
```

⚠️ 立刻暴露 v3 词汇缺口：`SummonUnit` 没内建 `duration`/`expiresIn`；`onExpire: SpawnIntent(Despawn)` 嵌套 intent 提案未明确 ReactionWindow 能否返回"延迟 intent"；更干净是用 `ScheduleIntent`，但提案没写它的 trigger 能否挂"第 3 回合 round.close"。

#### ② 头狼"唤狼嗥"（狂暴 buff + 概率召唤）★骰子竞争★

```ts
automaton "alpha_howl" {
  on window: "action.declared"
  trigger: { skill: "唤狼嗥", actor: "霜爪座狼头狼" }
  read: {
    caster: ctx.actor,
    nearbyWolves: ctx.combatants(side: "enemy", tag: "霜爪座狼"),
    hiddenPackMembers: ctx.reserveUnits(template: "霜爪座狼"),
    rngCursor: ctx.diceCursor
  }
  return intent batch: [
    SpendResource({ target: caster, kind: "MP", amount: 600 }),
    // 狂暴 buff（攻击+15%/受伤+10%/4回合）
    ApplyStatus({
      target: nearbyWolves,
      statusId: "唤狼嗥.狂暴",
      mods: [
        { kind: "百分比", path: "outgoingDamage", value: +0.15 },
        { kind: "百分比", path: "incomingDamage", value: +0.10 }
      ],
      duration: { rounds: 4 }, divinity: 0
    }),
    // ★概率召唤——抢骰子★
    SummonUnit({
      template: "霜爪座狼", side: "enemy", count: "<conditional>",
      condition: {
        roll: { kind: "d20", cursor: rngCursor, consume: 1 },   // ★抢 DiceTape 下一颗
        threshold: 15,
        onSuccess: { count: 1, joinsInitiativeNextRound: true }
      },
      sourcePool: hiddenPackMembers
    })
  ]
}
```

⚠️ 概率召唤抢的 d20 和"60-d20 顺序消费用于命中/伤害"的 cursor **是同一条 DiceTape**，会**错位后续所有命中检定**（见 Q3）。

#### ③ 普通攻击（霜爪座狼·霜爪撕裂）—— 对照基准

```ts
automaton "frostclaw_tear" {
  on window: "turn.attackDeclared"
  trigger: { skill: "霜爪撕裂", actor: "<any 霜爪座狼集群>" }
  read: { attacker: ctx.actor, defender: ctx.target, baseAttr: ctx.attr(attacker, "力") }
  return intent batch: [
    SpendResource({ target: attacker, kind: "SP", amount: 100 }),
    Outcome({
      kind: "DealDamage", damageType: "physical",
      baseFormula: "(力8×10×2.8 + 120 + 0)",
      intent: "常规", hitMode: "advantage",
      diceRequest: { count: 2, sides: 20, purpose: "attack_hit" },
      multiHit: { count: 3, reason: "集群HP100%→次数3" }   // ⚠ v3 Outcome 无现成字段
    }),
    ApplyStatus({
      target: defender, statusId: "霜爪撕裂.冻伤",
      condition: { hitRating: ">=暴击" },
      mods: [{ kind: "DoT", path: "HP", perRound: -30 }, { kind: "检定", path: "敏捷", value: -1 }],
      duration: { rounds: 2 }, divinity: 0
    })
  ]
}
```

普通攻击 v3 跑得通（命中/伤害/暴击/状态全走内核 window）。唯一小坑是 `multiHit`（集群攻击次数 3）在 v3 Outcome 无现成字段，可能要靠 Schedule 拆 3 次或内核内建"集群多段"。

---

### 2.3 战斗流程时间线

#### 时间线 A：召唤入场（回合 2 末，DeclareAction 死灵之书）

```
phase: UnitTurnOpen(理查德, 攻击槽已用/动作槽可用)
  ↓ [C10: DeclareAction(死灵之书-残篇)]
dispatch(C10):
  ├─ ReactionWindow: "action.declared"
  │    └─ 死灵之书 automaton 读 immutable snapshot
  │       ├─ 检查 FP≥100 ✅
  │       └─ 返回 [SpendFP(100), SummonUnit×2, ApplyStatus(召唤时限,3回合)×2]
  ├─ Intent 校验：SummonUnit template 合法 ✅
  ├─ DiceTape：★本轮召唤不消费骰子★（静态生成）
  ├─ 原子提交 nextState:
  │    ├─ CombatState.units += [食尸鬼A, 食尸鬼B]
  │    ├─ 食尸鬼A/B.initiativeOrder = null      ← 本轮不进先攻（v3 不变量）
  │    ├─ 食尸鬼A/B.status += [召唤时限:3回合]
  │    └─ 理查德.FP -= 100
  ├─ DomainEvents: [UnitSummoned(A), UnitSummoned(B), ResourceSpent(FP,100), StatusApplied(召唤时限)]
  └─ requiredInput: PlayerCommand（理查德动作槽已用，攻击槽待消费）

phase: RoundClose
  ├─ "round.close" ReactionWindow
  │    └─ 召唤时限 buff.tick → 剩余 3→2（B 已死，只 tick A）
  └─ DomainEvents: [StatusTicked, RoundClosed]

phase: Round3 Open
  ├─ initiative.before window
  │    └─ ★食尸鬼A 本轮首次进入先攻★（dice: 敏6+骰1-3迟缓=4）
  └─ 先攻序列: 理查德→菲希芙→头狼→普通狼集群→食尸鬼A
```

#### 时间线 B：3 回合后召唤物消失（推演，本案未触发）

```
phase: Round4 RoundClose（第 3 次 round.close tick）
  ↓ [round.close ReactionWindow]
  └─ 食尸鬼A "召唤时限" buff 剩余 1→0 → 触发 onExpire
     └─ onExpire 产出 SpawnIntent(Despawn, target=食尸鬼A)
        ↓ 内核解释 Despawn：
        ├─ 从 CombatState.units 移除食尸鬼A
        ├─ 若食尸鬼A 此刻正卡在 UnitTurnOpen → ★必须先强制 UnitTurnClose 再移除★
        └─ DomainEvents: [UnitDespawned(食尸鬼A), StatusExpired(召唤时限)]
```

---

## 3. 架构执行问题清单

### 🔴 Q1：召唤物"本轮无行动"约束 vs 案例事实冲突

**现象**：v3 提案明文"新单位本轮无行动，下轮才进入先攻"（不变量①）。但样本行 1202-1209 显示召唤物**召唤当回合就进先攻序列并执行攻击**（食尸鬼 A 骰 8 得 14、B 骰 3 得 9；行 1387-1392 食尸鬼扑头狼）。
**根因**：v3 的"本轮无行动"是为维护不变量①和先攻顺序确定性。但《命定之诗》原版召唤语义是**当回合即参战**（样本证据），v3 单方面修改了原版召唤规则。
**建议**：放宽约束 —— `SummonUnit` 加 `joinsInitiativeThisRound: boolean` 字段，召唤时掷一颗 d20 即时插入当前回合先攻序列尾部。或按主人决策走 **char_gen 战斗中调用**，由 char_gen 产出的单位定义声明参战时机（见交接地图 §char_gen 方案）。**原版当回合参战是设计意图不是 bug，v3 不该为不变量优雅牺牲玩法表达力**。

### 🔴 Q2："持续 3 回合后消失"在 v3 词汇表无干净表达

**现象**：`SummonUnit`/`SpawnOrDespawnIntent` 只表达"召唤"动作，**没有 `duration`/`expiresIn`**（行 1191/1348 明确要求）。
**根因**：v3 把"召唤"和"召唤物生命周期"拆成两件事，但只给了前者 intent，后者要靠 ApplyStatus+tick+onExpire→Despawn 拼，而 onExpire 能否返回延迟 intent 提案未写；ScheduleIntent 更合适但 trigger 语义能否挂"第 N 回合 round.close"未明确。
**建议**：**最小补丁**——给 `SummonUnit` 加内建 `duration: {rounds:N}`，内核自动在 round.close 维护倒计时，到期自动产 `UnitDespawned` DomainEvent。召唤物生命周期由 `ActiveEffectIndex` 统一管理。**这是结构性缺口，v3 现词汇表不足以表达"定时召唤物"这个极常见机制**。

### 🟡 Q3：概率召唤抢骰子，会错位命中检定

**现象**：唤狼嗥"有概率召唤"需掷 1 颗 d20 做 d20≥阈值 判定。v3 规定所有随机数来自同一条 DiceTape，60 颗顺序消费（不变量③）。这颗"召唤判定骰"和后续命中/伤害骰**共用 cursor**，会**错位整场后续命中结果**，replay 无法对齐样本。
**根因**：原版骰子池是给"正文输出"用的（60 颗，命中/伤害/状态对抗顺序取），多一个"召唤判定"抢骰子。回合 2 骰池 `[5,11,6,11,3,8,14,16,1,9,...]`，Recorder 思维链里自己都在纠结索引（行 799），说明原版消费顺序本身易错，v3 再让概率召唤抢骰子错位更严重。
**建议**：**DiceTape 分通道**（attackHit / statusContest / procCheck / initiative 各独立 cursor）。概率召唤的 d20 判定走 procCheckChannel，不污染命中 cursor。

### 🟡 Q4：召唤物算不算"在场参战者"？行动槽怎么算？expire 时卡在 UnitTurnOpen 怎么办？

**建议**：规定 Despawn 是**原子提交**，强制 UnitTurnClose 后移除，槽位作废（被强制清除非主动跳过，不违反"跳过也消费"）。召唤物行动槽和永久单位一致（1 攻击+1 动作）。DomainEvent 区分 `UnitDespawned`(时限到期)/`UnitDowned`(战死)/`UnitDismissedByOwner`(主动解除)。

### 🟡 Q5：FP 大额消耗 vs v2 存档级元货币的持久化衔接

**现象**：本案理查德消耗 FP100+150+800=**单场 1050 FP**（行 1287/1572/1909）。FP 是 v2 存档级元货币（SaveProfile，ADR-22），不是战斗内资源。
**根因**：v3 `SpendResource({kind:"FP"})` 战斗内原子提交扣减，但真正 FP 持久化要等 settlement 才落库。战斗中途崩溃/重开，已扣 FP 怎么办？
**建议**：FP 走"战斗内 provisional 扣减 + 终局 settlement 一次性幂等 commit 到 SaveProfile"双层模型。`SpendResource({kind:"FP"})` 标 `deferredCommit: true`，与 HP/MP/SP（战斗内即效）区分。详见交接地图 §FP 跨边界。

### 🟡 Q6：多目标范围攻击的骰子消费顺序未定义

**现象**：回合 2 头狼凛风吐息打 4 目标，劣势骰 `[6,3]/[14,7]/[17,5]/[18,12]`（行 1225-1238）—— 8 颗连续消费。v3 没明确"一次范围攻击多目标"的消费顺序。
**建议**：RFC 明确"范围攻击按目标顺序，每目标连续消费所需骰数"，写进 contract test。

### 🟢 Q7：集群修正×1.5 和范围结算×min(目标数,容量) —— v3 能 hold 住

**建议**：v3 内核 DealDamage 解释器直接复用 v2 `combat-damage.ts` 纯函数，`Outcome` intent 携带 `targetType: "cluster"`，内核自动套用集群修正+范围结算。提案明确保留 combat-damage。

### ⚪ Q8：危机响应机制（法则打断）vs v3 的 RequiredInput —— v3 优势点

回合 3 末理查德濒死触发危机响应（行 1875-1878），回合 4 玩家选"打开"→ 借史诗幻书翻盘。v3 的 `RequiredInput.EffectChoice` 正好表达"等待玩家选择是否开禁忌之门"。危机响应 = 头狼暴击导致理查德 HP≤0 时，内核不立即产 `UnitDowned`，先 PreventDeath 暂停 → waitFor: EffectChoice → 玩家选择 → 若选"打开"则提交 DeclareAttack 翻盘。**v3 表达得很干净**。

---

## 4. 判定

**🟡 部分能**。v3 对"普通攻击/范围伤害/buff/濒死保护/法则打断"这类**主流机制表达得更干净**（Q7、Q8 是 v3 优势），但本案例核心压测点——**召唤机制——v3 现词汇表有三个结构性缺口**（Q1 召唤当回合参战被禁、Q2 定时消失无干净表达、Q3 概率召唤抢骰子错位），加 FP 存档级持久化衔接未定义（Q5），**不补丁就无法忠实复现召唤叙事**。

**最小补丁建议**（按优先级）：

1. **【P0 必做】** `SummonUnit` 加 `duration:{rounds:N}` + `joinsInitiativeThisRound:boolean`，内核内建召唤物生命周期管理。同时解 Q1、Q2。或按主人决策走 char_gen 战斗中调用方案。
2. **【P0 必做】** DiceTape 分通道（attackHit/statusContest/procCheck），概率召唤 d20 走 procCheckChannel。解 Q3。
3. **【P1 应做】** RFC 明确 FP 走 `deferredCommit` 双层模型。解 Q5。
4. **【P1 应做】** 定义范围攻击多目标骰子消费顺序契约，写进 contract test。解 Q6。
5. **【P1 应做】** 定义 Despawn 时召唤物卡在 UnitTurnOpen 的强制清除语义。解 Q4。

**关键提醒**：Q1（召唤当回合参战 vs v3"下轮才进先攻"）**不是写法问题，是 v3 单方面修改了原版召唤语义**，样本白纸黑字证明原版即回合参战。这是**设计取舍**需主人拍板——已决策走 char_gen 战斗中调用方案（由 char_gen 声明参战时机）。
