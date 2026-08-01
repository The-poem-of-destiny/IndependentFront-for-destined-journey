/**
 * combat-v3/reducer.ts — 纯 reducer：按 state.phase 推进表分发 handler（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §二 2.1/2.4
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3（推进表）/ §3.9（熔断）
 *
 * reduce(bundle, state, command)：唯一分发入口。驱动状态机推进表：
 *   1. 校验 expectedRevision（stale → 拒绝，零骰子消费，验收 A1-2）
 *   2. Terminal 相位只接受 RequestSettlement（验收 A1-6）
 *   3. 从当前 phase 起循环推进（auto 阶段逐 handler 跑；SlotConsume 消费 PlayerCommand；
 *      Terminal 由 RequestSettlement 结算），累计 events，末尾一次提交（不变量④ / 验收 A1-4）
 *   4. 每步后调 checkTerminal：命中终局四出口 → 强制进 Terminal（验收 A1-6）
 *   5. 单次 dispatch 微步骤上限 200：超限抛 KernelStuckError（§3.9）
 *
 * 推进表（plan §3.3）落成 AUTO_PHASES 数据表。
 */

import { applyOutcome, freezeFrame, toView } from './state';
import { beginEpoch, splitSixty } from './dice-tape';
import {
  KernelStuckError,
  type CombatCommand,
  type CombatState,
  type DamageRecomputeCtx,
} from './types';
import { checkTerminal } from './phases/terminal';
import { handleRoundOpen, handleRoundClose } from './phases/round';
import { handleInitiative } from './phases/initiative';
import {
  currentUnitId,
  openUnitTurn,
  consumeSlot,
  runMoraleCheck,
  closeUnitTurn,
} from './phases/unit-turn';
import { handleAttack, resumeBlockedAttack } from './phases/attack';
import { handleAction, handleFlee } from './phases/action';
import { settle } from './phases/terminal';
import { emptyChanges, mergeChanges } from './phases/outcome';
import type { PhaseOutcome } from './phases/outcome';
import type {
  CombatDefinitionBundle,
  CombatTransition,
  CommandRejection,
  DiceEpoch,
} from './types';

/** 单次 dispatch 微步骤上限（plan §3.9 熔断） */
export const MAX_STEPS_PER_DISPATCH = 200;

/**
 * 纯 reducer 主入口。
 */
export function reduce(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: CombatCommand,
): CombatTransition {
  // 1. stale revision（验收 A1-2）
  if (command.expectedRevision !== state.revision) {
    return rejection(state, {
      code: 'STALE_REVISION',
      message: `expectedRevision ${command.expectedRevision} ≠ 当前 ${state.revision}`,
    });
  }

  // 2. Terminal 只接受 RequestSettlement（验收 A1-6）
  if (state.phase === 'Terminal' && command.kind !== 'RequestSettlement') {
    return rejection(state, {
      code: 'INVALID_PHASE',
      message: 'Terminal 相位只接受 RequestSettlement',
    });
  }
  if (state.phase === 'SettlementCommitted') {
    return rejection(state, {
      code: 'INVALID_PHASE',
      message: '已结算，不得再 dispatch',
    });
  }

  // 2.5 早期目标/执行者在场校验（A1-2：非法命令返回 rejection 且零事件、零骰子消费）
  const early = validateEarly(state, command);
  if (early) {
    return rejection(state, early);
  }

  // 2.6 DeclareBlock 的 damage.preview frame 恢复分支（M3，A3-5）
  if (command.kind === 'DeclareBlock' && state.resolution?.step === 'damage.preview') {
    return resumeBlock(state, command);
  }

  // 3. SupplyDice 续杯（BeginOutput 应答）
  if (command.kind === 'SupplyDice') {
    return reduceSupplyDice(bundle, state, command);
  }

  // 4. RequestSettlement（C3）
  if (command.kind === 'RequestSettlement') {
    const out = settle(bundle, state, command.payload.settlementId);
    return commitTransition(state, out);
  }

  // 5. 正常 dispatch 循环
  return runDispatch(bundle, state, command);
}

