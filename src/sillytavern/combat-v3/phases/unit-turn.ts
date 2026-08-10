/**
 * combat-v3/phases/unit-turn.ts — UnitTurnOpen / SlotConsume / MoraleCheck / UnitTurnClose（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §二 2.4（状态机）/ §四 4.5（士气骰）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.3 / §3.5（M-3 / M-4）
 *
 * M-3 修复：行动槽强制——`Command.cost` 由内核验证并消费；`resetTurnResources` 改为
 *   **只给 canAct && hp>0 的单位发槽**（其余发 0，自动跳过，验收 A1-1 / A1-2）。
 * M-4 修复：士气 d20 从 `statusContest` 通道取（调 v2 `checkMorale`），不再恒 10。
 *
 * 状态机（plan §3.3）：
 *   UnitTurnOpen --auto--> SlotConsume
 *   SlotConsume --Command(槽位未耗尽)--> SlotConsume（同单位继续等）
 *   SlotConsume --两槽处理完--> MoraleCheck
 *   MoraleCheck --auto--> UnitTurnClose
 *   UnitTurnClose --还有单位--> UnitTurnOpen / 全部处理完--> RoundClose
 */

import { draw } from '../dice-tape';
import { checkMorale, getMoraleThreshold } from '../../morale-system';
import { runWindow, makeWindowRuntimeCtx } from '../windows';
import { applyIntents } from '../intents';
import type { CombatCommand, CombatDefinitionBundle, CombatState } from '../types';
import { emptyChanges, type PhaseOutcome } from './outcome';

/** 当前正在行动的单位 id（initiativeOrder[currentTurnIndex]），不存在返回 null */
export function currentUnitId(state: CombatState): string | null {
  const order = state.initiativeOrder;
  if (order.length === 0) return null;
  const idx = Math.min(state.currentTurnIndex, order.length - 1);
  return order[idx] ?? null;
}

/**
 * UnitTurnOpen：给当前单位发槽（M-3 只发 canAct && hp>0），发 TurnOpened 事件。
 * - hp>0 且 canAct：攻击/动作各 1
 * - 否则：发 0/0（该单位本回合无行动，自动走 MoraleCheck → 下一位）
 */
export function openUnitTurn(bundle: CombatDefinitionBundle, state: CombatState): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };
  const id = currentUnitId(state);
  if (!id || !state.units[id]) {
    // 无在场单位 → 直接 RoundClose
    out.nextPhase = 'RoundClose';
    return out;
  }
  const u = state.units[id];

  // A4-3（架构 §八 8.2 action.freezeSlot 窗口触发源）：turn.open 窗口求值并应用
  // OverrideIntent(action.freezeSlot) → out.changes.freezeSlotPatches → applyPending 合并进
  // state.frozenSlots。当前单位（如时间收割者）通过 turn.open 冻结敌方（如理查德）槽位，
  // 生效点在**后续**单位的 openUnitTurn（activeFrozenFor 读 state.frozenSlots）。
  // 本次冻结对当前单位自身本轮 open 无效（activeFrozenFor 用应用前的 state），符合设计。
  applyTurnOpenIntents(out, state, id);

  const activatable = u.hp > 0 && u.canAct;
  // A4-3（架构 §八 8.2 action.freezeSlot）：被冻结的单位槽位不发，TurnClosed 直接跳过
  const frozen = activeFrozenFor(state, id);
  const freezeAttack = activatable && !frozen.attack;
  const freezeAction = activatable && !frozen.action;
  const attacks = freezeAttack ? 1 : 0;
  const actions = freezeAction ? 1 : 0;

  out.changes.turnOpenSlots = [{ actorId: id, attacks, actions }];
  out.events.push({
    kind: 'TurnOpened',
    unitId: id,
    attacksRemaining: attacks,
    actionsRemaining: actions,
  });

  // 不行动单位（含两槽全冻结）自动跳过两槽 → 进入 MoraleCheck
  if (attacks === 0 && actions === 0) {
    out.nextPhase = 'MoraleCheck';
  }
  return out;
}

/**
 * A4-3：turn.open 窗口求值并应用 OverrideIntent（action.freezeSlot）。
 *
 * 触发源：当前单位开回合时，其挂 turn.open 的 automaton（如时间暂停）产
 * OverrideIntent(ruleKey='action.freezeSlot')，经 applyIntents 的 OverrideIntent 分支
 * 写入 out.changes.freezeSlotPatches（applyPending 合并进 state.frozenSlots，max_rounds）。
 *
 * 错误隔离：单个 automaton 抛错不打断开回合（rejections 收集进 out.events）。
 */
