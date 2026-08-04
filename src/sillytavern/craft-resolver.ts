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
  CraftMaterial,
  CraftActionRequest,
  CraftActionResult,
  CraftPrepResult,
  CraftCheckResult,
  CraftSettleResult,
  CraftSettlementBreakdown,
  StatePatch,
  CraftProductionBonus,
} from './types';
import { CRAFT_DC_BASE, CRAFT_QUALITY_EXP, QUALITY_RANK, CRAFT_RATING_VALUE_RANGE } from './types';

import {
  inheritQuality,
  checkQualityRequirement,
  validateCrafterTierForQuality,
  validateCraftStage,
  generateDCModifier,
  checkRegulatedLicenses,
  checkResourceSufficiency,
  determineBatchMode,
} from './craft-quality';

// 🪦 Q-21：这份 import 里曾有 6 个从未在本文件出现过第二次的名字
//    （determineAdvantage / rollCraftDice / calcFinalDC / buildSettlementBreakdown /
//     checkMaterialSave / calcTimeReduction）。它们都还在 craft-dc.ts 里导出着，
//    只是本文件不用 —— 尤其 buildSettlementBreakdown 是 resolveSettlement 的
//    另一份实现（且它会算材料节省，而 resolveSettlement 不算）。留在这里会让人
//    以为结算读过材料节省。删的是 import，不是那些函数。
import {
  calcCraftCheck,
  getProductionBonus,
  calcExpReward,
  calcFPReward,
  calcResourceCost,
  checkQualityUpgrade,
} from './craft-dc';

import { buildCraftPanelLines, buildCraftDescription } from './craft-projection';

// ========== Phase 1: 生产准备 ==========

/**
 * 执行制作准备阶段
 * 检查: 批量模式 / 管制物许可 / 品质要求 / 资源
 */
export function resolvePreparation(request: CraftActionRequest): CraftPrepResult {
  const { stage, materials, targetQuality, quantity, hasRecipe, currentResources, resourceCosts } =
    request;

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

  const canProceed = regulatedCheck.passed && qualityCheck.passed && resourceCheck.sufficient;

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
    const effectiveLossRate =
      bonus.failureProtection < lossRate ? bonus.failureProtection : lossRate;

    return {
      stage: 'settlement',
      breakdown: {
        materialLoss: {
          lossRate: effectiveLossRate,
          lostMaterials: materials
            .map((m) => ({
              itemName: m.itemName,
              quantity: Math.ceil(m.quantity * effectiveLossRate),
            }))
            .filter((m) => m.quantity > 0),
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
  const upgradeCheck = checkQualityUpgrade(outputQuality, request.d20QualityUpgrade ?? 10);
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
  const productDCModifier = stage === '基础加工' ? 0 : generateDCModifier(finalQuality);

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
  const resourceCost = calcResourceCost(request.resourceCosts, finalQuality, prepResult.batchCount);

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

  // 🔒 P1-07: 材料消耗走结算结果（lostMaterials），不再无条件删全量。
  //   成功: 消耗全量（材料变成产物）
  //   大失败: lostMaterials lossRate=1.0 → 同样全量（全损）
  //   失败: 只扣 lostMaterials（lossRate 50%，或受 failureProtection 保护更低），剩余返还玩家
  //   此前无论成败都删 request.materials 全量，导致失败制作亏双倍材料（结算算 50%，实际扣 100%）。
  //   失败保护 failureProtection 形同虚设 —— 现在让结算成为材料消耗的唯一来源。
  const matLoss = settleResult.breakdown.materialLoss;
  const lossByItem = new Map(matLoss.lostMaterials.map((l) => [l.itemName, l.quantity]));
  for (const mat of request.materials) {
    const consumeQty = success ? mat.quantity : (lossByItem.get(mat.itemName) ?? 0);
    if (consumeQty <= 0) continue; // 该材料无损（如失败时受保护），不扣
    patches.push({
      op: 'remove_item',
      target: `characters.${request.characterId}`,
      value: { name: mat.itemName, quantity: consumeQty },
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

  // 投影（craft-projection.ts）—— 两者都是这四个结果对象的纯函数，不参与任何计算
  const panelLines = buildCraftPanelLines(request, prepResult, checkResult, settleResult);
  const description = buildCraftDescription(request, prepResult, checkResult, settleResult);

  return {
    request,
    success,
    productId: success ? generateProductId() : undefined,
    productName: request.productName,
    productQuantity: success
      ? prepResult.batchCount + (settleResult.breakdown.perfectionBonus?.batchExtraYield ?? 0)
      : 0,
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
    优良: '精良词条',
    稀有: '稀有词条',
    史诗: '史诗词条',
    传说: '传说词条',
    神话: '神话词条',
  };
  return affixes[quality] ?? '额外词条';
}

// 🪦 Q-21：这里曾有 export function createCraftRequest(params) —— 生产零调用
//    （只有 craft-resolver.test.ts 用它当 fixture 工厂），内部却拿 Math.random
//    掷三颗骰。两个后果：一是与 combat-v3「随机源在内核外」的确定性约定相悖；
//    二是任何拿它造「传说」请求的测试都在 15% 的概率上会被静默升成神话
//    （d20QualityUpgrade ≥ 18），一个还没绊倒人的定时器。
//    生产装配现在收在 craft-request.ts 的 buildCraftRequest（骰带显式传入）；
//    测试用的 fixture 工厂搬进了 craft-resolver.test.ts 自己家里。