// ──────────────────────────────────────────────────────────────────────────────
// DeclareBlock damage.preview frame 恢复（M3，A3-5）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * DeclareBlock Command 的 damage.preview frame 恢复分支。
 *
 * 玩家格挡：从冻结的 ResolutionFrame（step='damage.preview'）恢复，
 * 回到 damage.compute **重算**（resumeBlockedAttack），并入格挡的资源消耗
 * （SpendResource SP —— 架构 §5.4 步骤⑦），同一原子提交。不重取骰、不重跑前序。
 *
 * 验收 A3-5：487 → DeclareBlock → 重算 → 97。
 */
function resumeBlock(
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'DeclareBlock' }>,
) {
  const frame = state.resolution;
  const recompute = frame?.recompute;
  if (!recompute) {
    return rejection(state, {
      code: 'INVALID_PHASE',
      message: 'damage.preview frame 缺少 recompute 上下文',
    });
  }

  const out = resumeBlockedAttack(bundleOf(state), state, recompute);
  if (out.rejection) return rejection(state, out.rejection);

  // 格挡消耗动作槽（DeclareBlock.cost='action'）——进 pendingChanges
  out.changes.slotConsumptions ??= [];
  out.changes.slotConsumptions.push({ actorId: command.actorId, slot: 'action' });
  // 可选 SP 消耗（frame.awaiting.cost.sp）
  const spCost = frame.awaiting.kind === 'EffectChoice' ? frame.awaiting.cost?.sp : undefined;
  if (spCost && spCost > 0) {
    out.changes.spChanges[command.actorId] = (out.changes.spChanges[command.actorId] ?? 0) - spCost;
    out.events.push({
      kind: 'ResourceSpent',
      unitId: command.actorId,
      resource: 'sp',
      amount: spCost,
    });
  }

  // 清除 resolution（恢复完成）
  const cleared = { ...state, resolution: undefined };
  const applied = applyOutcome(cleared, out);
  const events = out.events as CombatTransition['events'];
  return {
    revision: applied.revision,
    snapshot: toView(applied),
    events,
    terminal: applied.terminal,
    next: applied,
  } satisfies CombatTransition;
}

