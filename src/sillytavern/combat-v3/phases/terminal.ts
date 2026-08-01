/**
 * combat-v3/phases/terminal.ts — 终局判定 + settlement（C3 幂等）（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十四 14.2 / §三 3.5 不变量⑤ / §十二
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.2 / §3.5（C3 / M-A1-6 / A1-7）
 *
 * 终局四出口（验收 A1-6）：
 *   1. hp_zero        —— 一方（玩家或敌方）全灭
 *   2. morale_routed  —— 士气溃逃（unit-turn.runMoraleCheck 触发）
 *   3. flee_success   —— 逃跑成功（action.handleFlee 触发）
 *   4. force_terminal —— 强制终局（概念级，第 09 场，rule-keys 注册）
 *
 * checkTerminal(state)：返回 TerminalReason | null。dispatch 进入 Terminal 相位后
 * **只接受 RequestSettlement**（A1-6）。
 *
 * settle(bundle, state, settlementId)：C3 幂等 —— 同 settlementId 二次调用返回既有
 * SettlementResult，不产生第二套 EXP/FP（A1-7）。M1 只结算 FP 净变动（快照 FP − 初始 FP），
 * EXP/战利品由 M2 settlement.before 窗口/coordinator 补。
 */

import type { CombatDefinitionBundle, CombatState, TerminalReason } from '../types';
import { emptyChanges, type PhaseOutcome } from './outcome';

/**
 * 判定终局（四出口）。若命中返回 reason + winner；否则 null。
 *
 * 优先顺序：
 *   1. force_terminal —— 若 state.terminal 已设定（内核内部 forceTerminal 触发）
 *   2. hp_zero —— 玩家全灭 → winner 'enemy'；敌方全灭 → winner 'player'
 *   3. morale_routed / flee_success —— state.terminal 已由 phases 设定
 *
 * 注意：hp_zero 由本函数判定；morale/flee 由前置 phase 用 out.terminal 设定、进 Terminal。
 */
export function checkTerminal(
  state: CombatState,
): { reason: TerminalReason; winner?: string } | null {
  // 已显式设定的终局（morale_routed / flee_success / force_terminal）
  if (state.terminal) {
    return state.terminal;
  }

  const units = Object.values(state.units);
  if (units.length === 0) return null;

  const alive = units.filter((u) => u.hp > 0);
  if (alive.length === 0) return null;

  const playerAlive = alive.some((u) => u.side === 'player');
  const enemyAlive = alive.some((u) => u.side === 'enemy');

  if (!playerAlive) return { reason: 'hp_zero', winner: 'enemy' };
  if (!enemyAlive) return { reason: 'hp_zero', winner: 'player' };

  return null;
}

/**
 * 判定是否应进入 Terminal 相位（供 reducer 每步后调用）。
 * 返回 null 表示战斗继续。
 */
export function shouldEnterTerminal(state: CombatState): TerminalReason | null {
  return checkTerminal(state)?.reason ?? null;
}

/**
 * 结算（C3 幂等）。
 *
 * - 若 state.settlementId 已存在（该 settlementId 已结算过）→ 返回既有结果，不重算（A1-7）
 * - 否则按 settlementId 计算 FP 净值，写入 state.settlement + settlementId + SettlementCommitted 事件
 *
 * 返回 PhaseOutcome，nextPhase 恒 'SettlementCommitted'。
 */
export function settle(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  settlementId: string,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SettlementCommitted',
  };

  // C3 幂等：同 settlementId 已结算过 → 返回既有结果（不产生第二套奖励）
  if (state.settlementId === settlementId && state.settlement) {
    out.changes.fpDelta = 0; // 不重复记账
    out.settlement = {
      settlementId: state.settlement.settlementId,
      fpDelta: state.settlement.fpDelta,
      reason: state.settlement.reason,
      winner: state.settlement.winner,
    };
    out.settlementId = settlementId;
    out.nextPhase = 'SettlementCommitted';
    out.events.push({
      kind: 'NarrativeCue',
      text: `settlement 已提交（幂等重放，id=${settlementId}，FP 不重复结算）`,
    });
    return out;
  }

  const initialFp = bundle.resourceSnapshots.FP;
  const currentFp = state.resourceSnapshots.FP;
  const fpDelta = currentFp - initialFp;

  const terminal = checkTerminal(state);

  out.changes.fpDelta = 0; // FP 净变动在 settle 终结时一次性记账（幂等键）
  out.events.push({
    kind: 'CombatEnded',
    reason: terminal?.reason ?? 'force_terminal',
    winner: terminal?.winner,
  });
  out.events.push({
    kind: 'NarrativeCue',
    text: `战斗结算：FP 净变动 ${fpDelta}`,
  });

  // 写入 settlement 结果（幂等键 idempotencyKey）
  out.settlement = {
    settlementId,
    fpDelta,
    reason: terminal?.reason ?? 'force_terminal',
    winner: terminal?.winner,
  };
  out.settlementId = settlementId;

  return out;
}
