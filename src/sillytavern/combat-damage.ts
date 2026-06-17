/**
 * 战斗伤害管线 — Layer 3 流程级 (AI 不可见)
 *
 * 职责: 执行完整的 8 步伤害计算管线，对齐世界书 #837805 [战斗协议]。
 *
 * 8 步管线:
 *   1. 初始伤害 = 关联属性×10×层级系数 + 技能威力 + 武器攻击力
 *   2. 多段分割 (如有)
 *   3. 穿透修正
 *   4. 装备减免
 *   5. 类型减免 (物理/能量/精神/真实)
 *   6. 评级系数 × 意图系数
 *   7. DR 修正
 *   8. 最终伤害 → HP 结算
 *
 * 命中评级 (7 级):
 *   ≥30(超暴击,2.0) | ≥25(强暴击,1.6) | ≥20(暴击,1.3)
 *   11-19(有效,1.0) | 8-10(勉强,0.8) | 4-7(擦伤,0.3) | ≤3(失手,0)
 */

import type {
  DamageType,
  HitRating,
  CombatDamageBreakdown,
} from './types';
import { getHitRating } from './types';
import { getCombatCoefficient } from './tier-constants';

// Re-export for convenience
export { getHitRating } from './types';

// ========== Step 1: 初始伤害 ==========

/** 计算初始伤害 = 关联属性×10×层级系数 + 技能威力 + 武器攻击力 (世界书公式) */
export function calcInitialDamage(
  relevantAttributeValue: number,
  attackerTier: number,
  skillPower: number,
  weaponAtk: number,
): { damage: number; formula: string } {
  const coeff = getCombatCoefficient(attackerTier);
  const attrPart = relevantAttributeValue * 10 * coeff;
  const total = attrPart + skillPower + weaponAtk;

  return {
    damage: total,
    formula: `(${relevantAttributeValue}×10×${coeff} + ${skillPower} + ${weaponAtk}) = ${total}`,
  };
}

// ========== Step 2: 多段分割 ==========

/** 多段/连击：将总伤害除以段数 */
export function applyMultiSplit(
  initialDamage: number,
  multiHitCount: number,
): { perHitDamage: number; count: number } {
  if (multiHitCount <= 1) {
    return { perHitDamage: initialDamage, count: 1 };
  }
  return {
    perHitDamage: Math.floor(initialDamage / multiHitCount),
    count: multiHitCount,
  };
}

// ========== Step 3: 穿透修正 ==========

/** 穿透修正: 有效防御 = 防御 × (1 - 穿透%) */
export function applyPenetration(
  defenderDefense: number,
  penetrationRate: number, // 0.0 ~ 1.0
): { effectiveDef: number; originalDef: number; penetrationRate: number } {
  if (penetrationRate <= 0) {
    return { effectiveDef: defenderDefense, originalDef: defenderDefense, penetrationRate: 0 };
  }
  const clampedRate = Math.min(1, Math.max(0, penetrationRate));
  const effectiveDef = Math.floor(defenderDefense * (1 - clampedRate));
  return { effectiveDef, originalDef: defenderDefense, penetrationRate: clampedRate };
}

// ========== Step 4: 装备减免 ==========

/** 装备减免: 伤害 × (有效防御 / (有效防御 + 2000)) */
export function applyEquipmentReduction(
  damage: number,
  effectiveDefense: number,
): { reductionAmount: number; afterReduction: number } {
  if (effectiveDefense <= 0) {
    return { reductionAmount: 0, afterReduction: damage };
  }
  // 减免 = 伤害 × (有效防 / (有效防 + 2000))
  const reductionRate = effectiveDefense / (effectiveDefense + 2000);
  const reductionAmount = Math.floor(damage * reductionRate);
  const afterReduction = damage - reductionAmount;
  return { reductionAmount, afterReduction };
}

// ========== Step 5: 类型减免 ==========

/**
 * 属性减免 (对齐世界书):
 *   物理: (体质+力量+敏捷) × 0.25%
 *   能量: (精神+智力) × 0.4%
 *   精神: 精神 × 0.8%
 *   真实: 0 (无视所有减免)
 */
