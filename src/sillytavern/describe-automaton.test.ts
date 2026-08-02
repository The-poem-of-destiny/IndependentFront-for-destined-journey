// src/sillytavern/describe-automaton.test.ts
import { describe, it, expect } from 'vitest';
import { describeAutomaton, describeAutomata } from './describe-automaton';
import type { EffectAutomatonDecl } from './combat-v3/types';

function makeA(over: Partial<EffectAutomatonDecl>): EffectAutomatonDecl {
  return {
    id: 'a1',
    subscribe: 'damage.after',
    trigger: 'true',
    intents: [{ kind: 'DealDamage', targetId: 'target', amount: 3, damageType: 'physical' }],
    ...over,
  };
}

describe('describeAutomaton 窗口中文', () => {
  it('damage.after → 受击时', () => {
    const a = makeA({});
    expect(describeAutomaton(a)[0]).toContain('受击时');
  });
  it('check.hit → 命中检定时', () => {
    const a = makeA({ subscribe: 'check.hit' });
    expect(describeAutomaton(a)[0]).toContain('命中检定时');
  });
  it('turn.open → 回合开始时', () => {
    const a = makeA({ subscribe: 'turn.open' });
    expect(describeAutomaton(a)[0]).toContain('回合开始时');
  });
});

describe('describeAutomaton trigger 条件', () => {
  it('target.hpPercent < 0.5 → 目标HP<50%', () => {
    const a = makeA({ trigger: 'target.hpPercent < 0.5' });
    expect(describeAutomaton(a)[0]).toContain('目标HP<50%');
  });
  it('trigger 恒真 → 无条件', () => {
    const a = makeA({ trigger: 'true' });
    expect(describeAutomaton(a)[0]).not.toContain('[');
  });
});

describe('describeAutomaton intents 13 类', () => {
  it('DealDamage', () => {
    expect(describeAutomaton(makeA({}))[0]).toBe('受击时：造成 3 点物理伤害');
  });
  it('AddModifier hitBonus', () => {
    const a = makeA({
      intents: [{ kind: 'AddModifier', slot: 'hitBonus', value: 5, scope: 'whole_action', targetId: 'self', divinity: 0 }],
    });
    expect(describeAutomaton(a)[0]).toContain('命中 +5');
  });
  it('Heal', () => {
    const a = makeA({ intents: [{ kind: 'Heal', targetId: 'self', amount: 20 }] });
    expect(describeAutomaton(a)[0]).toContain('回复 20 点HP');
  });
  it('ApplyStatus', () => {
    const a = makeA({ intents: [{ kind: 'ApplyStatus', targetId: 'target', statusId: 'bleed', duration: 3, layers: 2 }] });
    expect(describeAutomaton(a)[0]).toContain('附加 流血 2层');
  });
  it('ApplyStatus 无层数', () => {
    const a = makeA({ intents: [{ kind: 'ApplyStatus', targetId: 'target', statusId: 'poison', duration: 2 }] });
    expect(describeAutomaton(a)[0]).toContain('附加 中毒');
  });
  it('RemoveStatus', () => {
    const a = makeA({ intents: [{ kind: 'RemoveStatus', targetId: 'target', statusId: 'bleed' }] });
    expect(describeAutomaton(a)[0]).toContain('移除流血');
  });
  it('SpendResource', () => {
    const a = makeA({ intents: [{ kind: 'SpendResource', targetId: 'self', resource: 'mp', amount: 5 }] });
    expect(describeAutomaton(a)[0]).toContain('消耗 5 点MP');
  });
  it('PreventDeath', () => {
    const a = makeA({ intents: [{ kind: 'PreventDeath', targetId: 'target', hp: 1 }] });
    expect(describeAutomaton(a)[0]).toContain('免死一次');
  });
  it('ConsumeCharge', () => {
    const a = makeA({ intents: [{ kind: 'ConsumeCharge' }] });
    expect(describeAutomaton(a)[0]).toContain('消耗 1 次充能');
  });
  it('ConsumeCharge 指定次数', () => {
    const a = makeA({ intents: [{ kind: 'ConsumeCharge', amount: 3 }] });
    expect(describeAutomaton(a)[0]).toContain('消耗 3 次充能');
  });
  it('EmitNarrativeCue', () => {
    const a = makeA({ intents: [{ kind: 'EmitNarrativeCue', text: '寒光乍现' }] });
    expect(describeAutomaton(a)[0]).toContain('提示：寒光乍现');
  });
  it('OverrideIntent', () => {
    const a = makeA({ intents: [{ kind: 'OverrideIntent', ruleKey: 'freezeSlot', payload: {}, divinity: 0 }] });
    expect(describeAutomaton(a)[0]).toContain('覆盖freezeSlot行动');
  });
  it('ScheduleIntent 延后', () => {
    const a = makeA({
      intents: [{ kind: 'ScheduleIntent', delay: 1, intent: { kind: 'DealDamage', targetId: 'target', amount: 3, damageType: 'physical' } }],
    });
    expect(describeAutomaton(a)[0]).toContain('延后：');
  });
  it('SpawnOrDespawnIntent 召唤', () => {
    const a = makeA({ intents: [{ kind: 'SpawnOrDespawnIntent', op: 'spawn', unitId: 'unit-1' }] });
    expect(describeAutomaton(a)[0]).toContain('召唤 unit-1');
  });
  it('SpawnOrDespawnIntent 移除', () => {
    const a = makeA({ intents: [{ kind: 'SpawnOrDespawnIntent', op: 'despawn', unitId: 'unit-1' }] });
    expect(describeAutomaton(a)[0]).toContain('移除 unit-1');
  });
  it('RequestChoiceIntent', () => {
    const a = makeA({
      intents: [{ kind: 'RequestChoiceIntent', choiceId: 'c1', prompt: '要躲避还是硬抗？', options: ['躲避', '硬抗'] }],
    });
    expect(describeAutomaton(a)[0]).toContain('要求选择：要躲避还是硬抗？');
  });
});

describe('describeAutomata 批量', () => {
  it('空 → 空数组', () => {
    expect(describeAutomata(undefined)).toEqual([]);
  });
  it('多 automaton 拼接', () => {
    const list = [makeA({}), makeA({ subscribe: 'turn.open' })];
    const lines = describeAutomata(list);
    expect(lines.length).toBe(2);
  });
});
