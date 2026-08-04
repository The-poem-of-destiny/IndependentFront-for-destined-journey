/**
 * image-anlas.test.ts — `estimateAnlasCost` 的边界钉死（D43）
 *
 * 🔴 **这条规则会变，所以这份测试就是它的文档。** NAI 的免费档随时可能调整，届时
 *    改的是 `NAI_ANLAS_RULES` 一处，而**这里的红点就是那次改动的完整影响面**。
 *    因此每条断言都写明依据出自设计文档哪一段 —— 看得见依据，才判得出该改还是该留。
 *
 * 依据: `docs/planning/2026-08-04-image-generation-design.md`
 *   - D43（决策表 §2.1）：设置页按当前参数算「在免费额度内 ✅ / 会消耗 Anlas ⚠️」
 *   - §6 参数表 + §6.3 尾注：`1216×832 / 23 步 / n_samples:1` 在 Opus 免费档内
 *   - D9（§2 决策表）：`n_samples` 恒 1，「恰好卡在 Opus 免费档内（常规尺寸 + 单张）」
 *   - §11.2：措辞必须是**估算**，不是保证
 *   - §14.1：本文件应钉住「默认参数免费 · 尺寸越界 · 步数越界 · 边界值逐个」
 */

import { describe, it, expect } from 'vitest';

import { NAI_ANLAS_RULES, estimateAnlasCost } from './image-anlas';

describe('默认参数（§6 参数表 + §6.3 尾注）', () => {
  it('1216×832 / 23 步 / 1 张 → 在免费额度内，估算 0 点', () => {
    const est = estimateAnlasCost(1216, 832, 23, 1);
    expect(est.verdict).toBe('within-free-allowance');
    expect(est.estimatedAnlas).toBe(0);
    expect(est.breaches).toEqual([]);
  });

  it('省略 samples 时按 1 张算 —— D9 把 n_samples 恒定为 1', () => {
    expect(estimateAnlasCost(1216, 832, 23)).toEqual(estimateAnlasCost(1216, 832, 23, 1));
  });

  it('免费档内 anlasPerSample 仍是正数 —— 那是牌价，不是这次要付的钱', () => {
    const est = estimateAnlasCost(1216, 832, 23, 1);
    // 1,011,712 px × 23 步 按定价系数算出 17 点/张；免费额度把这一张免掉了
    expect(est.anlasPerSample).toBe(17);
    expect(est.estimatedAnlas).toBe(0);
  });
});

describe('尺寸边界：算的是**面积**不是边长（NAI_ANLAS_RULES.freeMaxPixels）', () => {
  it('恰好 1024×1024 = 1,048,576 px → 仍在免费额度内（边界含等号）', () => {
    expect(1024 * 1024).toBe(NAI_ANLAS_RULES.freeMaxPixels);
    expect(estimateAnlasCost(1024, 1024, 28, 1).verdict).toBe('within-free-allowance');
  });

  it('再多一行像素（1024×1025）→ 越界，breach 指向 pixels', () => {
    const est = estimateAnlasCost(1024, 1025, 28, 1);
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['pixels']);
    expect(est.estimatedAnlas).toBe(est.anlasPerSample); // 免费额度整个失效，这一张全额收费
  });

  it('🔴 长边远超 1024 但面积不超 → 仍免费（默认的 1216×832 正是靠这条成立）', () => {
    expect(estimateAnlasCost(1216, 832, 23, 1).verdict).toBe('within-free-allowance');
    // 2048×512 面积恰好等于预算，长边是上限的两倍 —— 写成「每边 ≤ 1024」的实现会在这里翻车
    expect(2048 * 512).toBe(NAI_ANLAS_RULES.freeMaxPixels);
    expect(estimateAnlasCost(2048, 512, 23, 1).verdict).toBe('within-free-allowance');
  });
});

describe('步数边界（NAI_ANLAS_RULES.freeMaxSteps）', () => {
  it('28 步 → 免费（边界含等号）', () => {
    expect(NAI_ANLAS_RULES.freeMaxSteps).toBe(28);
    expect(estimateAnlasCost(1024, 1024, 28, 1).verdict).toBe('within-free-allowance');
  });

  it('29 步 → 越界，breach 指向 steps', () => {
    const est = estimateAnlasCost(1024, 1024, 29, 1);
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['steps']);
  });

  it('尺寸与步数同时越界 → 两条 breach 都列出来，UI 才说得清是哪一项', () => {
    const est = estimateAnlasCost(2048, 2048, 50, 1);
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['pixels', 'steps']);
  });
});

