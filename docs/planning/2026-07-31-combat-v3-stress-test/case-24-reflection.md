# 压测案例 ③：Schedule 反伤+复活（第 24 场）

> 📌 本文件是 v3 真实样本压测的详细脑测报告。v3 提案核心速览见 [README](./README.md)。
> 源样本：[`reference/战斗对话样本/第24场_行1596-1600_2026-04-16_强度316.md`](../../../reference/战斗对话样本/第24场_行1596-1600_2026-04-16_强度316.md)（3 回合，强度 316）
> 压测 intent：**Schedule（反射）+ PreventDeath（复活）**
> 判定：🟡 **部分能**（反伤方向对，但 `isReaction` 标记缺失 + depth 熔断策略空白 + 复活需调和死亡红线）

---

## 1. 案例摘要

3 回合死斗，主角理查德（T5 传说）+ 菲希芙（T4）碾压清剿苍棘之塔处刑人，核心机制是「虚数偏折」状态触发的**虚数反弹反伤**（真实伤害），最终补刀处决 BOSS 查加尔。

**关键机制点（带行号）**：

- **虚数偏折状态**（行 101/236）：自身 buff，2 回合，"针对单体命中降低 5 / 反弹 50% 真伤"。
- 🔥 **反伤触发 ×4 次**（行 131、270、471、767）：攻方本是处刑人/查加尔打理查德，反伤后面板改写成「攻方: 理查德(反伤触发) | 守方: 原攻击者 | 招式: 虚数反弹」。
- **反伤仍掷骰**（行 139 优势 d20(3,19)→19「有效」、行 278、行 479 优势 d20(9,3)→9「勉强」、行 775）：反伤有独立命中评级结算，**消费骰池**。
- **反伤走真伤+集群修正**（行 144-145）：基础 565 → ×1.5 集群 → 范围结算 min(4,4)。
- ⚠️ **复活仅出现在背景记忆**（行 45 AM0288）：本场景**未实际触发**，理查德全程未濒死（HP 最低 21003/30079=69%）。这是诚实声明 —— 本案只验反伤，复活是推演。
- 多段连击（行 861 虚空·星轨裁决 5 段）、处决自动成功（行 889/1001）、空间锚定控场（行 875/980）、集群减员（行 147）。

---

## 2. v3 复现方案

### 2.1 CombatCommand 序列

> 约定：每条 Command 带 `commandId`、`expectedRevision`、`cost:{attack?,action?}`。骰子由 DiceTape 在 BeginOutput 注入 60 个 d20，cursor 顺序消费。本场所属回合跨 3 个 BeginOutput epoch（行 68/382/825）。

