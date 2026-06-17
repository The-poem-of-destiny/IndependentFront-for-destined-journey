/**
 * craft-dc.test.ts — 制作 DC 计算测试
 * 测试: DC计算 / 优势劣势 / 掷骰 / 经验/FP / 产能加成
 */

import { describe, it, expect } from 'vitest';
import type { QualityLevel, CraftMaterial } from './types';
import {
  determineAdvantage,
  rollCraftDice,
  calcFinalDC,
  calcCraftCheck,
  getBaseExp,
  calcExpReward,
  calcFPReward,
  getProductionBonus,
  calcResourceCost,
  calcTimeReduction,
  checkMaterialSave,
  checkGreatFailureImmunity,
  checkQualityUpgrade,
  buildSettlementBreakdown,
} from './craft-dc';

// ========== Helper ==========

function mat(name: string, quality: QualityLevel, dcMod = 0): CraftMaterial {
  return { itemId: `id_${name}`, itemName: name, quantity: 1, quality, dcModifier: dcMod };
}

// ========== Advantage / Disadvantage ==========

describe('determineAdvantage', () => {
  it('T5 vs 稀有(T3) → 优势', () => {
    const result = determineAdvantage(5, '稀有');
    expect(result.advantage).toBe(true);
    expect(result.disadvantage).toBe(false);
  });

  it('T2 vs 史诗(T4) → 劣势', () => {
    const result = determineAdvantage(2, '史诗');
    expect(result.advantage).toBe(false);
    expect(result.disadvantage).toBe(true);
  });

  it('T3 vs 史诗(T3) → 正常', () => {
    const result = determineAdvantage(3, '史诗');
    expect(result.advantage).toBe(false);
    expect(result.disadvantage).toBe(false);
  });
});

// ========== Dice Roll ==========

describe('rollCraftDice', () => {
  it('优势时取大值', () => {
    const result = rollCraftDice([8, 17], true, false);
    expect(result.diceValue).toBe(17);
    expect(result.diceUsed).toBe(2);
  });

  it('优势时取大值(反转顺序)', () => {
    const result = rollCraftDice([19, 3], true, false);
    expect(result.diceValue).toBe(19);
    expect(result.diceUsed).toBe(2);
  });

  it('劣势时取小值', () => {
    const result = rollCraftDice([8, 17], false, true);
    expect(result.diceValue).toBe(8);
    expect(result.diceUsed).toBe(2);
  });

  it('正常时取单骰', () => {
    const result = rollCraftDice([14], false, false);
    expect(result.diceValue).toBe(14);
    expect(result.diceUsed).toBe(1);
  });

  it('正常时忽略第二个骰子', () => {
    const result = rollCraftDice([12, 18], false, false);
    expect(result.diceValue).toBe(12);
    expect(result.diceUsed).toBe(1);
  });
});

// ========== Final DC ==========

describe('calcFinalDC', () => {
  it('无材料无加成的普通DC=6', () => {
    const result = calcFinalDC('普通', []);
    expect(result).toBe(6);
  });

  it('优良DC基准=10', () => {
    const result = calcFinalDC('优良', []);
    expect(result).toBe(10);
  });

  it('神话DC基准=40', () => {
    const result = calcFinalDC('神话', []);
    expect(result).toBe(40);
  });

  it('材料DC修正应叠加', () => {
    const materials = [mat('A', '优良', 2), mat('B', '优良', 1)];
    const result = calcFinalDC('普通', materials);
    expect(result).toBe(6 + 2 + 1); // = 9
  });

  it('工具加值应减免DC', () => {
    const result = calcFinalDC('普通', [], 2);
    expect(result).toBe(4); // 6 - 2
  });

  it('DC最低为1', () => {
    const result = calcFinalDC('普通', [], 100);
    expect(result).toBe(1);
  });
});

// ========== Craft Check ==========

