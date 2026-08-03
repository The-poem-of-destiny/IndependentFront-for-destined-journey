/**
 * 由属性加成总和推断品质（Q-11）。
 *
 * 这是一条**确定性游戏规则**（ADR-11：阈值规则归 Code），此前却逐字重复地住在
 * `ItemsPanel.vue` 与 `CharacterListPanel.vue` 两个视图组件里，引擎侧零实现、零测试。
 * 两份阈值今天一致纯属运气 —— 改一处就静默分叉，而分叉的表现只是「同一件装备在
 * 背包里显示传说、在角色详情里显示史诗」，没有任何东西会失败。
 *
 * 用在**没有显式 rarity 字段**的地方（AI 生成的临时物品、旧存档里的条目）。
 * 有 `rarity` 就该直接用，别推断。
 */
import { RARITY_LEVELS, type Rarity } from './field-enums';

/**
 * 阈值表 —— `[属性绝对值总和下限, 品质]`，从高到低排列。
 *
 * 🔴 **封顶在「传说」（第 5 级）是刻意的，不是漏写**。两份原实现都封顶在这里，
 * 本次抽取只搬不改（保持行为等价）。`神话` / `唯一` 属于剧情/制作赋予的品质，
 * 不该由「属性加起来够大」推出来 —— 那会让一件属性堆料的普通装备自称唯一。
 * 要放开就得先在世界书侧定义 T6/T7 的属性门槛，那是规则变更不是重构。
 */
const THRESHOLDS: readonly (readonly [number, Rarity])[] = [
  [50, '传说'],
  [30, '史诗'],
  [20, '稀有'],
  [10, '优良'],
];

/** 推断不出更高品质时的下限 */
const FLOOR: Rarity = RARITY_LEVELS[0];

/** 本函数可能返回的最高品质（供测试与文档断言，避免「封顶」变成隐式知识） */
export const INFERRED_QUALITY_CAP: Rarity = THRESHOLDS[0][1];

/**
 * 按属性加成绝对值之和推断品质。
 *
 * 取**绝对值**：负面属性也是「这件东西有分量」的证据（诅咒装备不该被算成普通）。
 */
export function inferQualityFromStats(stats?: Record<string, number>): Rarity {
  if (!stats) return FLOOR;
  const total = Object.values(stats).reduce(
    (sum, v) => sum + (typeof v === 'number' && Number.isFinite(v) ? Math.abs(v) : 0),
    0,
  );
  for (const [min, quality] of THRESHOLDS) {
    if (total >= min) return quality;
  }
  return FLOOR;
}
