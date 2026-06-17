/**
 * 制作 DC 计算 — Layer 2 计算级 (AI 可读，不可写)
 *
 * 职责: DC 计算 / 产能加成 / 经验/FP 奖励 / 资源消耗
 * 对齐世界书 #683615 [生产制作协议] + #265160 [品质效果限定] + #284017 [经验值获取]。
 *
 * DC 公式:
 *   finalDC = baseDC + Σ(materialDCModifiers) - bonusReduction
 *
 * 骰池规则:
 *   制作者层级 > 目标品质对应层级 → 优势 (2d20 取高)
 *   制作者层级 < 目标品质对应层级 → 劣势 (2d20 取低)
 *   相等 → 正常 1d20
 *
 * 检定公式:
 *   totalValue = 核心属性 + skillBonus + toolBonus + identityBonus + d20
 */

import type {
  QualityLevel,
  CraftStage,
  CraftRating,
  CraftMaterial,
  CraftProductionBonus,
  CraftCheckBreakdown,
  CraftSettlementBreakdown,
  TierConfig,
} from './types';
import {
  CRAFT_DC_BASE,
  CRAFT_PRODUCTION_BONUSES,
  CRAFT_QUALITY_EXP,
  QUALITY_RANK,
  CRAFT_RATING_VALUE_RANGE,
} from './types';
import { getTierConfig } from './tier-constants';

// ========== Dice Pool ==========

/**
 * 品质→对应生命层级 (用于骰池判定)
 * 对齐 tier-constants.ts 各层级的 qualityCap:
 *   T1→优良, T2→稀有, T3→史诗, T4→传说, T5→神话, T6→唯一
 */
const QUALITY_TIER_REFERENCE: Record<QualityLevel, number> = {
  '普通': 1,
  '优良': 1,   // T1 可产
  '稀有': 2,   // T2 可产
  '史诗': 3,   // T3 可产
  '传说': 4,   // T4 可产
  '神话': 5,   // T5 可产
  '唯一': 6,   // T6 可产 (实际不可生产,仅参考)
};

/**
 * 根据制作者层级 vs 目标品质层级 决定优势/劣势
 */
export function determineAdvantage(
  crafterTier: number,
  targetQuality: QualityLevel,
): { advantage: boolean; disadvantage: boolean } {
  const qualityTier = QUALITY_TIER_REFERENCE[targetQuality] ?? 1;

  if (crafterTier > qualityTier) {
    return { advantage: true, disadvantage: false };
  } else if (crafterTier < qualityTier) {
    return { advantage: false, disadvantage: true };
  }
  return { advantage: false, disadvantage: false };
}

/**
 * 掷骰 (advantage 时取大, disadvantage 时取小)
 */
export function rollCraftDice(
  d20Rolls: number[],
  advantage: boolean,
  disadvantage: boolean,
): { diceValue: number; diceUsed: number } {
  if (advantage && d20Rolls.length >= 2) {
    return { diceValue: Math.max(d20Rolls[0], d20Rolls[1]), diceUsed: 2 };
  }
  if (disadvantage && d20Rolls.length >= 2) {
    return { diceValue: Math.min(d20Rolls[0], d20Rolls[1]), diceUsed: 2 };
  }
  // 正常 1d20
  const d20 = d20Rolls[0] ?? 10;
  return { diceValue: d20, diceUsed: 1 };
}

// ========== DC Calculation ==========

/**
 * 计算最终制作 DC
 *
 * @param targetQuality 目标品质
 * @param materials 投入物列表
 * @param toolBonus 工具/设施加值
 * @param productionBonus 品质产能加成
 * @returns 最终 DC 值
 */
export function calcFinalDC(
  targetQuality: QualityLevel,
  materials: CraftMaterial[],
  toolBonus: number = 0,
  productionBonus?: CraftProductionBonus,
): number {
  const baseDC = CRAFT_DC_BASE[targetQuality];

  // 材料 DC 修正总和
  const materialDC = materials.reduce((sum, m) => sum + m.dcModifier, 0);

  // 品质产能 DC 减免
  let dcReduction = toolBonus;
  if (productionBonus) {
    const [min, max] = productionBonus.dcReduction;
    // 取中间值作为减免
    dcReduction += Math.floor((min + max) / 2);
  }

  const finalDC = Math.max(1, baseDC + materialDC - dcReduction);
  return finalDC;
}

