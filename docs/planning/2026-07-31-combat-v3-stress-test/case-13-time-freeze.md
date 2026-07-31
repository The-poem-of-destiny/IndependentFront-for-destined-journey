# 压测案例 ④：Permission 时间暂停+禁忌之门（第 13 场）

> 📌 本文件是 v3 真实样本压测的详细脑测报告。v3 提案核心速览见 [README](./README.md)。
> 源样本：[`reference/战斗对话样本/第13场_行784-798_2026-04-03_强度290.md`](../../../reference/战斗对话样本/第13场_行784-798_2026-04-03_强度290.md)（4 回合，强度 290）
> 压测 intent：**Permission（grantActionSlot）+ RequestChoice**
> 判定：🟡 **部分能**（常规阶段顺畅，但"暂停时间"语义造假 + "奇迹"开放性塞不进 closed 词汇）

---

## 1. 案例摘要

典型"流程顺畅但终局靠机制兜底"战斗：理查德+菲希芙打 3 只熔岩火元素集群（前 2 回合顺风碾压），然后冲进第六层级守护骸骨的绝对高温领域夺幻书，被【黄金之握】打出致死伤害后触发妲丽安【危机响应机制】（时间暂停 + 询问禁忌之门）。

**关键机制点（带行号）**：
- **常规阶段**（行 784-798 R1-R2）：菲希芙【暗影沼泽】控场 + 理查德【星屑连袭】配合《焚烬之理》真实伤害收割（连击×3 每发+1500 真伤，行 111、427）。
- 🔥 **危机机制触发条件**（行 1105、1436、1860）："理查德遭遇**濒死/被束缚/不可战胜强敌**时，暂停敌方攻势，询问是否开启禁忌之门以代价换取奇迹"——**纯 AI 主观判定的触发条件**。
- 🔥 **过载《无面者的狂想曲》**（行 1456-1460）：2400 FP + 800 MP，对抗成功剥夺认知 1 回合（保底衰减）。
- **真实伤害结算**（行 1577、1681）：环境【烈日残渣】每回合 1500 真伤无视减免 —— v2 8 步管线 Step5 真实减免=0 直接通过。
- 🔥 **致死一击 + 时间暂停**（行 1811-1839）：骸骨【黄金之握】12152 伤害，理查德 1042→0，时间"变得粘稠"，弹出选项"汝是否欲开启禁忌之门，以代价换取奇迹？"
- 玩家选 accept（行 1845）：借奇迹翻盘。

---

## 2. v3 复现方案

### 2.1 CombatCommand 序列

| 阶段 | command | 成本 | 骰耗 | 备注 |
|---|---|---|---|---|
| R1-init | `BeginOutput`→隐式 initiative | — | 3×d20 | 火元素13/菲19/理26 |
| R1 菲希芙 | `UseSkill(暗影沼泽)` | attack×1，180 MP | 2d20(优势取高6)+1d20(束缚对抗) | 1566 伤+束缚 2 回合 |
| R1 理查德 | `UseSkill(星屑连袭)` | action×1，280 MP，200 FP（焚烬之理）| 3×1d20(连击三发) | 8535 伤+1/3 减员 |
| R1 火元素 | `UseSkill(熔岩投掷)` | attack×1，250 SP | 2d20(劣势取低9)+1d20(灼烧对抗) | 296 伤+灼烧 |
| R2 理查德 | `UseSkill(星屑连袭·核心意图)` | attack×1，280 MP | 1d20(命中10)+1d20(意图) | 2236 伤致死，全歼 |
| R2-结算 | `combat_end` | — | — | EXP+700/FP+150 |
| R3（神庙内） | `UseSkill(无面者狂想曲·过载)` | action×1，800 MP，**2400 FP** | 2d20(精神对抗 6 vs 12) | 认知剥夺 1 回合 |
| R3 理查德 | `Move(冲入祭坛)` | action×1 | — | 被动触发：烈日残渣 1500 真伤 |
| R4 神庙回2 | `Sustain(按住幻书)` | action×1 | — | 环境伤害 1500 真伤 |
| R4 骸骨 | `UseSkill(黄金之握)` | attack×1，9000 SP | 2d20(优势取高19) | 12152→11666，理查德致死 ⚠️ |
| **R4 危机触发** | **（内核自动插入）** | — | — | **暂停敌方攻势 → RequestChoice** |
| R4 玩家 | `Choose(开启禁忌之门)` | — | — | 恢复 continuation |