| #   | Command                                                | 成本   | 时机/phase                          | 骰耗                                   | 说明                                     |
| --- | ------------------------------------------------------ | ------ | ----------------------------------- | -------------------------------------- | ---------------------------------------- |
| C0  | `BeginOutput(batch1)`                                  | —      | 战斗发起                            | 注入 60, cursor=0                      | 行 68                                    |
| C1  | `DeclareCombat(死斗, 参战方)`                          | —      | RoundOpen 前                        | 0                                      | 行 79                                    |
| C2  | `RollInitiative`                                       | —      | RoundOpen.initiative                | d20[1],[1]                             | 行 90-92                                 |
| C3  | `UseSkill(理查德, 虚数偏折, 自身)`                     | action | 理查德.action.declared              | 0                                      | 行 97，挂虚数偏折                        |
| C4  | `Attack(集群→理查德, 破甲重弩)`                        | attack | 集群回合                            | 意图骰 2 + 命中劣势 2 + **反伤优势 2** | 行 106/130，主伤害 582                   |
| C5  | _(内核自动)_ `Schedule→DealDamage 反伤`(理查德→集群)   | —      | C4 的 damage.after                  | 反伤命中 d20(3,19)→19                  | 行 131，2542 伤，集群 2800→258，减员 1/4 |
| C6  | `Attack(菲希芙→残存处刑人, 暗影之刃)`                  | attack | 菲希芙回合                          | d20(7)                                 | 行 154，628 伤                           |
| C7  | `EndRound` → DoT tick                                  | —      | RoundClose                          | 0                                      | 虚数偏折 2→1                             |
| —   | `BeginOutput(batch2)`                                  | —      | 下一 epoch                          | 60                                     | 行 382                                   |
| C8  | `RollInitiative`                                       | —      | RoundOpen                           | d20[11],[3],[4]                        | 行 405                                   |
| C9  | `Attack(理查德→查加尔, 灼热射线)`                      | attack | 理查德回合                          | 优势 d20(19,5)→19                      | 行 414，3624 伤，挂灼烧                  |
| C10 | `UseSkill(查加尔, 影渊步, 自身)`                       | action | 查加尔回合                          | 0                                      | 行 438，绝对闪避（被压制判无效）         |
| C11 | `Attack(查加尔→理查德, 猩红处决)`                      | attack | 查加尔回合                          | 劣势 d20(8,18)→8 + **反伤 d20(9,3)→9** | 行 447，484 伤                           |
| C12 | _(内核自动)_ `Schedule→DealDamage 反伤`(理查德→查加尔) | —      | C11 的 damage.after                 | d20(9,3)→9                             | 行 471，1080 伤                          |
| C13 | `EndRound` → 灼烧 tick(30)                             | —      | RoundClose                          | 0                                      |                                          |
| —   | `BeginOutput(batch3)`                                  | —      |                                     | 60                                     | 行 825                                   |
| C14 | `RollInitiative`                                       | —      | RoundOpen                           | d20[13],[7]                            | 行 847                                   |
| C15 | `Attack(理查德→查加尔, 虚空·星轨裁决, 多段5)`          | attack | 理查德回合                          | 意图 d20[8]/[1] + 优势 d20(13,5)→13    | 行 855，4208 伤，挂空间锚定              |
| C16 | `Attack(理查德→查加尔, 冰霜射线, 处决意图)`            | attack | 理查德回合（同回合第二攻击，见 Q3） | 优势 d20(4,20)→20                      | 行 880，4255 伤，查加尔死                |
| C17 | `SettleCombat(胜利)`                                   | —      | Terminal→Settlement                 | 0                                      | 行 902，幂等 EXP+1500/FP+3000            |

---

### 2.2 物品/技能脚本怎么写（v3 EffectAutomaton 实机写法）

#### ① 虚数反弹（反伤被动，最关键）—— 订阅 `damage.after`

```ts
automaton "虚数偏折" {
  subscribe: "damage.after"
  owner: statusEffect("虚数偏折")           // 状态挂在理查德身上
  trigger: ctx.event.defenderId === this.owner
           && ctx.event.outcome.hitGrade !== "失手"
           && ctx.event.attack.tags.includes("单体")

  // ① 命中修正（拆成另一条订阅 check.hit：命中-5，行 256）
  // ② 反伤核心：在 damage.after 排程一次 DealDamage
  return [
    ScheduleIntent({
      window: "damage.after",               // 当前伤害结算后立即排入
      delay: 0,                              // 同 Command 原子内
      intent: DealDamage({
        sourceId: this.owner,                // 攻方=理查德(反伤触发)
        targetId: ctx.event.attackerId,      // 守方=原攻击者
        damageType: "真实",
        baseDamage: floor(ctx.event.rawDamage.preReduction * 0.5),  // 原伤害1130×50%=565
        hitCheck: { rollPolicy: "advantage", consumeDice: 2 },      // 行139 优势d20(3,19)
        attackCount: ctx.event.attack.clusterHits,                  // 行143 ×3
        clusterMultiplier: 1.5,             // 行144 集群修正
        // 🔥 v3 反伤专项字段：
        rootChainId: ctx.event.actionId,
        depth: (ctx.chain?.depth ?? 0) + 1,
        reflectionTag: "虚数反弹",
        isReflection: true,
        doesNotConsumeSlot: true            // 反伤不消耗攻击槽（见 Q1）
      }),
      PreventDeath: false                   // 反伤杀敌正常死亡
    })
  ];
}
```

**rootChainId / depth / 反射标签走法**：

