---
name: combat-v3-m4-mechanism-done
description: 战斗 v3 M4 机制层（A4-3/A4-4）已全绿：rule-keys 4锁 + divinity压制 + freezeSlot + death.threshold，32 新测试；replay/7fixture/contract 留续跑
metadata:
  type: project
---

战斗 v3 M4 的**机制层**（2026-08-01 完成，32 新测试全绿，typecheck 0 错误，全量 5217 tests 通过）：

- `rule-keys.ts`：四把 RuleKey 全注册（terminal.forceTerminal / morale.forceState / action.freezeSlot / death.threshold），`resolveOverride` 从 M1 空转改真正解析（门槛≥5 + 按 key 定型 payload + merge policy），新增 `divinitySuppression(atk,def)`（差1~4→±0.2/0.4/0.6/0.8，≥5→`{certain:true}`）与 `suppressionAsModifier`。
- `phases/attack.ts` check.intent：A4-4 divinity 压制（差≥5 必成/必败**不消费 intentCheck 骰**，cursor 不进；1~4 作为攻方 value 加值）。
- `intents.ts` ApplyStatus.contest：A4-4 状态对抗压制（守方 div 高≥5 → 状态不施加）。
- `CombatState.frozenSlots` + `PendingChangeSet.freezeSlotPatches`：A4-3 freezeSlot 引擎（OverrideIntent → applyPending max_rounds 合并 → openUnitTurn 强制不发冻结槽 → round.close 递减）。
- `phases/attack.ts` unit.beforeDown：A4-3 death.threshold（PreventDeath slot='death.threshold' → DamagePrevented + HP 截断到保留值，不产 UnitDowned）。

**Why:** 这是 M4 的「机制」半，A4-1/A4-2/A4-5/A4-6（replay harness + 7 fixture + contract 测试 + eventHash 冻结）是「样本回推」半，依赖 [[combat-v3-reflection-window-intents-not-wired]] 的窗口 intents 接线 + 5 场脑测案例读档，需单独迭代。

**How to apply:** 续跑 M4 时：先补窗口 intents→applyIntents 集成层（反射/R8 命中骰 + death.threshold 端到端），再升级 replay.ts 用 `reduce()` 直驱（非 createSession，要拿完整 next.state + events），再按 5 案例写 fixture（现有 3 个 concept fixture 是 M0 旧类型 `attrs`/`programs`/`UseSkill`，与当前内核契约不符，需按 FixtureBundle/FixtureUnit 重写）。

相关：[[combat-v3-reflection-window-intents-not-wired]] [[combat-v3-m1-kernel-architecture]] [[combat-v3-m2-kernel-behaviors]]