> R3 过载幻书成本 2400 FP 是跨战斗 SaveProfile 字段，需 StateManager adapter 衔接。

---

### 2.2 物品/技能脚本怎么写（v3 实机写法）

#### 写法 A：【危机响应机制】（命定之书被动）—— 最关键

v3 提案明确："时间停止通过 `PermissionIntent(grantActionSlot)` 获得受限额外槽位，**不能修改 turn scheduler 本身**"。

但案例实际行为是：**敌方正在执行的致死攻击被冻结**（"液态黄金火焰悬停"、"骨爪定格在鼻尖几寸"）。这"冻结敌方正在进行的攻击"≠"给我方额外槽位"，两者语义有本质差别。

```ts
automaton CrisisResponse {
  trigger: ReactionWindow "damage.before"     // 在伤害 apply 前
  condition:
    // 濒死（HP 将≤0）OR 被束缚 OR AI 主观判定"不可战胜"
    snapshot.calc.projectedHpAfter(snapshot, intent) <= 0
    && target.id === "理查德"
    && owner.hasCharge("命定契约", 1)
  onTrigger(ctx): EffectIntent[] {
    // ① PreventDeath：本伤害不落地（骨爪定格）
    // ② RequestChoice：询问玩家（dispatch 中断）
    // ③ 暂停"敌方攻势"——v3 这里语义卡住，见 Q1
    return [
      { kind: "PreventDeath",
        targetId: "理查德",
        rootActionId: ctx.actionId,           // 挡掉这次黄金之握
        preserveHp: 1 },
      { kind: "RequestChoice",
        promptId: "forbidden_gate_offer",
        prompt: "汝是否欲开启禁忌之门，以代价换取奇迹？",
        choices: [
          { id: "accept", label: "开，我倒要看看你有什么挂。" },
          { id: "refuse", label: "拒绝" }
        ],
        persist: "ResolutionFrame"            // dispatch 中断保存续接点
      }
    ];
  }
}
```

**问题**：v3 的 `PreventDeath` 提案语义是"unit.beforeDown 返回一次性 replacement"（单位被击倒时救场），而案例是**伤害还没落地就被冻结**（HP 还停在 1042，没到 0 再回弹）。时序不同：PreventDeath 在 afterDown，时间冻结需要在 damage.before 拦截。v3 ReactionWindow `check.*`/`damage.*` 能挂，但"冻结敌方本次攻击整个回合剩余行为"在 intent 词汇里**找不到对应**——PreventDeath 只挡本次伤害，不挡骸骨本回合后续可能的多段/追加。

#### 写法 B：【禁忌之门·代价换奇迹】

玩家选 accept 后恢复 continuation，内核根据裁决验证"奇迹"。这里压测 v3 的开放性（按主人决策，走 **BoundedAdjudication 接口**，战斗 Agent 自己判）：