- 第一次反伤：`rootChainId = C4 的 actionId`、`depth = 1`、`isReflection = true`
- 内核验证：`depth ≤ MAX_REFLECTION_DEPTH`（提案未给阈值，见 Q2）
- 反伤 DealDamage 进入管线时再次触发 `damage.after` → 守方=原攻击者，**若原攻击者也有反伤**会再 Schedule depth=2 反伤

#### ② 复活机制（防御性 PreventDeath + ConsumeCharge）—— ⚠️ 本场景未实际触发

基于 AM0288 设定 + v3 vocabulary 推演"如果触发该怎么写"：

```ts
automaton "复活机制" {
  subscribe: "unit.beforeDown"
  owner: character("理查德")
  trigger: ctx.unitId === this.owner && ctx.pendingHp <= 0
  return [
    ConsumeCharge({ chargeId: "复活充能", amount: 1 }),   // 一次性
    PreventDeath({
      unitId: this.owner,
      restoreHpPercent: 50,                  // 复活后回 50% HP
      restoreRule: "replace",
      divinity: 6                            // 完整法则级（法则抹杀 vs 法则级复活）
    }),
    EmitNarrativeCue({ text: "异神法则抹杀后的复活" })
  ];
}
```

v3 调和点：PreventDeath 是 `unit.beforeDown` window 里**合法地 Override 死亡 RuleKey**，把"死亡"closed RuleKey 在法则级 divinity 下临时改判。但 v2 红线"HP≤0=死亡不可协商"会被打破，v3 用 divinity 优先级调和（见 Q4）。

#### ③ 普通攻击（灼热射线，行 414）—— Attack Command + 装备 modifier

```ts
// Attack Command 本身不需要 EffectAutomaton，装备 modifier 走 check.*/damage.* window
automaton "真理回响·渊核法杖" {
  subscribe: "check.hit"
  trigger: ctx.attackerId === this.owner
  return [ ModifierIntent({ target: "命中", value: +4, type: "检定" }) ];   // 行427 命中+4

  subscribe: "collect_attacker_mods"
  trigger: ctx.attackerId === this.owner
  return [
    ModifierIntent({ target: "伤害系数", value: +0.15, type: "百分比", tags:["能量"] }),
    ModifierIntent({ target: "穿透", value: +8, type: "特殊机制" }),
    ModifierIntent({ target: "攻击力", value: +380, type: "固伤" })
  ];
}

// Command 层面
Attack({
  attackerId: "理查德", targetId: "查加尔", skillId: "灼热射线",
  skillPower: 150, damageType: "能量", intent: "常规",
  cost: { mp: 100 },
  hitPolicy: { rollPolicy: "advantage", consumeDice: 2 },                    // 行425 优势d20(19,5)
  intentCheck: { rollPolicy: "none" },                                       // 常规意图无需对抗
  applyStatusOnHit: [ { id: "灼烧", duration: 2, dot: 30 } ]                 // 行433
})
```

---

### 2.3 战斗流程时间线（C4 攻击 → C5 反伤 → 反伤的反伤是否触发）

