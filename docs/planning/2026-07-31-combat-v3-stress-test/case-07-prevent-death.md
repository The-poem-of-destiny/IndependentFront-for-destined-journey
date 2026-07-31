# 压测案例 ①：PreventDeath 濒死免死（第 07 场）

> 📌 本文件是 v3 真实样本压测的详细脑测报告。v3 提案核心速览见 [README](./README.md)。
> 源样本：[`reference/战斗对话样本/第07场_行332-352_2026-03-28_强度713.md`](../../../reference/战斗对话样本/第07场_行332-352_2026-03-28_强度713.md)（跨 4 场连续战斗，7 回合，强度 713）
> 压测 intent：**PreventDeath + ConsumeCharge**
> 判定：🟡 **部分能**（核心机制可表达，但 `damage.preview` window 缺失导致格挡表达不出）

---

## 1. 案例摘要

样本实为 **4 场连续战斗**（女仆长 v1 / 女仆长 v2 / 无面者仆役集群 / 混沌肉块），跨 7 个战斗回合、9 次 60-d20 骰池续杯，是样本里唯一同时压测"濒死免死 + 解除濒死 + 集群范围结算 + 真实伤害 + 意图对抗 + 战意崩溃 + 格挡减伤"的复合案例。

**关键机制点（带行号）**：

- 🔥 **濒死免死 #1**（行 1311-1322）：诺娅 HP 883 → -197（致死），强制 HP=1 + [重创/倒地]。原版注释明确"触发濒死保护机制，强制保留 1 点 HP 并击飞"。
- 🔥 **濒死免死 #2**（行 2011-2019）：菲希芙 HP 213 → -339（致死），HP 锁 1 + [重创/昏迷]。
- 🔥 **解除濒死**（行 1561、2225-2232）："生机重燃"词条 —— 标准治疗药水恢复 400 HP 并解除 [重创]/[濒死]。
- 🔥 **真实伤害**（行 2153、2419-2466）：《焚烬之理》附 1500 真伤，无视减免，"基础能量部分走装备增益、真实部分不走"。
- **意图对抗失败重置**（行 1759、1969、2456）：攻方 T2×5+d20 vs 守方 T3×5+d20+难度，失败则意图系数重置 1.0。
- **战意崩溃→处决**（行 511-535、779-808）：HP<30% 触发 d20<12 检定，崩溃后下一击自动判 [处决] 保底暴击。
- **格挡减伤**（行 2109-2123、2338-2354）：战术动作"格挡"本次物理伤害 ×0.2 + 免疫拖拽 —— **受击后插入的战术动作，改了已结算的伤害**。
- **集群范围结算**（行 1209-1215、1358-1365）：`范围结算: 伤害 × min(范围上限, 剩余数量)`，减员动态。
- **9 次骰池续杯**：每场开场均注入 60 个 d20，cursor 顺序消费。

---

## 2. v3 复现方案

### 2.1 CombatCommand 序列

整案约 40-50 个 CombatCommand（不含 dispatch 自动推进的 phase 类 command）。按战斗场次列关键 command（`commandId / type / 成本 / expectedRevision / 骰子消耗`）：

#### 战斗 1：女仆长 v1（回合 1，4 单位各 1 攻击）

| #   | type           | 成本   | revision | 骰子           | 说明                         |
| --- | -------------- | ------ | -------- | -------------- | ---------------------------- |
| 1   | OpenCombat     | —      | R0→R1    | —              | 参战方+类型+环境+bundle hash |
| 2   | BeginOutput    | —      | R1       | 注入 60-d20 #1 |                              |
| 3   | RollInitiative | 自动   | R1→R2    | 4 颗           | 先攻排序                     |
| 4   | Attack         | attack | R2→R3    | 1(12)          | 女仆长→诺娅 尖啸训斥（精神） |
| 5   | Attack         | attack | R3→R4    | 1(10)          | 理查德→女仆长 灼热射线       |
| 6   | Attack         | attack | R4→R5    | 1(3)           | 诺娅→女仆长 崩山重击（失手） |
| 7   | Attack         | attack | R5→R6    | 2(9,10)劣势    | 菲希芙→女仆长 暗影之刃       |
| 8   | EndRound       | 自动   | R6→R7    | —              | round.close，负面 tick       |

