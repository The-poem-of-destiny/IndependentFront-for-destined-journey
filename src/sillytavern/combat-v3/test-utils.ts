/**
 * combat-v3/test-utils.ts — M1 测试共享构造工具
 *
 * 构造最小 2 单位 bundle + 便于 dispatch 的命令，供各测试复用。
 * 甲方（player）vs 乙方（enemy），双方槽位初 0、canAct true。
 */

import type { CombatParticipant, CombatDefinitionBundle, CombatCommand } from './types';

/** 构造一个最小 CombatParticipant（tier 可调） */
export function mkParticipant(
  id: string,
  opts: Partial<CombatParticipant> = {},
): CombatParticipant {
  const p: CombatParticipant = {
    characterId: id,
    name: id,
    tier: 3,
    level: 10,
    attributes: { str: 20, dex: 15, con: 15, int: 10, spi: 10 },
    hp: 500,
    maxHp: 500,
    mp: 100,
    maxMp: 100,
    sp: 50,
    maxSp: 50,
    defense: 100,
    dr: 0.1,
    penetration: 0,
    hitBonus: 10,
    dodgeBonus: 5,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 0,
    actionsRemaining: 0,
    statusEffects: [],
    weaponAtk: 50,
    side: 'ally',
    canAct: true,
    ...opts,
  };
  return p;
}

/** 构造 2 单位（甲 player / 乙 enemy）的默认 bundle */
export function mkBundle(overrides: Partial<CombatDefinitionBundle> = {}): CombatDefinitionBundle {
  const bundle: CombatDefinitionBundle = {
    combatId: 'test-combat',
    combatType: '标准',
    participants: [
      mkParticipant('甲'),
      mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
    ],
    resourceSnapshots: { FP: 1000 },
    rulesetRevision: 'v3-m1-test',
    ...overrides,
  };
  return bundle;
}

/** DeclareAttack 的可选载荷（测试写法宽松） */
export interface AttackOpts {
  intentionLevel?: string;
  nonLethal?: boolean;
  costs?: { mp?: number; sp?: number };
}

/** 构造一个 DeclareAttack 命令 */
export function mkAttack(
  commandId: string,
  expectedRevision: number,
  actorId: string,
  targetId: string,
  opts: AttackOpts = {},
): CombatCommand {
  return {
    commandId,
    expectedRevision,
    kind: 'DeclareAttack',
    actorId,
    cost: 'attack',
    payload: {
      targetId,
      intentionLevel: (opts.intentionLevel ?? '常规') as never,
      nonLethal: opts.nonLethal,
      costs: opts.costs,
    },
  } as CombatCommand;
}

/** 构造 PassAttack / PassAction */
export function mkPass(
  commandId: string,
  expectedRevision: number,
  actorId: string,
  slot: 'attack' | 'action',
): CombatCommand {
  return {
    commandId,
    expectedRevision,
    kind: slot === 'attack' ? 'PassAttack' : 'PassAction',
    actorId,
    cost: slot,
    payload: {},
  } as CombatCommand;
}

/** 构造 EndTurn（结束回合：放弃当前单位全部剩余槽位，cost none） */
export function mkEndTurn(
  commandId: string,
  expectedRevision: number,
  actorId: string,
): CombatCommand {
  return {
    commandId,
    expectedRevision,
    kind: 'EndTurn',
    actorId,
    cost: 'none',
    payload: {},
  } as CombatCommand;
}

/** 构造 RequestSettlement */
export function mkSettle(
  commandId: string,
  expectedRevision: number,
  settlementId: string,
): CombatCommand {
  return {
    commandId,
    expectedRevision,
    kind: 'RequestSettlement',
    actorId: '甲',
    cost: 'none',
    payload: { settlementId },
  } as CombatCommand;
}

/** 构造 DeclareAction */
export function mkAction(
  commandId: string,
  expectedRevision: number,
  actorId: string,
  actionType: 'item' | 'move' | 'focus' | 'defend',
): CombatCommand {
  return {
    commandId,
    expectedRevision,
    kind: 'DeclareAction',
    actorId,
    cost: 'action',
    payload: { actionType },
  } as CombatCommand;
}
