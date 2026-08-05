/**
 * combat-v3/phases/terminal.test.ts — 终局四出口 + settlement 幂等（M1）
 *
 * 验收对应（plan §3.7 / §3.1）：
 *   A1-6  终局四出口（HP全灭 / 士气溃逃 / 逃跑成功 / forceTerminal）任一成立进 Terminal，
 *         此后 dispatch 只接受 RequestSettlement
 *   A1-7  settle 同 settlementId 幂等：二次调用返回既有结果，不产生第二套 EXP/FP（C3）
 */

import { describe, expect, it } from 'vitest';
import { reduce } from '../reducer';
import { createCombatState, applyOutcome } from '../state';
import { checkTerminal, settle } from './terminal';
import type { CombatState } from '../types';
import { mkBundle, mkPass, mkSettle } from '../test-utils';

describe('A1-6：终局四出口', () => {
  it('HP 全灭（enemy 全灭）→ checkTerminal 返回 hp_zero', () => {
    const bundle = mkBundle();
    const s = createCombatState(bundle);
    // 乙 HP→0
    const deadState = applyOutcome(s, {
      changes: { ...emptyChg(), hpChanges: { 乙: -500 } },
      events: [],
      nextPhase: 'CombatOpen',
    });
    const t = checkTerminal(deadState);
    expect(t?.reason).toBe('hp_zero');
    expect(t?.winner).toBe('player');
  });

  it('士气溃逃（morale_routed）→ 进 Terminal', () => {
    const bundle = mkBundle();
    const s: CombatState = {
      ...createCombatState(bundle),
      terminal: { reason: 'morale_routed' },
    };
    const t = checkTerminal(s);
    expect(t?.reason).toBe('morale_routed');
  });

  it('逃跑成功（flee_success）→ 进 Terminal', () => {
    const bundle = mkBundle();
    const s: CombatState = {
      ...createCombatState(bundle),
      terminal: { reason: 'flee_success', winner: 'player' },
    };
    expect(checkTerminal(s)?.reason).toBe('flee_success');
  });

  it('forceTerminal → 进 Terminal', () => {
    const bundle = mkBundle();
    const s: CombatState = {
      ...createCombatState(bundle),
      terminal: { reason: 'force_terminal', winner: 'player' },
    };
    expect(checkTerminal(s)?.reason).toBe('force_terminal');
  });

  it('Terminal 相位 dispatch 只接受 RequestSettlement（其它 kind 被拒）', () => {
    const bundle = mkBundle();
    const s = applyOutcome(createCombatState(bundle), {
      changes: { ...emptyChg(), hpChanges: { 乙: -500 } },
      events: [],
      nextPhase: 'Terminal',
      terminal: { reason: 'hp_zero', winner: 'player' },
    });
    const pass = reduce(bundle, s, mkPass('p', s.revision, '甲', 'action'));
    expect(pass.rejection?.code).toBe('INVALID_PHASE');
    expect(pass.events).toHaveLength(0);
  });

  it('Terminal 相位接受 RequestSettlement 并结算', () => {
    const bundle = mkBundle();
    const s = applyOutcome(createCombatState(bundle), {
      changes: { ...emptyChg(), hpChanges: { 乙: -500 } },
      events: [],
      nextPhase: 'Terminal',
      terminal: { reason: 'hp_zero', winner: 'player' },
    });
    const t = reduce(bundle, s, mkSettle('st1', s.revision, 's1'));
    expect(t.rejection).toBeUndefined();
    expect(t.snapshot.phase).toBe('SettlementCommitted');
    expect(t.next!.settlementId).toBe('s1');
  });
});

describe('A1-7：settle 幂等（C3）', () => {
  it('同 settlementId 二次调用返回既有结果，不产生第二套 FP 记账', () => {
    const bundle = mkBundle();
    // FP 快照 1000，战前扣 800 → 净 -800（进入 settlement 时一次记账）
    const s = applyOutcome(createCombatState(bundle), {
      changes: { ...emptyChg(), fpDelta: -800, hpChanges: { 乙: -500 } },
      events: [],
      nextPhase: 'Terminal',
      terminal: { reason: 'hp_zero', winner: 'player' },
    });
    const first = settle(bundle, s, 'settle-1');
    expect(first.settlement?.fpDelta).toBe(-800);
    // 把第一次 settle 的产出应用到 state（settlementId + settlement 已落）
    const s1 = applyOutcome(s, first as never);
    // 二次调用同 id → 幂等（返回既有 result，不再按当前状态重算）
    const again = settle(bundle, s1, 'settle-1');
    expect(again.settlementId).toBe('settle-1');
    expect(again.settlement?.fpDelta).toBe(-800); // 不产生第二套（与既有一致）
  });
});

// ── 辅助 ──
function emptyChg(): any {
  return {
    hpChanges: {},
    mpChanges: {},
    spChanges: {},
    fpDelta: 0,
    statusPatches: [],
    slotConsumptions: [],
  };
}
