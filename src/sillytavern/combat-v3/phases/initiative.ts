/**
 * combat-v3/phases/initiative.ts — 先攻 handler（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §四 4.5（先攻每单位一颗 initiative 骰）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3 / §6 注意点 3
 *
 * 掷先攻：从 `initiative` 通道给每个在场存活单位取一颗骰，调 v2 纯函数 `rollInitiative`
 * 构造 CombatUnitTurn，按先攻总值从高到低排序，平手用名字字典序（确定性）。
 *
 * **必须避免 v2 `rollAndSortInitiative` 的随机骰兜底**（combat-turn.ts:55）：
 * v3 自己掷骰（从 initiative 通道取够），绝不调 rollAndSortInitiative。
 *
 * 若 initiative 通道耗尽 → 返回 requiredInput BeginOutput（coordinator 续杯）。
 */

import { draw } from '../dice-tape';
import { rollInitiative } from '../../combat-turn';
import type { CombatDefinitionBundle, CombatState, CombatUnitState } from '../types';
import type { CombatParticipant } from '../../types';
import { emptyOutcome, type PhaseOutcome } from './outcome';

/**
 * 掷一轮先攻。骰值从 `initiative` 通道取每单位一颗；排序按总值降序、
 * 平手按名字字典序（确定性，架构 §四 4.6 replay 前提）。
 *
 * 返回 PhaseOutcome：dice 为新 tape（若掷骰）、initiativeOrder 为排序后序列、
 * nextPhase 恒 'UnitTurnOpen'。骰带耗尽则 requiredInput: BeginOutput。
 */
export function handleInitiative(bundle: CombatDefinitionBundle, state: CombatState): PhaseOutcome {
  const out = emptyOutcome('UnitTurnOpen');

  const ids = state.initiativeOrder.length > 0 ? state.initiativeOrder : Object.keys(state.units);

  const unitIds = ids.filter((id) => {
    const u = state.units[id];
    return !!u && u.hp > 0;
  });

  // 从 initiative 通道逐单位取骰
  const rolls: number[] = [];
  let tape = state.dice;
  let diceExhausted = false;
  for (const _ of unitIds) {
    const r = draw(tape, 'initiative', 1);
    if ('exhausted' in r) {
      diceExhausted = true;
      break;
    }
    rolls.push(r.rolls[0]);
    tape = r.tape;
  }

  if (diceExhausted) {
    out.dice = tape;
    out.requiredInput = { kind: 'BeginOutput', channel: 'initiative' };
    return out;
  }

  // 构造 CombatUnitTurn 并排序
  const turns = unitIds.map((id, i) => {
    const u = state.units[id];
    return rollInitiative(toParticipant(u), rolls[i]);
  });

  const sorted = [...turns].sort((a, b) => {
    if (b.totalInitiative !== a.totalInitiative) return b.totalInitiative - a.totalInitiative;
    return a.name.localeCompare(b.name, 'zh');
  });

  const order = sorted.map((t) => t.characterId);

  out.dice = tape;
  out.initiativeOrder = order;
  out.currentTurnIndex = 0;
  out.events.push({
    kind: 'InitiativeRolled',
    round: state.round,
    order: sorted.map((t) => ({
      unitId: t.characterId,
      value: t.totalInitiative,
      roll: t.d20Roll,
    })),
  });

  return out;
}

/**
 * 把 CombatUnitState 映射成 rollInitiative 需要的 CombatParticipant 形状。
 * v3 自己构造，不依赖 v2 的 turn 结构。side 映射 'player'→'ally' / 'enemy'→'enemy'。
 */
export function toParticipant(u: CombatUnitState): CombatParticipant {
  return {
    characterId: u.id,
    name: u.name,
    tier: u.tier,
    level: u.level,
    attributes: { ...u.attributes },
    hp: u.hp,
    maxHp: u.maxHp,
    mp: u.mp,
    maxMp: u.maxMp,
    sp: u.sp,
    maxSp: u.maxSp,
    defense: u.defense,
    dr: u.dr,
    penetration: u.penetration,
    hitBonus: u.hitBonus,
    dodgeBonus: u.dodgeBonus,
    speedModifiers: [...u.speedModifiers],
    fixedInitiativeBonus: u.fixedInitiativeBonus,
    attacksRemaining: u.attacksRemaining,
    actionsRemaining: u.actionsRemaining,
    statusEffects: u.statusEffects,
    weaponAtk: u.weaponAtk,
    side: u.side === 'player' ? 'ally' : 'enemy',
    canAct: u.canAct,
    morale: u.morale,
  };
}
