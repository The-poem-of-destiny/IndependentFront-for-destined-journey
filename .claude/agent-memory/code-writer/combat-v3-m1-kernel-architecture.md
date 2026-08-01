---
name: combat-v3-m1-kernel-architecture
description: M1 内核骨架的关键架构落点——reducer 在 transition 里回传完整 next state、PhaseOutcome 单次提交、closeUnitTurn 线性推进；M2+ 接线必读
metadata:
  type: project
---

战斗 v3 M1（feat/combat-v3-m1）内核骨架已实现（2026-08-01）。几个 load-bearing 设计决策，M2+ 接线必修改时直接采信：

- **`CombatTransition.next?: CombatState`**（types.ts）——reducer 是纯函数不持有 state，但 kernel 跨 dispatch 需要完整权威状态。reducer 内部循环把每个 phase 的 `applyOutcome` 提交到的 `working` 归一为 `revision = 入参.revision + 1`（**一次 Command 只 +1 revision，即使内跨多个 auto phase**），通过 `transition.next` 回传给 kernel。`snapshot` 只是 `next` 的只读投影。
- **PhaseOutcome 统一产出**（`phases/outcome.ts`）：`{ changes: PendingChangeSet, events, nextPhase, dice?, requiredInput?, terminal?, settlement?, settlementId?, round?, rejection? }`。reducer 循环累加。`changes.statusPatches` / `slotConsumptions` 是**可变数组**（phases push），`turnOpenSlots` 发槽用。
- **closeUnitTurn 线性推进**（unit-turn.ts）——按 initiative 顺序 index 只前进不回头；死亡/失能单位在「自己的」UnitTurnOpen 里发 0 槽并自动跳到下一位。**别按"还有剩余槽"跳过**——未开回合的单位槽是 0，会被误判成已处理完（本喵踩过这个坑，见 phases.test 那次的 reject）。
- **reducer 需要 `commandUsed` 标志**——一次 dispatch 消费一个 PlayerCommand 后，后续 auto 推进再撞到 SlotConsume 必须返回 PlayerCommand（继续等），不能拿着同一个命令再消费。之前简化时去掉它导致"非当前单位"误拒。

**Bug 修复落点**（M1 内）：目标/执行者在场**早期校验**（reduce 内 `validateEarly`）必须在 dispatch 循环前，否则 auto 相位先产事件、A1-2"拒绝须零事件"就破了。

相关：[[combat-v3-proposal-pending]]（v3 提案评估）。A1-1~A1-10 全部由 reducer/phases/terminal/state/kernel 五组测试覆盖（4792 tests 全绿，typecheck 0 错误）。
