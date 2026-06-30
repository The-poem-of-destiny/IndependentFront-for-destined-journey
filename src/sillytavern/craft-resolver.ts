/**
 * 制作解析器 — Layer 3 流程级 ($craft namespace, AI 可见)
 *
 * 职责: 整合品质链→DC计算→骰检→结算→StatePatch 完整制作管线。
 * 对齐世界书 #683615 [生产制作协议]。
 *
 * 三阶段管线:
 *   Phase 1: 生产准备 (批量/管制/品质/资源)
 *   Phase 2: 制作检定 (DC/骰池/评级)
 *   Phase 3: 结算 (损耗/品质/精益求精/EXP/FP)
 *
 * $craft API (AI 可见):
 *   $craft.startProject()  — 执行完整制作项目
 *   $craft.check()         — 仅执行检定
 *   $craft.getBaseDC()     — 查询品质基准 DC
 *   $craft.getExpTable()   — 查询品质经验表
 *   $craft.validate()      — 验证制作可行性
 */

import type {
  QualityLevel,
  CraftIndustry,
  CraftStage,
  CraftRating,
  CraftMaterial,
  CraftActionRequest,
  CraftActionResult,
  CraftPrepResult,
  CraftCheckResult,
  CraftSettleResult,
  CraftCheckBreakdown,
  CraftSettlementBreakdown,
  CraftProduct,
  StatePatch,
  EffectDefinition,
  CraftProductionBonus,
} from './types';
import {
  CRAFT_DC_BASE,
  CRAFT_PRODUCTION_BONUSES,
  CRAFT_QUALITY_EXP,
  QUALITY_RANK,
  CRAFT_RATING_VALUE_RANGE,
  CRAFT_INDUSTRY_ATTRIBUTE,
} from './types';

import {
  inheritQuality,
  checkQualityRequirement,
  validateCrafterTierForQuality,
  validateCraftStage,
  generateDCModifier,
  assignMaterialDCModifiers,
  checkRegulatedLicenses,
  checkResourceSufficiency,
  determineBatchMode,
} from './craft-quality';

import {
  determineAdvantage,
  rollCraftDice,
  calcFinalDC,
  calcCraftCheck,
  getProductionBonus,
  calcExpReward,
  calcFPReward,
  calcResourceCost,
  buildSettlementBreakdown,
  checkMaterialSave,
  checkQualityUpgrade,
  calcTimeReduction,
} from './craft-dc';

// ========== Phase 1: 生产准备 ==========

/**
 * 执行制作准备阶段
 * 检查: 批量模式 / 管制物许可 / 品质要求 / 资源
 */
export function resolvePreparation(
  request: CraftActionRequest,
): CraftPrepResult {
  const { stage, materials, targetQuality, quantity, hasRecipe, currentResources, resourceCosts } = request;

  // 1. 确定单件/批量模式
  const batchMode = determineBatchMode(stage, quantity, hasRecipe ?? false);

  // 2. 管制物检查
  const regulatedCheck = checkRegulatedLicenses(materials);

  // 3. 品质要求检查
  const qualityCheck = checkQualityRequirement(materials, targetQuality);

  // 4. 资源预检
  const effectiveQty = batchMode.effectiveQuantity;
  const actualCost = {
    hp: resourceCosts.hp * effectiveQty,
    mp: resourceCosts.mp * effectiveQty,
    sp: resourceCosts.sp * effectiveQty,
  };
  const resourceCheck = checkResourceSufficiency(currentResources, actualCost);

  const canProceed =
    regulatedCheck.passed &&
    qualityCheck.passed &&
    resourceCheck.sufficient;

  let stopReason: string | undefined;
  if (!canProceed) {
    const reasons: string[] = [];
    if (!regulatedCheck.passed) {
      reasons.push(`管制物缺乏许可: ${regulatedCheck.missingLicenses.join('、')}`);
    }
    if (!qualityCheck.passed) {
      reasons.push(qualityCheck.downgradeReason ?? '品质要求不满足');
    }
    if (!resourceCheck.sufficient) {
      reasons.push(`资源不足: ${resourceCheck.shortage.join('; ')}`);
    }
    stopReason = reasons.join(' | ');
  }

  return {
    stage: 'preparation',
    canProceed,
    stopReason,
    batchCount: batchMode.effectiveQuantity,
    forcedSingle: batchMode.forcedSingle,
    forcedSingleReason: batchMode.reason,
    regulatedCheck,
    qualityReqCheck: qualityCheck,
    resourceCheck,
  };
}

