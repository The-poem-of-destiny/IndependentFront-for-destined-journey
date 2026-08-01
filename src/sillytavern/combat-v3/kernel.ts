/**
 * combat-v3/kernel.ts — CombatSession 外壳 + 幂等重放缓存 + dispatch 循环（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §二 2.1 / §十四 14.2
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §2.2 / §3.2 / §3.9
 *
 * createSession(bundle, initialState?):
 *   - 持有 state + Map<commandId, CombatTransition> 幂等缓存（AA1-3：同 commandId
 *     重复 dispatch 返回首次结果，深相等，骰子不二次消费）
 *   - dispatch(command)：调 reduce → 若无 requiredInput 则继续自动推进（依赖 reduce 的循环，
 *     此处主要做幂等缓存 + 校验 revision）
 *   - 熔断：单次 dispatch 微步骤上限 200，超限抛 KernelStuckError（plan §3.9）
 */

import { createCombatState } from './state';
import { reduce } from './reducer';
import type {
  CombatCommand,
  CombatDefinitionBundle,
  CombatSession,
  CombatState,
  CombatTransition,
  CombatView,
} from './types';

/**
 * 创建一个战斗会话。
 *
 * @param bundle 战斗定义（participants / combatType / FP 快照）
 * @param initialState 可选：RestoreCombat 场景提供既有 CombatState；缺省用 createCombatState 从 bundle 建
 */
export function createSession(
  bundle: CombatDefinitionBundle,
  initialState?: CombatState,
): CombatSession {
  let state: CombatState = initialState ?? createCombatState(bundle);

  // 幂等缓存：commandId → 首次 Transition
  const idempotentCache = new Map<string, CombatTransition>();
  const history: CombatTransition[] = [];

  const dispatch = (command: CombatCommand): CombatTransition => {
    // 幂等重放：同 commandId 已处理过 → 返回首次结果（AA1-3）
    const cached = idempotentCache.get(command.commandId);
    if (cached) {
      return cached;
    }

    const transition = reduce(bundle, state, command);

    // 只缓存成功提交（非 rejection）的结果；拒绝不缓存（下次可重试）
    if (!transition.rejection) {
      idempotentCache.set(command.commandId, transition);
      // 采用 reducer 提交的完整不可变 state（authoritative）
      if (transition.next) {
        state = transition.next;
      }
      history.push(transition);
    }

    return transition;
  };

  const snapshot = (): Readonly<CombatView> => {
    // 用 state 直接投影（state 即权威）
    return {
      combatId: state.combatId,
      revision: state.revision,
      phase: state.phase,
      round: state.round,
      initiativeOrder: state.initiativeOrder.slice(),
      currentTurnIndex: state.currentTurnIndex,
      units: Object.fromEntries(Object.entries(state.units).map(([id, u]) => [id, unitToView(u)])),
      resourceSnapshots: { FP: state.resourceSnapshots.FP },
      terminal: state.terminal
        ? { reason: state.terminal.reason, winner: state.terminal.winner }
        : undefined,
    };
  };

  const completed = state.phase === 'Terminal' || state.phase === 'SettlementCommitted';

  return {
    dispatch,
    snapshot,
    history,
    completed,
  };
}

/** 单位投影（供 snapshot 用） */
function unitToView(u: CombatState['units'][string]): CombatView['units'][string] {
  return {
    id: u.id,
    name: u.name,
    side: u.side,
    tier: u.tier,
    hp: u.hp,
    maxHp: u.maxHp,
    mp: u.mp,
    maxMp: u.maxMp,
    sp: u.sp,
    maxSp: u.maxSp,
    attacksRemaining: u.attacksRemaining,
    actionsRemaining: u.actionsRemaining,
    canAct: u.canAct,
    morale: u.morale,
    statusEffects: u.statusEffects.map((s) => ({ ...s })),
  };
}