describe('calcCraftCheck', () => {
  const basicParams = {
    targetQuality: '稀有' as QualityLevel,
    materials: [] as CraftMaterial[],
    crafterTier: 3,
    coreAttributeValue: 12,
    d20Rolls: [15],
  };

  it('应计算完整检定分解', () => {
    const result = calcCraftCheck(basicParams);
    expect(result.baseDC).toBe(16);
    // 稀有品质产能减免: (4+5)/2 = 4 → finalDC = 16 - 4 = 12
    expect(result.finalDC).toBe(12);
    expect(result.fixedBonus).toBe(12);
    expect(result.diceValue).toBe(15);
    expect(result.totalValue).toBe(27);
  });

  it('d20=1 且单骰 → 大失败', () => {
    const result = calcCraftCheck({ ...basicParams, d20Rolls: [1] });
    expect(result.rating).toBe('大失败');
  });

  it('总值 < DC → 失败', () => {
    // 稀有 target, coreAttr=1, d20=3 → total=4, DC=12 → 失败
    const result = calcCraftCheck({ ...basicParams, coreAttributeValue: 1, d20Rolls: [3] });
    expect(result.totalValue).toBe(4);
    expect(result.finalDC).toBe(12); // 16 - 4(稀有减免)
    expect(result.rating).toBe('失败');
  });

  it('总值 ≥ DC → 成功', () => {
    const result = calcCraftCheck({ ...basicParams, d20Rolls: [10] });
    expect(result.totalValue).toBe(22);
    expect(result.rating).toBe('成功');
  });

  it('总值 ≥ DC+20 → 精益求精', () => {
    const result = calcCraftCheck({ ...basicParams, d20Rolls: [19], coreAttributeValue: 20 });
    // total = 20 + 19 = 39, finalDC = 12, threshold = 12 + 20 = 32
    expect(result.totalValue).toBe(39);
    expect(result.perfectionThreshold).toBe(32);
    expect(result.rating).toBe('精益求精');
  });

  it('优势时使用2d20取高', () => {
    const result = calcCraftCheck({
      ...basicParams,
      targetQuality: '优良', // T2 quality
      crafterTier: 5,       // T5 > T2 → advantage
      d20Rolls: [5, 18],
    });
    expect(result.diceUsed).toBe(2);
    expect(result.diceValue).toBe(18);
    expect(result.advantage).toBe(true);
  });

  it('劣势时使用2d20取低', () => {
    const result = calcCraftCheck({
      ...basicParams,
      targetQuality: '传说', // T5 quality
      crafterTier: 3,        // T3 < T5 → disadvantage
      d20Rolls: [15, 3],
    });
    expect(result.diceUsed).toBe(2);
    expect(result.diceValue).toBe(3);
    expect(result.disadvantage).toBe(true);
  });

  it('层级差>2,即使roll低也应成功', () => {
    // T5 vs 优良(T2): 差=3 > 2 → 强制成功
    const result = calcCraftCheck({
      targetQuality: '优良',
      materials: [],
      crafterTier: 5,
      coreAttributeValue: 1,
      d20Rolls: [1],
    });
    // Normally would be 大失败, but tier difference > 2 overrides
    expect(result.rating).toBe('成功');
  });

  it('神话品质大失败豁免应生效', () => {
    // 神话 production bonus 有 greatFailureImmunity
    const result = calcCraftCheck({
      targetQuality: '神话',
      materials: [],
      crafterTier: 7,
      coreAttributeValue: 1,
      d20Rolls: [1],
    });
    expect(result.rating).not.toBe('大失败');
  });

  it('加值应正确分解', () => {
    const result = calcCraftCheck({
      ...basicParams,
      skillBonus: 3,
      toolBonus: 2,
      identityBonus: 1,
      locationBonus: 1,
    });
    expect(result.fixedBonus).toBe(12 + 3 + 2 + 1 + 1);
    expect(result.fixedBonusBreakdown.attribute).toBe(12);
    expect(result.fixedBonusBreakdown.skill).toBe(3);
    expect(result.fixedBonusBreakdown.tool).toBe(3); // 2+1
    expect(result.fixedBonusBreakdown.identity).toBe(1);
  });
});

// ========== Experience ==========