#### 战斗 2：女仆长 v2（含战意崩溃+处决）

| #   | type                | 成本   | 骰子      | 说明                                                  |
| --- | ------------------- | ------ | --------- | ----------------------------------------------------- |
| 9   | OpenCombat          | —      | —         | 新战斗                                                |
| 10  | BeginOutput         | —      | 60-d20 #2 |                                                       |
| 11  | Attack              | attack | 1(12)     | 女仆长→诺娅 剔骨连刺（多段×2 + 流血）                 |
| 12  | UseItem(深渊的低语) | action | —         | 理查德 FP150，触发渊化侵蚀                            |
| 13  | Attack(渊化侵蚀)    | attack | 1(14)     | 理查德→女仆长 精神 798 + 渊化 3 回合                  |
| 14  | **MoraleCheck**     | 自动   | 1(10)     | 战意 d20=10<12 → 崩溃                                 |
| 15  | Attack(崩山重击)    | attack | 1(13)     | 诺娅→女仆长，守方崩溃→处决保底暴击 660，HP 26→-634 死 |
| 16  | CommitSettlement    | 自动   | —         | CombatEnded 幂等（EXP160/FP100）                      |

#### 战斗 3：无面者集群（含濒死免死 #1）

| #    | type                    | 成本   | 骰子      | 说明                                                              |
| ---- | ----------------------- | ------ | --------- | ----------------------------------------------------------------- |
| 17   | OpenCombat              | —      | —         | 集群 3/3                                                          |
| 18   | BeginOutput             | —      | 60-d20 #3 |                                                                   |
| 19   | Attack(伸缩鞭击)        | attack | 1(17)     | 集群→诺娅 1080，**诺娅 HP 883→-197 致死**                         |
| 19.5 | **preventDeath window** | 自动   | —         | unit.beforeDown → PreventDeath+ConsumeCharge，HP 锁 1 + 重创/倒地 |
| 20   | CastSkill(暗影沼泽)     | action | 1(11)     | 菲希芙→集群 范围+减员 2/3 + 束缚                                  |
| 21   | Attack(火球术)          | attack | 1(11)     | 理查德→集群 3464，HP 1995→-1469 死                                |
| 22   | CommitSettlement        | 自动   | —         | 集群衰减 EXP 168                                                  |

#### 战斗 4：混沌肉块（含濒死免死 #2 + 真实伤害 + 格挡，4 回合）

| #    | type                    | 成本           | 骰子        | 说明                                                 |
| ---- | ----------------------- | -------------- | ----------- | ---------------------------------------------------- |
| 23   | OpenCombat              | —              | —           | 混沌肉块 T3                                          |
| 24   | BeginOutput             | —              | 60-d20 #5   |                                                      |
| 25   | Attack(污秽喷射)        | attack         | 1(8)        | 肉块→小队 AOE，**菲希芙 HP 213→-339 致死**           |
| 25.5 | **preventDeath window** | 自动           | —           | 菲希芙 HP 锁 1 + 重创/昏迷                           |
| 26   | EndRound                | 自动           | —           |                                                      |
| 27   | BeginOutput             | —              | 60-d20 #6   |                                                      |
| 28   | UseItem(标准治疗药水)   | action         | —           | 理查德→菲希芙 **解除重创/昏迷 + 治 400**（生机重燃） |
| 29   | Attack(肢体飞爪)        | attack         | 1(11)       | 肉块→诺娅 487，**诺娅 HP 319→-168 致死**             |
| 29.5 | **诺娅 insertBlock**    | action(响应式) | —           | 格挡 ×0.2 → 97，免疫拖拽。**受击后插入**             |
| 30   | Attack(肢体飞爪)        | attack         | 1(10)       | 肉块→理查德 404                                      |
| 31   | UseItem(焚烬之理)       | action         | —           | FP200，附 1500 真伤 buff                             |
| 32   | Attack(真理火球术)      | attack         | 2(20,5)劣势 | 真实伤害不走装备增益/暴击，1843                      |
| ...  | (回合 3-4 余下 command) |                |             |                                                      |
| N    | CommitSettlement        | 自动           | —           | EXP600/FP100                                         |

---

### 2.2 物品/技能脚本怎么写（v3 EffectAutomaton 实机写法）