/**
 * 计算完整的制作检定分解
 */
export function calcCraftCheck(
  params: {
    targetQuality: QualityLevel;
    materials: CraftMaterial[];
    crafterTier: number;
    coreAttributeValue: number;
    d20Rolls: number[];
    skillBonus?: number;
    toolBonus?: number;
    identityBonus?: number;
    locationBonus?: number;
  },
): CraftCheckBreakdown {
  const {
    targetQuality,
    materials,
    crafterTier,
    coreAttributeValue,
    d20Rolls,
    skillBonus = 0,
    toolBonus = 0,
    identityBonus = 0,
    locationBonus = 0,
  } = params;

  // 获取产能加成
  const productionBonus = getProductionBonus(targetQuality);

  // DC 计算
  const baseDC = CRAFT_DC_BASE[targetQuality];
  const materialDCModifier = materials.reduce((sum, m) => sum + m.dcModifier, 0);
  const [dcMin, dcMax] = productionBonus.dcReduction;
  const bonusDCReduction = toolBonus + locationBonus + Math.floor((dcMin + dcMax) / 2);
  const finalDC = Math.max(1, baseDC + materialDCModifier - bonusDCReduction);

  // 固定加值
  const fixedBonus = coreAttributeValue + skillBonus + toolBonus + identityBonus + locationBonus;

  // 骰池
  const { advantage, disadvantage } = determineAdvantage(crafterTier, targetQuality);
  const { diceValue, diceUsed } = rollCraftDice(d20Rolls, advantage, disadvantage);

  // 判定
  const totalValue = fixedBonus + diceValue;
  const perfectionThreshold = finalDC + 20 - productionBonus.perfectionThresholdReduction;

  let rating: CraftRating;
  if (diceValue === 1 && d20Rolls.length === 1 && !productionBonus.greatFailureImmunity) {
    rating = '大失败';
  } else if (totalValue >= perfectionThreshold) {
    rating = '精益求精';
  } else if (totalValue >= finalDC) {
    rating = '成功';
  } else {
    rating = '失败';
  }

  // 层级差 > 2 的绝对成功 (高T做低品质，大失败→成功 / 失败→成功)
  const qualityTier = QUALITY_TIER_REFERENCE[targetQuality] ?? 1;
  if (crafterTier > qualityTier + 2 && (rating === '失败' || rating === '大失败')) {
    rating = '成功';
  }

  return {
    baseDC,
    materialDCModifier,
    materialDCDetails: materials.map(m => ({ materialName: m.itemName, dcModifier: m.dcModifier })),
    bonusDCReduction,
    finalDC,
    fixedBonus,
    fixedBonusBreakdown: {
      attribute: coreAttributeValue,
      skill: skillBonus,
      tool: toolBonus + locationBonus,
      identity: identityBonus,
    },
    diceUsed,
    advantage,
    disadvantage,
    diceRolls: d20Rolls,
    diceValue,
    totalValue,
    rating,
    perfectionThreshold,
  };
}

// ========== Experience & FP Calculation ==========

/**
 * 获取目标品质的基础经验值
 */
export function getBaseExp(quality: QualityLevel): number {
  return CRAFT_QUALITY_EXP[quality] ?? 0;
}

/**
 * 计算实际经验获得
 * - 基础加工: 无经验
 * - 半成品: 经验 = 成品的一半
 * - 成品: 全额经验
 * - 失败/大失败: 无经验
 * - 层级压制: 若制作者层级远高于品质层级则归零
 *
 * @param stage 制作阶段
 * @param quality 产出品质
 * @param rating 检定评级
 * @param crafterTier 制作者层级
 * @param crafterLevel 制作者等级
 * @returns 实际获得经验
 */
