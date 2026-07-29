/**
 * combat-modifier-inject.ts 测试 (M3 战斗 v2 · 任务 4.4+4.5)
 * 覆盖: foldModsToPipelineModifiers —— 6 大类 modifier 折叠 + 登神压制折算
 *
 * 折叠规则对齐 RFC §3 D3/D5 + 架构 §4.4 + §十三 决策 c
 */
import { describe, it, expect } from 'vitest';
import { foldModsToPipelineModifiers, maxDivinity } from './combat-modifier-inject';
import type {
  Modifier,
  FixedDamageModifier,
  PercentageModifier,
  CheckModifier,
  SpecialMechanismModifier,
} from './effect-types';
import type { DivinityLevel } from './types';

// ========== 工具: 造 modifier ==========

function fixed(amount: number, divinity?: DivinityLevel): FixedDamageModifier {
  const m: FixedDamageModifier = { category: '固伤', source: 'test', amount };
  if (divinity !== undefined) m.divinity = divinity;
  return m;
}

function percent(coefficient: number): PercentageModifier {
  return { category: '百分比', source: 'test', coefficient, target: 'damage' };
}

function checkHit(bonus: number): CheckModifier {
  return { category: '检定', source: 'test', checkType: '命中', bonus };
}

function checkDodge(bonus: number): CheckModifier {
  return { category: '检定', source: 'test', checkType: '闪避', bonus };
}

function mechanism(
  mechanism: '穿透' | 'DR',
  value: number,
  divinity?: DivinityLevel,
): SpecialMechanismModifier {
  const m: SpecialMechanismModifier = { category: '特殊机制', source: 'test', mechanism, value };
  if (divinity !== undefined) m.divinity = divinity;
  return m;
}

// ========== foldModsToPipelineModifiers ==========