// ========== Phase 2: 制作检定 ==========

/**
 * 执行制作检定阶段
 * 骰池: 层级比较决定优势/劣势
 * 公式: 核心属性 + 技能 + 道具 + 身份 + d20
 * 评级: 大失败/失败/成功/精益求精
 */
export function resolveCheck(
  request: CraftActionRequest,
  prepResult: CraftPrepResult,
): CraftCheckResult {
  if (!prepResult.canProceed) {
    return {
      stage: 'check',
      breakdown: {
        baseDC: 0,
        materialDCModifier: 0,
        materialDCDetails: [],
        bonusDCReduction: 0,
        finalDC: 0,
        fixedBonus: 0,
        fixedBonusBreakdown: { attribute: 0, skill: 0, tool: 0, identity: 0 },
        diceUsed: 0,
        advantage: false,
        disadvantage: false,
        diceRolls: [],
        diceValue: 0,
        totalValue: 0,
        rating: '失败',
        perfectionThreshold: 0,
      },
    };
  }

  const breakdown = calcCraftCheck({
    targetQuality: request.targetQuality,
    materials: request.materials,
    crafterTier: request.crafterTier,
    coreAttributeValue: request.coreAttributeValue,
    d20Rolls: request.d20Rolls,
    skillBonus: request.skillBonus,
    toolBonus: request.toolBonus,
    identityBonus: request.identityBonus,
    locationBonus: request.locationBonus,
  });

  return { stage: 'check', breakdown };
}

// ========== Phase 3: 结算 ==========

/**
 * 执行制作结算阶段
 * 计算: 材料损耗 / 品质继承 / 精益求精增益 / EXP / FP / 产出
 */
export function resolveSettlement(
  request: CraftActionRequest,
  prepResult: CraftPrepResult,
  checkResult: CraftCheckResult,
): CraftSettleResult {
  const { materials, targetQuality, stage, crafterTier, crafterLevel } = request;
  const breakdown = checkResult.breakdown;
  const rating = breakdown.rating;

  // 失败/大失败 结算
  if (rating === '大失败' || rating === '失败') {
    const lossRate = rating === '大失败' ? 1.0 : 0.5;
    const bonus = getProductionBonus(targetQuality);
    const effectiveLossRate = bonus.failureProtection < lossRate ? bonus.failureProtection : lossRate;

    return {
      stage: 'settlement',
      breakdown: {
        materialLoss: {
          lossRate: effectiveLossRate,
          lostMaterials: materials.map(m => ({
            itemName: m.itemName,
            quantity: Math.ceil(m.quantity * effectiveLossRate),
          })).filter(m => m.quantity > 0),
        },
        outputQuality: targetQuality,
        qualityDowngraded: false,
        productDCModifier: 0,
        expReward: { baseExp: 0, tierSuppressed: false, actualExp: 0 },
        fpReward: 0,
        resourceCost: request.resourceCosts,
        resourceSufficient: true,
      },
    };
  }

  // 品质继承 (考虑品质要求检查的降级)
  const qualityResult = inheritQuality(materials, targetQuality);
  const outputQuality = qualityResult.quality;
  const qualityDowngraded = qualityResult.downgraded;

  // 品质提升判定 (神话)
  const upgradeCheck = checkQualityUpgrade(
    outputQuality,
    request.d20QualityUpgrade ?? 10,
  );
  const finalQuality = upgradeCheck.upgraded ? upgradeCheck.newQuality : outputQuality;

  // 精益求精增益
  const isSingle = prepResult.forcedSingle;
  let perfectionBonus: CraftSettlementBreakdown['perfectionBonus'];
  if (rating === '精益求精') {
    if (!isSingle && prepResult.batchCount > 1) {
      perfectionBonus = { batchExtraYield: Math.ceil(prepResult.batchCount * 0.1) };
    } else if (stage === '半成品') {
      perfectionBonus = { dcModifierDowngrade: 2 };
    } else if (stage === '成品') {
      perfectionBonus = { singleExtraAffix: getExtraAffixLabel(finalQuality) };
    }
  }

  // DC 修正 (产出物)
  const productDCModifier = stage === '基础加工'
    ? 0
    : generateDCModifier(finalQuality);

  // 成品数值区间
  let valueRange: { min: number; max: number } | undefined;
  if (stage === '成品') {
    const range = CRAFT_RATING_VALUE_RANGE[rating];
    valueRange = {
      min: Math.floor(range.min * 100),
      max: Math.floor(range.max * 100),
    };
  }

  // 经验 & FP
  const expReward = calcExpReward(stage, finalQuality, rating, crafterTier, crafterLevel);
  const fpReward = calcFPReward(stage, finalQuality, rating);

  // 资源消耗
  const resourceCost = calcResourceCost(
    request.resourceCosts,
    finalQuality,
    prepResult.batchCount,
  );

  // 管制物认证
  let certification: string | undefined;
  if (QUALITY_RANK[finalQuality] >= 3) {
    // 史诗+: 需许可才能加徽记
    const licenseCheck = checkRegulatedLicenses(materials);
    certification = licenseCheck.passed ? `徽记: ${finalQuality}制品` : '不合法';
  }

  const settlement: CraftSettlementBreakdown = {
    materialLoss: { lossRate: 0, lostMaterials: [] },
    outputQuality: finalQuality,
    qualityDowngraded,
    qualityDowngradeReason: qualityDowngraded ? qualityResult.reason : undefined,
    perfectionBonus,
    productDCModifier,
    valueRange,
    certification,
    expReward,
    fpReward,
    resourceCost,
    resourceSufficient: true,
  };

  return { stage: 'settlement', breakdown: settlement };
}

