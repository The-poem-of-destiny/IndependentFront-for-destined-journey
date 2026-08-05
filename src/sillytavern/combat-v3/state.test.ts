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
import { mkBundle, mkParticipant } from './test-utils';

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

  it('🆕 参与者 modifiers 编译进 activeEffects：装备词条效果在战斗中生效（v3 链路修复）', () => {
    // 甲带「命中+5」检定 modifier + 附加「流血」buff modifier
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲', {
          modifiers: [
            {
              category: '检定',
              source: '测试剑',
              checkType: '命中',
              bonus: 5,
              divinity: 0,
            },
          ],
        }),
        mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      ],
    });
    const state = createCombatState(bundle);

    // activeEffects 不再恒 EMPTY——命中 modifier 编译成 check.hit 窗口的 push-handler
    const hitMods = state.activeEffects.byWindow['check.hit'] ?? [];
    expect(hitMods.length).toBeGreaterThan(0);
    const ownerSet = new Set(hitMods.map((a) => a.owner));
    expect(ownerSet.has('甲')).toBe(true);
  });

  it('🆕 无 modifiers 的参与者 activeEffects 仍为 EMPTY（不误编译）', () => {
    const state = createCombatState(mkBundle());
    const total = Object.values(state.activeEffects.byWindow).reduce(
      (n, list) => n + list.length,
      0,
    );
    expect(total).toBe(0);
  });

  it('🆕 参与者 automata 编译进 activeEffects：AI 产自由效果 DSL 在战斗中生效（S3 链路）', () => {
    // 甲带一条 damage.after 吸血 automaton（trigger: ctx.damage.final > 0）
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲', {
          automata: [
            {
              id: '嗜血之刃.噬血',
              name: '噬血',
              source: '嗜血之刃',
              owner: '甲',
              subscribe: 'damage.after',
              trigger: 'ctx.damage.final > 0',
              priority: 0,
              divinity: 0,
              intents: [{ kind: 'Heal', targetId: '甲', amount: 'ctx.damage.final * 0.1' }],
            },
          ],
        }),
        mkParticipant('乙', { side: 'enemy', characterId: '乙', name: '乙' }),
      ],
    });
    const state = createCombatState(bundle);

    // damage.after 窗口挂上甲的吸血 automaton
    const afterMods = state.activeEffects.byWindow['damage.after'] ?? [];
    expect(afterMods.length).toBeGreaterThan(0);
    const ownerSet = new Set(afterMods.map((a) => a.owner));
    expect(ownerSet.has('甲')).toBe(true);
  });

  it('🆕 skillPower 链路修复 (2026-08-04): 透传 participant.activeSkills → unit.activeSkills', () => {
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲', {
          activeSkills: [
            { name: '火球术', skillPower: 450, relevantAttribute: 'int', damageType: '能量' },
          ],
        }),
      ],
    });
    const state = createCombatState(bundle);
    expect(state.units['甲'].activeSkills).toHaveLength(1);
    expect(state.units['甲'].activeSkills![0]).toMatchObject({
      name: '火球术',
      skillPower: 450,
      relevantAttribute: 'int',
      damageType: '能量',
    });
  });

  it('🆕 automata 不合规（subscribe 越界）→ 编译期剔除，不误入 activeEffects（A3-3）', () => {
    const bundle = mkBundle({
      participants: [
        mkParticipant('甲', {
          automata: [
            {
              id: '坏效果',
              name: '坏效果',
              source: '测试',
              owner: '甲',
              subscribe: 'bad.window' as never,
              trigger: 'true',
              priority: 0,
              divinity: 0,
              intents: [{ kind: 'Heal', targetId: '甲', amount: 5 }],
            },
          ],
        }),
      ],
    });
    const state = createCombatState(bundle);
    const total = Object.values(state.activeEffects.byWindow).reduce(
      (n, list) => n + list.length,
      0,
    );
    expect(total).toBe(0);
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