```ts
// 玩家选 accept → continuation 恢复
// 内核执行"代价换奇迹"——奇迹内容是开放性的
// v3 流程（主人决策）：战斗 Agent 提 ProposedAdjudication → 内核验证边界 → 执行

// 1. 代价（确定性，走 closed RuleKey / SpendResource）
const costIntents: EffectIntent[] = [
  { kind: "SpendResource", targetId: "理查德", resource: "FP", amount: 3000 },
  // 或永久损失：妲丽安好感 / 永久 HP 上限降低 / 命定契约耐久-1
  // ⚠️ 永久损失不在 CombatState 内，需 StateManager adapter（见 Q3）
];

// 2. 奇迹（开放性，走 ProposedAdjudication —— 主人决策的接口）
const miracleAdjudication: ProposedAdjudication = {
  effectDescription: "禁忌之门开启，妲丽安瞬间收容《熔毁的残章》",
  divinity: 7,                                // 神性优先级（内核验证是否够）
  verifiableBounds: {                          // 内核只验这部分
    targetLegal: true,
    numericalRange: { min: 0, max: 0 },        // 奇迹不造成数值伤害
    invariantCompliant: [/* 5 不变量检查 */]
  },
  requestedRuleOverride: "terminal.forceTerminal",  // 强制终局
  reason: "概念级奇迹，幻书被强制收容"
};
// 内核验证边界（不验证创造性）：
//   ✓ divinity(7) ≥ 法则级
//   ✓ 不变量未违反
//   → 执行：产 MiracleTriggered DomainEvent 投影给 Story Agent
```

**问题**：案例的"奇迹"不是固定数值（免死+伤害），而是**剧情级强制推进**（妲丽安瞬间收容幻书，绕过正常多回合收容流程）。v3 EffectIntent 词汇全是"战斗内数值/状态/行动槽"维度，**没有"跨战斗边界推进剧情"的 intent**。按主人决策，走 BoundedAdjudication 让战斗 Agent 判，内核只验边界 —— 创造性归 Agent，符合 ADR-11。

#### 写法 C：普通攻击【星屑连袭】（对照基线，v3 最能跑顺的部分）

```ts
automaton StardustBarrage {
  trigger: ReactionWindow "damage.compute"   // 8步管线 Step 6a 前
  condition: ctx.skill.tags.includes("连击")
  onTrigger(ctx): EffectIntent[] {
    const intents: EffectIntent[] = [];
    // 连击×3：每发单独命中检定（每发吃 1 颗 DiceTape d20）
    for (let i = 0; i < 3; i++) {
      intents.push({
        kind: "DealDamage",
        rootActionId: ctx.actionId,
        hitRoll: ctx.diceTape.consume(1),     // ← DiceTape cursor 推进（不变量③）
        damageType: "能量"
      });
    }
    return intents;
  }
}

// 焚烬之理（被动，配合连击）
automaton VeritasIgnis {
  trigger: ReactionWindow "damage.fixedBonus"  // Step 6a
  condition: ctx.owner.skill.tags.includes("连击") && ctx.owner.spent("FP", 200, thisRound)
  onTrigger(ctx): EffectIntent[] {
    return [{
      kind: "AddModifier",
      target: "每发连击", type: "fixed", amount: 1500, damageType: "真实",
      scope: "per_hit"                          // 🆕 连击每发（v3 需补 scope 字段）
    }];
  }
}
```

这部分 v3 跑得顺 —— 固伤 modifier + 连击单独检定 + DiceTape 顺序消费，完全匹配不变量③④。**唯一注意**：案例《焚烬之理》每发连击+1500 真伤（行 427），v3 的 AddModifier 默认"本次攻击整体加成"，需支持 `scope: "per_hit"`。

---

### 2.3 战斗流程时间线（濒死→危机响应→时间暂停→询问→玩家选择→代价→额外行动，行 1803-1839）