function applyTurnOpenIntents(out: PhaseOutcome, state: CombatState, unitId: string): void {
  const winCtx = makeWindowRuntimeCtx(state, {
    selfId: unitId,
    round: state.round,
    window: 'turn.open',
  });
  const openIntents = runWindow(out.events, state.activeEffects, 'turn.open', winCtx);

  // 逐批：非 OverrideIntent 的统一忽略（本轮 open 只消费 freezeSlot override）
  for (const raw of openIntents) {
    const freezeOverrides = raw.intents.filter(
      (i) => i.kind === 'OverrideIntent' && i.ruleKey === 'action.freezeSlot',
    );
    if (freezeOverrides.length === 0) continue;
    const r = applyIntents(
      {
        state,
        automatonOwner: raw.owner,
        resolveNumber: (expr, fb) => {
          // turn.open 窗口无 damage，直接按字面量 fallback（OverrideIntent 载荷为字面量）
          const n = Number(expr);
          return Number.isFinite(n) ? n : fb;
        },
        present: (id2) => Object.prototype.hasOwnProperty.call(state.units, id2),
      },
      freezeOverrides,
      {
        hpChanges: out.changes.hpChanges,
        mpChanges: out.changes.mpChanges,
        spChanges: out.changes.spChanges,
        fpDelta: out.changes.fpDelta,
        statusPatches: out.changes.statusPatches,
        freezeSlotPatches: out.changes.freezeSlotPatches,
        slotConsumptions: out.changes.slotConsumptions,
      },
    );
    out.changes.fpDelta = r.changes.fpDelta;
    out.changes.statusPatches = r.changes.statusPatches;
    out.changes.freezeSlotPatches = r.changes.freezeSlotPatches;
  }
}

/**
 * 查询某单位当前是否被冻结了攻击/动作槽（A4-3）。
 * 遍历 state.frozenSlots，命中 slotType='both' 或对应槽 → 该槽冻结。
 */
function activeFrozenFor(state: CombatState, unitId: string): { attack: boolean; action: boolean } {
  const frozen = state.frozenSlots ?? [];
  let attack = false;
  let action = false;
  for (const f of frozen) {
    if (f.targetId !== unitId) continue;
    if (f.rounds < 1) continue; // 已过期
    if (f.slotType === 'both' || f.slotType === 'attack') attack = true;
    if (f.slotType === 'both' || f.slotType === 'action') action = true;
  }
  return { attack, action };
}

/**
 * SlotConsume：验证并消费一个 Command 的 `cost`（M-3 行动槽强制）。
 *
 * 校验（验收 A1-2）：
 *   - actor 必须在场（target-not-present → rejection，由 reducer 仲裁）
 *   - actor 必须是当前行动单位（否则 invalid）
 *   - cost 对应的槽位必须剩 >0（SLOT_EXHAUSTED）
 *
 * 消费后：
 *   - DeclareAttack / PassAttack / DeclareAction / PassAction 消费对应槽
 *   - 两槽都归 0 → nextPhase 'MoraleCheck'；否则留在 'SlotConsume'（同单位等待）
 *   - Flee（cost 'both'）→ 消费攻击+动作，进 Flee 检定（action.ts/flee）
 */
