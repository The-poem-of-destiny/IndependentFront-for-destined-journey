/**
 * FP 命运点数系统 测试套件
 *
 * 纯函数测试 — 无需 mock，无需 fake-indexeddb。
 */

import { describe, it, expect } from 'vitest';
import {
  calcContractCost,
  calcFPFromTask,
  calcFPFromAchievement,
  calcFPFromIntimacy,
  calcFPFromCraft,
  calcSkillFusionCost,
  $fp,
} from './fp-system';

// ========== calcContractCost ==========

describe('calcContractCost', () => {
  it('T1 neutral (affectionModifier=0) → base 200', () => {
    const result = calcContractCost(1, 0);
    expect(result).toEqual({ base: 200, modifier: 0, total: 200 });
  });

  it('T3 neutral → base 2500', () => {
    const result = calcContractCost(3, 0);
    expect(result).toEqual({ base: 2500, modifier: 0, total: 2500 });
  });

  it('T5 neutral → base 50000', () => {
    const result = calcContractCost(5, 0);
    expect(result).toEqual({ base: 50000, modifier: 0, total: 50000 });
  });

  it('T7 negative base returns free (base=0, modifier=0, total=0)', () => {
    const result = calcContractCost(7, 0);
    expect(result).toEqual({ base: 0, modifier: 0, total: 0 });
  });

  it('T7 with any affection modifier stays free', () => {
    const result = calcContractCost(7, 80);
    expect(result).toEqual({ base: 0, modifier: 0, total: 0 });
  });

  it('positive affection makes contract cheaper (T1, +50)', () => {
    // modifier = round(200 * (-50/100)) = -100 → total = max(1, 100) = 100
    const result = calcContractCost(1, 50);
    expect(result.base).toBe(200);
    expect(result.modifier).toBe(-100);
    expect(result.total).toBe(100);
  });

  it('hostile affection makes contract more expensive (T1, -50)', () => {
    // modifier = round(200 * (50/100)) = 100 → total = 200 + 100 = 300
    const result = calcContractCost(1, -50);
    expect(result.base).toBe(200);
    expect(result.modifier).toBe(100);
    expect(result.total).toBe(300);
  });

  it('max positive affection (+100) on T1 → total clamped to minimum 1', () => {
    // modifier = round(200 * (-100/100)) = -200 → total = max(1, 0) = 1
    const result = calcContractCost(1, 100);
    expect(result.base).toBe(200);
    expect(result.modifier).toBe(-200);
    expect(result.total).toBe(1);
  });

  it('partial hostile affection (T3, -10) → correct modifier rounding', () => {
    // modifier = round(2500 * (10/100)) = 250 → total = 2750
    const result = calcContractCost(3, -10);
    expect(result.base).toBe(2500);
    expect(result.modifier).toBe(250);
    expect(result.total).toBe(2750);
  });

  it('unknown tier falls back to 200 (same as T1)', () => {
    const result = calcContractCost(99, 0);
    expect(result).toEqual({ base: 200, modifier: 0, total: 200 });
  });

  it('T6 neutral → base 150000', () => {
    const result = calcContractCost(6, 0);
    expect(result).toEqual({ base: 150000, modifier: 0, total: 150000 });
  });

  it('default affectionModifier is 0', () => {
    const result = calcContractCost(2);
    expect(result).toEqual({ base: 500, modifier: 0, total: 500 });
  });
});

// ========== calcFPFromTask ==========

describe('calcFPFromTask', () => {
  it('D grade → 50 FP', () => {
    expect(calcFPFromTask('D')).toBe(50);
  });

  it('C grade → 100 FP', () => {
    expect(calcFPFromTask('C')).toBe(100);
  });

  it('B grade → 500 FP', () => {
    expect(calcFPFromTask('B')).toBe(500);
  });

  it('A grade → 1000 FP', () => {
    expect(calcFPFromTask('A')).toBe(1000);
  });

  it('S grade → 10000 FP', () => {
    expect(calcFPFromTask('S')).toBe(10000);
  });

  it('unknown grade falls back to 50 (same as D)', () => {
    expect(calcFPFromTask('SSS')).toBe(50);
    expect(calcFPFromTask('F')).toBe(50);
    expect(calcFPFromTask('')).toBe(50);
  });
});

// ========== calcFPFromAchievement ==========

describe('calcFPFromAchievement', () => {
  it('minor → 500 FP', () => {
    expect(calcFPFromAchievement('minor')).toBe(500);
  });

  it('major → 5000 FP', () => {
    expect(calcFPFromAchievement('major')).toBe(5000);
  });

  it('legendary → 50000 FP', () => {
    expect(calcFPFromAchievement('legendary')).toBe(50000);
  });
});

// ========== calcFPFromIntimacy ==========

