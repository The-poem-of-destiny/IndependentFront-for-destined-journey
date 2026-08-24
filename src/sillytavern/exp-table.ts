/**
 * 经验表 & 升级判定（经验系统改造 v1，2026-08-24）
 *
 * 语义：累计经验值表（照参考脚本 config/index.ts 的 `LevelXpTable`）。
 * `getRequiredXpForLevel(level)` = 达到该等级所需**累计经验值**（Lv1=120, Lv2=360, ...，
 * Lv25='MAX'）。角色字段 `expToNext` 的新语义 = 当前等级对应的累计门槛。
 *
 * 升级循环（`resolveLevelUps`，照脚本 services/experience.ts 的 `processExperienceAndLevel`）：
 *   while (totalExp >= 门槛 && !isMaxLevel) { level+1; expToNext=新门槛; 每级+1 属性点;
 *   里程碑(5/9/13/17/21/25) 全属性+1 且 tier 提升；关键等级(12/16/20/24) 登神条件不满足时
 *   把 totalExp 截断到当前级门槛 }。totalExp 永不清空（累计语义）。
 *
 * 登神飞升（`resolveAscensionFlyup`，主人裁定放宽版，2026-08-24）：只要角色**持有**对应
 * 登神物就**立即飞升**到下一层（不卡经验），硬性限制为「当前层级必须 = 目标层级-1」：
 *   elements>0 → T4(Lv13)；authority>0 → T5(Lv17)；law>0 → T6(Lv21)；deityPosition → T7(Lv25)。
 *
 * 战斗经验系数表（`EXPERIENCE_COEFFICIENTS`）：normal = 世界书 [经验值获取规则] 的层级战斗
 * 系数（一层~六层）；easy = 主人裁定的方案 B 系数（简单模式，T6=500 保持与普通持平）。
 *
 * ADR-11：确定性数值规则归 Code —— 升级/登神由 Code 判定，不交给 AI。
 * 🔴 本模块**不 import tier-constants**（tier-constants 反过来委托本模块，避免 ESM 环）；
 *   层级名自持一份 `TIER_NAMES`，与 `TIER_CONFIGS[i].name` 对齐（tier-constants.test.ts 已钉死）。
 */

import type { CharacterState, ExperienceMode } from './types';

/** 登神长阶的宽松只读形状（对齐 CharacterState.ascension，字段全可选便于测试/脏数据容错） */
export interface AscensionLike {
  enabled?: boolean;
  elements?: ReadonlyArray<{ name?: string; description?: string }>;
  authority?: ReadonlyArray<{ name?: string; description?: string }>;
  law?: ReadonlyArray<{ name?: string; description?: string }>;
  deityPosition?: string;
  divineKingdom?: { name?: string; description?: string };
}

// ========== 累计经验值表 ==========

/** 职业等级经验表 — 各等级所需**累计经验值**（照参考脚本 LevelXpTable）。Lv25 为 'MAX'（满级） */
export const LEVEL_XP_TABLE: Readonly<Record<number, number | 'MAX'>> = {
  0: 0,
  1: 120,
  2: 360,
  3: 720,
  4: 1200,
  5: 2400,
  6: 3840,
  7: 5520,
  8: 7440,
  9: 11940,
  10: 16940,
  11: 22440,
  12: 28440,
  13: 38840,
  14: 50040,
  15: 62040,
  16: 74840,
  17: 100340,
  18: 127340,
  19: 155840,
  20: 185840,
  21: 236240,
  22: 289040,
  23: 344240,
  24: 401840,
  25: 'MAX',
} as const;

/** 最大等级（满级） —— 模块内专用（isMaxLevel），不导出（knip 死代码棘轮） */
const MAX_LEVEL = 25;

/**
 * Lv25（满级）时 `expToNext` 的哨兵数值 —— `getRequiredXpForLevel(25)` 返回 'MAX'，
 * 而 `CharacterState.expToNext` 是 number（类型不放开成 number | 'MAX'），满级时用此值占位
 * （与 TIER_CONFIGS T7 的旧 expCap 同值）。消费方（StatusOverview 等）优先用
 * `getRequiredXpForLevel(level)` 判断 'MAX'，不读这个哨兵做业务判断。
 */
