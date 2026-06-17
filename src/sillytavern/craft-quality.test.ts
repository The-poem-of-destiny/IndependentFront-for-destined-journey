/**
 * craft-quality.test.ts — 制作品质链测试
 * 测试: 品质继承 / 阶段校验 / DC修正生成 / 管制物 / 资源检查
 */

import { describe, it, expect } from 'vitest';
import type { CraftMaterial, QualityLevel, CraftIndustry } from './types';
import {
  inheritQuality,
  checkQualityRequirement,
  validateCrafterTierForQuality,
  validateCraftStage,
  generateDCModifier,
  assignMaterialDCModifiers,
  checkRegulatedMaterials,
  checkRegulatedLicenses,
  checkResourceSufficiency,
  compareQuality,
  degradeQuality,
  upgradeQuality,
  determineBatchMode,
  getIndustryAttribute,
  validateIndustryCompatibility,
} from './craft-quality';

// ========== Helpers ==========

function mat(name: string, quality: QualityLevel, qty = 1, regulated = false, licensed = false): CraftMaterial {
  return {
    itemId: `id_${name}`,
    itemName: name,
    quantity: qty,
    quality,
    dcModifier: 0,
    isRegulated: regulated,
    hasLicense: licensed,
  };
}

// ========== Quality Inheritance ==========

describe('inheritQuality', () => {
  it('应保持目标品质当有2种同品质投入物', () => {
    const materials = [mat('铁锭', '稀有'), mat('钢材', '稀有')];
    const result = inheritQuality(materials, '稀有');
    expect(result.quality).toBe('稀有');
    expect(result.downgraded).toBe(false);
  });

  it('应在只有1种同品质投入物时降级', () => {
    // 1稀有+1优良 → 稀有不满足(需2种) → 优良不满足(需2种) → 普通
    const materials = [mat('铁锭', '稀有'), mat('钢材', '优良')];
    const result = inheritQuality(materials, '稀有');
    expect(result.quality).toBe('普通');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toBeDefined();
  });

  it('应逐级降级直到找到满足的品质', () => {
    const materials = [mat('铁锭', '稀有'), mat('钢材', '普通')];
    const result = inheritQuality(materials, '稀有');
    expect(result.downgraded).toBe(true);
  });

  it('应降级为普通当无任何品质满足', () => {
    const materials = [mat('石头', '优良'), mat('木头', '稀有')];
    const result = inheritQuality(materials, '传说');
    expect(result.quality).toBe('普通');
    expect(result.downgraded).toBe(true);
  });

  it('唯一品质应自动降级为神话', () => {
    const materials = [mat('神铁', '神话'), mat('天钢', '神话')];
    const result = inheritQuality(materials, '唯一');
    expect(result.quality).toBe('神话');
    expect(result.downgraded).toBe(true);
    expect(result.reason).toContain('唯一');
  });

  it('3种同品质应满足要求', () => {
    const materials = [mat('A', '史诗'), mat('B', '史诗'), mat('C', '史诗')];
    const result = inheritQuality(materials, '史诗');
    expect(result.quality).toBe('史诗');
    expect(result.downgraded).toBe(false);
  });

  it('高品质可带低品质不影响', () => {
    const materials = [mat('A', '史诗'), mat('B', '史诗'), mat('C', '稀有'), mat('D', '优良')];
    const result = inheritQuality(materials, '史诗');
    expect(result.quality).toBe('史诗');
    expect(result.downgraded).toBe(false);
  });
});

// ========== Quality Requirement Check ==========

describe('checkQualityRequirement', () => {
  it('应通过当满足品质要求', () => {
    const materials = [mat('A', '稀有'), mat('B', '稀有')];
    const result = checkQualityRequirement(materials, '稀有');
    expect(result.passed).toBe(true);
  });

  it('应不通过当不满足品质要求', () => {
    const materials = [mat('A', '稀有'), mat('B', '优良')];
    const result = checkQualityRequirement(materials, '稀有');
    expect(result.passed).toBe(false);
    expect(result.downgradeReason).toBeDefined();
  });
});

// ========== Tier Validation ==========

describe('validateCrafterTierForQuality', () => {
  it('T5应能生产神话', () => {
    const result = validateCrafterTierForQuality(5, '神话');
    expect(result.valid).toBe(true);
  });

  it('T1不能生产稀有', () => {
    const result = validateCrafterTierForQuality(1, '稀有');
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('T1');
  });

  it('T3应能生产史诗', () => {
    const result = validateCrafterTierForQuality(3, '史诗');
    expect(result.valid).toBe(true);
  });

  it('T3不能生产传说', () => {
    const result = validateCrafterTierForQuality(3, '传说');
    expect(result.valid).toBe(false);
  });

  it('T7应能生产唯一', () => {
    const result = validateCrafterTierForQuality(7, '唯一');
    expect(result.valid).toBe(true);
  });
});