// ========== Main Resolver ==========

/**
 * $craft.startProject() — 执行完整的 3 阶段制作管线
 *
 * 管线:
 *   1. 生产准备 → 批量/许可/品质/资源
 *   2. 制作检定 → DC/骰池/评级
 *   3. 结算 → 损耗/品质/精益求精/EXP/FP
 */
export function resolveCraft(request: CraftActionRequest): CraftActionResult {
  // Phase 1: Preparation
  const prepResult = resolvePreparation(request);

  // Phase 2: Check
  const checkResult = resolveCheck(request, prepResult);

  // Phase 3: Settlement
  const settleResult = resolveSettlement(request, prepResult, checkResult);

  // Assemble
  const rating = checkResult.breakdown.rating;
  const success = rating === '成功' || rating === '精益求精';

  const outputQuality = settleResult.breakdown.outputQuality;

  // Build patches
  const patches: StatePatch[] = [];

  // 材料消耗 — 从背包中扣除（用 remove_item 而非 delta_variable）
  // remove_item 内部逻辑: qty -= amount, quantity ≤ 0 则 splice 删除
  for (const mat of request.materials) {
    patches.push({
      op: 'remove_item',
      target: `characters.${request.characterId}`,
      value: mat.itemId,
      amount: mat.quantity,
    });
  }

  if (settleResult.breakdown.resourceCost) {
    patches.push({
      op: 'delta_hp',
      target: `characters.${request.characterId}`,
      amount: -settleResult.breakdown.resourceCost.hp,
    });
    patches.push({
      op: 'delta_mp',
      target: `characters.${request.characterId}`,
      amount: -settleResult.breakdown.resourceCost.mp,
    });
    patches.push({
      op: 'delta_sp',
      target: `characters.${request.characterId}`,
      amount: -settleResult.breakdown.resourceCost.sp,
    });
  }
  if (settleResult.breakdown.expReward.actualExp > 0) {
    patches.push({
      op: 'delta_variable',
      target: `characters.${request.characterId}.exp`,
      amount: settleResult.breakdown.expReward.actualExp,
    });
  }
  if (settleResult.breakdown.fpReward > 0) {
    patches.push({
      op: 'delta_variable',
      target: 'profile.fp',
      amount: settleResult.breakdown.fpReward,
    });
  }

  // Build panel lines
  const panelLines = buildCraftPanelLines(request, prepResult, checkResult, settleResult);

  // Build description
  const description = buildCraftDescription(
    request.productName,
    outputQuality,
    rating,
    success,
    prepResult,
    settleResult,
  );

  return {
    request,
    success,
    productId: success ? generateProductId() : undefined,
    productName: request.productName,
    productQuantity: success ? prepResult.batchCount + (settleResult.breakdown.perfectionBonus?.batchExtraYield ?? 0) : 0,
    outputQuality,
    prepResult,
    checkResult,
    settleResult,
    xpGained: settleResult.breakdown.expReward.actualExp,
    fpGained: settleResult.breakdown.fpReward,
    effects: [],
    patches,
    panelLines,
    description,
  };
}

