/**
 * 捏人页数据目录 — 从 CDN 自动生成（纯数据，见 start-catalog.ts 的类型/常量入口）
 */

export * from './start-catalog-data';
import type { CatalogRarityCode } from './start-catalog-data';

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

export const RARITY_TO_QUALITY: Record<string, string> = {
  common: '普通',
  uncommon: '优良',
  rare: '稀有',
  epic: '史诗',
  legendary: '传说',
  mythic: '神话',
  only: '唯一',
};