```
┌─ Command C4: Attack(处刑人→理查德, 破甲重弩) ──────────────────────
│
│  [phase: UnitTurnOpen(处刑人).attack]
│  ├─ window: check.intent (意图对抗)
│  │   攻方T4×5+d20[2]=22 vs 守方T5×5+d20[6]+难度10=41 → 失败(行115)
│  │   DiceTape: 消费 d20[1]=2, d20[2]=6（意图骰 2 颗）
│  ├─ window: check.hit
│  │   collect_defender_mods → 虚数偏折: 命中-5 (行256)
│  │   劣势 d20(20,9)→9 (行117)
│  │   DiceTape: 消费 d20[3]=20, d20[4]=9（命中骰 2 颗, 取 9）
│  │   检定: 9+0-0-5=4 → 评级"擦伤"(0.3)  (行120)
│  ├─ 【8步伤害管线】 baseDamage=852 → ×0.3擦伤×1.0意图×3次=766 → ×(1-DR24%)=582
│  │   DomainEvent: DamageApplied{ 理查德, hp:22069→21487, 582 }
│  └─ window: damage.after  ★反伤触发点★
│      │  ActiveEffectIndex 查找: 守方=理查德 身上"虚数偏折"
│      │  → 命中 grade="擦伤"≠失手 → 触发反伤 automaton
│      │  反伤 automaton 返回 ScheduleIntent: DealDamage({
│      │    source:理查德, target:处刑人, type:真实,
│      │    base: floor(1130 × 0.5) = 565,    // 原伤害1130的50%（非最终582）
│      │    rootChainId: C4.actionId, depth: 1, isReflection: true,
│      │    hitPolicy: { advantage, consumeDice:2 }, attackCount: 3, clusterMult: 1.5 })
│      │  内核验证 intent batch:
│      │    ✓ depth(1) ≤ MAX_REFLECTION_DEPTH
│      │    ✓ target(处刑人) 在场
│      │    ✓ doesNotConsumeSlot → 不违反不变量①
│
├─ 【反伤 DealDamage 子结算】(C5, 同一原子提交内) ─────────
│  ├─ window: check.hit (反伤命中检定)
│  │   优势 d20(3,19)→19 (行139)
│  │   DiceTape: 消费 d20[5]=3, d20[6]=19（反伤命中骰 2 颗）★消费下一批骰子
│  │   检定: 19+0-0=19 → "有效"(1.0)  (行142)
│  ├─ 【反伤伤害管线】 base=565 → ×1.0有效×1.0意图×3次=1695 → ×1.5集群=2542 (行143-145)
│  │   ★ 反伤是真实伤害, Step5 减免=0, Step7 DR 对真伤无效
│  │   DomainEvent: DamageApplied{ 处刑人, hp:2800→258, 2542, isReflection:true, rootChain:C4 }
│  │   处刑人 258>0 存活，集群减员 1/4 (行147)
│  └─ window: damage.after (反伤的 after)  ★反伤的反伤是否触发?★
│      │  ActiveEffectIndex 查找: 守方=处刑人集群 有反伤被动吗?
│      │  → 处刑人集群【没有】反伤被动 → 无 automaton 响应
│      │  → 链终止, depth 不再 +1
│      │  (假设场景: 若守方也有反伤, 则 depth=2 ScheduleIntent 产生
│      │   内核检查 depth(2) vs MAX_REFLECTION_DEPTH
│      │   超限 → EffectRejected{ reason:"反射深度超限" }
│      │   未超 → 继续子结算, 守方=原攻方理查德, depth=3... 直到一方无反伤被动或超限)
│
└─ 【原子提交】(C4+C5 合并)
   CombatState: 理查德HP-582, 处刑人HP-2542
   DiceTape cursor: 6 (2意图+2主命中+2反伤命中)
   revision: N → N+1
```

**反伤的 DealDamage 是"立即在本 Command 原子提交内结算"**（`delay=0` ScheduleIntent 属同 Command 子结算，不变量④），**不是排到后续 Command**。

---

## 3. 架构执行问题清单

### 🔴 Q1：反伤不消耗攻击槽但产生 DealDamage，与不变量①的边界

**现象**：行 131/270/471/767 反伤面板明确「消耗: HP[0] MP[0] SP[0]」—— 反伤不消耗资源也不消耗攻击槽（被动触发，发生在**别人**回合）。但反伤本身是完整 DealDamage（有命中检定、伤害管线、消费骰子）。
**根因**：不变量①约束**主动行动**。反伤是 reaction，发生在 `damage.after`，属"触发方在别人回合的被动反应"。但 `DealDamage` 默认语义是"一次攻击行动产出"，没区分"主动攻击 vs 被动反射"。
**风险**：内核若把反伤当"理查德的一次攻击行动"，会误扣攻击槽（理查德此时甚至不在自己回合）。反伤面板「攻方: 理查德(反伤触发)」会让 attackerId 指向理查德，不变量校验若按 attackerId 统计会误判。
**建议**：`DealDamage` 增加 `isReaction: boolean` / `doesNotConsumeSlot: boolean`。不变量①校验只统计 `cost.attack/action` 非零的主动 Command，reaction 产出的 DealDamage 豁免。行动轴推进不能因"反伤让理查德造成了伤害"就移动 turnPtr。

