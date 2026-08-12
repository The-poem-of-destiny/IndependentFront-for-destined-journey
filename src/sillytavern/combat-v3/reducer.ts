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

import {
  applyOutcome,
  applyPending,
  bumpRevision,
  freezeFrame,
  restoreFrame,
  toView,
} from './state';
import { beginEpoch, draw, splitSixty } from './dice-tape';
import { updateIndex } from './automata/index-active';
import { compileEffectProgram } from './automata/compile';
import {
  KernelStuckError,
  type CombatCommand,
  type CombatState,
  type CombatUnitState,
  type DamageRecomputeCtx,
  type DomainEvent,
  type PendingChangeSet,
  type SummonedUnitDefinition,
} from './types';
import { checkTerminal } from './phases/terminal';
import { evaluateAdjudication } from './adjudication';
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

  // 2.7 SupplyUnit 的 spawn frame 恢复分支（M3.5，A35-1/A35-2）
  if (command.kind === 'SupplyUnit' && state.resolution?.step === 'spawn') {
    return resumeSpawn(state, command);
  }

  // 3. SupplyDice 续杯（BeginOutput 应答）
  if (command.kind === 'SupplyDice') {
    const supplied = reduceSupplyDice(bundle, state, command);
    // 🔴 2026-08-12（真机 bug：首回合面板「攻0动0」）：
    //   `reduceSupplyDice` 保持 phase 不变（CombatOpen）零推进。开局首次注骰后，
    //   coordinator 在槽位发放前就问玩家 → 面板显示攻0动0、AI 误判「没槽可动」。
    //   修复：开局（phase 仍 CombatOpen）时继续 auto 推进到 SlotConsume——
    //   掷先攻 + 开回合发槽（openUnitTurn）→ 返回 PlayerCommand（此时面板攻1动1）。
    //   续杯（其他 phase）保持既有语义（只注骰，不推进）。
    if (supplied.snapshot.phase === 'CombatOpen') {
      return advanceAfterOpeningSupply(bundle, state, supplied);
    }
    return supplied;
  }

  // 4. RequestSettlement（C3）
  if (command.kind === 'RequestSettlement') {
    const out = settle(bundle, state, command.payload.settlementId);
    return commitTransition(state, out);
  }

  // 4.1 Adjudicate —— BoundedAdjudication 有界裁决（M3.5，A35-4/A35-5）
  // 内核重锤验证（防御纵深：不信任 coordinator 侧结果），通过 → 产 AdjudicationAccepted +
  // RuleOverridden/MiracleTriggered + 进 journal；未通过 → 产 EffectRejected(code:'ADJUDICATION_REJECTED')
  if (command.kind === 'Adjudicate') {
    return adjudicate(bundle, state, command);
  }

  // 5. 正常 dispatch 循环
  return runDispatch(bundle, state, command);
}

// ──────────────────────────────────────────────────────────────────────────────
// Adjudicate（BoundedAdjudication 有界裁决，M3.5）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 执行一次 Adjudicate（架构 §十一 11.2）。
 *
 * 纯 reducer 侧：调 evaluateAdjudication 内核实锤（六步验证），
 *   - accepted → 产 AdjudicationAccepted（journal 带 reason）+ RuleOverridden / MiracleTriggered
 *   - rejected → 产 EffectRejected(code:'ADJUDICATION_REJECTED')，不落 journal（零状态变更零骰耗）
 * Adjudicate.cost='none'，不走槽位。
 */
