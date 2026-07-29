/**
 * effect-types 测试 (M2 战斗 v2 · 组 A)
 *
 * modifier 6 大类 + divinity 仲裁（§13 决策 c 差值压制表）+ 聚合工具的纯函数测试。
 */
import { describe, it, expect } from 'vitest';
import {
  resolveDivinityConflict,
  classifyModifier,
  sumFixedDamage,
  sumPercentages,
  collectChecks,
  collectResources,
  collectAdditionalEffects,
  collectSpecialMechanisms,
} from './effect-types';
import type { Modifier } from './effect-types';

// ═══════════════════════════════════════════════════════════
describe('resolveDivinityConflict（§13 决策 c 差值压制表）', () => {
  it('攻方不高于守方 → 0%（不压制）', () => {
    expect(resolveDivinityConflict(0, 0)).toBe(0);
    expect(resolveDivinityConflict(3, 5)).toBe(0); // 攻 < 守
    expect(resolveDivinityConflict(5, 5)).toBe(0); // 相等
  });

  it('差 1 级 → 20%', () => {
    expect(resolveDivinityConflict(1, 0)).toBeCloseTo(0.2);
    expect(resolveDivinityConflict(5, 4)).toBeCloseTo(0.2);
  });

  it('差 2/3/4 级 → 40/60/80%', () => {
    expect(resolveDivinityConflict(2, 0)).toBeCloseTo(0.4);
    expect(resolveDivinityConflict(3, 0)).toBeCloseTo(0.6); // 3*0.2 浮点误差，用 toBeCloseTo
    expect(resolveDivinityConflict(4, 0)).toBeCloseTo(0.8);
  });

  it('差 ≥5 级 → 100%（完全无视）', () => {
    expect(resolveDivinityConflict(5, 0)).toBe(1);
    expect(resolveDivinityConflict(8, 0)).toBe(1);
    expect(resolveDivinityConflict(8, 3)).toBe(1); // 差 5
  });
});

// ═══════════════════════════════════════════════════════════
describe('classifyModifier', () => {
  const samples: Modifier[] = [
    { category: '固伤', source: 'a', amount: 100 },
    { category: '百分比', source: 'b', coefficient: 0.2, target: 'damage' },
    { category: '资源', source: 'c', resource: 'hp', amount: 50 },
    { category: '检定', source: 'd', checkType: '命中', bonus: 5 },
    { category: '附加效果', source: 'e', buffName: '流血', sourceKey: '剑' },
    { category: '特殊机制', source: 'f', mechanism: 'DR', value: 0.1 },
  ];

  for (const m of samples) {
    it(`${m.category} 返回正确类别`, () => {
      expect(classifyModifier(m)).toBe(m.category);
    });
  }
});

// ═══════════════════════════════════════════════════════════
describe('聚合工具', () => {
  const mods: Modifier[] = [
    { category: '固伤', source: 'a', amount: 100, damageType: '物理' },
    { category: '固伤', source: 'b', amount: 50 },
    { category: '百分比', source: 'c', coefficient: 0.2, target: 'damage' },
    { category: '百分比', source: 'd', coefficient: 0.3, target: 'damage' },
    { category: '检定', source: 'e', checkType: '命中', bonus: 5 },
    { category: '检定', source: 'f', checkType: '闪避', bonus: 3 },
    { category: '资源', source: 'g', resource: 'hp', amount: -30 },
    { category: '附加效果', source: 'h', buffName: '流血', sourceKey: '剑' },
    { category: '特殊机制', source: 'i', mechanism: 'DR', value: 0.1 },
    { category: '特殊机制', source: 'j', mechanism: '穿透', value: 0.2 },
  ];

  it('sumFixedDamage 累加固伤 amount（首带 damageType 的作为类型）', () => {
    expect(sumFixedDamage(mods)).toEqual({ amount: 150, type: '物理' });
  });

  it('sumPercentages 累加百分比系数', () => {
    expect(sumPercentages(mods)).toBe(0.5); // 0.2 + 0.3
  });

  it('collectChecks 提取检定（可按 checkType 过滤）', () => {
    expect(collectChecks(mods)).toHaveLength(2);
    expect(collectChecks(mods, '命中')).toHaveLength(1);
    expect(collectChecks(mods, '先攻')).toHaveLength(0);
  });

  it('collectResources 提取资源 modifier', () => {
    expect(collectResources(mods)).toHaveLength(1);
    expect(collectResources(mods)[0].amount).toBe(-30);
  });

  it('collectAdditionalEffects 提取附加效果', () => {
    expect(collectAdditionalEffects(mods)).toHaveLength(1);
    expect(collectAdditionalEffects(mods)[0].buffName).toBe('流血');
  });

  it('collectSpecialMechanisms 提取特殊机制（可按 mechanism 过滤）', () => {
    expect(collectSpecialMechanisms(mods)).toHaveLength(2);
    expect(collectSpecialMechanisms(mods, 'DR')).toHaveLength(1);
    expect(collectSpecialMechanisms(mods, '穿透')).toHaveLength(1);
    expect(collectSpecialMechanisms(mods, '暴击倍率')).toHaveLength(0);
  });

  it('空数组聚合工具零异常', () => {
    expect(sumFixedDamage([])).toEqual({ amount: 0, type: undefined });
    expect(sumPercentages([])).toBe(0);
    expect(collectChecks([])).toEqual([]);
  });
});
