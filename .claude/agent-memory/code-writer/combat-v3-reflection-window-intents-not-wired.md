---
name: combat-v3-reflection-window-intents-not-wired
description: 战斗 v3 M4 发现：attack.ts finalizeAttack 的 damage.after/unit.beforeDown 窗口 intents 被丢弃，反射/PreventDeath 端到端未打通；replay 需先接这层
metadata:
  type: project
---

战斗 v3 M4（2026-08-01）做机制层时确认的真实缺口：`src/sillytavern/combat-v3/phases/attack.ts` 的 `finalizeAttack` 里，`damage.after` 与 `unit.beforeDown` 窗口的 `evaluateWindow(...)` 返回值**完全被丢弃**——反射（case-24/x1）与 death.threshold（case-07/x2）的 intent 目前根本没进 pendingChanges。

**Why:** `applyIntents` 只在 `intents.test.ts` / `automata/reflection.test.ts` 单测里被调用，**没有接线进 attack.ts**（reflection.test.ts 传的是手工 `ctx2 = { ...ctx, reflectDepth }`，不是内核路径）。反伤命中骰（R8 attackHit 通道）也没在 damage.after 消费。

**How to apply:** M4 续跑时，replay harness 要驱动真实内核出 case-24/case-x1，必须先补「窗口 intents → applyIntents 集成为一个子结算」这层（架构 §九 R1-R8 要求 damage.after 把反伤 ScheduleIntent 排进同一原子提交；R4 基准取 preReduction）。配套的窗口 ctx 分型（interpreter.ts `WINDOW_ROOTS` 已齐全）与 `makeWindowRuntimeCtx.resolveNumber`（当前非数字表达式一律 fallback）也因窗口 intents 未接线而闲置。参考 [[combat-v3-proposal-pending]] 的 C/开放性裁决背景，窗口去重（M-8 按 statusId 含上级前缀）在 applyPending 已按 `s.name` 合并。

相关：[[combat-v3-m2-kernel-behaviors]] [[combat-v3-m1-kernel-architecture]]
