---
name: combat-v3-m4-part2-harness-wiring
description: 战斗 v3 M4 第二部分已落地：窗口接线层（反射/PreventDeath 排进原子提交）+ replayCombat 升级为真内核 contract harness；case-24/x1/x2/09 真机跑通，06/13 归 M5
metadata:
  type: project
---

战斗中 v3 M4 第二部分（2026-08-01）已完成并全绿（5240 tests / typecheck 0）。工作区 `src/sillytavern/combat-v3/`。

**① 窗口接线层**：`phases/attack.ts` `finalizeAttack` 的 ⑨ `damage.after` 现在不再丢弃 `evaluateWindow` 结果 —— `applyAfterWindow` 把守方（`raw.owner === defender.id` 门控）的反射 `ScheduleIntent` 排进同一原子提交（`out.changes.hpChanges` + `DamageReflected` 事件），R8 命中骰从 `attackHit` 通道 draw；非反射 intent（Heal/SpendResource 等）经 `applyIntents` 并入。`windows.ts` `resolveNumber` 升级为 `parseExpression → evaluate → fallback`（错误隔离），`makeWindowRuntimeCtx` 支持 `damage` 覆盖。

**② replayCombat 升级**：从 M0 空转 → 驱动真实内核（`openCombat` + dispatch 循环）。RequiredInput 自动应答：BeginOutput→epochs 下一条 SupplyDice、PlayerCommand→commands 顺序消费、EffectChoice/CharGenRequest/BoundedAdjudication→`fixture.harnessInputs`。eventHash 基于 DomainEvent 序列（`hashEvents`）。fixture 单位带 `effects[]`（builtins，反伤）或 `automata[]`（DSL 编译，PreventDeath/freezeSlot）。

**Why:** M0 空转无法验证机制，M4 需 contract test 断言真实内核产出。反射/PreventDeath 之前窗口 intents 被丢弃（见 [[combat-v3-reflection-window-intents-not-wired]]，现已修）。

**How to apply / M4 闭合状态（2026-08-01 后续）**：遗留 4 缺口已全部闭合（5245 tests 全绿，typecheck 0）——
- case-x1 互反熔断：`attack.ts` `reflectChain` 链式反伤已接通。受击方反伤落地后以「反伤为新一轮伤害源」递归查对方被动（depth 递增），`resolveReflection` 在 depth≥2 返回 mutual_cancel + '反射湮灭'。`applyReflectionIntent` 改为显式 depth 参数 + 返回 landed；`DamageReflected.depth` 用本轮深度（首次反伤=1）非 nextDepth。
- case-09 forceTerminal：`reducer.adjudicate()` 在 ruleKey==='terminal.forceTerminal' 时把 `state.terminal={reason:'force_terminal'}` 落定，后续 runDispatch 的 checkTerminal 拾取进 Terminal。replay harness `nextPlayerCommand` 新增认 `Adjudicate` 命令（reducer 顶层路由，case-09 fixture 的 scripts 命令序列触发）。
- case-06 summon：召唤 automaton（action.declared 窗 → SpawnOrDespawnIntent + SpendResource(FP,100)）挂召唤师；DebareAction 命令 + harnessInputs.summons 提供 SummonedUnitDefinition（this_round_tail）。fpDelta milestone 语义注意：assertMilestone 用 `net=-total`，扣 100 要写 value=-100。
- case-13 freezeSlot：`openUnitTurn` 新增 `applyTurnOpenIntents` —— 求值 turn.open 窗口 → OverrideIntent(freezeSlot) 经 applyIntents 写 freezeSlotPatches → applyPending 合并 frozenSlots → 后续单位 openUnitTurn 读 frozenSlots 不发槽。freeze automaton trigger 用 `ctx.self.id == '时间收割者'` 只在自己回合触发。

**How to apply / 遗留 (M5)**：unit-turn.ts openUnitTurn 现在求值 turn.open 窗口（freezeSlot 用）；Attack 反射链已闭。再列：
- case-24/x1/x2/09：真实跑通（反射 depth=1+互反、PreventDeath、基本攻击、forceTerminal）。
- 守方 automaton divinity 必须 ≤ 单位 `divinity` 字段（compile #5 DIVINITY_EXCEEDED 剔除）——case-x2 曾因缺 `divinity` 字段导致复活 automaton 被剔除。

相关：[[combat-v3-m4-mechanism-done]] [[combat-v3-reflection-window-intents-not-wired]] [[combat-v3-m0-signature-refactor]]
