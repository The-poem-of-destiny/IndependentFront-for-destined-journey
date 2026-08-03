/**
 * 品质 / 层级 → 主题令牌 —— **全前端唯一的品质呈现入口**（design.md §5.3，Q-11）。
 *
 * Q-11 之前这里是 canonical 的一份，另有四份平行表：`ScenePanel.TIER_COLOR`（六项，
 * 而且**键错了套**，见下）、`SelectableCard.RARITY_QUALITY_VAR`（按英文码）、
 * `QualityFilter.FILTER_OPTIONS`（内联在选项里）、`CharGenSystemCard.TIER_COLORS`
 * （裸 hex，完全不跟随主题）。加一级品质或重排调色板要改五处，编译器一处都拦不住。
 *
 * 现在所有表都从 `RARITY_LEVELS` / `TIER_CONFIGS` 派生 —— 加第八级不可能漏。
 */
import { RARITY_LEVELS, normalizeRarity, type Rarity } from '@engine/field-enums';
import { TIER_CONFIGS } from '@engine/tier-constants';

/** 调色板令牌后缀，顺序与 `RARITY_LEVELS` 一一对应 */
const QUALITY_VAR_SUFFIX: readonly string[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
  'unique',
];

/**
 * 品质调色板的 CSS 变量名，按品质顺序排列（普通 → 唯一）。
 *
 * 导出是给 `utils/name-color.ts` 用的：它按名字 hash 取模选色，需要的是「这条调色板
 * 有哪几个档」而不是品质语义。此前它自己抄了一份，文件头还写着「与 quality-colors.ts
 * 保持同步」—— 那是第六张平行表（Q-11）。
 */
export const QUALITY_VAR_POOL: readonly string[] = QUALITY_VAR_SUFFIX.map(
  (suffix) => `--theme-quality-${suffix}`,
);

/** 品质中文名 → CSS 自定义属性名。由 `RARITY_LEVELS` 派生，不再手抄 */
const QUALITY_TO_VAR: Record<string, string> = Object.fromEntries(
  RARITY_LEVELS.map((q, i) => [q, QUALITY_VAR_POOL[i]]),
);

/**
 * 返回 CSS `var()` 引用字符串，用于内联 style 绑定。
 *
 * 兜底走 `--theme-quality-common` 而不是硬编码灰 —— 硬编码色不跟随主题，在浅色主题下
 * 不可读；而且它会把「数据里冒出个没见过的品质」表现成一个视觉上说不通的颜色，
 * 而不是一次可辨认的降级。
 */
export function qualityVar(quality: string): string {
  return `var(${qualityVarName(quality)})`;
}

/** 返回原始 CSS 变量名（不带 `var()` 包裹），用于动态 class 生成 */
export function qualityVarName(quality: string): string {
  return QUALITY_TO_VAR[quality] ?? '--theme-quality-common';
}

/**
 * 英文稀有度码（`CatalogRarityCode`，捏人页目录用）→ CSS `var()`。
 *
 * 走 `normalizeRarity` 而不是另建一张英文键的表 —— 别名表本身就是 field-enums 的职责，
 * 这里再抄一份就是第六张表。`only` / `unique` 两种第七级写法都能认。
 */
export function qualityVarFromRarity(code: string): string {
  const quality = normalizeRarity(code);
  return quality ? qualityVar(quality) : 'var(--theme-quality-common)';
}

/** 英文稀有度码 → 中文品质名（认不出时兜底「普通」），供徽章文案用 */
export function qualityLabelFromRarity(code: string): Rarity {
  return normalizeRarity(code) ?? '普通';
}

// ═══════════════════════════════════════════════════════════
// 层级（tier）—— 与品质**不是同一套词汇**
// ═══════════════════════════════════════════════════════════
//
// 🔴 `TIER_CONFIGS` 的层级名是 普通/中坚/精英/史诗/传说/神话/神祗，
//    品质名是 普通/优良/稀有/史诗/传说/神话/唯一 —— 只有 4 个词重合。
//
//    `ScenePanel.TIER_COLOR` 此前是一张按**品质名**建的六项表，却拿 `tierName` 去查：
//    T2 中坚 / T3 精英 / T7 神祗 三级查不着、落到静音灰，T1/T4/T5/T6 靠词形巧合碰对。
//    所以那不是「缺一项」，是键错了整套词汇 —— 直接换成 `qualityVar(tierName)`
//    只会把同一个 bug 搬个家。
//
//    这里按 **tier 序号**建映射（1..7 → 与品质同一条调色板），名字查询经 `TIER_CONFIGS`
//    反查序号，两条路都不依赖词形。

const TIER_VAR_BY_TIER: Record<number, string> = Object.fromEntries(
  TIER_CONFIGS.map((cfg, i) => [cfg.tier, QUALITY_VAR_POOL[i]]),
);

/** 层级序号（1..7）→ CSS `var()`；越界兜底 T1 色 */
export function tierVar(tier: number): string {
  return `var(${TIER_VAR_BY_TIER[tier] ?? '--theme-quality-common'})`;
}

/** 层级**名**（`CharacterState.tierName`，如「中坚」「神祗」）→ CSS `var()` */
export function tierVarByName(tierName?: string): string {
  const cfg = TIER_CONFIGS.find((c) => c.name === tierName);
  return cfg ? tierVar(cfg.tier) : 'var(--theme-quality-common)';
}

/**
 * 层级序号 → 中文**品质**名。
 *
 * 世界书把 T1-T7 与 普通~唯一 一一对应（战斗单位卡据此上色/贴标）。
 * 注意这与 `TIER_CONFIGS[i].name`（层级名）是两个不同的答案，别混用。
 */
export function qualityLabelForTier(tier: number): Rarity {
  return RARITY_LEVELS[tier - 1] ?? '普通';
}
