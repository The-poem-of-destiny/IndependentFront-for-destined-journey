/**
 * 捏人目录 — 引擎入口（类型 / 机制常量 / 纯函数）。
 *
 * 🔴 **这里没有内容了**（内容-引擎分离 D24）。七个池（装备/物品/技能、背景、命定核心、
 * 种族/身份点数表、起始地树）已从 `start-catalog-data.ts`（8704 行，已删）抽成
 * `data/content/catalog.json`，经内容注册表供给：
 *
 * ```ts
 * import { getContentRegistry, ensureContentRegistryLoaded } from '../ui/stores/content-store';
 * import { parseCatalogData } from '@engine/start-catalog-mechanics';
 * await ensureContentRegistryLoaded();
 * const catalog = parseCatalogData(getContentRegistry().catalog);
 * ```
 *
 * 机制半边在 `start-catalog-mechanics.ts`（下方整份 re-export）；本文件另留四组
 * 与目录同用的引擎常量（属性名 / 品质码表 / 品质色 / 品质基础 DC）。
 */

export * from './start-catalog-mechanics';
import type { CatalogRarityCode } from './start-catalog-mechanics';

export const ATTRIBUTE_NAMES = ['力量', '敏捷', '体质', '智力', '精神'] as const;
export const ATTR_CN_TO_EN: Record<string, string> = {
  力量: 'str',
  敏捷: 'dex',
  体质: 'con',
  智力: 'int',
  精神: 'spi',
};
export const ATTR_EN_TO_CN: Record<string, string> = {
  str: '力量',
  dex: '敏捷',
  con: '体质',
  int: '智力',
  spi: '精神',
};
export const RARITY_LABELS: CatalogRarityCode[] = [
  'common',
  'uncommon',
  'rare',
  'epic',
  'legendary',
  'mythic',
  'only',
];
export const QUALITY_COLORS: Record<string, string> = {
  普通: '#9e9e9e',
  优良: '#4caf50',
  稀有: '#2196f3',
  史诗: '#9c27b0',
  传说: '#ff9800',
  神话: '#e91e63',
  唯一: '#ff0000',
};
export const QUALITY_BASE_DC: Record<string, number> = {
  普通: 6,
  优良: 10,
  稀有: 14,
  史诗: 18,
  传说: 24,
  神话: 32,
  唯一: 40,
};
export const DESTINY_CORE_WORLDBOOK_MAP: Record<string, string[]> = {};

// 🪦 Q-11：`RARITY_TO_QUALITY` 已删。它是英文码 → 中文品质名的**第二张**表
//    （`field-enums.RARITY_ALIASES` 是第一张，且它还多认 `unique`），值类型是裸
//    `string`，于是四个调用点只能 `as QualityLevel` 强转。现在一律走
//    `normalizeRarity`（前端封装为 `quality-colors.qualityLabelFromRarity`），
//    返回类型即 `Rarity`，强转自然消失。
