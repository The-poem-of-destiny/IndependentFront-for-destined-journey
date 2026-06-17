/**
 * combat-damage.ts 测试
 * 覆盖: 8 步伤害管线 / 命中评级 / 攻击检定 / 伤害类型减免 / 状态触发
 */
import { describe, it, expect } from 'vitest';
import {
  calcInitialDamage,
  applyMultiSplit,
  applyPenetration,
  applyEquipmentReduction,
  calcDamageTypeReduction,
  applyTypeReduction,
  applyRatingAndIntention,
  applyDR,
  applyClusterMultiplier,
  runDamagePipeline,
  performAttackCheck,
  getClusterAttackCount,
  calcAoEClusterDamage,
  checkStatusTrigger,
  getHitRating,
} from './combat-damage';

// ========== Step 1: 初始伤害 ==========

describe('calcInitialDamage', () => {
  it('T3 攻击: 关联属性×10×4.0 + 技能 + 武器', () => {
    const result = calcInitialDamage(15, 3, 50, 20);
    // 15×10×4.0 = 600, + 50 + 20 = 670
    expect(result.damage).toBe(670);
    expect(result.formula).toContain('15×10×4');
    expect(result.formula).toContain('670');
  });

  it('T1 攻击: 关联属性×10×2.0 + 0 + 0', () => {
    const result = calcInitialDamage(8, 1, 0, 0);
    expect(result.damage).toBe(160); // 8×10×2.0 = 160
  });

  it('T6 高伤: 关联属性×10×35.0', () => {
    const result = calcInitialDamage(18, 6, 200, 80);
    // 18×10×35 = 6300, +200+80 = 6580
    expect(result.damage).toBe(6580);
  });
});

// ========== Step 2: 多段分割 ==========

describe('applyMultiSplit', () => {
  it('单次攻击: 不分割', () => {
    const result = applyMultiSplit(500, 1);
    expect(result.count).toBe(1);
    expect(result.perHitDamage).toBe(500);
  });

  it('3 段攻击: 均分伤害', () => {
    const result = applyMultiSplit(600, 3);
    expect(result.count).toBe(3);
    expect(result.perHitDamage).toBe(200);
  });

  it('5 段攻击: 有除不尽的舍入', () => {
    const result = applyMultiSplit(499, 3);
    expect(result.perHitDamage).toBe(166); // Math.floor(499/3) = 166
  });

  it('负段数也视为单次', () => {
    const result = applyMultiSplit(100, 0);
    expect(result.count).toBe(1);
    expect(result.perHitDamage).toBe(100);
  });
});

// ========== Step 3: 穿透修正 ==========

describe('applyPenetration', () => {
  it('无穿透: 防御不变', () => {
    const result = applyPenetration(500, 0);
    expect(result.effectiveDef).toBe(500);
    expect(result.originalDef).toBe(500);
  });

  it('30% 穿透: 有效防 = 500 × 0.7 = 350', () => {
    const result = applyPenetration(500, 0.3);
    expect(result.effectiveDef).toBe(350);
  });

  it('100% 穿透: 有效防 = 0', () => {
    const result = applyPenetration(500, 1.0);
    expect(result.effectiveDef).toBe(0);
  });

  it('穿透率 clamp 到 [0, 1]', () => {
    const result = applyPenetration(500, 2.5);
    expect(result.penetrationRate).toBe(1.0);
    expect(result.effectiveDef).toBe(0);
  });
});

// ========== Step 4: 装备减免 ==========

describe('applyEquipmentReduction', () => {
  it('高防御大幅减免', () => {
    // 有效防 2000 → 减免率 2000/4000 = 0.5
    const result = applyEquipmentReduction(500, 2000);
    expect(result.reductionAmount).toBe(250); // 500×0.5
    expect(result.afterReduction).toBe(250);
  });

  it('低防御轻微减免', () => {
    // 有效防 200 → 减免率 200/2200 ≈ 0.0909
    const result = applyEquipmentReduction(500, 200);
    expect(result.reductionAmount).toBe(45); // floor(500×200/2200)
    expect(result.afterReduction).toBe(455);
  });

  it('无防御: 不减', () => {
    const result = applyEquipmentReduction(500, 0);
    expect(result.reductionAmount).toBe(0);
    expect(result.afterReduction).toBe(500);
  });
});

// ========== Step 5: 类型减免 ==========