// ========== Stage Validation ==========

describe('validateCraftStage', () => {
  it('基础加工始终有效', () => {
    const result = validateCraftStage('基础加工', 1, '神话', false);
    expect(result.valid).toBe(true);
  });

  it('成品无图纸时应无效', () => {
    const result = validateCraftStage('成品', 3, '稀有', false);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('图纸');
  });

  it('成品有图纸应有效', () => {
    const result = validateCraftStage('成品', 3, '稀有', true);
    expect(result.valid).toBe(true);
  });

  it('半成品无需图纸', () => {
    const result = validateCraftStage('半成品', 3, '稀有', false);
    expect(result.valid).toBe(true);
  });

  it('T1成品稀有应无效(层级不够)', () => {
    const result = validateCraftStage('成品', 1, '稀有', true);
    expect(result.valid).toBe(false);
  });
});

// ========== DC Modifier Generation ==========

describe('generateDCModifier', () => {
  it('普通品质应为0', () => {
    const result = generateDCModifier('普通');
    expect(result).toBe(0);
  });

  it('优良品质应在[1,2]范围内', () => {
    for (let i = 0; i < 20; i++) {
      const result = generateDCModifier('优良');
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(2);
    }
  });

  it('稀有品质应在[3,5]范围内', () => {
    for (let i = 0; i < 20; i++) {
      const result = generateDCModifier('稀有');
      expect(result).toBeGreaterThanOrEqual(3);
      expect(result).toBeLessThanOrEqual(5);
    }
  });

  it('神话品质应在[16,25]范围内', () => {
    for (let i = 0; i < 20; i++) {
      const result = generateDCModifier('神话');
      expect(result).toBeGreaterThanOrEqual(16);
      expect(result).toBeLessThanOrEqual(25);
    }
  });

  it('使用种子时应产生确定性结果 (seed=0 → min)', () => {
    const result = generateDCModifier('优良', 0);
    expect(result).toBe(1); // min
  });

  it('使用种子时应产生确定性结果 (seed=1 → max)', () => {
    const result = generateDCModifier('优良', 0.999);
    expect(result).toBe(2); // max
  });
});

// ========== Assign Material DC Modifiers ==========

describe('assignMaterialDCModifiers', () => {
  it('应为普通材料分配DC=0保持不变', () => {
    const materials = [mat('石头', '普通'), mat('木头', '普通')];
    const result = assignMaterialDCModifiers(materials);
    expect(result[0].dcModifier).toBe(0);
    expect(result[1].dcModifier).toBe(0);
  });

  it('已有DC修正的材料保持不变', () => {
    const materials = [mat('铁锭', '稀有')];
    materials[0].dcModifier = 4;
    const result = assignMaterialDCModifiers(materials);
    expect(result[0].dcModifier).toBe(4);
  });
});

// ========== Regulated Materials ==========

describe('checkRegulatedMaterials', () => {
  it('史诗品质为管制物', () => {
    const materials = [mat('奥金', '史诗')];
    const result = checkRegulatedMaterials(materials);
    expect(result.hasRegulated).toBe(true);
    expect(result.regulatedMaterials).toHaveLength(1);
  });

  it('稀有品质非管制物', () => {
    const materials = [mat('钢材', '稀有')];
    const result = checkRegulatedMaterials(materials);
    expect(result.hasRegulated).toBe(false);
  });

  it('标记 isRegulated=true 也视为管制', () => {
    const materials = [mat('特殊材料', '稀有', 1, true)];
    const result = checkRegulatedMaterials(materials);
    expect(result.hasRegulated).toBe(true);
  });
});

describe('checkRegulatedLicenses', () => {
  it('无管制物应通过', () => {
    const materials = [mat('A', '优良'), mat('B', '普通')];
    const result = checkRegulatedLicenses(materials);
    expect(result.passed).toBe(true);
  });

  it('管制物无许可应不通过', () => {
    const materials = [mat('奥金', '史诗', 1, true, false)];
    const result = checkRegulatedLicenses(materials);
    expect(result.passed).toBe(false);
    expect(result.missingLicenses).toContain('奥金');
  });

  it('管制物有许可应通过', () => {
    const materials = [mat('奥金', '史诗', 1, true, true)];
    const result = checkRegulatedLicenses(materials);
    expect(result.passed).toBe(true);
  });
});

// ========== Resource Check ==========