// ========== $craft API ==========

export interface CraftAPI {
  startProject: (request: CraftActionRequest) => CraftActionResult;
  check: (request: CraftActionRequest) => CraftCheckResult;
  validate: (request: CraftActionRequest) => { valid: boolean; issues: string[] };
  getBaseDC: (quality: QualityLevel) => number;
  getExpTable: () => Record<QualityLevel, number>;
  getProductionBonus: (quality: QualityLevel) => CraftProductionBonus;
}

/**
 * $craft namespace — AI 可见的制作 API (Layer 3)
 */
export const $craft: CraftAPI = {
  startProject: resolveCraft,

  check: (request: CraftActionRequest): CraftCheckResult => {
    const prepResult = resolvePreparation(request);
    return resolveCheck(request, prepResult);
  },

  validate: (request: CraftActionRequest): { valid: boolean; issues: string[] } => {
    const issues: string[] = [];

    // Stage validation
    const stageCheck = validateCraftStage(
      request.stage,
      request.crafterTier,
      request.targetQuality,
      request.hasRecipe ?? false,
    );
    if (!stageCheck.valid && stageCheck.reason) {
      issues.push(stageCheck.reason);
    }

    // Tier validation
    const tierCheck = validateCrafterTierForQuality(request.crafterTier, request.targetQuality);
    if (!tierCheck.valid && tierCheck.reason) {
      issues.push(tierCheck.reason);
    }

    // Quality requirement
    const qualityCheck = checkQualityRequirement(request.materials, request.targetQuality);
    if (!qualityCheck.passed && qualityCheck.downgradeReason) {
      issues.push(qualityCheck.downgradeReason);
    }

    // Resource check
    const resourceCheck = checkResourceSufficiency(request.currentResources, request.resourceCosts);
    if (!resourceCheck.sufficient) {
      issues.push(`资源不足: ${resourceCheck.shortage.join(', ')}`);
    }

    // License check
    const licenseCheck = checkRegulatedLicenses(request.materials);
    if (!licenseCheck.passed) {
      issues.push(`管制物缺乏许可: ${licenseCheck.missingLicenses.join('、')}`);
    }

    return { valid: issues.length === 0, issues };
  },

  getBaseDC: (quality: QualityLevel): number => {
    return CRAFT_DC_BASE[quality];
  },

  getExpTable: (): Record<QualityLevel, number> => {
    return { ...CRAFT_QUALITY_EXP };
  },

  getProductionBonus,
};

// ========== Panel Line Generation ==========

/**
 * 生成三级面板行 (对齐世界书 <action_info> 模板)
 */
