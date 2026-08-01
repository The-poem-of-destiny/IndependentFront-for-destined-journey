/**
 * combat-v3/phases/action.ts — 战术动作 / 逃跑 handler（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §二 2.2 / §四 4.5
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3 / §3.2
 *
 * M1 最小实现：
 *   - DeclareAction：战术动作（道具/移动/专注/防御），消费动作槽（consumeSlot 管）+ 产 NarrativeCue 事件
 *   - Flee：逃跑检定（从 statusContest 取骰，d20 + 敏捷 vs DC 12），成功 → Terminal(flee_success)，
 *     失败 → 消费攻击+动作槽，产 FleeAttempt
 *
 * 槽位消费统一由 unit-turn.consumeSlot 处理（A1-1 行动槽强制）；本文件只结算动作的数值/事件。
 */

import { draw } from '../dice-tape';
import { evaluateWindow } from '../windows';
import type { CombatCommand, CombatDefinitionBundle, CombatState } from '../types';
import { emptyChanges, type PhaseOutcome } from './outcome';

/** DeclareAction 的动作分支（架构 §二 2.2） */
export type TacticalActionType = 'item' | 'move' | 'focus' | 'defend';

/**
 * 结算一次 DeclareAction。
 * 该命令的 action 槽已由 consumeSlot 消费；这里只产事件（M1 最小版，无实质数值）。
 */
export function handleAction(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'DeclareAction' }>,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };

  evaluateWindow(state.activeEffects, 'action.declared', {
    selfId: command.actorId,
    round: state.round,
  });

  const actionType: TacticalActionType = command.payload.actionType;
  const actor = state.units[command.actorId];
  const actionName =
    actionType === 'item'
      ? '使用道具'
      : actionType === 'move'
        ? '移动'
        : actionType === 'focus'
          ? '专注'
          : '防御';

  out.events.push({
    kind: 'NarrativeCue',
    text: `${actor?.name ?? command.actorId} ${actionName}${command.payload.description ? `：${command.payload.description}` : ''}`,
  });

  return out;
}

/**
 * 结算一次逃跑（Flee，cost 'both'）。
 *
 * 检定：从 statusContest 取骰 → `d20 + 敏捷` ≥ DC 12 成功。
 * 成功 → Terminal(flee_success)；失败 → 两槽照常消费（consumeSlot 已扣），产 FleeAttempt(false)。
 */
export function handleFlee(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'Flee' }>,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };
  const actor = state.units[command.actorId];
  if (!actor) {
    out.rejection = { code: 'TARGET_NOT_PRESENT', message: '逃跑者不在场' };
    return out;
  }

  const r = draw(state.dice, 'statusContest', 1);
  if ('exhausted' in r) {
    out.requiredInput = { kind: 'BeginOutput', channel: 'statusContest' };
    return out;
  }
  out.dice = r.tape;
  const roll = r.rolls[0];

  const check = roll + actor.attributes.dex;
  const success = check >= 12;

  out.events.push({ kind: 'FleeAttempt', unitId: actor.id, success, roll });

  if (success) {
    out.nextPhase = 'Terminal';
    out.terminal = { reason: 'flee_success', winner: undefined };
  } else {
    out.nextPhase = 'SlotConsume';
  }
  return out;
}