export const EXP_MAX_NUMBER = 999999;

/** 里程碑等级 — 达到时全属性 +1 且生命层级提升（照参考脚本 MilestoneLevels 的层级起点） */
export const MILESTONE_LEVELS: Readonly<Record<number, { attributeBonus: number; tier: number }>> =
  {
    5: { attributeBonus: 1, tier: 2 },
    9: { attributeBonus: 1, tier: 3 },
    13: { attributeBonus: 1, tier: 4 },
    17: { attributeBonus: 1, tier: 5 },
    21: { attributeBonus: 1, tier: 6 },
    25: { attributeBonus: 1, tier: 7 },
  } as const;

/** 五维属性英文键（对齐 CharacterState.attributes，升级/里程碑逐键遍历用） —— 模块内专用，不导出 */
const ATTRIBUTE_KEYS = ['str', 'dex', 'con', 'int', 'spi'] as const;

/** 7 层生命层级名（与 tier-constants.TIER_CONFIGS[i].name 对齐；本模块不 import tier-constants） */
const TIER_NAMES: readonly string[] = ['普通', '中坚', '精英', '史诗', '传说', '神话', '神祗'];

/** 等级 → 生命层级编号（1-7；与 TIER_CONFIGS.levelRange / create-store.getTier 对齐） */
export function getTierForLevel(level: number): number {
  if (level <= 4) return 1;
  if (level <= 8) return 2;
  if (level <= 12) return 3;
  if (level <= 16) return 4;
  if (level <= 20) return 5;
  if (level <= 24) return 6;
  return 7;
}

/** 层级编号 → 层级名（越界返回 '普通' 兜底） */
export function tierNameForTier(tier: number): string {
  return TIER_NAMES[tier - 1] ?? TIER_NAMES[0];
}

/** 查累计经验表：该等级所需累计经验值；越界/满级返回 'MAX' */
export function getRequiredXpForLevel(level: number): number | 'MAX' {
  return LEVEL_XP_TABLE[level] ?? 'MAX';
}

/** `getRequiredXpForLevel` 的 number 化（'MAX' → EXP_MAX_NUMBER），供 expToNext 字段落库 */
export function xpToNextNumber(level: number): number {
  const v = getRequiredXpForLevel(level);
  return typeof v === 'number' ? v : EXP_MAX_NUMBER;
}

/** 是否已满级 */
export function isMaxLevel(level: number): boolean {
  return level >= MAX_LEVEL;
}

// ========== 升级判定（ADR-11：数值规则归 Code） ==========

/** resolveLevelUps 的宽松输入（鸭子类型，不强制完整 CharacterState，测试好写） */
export interface LevelUpInput {
  level: number;
  totalExp: number;
  expToNext: number;
  freeAttrPoints: number;
  attributes: CharacterState['attributes'];
  tier: number;
  tierName: string;
  ascension?: AscensionLike;
}

/** 升级循环的结果（resolveLevelUps 的纯函数返回） */
export interface LevelUpResolution {
  level: number;
  totalExp: number;
  expToNext: number;
  freeAttrPoints: number;
  attributes: CharacterState['attributes'];
  tier: number;
  tierName: string;
  /** 关键等级（12/16/20/24）登神条件不满足 → totalExp 被截断到当前级门槛 */
  ascensionBlocked: boolean;
  /** 本次净升了几级（纯升级循环的增量，不含登神飞升） */
  levelsGained: number;
}

/**
 * 关键等级（12/16/20/24）的登神门槛 —— 升级循环与登神飞升共用同一判据（放宽版，2026-08-24）。
 *   Lv12 升 13 需持有要素；Lv16 升 17 需持有权能；Lv20 升 21 需持有法则；Lv24 升 25 需持有神位。
 */