```
phase: UnitTurn(守护骸骨)
  ├─ ReactionWindow "turn.open"
  │    └─ 骸骨 ActiveEffectIndex: [祭坛之缚]+6抵抗 / [不灭金焱] / [烈日残渣]被动注册
  │
  ├─ Command: UseSkill(黄金之握) [attack槽×1, 9000SP]
  │    │
  │    ├─ ReactionWindow "check.attack"   ← 骸骨优势取高骰
  │    │     DiceTape.consume(2) → [8,19]取19  (行1816)
  │    │
  │    ├─ ReactionWindow "damage.compute"  ← 8步管线
  │    │     initial=14500 → 减装备2315 → 属性33 = 12152
  │    │     rating=有效(1.0) → DR×0.96 = 11666
  │    │     projectedHp = 1042 - 11666 = -10624 ≤ 0  ⚠️ 濒死触发条件达成
  │    │
  │    ├─ ReactionWindow "damage.before"   ← 🔥 危机响应被动拦截点
  │    │     condition: projectedHp≤0 && target=理查德 && 契约有充能
  │    │     ↓ 返回 [PreventDeath, RequestChoice]
  │    │     ↓
  │    │  ⛔ dispatch 同步推进暂停
  │    │     CombatState 保存 ResolutionFrame:
  │    │       - pendingIntent: 黄金之握(未提交)
  │    │       - queueCursor: damage.apply 阶段
  │    │       - executedReactions: [check.attack已完成]
  │    │       - diceCursor: 已消费[8,19]，恢复不重消费
  │    │       - commandId + expectedRevision 锁
  │    │     ↓
  │    │  requiredInput: RequestChoice(forbidden_gate_offer)
  │    │     [dispatch 返回 CombatTransition, 不提交本次伤害]
  │    │
  │    ├─ ⏸️ 等玩家输入（行 1845："开，我倒要看看你有什么挂。"）
  │    │     ↓ 玩家提交 Choose(accept)
  │    │     ↓ 内核恢复 continuation（不重跑 check.attack，不重吃[8,19]）
  │    │
  │    ├─ ReactionWindow "miracle.resolve"  ← 禁忌之门效果执行
  │    │     ↓ 战斗 Agent 提 ProposedAdjudication（见写法B）
  │    │     ↓ 内核验证边界：divinity ✓ / 目标 ✓ / 不变量 ✓
  │    │     ↓ 执行 forceTerminal + 代价扣费 + MiracleTriggered 事件
  │    │
  │    └─ 原子提交 CombatTransition
  │       DomainEvents:
  │         - DamagePrevented(理查德, 黄金之握, rootActionId)
  │         - ChargeConsumed(命定契约, 1)
  │         - ResourceSpent(理查德, FP, 3000)        ← 代价
  │         - ForbiddenGateOpened(理查德)             ← 供叙事/UI
  │         - MiracleTriggered(收容幻书)              ← 投影给 Story Agent
  │         - NarrativeCue("时间恢复")
  │
  ├─ 🔥 "暂停敌方攻势"语义问题（见 Q1）：
  │     骸骨本回合 attack 槽已消费（黄金之握），action 槽是否被冻结？
  │     v3 只能 grantActionSlot(理查德) 给额外行动，无法冻结敌方 action 槽
  │
  └─ phase 继续：理查德获 GrantActionSlot（额外行动）
       → 完成收容 → 妲丽安收书 → 战斗结束
```

---

## 3. 架构执行问题清单

### 🔴 Q1："暂停敌方攻势" v3 语义对不上——是 grantActionSlot 还是冻结敌方？
**现象**：案例行 1829-1831"时间变得粘稠……液态黄金火焰悬停……骨爪定格在鼻尖几寸"。这是**冻结敌方正在执行的动作**。但 v3 提案行 168 明确："时间停止通过 `PermissionIntent(grantActionSlot)` 获得受限额外槽位，**不能修改 turn scheduler 本身**"。
**根因**：grantActionSlot 给己方额外槽 ≠ 冻结敌方，方向相反。若骸骨这回合 attack 槽已用（黄金之握）、action 槽还没用 → 只 grantActionSlot 给理查德，骸骨 action 槽轮到时**还是会动**。这不算"暂停时间"，算"白送一回合"。案例的"暂停"是**叙事层绝对静止**（敌方完整动作链被冻结），v3 在 dispatch 同步模型里实现不了——scheduler 内核独占（提案禁止脚本调 nextTurn），脚本没法把骸骨移出本轮先攻序列。
**建议**：按主人决策，需扩一个 closed RuleKey `FreezeActionSlot(targetUnitId, slotType, rounds)`（属 OverrideIntent），让脚本能在 verify 范围内冻结敌方 action 槽。**不加这个 RuleKey，"暂停时间"是语义造假**。叙事层用 NarrativeCue 包装成"时间冻结"。