describe('张数边界：免的是前 N 张，不是整单作废（D9「常规尺寸 + 单张」）', () => {
  it('参数在档内但要 2 张 → 会花钱，且只按 1 张收费', () => {
    const est = estimateAnlasCost(1216, 832, 23, 2);
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['samples']);
    expect(est.estimatedAnlas).toBe(est.anlasPerSample);
  });

  it('参数越界时免费额度不再抵扣，3 张就是 3 张的钱', () => {
    const est = estimateAnlasCost(1024, 1025, 40, 3);
    expect(est.estimatedAnlas).toBe(est.anlasPerSample * 3);
  });
});

describe('定价估算（NAI 前端 SDXL/V4 分支的系数）', () => {
  it('锚点：1024×1024 / 28 步 = 20 点/张，与官方公布的牌价一致', () => {
    expect(estimateAnlasCost(1024, 1024, 28, 2).anlasPerSample).toBe(20);
  });

  it('极小的图也不低于最低收费', () => {
    expect(estimateAnlasCost(64, 64, 1, 2).anlasPerSample).toBe(NAI_ANLAS_RULES.minAnlasPerSample);
  });

  it('步数与像素单调递增 —— 调大参数只会更贵，不会更便宜', () => {
    const base = estimateAnlasCost(1024, 1024, 28, 2).anlasPerSample;
    expect(estimateAnlasCost(1024, 1024, 50, 2).anlasPerSample).toBeGreaterThan(base);
    expect(estimateAnlasCost(2048, 1024, 28, 2).anlasPerSample).toBeGreaterThan(base);
  });
});

describe('🔴 读不懂的参数一律报成会花钱（设置页输入框清空 → NaN）', () => {
  const bad: Array<[string, number, number, number, number]> = [
    ['宽为 NaN', Number.NaN, 832, 23, 1],
    ['高为 0', 1216, 0, 23, 1],
    ['步数为负', 1216, 832, -1, 1],
    ['张数为 Infinity', 1216, 832, 23, Number.POSITIVE_INFINITY],
  ];

  for (const [label, w, h, s, n] of bad) {
    it(`${label} → consumes-anlas + invalid-input，绝不报成免费`, () => {
      const est = estimateAnlasCost(w, h, s, n);
      expect(est.verdict).toBe('consumes-anlas');
      expect(est.breaches).toEqual(['invalid-input']);
      expect(Number.isFinite(est.estimatedAnlas)).toBe(true);
    });
  }
});

describe('措辞是估算不是保证（§11.2）', () => {
  it('每份结果都带规则集标签，供 UI 写「按当前订阅规则估算」', () => {
    const est = estimateAnlasCost(1216, 832, 23, 1);
    expect(est.rulesetLabel).toBe(NAI_ANLAS_RULES.rulesetLabel);
    expect(est.rulesetLabel.length).toBeGreaterThan(0);
  });

  it('🔴 结果里不许出现 isFree 这类听起来像承诺的布尔字段', () => {
    const keys = Object.keys(estimateAnlasCost(1216, 832, 23, 1));
    expect(keys).not.toContain('isFree');
    expect(keys).not.toContain('free');
  });
});

describe('规则常量是唯一真源 —— 改规则只动 NAI_ANLAS_RULES 一处', () => {
  it('恰好踩在三条上限上 → 免费；任一项 +1 → 收费', () => {
    const { freeMaxPixels, freeMaxSteps, freeSamplesPerRequest } = NAI_ANLAS_RULES;
    const side = Math.sqrt(freeMaxPixels); // 1024

    expect(estimateAnlasCost(side, side, freeMaxSteps, freeSamplesPerRequest).verdict).toBe(
      'within-free-allowance',
    );
    expect(estimateAnlasCost(side + 1, side, freeMaxSteps, freeSamplesPerRequest).verdict).toBe(
      'consumes-anlas',
    );
    expect(estimateAnlasCost(side, side, freeMaxSteps + 1, freeSamplesPerRequest).verdict).toBe(
      'consumes-anlas',
    );
    expect(estimateAnlasCost(side, side, freeMaxSteps, freeSamplesPerRequest + 1).verdict).toBe(
      'consumes-anlas',
    );
  });
});