export function canPassAscensionGate(level: number, ascension: AscensionLike): boolean {
  switch (level) {
    case 12:
      return (ascension.elements?.length ?? 0) > 0;
    case 16:
      return (ascension.authority?.length ?? 0) > 0;
    case 20:
      return (ascension.law?.length ?? 0) > 0;
    case 24:
      return ((ascension.deityPosition ?? '') + '').length > 0;
    default:
      return true;
  }
}

/** 五维全属性 +n（副本，不改原对象） */
function bumpAttributes(
  attributes: CharacterState['attributes'],
  bonus: number,
): CharacterState['attributes'] {
  const next = { ...attributes };
  for (const key of ATTRIBUTE_KEYS) {
    next[key] = (next[key] ?? 0) + bonus;
  }
  return next;
}

/**
 * 升级循环（纯函数，照参考脚本 processExperienceAndLevel）。
 *
 * while (totalExp >= 当前级累计门槛 && !isMaxLevel)：
 *   - 关键等级（12/16/20/24）登神条件不满足 → `ascensionBlocked=true`，把 totalExp 截断到
 *     当前级门槛并停止（角色攒的经验被封顶，等拿到登神物才继续）。
 *   - 否则 level+1、expToNext=新级门槛、每级 +1 自由属性点、里程碑全属性+1 且 tier/tierName 提升。
 *
 * **totalExp 永不清空**（累计语义，升级只改门槛与等级，不清零已获经验）。
 */
export function resolveLevelUps(input: LevelUpInput): LevelUpResolution {
  let { level, totalExp, expToNext, freeAttrPoints, attributes, tier, tierName } = input;
  const ascension = input.ascension ?? {};
  let ascensionBlocked = false;
  let levelsGained = 0;

  while (!isMaxLevel(level)) {
    const required = getRequiredXpForLevel(level);
    if (typeof required !== 'number') break; // 'MAX'（防御：isMaxLevel 已排除 level>=25，理论到不了）
    if (totalExp < required) break;

    if (!canPassAscensionGate(level, ascension)) {
      // 登神长阶未开启：经验封顶于当前级门槛，等拿到对应登神物再突破
      ascensionBlocked = true;
      totalExp = required;
      break;
    }

    level += 1;
    levelsGained += 1;
    expToNext = xpToNextNumber(level);
    freeAttrPoints += 1;

    const milestone = MILESTONE_LEVELS[level];
    if (milestone) {
      attributes = bumpAttributes(attributes, milestone.attributeBonus);
      tier = milestone.tier;
      tierName = tierNameForTier(milestone.tier);
    }
  }

  return {
    level,
    totalExp,
    expToNext,
    freeAttrPoints,
    attributes,
    tier,
    tierName,
    ascensionBlocked,
    levelsGained,
  };
}

// ========== 登神长阶放宽版（主人裁定 2026-08-24） ==========

/** resolveAscensionFlyup 的宽松输入 */
export interface AscensionFlyupInput {
  level: number;
  ascension?: AscensionLike;
}

/** 登神飞升判定结果 */
export interface AscensionFlyupResult {
  flyup: boolean;
  /** 不满足「当前层级 = 目标层级-1」硬性限制时的提示 */
  reason?: '层级不足';
  nextLevel?: number;
  nextTier?: number;
}

/**
 * 登神飞升判定（纯函数，放宽版）：只要角色**持有**对应登神物就**立即飞升**到下一层
 * （不卡经验），硬性限制为「当前层级必须 = 目标层级-1」：
 *   elements>0 → T4（等级升到 13）；authority>0 → T5（升 17）；
 *   law>0 → T6（升 21）；deityPosition → T7（升 25）。
 *
 * 角色同时持有多个登神物时取**最高目标**（判定顺序从神位到要素）。
 * 层级不足（如 T2 有要素）返回 `{ flyup:false, reason:'层级不足' }` —— 等级不够时不触发。
 */
