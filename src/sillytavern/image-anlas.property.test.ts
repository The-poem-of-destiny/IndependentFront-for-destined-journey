import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NAI_ANLAS_RULES, TIER_RULESET_LABELS, estimateAnlasCost } from './image-anlas';
import type { NaiBillingTier } from './types-image';

/**
 * image-anlas 的**属性测试**。
 *
 * 模块头写着一条 doctrine：**「把『不知道』显示成『免费』是这个指示器最不该犯的错」**
 * ——而 2026-08-04 真机那天的 bug 正是它（对按点数付费的账户说不要钱）。
 * 那是一条**全称命题**：对*任何*参数组合都必须成立。这正是属性测试的形状，
 * 例子测试只能挑几组去证。
 */

const tier = fc.constantFrom<NaiBillingTier>('opus', 'metered', 'unset');

/** 掺进设置页输入框清空产生的 NaN / 负数 / 0 —— 那是 isUsable 要挡的东西 */
const dim = fc.oneof(
  fc.integer({ min: 1, max: 4096 }),
  fc.constantFrom(0, -1, NaN, Infinity, -Infinity),
  fc.double({ min: -100, max: 4096, noNaN: false }),
);

const steps = fc.oneof(fc.integer({ min: 1, max: 100 }), fc.constantFrom(0, -1, NaN, Infinity));

describe('estimateAnlasCost 不变式', () => {
  it('非 opus 档位永远不报「在免费额度内」', () => {
    // doctrine 的核心：免费额度是 Opus 专属的。
    fc.assert(
      fc.property(
        dim,
        dim,
        steps,
        fc.constantFrom<NaiBillingTier>('metered', 'unset'),
        (w, h, s, t) => {
          const est = estimateAnlasCost(w, h, s, { tier: t });
          expect(est.verdict).toBe('consumes-anlas');
        },
      ),
    );
  });

  it('缺省 tier 等价于 unset —— 忘了传绝不会得到乐观答案', () => {
    fc.assert(
      fc.property(dim, dim, steps, (w, h, s) => {
        expect(estimateAnlasCost(w, h, s)).toEqual(estimateAnlasCost(w, h, s, { tier: 'unset' }));
      }),
    );
  });

  it('参数不是正的有限数时，一律报收费 + invalid-input', () => {
    const bad = fc.constantFrom(0, -1, NaN, Infinity, -Infinity);
    fc.assert(
      fc.property(bad, dim, steps, tier, (w, h, s, t) => {
        const est = estimateAnlasCost(w, h, s, { tier: t });
        expect(est.verdict).toBe('consumes-anlas');
        expect(est.breaches).toContain('invalid-input');
      }),
    );
  });

  it('估算值永远是有限的非负数，单张牌价不低于最低收费', () => {
    fc.assert(
      fc.property(dim, dim, steps, tier, fc.integer({ min: 1, max: 4 }), (w, h, s, t, samples) => {
        const est = estimateAnlasCost(w, h, s, { tier: t, samples });
        expect(Number.isFinite(est.anlasPerSample)).toBe(true);
        expect(Number.isFinite(est.estimatedAnlas)).toBe(true);
        expect(est.estimatedAnlas).toBeGreaterThanOrEqual(0);
        expect(est.anlasPerSample).toBeGreaterThanOrEqual(NAI_ANLAS_RULES.minAnlasPerSample);
      }),
    );
  });

  it('verdict 与 estimatedAnlas 永远自洽', () => {
    // 说「在免费额度内」就必须真的是 0 点；说「收费」就必须 > 0。两者分家就是在骗用户。
    fc.assert(
      fc.property(dim, dim, steps, tier, fc.integer({ min: 1, max: 4 }), (w, h, s, t, samples) => {
        const est = estimateAnlasCost(w, h, s, { tier: t, samples });
        if (est.verdict === 'within-free-allowance') expect(est.estimatedAnlas).toBe(0);
        else expect(est.estimatedAnlas).toBeGreaterThan(0);
      }),
    );
  });

  it('opus 档下：超尺寸或超步数一定收费，且 breaches 指明是哪一项', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 4096 }),
        fc.integer({ min: 1, max: 100 }),
        (w, h, s) => {
          const est = estimateAnlasCost(w, h, s, { tier: 'opus' });
          const overPixels = w * h > NAI_ANLAS_RULES.freeMaxPixels;
          const overSteps = s > NAI_ANLAS_RULES.freeMaxSteps;
          expect(est.breaches.includes('pixels')).toBe(overPixels);
          expect(est.breaches.includes('steps')).toBe(overSteps);
          if (overPixels || overSteps) expect(est.verdict).toBe('consumes-anlas');
          else expect(est.verdict).toBe('within-free-allowance');
        },
      ),
    );
  });

  it('单调性：同档同步数下，图越大越不会变便宜', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: 1, max: 100 }),
        (w, hSmall, grow, s) => {
          const small = estimateAnlasCost(w, hSmall, s, { tier: 'opus' });
          const big = estimateAnlasCost(w, hSmall + grow, s, { tier: 'opus' });
          expect(big.anlasPerSample).toBeGreaterThanOrEqual(small.anlasPerSample);
        },
      ),
    );
  });

  it('rulesetLabel 永远来自档位标签表，绝不留空', () => {
    fc.assert(
      fc.property(dim, dim, steps, tier, (w, h, s, t) => {
        const est = estimateAnlasCost(w, h, s, { tier: t });
        expect(est.rulesetLabel).toBe(TIER_RULESET_LABELS[t]);
        expect(est.rulesetLabel.length).toBeGreaterThan(0);
      }),
    );
  });
});
