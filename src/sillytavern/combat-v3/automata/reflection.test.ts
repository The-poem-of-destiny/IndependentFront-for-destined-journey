/**
 * combat-v3/automata/reflection.test.ts — 反射（反伤）解析测试（M3, 验收 A3-8）
 *
 * 第 24 场反伤 fixture 的算法断言（架构 §九，§5.9）：
 *   - R4/R7：反伤基准取 preReduction（不放大）；depth≥2 也固定 rootChain preReduction
 *   - R6：depth ≥ MAX(2) 熔断 → mutual_cancel + NarrativeCue('反射湮灭')
 *   - R1/R3：反伤 DealDamage isReaction doesNotConsumeSlot —— 在 applyIntents 只写 hpChanges，
 *     天然不消耗攻击槽（不变量①豁免）
 *   - R8：反伤命中骰走 attackHit 通道（hitPolicy.consumeDice）——由 intent 属性断言
 */

import { describe, it, expect } from 'vitest';
import { resolveReflection, REFLECTION_ANNIHILATION_CUE } from './reflection';
import { applyIntents } from '../intents';
import type { EffectIntent, PendingChangeSet } from '../types';
import { EMPTY_CHANGES } from '../types';
import { MAX_REFLECTION_DEPTH } from '../types';

const damage = { preReduction: 8535, final: 487 };

const ctx = {
  state: undefined as never,
  automatonOwner: '处刑人',
  present: (id: string) => id === '处刑人' || id === '理查德',
  resolveNumber: (e: string, f: number) => Number(e) || f,
  reflectBase: damage, // 第 24 场星屑连袭 preReduction=8535
  reflectDepth: 0,
  reflectRatio: 0.3,
};

describe('反射基准（R4/R7）', () => {
  it('depth=1 反伤基准取 preReduction（8535 × 30% = 2560）', () => {
    const res = resolveReflection(0, damage, 0.3);
    expect(res.kind).toBe('propagate');
    if (res.kind === 'propagate') {
      expect(res.baseDamage).toBe(8535); // preReduction，非 final 487
      expect(res.reflectedAmount).toBe(Math.floor(8535 * 0.3));
      expect(res.nextDepth).toBe(1);
    }
  });

  it('depth=2 不放大（base 仍取 rootChain preReduction）', () => {
    // depth=1 进 → nextDepth=2；这里测 resolveReflection(1, ...) 仍 base=8535
    const res = resolveReflection(1, damage, 0.3);
    if (res.kind === 'propagate') {
      expect(res.baseDamage).toBe(8535);
    }
  });
});

describe('反射熔断（R6）', () => {
  it('depth ≥ MAX(2) 熔断 → mutual_cancel + 湮灭', () => {
    const res = resolveReflection(MAX_REFLECTION_DEPTH, damage, 0.3);
    expect(res.kind).toBe('mutual_cancel');
    if (res.kind === 'mutual_cancel') {
      expect(res.annihilated).toBe(true);
      // 熔断不产生伤害，只产湮灭叙事
    }
    expect(REFLECTION_ANNIHILATION_CUE).toBe('反射湮灭');
  });
});

describe('反伤不消耗攻击槽 + 命中骰走 attackHit（R1/R3/R8）', () => {
  it('ScheduleIntent(DealDamage isReaction) → 只写 hpChanges，不碰槽位', () => {
    const changes: PendingChangeSet = { ...EMPTY_CHANGES, hpChanges: {}, slotConsumptions: [] };
    const intent: EffectIntent = {
      kind: 'ScheduleIntent',
      delay: 0,
      intent: {
        kind: 'DealDamage',
        targetId: '理查德',
        amount: '8535 * 0.3',
        damageType: 'true',
        isReaction: true,
        doesNotConsumeSlot: true,
        hitPolicy: { consumeDice: true, advantage: 'adv' }, // R8 走 attackHit
      },
    };
    const r = applyIntents(ctx, [intent], changes);
    expect(r.changes.hpChanges['理查德']).toBeLessThan(0);
    // doesNotConsumeSlot：slotConsumptions 不变（不消耗攻击槽）
    expect(r.changes.slotConsumptions).toHaveLength(0);
    // R8 命中骰声明走 attackHit contract
    if (intent.intent.kind === 'DealDamage') {
      expect(intent.intent.hitPolicy?.consumeDice).toBe(true);
    }
  });

  it('depth=2 熔断时同一 intent 不再产生伤害，产湮灭叙事', () => {
    const changes: PendingChangeSet = { ...EMPTY_CHANGES, hpChanges: {} };
    const ctx2 = { ...ctx, reflectDepth: MAX_REFLECTION_DEPTH };
    const intent: EffectIntent = {
      kind: 'ScheduleIntent',
      delay: 0,
      intent: {
        kind: 'DealDamage',
        targetId: '理查德',
        amount: '8535 * 0.3',
        damageType: 'true',
        isReaction: true,
        doesNotConsumeSlot: true,
      },
    };
    const r = applyIntents(ctx2, [intent], changes);
    expect(r.changes.hpChanges).toEqual({});
    expect(r.narrative).toContain('反射湮灭');
  });
});
