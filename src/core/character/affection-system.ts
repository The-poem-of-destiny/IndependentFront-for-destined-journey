/**
 * 好感度系统 — Layer 2 计算级 (AI 可读写)
 *
 * 职责: 提供简单的 [-100, +100] 好感度值存储和边界保护。
 * 所有行为判断（冷漠/友好/敌对等）交给叙事 AI 演绎。
 *
 * 对齐世界书 #966681 [好感度]: -100至+100分11级命名区间。
 * 架构决策: Code 层只负责数值钳制和 API 暴露，不内置行为修正逻辑。
 */

// ========== 常量 ==========

/** 好感度下限 */
export const AFFECTION_MIN = -100;

/** 好感度上限 */
export const AFFECTION_MAX = +100;

/** 好感度键值映射: characterId → 好感度值 */
export type AffectionMap = Record<string, number>;

// ========== 钳制 ==========

/** 钳制好感度值到 [-100, +100] */
export function clampAffection(value: number): number {
  return Math.min(AFFECTION_MAX, Math.max(AFFECTION_MIN, Math.round(value)));
}

// ========== 读写操作 ==========

/**
 * 获取某角色好感度，不存在则返回 0
 */
export function getAffection(affections: AffectionMap, characterId: string): number {
  return affections[characterId] ?? 0;
}

/**
 * 设置某角色好感度（自动钳制）
 */
export function setAffection(
  affections: AffectionMap,
  characterId: string,
  value: number,
): AffectionMap {
  return { ...affections, [characterId]: clampAffection(value) };
}

/**
 * 增减某角色好感度（自动钳制）
 */
export function addAffection(
  affections: AffectionMap,
  characterId: string,
  delta: number,
): AffectionMap {
  const current = getAffection(affections, characterId);
  return setAffection(affections, characterId, current + delta);
}

/**
 * 批量设置多个角色好感度
 */
export function batchSetAffection(
  affections: AffectionMap,
  updates: Record<string, number>,
): AffectionMap {
  let result = { ...affections };
  for (const [id, value] of Object.entries(updates)) {
    result = setAffection(result, id, value);
  }
  return result;
}

/**
 * 批量增减多个角色好感度
 */
export function batchAddAffection(
  affections: AffectionMap,
  deltas: Record<string, number>,
): AffectionMap {
  let result = { ...affections };
  for (const [id, delta] of Object.entries(deltas)) {
    result = addAffection(result, id, delta);
  }
  return result;
}

// ========== 简易标签（仅用于 UI 展示，不影响行为） ==========

/** 好感度区间标签 */
export interface AffectionLabel {
  /** 数值范围 */
  range: [number, number];
  /** 中文标签 */
  label: string;
}

/** 11 级好感度标签 (对齐世界书 #966681) */
export const AFFECTION_LABELS: AffectionLabel[] = [
  { range: [90, 100], label: '誓死追随' },
  { range: [70, 89], label: '深厚羁绊' },
  { range: [50, 69], label: '友好信任' },
  { range: [30, 49], label: '好感' },
  { range: [10, 29], label: '略有善意' },
  { range: [-9, 9], label: '中立' },
  { range: [-29, -10], label: '略有反感' },
  { range: [-49, -30], label: '厌恶' },
  { range: [-69, -50], label: '敌意' },
  { range: [-89, -70], label: '深仇大恨' },
  { range: [-100, -90], label: '不共戴天' },
];

/**
 * 根据好感度值获取标签（仅用于 UI 展示）
 */
export function getAffectionLabel(value: number): string {
  const clamped = clampAffection(value);
  for (const tier of AFFECTION_LABELS) {
    if (clamped >= tier.range[0] && clamped <= tier.range[1]) {
      return tier.label;
    }
  }
  return '中立';
}

/**
 * 简化版标签: 仅分正面/中立/负面
 */
export function getSimpleAffectionLabel(value: number): '友好' | '中立' | '敌对' {
  const clamped = clampAffection(value);
  if (clamped > 9) return '友好';
  if (clamped < -9) return '敌对';
  return '中立';
}

// ========== $affection API (AI 可见) ==========

/**
 * $affection API — 供 vars_update Agent 调用
 *
 * 使用方式 (在 AI prompt 中声明):
 *   $affection.get("characterId")        → 获取当前值
 *   $affection.set("characterId", 50)     → 设置为指定值
 *   $affection.add("characterId", 5)      → 增减
 *   $affection.batch({ "alice": 30, "bob": -10 })  → 批量设置
 *   $affection.label(75)                  → "深厚羁绊"
 */
export const $affection = {
  /** 获取某角色好感度 */
  get: (affections: AffectionMap, characterId: string): number =>
    getAffection(affections, characterId),

  /** 设置并返回新 map */
  set: (affections: AffectionMap, characterId: string, value: number): AffectionMap =>
    setAffection(affections, characterId, value),

  /** 增减并返回新 map */
  add: (affections: AffectionMap, characterId: string, delta: number): AffectionMap =>
    addAffection(affections, characterId, delta),

  /** 批量 set */
  batch: (affections: AffectionMap, updates: Record<string, number>): AffectionMap =>
    batchSetAffection(affections, updates),

  /** 获取标签 */
  label: (value: number): string => getAffectionLabel(value),

  /** 获取简化标签 */
  simpleLabel: (value: number): '友好' | '中立' | '敌对' => getSimpleAffectionLabel(value),

  /** 边界常量 */
  MIN: AFFECTION_MIN,
  MAX: AFFECTION_MAX,
};