export function consumeSlot(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: CombatCommand,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };
  const current = currentUnitId(state);
  const u = state.units[command.actorId];
  if (!u || current !== command.actorId) {
    // 非当前单位 → reducer 上层会 reject；这里返回一个空 advance 避免卡死
    out.rejection = { code: 'INVALID_PHASE', message: '非当前单位，无法消费槽位' };
    return out;
  }

  // EndTurn（结束回合）：放弃当前单位**全部**剩余槽位（攻击+动作），一次命令。
  // 语义等价连续 PassAttack + PassAction；槽位清零后直接进 MoraleCheck，
  // 相位流转与「两槽自然耗尽」完全一致（不变量①：Pass 也消费槽位）。
  if (command.kind === 'EndTurn') {
    if (u.attacksRemaining > 0) {
      out.changes.slotConsumptions.push({ actorId: command.actorId, slot: 'attack' });
    }
    if (u.actionsRemaining > 0) {
      out.changes.slotConsumptions.push({ actorId: command.actorId, slot: 'action' });
    }
    out.nextPhase = 'MoraleCheck';
    return out;
  }

  // 按 cost 消费槽（Pass 也消费，不变量①）
  const slot =
    command.cost === 'attack'
      ? 'attack'
      : command.cost === 'action'
        ? 'action'
        : command.cost === 'both'
          ? 'both'
          : null;

  if (slot === null) {
    // cost 'none'（Choose / Adjudicate / SupplyDice / RequestSettlement）不走槽位消耗，
    // 由 reducer 单独路由，不应进到这里。
    out.nextPhase = 'SlotConsume';
    return out;
  }

  if (slot === 'attack') {
    if (u.attacksRemaining <= 0) {
      out.rejection = { code: 'SLOT_EXHAUSTED', message: '攻击槽已耗尽' };
      return out;
    }
    out.changes.slotConsumptions.push({ actorId: command.actorId, slot: 'attack' });
  } else if (slot === 'action') {
    if (u.actionsRemaining <= 0) {
      out.rejection = { code: 'SLOT_EXHAUSTED', message: '动作槽已耗尽' };
      return out;
    }
    out.changes.slotConsumptions.push({ actorId: command.actorId, slot: 'action' });
  } else {
    // both（Flee）：攻击 + 动作 各消费一个
    if (u.attacksRemaining <= 0 || u.actionsRemaining <= 0) {
      out.rejection = { code: 'SLOT_EXHAUSTED', message: '需要攻击+动作槽（逃跑）' };
      return out;
    }
    out.changes.slotConsumptions.push(
      { actorId: command.actorId, slot: 'attack' },
      { actorId: command.actorId, slot: 'action' },
    );
  }

  // 判断是否两槽都归零 → MoraleCheck；否则同单位继续等 PlayerCommand
  const after = {
    attacks: u.attacksRemaining - (slot === 'attack' || slot === 'both' ? 1 : 0),
    actions: u.actionsRemaining - (slot === 'action' || slot === 'both' ? 1 : 0),
  };
  if (after.attacks <= 0 && after.actions <= 0) {
    out.nextPhase = 'MoraleCheck';
  }
  return out;
}

/**
 * MoraleCheck（M-4）：对该单位做一次战意检定。
 * 骰值从 statusContest 通道取（调 v2 checkMorale）。非 player 单位才触发战意事件；
 * 战意溃逃 → Termina（morale_routed）。
 */
export function runMoraleCheck(bundle: CombatDefinitionBundle, state: CombatState): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'UnitTurnClose',
  };
  const id = currentUnitId(state);
  if (!id || !state.units[id]) {
    out.nextPhase = 'UnitTurnClose';
    return out;
  }
  const u = state.units[id];

  // 玩家单位不做战意溃逃判定（v2：非 user 才触发）
  if (u.side === 'player') {
    out.nextPhase = 'UnitTurnClose';
    return out;
  }

  // M-4：士气 d20 从 statusContest 通道取
  const r = draw(state.dice, 'statusContest', 1);
  if ('exhausted' in r) {
    out.requiredInput = { kind: 'BeginOutput', channel: 'statusContest' };
    return out;
  }
  out.dice = r.tape;
  const roll = r.rolls[0];

  const hpRatio = u.maxHp > 0 ? u.hp / u.maxHp : 0;
  const result = checkMorale(hpRatio, bundle.combatType, roll);
  const threshold = getMoraleThreshold(bundle.combatType);

  out.events.push({
    kind: 'MoraleChanged',
    unitId: id,
    threshold,
    roll,
    state: result.moraleState,
  });

  if (result.triggered && result.moraleState === 'routing') {
    out.nextPhase = 'Terminal';
    out.terminal = { reason: 'morale_routed', winner: undefined };
  } else {
    out.nextPhase = 'UnitTurnClose';
  }
  return out;
}

/**
 * UnitTurnClose：推进到下一个单位（或 RoundClose）。
 *
 * 模型：本轮按 initiative 顺序线性走一遍，index 只前进不回头（n 个 index 各处理一次）。
 * 死亡/失能单位在「自己的」UnitTurnOpen 里发 0 槽并自动跳到下一位——不需要在此跳过。
 * index 到达末尾 → RoundClose。
 */
export function closeUnitTurn(bundle: CombatDefinitionBundle, state: CombatState): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'UnitTurnOpen',
  };

  const order = state.initiativeOrder;
  if (order.length === 0) {
    out.nextPhase = 'RoundClose';
    return out;
  }

  // 记录当前单位槽位消费结果（审计）
  const id = currentUnitId(state);
  if (id && state.units[id]) {
    const u = state.units[id];
    out.events.push({
      kind: 'TurnClosed',
      unitId: id,
      attacksConsumed: 1 - u.attacksRemaining,
      actionsConsumed: 1 - u.actionsRemaining,
    });
  }

  // 线性推进 index（不回头）
  const nextIndex = state.currentTurnIndex + 1;
  if (nextIndex >= order.length) {
    out.nextPhase = 'RoundClose';
    return out;
  }
  out.currentTurnIndex = nextIndex;
  out.nextPhase = 'UnitTurnOpen';
  return out;
}
