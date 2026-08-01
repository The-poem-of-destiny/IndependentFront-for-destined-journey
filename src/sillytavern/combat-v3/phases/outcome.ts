/**
 * combat-v3/phases/outcome.ts — phase handler 统一返回类型（M1）
 *
 * 供 reducer 循环合并各 phase 的产出。所有 handler 返回同一形状，
 * reducer 依次把 changes 累加进单一 PendingChangeSet、events 追加、dice 替换，
 * 末尾一次 applyPending 原子提交（不变量④ / A1-4）。
 */

import type {
  CombatPhase,
  CommandRejection,
  DiceTapeState,
  DomainEvent,
  PendingChangeSet,
  RequiredInput,
  TerminalReason,
} from '../types';

/**
 * phase handler 的产出。
 *
 * - changes：本次 phase 声明的 pending 变更（HP/MP/SP/FP/buff/槽位）
 * - events：本次 phase 产出的 DomainEvent[]
 * - nextPhase：状态机推进到的下一 phase（架构 §二 2.4）
 * - dice：可选——掷过骰的 phase 返回新 tape（如 initiative）。无则缺省
 * - requiredInput：若需要外部输入则给出（PlayerCommand / BeginOutput 等）
 * - terminal：若触发终局则给出（phase 内判定，或由 checkTerminal 兜底）
 * - initiativeOrder / currentTurnIndex：允许初始化 phase 覆盖先攻序列
 * - revisionBump：是否主动递增（默认在 reducer 末尾 applyPending 统一 +1）
 */
export interface PhaseOutcome {
  changes: PendingChangeSet;
  events: DomainEvent[];
  nextPhase: CombatPhase;
  dice?: DiceTapeState;
  requiredInput?: RequiredInput;
  terminal?: { reason: TerminalReason; winner?: string };
  initiativeOrder?: readonly string[];
  currentTurnIndex?: number;
  /** 进入 Terminal 相位（由 checkTerminal 判定后驱动） */
  phase?: CombatPhase;
  /** 命令被拒（此时 events 空、骰子零消费、零变更） */
  rejection?: CommandRejection;
  /** settlement 结果（terminal.settle 用，C3 幂等） */
  settlement?: ImportedSettlement;
  /** settlement 幂等键 */
  settlementId?: string;
  /** 回合变更（round.close 推进到下一轮时 +1） */
  round?: number;
  /**
   * M3：damage.preview 触发 RequestChoice 时冻结的挂起上下文（reducer 据它构造 ResolutionFrame）。
   * 仅 attack phase 用；不进入 state.ts import 的形状（这是 phase 层的即时信息）。
   */
  suspended?: {
    /** 重算所需全部伤害入参 + 格挡因子 */
    recompute: ImportedRecomputeCtx;
    /** 暂停时的原始最终伤害（用于 RequiredInput.EffectChoice.damagePreview） */
    finalDamage: number;
  };
}

/** phase 层的重算上下文（避免 types.ts 循环依赖，复用字段名） */
export interface ImportedRecomputeCtx {
  attackerId: string;
  targetId: string;
  relevantAttribute: number;
  skillPower: number;
  weaponAtk: number;
  multiHitCount: number;
  intentionCoefficient: number;
  ratingCoefficient: number;
  damageTakenFactor: number;
  fixedDamageAdjust: number;
}

/** 轻量 settlement 结果（避免循环依赖 types.ts） */
export interface ImportedSettlement {
  settlementId: string;
  fpDelta: number;
  reason: TerminalReason;
  winner?: string;
}

/** 创建一个空产出（各 handler 起步用） */
export function emptyOutcome(nextPhase: CombatPhase): PhaseOutcome {
  return {
    changes: {
      hpChanges: {},
      mpChanges: {},
      spChanges: {},
      fpDelta: 0,
      statusPatches: [],
      slotConsumptions: [],
    },
    events: [],
    nextPhase,
  };
}

/** 空 pendingChanges 常量（复用） */
export function emptyChanges(): PendingChangeSet {
  return {
    hpChanges: {},
    mpChanges: {},
    spChanges: {},
    fpDelta: 0,
    statusPatches: [],
    slotConsumptions: [],
  };
}

/**
 * 合并两份 PendingChangeSet（reducer 循环累加用，不变量④一次提交）。
 * 返回新对象，入参不被修改。数值字段相加；数组字段拼接；turnOpenSlots 追加。
 */
export function mergeChanges(base: PendingChangeSet, add: PendingChangeSet): PendingChangeSet {
  const hpChanges: Record<string, number> = { ...base.hpChanges };
  for (const [id, v] of Object.entries(add.hpChanges)) {
    hpChanges[id] = (hpChanges[id] ?? 0) + v;
  }
  const mpChanges: Record<string, number> = { ...base.mpChanges };
  for (const [id, v] of Object.entries(add.mpChanges)) {
    mpChanges[id] = (mpChanges[id] ?? 0) + v;
  }
  const spChanges: Record<string, number> = { ...base.spChanges };
  for (const [id, v] of Object.entries(add.spChanges)) {
    spChanges[id] = (spChanges[id] ?? 0) + v;
  }
  return {
    hpChanges,
    mpChanges,
    spChanges,
    fpDelta: base.fpDelta + add.fpDelta,
    statusPatches: [...base.statusPatches, ...add.statusPatches],
    slotConsumptions: [...base.slotConsumptions, ...add.slotConsumptions],
    turnOpenSlots: [...(base.turnOpenSlots ?? []), ...(add.turnOpenSlots ?? [])],
    terminal: add.terminal ?? base.terminal,
  };
}