describe('calcDamageTypeReduction', () => {
  const baseAttr = { str: 10, dex: 12, con: 14, int: 16, spi: 18 };

  it('物理减免: (con+str+dex)×0.25%', () => {
    const result = calcDamageTypeReduction('物理', baseAttr);
    // (14+10+12)×0.0025 = 36×0.0025 = 0.09
    expect(result.reductionRate).toBeCloseTo(0.09, 3);
  });

  it('能量减免: (spi+int)×0.4%', () => {
    const result = calcDamageTypeReduction('能量', baseAttr);
    // (18+16)×0.004 = 34×0.004 = 0.136
    expect(result.reductionRate).toBeCloseTo(0.136, 3);
  });

  it('精神减免: spi×0.8%', () => {
    const result = calcDamageTypeReduction('精神', baseAttr);
    // 18×0.008 = 0.144
    expect(result.reductionRate).toBeCloseTo(0.144, 3);
  });

  it('真实伤害: 0% 减免', () => {
    const result = calcDamageTypeReduction('真实', baseAttr);
    expect(result.reductionRate).toBe(0);
  });

  it('减免率 clamp 到 95% 上限', () => {
    const hugeAttr = { str: 400, dex: 400, con: 400, int: 400, spi: 400 };
    const result = calcDamageTypeReduction('物理', hugeAttr);
    expect(result.reductionRate).toBe(0.95);
  });
});

describe('applyTypeReduction', () => {
  it('10% 减免: 500 → 450', () => {
    const result = applyTypeReduction(500, 0.1);
    expect(result.reductionAmount).toBe(50);
    expect(result.afterReduction).toBe(450);
  });

  it('0% 减免: 不变', () => {
    const result = applyTypeReduction(500, 0);
    expect(result.reductionAmount).toBe(0);
    expect(result.afterReduction).toBe(500);
  });
});

// ========== Step 6: 评级 + 意图系数 ==========

describe('applyRatingAndIntention', () => {
  it('暴击 × 抹杀意图: 300 × 1.3 × 2.0 = 780', () => {
    const result = applyRatingAndIntention(300, 1.3, 2.0);
    expect(result).toBe(780);
  });

  it('有效 × 常规意图: 300 × 1.0 × 1.0 = 300', () => {
    const result = applyRatingAndIntention(300, 1.0, 1.0);
    expect(result).toBe(300);
  });

  it('失手 × 任何意图: 300 × 0.0 × 2.0 = 0', () => {
    const result = applyRatingAndIntention(300, 0.0, 2.0);
    expect(result).toBe(0);
  });
});

// ========== Step 7: DR 修正 ==========

describe('applyDR', () => {
  it('30% DR: 500 → 350', () => {
    const result = applyDR(500, 0.3);
    expect(result.reductionAmount).toBe(150);
    expect(result.afterDR).toBe(350);
  });

  it('无 DR: 不变', () => {
    const result = applyDR(500, 0);
    expect(result.reductionAmount).toBe(0);
    expect(result.afterDR).toBe(500);
  });

  it('DR clamp', () => {
    const result = applyDR(500, 1.5);
    expect(result.reductionAmount).toBe(500);
    expect(result.afterDR).toBe(0);
  });
});

// ========== 集群修正 ==========

describe('applyClusterMultiplier', () => {
  it('对集群 ×1.5', () => {
    expect(applyClusterMultiplier(200, true)).toBe(300);
  });

  it('对单体不变', () => {
    expect(applyClusterMultiplier(200, false)).toBe(200);
  });
});

// ========== 完整 8 步管线 ==========

