/**
 * combat-v3/state.ts — CombatState 构造、不可变更新、只读投影（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §三（CombatState 与原子提交）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §2.2 / §3.2
 *
 * 职责：
 *   - createCombatState(bundle)：由 CombatDefinitionBundle 构造初始 CombatState
 *     （participants 转 CombatUnitState、初始 FP 快照、provenance、空效果索引）
 *   - toView(state)：脱敏只读投影（UI / Agent prompt 用，拿不到可变引用）
 *   - applyPending(state, changes)：**唯一状态写入函数**（不变量④），
 *     revision 单调递增；HP clamp 到 [0, maxHp]（M-2/C7 声明的兜底）
 *   - bumpRevision(state)：仅递增 revision 不放任写（内核内部用）
 *
 * 验收断言：
 *   A1-4  applyPending 不可变：返回新对象，入参原对象不被修改
 *   A1-4  revision 单调递增（每次 applyPending +1）
 *   A1-2  toView 脱敏：不暴露可变引用（journal / pendingChanges / dice 原始数组等）
 *   M-7(C7)  HP clamp 到 [0, maxHp] 在 applyPending 兜底
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import {
  CHANNEL_ORDER,
  DEFAULT_CHANNEL_SPLIT,
  type DiceChannel,
  type DiceEpoch,
  type DiceTapeState,
} from './types';
import { createTape as _createTape } from './dice-tape';
import type {
  ActiveEffectIndex,
  CombatDefinitionBundle,
  CombatState,
  CombatUnitState,
  CombatUnitView,
  CombatView,
  DamageRecomputeCtx,
  PendingChangeSet,
  RequiredInput,
  ResolutionFrame,
  ResolutionStep,
  TerminalReason,
} from './types';
import type { StatusEffect } from '../types';

// ──────────────────────────────────────────────────────────────────────────────
// bundleHash（确定性，供 provenance）——djb2-like 简单哈希
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 计算 bundle 的稳定哈希（供 provenance.bundleHash）。
 * 基于 participants 名字/tier/HP + combatType + rulesetRevision 的规范化拼接。
 * 位运算 + charCodeAt，确定性（无 Math.random）。
 */
export function hashBundle(bundle: CombatDefinitionBundle): string {
  const parts: string[] = [];
  for (const p of bundle.participants) {
    parts.push(`${p.name}:${p.tier}:${p.hp}/${p.maxHp}:${p.side}`);
  }
  const joined = `${bundle.combatType}|${bundle.rulesetRevision}|${parts.join(',')}`;
  let hash = 5381;
  for (let i = 0; i < joined.length; i++) {
    hash = (hash * 33) ^ joined.charCodeAt(i);
    hash >>>= 0;
  }
  return hash.toString(16);
}

// ──────────────────────────────────────────────────────────────────────────────
// createEpochFromSplit（从一组合法的 channels 构造 DiceEpoch）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Vite/vitest 环境下由 bundle 直接构造初始骰带：用默认预算 32/10/7/6/5 建一个
 * 全 10（中位数）的确定性 epoch，再 createTape 包成 DiceTapeState。
 *
 * 这只是一个「可 dispatch」的最小初始骰带（供单元测试的 3 回合样本）。
 * 真实 coordinator 的注骰（BeginOutput → SupplyDice）由 M2 接；这里保证
 * createCombatState 产出的 state 一定能开战（不会被 draw exhausted 立刻卡住）。
 *
 * 返回的 channels 各通道长度严格等于 DEFAULT_CHANNEL_SPLIT 对应值。
 */