export function calcDamageTypeReduction(
  damageType: DamageType,
  attributes: { str: number; dex: number; con: number; int: number; spi: number },
): { reductionRate: number; reductionAmount: number } {
  let reductionRate: number;

  switch (damageType) {
    case '物理':
      reductionRate = (attributes.con + attributes.str + attributes.dex) * 0.0025; // 0.25%
      break;
    case '能量':
      reductionRate = (attributes.spi + attributes.int) * 0.004; // 0.4%
      break;
    case '精神':
      reductionRate = attributes.spi * 0.008; // 0.8%
      break;
    case '真实':
      reductionRate = 0; // 真实伤害无视减免
      break;
    default:
      reductionRate = 0;
  }

  // Clamp to 0-95% (never fully immune via type alone)
  reductionRate = Math.min(0.95, Math.max(0, reductionRate));

  return {
    reductionRate,
    reductionAmount: 0, // calculated later against damage
  };
}

/** 应用类型减免: afterReduction × (1 - 减免%) */
export function applyTypeReduction(
  damageAfterEquipment: number,
  reductionRate: number,
): { reductionAmount: number; afterReduction: number } {
  const reductionAmount = Math.floor(damageAfterEquipment * reductionRate);
  return {
    reductionAmount,
    afterReduction: damageAfterEquipment - reductionAmount,
  };
}

// ========== Step 6: 评级 + 意图系数 ==========

/** 应用评级系数和意图系数 */
export function applyRatingAndIntention(
  damage: number,
  ratingCoefficient: number,
  intentionCoefficient: number,
): number {
  return Math.floor(damage * ratingCoefficient * intentionCoefficient);
}

// ========== Step 7: DR 修正 ==========

/** DR 修正: damage × (1 - DR%) */
export function applyDR(
  damage: number,
  drRate: number, // 0.0 ~ 1.0
): { reductionAmount: number; afterDR: number } {
  if (drRate <= 0) {
    return { reductionAmount: 0, afterDR: damage };
  }
  const clampedRate = Math.min(1, Math.max(0, drRate));
  const reductionAmount = Math.floor(damage * clampedRate);
  return { reductionAmount, afterDR: damage - reductionAmount };
}

// ========== 集群修正 ==========

/** 集群修正: 对集群单位的最终伤害 ×1.5 */
export function applyClusterMultiplier(damage: number, isClusterTarget: boolean): number {
  return isClusterTarget ? Math.floor(damage * 1.5) : damage;
}

// ========== 完整 8 步管线 ==========

export interface DamagePipelineInput {
  /** 关联属性值 (用于伤害公式) */
  relevantAttribute: number;
  /** 攻击者层级 */
  attackerTier: number;
  /** 技能威力 */
  skillPower: number;
  /** 武器攻击力 */
  weaponAtk: number;
  /** 多段攻击次数 (默认 1) */
  multiHitCount: number;
  /** 守方防御值 */
  defenderDefense: number;
  /** 穿透率 (0.0 ~ 1.0) */
  penetrationRate: number;
  /** 伤害类型 */
  damageType: DamageType;
  /** 守方五维属性 */
  defenderAttributes: { str: number; dex: number; con: number; int: number; spi: number };
  /** 命中评级系数 */
  ratingCoefficient: number;
  /** 意图系数 */
  intentionCoefficient: number;
  /** DR 率 (0.0 ~ 1.0) */
  drRate: number;
  /** 是否集群目标 */
  isClusterTarget: boolean;
  /** 当前 HP */
  currentHp: number;
  /** 额外固定伤害 (武器附魔/品质固伤等, 默认 0) */
  fixedDamageBonus?: number;
}

/**
 * 执行完整的 8 步伤害管线。
 * 返回逐步分解的伤害计算结果。
 */
