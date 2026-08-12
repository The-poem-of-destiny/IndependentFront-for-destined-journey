/**
 * combat-v3/phases/phases.test.ts — 各 phase handler 定向单测（M1）
 *
 * 验收对应（plan §3.7 / §3.1）：
 *   A1-1  单位必须消费两槽才推进；Pass 也消费槽位；未消费完返回 PlayerCommand
 *   A1-5  round.open 结算增益、round.close 结算减益/DoT；buff remainingTime 递减并到期移除
 *   A1-8  意图对抗消费 intentCheck 通道两颗独立骰（C5）；士气 d20 从 statusContest 取（M-4）
 *   A1-9  非致死攻击 HP 锁 1 + 施加[昏迷]（C6）
 *   A1-10 最终伤害 ≥ 0；负 modifier 不产生治疗（C7）
 *   M-3   行动槽强制：只给 canAct && hp>0 发槽
 */

import { describe, expect, it } from 'vitest';
import { reduce } from '../reducer';
import { createCombatState, applyOutcome } from '../state';
import { handleRoundOpen, handleRoundClose } from './round';
import { runMoraleCheck, openUnitTurn } from './unit-turn';
import { handleFlee } from './action';
import { checkTerminal } from './terminal';
import type { CombatState, CombatCommand } from '../types';
import { mkBundle, mkAttack, mkPass, mkFlee, mkParticipant } from '../test-utils';

/** 便捷 helper：从 bundle 建初始 state */

describe('A1-1：行动槽强制（M-3）', () => {
  it('单位必须消费两槽（攻击+动作）才离开自己的回合；Pass 也消费槽位', () => {
    const bundle = mkBundle();
    // 乙高 HP，避免一次攻击致死导致提前终局
    let s: CombatState = createCombatState(bundle);
    s = { ...s, units: { ...s.units, 乙: { ...s.units['乙'], hp: 50000, maxHp: 50000 } } };
    let t = reduce(bundle, s, mkAttack('a1', 0, '甲', '乙'));
    s = t.next!;
    // 甲攻击完 → 还有动作槽 → 必须消费动作才能到下一位（返回 PlayerCommand 而非推进）
    expect(t.requiredInput?.kind).toBe('PlayerCommand');
    expect(s.units['甲'].attacksRemaining).toBe(0);
    expect(s.units['甲'].actionsRemaining).toBe(1);
    // Pass 动作槽（即使不动作也消费）
    t = reduce(bundle, s, mkPass('a2', s.revision, '甲', 'action'));
    expect(t.requiredInput?.kind).toBe('PlayerCommand'); // 轮到乙
    expect(t.next!.units['甲'].actionsRemaining).toBe(0);
  });

  it('openUnitTurn：给 canAct && hp>0 的单位发满槽；残血/失能单位发 0（M-3）', () => {
    const bundle = mkBundle();
    const s = createCombatState(bundle);
    // 甲 hp0 → 不发槽（0/0）
    const deadState: CombatState = {
      ...s,
      units: {
        ...s.units,
        甲: { ...s.units['甲'], hp: 0 },
      },
    };
    const out = openUnitTurn(bundle, deadState);
    const patch = out.changes.turnOpenSlots?.find((p) => p.actorId === '甲');
    expect(patch?.attacks).toBe(0);
    expect(patch?.actions).toBe(0);
    // 乙存活 → 若其是当前单位则发满
    const aliveOut = openUnitTurn(bundle, s);
    // 当前单位是甲（index 0 存活）
    expect(aliveOut.changes.turnOpenSlots?.[0].attacks).toBe(1);
    expect(aliveOut.changes.turnOpenSlots?.[0].actions).toBe(1);
  });
});

describe('A1-5：buff 生命周期（M-1）', () => {
  it('round.open 结算增益：remainingTime 递减', () => {
    const bundle = mkBundle();
    const s = createCombatState(bundle);
    // 给甲加一个 2 回合增益 buff
    const withBuff: CombatState = {
      ...s,
      units: {
        ...s.units,
        甲: {
          ...s.units['甲'],
          statusEffects: [
            {
              name: '猛攻',
              description: '',
              category: '增益',
              stacks: 1,
              remainingTime: 2,
              timeUnit: '回合',
              source: '[增益]-[自己]',
              effects: {},
            },
          ],
        },
      },
    };
    const out = handleRoundOpen(bundle, withBuff);
    // apply patch 里应有 remainingTime=1 的写回
    const applied = out.changes.statusPatches.find(
      (p) => p.op === 'apply' && p.status.name === '猛攻',
    );
    expect(applied?.op).toBe('apply');
    expect(applied && 'status' in applied && applied.status.remainingTime).toBe(1);
  });

  it('round.close 结算减益/DoT + 到期移除', () => {
    const bundle = mkBundle();
    let s = createCombatState(bundle);
    // 给甲加一个 1 回合减益（含 DoT damagePerRound=10）
    s = {
      ...s,
      units: {
        ...s.units,
        甲: {
          ...s.units['甲'],
          statusEffects: [
            {
              name: '灼烧',
              description: '',
              category: '减益',
              stacks: 1,
              remainingTime: 1,
              timeUnit: '回合',
              source: '[减益]-[敌]',
              effects: { damagePerRound: 10 },
            },
          ],
        },
      },
    };
    const out = handleRoundClose(bundle, s);
    // DoT 扣 10 HP
    expect(out.changes.hpChanges['甲']).toBe(-10);
    // remainingTime 1 → 到期 → 移除
    expect(out.changes.statusPatches.some((p) => p.op === 'remove' && p.statusId === '灼烧')).toBe(
      true,
    );
  });
});

