/**
 * quality-colors 专项测试（Q-11）
 *
 * 这个模块是「全前端唯一的品质呈现入口」，它的价值全在于**别人不再抄表**。
 * 所以这里断的不是某个具体色值，而是三条会被下一次改动打破的性质：
 *   1. 每一级品质都有自己的令牌（没有两级撞色、没有谁悄悄落到兜底）
 *   2. 层级走的是**序号**而不是词形 —— 那正是 ScenePanel 那个 bug 的成因
 *   3. 层级名与品质名是两套词汇，不许混用
 */
import { describe, it, expect } from 'vitest';
import { RARITY_LEVELS } from '@engine/field-enums';
import { TIER_CONFIGS } from '@engine/tier-constants';
import {
  QUALITY_VAR_POOL,
  qualityLabelForTier,
  qualityLabelFromRarity,
  qualityVar,
  qualityVarFromRarity,
  qualityVarName,
  tierVar,
  tierVarByName,
} from './quality-colors';

describe('品质 → 令牌', () => {
  it('每一级都有自己的令牌，互不相同，且都不是兜底', () => {
    const vars = RARITY_LEVELS.map((q) => qualityVarName(q));
    expect(new Set(vars).size).toBe(RARITY_LEVELS.length);
    // 除「普通」外都不该等于兜底值
    for (const q of RARITY_LEVELS.slice(1)) {
      expect(qualityVarName(q)).not.toBe('--theme-quality-common');
    }
  });

  it('调色板长度与品质级数一致 —— 加第八级时这条会先红', () => {
    expect(QUALITY_VAR_POOL.length).toBe(RARITY_LEVELS.length);
  });

  it('qualityVar 包 var()，未知品质兜底到 common 而不是硬编码 hex', () => {
    expect(qualityVar('传说')).toBe('var(--theme-quality-legendary)');
    expect(qualityVar('不存在的品质')).toBe('var(--theme-quality-common)');
    expect(qualityVar('不存在的品质')).not.toMatch(/#/);
  });
});

describe('英文稀有度码 → 令牌 / 标签', () => {
  it('七个码各自映射到对应品质，第七级两种写法同义', () => {
    expect(qualityVarFromRarity('legendary')).toBe('var(--theme-quality-legendary)');
    expect(qualityLabelFromRarity('only')).toBe('唯一');
    expect(qualityLabelFromRarity('unique')).toBe('唯一');
    expect(qualityVarFromRarity('only')).toBe(qualityVarFromRarity('unique'));
  });

  it('认不出的码兜底「普通」，不抛', () => {
    expect(qualityLabelFromRarity('garbage')).toBe('普通');
    expect(qualityVarFromRarity('garbage')).toBe('var(--theme-quality-common)');
  });
});

describe('层级 → 令牌（🔴 与品质不是同一套词汇）', () => {
  it('T1..T7 各有自己的令牌，互不相同', () => {
    const vars = TIER_CONFIGS.map((c) => tierVar(c.tier));
    expect(new Set(vars).size).toBe(TIER_CONFIGS.length);
  });

  it('按层级**名**查也要全中 —— 中坚/精英/神祗 三个在品质表里根本不存在', () => {
    for (const cfg of TIER_CONFIGS) {
      expect(tierVarByName(cfg.name), `层级「${cfg.name}」查不到色`).toBe(tierVar(cfg.tier));
    }
    // 这三个是旧实现（按品质名建表）永远查不着、落到静音灰的那几级
    expect(tierVarByName('中坚')).not.toBe('var(--theme-quality-common)');
    expect(tierVarByName('精英')).not.toBe('var(--theme-quality-common)');
    expect(tierVarByName('神祗')).not.toBe('var(--theme-quality-common)');
  });

  it('层级名与品质名确实是两套词汇 —— 这就是不能直接复用 qualityVar 的原因', () => {
    const tierNames = TIER_CONFIGS.map((c) => c.name);
    const qualityNames = [...RARITY_LEVELS];
    expect(tierNames).not.toEqual(qualityNames);
    // 「中坚」是 T2 的层级名，却不是任何一级品质
    expect(qualityNames).not.toContain('中坚');
    expect(tierNames).toContain('中坚');
  });

  it('层级序号 → 品质名（世界书 T1-T7 = 普通~唯一），越界兜底普通', () => {
    expect(qualityLabelForTier(1)).toBe('普通');
    expect(qualityLabelForTier(7)).toBe('唯一');
    expect(qualityLabelForTier(0)).toBe('普通');
    expect(qualityLabelForTier(99)).toBe('普通');
  });
});
