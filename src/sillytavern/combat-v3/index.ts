/**
 * combat-v3/index.ts — 唯一公共出口（deep module，架构 §十四 14.1）
 *
 * 只导出：
 *   - openCombat(input: NewCombat | RestoreCombat): CombatSession
 *   - 公共类型：CombatCommand / CombatTransition / CombatView / DomainEvent /
 *     RequiredInput / CombatSession
 *
 * 一切 internal（reducer / state / dice-tape / phases / windows / coordinator /
 * projection-*）一律不导出。业务调用方（game-pipeline / game-store / 前端）
 * 只认识 openCombat 与这几个类型。reducer、tape、windows、automata 全部 internal。
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十四 14.1
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §1.2 / §4.2
 */

import { createSession } from './kernel';
import type { CombatDefinitionBundle, CombatSession, CombatState } from './types';
import { runCombatV3 } from './coordinator';

/** 开战入参：新建一场战斗（NewCombat） */
export interface NewCombat {
  kind: 'new';
  bundle: CombatDefinitionBundle;
}

/** 开战入参：恢复一场之前冻结的战斗（RestoreCombat） */
export interface RestoreCombat {
  kind: 'restore';
  state: CombatState;
  bundle: CombatDefinitionBundle;
}

/**
 * 开启一场战斗（业务侧唯一入口，架构 §十四 14.1）。
 *
 * - NewCombat：用 bundle 从零建 CombatState（createCombatState）
 * - RestoreCombat：用既有 CombatState 恢复（replay / 续跑场景）
 */
export function openCombat(input: NewCombat | RestoreCombat): CombatSession {
  if (input.kind === 'new') {
    return createSession(input.bundle);
  }
  return createSession(input.bundle, input.state);
}

/** Coordinator 驱动入口 —— 业务侧（game-pipeline）跑整场 v3 战斗的公共 seam（架构 §十四 14.3） */
export { runCombatV3 };
export type {
  CombatCommand,
  CombatTransition,
  CombatView,
  DomainEvent,
  RequiredInput,
  CombatSession,
  CombatDefinitionBundle,
} from './types';
export type { CombatV3Result, RunCombatV3Opts } from './coordinator';
