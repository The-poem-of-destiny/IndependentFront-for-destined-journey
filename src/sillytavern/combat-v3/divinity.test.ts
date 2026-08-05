/**
 * combat-v3/divinity.test.ts — A4-4 divinity 压制不消费骰子（attack.check.intent / ApplyStatus.contest 集成）
 *
 * 核心断言（架构 §八 8.3）：
 *   - 意图对抗：攻击者 divinity − 守方 ≥5 → 必成，**不消费 intentCheck 骰**（cursor 不进）
 *   - 意图对抗：守方 divinity − 攻方 ≥5 → 必败，**不消费 intentCheck 骰**
 *   - 状态对抗：ApplyStatus.contest 守方 div 高 ≥5 → 状态不施加
 */

import { describe, expect, it } from 'vitest';
import { createCombatState } from './state';
import { reduce } from './reducer';
import type { CombatDefinitionBundle, CombatState } from './types';
import { mkBundle, mkParticipant, mkAttack } from './test-utils';

/** 给 bundle 建 state 并给若干单位注入 divinity（into ability.divinity） */
function withDivinity(bundle: CombatDefinitionBundle, divs: Record<string, number>): CombatState {
  const state = createCombatState(bundle);
  for (const [id, div] of Object.entries(divs)) {
    if (!state.units[id]) continue;
    state.units = {
      ...state.units,
      [id]: { ...state.units[id], ability: { ...state.units[id].ability!, divinity: div } },
    };
  }
  return state;
}

describe('A4-4 意图对抗 divinity 压制（check.intent）', () => {
  it('差 ≥5 攻高必成：不消费 intentCheck 骰（cursor 不前进）', () => {
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲'),
        mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      ],
    });
    const state = withDivinity(bundle, { 甲: 6, 乙: 0 }); // 差 6 ≥5，攻高
    const before = state.dice.current.cursors.intentCheck;
    const t = reduce(bundle, state, mkAttack('a1', state.revision, '甲', '乙'));
    const after = (t.next ?? state).dice.current.cursors.intentCheck;
    // 意图骰未被消费（A4-4 不消费骰子）
    expect(after).toBe(before);
    // 攻击确实执行（命中骰在 attackHit 通道消费）
    expect(t.events.some((e) => (e as { kind?: string }).kind === 'AttackResolved')).toBe(true);
  });

  it('差 ≥5 守高必败：不消费 intentCheck 骰', () => {
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲'),
        mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      ],
    });
    const state = withDivinity(bundle, { 甲: 0, 乙: 6 }); // 差 -6 ≤ -5，守高
    const before = state.dice.current.cursors.intentCheck;
    const t = reduce(bundle, state, mkAttack('a2', state.revision, '甲', '乙'));
    const after = (t.next ?? state).dice.current.cursors.intentCheck;
    expect(after).toBe(before);
    expect(t.events.some((e) => (e as { kind?: string }).kind === 'AttackResolved')).toBe(true);
  });
});

describe('A4-4 状态对抗 divinity 压制（ApplyStatus.contest）', () => {
  it('守方 div 高 ≥5 → 状态不施加（守方抵抗）', async () => {
    const { applyIntents } = await import('./intents');
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲'),
        mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      ],
    });
    const state = createCombatState(bundle);
    const ctx = {
      state,
      automatonOwner: '甲',
      resolveNumber: () => 0,
      present: (id: string) => Boolean(state.units[id] && state.units[id].hp > 0),
    };
    const r = applyIntents(
      ctx,
      [
        {
          kind: 'ApplyStatus' as const,
          targetId: '乙',
          statusId: '迟缓',
          duration: 2,
          contest: { attackerDivinity: 0, defenderDivinity: 6 }, // 守高 ≥5
        },
      ],
      {
        hpChanges: {},
        mpChanges: {},
        spChanges: {},
        fpDelta: 0,
        statusPatches: [] as never[],
        slotConsumptions: [],
      },
    );
    expect(r.changes.statusPatches).toHaveLength(0); // 状态未施加
  });

  it('攻方 div 高 ≥5 → 状态照常施加', async () => {
    const { applyIntents } = await import('./intents');
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲'),
        mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      ],
    });
    const state = createCombatState(bundle);
    const ctx = {
      state,
      automatonOwner: '甲',
      resolveNumber: () => 0,
      present: (id: string) => Boolean(state.units[id] && state.units[id].hp > 0),
    };
    const r = applyIntents(
      ctx,
      [
        {
          kind: 'ApplyStatus' as const,
          targetId: '乙',
          statusId: '迟缓',
          duration: 2,
          contest: { attackerDivinity: 6, defenderDivinity: 0 }, // 攻高 ≥5
        },
      ],
      {
        hpChanges: {},
        mpChanges: {},
        spChanges: {},
        fpDelta: 0,
        statusPatches: [] as never[],
        slotConsumptions: [],
      },
    );
    expect(r.changes.statusPatches).toHaveLength(1); // 状态施加
  });
});