describe('getBaseExp', () => {
  it('普通=50', () => expect(getBaseExp('普通')).toBe(50));
  it('优良=120', () => expect(getBaseExp('优良')).toBe(120));
  it('神话=6000', () => expect(getBaseExp('神话')).toBe(6000));
  it('唯一=0', () => expect(getBaseExp('唯一')).toBe(0));
});

describe('calcExpReward', () => {
  it('基础加工无经验', () => {
    const result = calcExpReward('基础加工', '稀有', '成功', 3, 10);
    expect(result.actualExp).toBe(0);
  });

  it('半成品经验=成品一半', () => {
    const result = calcExpReward('半成品', '稀有', '成功', 3, 10);
    expect(result.actualExp).toBe(200); // 400/2
  });

  it('成品经验=全额', () => {
    const result = calcExpReward('成品', '稀有', '成功', 3, 10);
    expect(result.actualExp).toBe(400);
  });

  it('失败无经验', () => {
    const result = calcExpReward('成品', '稀有', '失败', 3, 10);
    expect(result.actualExp).toBe(0);
  });

  it('大失败无经验', () => {
    const result = calcExpReward('成品', '稀有', '大失败', 3, 10);
    expect(result.actualExp).toBe(0);
  });

  it('层级压制应归零 (T5做优良,差≥3)', () => {
    const result = calcExpReward('成品', '优良', '成功', 5, 18);
    expect(result.tierSuppressed).toBe(true);
    expect(result.actualExp).toBe(0);
  });
});

// ========== FP ==========

describe('calcFPReward', () => {
  it('普通=1', () => expect(calcFPReward('成品', '普通', '成功')).toBe(1));
  it('稀有=3', () => expect(calcFPReward('成品', '稀有', '成功')).toBe(3));
  it('神话=12', () => expect(calcFPReward('成品', '神话', '成功')).toBe(12));
  it('失败=0', () => expect(calcFPReward('成品', '稀有', '失败')).toBe(0));
  it('基础加工=0', () => expect(calcFPReward('基础加工', '稀有', '成功')).toBe(0));
  it('半成品FP减半', () => {
    const full = calcFPReward('成品', '稀有', '成功');
    const half = calcFPReward('半成品', '稀有', '成功');
    expect(half).toBe(Math.floor(full / 2));
  });
});

// ========== Production Bonus ==========

describe('getProductionBonus', () => {
  it('应有所有品质的配置', () => {
    const qualities: QualityLevel[] = ['普通', '优良', '稀有', '史诗', '传说', '神话', '唯一'];
    for (const q of qualities) {
      const bonus = getProductionBonus(q);
      expect(bonus).toBeDefined();
      expect(bonus.dcReduction).toBeDefined();
      expect(bonus.resourceReduction).toBeDefined();
    }
  });

  it('神话有品质提升能力', () => {
    const bonus = getProductionBonus('神话');
    expect(bonus.canUpgradeQuality).toBe(true);
    expect(bonus.greatFailureImmunity).toBe(true);
  });

  it('史诗有材料节省', () => {
    const bonus = getProductionBonus('史诗');
    expect(bonus.materialSave).toBeDefined();
    expect(bonus.materialSave!.d20Threshold).toBe(16);
    expect(bonus.materialSave!.savePercent).toBe(25);
  });
});

// ========== Resource Cost ==========

describe('calcResourceCost', () => {
  it('应应用资源减免', () => {
    const cost = calcResourceCost({ hp: 100, mp: 50, sp: 30 }, '稀有', 1);
    // 稀有减免: (6+10)/2 = 8% → cost * 0.92
    expect(cost.hp).toBeLessThan(100);
    expect(cost.mp).toBeLessThan(50);
  });

  it('批量应累乘', () => {
    const single = calcResourceCost({ hp: 100, mp: 0, sp: 0 }, '普通', 1);
    const batch = calcResourceCost({ hp: 100, mp: 0, sp: 0 }, '普通', 5);
    expect(batch.hp).toBe(single.hp * 5);
  });
});

// ========== Time Reduction ==========

describe('calcTimeReduction', () => {
  it('神话应有最高时间减免', () => {
    const rate = calcTimeReduction('神话');
    expect(rate).toBeCloseTo(0.605, 1); // (51+70)/2/100
  });

  it('普通无时间减免', () => {
    const rate = calcTimeReduction('普通');
    expect(rate).toBe(0);
  });
});

