/**
 * craft-resolver.test.ts — 制作解析器测试
 * 测试: 3阶段管线 / $craft API
 */

import { describe, it, expect } from 'vitest';
import type { CraftMaterial, QualityLevel } from './types';
import {
  resolvePreparation,
  resolveCheck,
  resolveSettlement,
  resolveCraft,
  createCraftRequest,
  $craft,
} from './craft-resolver';

// ========== Helpers ==========

function mat(name: string, quality: QualityLevel, qty = 1, licensed = false): CraftMaterial {
  return {
    itemId: `id_${name}`,
    itemName: name,
    quantity: qty,
    quality,
    dcModifier: 0,
    isRegulated: quality === '史诗' || quality === '传说' || quality === '神话',
    hasLicense: licensed,
  };
}

function makeRequest(overrides: Partial<ReturnType<typeof createCraftRequest>> = {}) {
  return createCraftRequest({
    characterId: 'char_1',
    industry: '锻造',
    stage: '成品',
    productName: '铁剑',
    targetQuality: '优良',
    quantity: 1,
    materials: [mat('铁锭', '优良'), mat('钢材', '优良')],
    crafterTier: 2,
    crafterLevel: 6,
    coreAttributeValue: 12,
    resourceCosts: { hp: 0, mp: 5, sp: 10 },
    currentResources: { hp: 100, mp: 50, sp: 30 },
    hasRecipe: true,
    d20Rolls: [15],
    ...overrides,
  });
}

// ========== Phase 1: Preparation ==========

describe('resolvePreparation', () => {
  it('全部通过时 canProceed=true', () => {
    const req = makeRequest();
    const result = resolvePreparation(req);
    expect(result.canProceed).toBe(true);
    expect(result.stage).toBe('preparation');
  });

  it('资源不足时 canProceed=false', () => {
    const req = makeRequest({
      currentResources: { hp: 0, mp: 0, sp: 0 },
    });
    const result = resolvePreparation(req);
    expect(result.canProceed).toBe(false);
    expect(result.stopReason).toContain('资源不足');
  });

  it('管制物无许可时应阻止', () => {
    const req = makeRequest({
      targetQuality: '史诗',
      materials: [mat('奥金', '史诗', 2), mat('秘银', '史诗', 1)],
    });
    const result = resolvePreparation(req);
    expect(result.canProceed).toBe(false);
    expect(result.stopReason).toContain('缺乏许可');
  });

  it('管制物有许可应通过', () => {
    const req = makeRequest({
      targetQuality: '史诗',
      materials: [mat('奥金', '史诗', 1, true), mat('秘银', '史诗', 1, true)],
    });
    const result = resolvePreparation(req);
    expect(result.regulatedCheck.passed).toBe(true);
  });

  it('品质要求不满足时应阻止', () => {
    const req = makeRequest({
      targetQuality: '稀有',
      materials: [mat('铁锭', '普通'), mat('钢材', '普通')],
    });
    const result = resolvePreparation(req);
    expect(result.canProceed).toBe(false);
  });

  it('批量模式应根据图纸判断', () => {
    const req = makeRequest({ quantity: 5, hasRecipe: false });
    const result = resolvePreparation(req);
    expect(result.forcedSingle).toBe(true);
    expect(result.batchCount).toBe(1);
  });

  it('半成品应始终可批量', () => {
    const req = makeRequest({ stage: '半成品', quantity: 10, hasRecipe: false });
    const result = resolvePreparation(req);
    expect(result.forcedSingle).toBe(false);
    expect(result.batchCount).toBe(10);
  });
});

// ========== Phase 2: Check ==========

describe('resolveCheck', () => {
  it('成功检定应返回评级', () => {
    const req = makeRequest({ d20Rolls: [12] }); // 12 + 12 = 24, DC=8, threshold=28 → 成功
    const prep = resolvePreparation(req);
    const result = resolveCheck(req, prep);
    expect(result.breakdown.rating).toBe('成功');
    expect(result.breakdown.totalValue).toBeGreaterThan(0);
    expect(result.breakdown.finalDC).toBeGreaterThan(0);
  });

  it('d20=1 应为大失败', () => {
    const req = makeRequest({ d20Rolls: [1] });
    const prep = resolvePreparation(req);
    const result = resolveCheck(req, prep);
    expect(result.breakdown.rating).toBe('大失败');
  });

  it('高roll+高属性应为精益求精', () => {
    const req = makeRequest({
      d20Rolls: [19],
      coreAttributeValue: 20,
      targetQuality: '普通', // DC=6, threshold=26
    });
    const prep = resolvePreparation(req);
    const result = resolveCheck(req, prep);
    expect(result.breakdown.rating).toBe('精益求精');
  });

  it('prep不可继续时应返回空结果', () => {
    const req = makeRequest({ currentResources: { hp: 0, mp: 0, sp: 0 } });
    const prep = resolvePreparation(req);
    const result = resolveCheck(req, prep);
    expect(result.breakdown.rating).toBe('失败');
    expect(result.breakdown.finalDC).toBe(0);
  });
});

