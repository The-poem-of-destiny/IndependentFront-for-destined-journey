/**
 * 制作品质链 — Layer 2 计算级 (AI 可读，不可写)
 *
 * 职责: 品质继承规则 / 阶段校验 / DC 修正生成 / 管制物检测
 * 对齐世界书 #683615 [生产制作协议] + #265160 [品质效果限定]。
 *
 * 品质继承规则 (世界书):
 *   - 至少 2 种同品质投入物才能产出对应品质
 *   - 不满足则产物品质降级
 *   - 高品质可带低品质投入物（不触发降级）
 *
 * 3 级加工:
 *   - 基础加工: 原材料→材料，无检定，无经验
 *   - 半成品: 材料→半成品，经验=成品一半
 *   - 成品: 半成品→最终可用品，需图纸，有经验
 */

import type {
  QualityLevel,
  CraftIndustry,
  CraftStage,
  CraftMaterial,
} from './types';
import {
  QUALITY_RANK,
  QUALITY_BY_RANK,
  CRAFT_DC_MODIFIER_RANGE,
  CRAFT_INDUSTRY_ATTRIBUTE,
} from './types';

// ========== Quality Inheritance ==========

/**
 * 检查品质要求: 至少 2 种同品质投入物才能产出对应品质
 * 返回满足的最高品质级别，若不满足目标品质则降级。
 *
 * @param materials 投入物列表
 * @param targetQuality 目标品质
 * @returns { quality: 实际产出品质, downgraded: 是否降级, reason: 降级原因 }
 */
export function inheritQuality(
  materials: CraftMaterial[],
  targetQuality: QualityLevel,
): { quality: QualityLevel; downgraded: boolean; reason?: string } {
  if (targetQuality === '唯一') {
    return {
      quality: '神话',
      downgraded: true,
      reason: '唯一品质无法生产制作获得，已降级为神话',
    };
  }

  // 统计各品质的材料种类数
  const qualityCount: Partial<Record<QualityLevel, number>> = {};
  for (const m of materials) {
    qualityCount[m.quality] = (qualityCount[m.quality] ?? 0) + 1;
  }

  const targetRank = QUALITY_RANK[targetQuality];

  // 检查目标品质：至少需要 2 种同品质材料
  const targetCount = qualityCount[targetQuality] ?? 0;
  if (targetCount >= 2) {
    return { quality: targetQuality, downgraded: false };
  }

  // 目标品质不满足，逐级降级查找
  for (let rank = targetRank - 1; rank >= 0; rank--) {
    const q = QUALITY_BY_RANK[rank];
    const count = qualityCount[q] ?? 0;
    if (count >= 2) {
      return {
        quality: q,
        downgraded: true,
        reason: `目标品质「${targetQuality}」需要至少 2 种同品质投入物 (当前: ${targetCount})，已降级为「${q}」`,
      };
    }
  }

  // 没有任何品质满足 → 最低品质 (普通)
  return {
    quality: '普通',
    downgraded: targetQuality !== '普通',
    reason: '投入物品品质不足，产出降级为普通',
  };
}

/**
 * 检查是否可以产出目标品质 (不实际降级，仅返回结果)
 */
export function checkQualityRequirement(
  materials: CraftMaterial[],
  targetQuality: QualityLevel,
): { passed: boolean; downgradeReason?: string } {
  const result = inheritQuality(materials, targetQuality);
  if (result.downgraded) {
    return { passed: false, downgradeReason: result.reason };
  }
  return { passed: true };
}

// ========== Stage Validation ==========

/** 层级→可生产品质对照表 (对齐世界书核心数值) */
const TIER_QUALITY_CAP: Record<number, QualityLevel> = {
  1: '优良',
  2: '稀有',
  3: '史诗',
  4: '传说',
  5: '神话',
  6: '神话',
  7: '唯一',
};

/**
 * 验证制作者层级能否生产目标品质
 * @returns { valid, reason }
 */
export function validateCrafterTierForQuality(
  crafterTier: number,
  targetQuality: QualityLevel,
): { valid: boolean; reason?: string } {
  const cap = TIER_QUALITY_CAP[crafterTier] ?? '普通';
  const targetRank = QUALITY_RANK[targetQuality];
  const capRank = QUALITY_RANK[cap];

  if (targetRank > capRank) {
    return {
      valid: false,
      reason: `制作者层级 T${crafterTier} 最高可生产「${cap}」品质，目标「${targetQuality}」超出能力范围`,
    };
  }
  return { valid: true };
}

/**
 * 验证制作阶段的合法性
 */
export function validateCraftStage(
  stage: CraftStage,
  crafterTier: number,
  targetQuality: QualityLevel,
  hasRecipe: boolean,
): { valid: boolean; reason?: string } {
  // 基础加工: 无限制
  if (stage === '基础加工') {
    return { valid: true };
  }

  // 半成品/成品: 检查层级上限
  const tierCheck = validateCrafterTierForQuality(crafterTier, targetQuality);
  if (!tierCheck.valid) {
    return tierCheck;
  }

  // 成品: 需要图纸 (批量模式下)
  if (stage === '成品' && !hasRecipe) {
    return {
      valid: false,
      reason: '成品制作需要图纸，当前未持有图纸，将强制单件制作',
    };
  }

  return { valid: true };
}

// ========== DC Modifier Generation ==========

/**
 * 生成随机 DC 修正值 (在品质范围内)
 * 用于材料/半成品 DC 修正的随机生成
 *
 * @param quality 品质
 * @param seed 可选种子值 (0-1)，用于确定性随机
 * @returns DC 修正值
 */
