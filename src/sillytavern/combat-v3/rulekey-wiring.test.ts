/**
 * combat-v3/rulekey-wiring.test.ts — A4-3 closed RuleKey 引擎接线
 *
 * 覆盖 action.freezeSlot（第 13 场时间暂停）完整链路：
 *   OverrideIntent → applyIntents 产 freezeSlotPatches → applyPending 合并进
 *   state.frozenSlots（max_rounds）→ openUnitTurn 对被冻结单位不发槽 → round.close 递减。
 *
 * 不依赖 fixture / replay harness，直接驱动纯函数。
 */

import { describe, expect, it } from 'vitest';
import { createCombatState, applyPending } from './state';
import { applyIntents } from './intents';
import { openUnitTurn, currentUnitId } from './phases/unit-turn';
import { handleRoundClose } from './phases/round';
import { mkBundle, mkParticipant } from './test-utils';
import type { CombatState } from './types';

const bundle = (() =>
  mkBundle({
    participants: [
      mkParticipant('甲'),
      mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
    ],
  }))();

/** 直接构造一个带 frozenSlots 的 state，验证 openUnitTurn 强制不发槽 */
function stateWithFrozen(frozenSlots: CombatState['frozenSlots']): CombatState {
  const s = createCombatState(bundle);
  return { ...s, initiativeOrder: ['乙', '甲'], currentTurnIndex: 0, frozenSlots };
}

describe('OverrideIntent → freezeSlotPatches（intents.applyIntents）', () => {
  it('action.freezeSlot override 产 freezeSlotPatches 条目（max_rounds）', () => {
    const state = createCombatState(bundle);
    const r = applyIntents(
      { state, automatonOwner: '甲', resolveNumber: () => 0, present: () => true },
      [
        {
          kind: 'OverrideIntent',
          ruleKey: 'action.freezeSlot',
          payload: { targetId: '乙', slotType: 'attack', rounds: 3 },
          divinity: 6,
        },
      ],
      {
        hpChanges: {},
        mpChanges: {},
        spChanges: {},
        fpDelta: 0,
        statusPatches: [],
        slotConsumptions: [],
      },
    );
    expect(r.changes.freezeSlotPatches).toHaveLength(1);
    expect(r.changes.freezeSlotPatches![0]).toMatchObject({
      targetId: '乙',
      slotType: 'attack',
      rounds: 3,
    });
  });
});

describe('applyPending 合并 frozenSlots（max_rounds）', () => {
  it('同目标同槽取 rounds 最大，其它槽独立保留', () => {
    const state = createCombatState(bundle);
    const next = applyPending(state, {
      hpChanges: {},
      mpChanges: {},
      spChanges: {},
      fpDelta: 0,
      statusPatches: [],
      slotConsumptions: [],
      freezeSlotPatches: [
        { targetId: '乙', slotType: 'attack', rounds: 2 },
        { targetId: '乙', slotType: 'attack', rounds: 5 }, // 冲突 → 取 5
        { targetId: '乙', slotType: 'action', rounds: 1 },
      ],
    });
    expect(next.frozenSlots).toHaveLength(2);
    const atk = next.frozenSlots!.find((f) => f.slotType === 'attack');
    const act = next.frozenSlots!.find((f) => f.slotType === 'action');
    expect(atk!.rounds).toBe(5); // max_rounds
    expect(act!.rounds).toBe(1);
  });
});

describe('openUnitTurn 强制不发冻结槽（A4-3）', () => {
  it('攻击槽被冻结 → attacksRemaining 0，TurnOpened 反映', () => {
    const state = stateWithFrozen([{ targetId: '乙', slotType: 'attack', rounds: 2 }]);
    expect(currentUnitId(state)).toBe('乙');
    const out = openUnitTurn(bundle, state);
    expect(out.changes.turnOpenSlots![0]).toMatchObject({ actorId: '乙', attacks: 0, actions: 1 });
    // 冻结攻击槽 → 该单位只发动作槽
    const evt = out.events.find((e) => e.kind === 'TurnOpened') as
      { attacksRemaining: number } | undefined;
    expect(evt?.attacksRemaining).toBe(0);
  });

  it('both 冻结 → 攻击+动作都不发，直接跳 MoraleCheck', () => {
    const state = stateWithFrozen([{ targetId: '乙', slotType: 'both', rounds: 1 }]);
    const out = openUnitTurn(bundle, state);
    expect(out.changes.turnOpenSlots![0]).toMatchObject({ actorId: '乙', attacks: 0, actions: 0 });
    expect(out.nextPhase).toBe('MoraleCheck');
  });
});

describe('round.close 冻结回合递减（A4-3）', () => {
  it('rounds 递减 1，归 0 剔除', () => {
    const state = stateWithFrozen([
      { targetId: '乙', slotType: 'attack', rounds: 2 },
      { targetId: '甲', slotType: 'action', rounds: 1 },
    ]);
    const out = handleRoundClose(bundle, state);
    expect(out.frozenSlots).toHaveLength(1);
    expect(out.frozenSlots![0]).toMatchObject({ targetId: '乙', slotType: 'attack', rounds: 1 });
    // 甲 的 action 冻结（rounds 1→0）被剔除
  });
});

describe('death.threshold（A4-3，架构 §八 8.2 / 8.3）', () => {
  it('PreventDeath(HP 阈值 → 保留)：ApplyStatus 之类的窗口中把 HP 截断到调用点求值的 hp', async () => {
    // 直接用 applyIntents 验证 PreventDeath intent 本身不产 hpChanges（由 attack.unit.beforeDown 消费）
    const state = createCombatState(bundle);
    const r = applyIntents(
      { state, automatonOwner: '甲', resolveNumber: () => 0, present: () => true },
      [{ kind: 'PreventDeath', targetId: '乙', hp: 300, slot: 'death.threshold' }],
      {
        hpChanges: {},
        mpChanges: {},
        spChanges: {},
        fpDelta: 0,
        statusPatches: [],
        slotConsumptions: [],
      },
    );
    // PreventDeath 是窗口语义（unit.beforeDown），不直接改 pending HP；此处仅为验证不抛错、零副作用
    expect(r.changes.hpChanges).toEqual({});
  });
});
