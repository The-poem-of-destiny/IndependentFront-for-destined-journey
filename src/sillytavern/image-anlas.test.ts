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
 *
 * 🔴 **档位轴（2026-08-04 真机催生）**：免费额度那三条是 **Opus 专属**的。此前本文件
 *    每条断言都隐含「用户是 Opus」，于是实现里那个隐含假设一直没被看见 —— 指示器对
 *    按点数付费的账户也说「免费」。现在每条与免费额度有关的断言都**显式**写出
 *    `tier: 'opus'`，那个假设从此在纸面上。
 */

import { describe, it, expect } from 'vitest';

import { NAI_ANLAS_RULES, TIER_RULESET_LABELS, estimateAnlasCost } from './image-anlas';

/** 大多数历史断言的前提：Opus 账户。写成常量，免得每处都重复一遍字面量 */
const OPUS = { tier: 'opus' } as const;

describe('默认参数（§6 参数表 + §6.3 尾注）', () => {
  it('Opus + 1216×832 / 23 步 / 1 张 → 在免费额度内，估算 0 点', () => {
    const est = estimateAnlasCost(1216, 832, 23, { samples: 1, ...OPUS });
    expect(est.verdict).toBe('within-free-allowance');
    expect(est.estimatedAnlas).toBe(0);
    expect(est.breaches).toEqual([]);
  });

  it('省略 samples 时按 1 张算 —— D9 把 n_samples 恒定为 1', () => {
    expect(estimateAnlasCost(1216, 832, 23, OPUS)).toEqual(
      estimateAnlasCost(1216, 832, 23, { samples: 1, ...OPUS }),
    );
  });

  it('免费档内 anlasPerSample 仍是正数 —— 那是牌价，不是这次要付的钱', () => {
    const est = estimateAnlasCost(1216, 832, 23, { samples: 1, ...OPUS });
    // 1,011,712 px × 23 步 按定价系数算出 17 点/张；免费额度把这一张免掉了
    expect(est.anlasPerSample).toBe(17);
    expect(est.estimatedAnlas).toBe(0);
  });
});

describe('🔴 账户档位：免费额度是 Opus 专属的（2026-08-04 真机催生）', () => {
  const params = [1216, 832, 23] as const;

  it('缺省档位 = unset，**不是** opus —— 忘了传的调用方不该白得一个「免费」', () => {
    const est = estimateAnlasCost(...params);
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toContain('tier-unknown');
  });

  it('unset：算得出牌价，但一律按会花钱报（与 invalid-input 同一条 doctrine）', () => {
    const est = estimateAnlasCost(...params, { tier: 'unset' });
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.anlasPerSample).toBe(17); // 牌价照算，UI 才能说「约 17 点/张，取决于你的档位」
    expect(est.estimatedAnlas).toBe(17);
  });

  it('metered：同一组参数在 Opus 下免费，在按点数付费下每张都扣', () => {
    const opus = estimateAnlasCost(...params, OPUS);
    const metered = estimateAnlasCost(...params, { tier: 'metered' });

    expect(opus.verdict).toBe('within-free-allowance');
    expect(opus.estimatedAnlas).toBe(0);

    expect(metered.verdict).toBe('consumes-anlas');
    expect(metered.estimatedAnlas).toBe(metered.anlasPerSample);
    expect(metered.breaches).toContain('no-free-allowance');
  });

  it('metered 的 breach 与参数越界**互不蕴含** —— 参数没超也照样没有免费额度', () => {
    // 这组参数完全在 Opus 免费档内：唯一的 breach 只能是档位
    const est = estimateAnlasCost(...params, { tier: 'metered' });
    expect(est.breaches).toEqual(['no-free-allowance']);
    expect(est.breaches).not.toContain('pixels');
    expect(est.breaches).not.toContain('steps');
  });

  it('metered 下调小尺寸/步数也免不掉 —— UI 据此不建议用户去徒劳地调参数', () => {
    const tiny = estimateAnlasCost(512, 512, 1, { tier: 'metered' });
    expect(tiny.verdict).toBe('consumes-anlas');
    expect(tiny.estimatedAnlas).toBeGreaterThan(0);
  });

  it('三档各自的规则集标签不同 —— 拿 Opus 那句去描述按点数付费正是那个 bug 本身', () => {
    expect(estimateAnlasCost(...params, OPUS).rulesetLabel).toBe(TIER_RULESET_LABELS.opus);
    expect(estimateAnlasCost(...params, { tier: 'metered' }).rulesetLabel).toBe(
      TIER_RULESET_LABELS.metered,
    );
    expect(estimateAnlasCost(...params, { tier: 'unset' }).rulesetLabel).toBe(
      TIER_RULESET_LABELS.unset,
    );
    expect(TIER_RULESET_LABELS.metered).not.toBe(TIER_RULESET_LABELS.opus);
    // 非 Opus 的两句都不许提「免费额度」，免得又暗示有那么一档
    expect(TIER_RULESET_LABELS.metered).not.toContain('免费额度内');
  });

  it('🔴 没有任何档位能让 verdict 变成「免费」而参数其实越界', () => {
    for (const tier of ['opus', 'metered', 'unset'] as const) {
      expect(estimateAnlasCost(2048, 2048, 50, { tier }).verdict).toBe('consumes-anlas');
    }
  });
});

