/**
 * combat-v3/phases/round.ts — RoundOpen / RoundClose handler（M1/M3.5）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §五 5.1（round.open / round.close 窗口）/ §十 10.3
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3 / §3.5（M-1）/ §6.2（A35-3）
 *
 * M-1 修复：buff tick 挂 `round.open`（增益） / `round.close`（减益 + DoT）；
 * `remainingTime` 真实递减并到期移除（验收 A1-5）。
 *
 * M3.5 扩展（A35-3）：召唤物「召唤时限」到期在 **round.close** 移除——
 *   产 UnitDespawned + 从 ActiveEffectIndex 摘除其 automaton（updateIndex removeIds）。
 *   召唤时限 buff 语义独立于通用 buff tick（它在 round.close 而非 round.open 到期）。
 *
 * M1 用最小 buff 语义：
 *   - round.open：所有「增益」/「periodicPositive」类别且 remainingTime !== null 的 buff
 *     remainingTime -1；remainingTime 归 0 则移除（StatusExpired）
 *   - round.close：同 round.open，但针对「减益」与 DoT（effects 里的数值按回合扣血）
 *
 * windows 调用点就位（evaluateWindow('round.open' / 'round.close')），M3 接索引。
 */

import type {
  ActiveEffectIndex,
  CombatDefinitionBundle,
  CombatState,
  DomainEvent,
  FrozenSlot,
  PendingChangeSet,
  StatusPatch,
} from '../types';
import { evaluateWindow, makeWindowRuntimeCtx } from '../windows';
import { updateIndex } from '../automata/index-active';
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
  evaluateWindow(
    state.activeEffects,
    'round.open',
    makeWindowRuntimeCtx(state, { selfId: undefined, round: state.round, window: 'round.open' }),
  );

  // 增益 buff tick：remainingTime 递减，到期移除
  applyBuffTick(state, changes, events, 'positive', 'round.open');

  return { changes, events, nextPhase: 'Initiative' };
}

/**
 * RoundClose：结算减益 / DoT + 到期移除（M-1）+ 召唤物「召唤时限」到期移除（M3.5，A35-3）。
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
  evaluateWindow(
    state.activeEffects,
    'round.close',
    makeWindowRuntimeCtx(state, { selfId: undefined, round: state.round, window: 'round.close' }),
  );

  // 减益 buff tick + DoT
  applyBuffTick(state, changes, events, 'negative', 'round.close');

  // M3.5（A35-3）：召唤物「召唤时限」到期 → UnitDespawned + 摘 automaton
  const expired = expireSummonedUnits(state, changes, events);

  events.push({ kind: 'RoundClosed', round: state.round });

  const out: PhaseOutcome = {
    changes,
    events,
    nextPhase: 'RoundOpen',
    round: state.round + 1,
  };
  // A4-3：槽位冻结回合递减（round.close 减 1，归 0 剔除）
  out.frozenSlots = tickFrozenSlots(state);
  if (expired.removeUnitIds.length > 0) {
    out.removeUnitIds = expired.removeUnitIds;
    out.activeEffects = expired.activeEffects;
  }
  return out;
}

/**
 * A4-3：槽位冻结回合递减。每轮 close 对 state.frozenSlots 的每条 rounds −1，
 * 归 0 的记录剔除；无冻结返回原引用（避免不必要的新对象）。
 */
function tickFrozenSlots(state: CombatState): readonly FrozenSlot[] | undefined {
  if (!state.frozenSlots || state.frozenSlots.length === 0) return undefined;
  const next = state.frozenSlots
    .map((f) => (f.rounds > 0 ? { ...f, rounds: f.rounds - 1 } : f))
    .filter((f) => f.rounds > 0);
  return next.length === 0 ? [] : next;
}

// ──────────────────────────────────────────────────────────────────────────────
// 召唤物「召唤时限」到期移除（M3.5，A35-3）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 在 round.close 扫描「召唤时限」buff 的召唤物，剩余回合减一；归 0 则：
 *   - 从 units / initiativeOrder 移除（applyOutcome removeUnitIds）
 *   - 从其 automaton 从 ActiveEffectIndex 摘除（updateIndex removeIds，按 byOwner[unitId]）
 *   - 产 UnitDespawned + StatusExpired
 *
 * 返回 { removeUnitIds, activeEffects }: removeUnitIds 空数组表示无到期召唤物。
 * 原子性：与当轮其他变更（减益 DoT 等）在 applyOutcome 一次提交。
 */
function expireSummonedUnits(
  state: CombatState,
  changes: PendingChangeSet,
  events: DomainEvent[],
): { removeUnitIds: string[]; activeEffects: ActiveEffectIndex } {
  const removeUnitIds: string[] = [];
  const affected: StatusPatch[] = [];

  for (const [id, unit] of Object.entries(state.units)) {
    const summonBuff = unit.statusEffects.find((s) => s.name === '召唤时限');
    if (!summonBuff || summonBuff.remainingTime === null) continue;

    const newTime = summonBuff.remainingTime - 1;
    if (newTime <= 0) {
      // 到期：移除单位 + 摘 automaton
      removeUnitIds.push(id);
      affected.push({ op: 'remove', unitId: id, statusId: '召唤时限' });
      events.push({ kind: 'StatusExpired', unitId: id, statusId: '召唤时限' });
      events.push({ kind: 'UnitDespawned', unitId: id, reason: 'expired' });
    } else {
      // 剩余递减写回
      affected.push({
        op: 'apply',
        unitId: id,
        status: { ...summonBuff, remainingTime: newTime },
      });
    }
  }

  changes.statusPatches.push(...affected);

  if (removeUnitIds.length === 0) return { removeUnitIds, activeEffects: state.activeEffects };

  // 摘除所有到期召唤物所属的 automaton（按 byOwner[unitId] → automaton id 表）
  const removeIds: string[] = [];
  for (const id of removeUnitIds) {
    const ownerIds = state.activeEffects.byOwner[id];
    if (ownerIds) removeIds.push(...ownerIds);
  }
  const activeEffects =
    removeIds.length > 0 ? updateIndex(state.activeEffects, { removeIds }) : state.activeEffects;

  return { removeUnitIds, activeEffects };
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