function buildCraftPanelLines(
  request: CraftActionRequest,
  prep: CraftPrepResult,
  check: CraftCheckResult,
  settle: CraftSettleResult,
): string[] {
  const lines: string[] = [];

  // Phase 1: 生产准备
  lines.push('{生产准备}');
  lines.push(`| 目标: ${request.productName} | 数量: ${prep.batchCount} | 类型: ${request.stage} | 品质: ${request.targetQuality} |`);
  lines.push(`| 行业: ${request.industry} | 核心属性: ${CRAFT_INDUSTRY_ATTRIBUTE[request.industry]} |`);
  lines.push(`| 管制投入物检查: ${prep.regulatedCheck.passed ? '不涉及/有许可' : `涉及-无许可(${prep.regulatedCheck.missingLicenses.join(',')})`} |`);
  lines.push(`| 品质要求检查: ${prep.qualityReqCheck.passed ? '满足' : `不满足(${prep.qualityReqCheck.downgradeReason})`} |`);
  lines.push(`| 资源预检: HP[${request.currentResources.hp}/${request.resourceCosts.hp * prep.batchCount}] MP[${request.currentResources.mp}/${request.resourceCosts.mp * prep.batchCount}] SP[${request.currentResources.sp}/${request.resourceCosts.sp * prep.batchCount}] | 状态: ${prep.resourceCheck.sufficient ? '充足' : '不足(终止)'} |`);
  lines.push(`| 批量检查: ${request.stage === '成品' && !request.hasRecipe ? '成品-图纸(未持有)->强制单件' : '允许批量'} |`);
  const matStr = request.materials.map(m => `${m.itemName} x${m.quantity}`).join(', ');
  lines.push(`| 投入物: ${matStr} |`);

  // Phase 2: 制作检定
  if (prep.canProceed) {
    const bd = check.breakdown;
    lines.push('{制作检定}');
    lines.push(`| 类型: ${request.stage} | 数量: ${prep.batchCount} |`);
    const dcDetail = `${bd.baseDC} + [材料 DC ${bd.materialDCModifier}] - [减免 ${bd.bonusDCReduction}] = ${bd.finalDC}`;
    lines.push(`| 基础DC: ${dcDetail} |`);
    lines.push(`| 检定加值: 属性[${bd.fixedBonusBreakdown.attribute}] + 技能[${bd.fixedBonusBreakdown.skill}] + 道具[${bd.fixedBonusBreakdown.tool}] + 身份[${bd.fixedBonusBreakdown.identity}] = 固定加值 [${bd.fixedBonus}] |`);
    const advStr = bd.advantage ? `优势:d20(${bd.diceRolls.join(',')})→取值${bd.diceValue}` :
      bd.disadvantage ? `劣势:d20(${bd.diceRolls.join(',')})→取值${bd.diceValue}` :
        `正常:d20(${bd.diceValue})`;
    lines.push(`| 掷骰: ${advStr} |`);
    lines.push(`| 判定公式: ${bd.fixedBonus} + ${bd.diceValue} = ${bd.totalValue} vs DC ${bd.finalDC} |`);
    lines.push(`| 检定结果: ${bd.rating} |`);
    lines.push(`| 资源消耗: HP[${settle.breakdown.resourceCost.hp}] MP[${settle.breakdown.resourceCost.mp}] SP[${settle.breakdown.resourceCost.sp}] |`);
  } else {
    lines.push('{制作检定}');
    lines.push(`| 状态: [终止] ${prep.stopReason} |`);
  }

  // Phase 3: 结算
  const sb = settle.breakdown;
  lines.push('{生产结算}');
  lines.push(`| 类型: ${request.stage} |`);

  if (request.stage === '基础加工' && check.breakdown.rating !== '大失败') {
    lines.push('| 状态: 基础加工完成，无损耗 |');
  } else if (sb.materialLoss.lossRate > 0) {
    lines.push(`| 状态: [制作${check.breakdown.rating}] | 投入物损耗 ${Math.round(sb.materialLoss.lossRate * 100)}% |`);
    const lossStr = sb.materialLoss.lostMaterials.map(m => `${m.itemName} x${m.quantity}`).join(', ');
    lines.push(`| 损失: ${lossStr} 损毁 |`);
  } else {
    lines.push(`| 状态: [制作成功] | 品质: ${sb.outputQuality}${sb.qualityDowngraded ? ` (降级前: ${request.targetQuality})` : ''} |`);
    if (sb.certification) {
      lines.push(`| 认证: ${sb.certification} |`);
    }
    if (sb.perfectionBonus) {
      if (sb.perfectionBonus.batchExtraYield) {
        lines.push(`| 精益求精: 批量-产量+${sb.perfectionBonus.batchExtraYield} |`);
      } else if (sb.perfectionBonus.singleExtraAffix) {
        lines.push(`| 精益求精: 单件-获得额外词条: ${sb.perfectionBonus.singleExtraAffix} |`);
      } else if (sb.perfectionBonus.dcModifierDowngrade) {
        lines.push(`| 精益求精: 单件-DC修正降级${sb.perfectionBonus.dcModifierDowngrade} |`);
      }
    }
    lines.push(`| 产出列表: ${request.productName}(${sb.outputQuality}, DC修正+${sb.productDCModifier}) x${prep.batchCount} |`);
    if (sb.expReward.actualExp > 0) {
      lines.push(`| 经验依据: ${request.stage} ${sb.outputQuality} -> 基础EXP ${sb.expReward.baseExp} |`);
      lines.push(`| 结算状态: ${sb.expReward.tierSuppressed ? '层级压制归零' : '正常结算'} | 实得EXP: ${sb.expReward.actualExp} |`);
      lines.push(`| 奖励: EXP +${sb.expReward.actualExp} | FP +${sb.fpReward} |`);
    }
  }

  return lines;
}

