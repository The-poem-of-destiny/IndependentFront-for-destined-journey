/**
 * combat-v3/phases/round.ts — RoundOpen / RoundClose handler（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §五 5.1（round.open / round.close 窗口）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3 / §3.5（M-1）
 *
 * M-1 修复：buff tick 挂 `round.open`（增益） / `round.close`（减益 + DoT）；
 * `remainingTime` 真实递减并到期移除（验收 A1-5）。
 *
 * M1 用最小 buff 语义：
 *   - round.open：所有「增益」/「periodicPositive」类别且 remainingTime !== null 的 buff
 *     remainingTime -1；remainingTime 归 0 则移除（StatusExpired）
 *   - round.close：同 round.open，但针对「减益」与 DoT（effects 里的数值按回合扣血）
 *
 * windows 调用点就位（evaluateWindow('round.open' / 'round.close')），M3 接索引。
 */

import type { CombatDefinitionBundle, CombatState, PendingChangeSet, StatusPatch } from '../types';
import type { DomainEvent } from '../types';
import { evaluateWindow } from '../windows';
import type { PhaseOutcome } from './outcome';
import { emptyChanges } from './outcome';

/**
 * RoundOpen：结算增益 tick（M-1）。
 * 返回 PendingChangeSet + DomainEvents + 下一步 phase = 'Initiative'（架构 §2.4）。
 */
export function handleRoundOpen(
  bundle: CombatDefinitionBundle,
  state: CombatState,
): {
  changes: PendingChangeSet;
  events: DomainEvent[];
  nextPhase: 'Initiative';
} {
  const changes: PendingChangeSet = {
    hpChanges: {},
    mpChanges: {},
    spChanges: {},
    fpDelta: 0,
    statusPatches: [],
    slotConsumptions: [],
  };
  const events: DomainEvent[] = [];

  events.push({ kind: 'RoundOpened', round: state.round });

  // round.open 窗口（M3 接索引，M1 空转）
  evaluateWindow(state.activeEffects, 'round.open', { selfId: undefined, round: state.round });

  // 增益 buff tick：remainingTime 递减，到期移除
  applyBuffTick(state, changes, events, 'positive', 'round.open');

  return { changes, events, nextPhase: 'Initiative' };
}

/**
 * RoundClose：结算减益 / DoT + 到期移除（M-1）。
 * 返回 PhaseOutcome + 下一 phase（RoundOpen 推进，round+1）。
 */
export function handleRoundClose(bundle: CombatDefinitionBundle, state: CombatState): PhaseOutcome {
  const changes: PendingChangeSet = {
    hpChanges: {},
    mpChanges: {},
    spChanges: {},
    fpDelta: 0,
    statusPatches: [],
    slotConsumptions: [],
  };
  const events: DomainEvent[] = [];

  // round.close 窗口（M3 接索引，M1 空转）
  evaluateWindow(state.activeEffects, 'round.close', { selfId: undefined, round: state.round });

  // 减益 buff tick + DoT
  applyBuffTick(state, changes, events, 'negative', 'round.close');

  events.push({ kind: 'RoundClosed', round: state.round });

  // 推进到下一轮（round +1）
  return { changes, events, nextPhase: 'RoundOpen', round: state.round + 1 };
}

// ──────────────────────────────────────────────────────────────────────────────
// buff tick 实现（M-1）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 对所有带 remainingTime 的 buff 做一次回合 tick：
 *   - 类别匹配 direction（增益/减益）时递减 remainingTime
 *   - remainingTime 归 0 → 移除 + StatusExpired
 *   - DoT（减益 + effects.damagePerRound>0）每回合扣对应 HP
 */
function applyBuffTick(
  state: CombatState,
  changes: PendingChangeSet,
  events: DomainEvent[],
  direction: 'positive' | 'negative',
  _windowKey: 'round.open' | 'round.close',
): void {
  const units = state.units;

  for (const [id, unit] of Object.entries(units)) {
    if (unit.statusEffects.length === 0) continue;

    for (const buff of unit.statusEffects) {
      // 只处理有生命周期（remainingTime !== null，timeUnit === '回合'）的战斗型 buff
      if (buff.remainingTime === null || buff.timeUnit !== '回合') continue;

      const isPositive = buff.category === '增益';
      const matches = direction === 'positive' ? isPositive : !isPositive;

      if (!matches) continue;

      const newTime = buff.remainingTime - 1;

      // DoT：减益 + 定义 damagePerRound
      const dot = buff.effects?.damagePerRound ?? buff.effects?.dotPerRound ?? 0;
      if (direction === 'negative' && dot > 0) {
        changes.hpChanges[id] = (changes.hpChanges[id] ?? 0) - dot;
      }

      if (newTime <= 0) {
        // 到期移除（M-1 验收 A1-5）
        changes.statusPatches.push({ op: 'remove', unitId: id, statusId: buff.name });
        events.push({ kind: 'StatusExpired', unitId: id, statusId: buff.name });
      } else {
        // remainingTime 写回（M-1：buff remainingTime 真实递减）
        changes.statusPatches.push({
          op: 'apply',
          unitId: id,
          status: { ...buff, remainingTime: newTime },
        });
      }
    }
  }
}

// 只导出供 reducer 使用
export type RoundOutcome = ReturnType<typeof handleRoundOpen>;
