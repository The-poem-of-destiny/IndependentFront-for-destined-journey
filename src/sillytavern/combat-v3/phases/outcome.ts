/**
 * combat-v3/phases/outcome.ts — phase handler 统一返回类型（M1）
 *
 * 供 reducer 循环合并各 phase 的产出。所有 handler 返回同一形状，
 * reducer 依次把 changes 累加进单一 PendingChangeSet、events 追加、dice 替换，
 * 末尾一次 applyPending 原子提交（不变量④ / A1-4）。
 */

import type {
  ActiveEffectIndex,
  CombatPhase,
  CommandRejection,
  DamageRecomputeCtx,
  DiceTapeState,
  DomainEvent,
  FrozenSlot,
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
  /** A4-3：槽位冻结记录（round.close 递减 后写回 / openUnitTurn 消费；applyOutcome 直接落 state.frozenSlots） */
  frozenSlots?: readonly FrozenSlot[];
  /**
   * M3.5：需从 state.units 移除的单位 id（召唤时限到期 UnitDespawned，A35-3）。
   * applyOutcome 会同步从 initiativeOrder 移除；随同 activeEffects 里对应的 automaton 摘除。
   */
  removeUnitIds?: readonly string[];
  /** M3.5：ActiveEffectIndex 覆盖（召唤物 automaton 增量/摘除用 updateIndex 结果） */
  activeEffects?: ActiveEffectIndex;
  /**
   * M3/M3.5：phase 挂起上下文（reducer 据此构造 ResolutionFrame）：
   *   - damage.preview 冻结（EffectChoice）：recompute + finalDamage
   *   - spawn 冻结（CharGenRequest）：spawn 标记（requiredInput 已带 requestId/prompt/constraints）
   * 仅 attack / action phase 用；不进入 state.ts import 的形状（这是 phase 层的即时信息）。
   */
  suspended?:
    | {
        recompute: DamageRecomputeCtx;
        finalDamage: number;
      }
    | { spawn: boolean };
}

// 🪦 Q-21：这里曾有一份 `ImportedRecomputeCtx` —— 逐字段抄自 `DamageRecomputeCtx`，
//    注释写着「避免 types.ts 循环依赖」。那个理由不成立：本文件上方**已经**在从
//    `'../types'` 取 10 个类型，多取一个不新增任何边。代价却是真的：给 frame 加一个
//    字段要改两处，漏一处就是「reducer 收得到、phase 读不到」这类只在真机上冒头的偏差。

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
    freezeSlotPatches: [...(base.freezeSlotPatches ?? []), ...(add.freezeSlotPatches ?? [])],
    terminal: add.terminal ?? base.terminal,
  };
}