#### ① 濒死保护（重创保护机制）—— 最关键

单位级被动 automaton，订阅 `unit.beforeDown`。不是物品也不是 buff，更像角色天赋/系统规则 —— 挂到角色 `innateAutomata` 或全局 `SystemRulesAutomaton`。

```ts
const grievousProtection: EffectAutomaton = {
  id: 'system.grievous_protection',
  owner: '诺娅', // 动态，每个有此被动的角色各一份
  window: 'unit.beforeDown', // HP 即将 ≤0 的窗口
  trigger: (ctx) => ctx.pendingHpDelta <= 0 && ctx.unit.charges.has('grievous_protection'),
  intent: (ctx) => [
    // ① 阻止死亡
    { kind: 'PreventDeath', target: ctx.unit.id, floorHp: 1 },
    // ② 消耗一次性充能（"一次性"语义靠这个）
    { kind: 'ConsumeCharge', target: ctx.unit.id, chargeKey: 'grievous_protection', count: 1 },
    // ③ 施加重创/倒地（"代价"）
    {
      kind: 'ApplyStatus',
      target: ctx.unit.id,
      status: '重创/倒地',
      duration: { kind: 'until_removed' },
    },
    // ④ 击飞 = 叙事 cue + 失能（无几何位移，项目是节点式 location）
    { kind: 'EmitNarrativeCue', cue: 'knockback', target: ctx.unit.id },
  ],
  priority: { divinity: 0, declared: 100 }, // 系统级，早于普通效果
};
```

**关键点**：

- `PreventDeath.floorHp=1` 对应样本"HP 锁定 1"。
- `ConsumeCharge` 实现一次性 —— 多次濒死需多个 charge 或重新充能。样本里诺娅/菲希芙是**不同角色**，各自独立 charge，没问题。
- **"击飞"在 v3 词汇里没有直接 intent**。用 `EmitNarrativeCue` + `ApplyStatus(重创/倒地)` 组合表达，只解决叙事+失能，**不表达几何位移**（项目是节点式 location，战斗内无二维坐标，"击飞"本就不该有几何意义）。

#### ② 生机重燃（标准治疗药水的解除濒死词条）

道具使用 command 触发，声明式 effect bundle，不需要 window（非反应式）。

```ts
const standardHealingPotion: ItemEffectBundle = {
  id: 'item.standard_healing_potion',
  triggers: [{ kind: 'on_use', target: 'drink' }],
  intents: (ctx, target) => [
    // ① 治疗
    { kind: 'Heal', target: target.id, amount: 400, type: 'hp' },
    // ② 解除重创/濒死 —— RemoveStatus 支持 predicate 匹配多个状态
    {
      kind: 'RemoveStatus',
      target: target.id,
      predicate: (s) => ['重创', '重创/倒地', '重创/昏迷', '濒死'].includes(s.id),
    },
    // ③ 快速吸收词条 —— 纯叙事 cue
    { kind: 'EmitNarrativeCue', cue: 'fast_absorption' },
  ],
};
```

`RemoveStatus` 词汇够用，predicate 匹配能一次清掉"重创/倒地"这种复合命名状态。

#### ③ 火球术（普通攻击技能，含意图对抗）

技能 automaton 在 `attack.declared` 声明参数，意图对抗由内核 `check.intent` 阶段处理（非脚本管）。

```ts
const fireball: SkillAutomaton = {
  id: 'skill.fireball',
  window: 'attack.declared',
  trigger: (ctx) => ctx.command.skillId === 'fireball',
  intent: (ctx) => [
    {
      kind: 'DeclareAttack',
      attacker: ctx.attacker.id,
      defender: ctx.defender.id,
      damageType: 'energy',
      baseDamage: ctx.attacker.stats.int * 10 * 2.8 + 400 + 190,
      intentTier: ctx.command.intent || '常规',
      consumes: { mp: 400 },
      tags: ['range:5', 'cluster_eligible'],
    },
  ],
};
// 装备 modifier 各自在 collect_attacker_mods 注入
const elementalStaff = {
  window: 'collect_attacker_mods',
  trigger: (ctx) => ctx.attacker.equipped.weapon === '元素法杖' && ctx.damageType === 'energy',
  intent: [
    { kind: 'AddModifier', modifier: { type: 'percentage', value: 0.15 }, slot: 'final_damage' },
  ],
};
```

