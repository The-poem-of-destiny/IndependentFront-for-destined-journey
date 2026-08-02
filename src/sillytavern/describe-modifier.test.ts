// src/sillytavern/describe-modifier.test.ts
import { describe, it, expect } from 'vitest';
import { describeModifier, describeModifiers } from './describe-modifier';
import type { Modifier } from './effect-types';

describe('describeModifier 固伤', () => {
  it('造成 N 点X伤害', () => {
    const m: Modifier = { category: '固伤', source: '', amount: 5, damageType: '物理' };
    expect(describeModifier(m)).toBe('造成 5 点物理伤害');
  });
  it('无 damageType 时省略类型', () => {
    const m: Modifier = { category: '固伤', source: '', amount: 5 };
    expect(describeModifier(m)).toBe('造成 5 点伤害');
  });
});

describe('describeModifier 百分比', () => {
  it('正系数 = 增伤', () => {
    const m: Modifier = { category: '百分比', source: '', coefficient: 0.2, target: 'damage' };
    expect(describeModifier(m)).toBe('伤害 +20%');
  });
  it('负系数 = 减益', () => {
    const m: Modifier = { category: '百分比', source: '', coefficient: -0.15, target: 'damage' };
    expect(describeModifier(m)).toBe('伤害 -15%');
  });
  it('target=heal → 治疗', () => {
    const m: Modifier = { category: '百分比', source: '', coefficient: 0.1, target: 'heal' };
    expect(describeModifier(m)).toBe('治疗 +10%');
  });
});

describe('describeModifier 资源', () => {
  it('正 = 回复，负 = 消耗', () => {
    expect(describeModifier({ category: '资源', source: '', resource: 'hp', amount: 10 })).toBe(
      '回复 10 点HP',
    );
    expect(describeModifier({ category: '资源', source: '', resource: 'mp', amount: -5 })).toBe(
      '消耗 5 点MP',
    );
  });
});

describe('describeModifier 检定', () => {
  it('命中检定 +5', () => {
    expect(
      describeModifier({ category: '检定', source: '', checkType: '命中', bonus: 5 }),
    ).toBe('命中检定 +5');
  });
  it('属性检定带 attribute', () => {
    // attribute 实为 AttributeName（str/dex/con/int/spi），brief 用中文标签 `力量` 断言展示层，
    // 直传会与真实联合类型冲突，故按真实类型收窄断言字符串（见 task-1-report concerns）
    const m: Modifier = {
      category: '检定',
      source: '',
      checkType: '属性',
      attribute: 'str',
      bonus: 3,
    };
    expect(describeModifier(m)).toBe('str检定 +3');
  });
});

describe('describeModifier 附加效果', () => {
  it('附加状态', () => {
    expect(
      describeModifier({ category: '附加效果', source: '', sourceKey: '', buffName: '流血', stacks: 2 }),
    ).toBe('附加 流血 2层');
  });
});

describe('describeModifier 特殊机制', () => {
  it('DR / 穿透', () => {
    expect(describeModifier({ category: '特殊机制', source: '', mechanism: 'DR', value: 20 })).toBe(
      '减伤 20%',
    );
    expect(
      describeModifier({ category: '特殊机制', source: '', mechanism: '穿透', value: 15 }),
    ).toBe('穿透 15%');
  });
});

describe('describeModifier 触发条件 + 来源', () => {
  it('condition 前缀', () => {
    const m: Modifier = {
      category: '检定',
      source: '',
      checkType: '命中',
      bonus: 5,
      condition: '{{target.hpPercent}} < 0.5',
    };
    expect(describeModifier(m)).toContain('目标HP<50%');
    expect(describeModifier(m)).toContain('命中检定 +5');
  });
  it('source 尾注', () => {
    const m: Modifier = { category: '固伤', source: '灼热之刃', amount: 3, damageType: '能量' };
    expect(describeModifier(m)).toBe('造成 3 点能量伤害（来源：灼热之刃）');
  });
});

describe('describeModifiers 批量', () => {
  it('空数组 → 空数组', () => {
    expect(describeModifiers([])).toEqual([]);
  });
  it('过滤空行', () => {
    expect(describeModifiers([{ category: '固伤', source: '', amount: 0 }])).toEqual([]);
  });
});