// ========== Material Save ==========

describe('checkMaterialSave', () => {
  it('无材料节省能力的品质', () => {
    const result = checkMaterialSave('普通', 20);
    expect(result.saved).toBe(false);
  });

  it('史诗 d20≥16 应节省', () => {
    const result = checkMaterialSave('史诗', 16);
    expect(result.saved).toBe(true);
    expect(result.savePercent).toBe(25);
  });

  it('史诗 d20<16 不节省', () => {
    const result = checkMaterialSave('史诗', 15);
    expect(result.saved).toBe(false);
  });
});

// ========== Great Failure Immunity ==========

describe('checkGreatFailureImmunity', () => {
  it('神话有大失败豁免', () => {
    expect(checkGreatFailureImmunity('神话')).toBe(true);
  });
  it('传说无大失败豁免', () => {
    expect(checkGreatFailureImmunity('传说')).toBe(false);
  });
});

// ========== Quality Upgrade ==========

describe('checkQualityUpgrade', () => {
  it('传说 d20≥18 → 神话', () => {
    const result = checkQualityUpgrade('传说', 18);
    expect(result.upgraded).toBe(true);
    expect(result.newQuality).toBe('神话');
  });

  it('传说 d20<18 → 不升级', () => {
    const result = checkQualityUpgrade('传说', 17);
    expect(result.upgraded).toBe(false);
  });

  it('史诗不可品质提升', () => {
    const result = checkQualityUpgrade('史诗', 20);
    expect(result.upgraded).toBe(false);
  });
});

// ========== Settlement Breakdown ==========

describe('buildSettlementBreakdown', () => {
  const baseParams = {
    stage: '成品' as const,
    targetQuality: '稀有' as QualityLevel,
    outputQuality: '稀有' as QualityLevel,
    rating: '成功' as const,
    materials: [mat('铁锭', '稀有'), mat('钢材', '稀有')],
    quantity: 1,
    crafterTier: 3,
    crafterLevel: 10,
    isSingle: true,
    d20MaterialSave: 10,
    d20QualityUpgrade: 10,
    resourceCost: { hp: 10, mp: 5, sp: 3 },
  };

  it('成功结算应有产出', () => {
    const result = buildSettlementBreakdown(baseParams);
    expect(result.outputQuality).toBe('稀有');
    expect(result.materialLoss.lossRate).toBe(0);
    expect(result.expReward.actualExp).toBeGreaterThan(0);
    expect(result.fpReward).toBeGreaterThan(0);
  });

  it('大失败应100%损耗', () => {
    const result = buildSettlementBreakdown({ ...baseParams, rating: '大失败' });
    expect(result.materialLoss.lossRate).toBeGreaterThan(0);
    expect(result.expReward.actualExp).toBe(0);
  });

  it('失败应50%损耗(或保护后更少)', () => {
    const result = buildSettlementBreakdown({ ...baseParams, rating: '失败' });
    expect(result.materialLoss.lossRate).toBeGreaterThan(0);
    expect(result.expReward.actualExp).toBe(0);
  });

  it('品质降级应记录', () => {
    const result = buildSettlementBreakdown({
      ...baseParams,
      outputQuality: '优良',
    });
    expect(result.qualityDowngraded).toBe(true);
  });

  it('精益求精批量应有额外产量', () => {
    const result = buildSettlementBreakdown({
      ...baseParams,
      rating: '精益求精',
      quantity: 10,
      isSingle: false,
    });
    expect(result.perfectionBonus).toBeDefined();
    expect(result.perfectionBonus!.batchExtraYield).toBe(1); // 10% of 10
  });

  it('精益求精单件应有额外词条', () => {
    const result = buildSettlementBreakdown({
      ...baseParams,
      rating: '精益求精',
      isSingle: true,
    });
    expect(result.perfectionBonus).toBeDefined();
    expect(result.perfectionBonus!.singleExtraAffix).toBeDefined();
  });
});