意图对抗失败重置（行 1759/1969/2456）是**内核 check.intent 纯公式**，不写进 automaton，写进内核 RuleKey。

#### ④ Bonus：《焚烬之理》真实伤害

```ts
const cremationTruthBuff: EffectAutomaton = {
  id: 'buff.fenjin_zhili',
  owner: '理查德',
  window: 'damage.compute',
  trigger: (ctx) => ctx.attacker.id === '理查德' && ctx.attacker.buffs.has('fenjin_zhili_charge'),
  intent: (ctx) => [
    // 真伤：不走装备增益、不走暴击、不走减免
    {
      kind: 'DealDamage',
      target: ctx.defender.id,
      amount: 1500,
      damageType: 'true', // 关键标签
      bypass: ['equip_bonus', 'crit', 'dr', 'attribute_reduce'],
      rootChainId: ctx.actionId,
    },
    { kind: 'ConsumeCharge', target: '理查德', chargeKey: 'fenjin_zhili_charge', count: 1 },
  ],
};
```

⚠️ 提案未明确 `DealDamage` 支持 `bypass` 列表 —— 见问题清单 Q3。

#### ⑤ Bonus：格挡（响应式战术动作，本案最别扭）

样本是"受击结算完 → 插入格挡 → 重新结算伤害"。需 `damage.preview` window（提案未列）。

```ts
const blockAction: ReactiveActionAutomaton = {
  id: 'action.block',
  owner: '诺娅',
  window: 'damage.preview', // 伤害已算出但未提交
  trigger: (ctx) => ctx.defender.id === '诺娅' && ctx.pendingDamage.type === 'physical',
  requiresChoice: true, // 玩家/NPC 决定要不要格挡
  intent: (ctx) => [
    {
      kind: 'AddModifier',
      modifier: { type: 'percentage', value: -0.8 },
      slot: 'final_damage',
      scope: 'this_attack',
    },
    { kind: 'Override', ruleKey: 'immunity', value: ['拖拽'], scope: 'this_attack' },
    { kind: 'SpendResource', target: '诺娅', sp: 50 },
    { kind: 'ConsumeCharge', target: '诺娅', chargeKey: 'action_slot', count: 1 },
  ],
};
```

---

### 2.3 战斗流程时间线

#### 时间线 A：濒死触发那一下（行 1295-1322，无面者集群→诺娅）

```
[phase: UnitTurnOpen, 单位=无面者集群] → 消费攻击槽
[PlayerCommand: attack(伸缩鞭击)] → dispatch
  ↓ 内核 attack 结算
[window: attack.declared] → 集群技能 automaton 返回 DeclareAttack intent
[window: check.intent]   → 内核纯公式，常规意图，无需对抗
[window: check.hit]      → d20(17)+0-0=17 → 评级[有效]
[window: damage.compute] → 8 步管线 = 1080（含集群 ×3）
  ↓ 即将提交：诺娅 HP 883 → -197（致死）
[window: ★ unit.beforeDown ★] ← 濒死保护 automaton 触发
  → intents: [PreventDeath(诺娅, floorHp=1),
              ConsumeCharge(诺娅, 'grievous_protection', 1),
              ApplyStatus(诺娅, '重创/倒地'),
              EmitNarrativeCue('knockback')]
  → 内核验证：PreventDeath 合法（charge 存在），intent batch 整体通过
[原子提交] → nextState + DomainEvents:
    DamageApplied(诺娅, -1080, 物理根源)
    HpFloored(诺娅, 1)           ← PreventDeath 生效
    ChargeConsumed(诺娅, grievous_protection)
    StatusApplied(诺娅, 重创/倒地)
    NarrativeCue(knockback, 诺娅)
```

**要点**：濒死保护**没打断**攻击槽消费，没让诺娅"额外行动"，符合不变量①②。PreventDeath 和伤害提交是**同一个原子提交**，符合不变量④。

#### 时间线 B：一个完整回合（混沌肉块回合 2，含格挡+真实伤害）