### 🔴 Q2：反伤 depth 链的终止策略，提案完全没定义

**现象**：提案原文只说"携带 rootActionId、depth 和反射标签，避免无限反射"——但 **MAX_REFLECTION_DEPTH 阈值、熔断策略、谁定**，三份提案文件全空白。
**根因**：本案反伤只反弹一次（处刑人/查加尔都无反伤被动，链自然终止）。但 v3 要 hold 住真实战斗，必然出现"反伤对反伤"（两个反伤装对打）。depth 阈值定多少？v2 subscription-manager ≤10，战斗场景建议 ≤5。超限是 `EffectRejected`（整批拒绝）还是 `ClampToZero`（伤害归零）还是叙事提示？反伤对反伤时，"原伤害 1130"的基准取谁的？depth=2 的基准是 depth=1 的"最终 2542"还是"原始 1130"？样本没答案。
**建议**：明确 `MAX_REFLECTION_DEPTH = 2`（反射→反射→终止，符合"反弹一次"直觉）。超限走 `EmitNarrativeCue("反射湮灭") + 双方反伤互相抵消`（叙事+数值双兜底）。反伤基准统一取 `rootChainId 对应的原始伤害`（depth≥2 时 base 不累加，永远基于根伤害 50%），避免伤害放大。

### 🟡 Q3：反伤的 DiceTape 消费 vs "每次输出 60 个 d20"语义对齐

**现象**：行 68 一批 60 个 d20，本回合消费：先攻骰(2) → 处刑人意图(2) → 处刑人命中(2,劣势) → **反伤命中(2,优势)** → 菲希芙命中(1)。反伤 d20(3,19)（行139）就是同一批顺序取的下一对。
**判定**：v3 的 DiceTape"每次输出 60 个 d20 顺序消费"+cursor 模型，与样本"一批骰池本回合所有掷骰（含反伤）顺序消费"**语义对得上**。反伤消费 d20[5]、d20[6] 正好是 cursor 顺序推进。✅ v3 比 v2 更严谨（v2 emitChain 里脚本可能 Math.random）。
**残留风险**：反伤 `hitPolicy.consumeDice` 必须显式声明（样本反伤**确实掷骰**）。若一批 60 颗在反伤密集战斗不够用（反伤链 depth=2 + 多段连击5 + 集群3次攻击，单回合最多 2+2+2+2=8 颗），cursor 耗尽 → `RequiredInput.BeginOutput`。adapter 不能暗中补骰。
**建议**：反伤 intent 强制带 `hitPolicy`（不能默认"自动命中"）。做骰子消耗压力测试。**推荐 DiceTape 分通道**（反伤命中走 attackHit 通道，不和 procCheck 混）。

### 🟡 Q4：复活机制——PreventDeath 与"HP≤0=死亡不可协商"红线的调和

**现象**：本场景复活**未实际触发**（理查德 HP 最低 21003=69%）。但 AM0288 设定"被异神法则抹杀后复活"是已确立角色能力，v3 必须能表达。
**根因**：v2 红线（§7.1）「HP≤0=死亡，**不可协商**」；v3 `PreventDeath`+`unit.beforeDown`+Override closed RuleKey。"法则抹杀"是 Override RuleKey（概念级），"复活"是 PreventDeath。时序：抹杀发生在死亡判定阶段，复活发生在 `unit.beforeDown`——**beforeDown 在死亡判定之前**，复活先生效，抹杀走不到。
**矛盾**：时序上 PreventDeath 抢在死亡前，等于"死亡从未发生"，叙事上"被抹杀后复活"的"抹杀"部分无法在数值层体现（HP 没真到 0）。严格按 v2 红线则复活实现不了；v3 用 divinity 调和（复活 divinity=6 > 抹杀），等于**承认 v2 红线被 v3 打破**。复活的 `restoreHpPercent`+`ConsumeCharge` 是 stateful，提案没说 PreventDeath 的 HP 恢复走哪个原子提交。
**建议**：明确复活走 `unit.beforeDown`，Override `death.threshold` RuleKey，divinity≥抹杀来源。v3 应正式声明："v2 HP≤0=死亡红线，在 v3 中由 PreventDeath window 提供 closed Override 出口，仅 divinity≥法则级 可激活"——**显式修订**，不是违反。PreventDeath 的 HP 恢复必须在**同一原子提交**内（不变量④），ConsumeCharge 同批。