function adjudicate(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'Adjudicate' }>,
): CombatTransition {
  const { adjudication } = command.payload;
  void bundle;
  const result = evaluateAdjudication(adjudication, state);

  const next = bumpRevision({ ...state }); // Adjudicate 本身不改变 units/资源，仅 revision 推进
  const journal = [
    ...state.journal,
    {
      seq: state.journal.length + 1,
      commandId: command.commandId,
      kind: 'command' as const,
      payload: `bounded_adjudication: ${result.kind} — ${result.reason}`,
    },
  ];

  if (result.kind === 'rejected') {
    return {
      revision: next.revision,
      snapshot: toView({ ...next, journal }),
      events: [
        {
          kind: 'EffectRejected',
          code: 'ADJUDICATION_REJECTED',
          detail: result.reason,
          window: 'bounded_adjudication',
        },
      ],
      next: { ...next, journal },
    };
  }

  // accepted → 产 RuleOverridden / MiracleTriggered + AdjudicationAccepted
  const events: DomainEvent[] = [
    {
      kind: 'AdjudicationAccepted',
      divinity: adjudication.divinity,
      reason: result.reason,
      effectDescription: adjudication.effectDescription,
      ruleKey: result.effect.eventKind === 'RuleOverridden' ? result.effect.ruleKey : undefined,
    },
  ];
  if (result.effect.eventKind === 'RuleOverridden') {
    events.push({
      kind: 'RuleOverridden',
      ruleKey: result.effect.ruleKey,
      payload: result.effect.payload,
      divinity: adjudication.divinity,
    });
  } else {
    events.push({
      kind: 'MiracleTriggered',
      effectDescription: adjudication.effectDescription,
      divinity: adjudication.divinity,
      payload: result.effect.payload,
    });
  }

  // A1-6 forceTerminal 出口（架构 §八 8.2 terminal.forceTerminal）：裁决产出概念级终局时，
  // 把 state.terminal 落定，让后续 runDispatch 的 checkTerminal 拾取进 Terminal 相位（case-09）。
  // 载荷 reason/winner 优先取 RuleOverridden payload（若裁决方给出），否则用 'force_terminal'。
  let judgeTerminal: { reason: 'force_terminal'; winner?: string } | undefined;
  if (
    result.effect.eventKind === 'RuleOverridden' &&
    result.effect.ruleKey === 'terminal.forceTerminal'
  ) {
    const p = result.effect.payload as { reason?: string; winner?: string } | null | undefined;
    judgeTerminal = { reason: 'force_terminal', winner: p?.winner };
  }

  const final = judgeTerminal
    ? { ...next, journal, terminal: judgeTerminal }
    : { ...next, journal };
  return {
    revision: final.revision,
    snapshot: toView(final),
    events,
    next: final,
  };
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

  const out = resumeBlockedAttack(state, recompute);
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

// 🪦 Q-22：`bundleOf` 已删。它存在的唯一理由是 `resumeBlockedAttack` 的签名要一个
//    `bundle` —— 而那个参数贯穿整条攻击路径却**从不被读**。为了喂它，这里要现造一个
//    假 bundle（combatType 硬写 '标准'、rulesetRevision 硬写 'v3-m3'，两处 `as never`）。
//    参数一删，这段连同两个 `as never` 一起消失。
//    将来某个窗口若真需要战斗级事实，传具体字段（如 `combatType: CombatType`）——
//    产出 `PhaseOutcome` 的函数应当只拿它读的东西。

// ──────────────────────────────────────────────────────────────────────────────
// SupplyUnit spawn frame 恢复（M3.5，A35-1/A35-2）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * SupplyUnit Command 的 spawn frame 恢复分支（plan §6.2 ⑥）。
 *
 * 从冻结的 ResolutionFrame（step='spawn'）恢复，把 char_gen 产出的 SummonedUnitDefinition
 * 实例化为 CombatUnitState 插入 state.units：
 *   - joinTiming='this_round_tail' → draw(initiative,1) → append 先攻序列尾部
 *   - actionEconomy 决定本轮槽位（full=1攻1动 / partial=仅动作 / no_action=0）
 *   - duration → ApplyStatus('召唤时限', rounds)
 *   - 自带 automaton 走 compileEffectProgram → ActiveEffectIndex 增量 add
 *   - 与冻结时挂起的 SpendResource(FP,100) 同一次原子提交（不变量④，A35-6）
 *   ⇒ 产 UnitSummoned + ResourceSpent
 *
 * 不重跑前序效果、不重复消费已冻结的骰子（此处只对本轮 this_round_tail 掷 1 颗 initiative）。
 */
function resumeSpawn(state: CombatState, command: Extract<CombatCommand, { kind: 'SupplyUnit' }>) {
  const restored = restoreFrame(state);
  if (!restored) {
    return rejection(state, {
      code: 'INVALID_PHASE',
      message: 'SupplyUnit 到达但无 spawn frame 可恢复',
    });
  }
  const frame = restored.frame;
  const cleared = restored.next;

  // requestId 必须与冻结的 CharGenRequest 匹配（幂等键）
  const req = frame.awaiting.kind === 'CharGenRequest' ? frame.awaiting : undefined;
  if (!req || req.requestId !== command.payload.requestId) {
    return rejection(state, {
      code: 'INVALID_PHASE',
      message: `SupplyUnit requestId「${command.payload.requestId}」与冻结 CharGenRequest 不匹配`,
    });
  }

  const definition = command.payload.definition;
  const instanceId = uniqueUnitId(cleared, definition);

  const unitState = buildSummonedUnit(instanceId, definition, command.actorId);

  // ① 插入 units（不可变）
  const units: Record<string, CombatUnitState> = { ...cleared.units, [unitState.id]: unitState };

  // ② 先攻插入（joinTiming 语义：plan §6.2 ⑥ / 架构 §十 10.3）
  let order: string[];
  let tape = cleared.dice;
  if (definition.joinTiming === 'this_round_tail') {
    // 掷 1 颗 initiative，追加到当前回合先攻序列尾部（A35-2）
    const r = draw(tape, 'initiative', 1);
    if ('exhausted' in r) {
      return rejection(state, {
        code: 'INVALID_PHASE',
        message: 'this_round_tail 召唤需 initiative 骰但通道耗尽',
      });
    }
    tape = r.tape;
    order = [...cleared.initiativeOrder, unitState.id];
  } else {
    // next_round_head：追加 id 进序列 base，由下轮 handleInitiative 统一掷（A35-2）
    order = [...cleared.initiativeOrder, unitState.id];
  }

  // ③ automaton 编译 + ActiveEffectIndex 增量 add（A35-3 到期摘除用同样 updateIndex）
  const compiled = compileEffectProgram({
    owner: unitState.id,
    source: definition.sourceItem ?? definition.name,
    idPrefix: unitState.id,
    divinity: definition.divinity,
    modifiers: definition.modifiers ?? [],
    automata: definition.automata,
  });
  const activeEffects =
    compiled.automata.length > 0
      ? updateIndex(cleared.activeEffects, { add: compiled.automata })
      : cleared.activeEffects;

  // ④ 组装待提交变更：复用冻结的 pendingChanges（含 SpendResource FP + 动作槽消费），
  //    叠加「召唤时限」buff（不变量④一次原子提交）
  const summonPatches: PendingChangeSet['statusPatches'] = definition.duration
    ? [
        {
          op: 'apply',
          unitId: unitState.id,
          status: {
            name: '召唤时限',
            description: `召唤物持续 ${definition.duration.rounds} 回合后自动消失`,
            category: '增益',
            stacks: 1,
            remainingTime: definition.duration.rounds,
            timeUnit: '回合',
            source: `[召唤]-[${frame.commandId}]`,
            effects: {},
            lifecycle: '战斗',
          },
        },
      ]
    : [];
  const changes: PendingChangeSet = {
    ...frame.pendingChanges,
    statusPatches: [...summonPatches, ...frame.pendingChanges.statusPatches],
  };

  // ⑤ 一次原子提交（不变量④）：插入 units + 先攻 + 效果索引 + buff + FP 记账
  const base: CombatState = {
    ...cleared,
    units,
    initiativeOrder: order,
    dice: tape,
    activeEffects,
    resolution: undefined,
  };
  const applied = applyPending(base, changes);

  // ⑥ 事件：UnitSummoned + ResourceSpent（FP 已在冻结时入 pendingChanges.fpDelta）
  const events: DomainEvent[] = [];
  events.push({
    kind: 'UnitSummoned',
    unitId: unitState.id,
    joinTiming: definition.joinTiming,
    duration: definition.duration?.rounds ?? null,
    sourceItem: definition.sourceItem,
  });
  if (changes.fpDelta !== 0) {
    events.push({
      kind: 'ResourceSpent',
      unitId: command.actorId,
      resource: 'fp',
      amount: Math.abs(changes.fpDelta),
    });
  }

  // checkTerminal：召唤若致一方全灭（罕见）也正常推进
  const term = checkTerminal(applied);

  return {
    revision: applied.revision,
    snapshot: toView(applied),
    events,
    terminal: term ?? undefined,
    next: applied,
  };
}

/** 由 SummonedUnitDefinition 构建运行时 CombatUnitState（补 id / ability / 初始槽位） */
function buildSummonedUnit(
  id: string,
  d: SummonedUnitDefinition,
  _summonerId: string,
): CombatUnitState {
  // actionEconomy 决定本轮槽位（架构 §十 10.2：full=1攻1动 / partial=仅动作 / no_action=0）
  const economy = d.actionEconomy ?? 'partial';
  const attacks = economy === 'full' ? 1 : 0;
  const actions = economy === 'no_action' ? 0 : 1;
  return {
    id,
    name: d.name,
    side: d.side ?? 'player',
    tier: d.tier,
    level: d.level,
    attributes: {
      str: d.attributes?.str ?? 10,
      dex: d.attributes?.dex ?? 10,
      con: d.attributes?.con ?? 10,
      int: d.attributes?.int ?? 10,
      spi: d.attributes?.spi ?? 10,
    },
    hp: d.hp,
    maxHp: d.hp,
    mp: d.mp,
    maxMp: d.mp,
    sp: d.sp,
    maxSp: d.sp,
    defense: d.defense,
    dr: d.dr,
    penetration: d.penetration,
    hitBonus: d.hitBonus,
    dodgeBonus: d.dodgeBonus,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    weaponAtk: d.weaponAtk,
    canAct: true,
    morale: 'steady',
    attacksRemaining: attacks,
    actionsRemaining: actions,
    statusEffects: [],
    ability: {
      relevantAttribute: d.attributes?.str ?? 10,
      skillPower: 0,
      damageType: '物理',
      intentionLevel: '常规',
      multiHitCount: 1,
      divinity: d.divinity,
    },
  };
}

/** 生成确定性的召唤物唯一实例 id（同名加序号，避免覆盖；零随机） */
function uniqueUnitId(state: CombatState, d: SummonedUnitDefinition): string {
  const base = d.name;
  if (!Object.prototype.hasOwnProperty.call(state.units, base)) return base;
  let n = 2;
  while (Object.prototype.hasOwnProperty.call(state.units, `${base}${n}`)) n += 1;
  return `${base}${n}`;
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
        recompute: ('recompute' in biz.suspended ? biz.suspended.recompute : undefined) as
          DamageRecomputeCtx | undefined,
      });
      return {
        working: frozen,
        events: slotOut.events,
        requiredInput: biz.requiredInput,
        waitForNext: false,
      };
    }
    // M3.5：CharGenRequest（召唤物创造性生成）→ 冻结 ResolutionFrame（step='spawn'，
    // pendingChanges 已含 SpendResource(FP,100)，未提交；SupplyUnit 到达时续跑，A35-1）
    if (biz.requiredInput.kind === 'CharGenRequest' && biz.suspended) {
      const frozen = freezeFrame(working, {
        commandId: command.commandId,
        step: 'spawn',
        pendingChanges: mergeChanges(slotOut.changes, biz.changes),
        diceConsumedInFrame: {
          attackHit: 0,
          initiative: 0,
          intentCheck: 0,
          statusContest: 0,
          procCheck: 0,
        },
        awaiting: biz.requiredInput,
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
  // 终局由 biz.terminal 覆盖为 Terminal。
  // 🔴 2026-08-12（Bug A/C）：Flee 是唯一例外 —— 它不消费槽位（slotOut 恒
  //   SlotConsume），相位流转由 handleFlee 自己决定：成功 → UnitTurnClose
  //   （单位已移除，applyOutcome 摘 initiativeOrder）；失败 → MoraleCheck
  //   （结束本回合，不留在 SlotConsume 无限等同一单位命令）。
  const nextPhase: CombatPhase = biz.terminal
    ? 'Terminal'
    : command.kind === 'Flee'
      ? biz.nextPhase
      : slotOut.nextPhase;
  const out: PhaseOutcome = {
    changes: combined,
    events: [...slotOut.events, ...biz.events],
    nextPhase: nextPhase as PhaseOutcome['nextPhase'],
    dice: biz.dice ?? slotOut.dice,
    terminal: biz.terminal,
    round: biz.round,
    // 🔴 2026-08-12（Bug C 修复）：业务结算产出的 removeUnitIds / activeEffects
    //   必须透传给 applyOutcome —— 此前漏透传，UnitDespawned 事件发了但单位
    //   没有被从 units / initiativeOrder 摘除（逃跑成功 = 白跑）。
    removeUnitIds: biz.removeUnitIds,
    activeEffects: biz.activeEffects,
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
      return handleAttack(working, command);
    case 'DeclareAction':
      return handleAction(bundle, working, command);
    case 'Flee':
      return handleFlee(bundle, working, command);
    case 'PassAttack':
    case 'PassAction':
    case 'EndTurn':
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
    case 'PassAction':
    case 'EndTurn': {
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

/**
 * 🔴 2026-08-12（真机 bug：首回合面板「攻0动0」修复）：
 * 开局首次 SupplyDice 注骰后，kernel 从 CombatOpen 继续 auto 推进到 SlotConsume：
 *   CombatOpen → RoundOpen（handleRoundOpen）→ Initiative（handleInitiative 掷先攻）
 *   → UnitTurnOpen（openUnitTurn 发槽）→ SlotConsume（返回 PlayerCommand 等玩家命令）。
 *
 * 背景：`reduceSupplyDice` 只注骰、phase 保持 CombatOpen 零推进。此前 coordinator 在
 * 注骰后、发槽前就问玩家 → 面板 `攻0动0`，AI 误判「没槽可动」。让开局首骰继续推进，
 * 玩家第一次被问时槽位已发放（面板攻1动1）。
 *
 * 幂等/续杯安全：仅在 phase === 'CombatOpen'（开局首次）调用；续杯（Initiative 等）
 * 走 reduceSupplyDice 原路径（注骰即回，由协调器 BeginOutput 路由决定下一个动作单位）。
 */
function advanceAfterOpeningSupply(
  bundle: CombatDefinitionBundle,
  original: CombatState,
  supplied: CombatTransition,
): CombatTransition {
  const next0 = supplied.next;
  if (!next0) {
    throw new KernelStuckError('开局 SupplyDice 注骰返回空 next');
  }
  let working: CombatState = next0;
  const events: PhaseOutcome['events'][] = [supplied.events] as unknown as PhaseOutcome['events'][];

  // 从 CombatOpen 起循环 auto 推进（与 runDispatch 同款：rejection / 骰尽 / Terminal 兜底）
  let guard = 0;
  while (true) {
    if (++guard > MAX_STEPS_PER_DISPATCH) {
      throw new KernelStuckError(
        `Kernel 熔断：开局 SupplyDice 推进超过 ${MAX_STEPS_PER_DISPATCH} 个微步骤（phase: ${working.phase}）`,
      );
    }
    const phase = working.phase;
    if (phase === 'SlotConsume' || phase === 'Terminal' || phase === 'SettlementCommitted') {
      break;
    }
    const autoFn = AUTO_PHASES[phase as CombatPhase];
    if (!autoFn) {
      throw new KernelStuckError(`开局推进遇到未知 phase「${phase}」`);
    }
    // CombatOpen 首步发 CombatOpened（与 runDispatch 552 行同款）
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
      // 骰尽 → 返回 BeginOutput（coordinator 续杯；此时不在玩家轮，不产生面板误导）
      return buildTransition(original, events, {
        requiredInput: out.requiredInput,
        snapshotState: working,
      });
    }
    if (out.rejection) {
      return buildTransition(original, events, { snapshotState: working });
    }
    if (out.events.length > 0) events.push(out.events);
    const next = applyOutcome(working, out);
    if (!next) {
      throw new KernelStuckError(`开局推进 applyOutcome 返回空（phase: ${working.phase}）`);
    }
    working = next;
  }

  // 到 SlotConsume → 返回 PlayerCommand（当前单位等命令；槽位已发，面板正确）
  if (working.phase === 'SlotConsume') {
    const id = currentUnitId(working);
    const u = id ? working.units[id] : undefined;
    return buildTransition(original, events, {
      snapshotState: working,
      requiredInput: {
        kind: 'PlayerCommand',
        unitId: id ?? '',
        unitName: u?.name ?? '',
        round: working.round,
      },
    });
  }
  // Terminal（极小概率：开战即终局）→ 照常返回
  return buildTransition(original, events, { snapshotState: working });
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