```
[phase: RoundOpen] → 正面状态 tick（诺娅/菲希芙的[信赖]）
[phase: 战况总览] → 投影 CombatView
[phase: 本轮先攻] → 序列: 诺娅(17) > 菲希芙(12) > 肉块(8) > 理查德(8)

[phase: UnitTurnOpen, 混沌肉块] → 攻+动槽
  [NPC attack: 肢体飞爪 → 诺娅]
    [check.hit: d20=11] → [有效] → 伤害 487
    [window: ★ damage.preview ★] → 诺娅格挡 automaton 触发 requiresChoice
    ⛔ dispatch 暂停！[RequiredInput: EffectChoice(格挡? Y/N)] → 玩家选 Y
    [格挡 intent: AddModifier(-80%), Override(免疫拖拽), SpendResource(SP50), ConsumeActionSlot]
    [重新 damage.compute] → 487×0.2=97
    [原子提交] → DamageApplied(诺娅,-97), ActionSlotConsumed, ResourceSpent(SP50)

[phase: UnitTurnOpen, 理查德] → 攻+动槽
  [useItem(标准治疗药水) → 菲希芙] → action 槽
    [Heal 400, RemoveStatus(重创/昏迷)] → 菲希芙 HP 1→401, 状态清
  [useItem(焚烬之理)] → 挂真实伤害 charge（action 槽）
  [attack(真理·火球术) → 肉块] → attack 槽
    [check.hit: 2 颗劣势 = (20,5)→5] → [擦伤] 系数 0.3
    [damage.compute] 火球基础 891×0.3 = 267, 装备增益 ×1.12×1.15 → 344
      焚烬之理 buff → DealDamage(1500, true, bypass=[equip,crit,dr])
    [意图对抗] 攻方T2×5+17=27 vs 守方T3×5+19+20=54 → 失败 → 系数重置（真伤不受影响）
    [原子提交] → DamageApplied(肉块, -1843), ChargeConsumed(焚烬之理)

[phase: RoundClose] → 负面 tick
```

---

## 3. 架构执行问题清单

### 🔴 Q1：「击飞/位移」无对应 EffectIntent（下调为 🟡，本案可不补）

**现象**：行 1315"强制保留 1 点 HP 并击飞"。
**根因**：v3 词汇有 SpawnOrDespawn / SelectOrRetarget，**无强制位移 intent**。
**建议**：本案用方案 A（`EmitNarrativeCue('knockback')` + `ApplyStatus(重创/倒地)`，无几何位移）能跑通 —— 项目是节点式 location，战斗内无二维坐标，"击飞"本就不该有几何意义。v3 文档应明确"击飞=叙事cue+失能状态，无几何位移"。未来若需"击退后排"，新增 `RepositionIntent` closed RuleKey（需证明 ≥2 技能需要）。

### 🔴 Q2：受击后插入格挡 vs dispatch 同步推进模型 —— 时序张力（致命）

**现象**：行 2338-2354，诺娅在**已被打中（伤害 487 已算出）**后插入格挡，改成 97。要求结算管线在"伤害已算/未提交"间暂停。
**根因**：v3 提案"dispatch 同步自动推进到 RequiredInput"。格挡是**响应式**（非玩家主动 command，是伤害预览触发的选择）。`RequiredInput.EffectChoice` 理论能表达，但：

1. 提案列的 window 是 `unit.beforeDown`/`damage.after`/`check.*`/`damage.*`，`damage.after` 是结算后改不了伤害，需要的是**结算前预览**。
2. 每次受击都暂停问"要不要格挡"会**严重打断节奏**。
   **建议**：v3 必须显式增加 `damage.preview`（或 `damage.before_commit`）typed window，允许返回 `RequestChoice` 触发 `EffectChoice`。优化：只有装备格挡类 automaton 的单位才触发暂停，NPC 默认自动决策。

### 🟡 Q3：真实伤害 bypass 语义在 DealDamage schema 未明确

**现象**：行 2173-2174"真实伤害不吃暴击和装备加成"。需 `DealDamage` 声明"绕过 equip_bonus/crit/dr/attribute_reduce"。
**根因**：提案 `OutcomeIntent`(含 DealDamage) 只说"请求伤害，仍须走结算窗口"，**没明确支持 `bypass: string[]` 或 `damageType:'true'`**。走标准 8 步管线会被装备减免/DR 误减。
**建议**：`DealDamage` 加 `damageType: 'physical'|'energy'|'mental'|'true'` 和 `bypass: ModifierSlot[]`，`true` 类型短路 Step3-7。