describe('尺寸边界：算的是**面积**不是边长（NAI_ANLAS_RULES.freeMaxPixels）', () => {
  it('恰好 1024×1024 = 1,048,576 px → 仍在免费额度内（边界含等号）', () => {
    expect(1024 * 1024).toBe(NAI_ANLAS_RULES.freeMaxPixels);
    expect(estimateAnlasCost(1024, 1024, 28, { samples: 1, ...OPUS }).verdict).toBe(
      'within-free-allowance',
    );
  });

  it('再多一行像素（1024×1025）→ 越界，breach 指向 pixels', () => {
    const est = estimateAnlasCost(1024, 1025, 28, { samples: 1, ...OPUS });
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['pixels']);
    expect(est.estimatedAnlas).toBe(est.anlasPerSample); // 免费额度整个失效，这一张全额收费
  });

  it('🔴 长边远超 1024 但面积不超 → 仍免费（默认的 1216×832 正是靠这条成立）', () => {
    expect(estimateAnlasCost(1216, 832, 23, { samples: 1, ...OPUS }).verdict).toBe(
      'within-free-allowance',
    );
    // 2048×512 面积恰好等于预算，长边是上限的两倍 —— 写成「每边 ≤ 1024」的实现会在这里翻车
    expect(2048 * 512).toBe(NAI_ANLAS_RULES.freeMaxPixels);
    expect(estimateAnlasCost(2048, 512, 23, { samples: 1, ...OPUS }).verdict).toBe(
      'within-free-allowance',
    );
  });
});

describe('步数边界（NAI_ANLAS_RULES.freeMaxSteps）', () => {
  it('28 步 → 免费（边界含等号）', () => {
    expect(NAI_ANLAS_RULES.freeMaxSteps).toBe(28);
    expect(estimateAnlasCost(1024, 1024, 28, { samples: 1, ...OPUS }).verdict).toBe(
      'within-free-allowance',
    );
  });

  it('29 步 → 越界，breach 指向 steps', () => {
    const est = estimateAnlasCost(1024, 1024, 29, { samples: 1, ...OPUS });
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['steps']);
  });

  it('尺寸与步数同时越界 → 两条 breach 都列出来，UI 才说得清是哪一项', () => {
    const est = estimateAnlasCost(2048, 2048, 50, { samples: 1, ...OPUS });
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['pixels', 'steps']);
  });
});

describe('张数边界：免的是前 N 张，不是整单作废（D9「常规尺寸 + 单张」）', () => {
  it('参数在档内但要 2 张 → 会花钱，且只按 1 张收费', () => {
    const est = estimateAnlasCost(1216, 832, 23, { samples: 2, ...OPUS });
    expect(est.verdict).toBe('consumes-anlas');
    expect(est.breaches).toEqual(['samples']);
    expect(est.estimatedAnlas).toBe(est.anlasPerSample);
  });

  it('参数越界时免费额度不再抵扣，3 张就是 3 张的钱', () => {
    const est = estimateAnlasCost(1024, 1025, 40, { samples: 3, ...OPUS });
    expect(est.estimatedAnlas).toBe(est.anlasPerSample * 3);
  });

  it('metered 下没有前 N 张可免，2 张就是 2 张的钱', () => {
    const est = estimateAnlasCost(1216, 832, 23, { samples: 2, tier: 'metered' });
    expect(est.estimatedAnlas).toBe(est.anlasPerSample * 2);
  });
});

