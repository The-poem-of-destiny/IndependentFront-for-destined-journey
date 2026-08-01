/**
 * combat-v3/state.test.ts — CombatState 构造 / 不可变 / 投影（M1）
 *
 * 验收对应（plan §3.7 / §3.1）：
 *   A1-4  applyPending 产生新对象（不可变）；revision 单调递增
 *   A1-2  toView 不暴露可变引用（深脱敏）
 *   M-7(C7)  HP clamp 到 [0, maxHp] 在 applyPending 兜底
 */

import { describe, expect, it } from 'vitest';
import { applyPending, createCombatState, toView, applyOutcome } from './state';
import { emptyChanges } from './phases/outcome';
import type { CombatState } from './types';
import { mkBundle } from './test-utils';

describe('createCombatState / toView', () => {
  it('由 bundle 建状态：units 键 = 角色 id，初始槽位 0，phase=CombatOpen', () => {
    const state = createCombatState(mkBundle());
    expect(state.phase).toBe('CombatOpen');
    expect(state.units['甲']).toBeDefined();
    expect(state.units['乙']).toBeDefined();
    expect(state.units['甲'].attacksRemaining).toBe(0);
    expect(state.units['乙'].side).toBe('enemy');
    expect(state.resourceSnapshots.FP).toBe(1000);
  });

  it('toView 不暴露可变引用：statusEffects 深度复制，改动不影响原状态', () => {
    const state = createCombatState(mkBundle());
    const view = toView(state);
    // 尝试 mutate 视图单位
    view.units['甲'].hp = 999;
    expect(state.units['甲'].hp).toBe(500);
    // journal / dice / activeEffects 不暴露
    expect((view as any).journal).toBeUndefined();
    expect((view as any).dice).toBeUndefined();
    expect((view as any).activeEffects).toBeUndefined();
  });

  it('applyOutcome 不可变：入参 state 不被修改（引用不变），返回新对象', () => {
    const state = createCombatState(mkBundle());
    // structuredClone 保留 undefined 字段（如 ability），与 toStrictEqual 对齐
    const frozen = structuredClone(state as any);
    const out = applyOutcome(state, {
      changes: {
        ...emptyChanges(),
        hpChanges: { 乙: -50 },
      },
      events: [],
      nextPhase: 'CombatOpen',
    });
    expect(state).toStrictEqual(frozen); // 原对象不可变
    expect(out).not.toBe(state);
    expect(out.units['乙'].hp).toBe(450);
    expect(out.revision).toBe(state.revision + 1);
  });
});

describe('applyPending（唯一写入 + HP clamp）', () => {
  it('revision 单调递增（每次 +1）', () => {
    const state = createCombatState(mkBundle());
    const s1 = applyPending(state, emptyChanges());
    const s2 = applyPending(s1, emptyChanges());
    expect(s1.revision).toBe(1);
    expect(s2.revision).toBe(2);
  });

  it('HP clamp 到 [0, maxHp]：过量伤害不跌破 0，过量治疗不超上限（M-7/C7）', () => {
    const state = createCombatState(mkBundle());
    // 乙 hp 500 → 减去 10000 → clamp 0
    const over = applyPending(state, { ...emptyChanges(), hpChanges: { 乙: -10000 } });
    expect(over.units['乙'].hp).toBe(0);
    // 超量治疗 → clamp maxHp
    const heal = applyPending(state, { ...emptyChanges(), hpChanges: { 乙: 5000 } });
    expect(heal.units['乙'].hp).toBe(500);
  });

  it('MP/SP 也 clamp 到 [0, max]；FP 不 clamp（跨边界，settlement 结算）', () => {
    const state = createCombatState(mkBundle());
    const s = applyPending(state, {
      ...emptyChanges(),
      mpChanges: { 甲: -1000 },
      spChanges: { 甲: 1000 },
      fpDelta: -800, // 注：FP 只记录不 clamp
    });
    expect(s.units['甲'].mp).toBe(0);
    expect(s.units['甲'].sp).toBe(50); // maxSp=50
    expect(s.resourceSnapshots.FP).toBe(200);
  });

  it('行动槽消费（slotConsumptions）clamp ≥ 0 + 回合开发槽（turnOpenSlots）', () => {
    const state = createCombatState(mkBundle());
    // 开槽：甲 full 1/1；乙 no_action 0/0
    const opened = applyPending(state, {
      ...emptyChanges(),
      turnOpenSlots: [
        { actorId: '甲', attacks: 1, actions: 1 },
        { actorId: '乙', attacks: 0, actions: 0 },
      ],
    });
    expect(opened.units['甲'].attacksRemaining).toBe(1);
    expect(opened.units['乙'].actionsRemaining).toBe(0);
    // 消费攻击（消费一次，还有）
    const consumed = applyPending(opened, {
      ...emptyChanges(),
      slotConsumptions: [{ actorId: '甲', slot: 'attack' }],
    });
    expect(consumed.units['甲'].attacksRemaining).toBe(0);
  });

  it('buff apply/remove + 去重（同名合并层数）', () => {
    const state = createCombatState(mkBundle());
    const s1 = applyPending(state, {
      ...emptyChanges(),
      statusPatches: [
        {
          op: 'apply',
          unitId: '甲',
          status: {
            name: '力量强化',
            description: '',
            category: '增益',
            stacks: 1,
            remainingTime: 2,
            timeUnit: '回合',
            source: '[增益]-[自己]',
            effects: {},
          },
        },
      ],
    });
    expect(s1.units['甲'].statusEffects).toHaveLength(1);
    const s2 = applyPending(s1, {
      ...emptyChanges(),
      statusPatches: [
        {
          op: 'apply',
          unitId: '甲',
          status: {
            name: '力量强化',
            description: '',
            category: '增益',
            stacks: 1,
            remainingTime: 2,
            timeUnit: '回合',
            source: '[增益]-[自己]',
            effects: {},
          },
        },
      ],
    });
    expect(s2.units['甲'].statusEffects).toHaveLength(1);
    expect(s2.units['甲'].statusEffects[0].stacks).toBe(2); // 去重合并层数
  });
});