export function calcExpReward(
  stage: CraftStage,
  quality: QualityLevel,
  rating: CraftRating,
  crafterTier: number,
  crafterLevel: number,
): { baseExp: number; tierSuppressed: boolean; actualExp: number } {
  // 失败/大失败 → 无经验
  if (rating === '大失败' || rating === '失败') {
    return { baseExp: 0, tierSuppressed: false, actualExp: 0 };
  }

  // 基础加工 → 无经验
  if (stage === '基础加工') {
    return { baseExp: 0, tierSuppressed: false, actualExp: 0 };
  }

  const baseExp = CRAFT_QUALITY_EXP[quality] ?? 0;

  // 半成品 → 经验减半
  let exp = stage === '半成品' ? Math.floor(baseExp / 2) : baseExp;

  // 层级压制: 制作者层级 ≥ 品质对应层级+3 → 经验归零
  const qualityTier = QUALITY_TIER_REFERENCE[quality] ?? 1;
  const tierSuppressed = crafterTier >= qualityTier + 3;

  if (tierSuppressed) {
    exp = 0;
  }

  // 检查是否超过层级经验上限
  const tierConfig = getTierConfig(crafterTier);
  if (tierConfig && crafterLevel >= tierConfig.levelRange[1]) {
    // At level cap for this tier
  }

  return { baseExp, tierSuppressed, actualExp: exp };
}

/**
 * 计算 FP 奖励
 * FP = 基础 × 品质乘数
 * 普通1/优良2/稀有3/史诗5/传说8/神话12
 */
export function calcFPReward(
  stage: CraftStage,
  quality: QualityLevel,
  rating: CraftRating,
): number {
  if (rating === '大失败' || rating === '失败') return 0;
  if (stage === '基础加工') return 0;

  const fpMultiplier: Record<QualityLevel, number> = {
    '普通': 1, '优良': 2, '稀有': 3, '史诗': 5, '传说': 8, '神话': 12, '唯一': 0,
  };

  // 半成品 FP 减半
  const base = fpMultiplier[quality] ?? 0;
  return stage === '半成品' ? Math.max(1, Math.floor(base / 2)) : base;
}

// ========== Production Bonus ==========

/**
 * 获取品质产能加成配置
 */
export function getProductionBonus(quality: QualityLevel): CraftProductionBonus {
  return CRAFT_PRODUCTION_BONUSES[quality] ?? CRAFT_PRODUCTION_BONUSES['普通'];
}

/**
 * 计算资源消耗 (应用产能加成减免)
 */
export function calcResourceCost(
  baseCost: { hp: number; mp: number; sp: number },
  quality: QualityLevel,
  quantity: number = 1,
): { hp: number; mp: number; sp: number } {
  const bonus = getProductionBonus(quality);
  const [reduceMin, reduceMax] = bonus.resourceReduction;
  const reductionRate = (reduceMin + reduceMax) / 2 / 100; // 取中值

  return {
    hp: Math.ceil(baseCost.hp * quantity * (1 - reductionRate)),
    mp: Math.ceil(baseCost.mp * quantity * (1 - reductionRate)),
    sp: Math.ceil(baseCost.sp * quantity * (1 - reductionRate)),
  };
}

/**
 * 计算时间消耗 (应用产能加成减免)
 */
export function calcTimeReduction(quality: QualityLevel): number {
  const bonus = getProductionBonus(quality);
  const [min, max] = bonus.timeReduction;
  return (min + max) / 2 / 100; // 返回减免率
}

// ========== Settlement Helpers ==========

/**
 * 计算材料节省判定
 */
export function checkMaterialSave(
  quality: QualityLevel,
  d20Roll: number,
): { saved: boolean; savePercent: number } {
  const bonus = getProductionBonus(quality);
  if (!bonus.materialSave) {
    return { saved: false, savePercent: 0 };
  }
  return {
    saved: d20Roll >= bonus.materialSave.d20Threshold,
    savePercent: bonus.materialSave.savePercent,
  };
}

/**
 * 计算大失败豁免 (神话品质)
 */
export function checkGreatFailureImmunity(quality: QualityLevel): boolean {
  return getProductionBonus(quality).greatFailureImmunity === true;
}

/**
 * 计算品质提升判定 (神话: 传说→神话, d20≥18)
 */
/**
 * 品质提升判定 (对齐世界书 #265160 生产加成表)
 * 神话产能加成: 品质提升(传→神, d20≥18)
 * 注: 该能力来自神话品质的工具/设施，不是目标品质本身
 */