### 🔴 Q2：触发条件"不可战胜强敌"是 AI 主观判定，ReactionWindow trigger 怎么可靠识别？
**现象**：案例行 1105、1860 触发条件包括"**遭遇不可战胜强敌**"——模糊主观判定。骸骨 Lv.24 第六层级，理查德 Lv.12 第三层级，层级差 3，这算"不可战胜"吗？AI 可能判 yes，但代码不知道。
**根因**：v3 ReactionWindow trigger 是**确定性 condition AST**。"濒死"(HP≤阈值) 可判定，"被束缚"(状态查询) 可判定，但"不可战胜强敌"**没有确定性信号**。交给 AI 提 ProposedAdjudication 触发危机响应，就破坏 v3"内核独占流程不变量"——AI 能决定何时暂停时间 = AI 间接控制 scheduler。
**建议**：把"不可战胜"**降维成确定性代理信号**：层级差 ≥ N、或敌方 divinity 高于己方 ≥ M 阶、或连续 X 回合未造成有效伤害。ReactionWindow condition 写死可判定条件，AI 主观判定只用于**叙事 cue**（EmitNarrativeCue），不进 trigger。

### 🟡 Q3：RequestChoice 中断恢复 + 跨战斗代价（FP/永久损失）的 StateManager adapter 衔接
**现象**：代价可能是 2400 FP（行 1437 已用过载 2400 FP，再加禁忌之门代价更大）、或永久 HP 上限损失、或命定契约耐久。FP 是 SaveProfile 字段（跨战斗），不在 CombatState 内。
**根因**：v3 提案"StateManager 保留为持久化 adapter"+"CombatState 保存 ResolutionFrame"。但 dispatch 中断时 CombatState 只持有战斗内状态，代价结算扣 FP 需要：① CombatTransition 产出 `ResourceCostRequested(理查德, FP, 3000)` DomainEvent；② adapter 翻译成 StatePatch 提交 SaveProfile；③ adapter 提交是**异步**——若玩家禁忌之门中途取消（断线/读档），代价是否已扣？幂等性怎么保证？
**建议**：明确**代价 DomainEvent 在 CombatEnded 终局才提交**（不是 dispatch 中途），用 `combatId + settlementId` 保证幂等（不变量⑤）。代价字段在 CombatState 的 pendingSettlement 挂着，战斗结束统一提交。RequestChoice 中断恢复只动战斗内状态，不动 SaveProfile，幂等干净。详见交接地图 §FP 跨边界。

### 🟡 Q4："以代价换奇迹"的奇迹=开放性创意，v3 closed RuleKey + UnsupportedCapability 会卡死吗？
**现象**：案例"奇迹"是**强制完成幻书收容**（妲丽安瞬间把《熔毁的残章》拖入书库），剧情级强制推进，不是固定数值效果。
**根因**：v3 升级通道要求"≥2 真实技能需要、确定窗口与冲突语义、可重放、不能由现有 intent 组合表达"。**单次性奇迹不满足"≥2 真实技能需要"**——每个奇迹都是 unique 创意场景。且奇迹效果（强制收容幻书）本质**跨出战斗边界推进剧情**，v3 EffectIntent 全是战斗内维度，没有 `ForceStoryAdvance`/`CompleteLorebookCollection`。
**建议**（主人已决策）：**走 BoundedAdjudication 接口**——战斗 Agent 对"奇迹是否触发"做主观判定，提交 `ProposedAdjudication`（带 divinity + 可验证边界 + requestedRuleOverride + reason），内核验证**边界**（divinity/目标/数值范围/不变量），**不验证创造性**。验证通过 → 执行（产 MiracleTriggered DomainEvent 投影给 Story Agent）。奇迹的实际效果（收容幻书/降维打击）作为 post-combat 事件投影给 Story Agent 由叙事侧展开，**不进 EffectIntent 词汇**。这符合 ADR-11（创造性归 Prompt，确定性归 Code）。

