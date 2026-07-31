# v3 真实样本压测 · 案例集（README）

> 📌 本目录是 5 个真实战斗对话样本对 v3 架构的脑测压测详报，是 [`../2026-07-31-combat-v3-real-sample-stress-test-rfc.md`](../2026-07-31-combat-v3-real-sample-stress-test-rfc.md)（压测 + 补丁 RFC）的**实证依据**。
>
> 写 plan 时遇到设计决策，应回溯到这里查"哪场战斗的哪个机制需要这个"。

---

## 怎么读

1. 先读本 README 的 **v3 提案核心速览**（自包含，不重复去读提案也能理解脑测）。
2. 按需查具体案例（每个案例独立成文，含 CombatCommand 序列 / EffectAutomaton 伪代码 / 流程时间线 / 架构执行问题清单 / 判定）。
3. 高层结论与补丁方案见 [RFC 主文档](../2026-07-31-combat-v3-real-sample-stress-test-rfc.md)。

---

## 案例索引

| 案例 | 场次 | 压测 intent | 判定 | 核心卡点 |
|---|---|---|---|---|
| [① PreventDeath 濒死免死](./case-07-prevent-death.md) | 第07场（713，7回合）| PreventDeath + ConsumeCharge | 🟡 部分能 | `damage.preview` window 缺失（格挡）+ DealDamage 真伤 bypass |
| [② SpawnOrDespawn 召唤物](./case-06-summon.md) | 第06场（505，5回合）| SpawnOrDespawn + SummonUnit | 🟡 部分能 | 召唤当回合参战 vs v3"下轮进先攻" + 定时消失无表达 + 概率召唤抢骰子 |
| [③ Schedule 反伤+复活](./case-24-reflection.md) | 第24场（316，3回合）| Schedule（反射）+ PreventDeath | 🟡 部分能 | 反伤缺 isReaction 标记 + 反射 depth 熔断策略空白 + 复活调和死亡红线 |
| [④ Permission 时间暂停](./case-13-time-freeze.md) | 第13场（290，4回合）| Permission + RequestChoice | 🟡 部分能 | "暂停敌方"语义造假 + "奇迹"开放性塞不进 closed 词汇 |
| [⑤ Override 概念抹杀](./case-09-concept.md) | 第09场（253，4回合）| Override RuleKey + SpendResource | 🟡 部分能 | "状态→判胜"无终局规则 + FP 跨边界原子性 |

**5/5 全是 🟡**——但 v3 方向正确，卡点是 6 类系统性缺口（schema/window/RuleKey/跨边界/不变量冲突/开放性），不是架构方向错误。详见 RFC 主文档。

---

## v3 提案核心速览（自包含）

### 单入口与权威

- **单入口**：`CombatSession.dispatch(command): CombatTransition`，替代当前 EventBus/emitChain/modifyHp/nextTurn 等多条控制路径
- **唯一权威**：一个 CombatState，每个 Command 末尾**一次原子提交**（nextState + DomainEvent[] + waitFor?）
- **脚本不执行任意 JS**：物品/技能/buff 编译成 `EffectAutomaton`，在 typed `ReactionWindow` 读 immutable snapshot、返回**受限 EffectIntent batch**（原子范围，非法整批拒绝但不取消合法核心攻击）
- **dispatch 同步推进**到下一个 RequiredInput（PlayerCommand/EffectChoice/BoundedAdjudication/BeginOutput），内核不存 Promise、不挂 awaitPlayerInput
- **commandId + expectedRevision** 串行化并发、拒绝 stale、重复返回同结果、零状态变化零骰子消费

### EffectIntent 词汇

`Modifier` / `Outcome(DealDamage/Heal/ApplyStatus/RemoveStatus/SpendResource)` / `Override(closed RuleKey)` / `Permission(grantActionSlot 等)` / `SelectOrRetarget` / `Schedule(反伤/延迟/连锁)` / `SpawnOrDespawn` / `RequestChoice` / `PreventDeath` / `ConsumeCharge` / `SummonUnit` / `EmitNarrativeCue`

### 5 条不变量

1. 每单位每轮恰好 **1 攻击槽 + 1 动作槽**（跳过也消费）
2. 额外行动只能来自验证过的 **GrantActionSlot**
3. 所有随机数来自 **DiceTape**（保留原作每次输出 60 个 d20 顺序消费语义）
4. 所有 HP/资源/状态/行动槽变化**同一原子提交**
5. **CombatEnded + 奖励**按 `combatId + settlementId` 幂等

### 原版状态机（内核独占）

```
RoundOpen → 正面状态 tick → 战况总览 → 先攻 → UnitTurnOpen(消费攻击槽+动作槽)
→ 士气检查 → UnitTurnClose → 下一单位 → RoundClose(负面 tick/DoT) → 下一轮或 Terminal → SettlementCommitted
```

### 主人 2026-07-31 拍板

- **缺口 C**（召唤物当回合参战）→ 战斗中调 char_gen，由 char_gen 产出单位定义声明参战时机
- **缺口 F**（奇迹/概念抹杀开放性）→ 走 `BoundedAdjudication` 接口，战斗 Agent 自己判，内核只验边界（符合 ADR-11）
- **其余（A/B/D/E + 跨案例共识）**→ 打补丁

---

## v3 实机写法通用模式

5 场常规部分都跑通这个模式：

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

**与 v2 的差异**：v2 用 `scripts[]` + `$event.on` + handler 改共享 params；v3 用声明式 automaton + 订阅 typed window + 返回 intent batch（内核验证后解释），**不再有 `modifyHp()` / `nextTurn()` / 任意 JS**。

---

## 跨案例共识（2+ 个案例独立提出，可信度高）

1. **🎯 DiceTape 必须分通道**（case-06/case-24）：概率召唤、反伤命中的 d20 和普通命中 d20 共用 cursor 会错位整场后续命中结果，replay 无法对齐。建议拆 `attackHit / statusContest / procCheck / initiative` 多通道。
2. **🎯 DealDamage 必须加 `isReaction` + `bypass` 字段**（case-07/case-24）：reaction 伤害豁免槽位统计 + 真实伤害绕过管线。schema 硬伤。
3. **🎯 FP 跨边界方案**（case-06/case-09）：战斗开始 FP 快照进 CombatState 当本地权威，终局 diff 回 SaveProfile + journal 记 idempotencyKey 防重放。
4. **🎯 divinity 压制表要泛化**（case-09）：从穿透/DR 扩展到状态对抗/意图对抗。
5. **🎯 奇迹/概念抹杀应归叙事层 + BoundedAdjudication**（case-13/case-09，符合 ADR-11）：战斗内核只产 DomainEvent，奇迹效果投影给 Story Agent 展开。

---

## 相关资料

- **RFC 主文档**：[`../2026-07-31-combat-v3-real-sample-stress-test-rfc.md`](../2026-07-31-combat-v3-real-sample-stress-test-rfc.md)（6 类缺口 + 补丁方案 + M0-M5 落地路线）
- **v3 提案原文**：[`../2026-07-30-combat-kernel-v3-proposal.md`](../2026-07-30-combat-kernel-v3-proposal.md) + [`../../../../reference/战斗架构设计参考.txt`](../../../../reference/战斗架构设计参考.txt)
- **v2 现状架构**：[`../../../../docs/reference/combat-system-architecture.md`](../../../../docs/reference/combat-system-architecture.md)
- **战斗样本源**：[`../../../../reference/战斗对话样本/`](../../../../reference/战斗对话样本/)（24 场，本目录用其中 5 场）
