/**
 * combat-v3/phases/action.ts — 战术动作 / 逃跑 handler（M1/M3.5）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §二 2.2 / §四 4.5 / §十 10.2
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3 / §3.2 / §6.2（A35-1）
 *
 * M1 最小实现：
 *   - DeclareAction：战术动作（道具/移动/专注/防御），消费动作槽（consumeSlot 管）+ 产 NarrativeCue 事件
 *   - Flee：逃跑检定（从 statusContest 取骰，d20 + 敏捷 vs DC 12），成功 → Terminal(flee_success)，
 *     失败 → 消费攻击+动作槽，产 FleeAttempt
 *
 * M3.5 扩展（开放召唤出口，A35-1）：
 *   - DeclareAction 结算时求值 action.declared 窗口，若 automaton 返回 SpawnOrDespawnIntent(op:'spawn'):
 *       · templateRef 缺省（AI 创造性召唤）→ 冻结 spawn frame + 返回 RequiredInput.CharGenRequest
 *       · templateRef 命中（预生成池）→ 由 coordinator/reducer 实例化（本文件只标 requiredInput 信号，
 *         实际实例化走 SupplyUnit；templateRef 版本也可在此直接产事件——M3.5 先走 CharGenRequest 统一出口）
 *   - 非 spawn 意图（SpendResource 等）仍照常并入 pendingChanges（与冻结 FP 扣费同批）
 *
 * 槽位消费统一由 unit-turn.consumeSlot 处理（A1-1 行动槽强制）；本文件只结算动作的数值/事件。
 */

import { draw } from '../dice-tape';
import { runWindow, makeWindowRuntimeCtx } from '../windows';
import { validateBatch, applyIntents } from '../intents';
import type {
  CombatCommand,
  CombatDefinitionBundle,
  CombatState,
  EffectIntent,
  SpawnOrDespawnIntent,
} from '../types';
import { emptyChanges, type PhaseOutcome } from './outcome';

/** DeclareAction 的动作分支（架构 §二 2.2） */
export type TacticalActionType = 'item' | 'move' | 'focus' | 'defend';

/** 生成一个确定性 requestId（召唤冻结幂等键；零随机） */
let _spawnSeq = 0;
function spawnRequestId(actorId: string): string {
  _spawnSeq += 1;
  return `summon-${actorId}-${_spawnSeq}`;
}

/**
 * 结算一次 DeclareAction。
 * 该命令的 action 槽已由 consumeSlot 消费；这里只产事件。
 * M3.5：求值 action.declared 窗口，拦截 SpawnOrDespawnIntent 触发 CharGenRequest（A35-1）。
 */
export function handleAction(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'DeclareAction' }>,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };

  // 错误隔离：单 automaton 抛错不打断动作（rejections 由 runWindow 记进 out.events）
  const declaredIntents = runWindow(
    out.events,
    state.activeEffects,
    'action.declared',
    makeWindowRuntimeCtx(state, {
      selfId: command.actorId,
      round: state.round,
      window: 'action.declared',
    }),
  );

  // 收集 spawn 意图 + 已验证的非 spawn 费用意图（A3-7 / A35-1）
  const { spawns, nonSpawn } = collectSpawnAndFees(declaredIntents);

  if (spawns.length > 0) {
    return handleSpawnIntents(out, state, bundle, command, spawns, nonSpawn);
  }

  const actionType: TacticalActionType = command.payload.actionType;
  const actor = state.units[command.actorId];
  const actionName =
    actionType === 'item'
      ? '使用道具'
      : actionType === 'move'
        ? '移动'
        : actionType === 'focus'
          ? '专注'
          : '防御';

  out.events.push({
    kind: 'NarrativeCue',
    text: `${actor?.name ?? command.actorId} ${actionName}${command.payload.description ? `：${command.payload.description}` : ''}`,
  });

  return out;
}

/**
 * M3.5：处理 action.declared 窗口产出的 SpawnOrDespawnIntent（A35-1）。
 *
 * 取第一条 spawn 意图（多 spawn 意图本 milestone 按第一条，M4 串行处理）：
 *   - templateRef 缺省 → 冻结 spawn frame + 返回 RequiredInput.CharGenRequest
 *   - 把同窗口的非 spawn 意图（SpendResource FP / EmitNarrativeCue 等）apply 到 out.changes，
 *     使冻结 frame 的 pendingChanges 含费用扣减，与 SupplyUnit 恢复时同批原子提交（不变量④，A35-6）
 *
 * @param nonSpawn 同窗口已验证的非 spawn 意图（供 applyIntents 落地费用；spawn 意图本身不 apply）
 */