### 🟡 Q5：dispatch 同步中断-恢复的 continuation 状态量 + commandId 串行化冲突
**现象**：危机响应触发后，CombatState 要保存 ResolutionFrame（pendingIntent + queueCursor + executedReactions + diceCursor + commandId + expectedRevision）。玩家思考期间若有 stale command（AI 控制的菲希芙发攻击），怎么处理？
**根因**：v3"commandId+expectedRevision 串行化、拒绝 stale command"。危机响应期间 expectedRevision 不变（dispatch 没提交新 state），菲希芙的 command 带 expectedRevision=旧值 → 接受还是拒绝？若接受，会覆盖 ResolutionFrame 吗？提案没说"中断态下的 command 路由规则"。
**建议**：明确**中断态下只接受 `Choose` 类 command**（对应 pending RequestChoice），其他 command 一律 rejection（reason: "waiting_for_choice"）。CombatState 加 `awaitingChoice: RequestChoiceId` 字段，dispatch 入口先查。

### ⚪ Q6：AddModifier 的 scope 粒度（连击每发 vs 整体）
**现象**：案例行 427《焚烬之理》每发连击+1500 真伤（3 发共+4500）。v3 AddModifier 默认作用于"本次攻击整体"，连击场景需 `scope: "per_hit"`。
**建议**：AddModifier 加 `scope: "whole_action" | "per_hit" | "per_target"`。

---

## 4. 判定

**🟡 部分能**。v3 能顺畅跑完常规阶段（火元素战斗 R1-R2，写法 C 基线），但**"时间暂停 + 询问禁忌之门 + 代价换奇迹"这个最考验 v3 可控开放性的场景，v3 现有词汇不够用，会卡在三处**：
1. 🔴 **"暂停敌方攻势"语义造假**（grantActionSlot ≠ 冻结敌方，需加 closed RuleKey `FreezeActionSlot`）
2. 🔴 **"不可战胜强敌"触发条件无法确定性判定**（需降维成层级差/divinity 差代理信号）
3. 🟡 **"奇迹"的开放性塞不进 EffectIntent**（按主人决策走 BoundedAdjudication，战斗内只做 PreventDeath+GrantActionSlot+代价扣费，奇迹效果走 DomainEvent→Story Agent 叙事展开）

**最小补丁建议**：
1. 加 closed RuleKey `FreezeActionSlot(targetId, slotType, rounds)`（OverrideIntent 的一种），让"暂停时间"能真正冻结敌方 action 槽，语义诚实。
2. ReactionWindow trigger condition 限定为确定性信号（HP 阈值/状态查询/层级差/divinity 差），AI 主观判定只走 EmitNarrativeCue 不进 trigger。
3. **按主人决策落地 BoundedAdjudication 接口**：战斗 Agent 提 ProposedAdjudication，内核验边界不验创造性；战斗内只产 `DamagePrevented + GrantActionSlot + ForbiddenGateOpened(NarrativeCue)` DomainEvent；奇迹效果作为 post-combat 事件投影给 Story Agent；代价（FP/永久损失）在 CombatEnded 终局提交，挂 `combatId+settlementId` 保证幂等。
4. CombatState 加 `awaitingChoice` 字段，dispatch 入口路由：中断态下只接受 Choose，其他 rejection。

**关键结论**：v3 内核哲学（closed RuleKey + 5 不变量 + dispatch 单入口）本身没问题，但**"危机响应/禁忌之门"这类叙事驱动的机制本质是开放性的**。按主人决策走 BoundedAdjudication，战斗内核管确定性部分（免死/额外槽/代价扣费），奇迹的创造性效果交给战斗 Agent 判 + 叙事层展开 —— 符合 ADR-11 本意。
