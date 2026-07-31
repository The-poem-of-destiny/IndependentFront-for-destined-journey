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

import type { DamageType, HitRating, CombatDamageBreakdown } from './types';
import { getHitRating } from './types';
import { getCombatCoefficient } from './tier-constants';

// Re-export for convenience
export { getHitRating } from './types';

/** 🆕 M3: clamp 到 [0, 1]（modifier 累加后兜底，防止穿透/DR 超界） */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** 🐛修复(对抗验证): d20 骰值结构性校验 —— 任何来源(AI 参数/事件脚本)的骰值都 clamp 到 [1,20]，
 *  防止伪造 d20=100 必超暴击 / d20=0 必失手（API 纪律"禁止编造骰值"此前无机制强制） */
function clampD20(v: number): number {
  if (typeof v !== 'number' || Number.isNaN(v)) return 1;
  return Math.min(20, Math.max(1, Math.floor(v)));
}

/** 关联属性推导: 显式指定优先，否则按伤害类型缺省（物理→str / 能量→int / 精神→spi / 真实→str）。
 *  legacy resolveAttack 与管线版共用（避免两版行为分叉）。 */
export function resolveRelevantAttribute(
  explicit: string | undefined,
  damageType: DamageType,
): 'str' | 'dex' | 'con' | 'int' | 'spi' {
  const valid = ['str', 'dex', 'con', 'int', 'spi'];
  if (explicit && valid.includes(explicit)) {
    return explicit as 'str' | 'dex' | 'con' | 'int' | 'spi';
  }
  switch (damageType) {
    case '能量':
      return 'int';
    case '精神':
      return 'spi';
    default:
      return 'str';
  }
}

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
  /** 🆕 M3: 管道版折叠出的 modifier 注入（固伤/百分比/穿透/DR/检定）。缺省=无修正，现有测试不受影响 */
  modifiers?: PipelineModifiers;
}

/** 🆕 M3: 管线修正注入（管道版 collect mods + 登神压制折叠后产出，runDamagePipeline 在对应 step 应用）。
 *
 *  - fixedDamageBonus / damageMultiplier / penetrationRateBonus / drRateBonus 由 runDamagePipeline 消费
 *  - hitBonus / dodgeBonus 由管道版的 performAttackCheck 消费（runDamagePipeline 不处理）
 *
 *  对齐架构 §4.4（modifier 按类分发到管线）+ §十三 决策 c（登神压制率当穿透、削减守方 DR） */
export interface PipelineModifiers {
  /** Step 6a 累加固伤 */
  fixedDamageBonus?: number;
  /** Step 6 额外 ×(1 + this)；增伤正值、减伤负值 */
  damageMultiplier?: number;
  /** Step 3 累加进穿透率（登神压制率当穿透，见 resolveDivinityConflict） */
  penetrationRateBonus?: number;
  /** Step 7 累加进 DR（可负 —— 登神压制削减守方 DR） */
  drRateBonus?: number;
  /** 检定·命中加成（管道版 performAttackCheck 用，runDamagePipeline 不处理） */
  hitBonus?: number;
  /** 检定·闪避加成（管道版用） */
  dodgeBonus?: number;
}

/**
 * 执行完整的 8 步伤害管线。
 * 返回逐步分解的伤害计算结果。
 */