describe('A1-8：双骰意图 + 士气骰源', () => {
  it('意图对抗消费 intentCheck 通道两颗独立骰（C5 → cursor 前进 2）', () => {
    const bundle = mkBundle();
    const s = createCombatState(bundle);
    const beforeIntent = s.dice.current.cursors.intentCheck;
    const t = reduce(bundle, s, mkAttack('i1', 0, '甲', '乙'));
    const afterIntent = t.next!.dice.current.cursors.intentCheck;
    expect(afterIntent - beforeIntent).toBe(2); // 攻守各一颗
  });

  it('士气 d20 从 statusContest 通道取（M-4 → cursor 前进 1）', () => {
    const bundle = mkBundle();
    // 让当前单位是敌方乙（index 0），才会走士气检定掷骰
    const s: CombatState = {
      ...createCombatState(bundle),
      initiativeOrder: ['乙', '甲'],
      currentTurnIndex: 0,
    };
    const before = s.dice.current.cursors.statusContest;
    const out = runMoraleCheck(bundle, s);
    expect(out.dice).toBeDefined();
    expect(out.dice!.current.cursors.statusContest).toBe(before + 1);
  });
});

describe('A1-9 / A1-10：非致死 + 负 modifier', () => {
  it('非致死攻击 HP 锁 1 + 施加[昏迷]（C6）', () => {
    const bundle = mkBundle();
    // 守方低血，非致死攻击本应致死
    let s = createCombatState(bundle);
    s = {
      ...s,
      units: { ...s.units, 乙: { ...s.units['乙'], hp: 50, maxHp: 500 } },
    };
    const t = reduce(bundle, s, mkAttack('nl1', 0, '甲', '乙', { nonLethal: true, costs: {} }));
    expect(t.rejection).toBeUndefined();
    expect(t.next!.units['乙'].hp).toBe(1); // HP 锁 1
    // 施加昏迷
    expect(t.next!.units['乙'].statusEffects.some((st) => st.name === '昏迷')).toBe(true);
  });

  it('负 modifier 不产生治疗：失手(评级0) 的最终伤害 0，守方 HP 不增（C7）', () => {
    const bundle = mkBundle();
    // 守方闪避拉满 → 必定失手
    let s = createCombatState(bundle);
    s = {
      ...s,
      units: { ...s.units, 乙: { ...s.units['乙'], dodgeBonus: 9999 } },
    };
    const beforeHp = s.units['乙'].hp;
    const t = reduce(bundle, s, mkAttack('m1', 0, '甲', '乙'));
    const afterHp = t.next!.units['乙'].hp;
    // 不致死、不治疗：HP 要么不变（=0 伤害）要么减少，绝不增加
    expect(afterHp).toBeLessThanOrEqual(beforeHp);
    // 失手评级 → 最终伤害为 0（攻击被完全闪避）
    const damageEvt = t.events.find((e: any) => e.kind === 'DamageApplied') as any;
    if (damageEvt) {
      expect(damageEvt.final).toBe(0);
    }
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

// ══════════════════════════════════════════════════════════════════════════
// Bug C（2026-08-12）：逃跑成功不再整场 Terminal —— 只移除逃跑单位，
// 终局归 checkTerminal（单敌人逃光 = 玩家获胜；多敌人逃一个 = 战斗继续）
// ══════════════════════════════════════════════════════════════════════════
describe('Bug C：逃跑成功移除单位（多敌人场景）', () => {
  it('多敌人逃一个 → 该单位从 units/initiativeOrder 摘除，战斗继续（checkTerminal 不终局）', () => {
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲'),
        mkParticipant('乙', { side: 'enemy' }),
        mkParticipant('丙', { side: 'enemy' }),
      ],
    });
    let s = createCombatState(bundle);
    // 手工推进到乙的 SlotConsume（乙当前，槽已发好）
    s = applyOutcome(s, {
      changes: { ...emptyChg(), turnOpenSlots: [{ actorId: '乙', attacks: 1, actions: 1 }] },
      events: [],
      nextPhase: 'SlotConsume',
      currentTurnIndex: 1,
    });
    const out = handleFlee(
      bundle,
      s,
      mkFlee('f', s.revision, '乙') as Extract<CombatCommand, { kind: 'Flee' }>,
    );
    expect(out.rejection).toBeUndefined();
    // 成功 → removeUnitIds + UnitDespawned('fled') + 走 UnitTurnClose（不 Terminal）
    expect(out.removeUnitIds).toEqual(['乙']);
    const despawn = out.events.find((e) => e.kind === 'UnitDespawned') as any;
    expect(despawn?.unitId).toBe('乙');
    expect(despawn?.reason).toBe('fled');
    expect(out.nextPhase).toBe('UnitTurnClose');
    // 应用产出：乙从 units 与 initiativeOrder 摘除（index 不越界不归零），战斗继续
    const next = applyOutcome(s, out);
    expect(next.units['乙']).toBeUndefined();
    expect(next.initiativeOrder).toEqual(['甲', '丙']);
    expect(next.currentTurnIndex).toBe(1); // 指向丙
    expect(checkTerminal(next)).toBeNull(); // 甲、丙都存活 → 不终局
  });
});