export function runDamagePipeline(input: DamagePipelineInput): CombatDamageBreakdown {
  // Step 1: 初始伤害
  const initial = calcInitialDamage(
    input.relevantAttribute,
    input.attackerTier,
    input.skillPower,
    input.weaponAtk,
  );

  // Step 2: 多段分割
  const multiSplit = applyMultiSplit(initial.damage, input.multiHitCount);
  const afterSplit = multiSplit.perHitDamage;

  // Step 3: 穿透修正
  const penetration = applyPenetration(input.defenderDefense, input.penetrationRate);

  // Step 4: 装备减免
  const equipReduction = applyEquipmentReduction(afterSplit, penetration.effectiveDef);

  // Step 5: 类型减免
  const typeReduction = calcDamageTypeReduction(input.damageType, input.defenderAttributes);
  const typeApplied = applyTypeReduction(equipReduction.afterReduction, typeReduction.reductionRate);

  // Step 6: 评级系数 × 意图系数
  const afterRating = applyRatingAndIntention(
    typeApplied.afterReduction,
    input.ratingCoefficient,
    input.intentionCoefficient,
  );

  // Step 6a: + 额外固定伤害 (世界书: 武器附魔/品质固伤等)
  const fixedBonus = input.fixedDamageBonus ?? 0;
  const afterFixed = afterRating + fixedBonus;

  // Step 6b: × 攻击次数 (世界书: 多段/连击恢复总伤害)
  const afterAttackCount = afterFixed * input.multiHitCount;

  // Step 7: DR 修正
  const drApplied = applyDR(afterAttackCount, input.drRate);

  // Step 8: 集群修正 → 最终伤害
  const finalDamage = applyClusterMultiplier(drApplied.afterDR, input.isClusterTarget);

  return {
    initialDamage: initial.damage,
    initialFormula: initial.formula,

    afterMultiSplit: afterSplit,
    multiSplitInfo: input.multiHitCount > 1
      ? { count: input.multiHitCount, perHit: afterSplit }
      : undefined,

    penetration: {
      originalDef: penetration.originalDef,
      penetrationRate: penetration.penetrationRate,
      effectiveDef: penetration.effectiveDef,
    },

    equipmentReduction: equipReduction.reductionAmount,
    afterEquipmentReduction: equipReduction.afterReduction,

    typeReductionRate: typeReduction.reductionRate,
    typeReductionAmount: typeApplied.reductionAmount,
    afterTypeReduction: typeApplied.afterReduction,

    ratingCoefficient: input.ratingCoefficient,
    intentionCoefficient: input.intentionCoefficient,
    afterRating,

    drRate: input.drRate,
    drReduction: drApplied.reductionAmount,
    afterDr: drApplied.afterDR,

    finalDamage,
  };
}

// ========== 攻击检定 ==========

export interface AttackCheckInput {
  /** d20 骰值 */
  d20Roll: number;
  /** 攻方层级 */
  attackerTier: number;
  /** 守方层级 */
  defenderTier: number;
  /** 命中加值 */
  hitBonus: number;
  /** 守方闪避加值 */
  defenderDodge: number;
  /** 闪避是否无效 (攻方T > 守方T+1 或特定状态) */
  dodgeNegated: boolean;
}

export interface AttackCheckResult {
  /** 使用的骰值 */
  diceUsed: number;
  /** 所有掷骰结果 */
  diceRolls: number[];
  /** 是否使用优势 */
  advantage: boolean;
  /** 是否使用劣势 */
  disadvantage: boolean;
  /** 闪避是否被无效 */
  dodgeNegated: boolean;
  dodgeNegatedReason?: string;
  /** 命中加值 */
  hitBonus: number;
  /** 有效闪避 (被无效则为 0) */
  effectiveDodge: number;
  /** 检定总值 */
  checkValue: number;
  /** 命中评级 */
  rating: HitRating;
}

/**
 * 执行攻击检定 (对齐世界书):
 *   - 层级优势/劣势: 高T对低T → 2d20取高; 低T对高T → 2d20取低; 同T → 1d20
 *   - 闪避无效: 攻方T > 守方T+1 → dodge=0; 失能目标 → dodge=0
 *   - 检定总值 = d20 + 命中 - 闪避
 */