export function resolveAscensionFlyup(input: AscensionFlyupInput): AscensionFlyupResult {
  const ascension = input.ascension ?? {};
  const currentTier = getTierForLevel(input.level);

  const tryFly = (
    targetTier: number,
    has: boolean,
    nextLevel: number,
  ): AscensionFlyupResult | null => {
    if (!has) return null;
    if (currentTier === targetTier - 1) {
      return { flyup: true, nextLevel, nextTier: targetTier };
    }
    return { flyup: false, reason: '层级不足' };
  };

  const hasDeity = ((ascension.deityPosition ?? '') + '').length > 0;
  const hasLaw = (ascension.law?.length ?? 0) > 0;
  const hasAuthority = (ascension.authority?.length ?? 0) > 0;
  const hasElements = (ascension.elements?.length ?? 0) > 0;

  return (
    tryFly(7, hasDeity, 25) ??
    tryFly(6, hasLaw, 21) ??
    tryFly(5, hasAuthority, 17) ??
    tryFly(4, hasElements, 13) ?? { flyup: false }
  );
}

// ========== 战斗经验系数表（简单/普通模式分档，2026-08-24） ==========

/**
 * 按存档经验模式查战斗经验系数（**每层**系数，照世界书 [经验值获取规则] 的层级战斗系数）。
 * normal = 世界书系数（一层~六层）；easy = 主人裁定的方案 B 系数。
 * 数组下标 = tier-1（T1 → [0]，…，T6 → [5]）；T7（满级）回退到最后一档（登神角色已无升级需求）。
 */
export const EXPERIENCE_COEFFICIENTS: Readonly<Record<ExperienceMode, readonly number[]>> = {
  normal: [10, 20, 50, 100, 250, 600],
  easy: [20, 36, 76, 130, 260, 500],
};

/** 查经验系数表：mode 缺省/未知 → normal；tier 越界 clamp 到表两端 */
export function getExperienceCoefficient(mode: ExperienceMode | undefined, tier: number): number {
  const table = EXPERIENCE_COEFFICIENTS[mode ?? 'normal'] ?? EXPERIENCE_COEFFICIENTS.normal;
  const idx = Math.min(Math.max(tier - 1, 0), table.length - 1);
  return table[idx] ?? table[table.length - 1] ?? EXPERIENCE_COEFFICIENTS.normal[0];
}

// ========== 旧档经验保底归一化（主人裁定方案 A，2026-08-24） ==========

/**
 * 角色经验保底归一化（旧存档兼容 v1，2026-08-24，主人裁定方案 A）。
 *
 * 背景：旧存档的 `totalExp` 语义是「层级内已积累」（如 Lv5 可能存 `2`、`expToNext` 是
 * 层级 expCap 如 `1000`），而新语义（本次经验系统改造）是「从 Lv1 起的全程累计」——
 * `expToNext` = 当前等级的累计门槛。旧档若直接套新语义会显示「2/2400」这类矛盾数据
 * （升到 Lv5 本就需要累计 ≥ 1200）。
 *
 * 本函数做**保底归一化**（方案 A）：
 *   · `totalExp` 至少抬到「升到当前等级所需累计门槛」`LevelXpTable[level-1]`（Lv1 → 0）；
 *   · `expToNext` 重算为当前等级累计门槛 `LevelXpTable[level]`（清掉旧 expCap 残留）。
 *
 * 🔴 幂等且只升不降：已符合新语义的角色（totalExp ≥ 门槛、expToNext 已是表值）
 *    原地不变、返回 `changed:false` —— 正常存档零影响，绝不"炸"。
 *    `totalExp` 只增不减（系统内 delta 累加，永不削减）。就地改 char。
 */
export function applyExpFloor(char: { level: number; totalExp: number; expToNext: number }): {
  changed: boolean;
} {
  let changed = false;

  // 保底：升到当前等级所需累计门槛（Lv1 门槛为 0；level>1 时 level-1 在 1..24，恒为 number）
  const floor = char.level <= 1 ? 0 : getRequiredXpForLevel(char.level - 1);
  if (typeof floor === 'number' && char.totalExp < floor) {
    char.totalExp = floor;
    changed = true;
  }

  // expToNext 重算为当前级累计门槛（清掉旧「层级 expCap」残留；正常存档已是表值 → 不变）
  const next = xpToNextNumber(char.level);
  if (char.expToNext !== next) {
    char.expToNext = next;
    changed = true;
  }

  return { changed };
}
