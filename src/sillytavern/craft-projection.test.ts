/**
 * craft-projection.test.ts — 制作投影（Q-21 刀四）
 *
 * 这两个函数在 `craft-resolver.ts` 里时是模块私有的，只能经 `resolveCraft`
 * 间接断言。搬出来之后可以直接喂四个结果对象 —— 于是能覆盖到
 * 「准备阶段终止」「大失败」「精益求精三种形态」这些整条管线不好摆出来的分支。
 *
 * 投影层不允许出现计算：每条断言里的数字都应该能在入参里指着找到。
 */

import { describe, it, expect } from 'vitest';
import type { CraftActionRequest, CraftMaterial, QualityLevel } from './types';
import { resolvePreparation, resolveCheck, resolveSettlement } from './craft-resolver';
import { buildCraftPanelLines, buildCraftDescription } from './craft-projection';

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

function makeRequest(overrides: Partial<CraftActionRequest> = {}): CraftActionRequest {
  return {
    characterId: '铁砧',
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
    d20MaterialSave: 10,
    d20QualityUpgrade: 10,
    ...overrides,
  };
}

/** 跑完三阶段，把四个结果对象一起交给投影 */
function project(overrides: Partial<CraftActionRequest> = {}) {
  const request = makeRequest(overrides);
  const prep = resolvePreparation(request);
  const check = resolveCheck(request, prep);
  const settle = resolveSettlement(request, prep, check);
  return {
    request,
    prep,
    check,
    settle,
    lines: buildCraftPanelLines(request, prep, check, settle),
    description: buildCraftDescription(request, prep, check, settle),
  };
}

// ========== buildCraftPanelLines ==========

describe('buildCraftPanelLines', () => {
  it('三节标题按 准备 → 检定 → 结算 的顺序出现', () => {
    const { lines } = project({ d20Rolls: [16] });
    expect(lines.indexOf('{生产准备}')).toBe(0);
    expect(lines.indexOf('{制作检定}')).toBeGreaterThan(0);
    expect(lines.indexOf('{生产结算}')).toBeGreaterThan(lines.indexOf('{制作检定}'));
  });

  it('检定节的数字全部来自 breakdown（不重算）', () => {
    const { lines, check } = project({ d20Rolls: [16] });
    const bd = check.breakdown;
    const text = lines.join('\n');
    expect(text).toContain(`= ${bd.finalDC} |`);
    expect(text).toContain(`固定加值 [${bd.fixedBonus}]`);
    expect(text).toContain(
      `${bd.fixedBonus} + ${bd.diceValue} = ${bd.totalValue} vs DC ${bd.finalDC}`,
    );
    expect(text).toContain(`| 检定结果: ${bd.rating} |`);
  });

  it('正常骰写「正常:d20(值)」；优势写取值来源', () => {
    // 优良 对应 T1 —— 制作者也 T1 才是齐平（默认 fixture 的 T2 已经是优势了）
    const normal = project({ crafterTier: 1, d20Rolls: [16] });
    expect(normal.check.breakdown.advantage).toBe(false);
    expect(normal.check.breakdown.disadvantage).toBe(false);
    expect(normal.lines.join('\n')).toContain(`正常:d20(${normal.check.breakdown.diceValue})`);

    // T3 制作普通品质（对应 T1）→ 优势，2 颗取高
    const adv = project({ crafterTier: 3, targetQuality: '普通', d20Rolls: [4, 17] });
    expect(adv.check.breakdown.advantage).toBe(true);
    expect(adv.lines.join('\n')).toContain('优势:d20(4,17)→取值17');
  });

  it('准备阶段终止 → 检定节只留一行终止原因', () => {
    const { lines, prep } = project({ currentResources: { hp: 0, mp: 0, sp: 0 } });
    expect(prep.canProceed).toBe(false);
    const i = lines.indexOf('{制作检定}');
    expect(lines[i + 1]).toBe(`| 状态: [终止] ${prep.stopReason} |`);
    // 终止时不应该冒出检定加值/判定公式那几行
    expect(lines.join('\n')).not.toContain('判定公式');
  });

  it('大失败 → 结算节报损耗百分比与损毁清单', () => {
    const { lines, settle } = project({ d20Rolls: [1] });
    const text = lines.join('\n');
    expect(text).toContain('| 状态: [制作大失败] |');
    expect(text).toContain(
      `投入物损耗 ${Math.round(settle.breakdown.materialLoss.lossRate * 100)}%`,
    );
    expect(text).toContain('铁锭 x1, 钢材 x1 损毁');
  });

  it('基础加工成功 → 走「无损耗」那一行', () => {
    const { lines } = project({ stage: '基础加工', d20Rolls: [16] });
    expect(lines.join('\n')).toContain('| 状态: 基础加工完成，无损耗 |');
  });

  it('成品精益求精 → 报额外词条', () => {
    const { lines, settle } = project({
      d20Rolls: [19],
      coreAttributeValue: 20,
      targetQuality: '普通',
      materials: [mat('铁锭', '普通')],
    });
    expect(settle.breakdown.perfectionBonus?.singleExtraAffix).toBeDefined();
    expect(lines.join('\n')).toContain(
      `| 精益求精: 单件-获得额外词条: ${settle.breakdown.perfectionBonus!.singleExtraAffix} |`,
    );
  });

  it('资源预检行按 batchCount 放大消耗（单件时即原值）', () => {
    const { lines } = project({ d20Rolls: [16] });
    expect(lines.join('\n')).toContain('资源预检: HP[100/0] MP[50/5] SP[30/10]');
  });

  it('成品未持图纸 → 批量检查报强制单件', () => {
    const { lines } = project({ hasRecipe: false, quantity: 5, d20Rolls: [16] });
    expect(lines.join('\n')).toContain('批量检查: 成品-图纸(未持有)->强制单件');
  });
});

// ========== buildCraftDescription ==========

describe('buildCraftDescription', () => {
  it('成功 → 产物名 + 品质 + EXP/FP', () => {
    const { description, settle } = project({ d20Rolls: [16] });
    expect(description).toContain('成功制作「铁剑」(优良品质)');
    expect(description).toContain(`获得 ${settle.breakdown.expReward.actualExp} EXP`);
    expect(description).toContain(`${settle.breakdown.fpReward} FP`);
  });

  it('大失败 → 全损文案，且不带 EXP 尾巴', () => {
    const { description } = project({ d20Rolls: [1] });
    expect(description).toBe('制作「铁剑」大失败！投入物全部损毁。');
  });

  it('失败 → 报损耗比例', () => {
    // 目标史诗（DC 高）+ 低骰 → 失败但非大失败
    const { description, check } = project({
      targetQuality: '史诗',
      materials: [mat('奥金', '史诗', 1, true), mat('秘银', '史诗', 1, true)],
      d20Rolls: [2],
      coreAttributeValue: 1,
    });
    expect(check.breakdown.rating).toBe('失败');
    expect(description).toContain('制作「铁剑」失败');
    expect(description).toContain('% 投入物损耗');
  });

  it('准备阶段终止优先于检定结果', () => {
    const { description, prep } = project({ currentResources: { hp: 0, mp: 0, sp: 0 } });
    expect(description).toBe(`制作「铁剑」终止: ${prep.stopReason}。`);
  });

  it('精益求精追加一句', () => {
    const { description } = project({
      d20Rolls: [19],
      coreAttributeValue: 20,
      targetQuality: '普通',
      materials: [mat('铁锭', '普通')],
    });
    expect(description).toContain('精益求精！');
  });
});