export function generateDCModifier(quality: QualityLevel, seed?: number): number {
  const range = CRAFT_DC_MODIFIER_RANGE[quality];
  if (!range || range[0] === 0 && range[1] === 0) return 0;

  const [min, max] = range;
  if (seed !== undefined) {
    return min + Math.floor(seed * (max - min + 1));
  }
  return min + Math.floor(Math.random() * (max - min + 1));
}

/**
 * 为一批材料生成 DC 修正
 */
export function assignMaterialDCModifiers(
  materials: CraftMaterial[],
): CraftMaterial[] {
  return materials.map(m => ({
    ...m,
    dcModifier: m.dcModifier !== undefined ? m.dcModifier : generateDCModifier(m.quality),
  }));
}

// ========== Regulated Material Check ==========

/**
 * 检查是否有管制投入物 (史诗+)
 */
export function checkRegulatedMaterials(
  materials: CraftMaterial[],
): { hasRegulated: boolean; regulatedMaterials: CraftMaterial[] } {
  const regulated = materials.filter(m =>
    m.isRegulated === true || QUALITY_RANK[m.quality] >= 3, // 史诗+
  );
  return {
    hasRegulated: regulated.length > 0,
    regulatedMaterials: regulated,
  };
}

/**
 * 检查管制物许可
 */
export function checkRegulatedLicenses(
  materials: CraftMaterial[],
): { passed: boolean; missingLicenses: string[] } {
  const { regulatedMaterials } = checkRegulatedMaterials(materials);
  const missing: string[] = [];

  for (const m of regulatedMaterials) {
    if (!m.hasLicense) {
      missing.push(m.itemName);
    }
  }

  return { passed: missing.length === 0, missingLicenses: missing };
}

// ========== Resource Check ==========

/**
 * 资源预检: 检查 HP/MP/SP 是否充足
 */
export function checkResourceSufficiency(
  current: { hp: number; mp: number; sp: number },
  required: { hp: number; mp: number; sp: number },
): { sufficient: boolean; shortage: string[] } {
  const shortage: string[] = [];
  if (current.hp < required.hp) shortage.push(`HP (当前${current.hp}，需要${required.hp})`);
  if (current.mp < required.mp) shortage.push(`MP (当前${current.mp}，需要${required.mp})`);
  if (current.sp < required.sp) shortage.push(`SP (当前${current.sp}，需要${required.sp})`);
  return { sufficient: shortage.length === 0, shortage };
}

// ========== Quality Comparison ==========

/**
 * 比较两个品质级别
 * @returns -1 (a<b), 0 (相等), 1 (a>b)
 */
export function compareQuality(a: QualityLevel, b: QualityLevel): number {
  const rankA = QUALITY_RANK[a];
  const rankB = QUALITY_RANK[b];
  if (rankA < rankB) return -1;
  if (rankA > rankB) return 1;
  return 0;
}

/**
 * 品质降级一步
 */
export function degradeQuality(quality: QualityLevel): QualityLevel {
  const rank = QUALITY_RANK[quality];
  if (rank <= 0) return '普通';
  return QUALITY_BY_RANK[rank - 1];
}

/**
 * 品质升级一步 (不越过唯一)
 */
export function upgradeQuality(quality: QualityLevel): QualityLevel {
  const rank = QUALITY_RANK[quality];
  if (rank >= QUALITY_BY_RANK.length - 2) return '神话'; // max craftable is 神话
  return QUALITY_BY_RANK[rank + 1];
}

// ========== Batch / Single Mode ==========

/**
 * 确定单件/批量模式
 */
export function determineBatchMode(
  stage: CraftStage,
  quantity: number,
  hasRecipe: boolean,
): { forcedSingle: boolean; reason?: string; effectiveQuantity: number } {
  if (quantity <= 1) {
    return { forcedSingle: true, reason: '数量为1，单件制作', effectiveQuantity: 1 };
  }

  // 基础加工/半成品: 始终可批量
  if (stage === '基础加工' || stage === '半成品') {
    return { forcedSingle: false, effectiveQuantity: quantity };
  }

  // 成品: 需要图纸才能批量
  if (stage === '成品' && !hasRecipe) {
    return {
      forcedSingle: true,
      reason: '成品批量需要图纸，当前未持有图纸，强制单件制作',
      effectiveQuantity: 1,
    };
  }

  return { forcedSingle: false, effectiveQuantity: quantity };
}

// ========== Craft Industry Helpers ==========

/**
 * 获取行业对应的核心属性名
 */
export function getIndustryAttribute(industry: CraftIndustry): string {
  return CRAFT_INDUSTRY_ATTRIBUTE[industry];
}

/**
 * 验证行业与投入物类型的兼容性 (基本检查)
 */
export function validateIndustryCompatibility(
  industry: CraftIndustry,
  productName: string,
): { compatible: boolean; reason?: string } {
  // 基本检查: 锻造→金属/武器/防具, 炼金→药水/药剂, 烹饪→食物/料理, 裁缝→布/皮/时装
  const keywords: Record<CraftIndustry, string[]> = {
    '锻造': ['武器', '剑', '刀', '斧', '锤', '枪', '弓', '盾', '甲', '铠', '盔', '金属', '工具', '锭', '板'],
    '炼金': ['药', '水', '剂', '油', '膏', '炸', '毒', '瓶', '粉', '附魔'],
    '烹饪': ['餐', '食', '肉', '鱼', '菜', '汤', '酒', '饮', '面包', '料', '理', '烤', '煮'],
    '裁缝': ['布', '皮', '衣', '袍', '袋', '包', '帽', '鞋', '靴', '丝', '棉', '毛', '装', '时装', '容器'],
  };

  const kw = keywords[industry] ?? [];
  const match = kw.some(k => productName.includes(k));

  if (!match) {
    return {
      compatible: false,
      reason: `产品名「${productName}」与行业「${industry}」可能不匹配`,
    };
  }
  return { compatible: true };
}