### 🟡 Q4：60-d20 DiceTape 续杯时机与战斗节奏

**现象**：本案 4 场注入 8 次 60-d20，单场常**用不完**（女仆长 v2 只消费约 8 颗）。
**根因**：① 跨战斗 cursor 重置：新战斗是否强制新 BeginOutput，提案没明确。不强制则 cursor 跨场累积，第 4 场开战即快耗尽。② 场内续杯：单场回合多 + 多次劣势骰×2，60 颗可能不够，中途 BeginOutput 在敌人回合中途耗尽会卡住。
**建议**：明确 `OpenCombat` 自动触发首个 `BeginOutput`，跨战斗重新绑定。场内续杯在 RoundOpen 间隙触发（非攻击中途）。本案实际约 35-40 颗/场，60 够用，**不触发**但 v3 通用风险。

### 🟡 Q5：RemoveStatus 解除濒死 vs PreventDeath 的 window 时序

**现象**：事后解除（行 1581/2232，状态已施加后清掉）时序简单。但若某技能想在 `unit.beforeDown` **同时** PreventDeath 和 RemoveStatus[濒死]，同 batch 语义矛盾。
**根因**：PreventDeath（保留 1HP + 施加重创）和 RemoveStatus（清除重创）同 batch 会"免死且无副作用"，破坏平衡。
**建议**：明确 `PreventDeath` 和 `RemoveStatus` 的**互斥 scope**：同 batch 内不允许同时 target 同一单位的"濒死/重创"状态。本案时序安全（事后解除）。

### 🟡 Q6：多段/集群范围结算的 intent 表达

**现象**：剔骨连刺"多段×2，伤害÷2 再×2"；暗影沼泽"集群×1.5，范围×min(4,3)"；动态减员 2/3。
**建议**：`DeclareAttack` 加 `multiHit: number`、`clusterTargeting: { maxRange: number, count: 'dynamic' }`。count='dynamic' 让内核结算时读当前减员数。

### ⚪ Q7：战意崩溃→处决保底暴击的 RuleKey

**建议**：加 closed RuleKey `morale.crashed → attack.execution_floor`（崩溃单位被攻击时，评级下限=暴击 1.3×，闪避=0）。

### ⚪ Q8：战斗间穿插生产/使用道具的边界

**建议**：v3 文档补一句"CombatSession 在 commitSettlement 后变为 readonly，后续动作走游戏主循环"。

---

## 4. 判定

**🟡 部分能**。核心机制（濒死免死、解除濒死、真实伤害、意图对抗、战意崩溃、多段/集群）在 v3 的 EffectIntent + closed RuleKey 框架下**都能表达**，不变量①-⑤不被违反。但 **2 个真实卡壳点**必须补丁：

1. 🔴 **`damage.preview` window 缺失** —— 格挡（受击后插入战术动作改伤害）表达不出来。本案混沌肉块回合 2 诺娅格挡是关键生存节点，没这个 window 直接卡死。
2. 🟡 **`DealDamage.damageType='true' + bypass` schema 未明确** —— 焚烬之理真实伤害会被管线误减。

**最小补丁**：

1. **P0**：typed ReactionWindow 列表显式增加 `damage.preview`，允许返回 `RequestChoice` 触发 `EffectChoice`，支持响应式战术动作（格挡/招架/闪避反应）。
2. **P0**：`DealDamage` schema 加 `damageType` 和 `bypass`，true 类型短路 Step3-7。
3. **P1**：明确 `OpenCombat` 自动触发首个 `BeginOutput`，跨战斗 DiceTape 重新绑定。
4. **P1**：`PreventDeath` 与 `RemoveStatus` 同 batch 互斥 scope 规则。
5. **P2**：`DeclareAttack` 加 `multiHit`/`clusterTargeting`；明确"击飞=叙事cue+失能，无几何位移"。

补完 P0 两条后，本案 7 回合 / 4 场战斗 / 2 次濒死 / 1 次解除濒死 / 真实伤害 / 格挡 **能完整复现**，且比 v2 更严谨（v2 生产攻击管线根本没调用 `attacksRemaining/actionsRemaining`，"1 攻击+1 动作"靠 AI 自觉，v3 才真正锁死）。