describe('定价估算（NAI 前端 SDXL/V4 分支的系数）', () => {
  it('锚点：1024×1024 / 28 步 = 20 点/张，与官方公布的牌价一致', () => {
    expect(estimateAnlasCost(1024, 1024, 28, { samples: 2, ...OPUS }).anlasPerSample).toBe(20);
  });

  it('牌价与档位无关 —— 档位只决定免不免，不改变这张图值多少钱', () => {
    const price = (tier: 'opus' | 'metered' | 'unset'): number =>
      estimateAnlasCost(1024, 1024, 28, { tier }).anlasPerSample;
    expect(price('metered')).toBe(price('opus'));
    expect(price('unset')).toBe(price('opus'));
  });

  it('极小的图也不低于最低收费', () => {
    expect(estimateAnlasCost(64, 64, 1, { samples: 2, ...OPUS }).anlasPerSample).toBe(
      NAI_ANLAS_RULES.minAnlasPerSample,
    );
  });

  it('步数与像素单调递增 —— 调大参数只会更贵，不会更便宜', () => {
    const base = estimateAnlasCost(1024, 1024, 28, { samples: 2, ...OPUS }).anlasPerSample;
    expect(
      estimateAnlasCost(1024, 1024, 50, { samples: 2, ...OPUS }).anlasPerSample,
    ).toBeGreaterThan(base);
    expect(
      estimateAnlasCost(2048, 1024, 28, { samples: 2, ...OPUS }).anlasPerSample,
    ).toBeGreaterThan(base);
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
      // 🔴 连 Opus 都救不了读不懂的参数 —— 档位不是免死金牌
      const est = estimateAnlasCost(w, h, s, { samples: n, ...OPUS });
      expect(est.verdict).toBe('consumes-anlas');
      expect(est.breaches).toEqual(['invalid-input']);
      expect(Number.isFinite(est.estimatedAnlas)).toBe(true);
    });
  }
});

describe('措辞是估算不是保证（§11.2）', () => {
  it('每份结果都带规则集标签，供 UI 写「按当前订阅规则估算」', () => {
    const est = estimateAnlasCost(1216, 832, 23, { samples: 1, ...OPUS });
    expect(est.rulesetLabel).toBe(NAI_ANLAS_RULES.rulesetLabel);
    expect(est.rulesetLabel.length).toBeGreaterThan(0);
  });

  it('🔴 结果里不许出现 isFree 这类听起来像承诺的布尔字段', () => {
    const keys = Object.keys(estimateAnlasCost(1216, 832, 23, { samples: 1, ...OPUS }));
    expect(keys).not.toContain('isFree');
    expect(keys).not.toContain('free');
  });
});

describe('规则常量是唯一真源 —— 改规则只动 NAI_ANLAS_RULES 一处', () => {
  it('恰好踩在三条上限上 → 免费；任一项 +1 → 收费', () => {
    const { freeMaxPixels, freeMaxSteps, freeSamplesPerRequest } = NAI_ANLAS_RULES;
    const side = Math.sqrt(freeMaxPixels); // 1024

    expect(
      estimateAnlasCost(side, side, freeMaxSteps, { samples: freeSamplesPerRequest, ...OPUS })
        .verdict,
    ).toBe('within-free-allowance');
    expect(
      estimateAnlasCost(side + 1, side, freeMaxSteps, { samples: freeSamplesPerRequest, ...OPUS })
        .verdict,
    ).toBe('consumes-anlas');
    expect(
      estimateAnlasCost(side, side, freeMaxSteps + 1, { samples: freeSamplesPerRequest, ...OPUS })
        .verdict,
    ).toBe('consumes-anlas');
    expect(
      estimateAnlasCost(side, side, freeMaxSteps, { samples: freeSamplesPerRequest + 1, ...OPUS })
        .verdict,
    ).toBe('consumes-anlas');
  });
});