function handleSpawnIntents(
  out: PhaseOutcome,
  state: CombatState,
  _bundle: CombatDefinitionBundle,
  command: Extract<CombatCommand, { kind: 'DeclareAction' }>,
  spawns: readonly SpawnOrDespawnIntent[],
  nonSpawn: readonly EffectIntent[],
): PhaseOutcome {
  const spawn = spawns[0];

  // 落地费用意图（SpendResource FP=100 等进 out.changes.fpDelta，供冻结 frame 持有）
  if (nonSpawn.length > 0) {
    const applyCtx: Parameters<typeof applyIntents>[0] = {
      state,
      automatonOwner: command.actorId,
      present: (id) => Object.prototype.hasOwnProperty.call(state.units, id),
      resolveNumber: () => 0,
    };
    const res = applyIntents(applyCtx, nonSpawn, out.changes);
    for (const n of res.narrative) out.events.push({ kind: 'NarrativeCue', text: n });
  }

  const sourceItem = command.payload.description || '召唤技能';
  const summonerIntent =
    command.payload.description ||
    `${state.units[command.actorId]?.name ?? command.actorId} 发动召唤`;

  const requestId = spawnRequestId(command.actorId);

  // A35-1：templateRef 缺省（创造性召唤）→ 冻结 spawn frame + CharGenRequest
  out.requiredInput = {
    kind: 'CharGenRequest',
    requestId,
    prompt: {
      race: undefined,
      tier: undefined,
      role: undefined,
      sourceItem,
      summonerIntent,
    },
    constraints: {
      divinityCap: state.units[command.actorId]?.ability?.divinity ?? 0,
      attributeBudget: 300,
      durationRounds: spawn.duration?.rounds,
    },
  };
  out.suspended = { spawn: true };
  out.nextPhase = 'SlotConsume';
  return out;
}

/**
 * 从 action.declared 收集的 intent 中提取全部 SpawnOrDespawnIntent（op='spawn'），
 * 同时聚合同窗口所有**已验证**的非 spawn 意图（供费用落地）。
 * batch 校验失败（A3-7 批原子性）→ 该 batch 的意图整体忽略。
 */
function collectSpawnAndFees(
  batches: readonly { automatonId: string; owner: string; intents: readonly EffectIntent[] }[],
): { spawns: SpawnOrDespawnIntent[]; nonSpawn: EffectIntent[] } {
  const spawns: SpawnOrDespawnIntent[] = [];
  const nonSpawn: EffectIntent[] = [];
  for (const b of batches) {
    const valid = validateBatch(b.intents);
    if (!valid.ok) continue; // 该 batch 非法 → 整批忽略
    for (const intent of b.intents) {
      if (intent.kind === 'SpawnOrDespawnIntent') {
        const sp = intent as SpawnOrDespawnIntent;
        if (sp.op === 'spawn') spawns.push(sp);
      } else {
        nonSpawn.push(intent);
      }
    }
  }
  return { spawns, nonSpawn };
}

/**
 * 结算一次逃跑（Flee，cost 'both'）。
 *
 * 检定：从 statusContest 取骰 → `d20 + 敏捷` ≥ DC 12 成功。
 * 成功 → Terminal(flee_success)；失败 → 两槽照常消费（consumeSlot 已扣），产 FleeAttempt(false)。
 */
export function handleFlee(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'Flee' }>,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };
  const actor = state.units[command.actorId];
  if (!actor) {
    out.rejection = { code: 'TARGET_NOT_PRESENT', message: '逃跑者不在场' };
    return out;
  }

  const r = draw(state.dice, 'statusContest', 1);
  if ('exhausted' in r) {
    out.requiredInput = { kind: 'BeginOutput', channel: 'statusContest' };
    return out;
  }
  out.dice = r.tape;
  const roll = r.rolls[0];

  const check = roll + actor.attributes.dex;
  const success = check >= 12;

  out.events.push({ kind: 'FleeAttempt', unitId: actor.id, success, roll });

  if (success) {
    out.nextPhase = 'Terminal';
    out.terminal = { reason: 'flee_success', winner: undefined };
  } else {
    out.nextPhase = 'SlotConsume';
  }
  return out;
}