function buildInitialEpoch(epochSeqHint?: string): DiceEpoch {
  const channels: Record<DiceChannel, number[]> = {
    attackHit: Array.from({ length: DEFAULT_CHANNEL_SPLIT.attackHit }, () => 10),
    initiative: Array.from({ length: DEFAULT_CHANNEL_SPLIT.initiative }, () => 10),
    intentCheck: Array.from({ length: DEFAULT_CHANNEL_SPLIT.intentCheck }, () => 10),
    statusContest: Array.from({ length: DEFAULT_CHANNEL_SPLIT.statusContest }, () => 10),
    procCheck: Array.from({ length: DEFAULT_CHANNEL_SPLIT.procCheck }, () => 10),
  };
  return {
    outputId: epochSeqHint ?? 'initial',
    batchHash: 'initial-dummy',
    cursors: {
      attackHit: 0,
      initiative: 0,
      intentCheck: 0,
      statusContest: 0,
      procCheck: 0,
    },
    channels,
  };
}

/**
 * 由 CombatDefinitionBundle 构造初始 CombatState。
 *
 * - participants → CombatUnitState（canAct 为初始 true；槽位由 unit-turn 发，初为 0）
 * - 首次先攻骰：v3 掷 initiative 需在 Initiative phase 消费，故初始槽位留 0，
 *   由 round/initiative 阶段结算后发（unit-turn.handleUnitTurnOpen 发槽）
 */