// ========== Phase 3: Settlement ==========

describe('resolveSettlement', () => {
  it('成功结算应返回产出', () => {
    const req = makeRequest({ d20Rolls: [18] });
    const prep = resolvePreparation(req);
    const check = resolveCheck(req, prep);
    const result = resolveSettlement(req, prep, check);
    expect(result.stage).toBe('settlement');
    expect(result.breakdown.outputQuality).toBe('优良');
    expect(result.breakdown.expReward.actualExp).toBeGreaterThan(0);
  });

  it('大失败应100%损耗', () => {
    const req = makeRequest({ d20Rolls: [1] });
    const prep = resolvePreparation(req);
    const check = resolveCheck(req, prep);
    const result = resolveSettlement(req, prep, check);
    expect(result.breakdown.materialLoss.lossRate).toBeGreaterThan(0);
    expect(result.breakdown.expReward.actualExp).toBe(0);
  });

  it('品质要求不满足时应阻止生产', () => {
    const req = makeRequest({
      targetQuality: '稀有',
      materials: [mat('铁锭', '普通'), mat('钢材', '普通')],
      d20Rolls: [18],
    });
    const prep = resolvePreparation(req);
    // 品质要求不满足 (需2种稀有, 实际0种)
    expect(prep.qualityReqCheck.passed).toBe(false);
    expect(prep.canProceed).toBe(false);
  });

  it('精益求精应有增益', () => {
    const req = makeRequest({
      d20Rolls: [19],
      coreAttributeValue: 20,
      targetQuality: '优良',
    });
    const prep = resolvePreparation(req);
    const check = resolveCheck(req, prep);
    const result = resolveSettlement(req, prep, check);
    expect(result.breakdown.perfectionBonus).toBeDefined();
  });
});

// ========== Full Pipeline ==========

describe('resolveCraft', () => {
  it('成功制作应返回完整结果', () => {
    const req = makeRequest({ d20Rolls: [16] });
    const result = resolveCraft(req);
    expect(result.success).toBe(true);
    expect(result.productName).toBe('铁剑');
    expect(result.outputQuality).toBe('优良');
    expect(result.prepResult).toBeDefined();
    expect(result.checkResult).toBeDefined();
    expect(result.settleResult).toBeDefined();
  });

  it('应生成 patches', () => {
    const req = makeRequest({ d20Rolls: [16] });
    const result = resolveCraft(req);
    expect(result.patches.length).toBeGreaterThan(0);
  });

  it('应生成面板行', () => {
    const req = makeRequest({ d20Rolls: [16] });
    const result = resolveCraft(req);
    expect(result.panelLines.length).toBeGreaterThan(0);
    expect(result.panelLines[0]).toContain('生产准备');
  });

  it('应生成描述', () => {
    const req = makeRequest({ d20Rolls: [16] });
    const result = resolveCraft(req);
    expect(result.description).toContain('铁剑');
    expect(result.description).toContain('优良');
  });

  it('基础加工不应有经验', () => {
    const req = makeRequest({
      stage: '基础加工',
      d20Rolls: [16],
    });
    const result = resolveCraft(req);
    expect(result.xpGained).toBe(0);
    expect(result.fpGained).toBe(0);
  });

  it('半成品经验应为成品的一半', () => {
    const req = makeRequest({
      stage: '半成品',
      d20Rolls: [16],
    });
    const result1 = resolveCraft(req);

    const req2 = makeRequest({
      stage: '成品',
      d20Rolls: [16],
    });
    const result2 = resolveCraft(req2);

    expect(result1.xpGained).toBe(Math.floor(result2.xpGained / 2));
  });

  it('资源不足应终止并生产面板描述', () => {
    const req = makeRequest({
      currentResources: { hp: 0, mp: 0, sp: 0 },
      d20Rolls: [16],
    });
    const result = resolveCraft(req);
    expect(result.success).toBe(false);
    expect(result.description).toContain('终止');
  });

  it('管制物无许可应终止', () => {
    const req = makeRequest({
      targetQuality: '史诗',
      materials: [mat('奥金', '史诗', 1, false), mat('秘银', '史诗', 1, false)],
      d20Rolls: [16],
    });
    const result = resolveCraft(req);
    expect(result.success).toBe(false);
  });

  it('大失败应为failure且有描述', () => {
    const req = makeRequest({ d20Rolls: [1] });
    const result = resolveCraft(req);
    expect(result.success).toBe(false);
    expect(result.description).toContain('大失败');
    expect(result.description).toContain('损毁');
  });

  it('锻造行业制作应正确', () => {
    const req = makeRequest({
      industry: '锻造',
      productName: '精钢长剑',
      d20Rolls: [14],
    });
    const result = resolveCraft(req);
    expect(result.success).toBe(true);
  });

  it('炼金行业制作应正确', () => {
    const req = makeRequest({
      industry: '炼金',
      productName: '治疗药水',
      d20Rolls: [14],
    });
    const result = resolveCraft(req);
    expect(result.success).toBe(true);
  });
});