// ========== Description Builder ==========

function buildCraftDescription(
  productName: string,
  quality: QualityLevel,
  rating: CraftRating,
  success: boolean,
  prep: CraftPrepResult,
  settle: CraftSettleResult,
): string {
  // 准备阶段失败优先于检定失败
  if (!success && !prep.canProceed) {
    return `制作「${productName}」终止: ${prep.stopReason ?? '准备阶段不通过'}。`;
  }
  if (rating === '大失败') {
    return `制作「${productName}」大失败！投入物全部损毁。`;
  }
  if (rating === '失败') {
    return `制作「${productName}」失败，${Math.round(settle.breakdown.materialLoss.lossRate * 100)}% 投入物损耗。`;
  }

  let desc = `成功制作「${productName}」(${quality}品质)`;
  if (settle.breakdown.qualityDowngraded) {
    desc += `，因品质继承降级`;
  }
  if (rating === '精益求精') {
    desc += `，精益求精！`;
  }
  desc += `，获得 ${settle.breakdown.expReward.actualExp} EXP，${settle.breakdown.fpReward} FP。`;
  return desc;
}

// ========== Utilities ==========

let productIdCounter = 0;

function generateProductId(): string {
  productIdCounter++;
  return `craft_${Date.now()}_${productIdCounter}`;
}

/**
 * 按品质获取额外词条标签
 */
function getExtraAffixLabel(quality: QualityLevel): string {
  const affixes: Partial<Record<QualityLevel, string>> = {
    '优良': '精良词条',
    '稀有': '稀有词条',
    '史诗': '史诗词条',
    '传说': '传说词条',
    '神话': '神话词条',
  };
  return affixes[quality] ?? '额外词条';
}

/**
 * 按请求构建默认的 CraftActionRequest
 */
export function createCraftRequest(params: {
  characterId: string;
  industry: CraftIndustry;
  stage: CraftStage;
  productName: string;
  targetQuality: QualityLevel;
  quantity: number;
  materials: CraftMaterial[];
  crafterTier: number;
  crafterLevel: number;
  coreAttributeValue: number;
  resourceCosts: { hp: number; mp: number; sp: number };
  currentResources: { hp: number; mp: number; sp: number };
  recipeId?: string;
  hasRecipe?: boolean;
  toolBonus?: number;
  skillBonus?: number;
  identityBonus?: number;
  locationBonus?: number;
  d20Rolls?: number[];
}): CraftActionRequest {
  return {
    characterId: params.characterId,
    industry: params.industry,
    stage: params.stage,
    productName: params.productName,
    targetQuality: params.targetQuality,
    quantity: params.quantity,
    materials: params.materials,
    crafterTier: params.crafterTier,
    crafterLevel: params.crafterLevel,
    coreAttributeValue: params.coreAttributeValue,
    resourceCosts: params.resourceCosts,
    currentResources: params.currentResources,
    recipeId: params.recipeId,
    hasRecipe: params.hasRecipe ?? (params.stage !== '成品'),
    toolBonus: params.toolBonus,
    skillBonus: params.skillBonus,
    identityBonus: params.identityBonus,
    locationBonus: params.locationBonus,
    d20Rolls: params.d20Rolls ?? [Math.floor(Math.random() * 20) + 1],
    d20MaterialSave: Math.floor(Math.random() * 20) + 1,
    d20QualityUpgrade: Math.floor(Math.random() * 20) + 1,
  };
}