describe('runDamagePipeline', () => {
  const pipelineInput = {
    relevantAttribute: 14,
    attackerTier: 3,
    skillPower: 50,
    weaponAtk: 30,
    multiHitCount: 1,
    defenderDefense: 300,
    penetrationRate: 0,
    damageType: '物理' as const,
    defenderAttributes: { str: 10, dex: 10, con: 12, int: 10, spi: 10 },
    ratingCoefficient: 1.0,
    intentionCoefficient: 1.0,
    drRate: 0,
    isClusterTarget: false,
    currentHp: 200,
  };

  it('常规攻击完整管线无错误', () => {
    const result = runDamagePipeline(pipelineInput);
    expect(result.initialDamage).toBeGreaterThan(0);
    expect(result.finalDamage).toBeGreaterThanOrEqual(0);
    expect(result.finalDamage).toBeLessThanOrEqual(result.initialDamage);
  });

  it('管线逐步降值 (除了暴击加成)', () => {
    const result = runDamagePipeline(pipelineInput);
    // 经过装备减免和类型减免后应低于初始
    expect(result.afterEquipmentReduction).toBeLessThanOrEqual(result.initialDamage);
    expect(result.finalDamage).toBeLessThanOrEqual(result.initialDamage);
  });

  it('暴击管线: 系数 1.3 放大伤害', () => {
    const critInput = { ...pipelineInput, ratingCoefficient: 1.3 };
    const result = runDamagePipeline(critInput);
    expect(result.ratingCoefficient).toBe(1.3);
  });

  it('真实伤害跳过类型减免', () => {
    const trueDmgInput = { ...pipelineInput, damageType: '真实' as const };
    const result = runDamagePipeline(trueDmgInput);
    expect(result.typeReductionRate).toBe(0);
    expect(result.typeReductionAmount).toBe(0);
  });

  it('穿透减少装备减免', () => {
    const penInput = {
      ...pipelineInput,
      penetrationRate: 0.5,
      defenderDefense: 2000,
    };
    const resultPen = runDamagePipeline(penInput);
    const resultNoPen = runDamagePipeline({ ...pipelineInput, defenderDefense: 2000 });
    // 有穿透时减免更少 → 最终伤害更高
    expect(resultPen.equipmentReduction).toBeLessThan(resultNoPen.equipmentReduction);
  });

  it('多功能管线: T5 暴击+穿透+DR', () => {
    const result = runDamagePipeline({
      ...pipelineInput,
      relevantAttribute: 18,
      attackerTier: 5,
      skillPower: 120,
      weaponAtk: 80,
      defenderDefense: 800,
      penetrationRate: 0.25,
      ratingCoefficient: 1.6,
      intentionCoefficient: 1.3,
      drRate: 0.15,
      defenderAttributes: { str: 16, dex: 14, con: 16, int: 14, spi: 16 },
    });
    expect(result.initialDamage).toBeGreaterThan(0);
    expect(result.finalDamage).toBeGreaterThan(0);
    expect(result.penetration.effectiveDef).toBe(600); // 800×0.75
    expect(result.typeReductionRate).toBeGreaterThan(0);
    expect(result.ratingCoefficient).toBe(1.6);
  });
});

// ========== 攻击检定 ==========

describe('performAttackCheck', () => {
  it('同层级: 1d20 正常检定', () => {
    const result = performAttackCheck({
      d20Roll: 15,
      attackerTier: 3,
      defenderTier: 3,
      hitBonus: 5,
      defenderDodge: 3,
      dodgeNegated: false,
    });
    expect(result.diceRolls).toHaveLength(1);
    expect(result.diceRolls[0]).toBe(15);
    expect(result.advantage).toBe(false);
    expect(result.disadvantage).toBe(false);
    expect(result.checkValue).toBe(17); // 15+5-3
    expect(result.rating.level).toBe('有效');
  });

  it('高T对低T: 优势 (2d20取高)', () => {
    const result = performAttackCheck({
      d20Roll: 10,
      attackerTier: 5,
      defenderTier: 3,
      hitBonus: 2,
      defenderDodge: 2,
      dodgeNegated: false,
    });
    expect(result.diceRolls).toHaveLength(2);
    expect(result.advantage).toBe(true);
    expect(result.diceUsed).toBeGreaterThanOrEqual(10);
  });

  it('低T对高T: 劣势 (2d20取低)', () => {
    const result = performAttackCheck({
      d20Roll: 15,
      attackerTier: 2,
      defenderTier: 5,
      hitBonus: 0,
      defenderDodge: 5,
      dodgeNegated: false,
    });
    expect(result.disadvantage).toBe(true);
    expect(result.diceUsed).toBeLessThanOrEqual(15);
  });

  it('攻方 T > 守方 T+1: 闪避无效', () => {
    const result = performAttackCheck({
      d20Roll: 12,
      attackerTier: 5,
      defenderTier: 3, // 5 > 3+1 → 闪避无效
      hitBonus: 2,
      defenderDodge: 10,
      dodgeNegated: false,
    });
    expect(result.effectiveDodge).toBe(0);
    expect(result.dodgeNegatedReason).toContain('闪避无效');
  });

  it('强暴击: 检定值 ≥ 25', () => {
    const result = performAttackCheck({
      d20Roll: 20,
      attackerTier: 5,
      defenderTier: 3,
      hitBonus: 8,
      defenderDodge: 0,
      dodgeNegated: true,
    });
    expect(result.checkValue).toBe(28); // 20+8-0
    expect(result.rating.level).toBe('强暴击');
    expect(result.rating.coefficient).toBe(1.6);
  });

  it('失手: 检定值 ≤ 3', () => {
    const result = performAttackCheck({
      d20Roll: 1,
      attackerTier: 1,
      defenderTier: 5,
      hitBonus: 0,
      defenderDodge: 5,
      dodgeNegated: false,
    });
    expect(result.rating.level).toBe('失手');
    expect(result.rating.coefficient).toBe(0);
  });
});