export function createCombatState(bundle: CombatDefinitionBundle): CombatState {
  const units: Record<string, CombatUnitState> = {};
  const initiativeOrder: string[] = [];

  for (const p of bundle.participants) {
    const id = p.characterId;
    units[id] = {
      id,
      name: p.name,
      side: p.side === 'ally' ? 'player' : 'enemy',
      tier: p.tier,
      level: p.level,
      attributes: { ...p.attributes },
      hp: clamp(p.hp, 0, p.maxHp),
      maxHp: p.maxHp,
      mp: p.mp,
      maxMp: p.maxMp,
      sp: p.sp,
      maxSp: p.maxSp,
      defense: p.defense,
      dr: p.dr,
      penetration: p.penetration,
      hitBonus: p.hitBonus,
      dodgeBonus: p.dodgeBonus,
      speedModifiers: [...p.speedModifiers],
      fixedInitiativeBonus: p.fixedInitiativeBonus,
      weaponAtk: p.weaponAtk,
      canAct: p.canAct,
      morale: p.morale ?? 'steady',
      // 槽位初为 0，由第一轮 unit-turn.open 发
      attacksRemaining: 0,
      actionsRemaining: 0,
      statusEffects: p.statusEffects ? p.statusEffects.map((s) => ({ ...s })) : [],
      // M1 最小 ability：可由 bundle.skills 或参与者的 weaponAtk 兜底
      ability: undefined,
    };
    initiativeOrder.push(id);
  }

  const dice: DiceTapeState = _createTape(buildInitialEpoch(bundle.combatId));

  return {
    combatId: bundle.combatId,
    revision: 0,
    phase: 'CombatOpen',
    round: 1,
    initiativeOrder,
    currentTurnIndex: 0,
    units,
    activeEffects: EMPTY_EFFECT_INDEX(),
    dice,
    resourceSnapshots: { FP: bundle.resourceSnapshots.FP },
    journal: [],
    provenance: {
      engineVersion: 'v3',
      schemaVersion: '1',
      rulesetRevision: bundle.rulesetRevision,
      bundleHash: hashBundle(bundle),
      eventSequence: 0,
      diceEpochs: [],
    },
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// applyPending（唯一状态写入）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 应用一次 PendingChangeSet（不变量④：一次 Command 的全部变更末尾一次提交）。
 *
 * 保证（验收 A1-4）：
 *   - **不可变**：返回全新 CombatState，入参 state 与 changes 原对象不被修改
 *   - **revision 单调递增**：每次调用 +1
 *   - **HP clamp**：每个单位的 hp 落在 [0, maxHp]（M-2/C7 兜底）
 *   - MP / SP clamp 到 [0, max]，FP 不 clamp（可能为负的跨边界，settlement 才落库）
 *   - buff apply/remove 生效；行动槽由 slotConsumptions 递减（clamp ≥ 0）
 *
 * 传入的 terminal 会写入 state.terminal（供 checkTerminal 判定消费）。
 */
export function applyPending(state: CombatState, changes: PendingChangeSet): CombatState {
  const units: Record<string, CombatUnitState> = {};
  for (const [id, u] of Object.entries(state.units)) {
    units[id] = { ...u, statusEffects: u.statusEffects.slice() };
  }

  // HP
  for (const [id, delta] of Object.entries(changes.hpChanges)) {
    const u = units[id];
    if (!u) continue;
    units[id] = { ...u, hp: clamp(u.hp + delta, 0, u.maxHp) };
  }
  // MP
  for (const [id, delta] of Object.entries(changes.mpChanges)) {
    const u = units[id];
    if (!u) continue;
    units[id] = { ...u, mp: clamp(u.mp + delta, 0, u.maxMp) };
  }
  // SP
  for (const [id, delta] of Object.entries(changes.spChanges)) {
    const u = units[id];
    if (!u) continue;
    units[id] = { ...u, sp: clamp(u.sp + delta, 0, u.maxSp) };
  }

  // 行动槽消费
  for (const c of changes.slotConsumptions) {
    const u = units[c.actorId];
    if (!u) continue;
    if (c.slot === 'attack') {
      units[c.actorId] = { ...u, attacksRemaining: Math.max(0, u.attacksRemaining - 1) };
    } else {
      units[c.actorId] = { ...u, actionsRemaining: Math.max(0, u.actionsRemaining - 1) };
    }
  }

  // 回合开：给单位发槽（M-3：只给 canAct && hp>0 的单位发满，其余发 0）
  for (const s of changes.turnOpenSlots ?? []) {
    const u = units[s.actorId];
    if (!u) continue;
    units[s.actorId] = { ...u, attacksRemaining: s.attacks, actionsRemaining: s.actions };
  }

  // buff apply / remove
  for (const patch of changes.statusPatches) {
    if (patch.op === 'apply') {
      const u = units[patch.unitId];
      if (!u) continue;
      const existingIdx = u.statusEffects.findIndex((s) => s.name === patch.status.name);
      let next: StatusEffect[];
      if (existingIdx >= 0) {
        // 去重：同名 buff 已有。
        //   生命周期 tick（applyBuffTick / expireSummonedUnits 携带新 remainingTime）→ 更新 remainingTime
        //   否则（叠加 / 刷新）→ 合并层数（v2 §五 去重）
        const merged: StatusEffect[] = u.statusEffects.slice();
        const old = merged[existingIdx];
        // 生命周期 tick：existing 与 patch 的 remainingTime 不同（递减）→ 更新 remainingTime
        // 否则（同 remainingTime / 叠加）→ 合并层数（v2 §五 去重）
        const isTick =
          old.remainingTime !== null &&
          patch.status.remainingTime !== null &&
          patch.status.remainingTime !== old.remainingTime;
        merged[existingIdx] = isTick
          ? {
              ...old,
              remainingTime: patch.status.remainingTime,
              stacks: patch.status.stacks ?? old.stacks,
            }
          : { ...old, stacks: old.stacks + patch.status.stacks };
        next = merged;
      } else {
        next = [...u.statusEffects, { ...patch.status }];
      }
      units[patch.unitId] = { ...u, statusEffects: next };
    } else {
      const u = units[patch.unitId];
      if (!u) continue;
      units[patch.unitId] = {
        ...u,
        statusEffects: u.statusEffects.filter((s) => s.name !== patch.statusId),
      };
    }
  }

  // FP 净变动（不必 clamp，settlement 才结算，M-9/M-7 语义）
  const resourceSnapshots = {
    FP: state.resourceSnapshots.FP + changes.fpDelta,
  };

  return {
    ...state,
    revision: state.revision + 1,
    units,
    resourceSnapshots,
    // terminal 延后由 checkTerminal 判定；这里若显式给 terminal 则直接落
    ...(changes.terminal ? { terminal: changes.terminal } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// bumpRevision
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 仅递增 revision（内核内部自动推进一个微步时用，不应用任何 pending 变更）。
 * 返回新对象，入参不被修改。
 */
export function bumpRevision(state: CombatState): CombatState {
  return { ...state, revision: state.revision + 1 };
}

// ──────────────────────────────────────────────────────────────────────────────
// ResolutionFrame 冻结/恢复辅助（M3，架构 §三 3.3）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 冻结一个中断续跑帧（damage.preview 触发 RequestChoice 时，M3）。
 *
 * 存储：commandId / step / pendingChanges / diceConsumedInFrame / awaiting / recompute。
 * 冻结后 dispatch 返回 RequiredInput.EffectChoice；DeclareBlock 恢复时从 frame 续跑，
 * 不重跑前序效果、不重复消费骰子（架构 §三 3.3）。
 *
 * 不可变：返回新 CombatState，入参不被修改。
 */
export function freezeFrame(
  state: CombatState,
  frame: {
    commandId: string;
    step: ResolutionStep;
    pendingChanges: PendingChangeSet;
    diceConsumedInFrame: Readonly<Record<DiceChannel, number>>;
    awaiting: RequiredInput;
    recompute?: DamageRecomputeCtx;
  },
): CombatState {
  return { ...state, resolution: frame };
}

/**
 * 从 frame 恢复：取回 resolution 并清除（DeclareBlock 恢复后不再持有旧帧）。
 * 返回 { frame, next }：next 是清除 resolution 后的新 CombatState（不可变）。
 */
export function restoreFrame(state: CombatState): {
  frame: ResolutionFrame;
  next: CombatState;
} | null {
  if (!state.resolution) return null;
  const frame = state.resolution;
  const { resolution: _res, ...rest } = state;
  return { frame, next: rest as CombatState };
}

// ──────────────────────────────────────────────────────────────────────────────
// toView（脱敏只读投影）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 把 CombatState 投影为只读 CombatView（验收 A1-2：不暴露可变引用）。
 *
 * 项目各单位只保留 UI/Agent 需要的最小字段；journal / provenance / dice /
 * pendingChanges / activeEffects 全部不暴露。statusEffects 深复制，防止外部 mutate。
 */
export function toView(state: CombatState): Readonly<CombatView> {
  const units: Record<string, CombatUnitView> = {};
  for (const [id, u] of Object.entries(state.units)) {
    units[id] = {
      id,
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
      statusEffects: u.statusEffects.map((s) => ({
        ...s,
        effects: { ...s.effects },
        scripts: s.scripts ? { ...s.scripts } : undefined,
        effectDescriptions: s.effectDescriptions ? { ...s.effectDescriptions } : undefined,
      })),
    };
  }

  return {
    combatId: state.combatId,
    revision: state.revision,
    phase: state.phase,
    round: state.round,
    initiativeOrder: state.initiativeOrder.slice(),
    currentTurnIndex: state.currentTurnIndex,
    units,
    resourceSnapshots: { FP: state.resourceSnapshots.FP },
    terminal: state.terminal
      ? { reason: state.terminal.reason, winner: state.terminal.winner }
      : undefined,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 内部辅助
// ──────────────────────────────────────────────────────────────────────────────

/** clamp 到 [min, max]，含两端 */
function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** 空效果索引（组件内部使用，避免与其常量耦合） */
function EMPTY_EFFECT_INDEX(): ActiveEffectIndex {
  return {
    byWindow: {
      'round.open': [],
      'round.close': [],
      'initiative.before': [],
      'initiative.after': [],
      'turn.open': [],
      'turn.close': [],
      'action.declared': [],
      'check.intent': [],
      'check.hit': [],
      collect_attacker_mods: [],
      collect_defender_mods: [],
      'damage.preview': [],
      'damage.compute': [],
      'damage.after': [],
      'unit.beforeDown': [],
      'morale.before': [],
      'morale.after': [],
      'settlement.before': [],
    },
    byOwner: {},
  };
}

/**
 * 校验单位在场（供 phases/* 与 state.ts 复用）。
 * 目标不在场 → 返回 false（Command 应被 reject，A1-2）。
 */
export function isUnitPresent(state: CombatState, unitId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.units, unitId);
}

/**
 * 应用一个 phase 产出（PhaseOutcome）到 CombatState——不变量④的单一提交。
 *
 * 这是 `applyPending` 之上的编排层：applyPending 处理 PendingChangeSet 内字段，
 * 本函数额外应用 phase 层才能决定的状态（dice / initiativeOrder / currentTurnIndex /
 * terminal / settlement / settlementId / phase）。二者共用同一次 revision +1。
 *
 * 若 outcome.rejection 非空 → 直接返回原 state（零变更、零骰子消费，验收 A1-2）。
 */
export function applyOutcome(state: CombatState, outcome: ImportedOutcome): CombatState {
  if (outcome.rejection) {
    return state;
  }

  const next = applyPending(state, outcome.changes);

  // M3.5：移除到期召唤物（A35-3）——从 units 与 initiativeOrder 同步摘除
  let final = next;
  if (outcome.removeUnitIds && outcome.removeUnitIds.length > 0) {
    const removeSet = new Set(outcome.removeUnitIds);
    const units: Record<string, CombatUnitState> = {};
    for (const [id, u] of Object.entries(next.units)) {
      if (!removeSet.has(id)) units[id] = u;
    }
    const order = next.initiativeOrder.filter((id) => !removeSet.has(id));
    let index = next.currentTurnIndex;
    if (index >= order.length) index = 0;
    final = { ...next, units, initiativeOrder: order, currentTurnIndex: index };
  }

  // M3.5：ActiveEffectIndex 覆盖（召唤物摘除后）
  if (outcome.activeEffects) {
    final = { ...final, activeEffects: outcome.activeEffects };
  }

  // 应用到 phase 层字段
  const merged = {
    ...final,
    ...(outcome.dice ? { dice: outcome.dice } : {}),
    ...(outcome.initiativeOrder ? { initiativeOrder: outcome.initiativeOrder } : {}),
    ...(outcome.currentTurnIndex !== undefined
      ? { currentTurnIndex: outcome.currentTurnIndex }
      : {}),
    ...(outcome.terminal ? { terminal: outcome.terminal } : {}),
    ...(outcome.settlement ? { settlement: outcome.settlement } : {}),
    ...(outcome.settlementId ? { settlementId: outcome.settlementId } : {}),
    ...(outcome.round !== undefined ? { round: outcome.round } : {}),
    phase: outcome.nextPhase,
  };
  // revision 已由 applyPending +1；phase 变更不额外递增，保持单次提交一次递增
  return merged;
}

/** 避免循环依赖的最小 outcome 形状（导入为 type-only） */
export type ImportedOutcome = {
  changes: PendingChangeSet;
  rejection?: { code: string; message: string };
  dice?: DiceTapeState;
  initiativeOrder?: readonly string[];
  currentTurnIndex?: number;
  terminal?: { reason: TerminalReason; winner?: string };
  settlement?: {
    settlementId: string;
    fpDelta: number;
    reason: TerminalReason;
    winner?: string;
  };
  settlementId?: string;
  nextPhase: CombatState['phase'];
  round?: number;
  /** M3.5：需移除的单位（召唤时限到期），同时从 initiativeOrder 摘除 */
  removeUnitIds?: readonly string[];
  /** M3.5：ActiveEffectIndex 覆盖（召唤物摘除后的索引） */
  activeEffects?: ActiveEffectIndex;
  events?: readonly unknown[];
};

// re-export 供外部引用（DiceChannel 透传避免两处定义）
export type { DiceChannel } from './types';
export { CHANNEL_ORDER };