### 🟡 Q5：反伤触发时，理查德身份从"守方"变反伤的"攻方"，owner/在场过滤

**现象**：行 131 面板「攻方: 理查德(反伤触发) | 守方: 集群」。C4 里理查德是守方，C5 里变攻方。
**判定**：v3 ReactionWindow evaluator 在 `damage.after` 触发反伤 automaton 时，automaton `owner=理查德`（虚数偏折挂理查德身上），反伤 DealDamage `sourceId=理查德`。理查德一直在场，**本身没问题**。
**残留风险**：若反伤 automaton 注册时 `owner` 写成"虚数偏折状态"而非"理查德"，在场过滤查不到参战者 → 不响应。反伤 DealDamage 的 `targetId=ctx.event.attackerId`（处刑人/查加尔），若原攻击者在反伤结算前已离场，内核必须校验 `targetId 在场`，否则 `EffectRejected` 或 `Retarget`。本案处刑人反伤后仍存活(258HP)，未触发。
**建议**：反伤 automaton 的 `owner` 标准化为"被反伤保护的角色 id"。反伤 DealDamage 进管线前强制校验 targetId 在场，离场 silently drop。

### ⚪ Q6：反伤取"原伤害 1130"而非"最终伤害 582"——EffectIntent 表达力

**现象**：行 136「基础伤害: 原伤害 1130 × 50% = 565」。反伤基准是**管线 Step1 初始伤害 1130**，不是最终 582。
**建议**：`damage.after` 的 immutable snapshot 必须暴露完整伤害管线中间值（`rawDamage.preReduction` / `postStep6` / `final` 三档），让 automaton 自选基准。

---

## 4. 判定

**🟡 部分能**。核心反伤机制 v3 的 `damage.after` window + `Schedule→DealDamage` + `rootChainId/depth/反射标签` 设计**方向正确，能表达本案例**（反伤只反弹一次，链自然终止，不存在 depth 熔断问题）。骰子语义（DiceTape 顺序消费）反而比 v2 更严谨对齐样本。但 v3 提案在三个关键点**留白过多**，实机必然卡住：

1. 🔴 反伤 intent 缺 `isReaction/doesNotConsumeSlot`，不变量①会误扣槽位
2. 🔴 `MAX_REFLECTION_DEPTH` 阈值与超限策略完全未定义，"反伤对反伤"场景必翻车
3. 🟡 PreventDeath 调和 v2 死亡红线需显式声明，否则复活无法落地

本案例因复活未触发、反伤链未递归，**恰好绕过了 Q2/Q4 两个最深的坑**——这说明**第 24 场不足以压测 v3 反伤/复活边界**，需补一个"双方都有反伤被动"+"角色真正死亡后复活"的极端样本。

**最小补丁建议**：

1. **EffectIntent.DealDamage 增加反应伤害标记**：`isReaction?`、`doesNotConsumeSlot?`、`rootChainId?`、`depth?`，不变量①校验豁免 `isReaction=true` 的 DealDamage 槽位统计。
2. **明确反伤熔断策略**：`MAX_REFLECTION_DEPTH = 2`；超限走 `EmitNarrativeCue("反射湮灭")+双方反伤互相抵消`；depth≥2 的反伤基准固定取 rootChain 原始伤害（不放大）。
3. **PreventDeath 正式修订 v2 死亡红线**：声明 `unit.beforeDown`+Override `death.threshold` RuleKey 为合法出口，仅 `divinity ≥ 法则级` 可激活，HP 恢复与 ConsumeCharge 同原子提交。
4. **damage.after snapshot 暴露三档伤害值**（preReduction / postStep6 / final）。
5. **补一个极端压测样本**：双方都带反伤被动 + 一方真正死亡触发复活。