/** DeclareBlock 恢复时重建 bundle（bundle 参与 runDamagePipeline 的 skill 解析；M3 用最小闭包） */
function bundleOf(state: CombatState): CombatDefinitionBundle {
  // resumeBlockedAttack 只用 state.units + recompute；bundle 仅供签名，
  // 传一个最小 bundle 保证纯函数（无副作用）可继续。
  return {
    combatId: state.combatId,
    combatType: '标准',
    participants: Object.values(state.units as never) as never,
    resourceSnapshots: state.resourceSnapshots,
    rulesetRevision: 'v3-m3',
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// dispatch 循环
// ──────────────────────────────────────────────────────────────────────────────

function runDispatch(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: CombatCommand,
): CombatTransition {
  // working 是逐 phase 演化的临时状态；revision 在末尾统一设为 state.revision+1，
  // 保证「一次 Command 一次 revision 递增」。
  let working = state;
  const events: PhaseOutcome['events'][] = [];
  let commandUsed = false;

  const phaseHistory: string[] = [state.phase];
  let steps = 0;

  while (true) {
    if (++steps > MAX_STEPS_PER_DISPATCH) {
      throw new KernelStuckError(
        `Kernel 熔断：单次 dispatch 超过 ${MAX_STEPS_PER_DISPATCH} 个微步骤（phase 历史: ${phaseHistory.join(' → ')}）`,
      );
    }
    const phase = working.phase;
    phaseHistory.push(phase);

    // 终局：检查是否应进 Terminal
    const terminal = checkTerminal(working);
    if (terminal && phase !== 'Terminal') {
      // 强制进 Terminal（A1-6）：此后只接受 RequestSettlement
      working = applyOutcome(working, {
        changes: emptyChanges(),
        events: [],
        nextPhase: 'Terminal',
        terminal,
      });
      events.push([{ kind: 'CombatEnded', reason: terminal.reason, winner: terminal.winner }]);
      continue;
    }

    // Terminal / SettlementCommitted → 停下等 RequestSettlement
    if (phase === 'Terminal' || phase === 'SettlementCommitted') {
      break;
    }

    // auto 相位（数据表 plan §3.3）
    const autoFn = AUTO_PHASES[phase as CombatPhase];
    if (autoFn) {
      // CombatOpen：首步先发 CombatOpened（架构 §十三 #1）
      if (phase === 'CombatOpen') {
        events.push([
          {
            kind: 'CombatOpened',
            combatId: working.combatId,
            combatType: bundle.combatType,
            unitIds: Object.keys(working.units),
            bundleHash: working.provenance.bundleHash,
          },
        ] as PhaseOutcome['events']);
      }
      const out = autoFn(bundle, working);
      if (out.requiredInput) {
        // 骰带耗尽 → 冻结 frame，返回 BeginOutput（不提交半成品）
        return buildTransition(state, events, {
          requiredInput: out.requiredInput,
          snapshotState: working,
        });
      }
      if (out.rejection) {
        return rejection(state, out.rejection);
      }
      if (out.events.length > 0) events.push(out.events);
      working = applyOutcome(working, out);
      continue;
    }

    // SlotConsume：消费 PlayerCommand
    if (phase === 'SlotConsume') {
      if (commandUsed) {
        // 本命令已消费，当前单位（或下一单位）还等 PlayerCommand → 直接返回
        const uid = currentUnitId(working);
        const u = uid ? working.units[uid] : undefined;
        return buildTransition(state, events, {
          requiredInput: {
            kind: 'PlayerCommand',
            unitId: uid ?? '',
            unitName: u?.name ?? '',
            round: working.round,
          },
          snapshotState: working,
        });
      }
      commandUsed = true;
      const res = consumePlayerCommand(bundle, working, command);
      if (res.rejection) {
        return rejection(state, res.rejection);
      }
      if (res.requiredInput) {
        events.push(res.events);
        return buildTransition(state, events, {
          requiredInput: res.requiredInput,
          snapshotState: res.working,
        });
      }
      events.push(res.events);
      working = res.working;
      if (res.waitForNext) {
        // 同 unit 还有槽 → 返回 PlayerCommand
        const id = currentUnitId(working);
        const u = id ? working.units[id] : undefined;
        return buildTransition(state, events, {
          requiredInput: {
            kind: 'PlayerCommand',
            unitId: id ?? '',
            unitName: u?.name ?? '',
            round: working.round,
          },
          snapshotState: working,
        });
      }
      // 推进（MoraleCheck）
      continue;
    }

    // 未知 phase → 熔断
    throw new KernelStuckError(`无法处理的 phase「${phase}」`);
  }

  // 循环结束（Terminal 或 SettlementCommitted）
  return buildTransition(state, events, { snapshotState: working });
}

// ──────────────────────────────────────────────────────────────────────────────
// auto 相位推进表（plan §3.3）
// ──────────────────────────────────────────────────────────────────────────────

type CombatPhase = CombatState['phase'];

const AUTO_PHASES: Partial<
  Record<CombatPhase, (bundle: CombatDefinitionBundle, s: CombatState) => PhaseOutcome>
> = {
  CombatOpen: handleRoundOpen,
  RoundOpen: handleRoundOpen,
  Initiative: handleInitiative,
  UnitTurnOpen: openUnitTurn,
  MoraleCheck: runMoraleCheck,
  UnitTurnClose: closeUnitTurn,
  RoundClose: handleRoundClose,
};

// ──────────────────────────────────────────────────────────────────────────────
// 消费 PlayerCommand（SlotConsume）
// ──────────────────────────────────────────────────────────────────────────────

interface ConsumeResult {
  working: CombatState;
  events: PhaseOutcome['events'];
  rejection?: CommandRejection;
  requiredInput?: PhaseOutcome['requiredInput'];
  waitForNext: boolean;
}

function consumePlayerCommand(
  bundle: CombatDefinitionBundle,
  working: CombatState,
  command: CombatCommand,
): ConsumeResult {
  // ① 槽位消费（M-3：cost 验证 + 消费）
  const slotOut = consumeSlot(bundle, working, command);
  if (slotOut.rejection) {
    return { working, events: [], rejection: slotOut.rejection, waitForNext: false };
  }
  if (slotOut.requiredInput) {
    return {
      working,
      events: slotOut.events,
      requiredInput: slotOut.requiredInput,
      waitForNext: false,
    };
  }

  // ② 业务结算
  const biz = runBusiness(bundle, working, command);
  if (biz.rejection) {
    return { working, events: [], rejection: biz.rejection, waitForNext: false };
  }
  if (biz.requiredInput) {
    // M3：EffectChoice（damage.preview 格挡询问）→ 冻结 ResolutionFrame（不提交半成品）
    if (biz.requiredInput.kind === 'EffectChoice' && biz.suspended) {
      const frozen = freezeFrame(working, {
        commandId: command.commandId,
        step: 'damage.preview',
        pendingChanges: mergeChanges(slotOut.changes, biz.changes),
        diceConsumedInFrame: {
          attackHit: 0,
          initiative: 0,
          intentCheck: 0,
          statusContest: 0,
          procCheck: 0,
        },
        awaiting: biz.requiredInput,
        recompute: biz.suspended.recompute as unknown as DamageRecomputeCtx,
      });
      return {
        working: frozen,
        events: slotOut.events,
        requiredInput: biz.requiredInput,
        waitForNext: false,
      };
    }
    return {
      working,
      events: slotOut.events,
      requiredInput: biz.requiredInput,
      waitForNext: false,
    };
  }

  // ③ 合并 slot + business 一次 apply（不变量④ / M-9 攻守资源同批）
  const combined = mergeChanges(slotOut.changes, biz.changes);
  // nextPhase：槽位消费结果权威（SlotConsume 同 unit 继续 / MoraleCheck 推进）；
  // 终局由 biz.terminal 覆盖为 Terminal
  const nextPhase: CombatPhase = biz.terminal ? 'Terminal' : slotOut.nextPhase;
  const out: PhaseOutcome = {
    changes: combined,
    events: [...slotOut.events, ...biz.events],
    nextPhase: nextPhase as PhaseOutcome['nextPhase'],
    dice: biz.dice ?? slotOut.dice,
    terminal: biz.terminal,
    round: biz.round,
  };
  const next = applyOutcome(working, out);

  const waitForNext = nextPhase === 'SlotConsume';
  return {
    working: next,
    events: out.events,
    waitForNext,
  };
}

/** 按 Command kind 跑业务结算（攻击 / 动作 / 逃跑） */
function runBusiness(
  bundle: CombatDefinitionBundle,
  working: CombatState,
  command: CombatCommand,
): PhaseOutcome {
  switch (command.kind) {
    case 'DeclareAttack':
      return handleAttack(bundle, working, command);
    case 'DeclareAction':
      return handleAction(bundle, working, command);
    case 'Flee':
      return handleFlee(bundle, working, command);
    case 'PassAttack':
    case 'PassAction':
      return {
        changes: emptyChanges(),
        events: [],
        nextPhase: 'MoraleCheck',
      };
    default:
      // Choose / Adjudicate 等 M1 不在 SlotConsume 用（应由对应 RequiredInput 分支处理）
      return {
        changes: emptyChanges(),
        events: [],
        nextPhase: 'SlotConsume',
        rejection: {
          code: 'INVALID_PHASE',
          message: `M1 不支持 kind「${command.kind}」在槽位阶段`,
        },
      };
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 早期校验（A1-2：非法命令零事件 / 零骰子消费）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 在进入 dispatch 循环前校验命令引用的一致性（目标/执行者在场）。
 * 命中返回 rejection；否则 null。
 *
 * 目的：A1-2 要求非法命令（目标不在场 / 槽位已耗尽 / 错 phase / stale revision）
 * 返回 rejection 且 events 空、骰子零消费。stale/phase 已前置校验；这里补目标/执行者
 * 在场校验——必须在自动推进产生任何事件之前完成。
 */
function validateEarly(state: CombatState, command: CombatCommand): CommandRejection | null {
  switch (command.kind) {
    case 'DeclareAttack': {
      const target = command.payload.targetId;
      if (!Object.prototype.hasOwnProperty.call(state.units, target)) {
        return { code: 'TARGET_NOT_PRESENT', message: `目标「${target}」不在场` };
      }
      break;
    }
    case 'DeclareAction':
    case 'Flee':
    case 'PassAttack':
    case 'PassAction': {
      if (!Object.prototype.hasOwnProperty.call(state.units, command.actorId)) {
        return { code: 'TARGET_NOT_PRESENT', message: `执行者「${command.actorId}」不在场` };
      }
      break;
    }
    default:
      break;
  }
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// SupplyDice（续杯）
// ──────────────────────────────────────────────────────────────────────────────

function reduceSupplyDice(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'SupplyDice' }>,
): CombatTransition {
  // 切分并续杯（与 dice-tape 契约一致）
  const channels = splitSixty(command.payload.dice as number[]);
  const epoch: DiceEpoch = {
    outputId: command.payload.outputId,
    batchHash: 'supplied',
    channels,
    cursors: { attackHit: 0, initiative: 0, intentCheck: 0, statusContest: 0, procCheck: 0 },
  };
  const nextDice = beginEpoch(state.dice, epoch);
  const next: CombatState = { ...state, dice: nextDice, phase: state.phase };
  return {
    revision: state.revision,
    snapshot: toView(next),
    events: [{ kind: 'NarrativeCue', text: `骰池续杯：${command.payload.outputId}` }],
    next,
  };
}

// ──────────────────────────────────────────────────────────────────────────────
// 过渡辅助
// ──────────────────────────────────────────────────────────────────────────────

function buildTransition(
  original: CombatState,
  pendingEvents: PhaseOutcome['events'][],
  opts: {
    snapshotState: CombatState;
    requiredInput?: CombatTransition['requiredInput'];
  },
): CombatTransition {
  // 把 working 的 revision 归一为 original.revision + 1（一次 Command 一次递增）
  const flat = opts.snapshotState;
  const trimmed: CombatState = { ...flat, revision: original.revision + 1 };
  const events = pendingEvents.flat() as CombatTransition['events'];
  return {
    revision: trimmed.revision,
    snapshot: toView(trimmed),
    events,
    requiredInput: opts.requiredInput,
    terminal: trimmed.terminal,
    next: trimmed,
  };
}

function commitTransition(original: CombatState, out: PhaseOutcome): CombatTransition {
  const next = applyOutcome(original, out);
  return {
    revision: next.revision,
    snapshot: toView(next),
    events: out.events as CombatTransition['events'],
    requiredInput:
      out.requiredInput === undefined || out.requiredInput.kind === 'PlayerCommand'
        ? out.requiredInput
        : undefined,
    terminal: next.terminal,
    next,
  };
}

function rejection(state: CombatState, r: CommandRejection): CombatTransition {
  return {
    revision: state.revision,
    snapshot: toView(state),
    events: [],
    rejection: r,
  };
}