export function checkQualityUpgrade(
  targetQuality: QualityLevel,
  d20Roll: number,
): { upgraded: boolean; newQuality: QualityLevel } {
  // 神话级别产能方可触发品质提升
  if (targetQuality === '传说' && d20Roll >= 18) {
    return { upgraded: true, newQuality: '神话' };
  }
  return { upgraded: false, newQuality: targetQuality };
}

/**
 * 构建完整的制作结算分解
 */
export function buildSettlementBreakdown(
  params: {
    stage: CraftStage;
    targetQuality: QualityLevel;
    outputQuality: QualityLevel;
    rating: CraftRating;
    materials: CraftMaterial[];
    quantity: number;
    crafterTier: number;
    crafterLevel: number;
    isSingle: boolean;
    d20MaterialSave: number;
    d20QualityUpgrade: number;
    resourceCost: { hp: number; mp: number; sp: number };
  },
): CraftSettlementBreakdown {
  const {
    stage, targetQuality, outputQuality, rating, materials,
    quantity, crafterTier, crafterLevel, isSingle,
    d20MaterialSave, d20QualityUpgrade, resourceCost,
  } = params;

  const bonus = getProductionBonus(outputQuality);

  // 材料损耗
  let lossRate: number;
  if (rating === '大失败' && stage === '成品') lossRate = 1.0;
  else if (rating === '失败') lossRate = 0.5;
  else lossRate = 0;

  // 失败保护: 降低损毁率
  if (rating === '失败' && bonus.failureProtection < lossRate) {
    lossRate = bonus.failureProtection;
  }

  const lostMaterials = materials.map(m => ({
    itemName: m.itemName,
    quantity: Math.ceil(m.quantity * lossRate),
  })).filter(m => m.quantity > 0);

  // 精益求精增益
  let perfectionBonus: CraftSettlementBreakdown['perfectionBonus'];
  if (rating === '精益求精') {
    if (!isSingle) {
      // 批量: +10% 产量
      perfectionBonus = { batchExtraYield: Math.ceil(quantity * 0.1) };
    } else if (stage === '半成品') {
      // 半成品单件: DC 修正降级
      perfectionBonus = { dcModifierDowngrade: 2 };
    } else if (stage === '成品') {
      // 成品单件: 额外词条
      perfectionBonus = { singleExtraAffix: '精益求精额外词条' };
    }
  }

  // DC 修正
  const dcRange = bonus.canUpgradeQuality
    ? [16, 25] as [number, number]
    : [Math.floor((CRAFT_DC_MODIFIER_RANGE[outputQuality]?.[0] ?? 0) * 0.7),
       CRAFT_DC_MODIFIER_RANGE[outputQuality]?.[1] ?? 0] as [number, number];
  const productDCModifier = dcRange[0] +
    Math.floor(Math.random() * (dcRange[1] - dcRange[0] + 1));

  // 经验
  const expReward = calcExpReward(stage, outputQuality, rating, crafterTier, crafterLevel);
  const fpReward = calcFPReward(stage, outputQuality, rating);

  // 材料节省
  const materialSave = checkMaterialSave(outputQuality, d20MaterialSave);

  // 品质升级
  const qualityUpgrade = checkQualityUpgrade(targetQuality, d20QualityUpgrade);
  const finalQuality = qualityUpgrade.upgraded ? qualityUpgrade.newQuality : outputQuality;

  // 成品数值区间
  let valueRange: { min: number; max: number } | undefined;
  if (stage === '成品' && rating !== '大失败' && rating !== '失败') {
    const range = CRAFT_RATING_VALUE_RANGE[rating];
    valueRange = {
      min: range.min * 100,
      max: range.max * 100,
    };
  }

  return {
    materialLoss: { lossRate, lostMaterials },
    outputQuality: finalQuality,
    qualityDowngraded: finalQuality !== targetQuality,
    qualityDowngradeReason: finalQuality !== targetQuality
      ? `品质继承不满足，产出降级为「${finalQuality}」` : undefined,
    perfectionBonus,
    productDCModifier,
    valueRange,
    expReward,
    fpReward,
    resourceCost,
    resourceSufficient: true,
  };
}

// Re-export for convenience
import { CRAFT_DC_MODIFIER_RANGE } from './types';