describe('calcFPFromIntimacy', () => {
  it('daily → 100 FP', () => {
    expect(calcFPFromIntimacy('daily')).toBe(100);
  });

  it('crisis → 2000 FP', () => {
    expect(calcFPFromIntimacy('crisis')).toBe(2000);
  });

  it('bond → 2000 FP', () => {
    expect(calcFPFromIntimacy('bond')).toBe(2000);
  });

  it('first_time → 500 FP', () => {
    expect(calcFPFromIntimacy('first_time')).toBe(500);
  });

  it('sex → 50 FP', () => {
    expect(calcFPFromIntimacy('sex')).toBe(50);
  });

  it('orgasm → 100 FP', () => {
    expect(calcFPFromIntimacy('orgasm')).toBe(100);
  });

  it('special → 500 FP', () => {
    expect(calcFPFromIntimacy('special')).toBe(500);
  });

  it('unknown type falls back to 100 (same as daily)', () => {
    expect(calcFPFromIntimacy('unknown')).toBe(100);
    expect(calcFPFromIntimacy('random_event')).toBe(100);
    expect(calcFPFromIntimacy('')).toBe(100);
  });
});

// ========== calcFPFromCraft ==========

describe('calcFPFromCraft', () => {
  it('poor → 0 FP', () => {
    expect(calcFPFromCraft('普通')).toBe(0);
  });

  it('normal → 50 FP', () => {
    expect(calcFPFromCraft('优良')).toBe(50);
  });

  it('good → 100 FP', () => {
    expect(calcFPFromCraft('稀有')).toBe(100);
  });

  it('excellent → 400 FP', () => {
    expect(calcFPFromCraft('史诗')).toBe(400);
  });

  it('masterwork → 1000 FP', () => {
    expect(calcFPFromCraft('传说')).toBe(1000);
  });

  it('legendary → 3000 FP', () => {
    expect(calcFPFromCraft('神话')).toBe(3000);
  });

  it('mythic → 6000 FP', () => {
    expect(calcFPFromCraft('唯一')).toBe(6000);
  });

  it('unknown quality falls back to 0 (same as poor)', () => {
    expect(calcFPFromCraft('unknown')).toBe(0);
    expect(calcFPFromCraft('broken')).toBe(0);
    expect(calcFPFromCraft('')).toBe(0);
  });
});

// ========== calcSkillFusionCost ==========

describe('calcSkillFusionCost', () => {
  it('same tier → 0 FP', () => {
    expect(calcSkillFusionCost(3, 3)).toBe(0);
    expect(calcSkillFusionCost(5, 5)).toBe(0);
  });

  it('+1 tier → cost = 1 * 500 * currentTier', () => {
    // diff=1, currentTier=3 → 1 * 500 * 3 = 1500
    expect(calcSkillFusionCost(3, 4)).toBe(1500);
    // diff=1, currentTier=1 → 1 * 500 * 1 = 500
    expect(calcSkillFusionCost(1, 2)).toBe(500);
  });

  it('+2 tiers → cost = 2 * 500 * currentTier', () => {
    // diff=2, currentTier=3 → 2 * 500 * 3 = 3000
    expect(calcSkillFusionCost(3, 5)).toBe(3000);
    // diff=2, currentTier=2 → 2 * 500 * 2 = 2000
    expect(calcSkillFusionCost(2, 4)).toBe(2000);
  });

  it('+3 tiers → cost = 3 * 500 * currentTier', () => {
    // diff=3, currentTier=2 → 3 * 500 * 2 = 3000
    expect(calcSkillFusionCost(2, 5)).toBe(3000);
  });

  it('downgrade (target < current) → 0 FP', () => {
    expect(calcSkillFusionCost(5, 3)).toBe(0);
    expect(calcSkillFusionCost(4, 1)).toBe(0);
  });

  it('currentTier=0 and positive diff computes correctly', () => {
    // diff=1, currentTier=0 → 1 * 500 * 0 = 0
    expect(calcSkillFusionCost(0, 1)).toBe(0);
  });
});

// ========== $fp namespace ==========

describe('$fp namespace', () => {
  it('exposes all 6 calculation methods', () => {
    expect($fp.calcContractCost).toBe(calcContractCost);
    expect($fp.calcFPFromTask).toBe(calcFPFromTask);
    expect($fp.calcFPFromAchievement).toBe(calcFPFromAchievement);
    expect($fp.calcFPFromIntimacy).toBe(calcFPFromIntimacy);
    expect($fp.calcFPFromCraft).toBe(calcFPFromCraft);
    expect($fp.calcSkillFusionCost).toBe(calcSkillFusionCost);
  });

  it('all methods are callable through the namespace', () => {
    expect($fp.calcContractCost(1, 0)).toEqual({ base: 200, modifier: 0, total: 200 });
    expect($fp.calcFPFromTask('A')).toBe(1000);
    expect($fp.calcFPFromAchievement('major')).toBe(5000);
    expect($fp.calcFPFromIntimacy('crisis')).toBe(2000);
    expect($fp.calcFPFromCraft('唯一')).toBe(6000);
    expect($fp.calcSkillFusionCost(3, 4)).toBe(1500);
  });
});