describe('foldModsToPipelineModifiers', () => {
  describe('1. 空数组', () => {
    it('双方空数组 → 全部归零（数值字段为 0，不出现 undefined）', () => {
      const r = foldModsToPipelineModifiers([], []);
      expect(r.fixedDamageBonus).toBe(0);
      expect(r.damageMultiplier).toBe(0);
      expect(r.penetrationRateBonus).toBe(0);
      expect(r.drRateBonus).toBe(0);
      expect(r.hitBonus).toBe(0);
      expect(r.dodgeBonus).toBe(0);
    });
  });

  describe('2. 纯固伤（attacker）', () => {
    it('3 个固伤 modifier (100/200/50) → fixedDamageBonus=350', () => {
      const r = foldModsToPipelineModifiers([fixed(100), fixed(200), fixed(50)], []);
      expect(r.fixedDamageBonus).toBe(350);
    });

    it('defender 固伤不进 fixedDamageBonus（仅 attacker 声明累加）', () => {
      const r = foldModsToPipelineModifiers([fixed(100)], [fixed(999)]);
      expect(r.fixedDamageBonus).toBe(100);
    });
  });

  describe('3. 纯百分比（attacker）', () => {
    it('2 个百分比 modifier (0.2/0.3) → damageMultiplier=0.5', () => {
      const r = foldModsToPipelineModifiers([percent(0.2), percent(0.3)], []);
      expect(r.damageMultiplier).toBeCloseTo(0.5, 10);
    });

    it('defender 百分比不进 damageMultiplier', () => {
      const r = foldModsToPipelineModifiers([percent(0.2)], [percent(0.5)]);
      expect(r.damageMultiplier).toBeCloseTo(0.2, 10);
    });

    it('负值减伤 (-0.3) 也累加', () => {
      const r = foldModsToPipelineModifiers([percent(-0.3)], []);
      expect(r.damageMultiplier).toBeCloseTo(-0.3, 10);
    });
  });

  describe('4. 穿透（attacker 特殊机制·穿透）', () => {
    it('2 个穿透 (0.2/0.3) → penetrationRateBonus=0.5', () => {
      const r = foldModsToPipelineModifiers([mechanism('穿透', 0.2), mechanism('穿透', 0.3)], []);
      expect(r.penetrationRateBonus).toBeCloseTo(0.5, 10);
    });

    it('defender 穿透不进 penetrationRateBonus', () => {
      const r = foldModsToPipelineModifiers([], [mechanism('穿透', 0.4)]);
      expect(r.penetrationRateBonus).toBe(0);
    });
  });

  describe('5. DR（defender 特殊机制·DR）', () => {
    it('1 个 DR (0.15) → drRateBonus=0.15', () => {
      const r = foldModsToPipelineModifiers([], [mechanism('DR', 0.15)]);
      expect(r.drRateBonus).toBeCloseTo(0.15, 10);
    });

    it('attacker DR 不进 drRateBonus', () => {
      const r = foldModsToPipelineModifiers([mechanism('DR', 0.3)], []);
      expect(r.drRateBonus).toBe(0);
    });
  });

  describe('6. 命中 / 闪避', () => {
    it('attacker 命中 +5 → hitBonus=5', () => {
      const r = foldModsToPipelineModifiers([checkHit(5)], []);
      expect(r.hitBonus).toBe(5);
    });

    it('defender 闪避 +3 → dodgeBonus=3', () => {
      const r = foldModsToPipelineModifiers([], [checkDodge(3)]);
      expect(r.dodgeBonus).toBe(3);
    });

    it('attacker 闪避 / defender 命中互不串台', () => {
      const r = foldModsToPipelineModifiers([checkDodge(7)], [checkHit(9)]);
      expect(r.hitBonus).toBe(0);
      expect(r.dodgeBonus).toBe(0);
    });

    it('多个命中累加 (2+3+4=9)', () => {
      const r = foldModsToPipelineModifiers([checkHit(2), checkHit(3), checkHit(4)], []);
      expect(r.hitBonus).toBe(9);
    });
  });

  describe('7. 登神压制（§13 决策 c）', () => {
    it('攻方 divinity=5 vs 守方 divinity=2 → 压制率 0.6 → penetration+0.6 / dr-0.6', () => {
      // 压制率表: 差 3 级 = 0.6
      const atkMods: Modifier[] = [mechanism('穿透', 0, 5)]; // 自带穿透 0, divinity 5
      const defMods: Modifier[] = [mechanism('DR', 0, 2)]; // 自带 DR 0, divinity 2
      const r = foldModsToPipelineModifiers(atkMods, defMods);
      expect(r.penetrationRateBonus).toBeCloseTo(0.6, 10);
      expect(r.drRateBonus).toBeCloseTo(-0.6, 10);
    });

    it('压制率叠加在声明穿透之上 (声明 0.3 + 压制 0.6 = 0.9)', () => {
      const atkMods: Modifier[] = [mechanism('穿透', 0.3, 5)];
      const defMods: Modifier[] = [mechanism('DR', 0.1, 2)];
      const r = foldModsToPipelineModifiers(atkMods, defMods);
      expect(r.penetrationRateBonus).toBeCloseTo(0.9, 10);
      // 守方 DR 0.1 + 压制 -0.6 = -0.5
      expect(r.drRateBonus).toBeCloseTo(-0.5, 10);
    });

    it('差 ≥5 级 → 完全压制 (压制率 1.0)', () => {
      const atkMods: Modifier[] = [{ category: '固伤', source: 't', amount: 0, divinity: 7 }];
      const defMods: Modifier[] = [{ category: '固伤', source: 't', amount: 0, divinity: 2 }];
      const r = foldModsToPipelineModifiers(atkMods, defMods);
      expect(r.penetrationRateBonus).toBeCloseTo(1.0, 10);
      expect(r.drRateBonus).toBeCloseTo(-1.0, 10);
    });

    it('攻方不高于守方 (差 ≤0) → 压制率 0', () => {
      const atkMods: Modifier[] = [{ category: '固伤', source: 't', amount: 0, divinity: 2 }];
      const defMods: Modifier[] = [{ category: '固伤', source: 't', amount: 0, divinity: 5 }];
      const r = foldModsToPipelineModifiers(atkMods, defMods);
      expect(r.penetrationRateBonus).toBe(0);
      expect(r.drRateBonus).toBe(0);
    });

    it('同级 divinity → 压制率 0', () => {
      const atkMods: Modifier[] = [{ category: '固伤', source: 't', amount: 0, divinity: 3 }];
      const defMods: Modifier[] = [{ category: '固伤', source: 't', amount: 0, divinity: 3 }];
      const r = foldModsToPipelineModifiers(atkMods, defMods);
      expect(r.penetrationRateBonus).toBe(0);
      expect(r.drRateBonus).toBe(0);
    });
  });

  describe('8. 无登神（双方 divinity 缺省）', () => {
    it('双方均无 divinity 字段 → 压制率 0', () => {
      const atkMods: Modifier[] = [fixed(50), percent(0.2), mechanism('穿透', 0.1)];
      const defMods: Modifier[] = [mechanism('DR', 0.1), checkDodge(2)];
      const r = foldModsToPipelineModifiers(atkMods, defMods);
      // 没有压制
      expect(r.penetrationRateBonus).toBeCloseTo(0.1, 10);
      expect(r.drRateBonus).toBeCloseTo(0.1, 10);
    });
  });

  describe('9. 混合：各类 modifier 共存，各进各位', () => {
    it('attacker: 固伤 100 + 百分比 0.2 + 穿透 0.15 + 命中 +4 + divinity 4 / defender: DR 0.2 + 闪避 +2 + divinity 1', () => {
      const atkMods: Modifier[] = [
        fixed(100),
        percent(0.2),
        mechanism('穿透', 0.15, 4),
        checkHit(4),
      ];
      const defMods: Modifier[] = [mechanism('DR', 0.2, 1), checkDodge(2)];
      const r = foldModsToPipelineModifiers(atkMods, defMods);

      expect(r.fixedDamageBonus).toBe(100);
      expect(r.damageMultiplier).toBeCloseTo(0.2, 10);
      // 穿透声明 0.15 + 压制率 (4-1=3 → 0.6) = 0.75
      expect(r.penetrationRateBonus).toBeCloseTo(0.75, 10);
      // DR 声明 0.2 + 压制 -0.6 = -0.4
      expect(r.drRateBonus).toBeCloseTo(-0.4, 10);
      expect(r.hitBonus).toBe(4);
      expect(r.dodgeBonus).toBe(2);
    });

    it('无关类别（资源/附加效果）被忽略，不污染任何字段', () => {
      const atkMods: Modifier[] = [
        { category: '资源', source: 't', resource: 'hp', amount: 50 },
        { category: '附加效果', source: 't', buffName: '中毒', sourceKey: 'poison' },
      ];
      const r = foldModsToPipelineModifiers(atkMods, []);
      expect(r.fixedDamageBonus).toBe(0);
      expect(r.damageMultiplier).toBe(0);
      expect(r.penetrationRateBonus).toBe(0);
      expect(r.drRateBonus).toBe(0);
      expect(r.hitBonus).toBe(0);
      expect(r.dodgeBonus).toBe(0);
    });
  });
});

// ========== maxDivinity helper ==========

describe('maxDivinity', () => {
  it('空数组 → 0', () => {
    expect(maxDivinity([])).toBe(0);
  });

  it('无 divinity 字段 → 0', () => {
    expect(maxDivinity([fixed(100), percent(0.2)])).toBe(0);
  });

  it('取最高 divinity', () => {
    const mods: Modifier[] = [
      { category: '固伤', source: 't', amount: 0, divinity: 2 },
      { category: '固伤', source: 't', amount: 0, divinity: 5 },
      { category: '固伤', source: 't', amount: 0, divinity: 3 },
    ];
    expect(maxDivinity(mods)).toBe(5);
  });

  it('缺省 divinity 与显式 0 混合 → 取显式最高', () => {
    const mods: Modifier[] = [
      { category: '固伤', source: 't', amount: 0 }, // 缺省
      { category: '固伤', source: 't', amount: 0, divinity: 0 }, // 显式 0
      { category: '固伤', source: 't', amount: 0, divinity: 4 },
    ];
    expect(maxDivinity(mods)).toBe(4);
  });
});