describe('checkResourceSufficiency', () => {
  it('资源充足应通过', () => {
    const result = checkResourceSufficiency(
      { hp: 100, mp: 50, sp: 30 },
      { hp: 10, mp: 5, sp: 3 },
    );
    expect(result.sufficient).toBe(true);
    expect(result.shortage).toHaveLength(0);
  });

  it('HP不足应报告', () => {
    const result = checkResourceSufficiency(
      { hp: 5, mp: 50, sp: 30 },
      { hp: 10, mp: 5, sp: 3 },
    );
    expect(result.sufficient).toBe(false);
    expect(result.shortage.some(s => s.includes('HP'))).toBe(true);
  });

  it('多种资源不足应全部报告', () => {
    const result = checkResourceSufficiency(
      { hp: 0, mp: 0, sp: 30 },
      { hp: 10, mp: 5, sp: 3 },
    );
    expect(result.sufficient).toBe(false);
    expect(result.shortage.length).toBeGreaterThanOrEqual(2);
  });
});

// ========== Quality Comparison ==========

describe('compareQuality', () => {
  it('普通 < 优良', () => {
    expect(compareQuality('普通', '优良')).toBe(-1);
  });
  it('神话 > 传说', () => {
    expect(compareQuality('神话', '传说')).toBe(1);
  });
  it('史诗 === 史诗', () => {
    expect(compareQuality('史诗', '史诗')).toBe(0);
  });
});

describe('degradeQuality', () => {
  it('神话→传说', () => expect(degradeQuality('神话')).toBe('传说'));
  it('稀有→优良', () => expect(degradeQuality('稀有')).toBe('优良'));
  it('普通→普通', () => expect(degradeQuality('普通')).toBe('普通'));
});

describe('upgradeQuality', () => {
  it('传说→神话', () => expect(upgradeQuality('传说')).toBe('神话'));
  it('神话→神话 (封顶)', () => expect(upgradeQuality('神话')).toBe('神话'));
  it('普通→优良', () => expect(upgradeQuality('普通')).toBe('优良'));
});

// ========== Batch Mode ==========

describe('determineBatchMode', () => {
  it('数量=1应强制单件', () => {
    const result = determineBatchMode('成品', 1, true);
    expect(result.forcedSingle).toBe(true);
    expect(result.effectiveQuantity).toBe(1);
  });

  it('基础加工数量>1应可批量(无需图纸)', () => {
    const result = determineBatchMode('基础加工', 10, false);
    expect(result.forcedSingle).toBe(false);
    expect(result.effectiveQuantity).toBe(10);
  });

  it('半成品数量>1应可批量(无需图纸)', () => {
    const result = determineBatchMode('半成品', 5, false);
    expect(result.forcedSingle).toBe(false);
    expect(result.effectiveQuantity).toBe(5);
  });

  it('成品无图纸数量>1应强制单件', () => {
    const result = determineBatchMode('成品', 5, false);
    expect(result.forcedSingle).toBe(true);
    expect(result.reason).toContain('图纸');
    expect(result.effectiveQuantity).toBe(1);
  });

  it('成品有图纸数量>1应可批量', () => {
    const result = determineBatchMode('成品', 5, true);
    expect(result.forcedSingle).toBe(false);
    expect(result.effectiveQuantity).toBe(5);
  });
});

// ========== Industry Helpers ==========

describe('getIndustryAttribute', () => {
  it('锻造→力量', () => expect(getIndustryAttribute('锻造')).toBe('力量'));
  it('炼金→智力', () => expect(getIndustryAttribute('炼金')).toBe('智力'));
  it('烹饪→精神', () => expect(getIndustryAttribute('烹饪')).toBe('精神'));
  it('裁缝→敏捷', () => expect(getIndustryAttribute('裁缝')).toBe('敏捷'));
});

describe('validateIndustryCompatibility', () => {
  it('锻造+剑应兼容', () => {
    const result = validateIndustryCompatibility('锻造', '铁剑');
    expect(result.compatible).toBe(true);
  });

  it('炼金+药水应兼容', () => {
    const result = validateIndustryCompatibility('炼金', '治疗药水');
    expect(result.compatible).toBe(true);
  });

  it('烹饪+料理应兼容', () => {
    const result = validateIndustryCompatibility('烹饪', '烤肉料理');
    expect(result.compatible).toBe(true);
  });

  it('裁缝+布甲应兼容', () => {
    const result = validateIndustryCompatibility('裁缝', '皮甲');
    expect(result.compatible).toBe(true);
  });

  it('锻造+药水应不兼容', () => {
    const result = validateIndustryCompatibility('锻造', '治疗药水');
    expect(result.compatible).toBe(false);
  });
});