export function runDamagePipeline(input: DamagePipelineInput): CombatDamageBreakdown {
  // 🐛修复(对抗验证): multiHitCount 是 AI 工具入参，负数/0/小数会让 Step 6b 把已 clamp≥0 的
  // 伤害重新变负（实测 -2 段 → finalDamage=-1070 → delta_hp 反向加血）。强制 ≥1 整数。
  const multiHitCount = Math.max(1, Math.floor(input.multiHitCount || 1));

  // Step 1: 初始伤害
  const initial = calcInitialDamage(
    input.relevantAttribute,
    input.attackerTier,
    input.skillPower,
    input.weaponAtk,
  );

  // Step 2: 多段分割
  const multiSplit = applyMultiSplit(initial.damage, multiHitCount);
  const afterSplit = multiSplit.perHitDamage;

  // Step 3: 穿透修正 (M3: + modifier 穿透，含登神压制率)
  const penetration = applyPenetration(
    input.defenderDefense,
    clamp01(input.penetrationRate + (input.modifiers?.penetrationRateBonus ?? 0)),
  );

  // Step 4: 装备减免
  const equipReduction = applyEquipmentReduction(afterSplit, penetration.effectiveDef);

  // Step 5: 类型减免
  const typeReduction = calcDamageTypeReduction(input.damageType, input.defenderAttributes);
  const typeApplied = applyTypeReduction(
    equipReduction.afterReduction,
    typeReduction.reductionRate,
  );

  // Step 6: 评级系数 × 意图系数 (M3: × modifier 乘算)
  let afterRating = applyRatingAndIntention(
    typeApplied.afterReduction,
    input.ratingCoefficient,
    input.intentionCoefficient,
  );
  const damageMultiplier = input.modifiers?.damageMultiplier ?? 0;
  if (damageMultiplier !== 0) {
    // 🐛修复: 减伤 modifier 累加可能 < -100%，(1+m) 需 clamp ≥ 0，否则伤害为负 → delta_hp 变成给目标加血
    afterRating = Math.floor(afterRating * Math.max(0, 1 + damageMultiplier));
  }

  // Step 6a: + 额外固定伤害 (世界书: 武器附魔/品质固伤等 + M3 modifier 固伤)
  // 注: 固伤加在单段上、Step 6b 再 × 攻击次数 —— 对齐架构 §八 (Step 6a 在 6b 之前)。
  // 🐛修复: 固伤可为负(诅咒类)，单段伤害 clamp ≥ 0，防止负伤害经 delta_hp 反向加血
  const fixedBonus = (input.fixedDamageBonus ?? 0) + (input.modifiers?.fixedDamageBonus ?? 0);
  const afterFixed = Math.max(0, afterRating + fixedBonus);

  // Step 6b: × 攻击次数 (世界书: 多段/连击恢复总伤害；使用已消毒的 multiHitCount)
  const afterAttackCount = afterFixed * multiHitCount;

  // Step 7: DR 修正 (M3: + modifier DR，登神压制时为负削减守方 DR)
  const drApplied = applyDR(
    afterAttackCount,
    clamp01(input.drRate + (input.modifiers?.drRateBonus ?? 0)),
  );

  // Step 8: 集群修正 → 最终伤害
  const finalDamage = applyClusterMultiplier(drApplied.afterDR, input.isClusterTarget);

  return {
    initialDamage: initial.damage,
    initialFormula: initial.formula,

    afterMultiSplit: afterSplit,
    multiSplitInfo: multiHitCount > 1 ? { count: multiHitCount, perHit: afterSplit } : undefined,

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
  /**
   * 🐛修复: 第二颗 d20（层级优劣势 2d20 用）。
   * 不提供时内部掷一颗独立均匀 d20（旧实现是 r1±3 的伪骰，优势收益偏低且有偏）。
   * 调用方（管线版）应通过 dice.roll 事件提供，保证确定性。
   */
  d20Roll2?: number;
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

  // 🐛修复: 第二骰必须是独立均匀 d20。旧实现 r2 = r1 + rand(-3..2) 与首骰强相关且期望为负，
  // 优势几乎无收益、劣势失真。优先用调用方传入的 d20Roll2（可走 dice.roll 事件保证确定性）。
  // 🐛修复(对抗验证): 所有骰值 clamp 到 [1,20] —— 外部可控输入不再能伪造 100/0 操纵评级。
  const firstRoll = clampD20(input.d20Roll);
  const secondRoll = (): number => clampD20(input.d20Roll2 ?? Math.floor(Math.random() * 20) + 1);

  // 层级比较决定优劣势
  if (attackerTier > defenderTier) {
    // 高T对低T → 优势 (2d20取高)
    const r1 = firstRoll;
    const r2 = secondRoll();
    diceRolls = [r1, r2];
    diceUsed = Math.max(r1, r2);
    advantage = true;
  } else if (attackerTier < defenderTier) {
    // 低T对高T → 劣势 (2d20取低)
    const r1 = firstRoll;
    const r2 = secondRoll();
    diceRolls = [r1, r2];
    diceUsed = Math.min(r1, r2);
    disadvantage = true;
  } else {
    // 同层级 → 1d20
    diceRolls = [firstRoll];
    diceUsed = firstRoll;
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
    // 🐛修复: 旧实现用 effectiveDodge===0 判断，守方闪避加值本来就是 0 时会误报"闪避被无效"
    dodgeNegated: dodgeNegatedReason !== undefined,
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