// ========== $craft API ==========

describe('$craft API', () => {
  it('startProject 应返回 CraftActionResult', () => {
    const req = makeRequest({ d20Rolls: [16] });
    const result = $craft.startProject(req);
    expect(result.success).toBe(true);
  });

  it('check 应返回 CraftCheckResult', () => {
    const req = makeRequest({ d20Rolls: [16] });
    const result = $craft.check(req);
    expect(result.breakdown).toBeDefined();
    expect(result.stage).toBe('check');
  });

  it('validate 对有效请求应返回 valid=true', () => {
    const req = makeRequest();
    const result = $craft.validate(req);
    expect(result.valid).toBe(true);
    expect(result.issues).toHaveLength(0);
  });

  it('validate 对无效请求应列出问题', () => {
    const req = makeRequest({
      targetQuality: '传说',
      crafterTier: 1,
      currentResources: { hp: 0, mp: 0, sp: 0 },
    });
    const result = $craft.validate(req);
    expect(result.valid).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it('getBaseDC 应返回正确 DC', () => {
    expect($craft.getBaseDC('普通')).toBe(6);
    expect($craft.getBaseDC('神话')).toBe(40);
  });

  it('getExpTable 应返回完整经验表', () => {
    const table = $craft.getExpTable();
    expect(table['普通']).toBe(50);
    expect(table['神话']).toBe(6000);
    expect(Object.keys(table)).toHaveLength(7);
  });

  it('getProductionBonus 应返回产能加成', () => {
    const bonus = $craft.getProductionBonus('稀有');
    expect(bonus.dcReduction).toBeDefined();
    expect(bonus.resourceReduction).toBeDefined();
  });
});

// ========== createCraftRequest ==========

describe('createCraftRequest', () => {
  it('应正确填充默认值', () => {
    const req = createCraftRequest({
      characterId: 'char_1',
      industry: '锻造',
      stage: '成品',
      productName: '铁剑',
      targetQuality: '优良',
      quantity: 3,
      materials: [mat('铁锭', '优良')],
      crafterTier: 2,
      crafterLevel: 6,
      coreAttributeValue: 12,
      resourceCosts: { hp: 0, mp: 5, sp: 10 },
      currentResources: { hp: 100, mp: 50, sp: 30 },
    });
    expect(req.hasRecipe).toBe(false); // 成品默认不持有图纸(需显式传入)
    expect(req.d20Rolls).toHaveLength(1);
  });

  it('成品无图纸', () => {
    const req = createCraftRequest({
      characterId: 'char_1',
      industry: '锻造',
      stage: '成品',
      productName: '铁剑',
      targetQuality: '优良',
      quantity: 1,
      materials: [],
      crafterTier: 2,
      crafterLevel: 6,
      coreAttributeValue: 12,
      resourceCosts: { hp: 0, mp: 5, sp: 10 },
      currentResources: { hp: 100, mp: 50, sp: 30 },
      hasRecipe: false,
    });
    expect(req.hasRecipe).toBe(false);
  });
});