// ========== 命中评级表 ==========

describe('getHitRating', () => {
  it('≥30 → 超暴击 (2.0)', () => {
    const r = getHitRating(32);
    expect(r.level).toBe('超暴击');
    expect(r.coefficient).toBe(2.0);
  });

  it('≥25 → 强暴击 (1.6)', () => {
    expect(getHitRating(26).level).toBe('强暴击');
    expect(getHitRating(26).coefficient).toBe(1.6);
  });

  it('≥20 → 暴击 (1.3)', () => {
    expect(getHitRating(22).level).toBe('暴击');
    expect(getHitRating(22).coefficient).toBe(1.3);
  });

  it('11-19 → 有效 (1.0)', () => {
    expect(getHitRating(15).level).toBe('有效');
    expect(getHitRating(15).coefficient).toBe(1.0);
  });

  it('8-10 → 勉强 (0.8)', () => {
    expect(getHitRating(9).level).toBe('勉强');
    expect(getHitRating(9).coefficient).toBe(0.8);
  });

  it('4-7 → 擦伤 (0.3)', () => {
    expect(getHitRating(5).level).toBe('擦伤');
    expect(getHitRating(5).coefficient).toBe(0.3);
  });

  it('≤3 → 失手 (0)', () => {
    expect(getHitRating(2).level).toBe('失手');
    expect(getHitRating(2).coefficient).toBe(0);
    expect(getHitRating(-5).level).toBe('失手');
  });
});

// ========== 集群攻击次数 ==========

describe('getClusterAttackCount', () => {
  it('HP ≥ 80% → 3 次', () => {
    expect(getClusterAttackCount(80, 100)).toBe(3);
    expect(getClusterAttackCount(95, 100)).toBe(3);
  });

  it('HP ≥ 50% → 2 次', () => {
    expect(getClusterAttackCount(60, 100)).toBe(2);
    expect(getClusterAttackCount(79, 100)).toBe(2);
  });

  it('HP ≥ 30% → 1 次', () => {
    expect(getClusterAttackCount(40, 100)).toBe(1);
    expect(getClusterAttackCount(49, 100)).toBe(1);
  });

  it('HP < 30% → 1 次', () => {
    expect(getClusterAttackCount(20, 100)).toBe(1);
    expect(getClusterAttackCount(1, 100)).toBe(1);
  });
});

// ========== AoE 集群 ==========

describe('calcAoEClusterDamage', () => {
  it('范围 3/集群 5: 取 min(3,5)=3', () => {
    expect(calcAoEClusterDamage(100, 3, 5)).toBe(300);
  });

  it('范围 5/集群 3: 取 min(5,3)=3', () => {
    expect(calcAoEClusterDamage(100, 5, 3)).toBe(300);
  });
});

// ========== 状态触发判定 ==========

describe('checkStatusTrigger', () => {
  it('暴击(≥1.3) → 必触发', () => {
    const result = checkStatusTrigger(1.3, 10, 10, 5, 5, false);
    expect(result.triggered).toBe(true);
    expect(result.narrative).toContain('必触发');
  });

  it('擦伤(0.3) → 不触发', () => {
    const result = checkStatusTrigger(0.3, 10, 10, 5, 5, false);
    expect(result.triggered).toBe(false);
    expect(result.narrative).toContain('不触发');
  });

  it('失手(0) → 不触发', () => {
    const result = checkStatusTrigger(0, 10, 10, 5, 5, false);
    expect(result.triggered).toBe(false);
  });

  it('有效(1.0) + 对抗检定成功', () => {
    // 攻方: 15+18=33, 守方: 12+10=22 → 成功
    const result = checkStatusTrigger(1.0, 15, 12, 18, 10, false);
    expect(result.triggered).toBe(true);
  });

  it('有效(1.0) + 对抗检定失败', () => {
    // 攻方: 10+8=18, 守方: 15+12=27 → 失败
    const result = checkStatusTrigger(1.0, 10, 15, 8, 12, false);
    expect(result.triggered).toBe(false);
  });

  it('控制类状态: 守方+5 加固', () => {
    // 攻方: 20+15=35, 守方: 20+10+5=35 → 平局成功
    const result = checkStatusTrigger(1.0, 20, 20, 15, 10, true);
    expect(result.triggered).toBe(true);
  });

  it('控制类状态: 加固后失败', () => {
    // 攻方: 15+10=25, 守方: 18+10+5=33 → 失败
    const result = checkStatusTrigger(1.0, 15, 18, 10, 10, true);
    expect(result.triggered).toBe(false);
  });
});