export function performAttackCheck(input: AttackCheckInput): AttackCheckResult {
  const { attackerTier, defenderTier, hitBonus, defenderDodge, dodgeNegated } = input;

  let diceRolls: number[];
  let diceUsed: number;
  let advantage = false;
  let disadvantage = false;

  // 层级比较决定优劣势
  if (attackerTier > defenderTier) {
    // 高T对低T → 优势 (2d20取高)
    const r1 = input.d20Roll;
    const r2 = Math.max(1, Math.min(20, r1 + Math.floor(Math.random() * 6 - 3))); // simulated second roll
    diceRolls = [r1, r2];
    diceUsed = Math.max(r1, r2);
    advantage = true;
  } else if (attackerTier < defenderTier) {
    // 低T对高T → 劣势 (2d20取低)
    const r1 = input.d20Roll;
    const r2 = Math.max(1, Math.min(20, r1 + Math.floor(Math.random() * 6 - 3))); // simulated second roll
    diceRolls = [r1, r2];
    diceUsed = Math.min(r1, r2);
    disadvantage = true;
  } else {
    // 同层级 → 1d20
    diceRolls = [input.d20Roll];
    diceUsed = input.d20Roll;
  }

  // 闪避判定
  let effectiveDodge = defenderDodge;
  let dodgeNegatedReason: string | undefined;

  if (dodgeNegated) {
    effectiveDodge = 0;
    dodgeNegatedReason = '闪避已被无效';
  } else if (attackerTier > defenderTier + 1) {
    effectiveDodge = 0;
    dodgeNegatedReason = `攻方层级(T${attackerTier}) > 守方层级(T${defenderTier})+1 → 闪避无效`;
  }

  // 检定总值
  const checkValue = diceUsed + hitBonus - effectiveDodge;

  // 命中评级
  const rating = getHitRating(checkValue);

  return {
    diceUsed,
    diceRolls,
    advantage,
    disadvantage,
    dodgeNegated: effectiveDodge === 0,
    dodgeNegatedReason,
    hitBonus,
    effectiveDodge,
    checkValue,
    rating,
  };
}

// ========== 集群攻击次数 ==========

/**
 * 集群攻击次数 (对齐世界书):
 *   HP ≥ 80% → 3次
 *   HP ≥ 50% → 2次
 *   HP ≥ 30% → 1次
 *   HP < 30% → 1次
 */
export function getClusterAttackCount(currentHp: number, maxHp: number): number {
  const hpPercent = maxHp > 0 ? currentHp / maxHp : 0;
  if (hpPercent >= 0.8) return 3;
  if (hpPercent >= 0.5) return 2;
  return 1;
}

// ========== 范围/集群结算 ==========

/** 范围技能对集群: 总伤害 = 修正后单体伤害 × min(范围x, 集群当前数量n) */
export function calcAoEClusterDamage(
  singleTargetDamage: number,
  aoeRange: number,
  clusterCount: number,
): number {
  return singleTargetDamage * Math.min(aoeRange, clusterCount);
}

// ========== 状态触发判定 ==========

/**
 * 状态施加判定 (对齐世界书):
 *   任意暴击(≥20) → 必触发
 *   有效/勉强 → (攻方属性+d20) vs (守方属性+d20) 对抗检定
 *   擦伤/失手 → 不触发
 *   控制类状态 → 守方对抗检定额外+5
 */
export function checkStatusTrigger(
  ratingCoefficient: number,
  attackerStat: number,
  defenderStat: number,
  attackerD20: number,
  defenderD20: number,
  isControlEffect: boolean,
): { triggered: boolean; narrative: string } {
  // 暴击(≥1.3) → 必触发
  if (ratingCoefficient >= 1.3) {
    return { triggered: true, narrative: `暴击(系数${ratingCoefficient}) → 状态效果必触发` };
  }

  // 擦伤(0.3) / 失手(0) → 不触发
  if (ratingCoefficient <= 0.3) {
    return { triggered: false, narrative: `擦伤/失手(系数${ratingCoefficient}) → 状态效果不触发` };
  }

  // 有效(1.0) / 勉强(0.8) → 对抗检定
  const controlBonus = isControlEffect ? 5 : 0;
  const attackerCheck = attackerStat + attackerD20;
  const defenderCheck = defenderStat + defenderD20 + controlBonus;

  const triggered = attackerCheck >= defenderCheck;

  return {
    triggered,
    narrative: triggered
      ? `对抗检定成功 (${attackerCheck} ≥ ${defenderCheck}${controlBonus > 0 ? ` [+${controlBonus}控制加固]` : ''}) → 状态触发`
      : `对抗检定失败 (${attackerCheck} < ${defenderCheck}${controlBonus > 0 ? ` [+${controlBonus}控制加固]` : ''}) → 状态未触发`,
  };
}
