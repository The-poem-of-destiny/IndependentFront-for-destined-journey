/**
 * 核心数值表 — 生命层级常量 & 计算公式 (Phase 5)
 *
 * 从 JSON 世界规则 #417617 [核心数值表] 提取的 7 层生命层级核心数值表
 * Layer 2 纯函数，AI 可读
 *
 * 世界书数值:
 *   HP 乘数:  [1, 2, 4, 10, 20, 40, 100]
 *   MP 乘数:  [1, 2.5, 6, 15, 35, 80, 160]
 *   SP 乘数:  [1, 2.5, 6, 15, 35, 80, 160]
 *   战斗系数: [2.0, 2.8, 4.0, 8.0, 15.0, 35.0, 80.0]
 *   属性上限: [8, 10, 12, 14, 16, 18, 20] (硬上限20，仅T7可达)
 *   EXP上限:  [100, 1000, 4000, 10000, 25000, 50000, 999999]
 */

import type { TierConfig } from './types';

// ========== 7 层生命层级表 ==========

export const TIER_CONFIGS: TierConfig[] = [
  {
    tier: 1, name: '普通',
    levelRange: [1, 4],
    hpMultiplier: 1, mpMultiplier: 1, spMultiplier: 1,
    combatCoefficient: 2.0, expCap: 100, qualityCap: '优良',
    populationWeight: 80, attributeCap: 8,
  },
  {
    tier: 2, name: '中坚',
    levelRange: [5, 8],
    hpMultiplier: 2, mpMultiplier: 2.5, spMultiplier: 2.5,
    combatCoefficient: 2.8, expCap: 1000, qualityCap: '稀有',
    populationWeight: 15, attributeCap: 10,
  },
  {
    tier: 3, name: '精英',
    levelRange: [9, 12],
    hpMultiplier: 4, mpMultiplier: 6, spMultiplier: 6,
    combatCoefficient: 4.0, expCap: 4000, qualityCap: '史诗',
    populationWeight: 5, attributeCap: 12,
  },
  {
    tier: 4, name: '史诗',
    levelRange: [13, 16],
    hpMultiplier: 10, mpMultiplier: 15, spMultiplier: 15,
    combatCoefficient: 8.0, expCap: 10000, qualityCap: '传说',
    populationWeight: 0.1, attributeCap: 14,
  },
  {
    tier: 5, name: '传说',
    levelRange: [17, 20],
    hpMultiplier: 20, mpMultiplier: 35, spMultiplier: 35,
    combatCoefficient: 15.0, expCap: 25000, qualityCap: '神话',
    populationWeight: 0.01, attributeCap: 16,
  },
  {
    tier: 6, name: '神话',
    levelRange: [21, 24],
    hpMultiplier: 40, mpMultiplier: 80, spMultiplier: 80,
    combatCoefficient: 35.0, expCap: 50000, qualityCap: '唯一',
    populationWeight: 0.001, attributeCap: 18,
  },
  {
    tier: 7, name: '神祗',
    levelRange: [25, 25],
    hpMultiplier: 100, mpMultiplier: 160, spMultiplier: 160,
    combatCoefficient: 80.0, expCap: 999999, qualityCap: '唯一',
    populationWeight: 0, attributeCap: 20,
  },
];

// ========== 查询 ==========

export function getTierConfig(tier: number): TierConfig | undefined {
  return TIER_CONFIGS.find(t => t.tier === tier);
}

// ========== 资源计算 ==========

/** 基础 HP = 体质 × tier乘数（世界书纯乘数公式） */
export function calcHP(tier: number, con: number, _level?: number): number {
  const cfg = getTierConfig(tier);
  if (!cfg) return 100;
  return Math.floor(cfg.hpMultiplier * con);
}

/** 基础 MP = 智力 × tier乘数 */
export function calcMP(tier: number, int: number, _level?: number): number {
  const cfg = getTierConfig(tier);
  if (!cfg) return 50;
  return Math.floor(cfg.mpMultiplier * int);
}

/** 基础 SP = 精神 × tier乘数 */
export function calcSP(tier: number, spi: number, _level?: number): number {
  const cfg = getTierConfig(tier);
  if (!cfg) return 50;
  return Math.floor(cfg.spMultiplier * spi);
}

// ========== 经验计算 ==========

/** 升级所需经验: 100 × 1.5^(level-1) */
export function calcExpToNext(level: number, _tier?: number): number {
  return Math.floor(100 * Math.pow(1.5, level - 1));
}

/** 总经验值（到指定等级） */
export function totalExpForLevel(level: number): number {
  let total = 0;
  for (let i = 1; i < level; i++) {
    total += calcExpToNext(i);
  }
  return total;
}

// ========== 属性点数 ==========

/** 每级获得的自由属性点数 */
export function calcAttributePoints(level: number): number {
  if (level <= 4) return 5;   // T1
  if (level <= 8) return 4;   // T2
  if (level <= 12) return 3;  // T3
  if (level <= 20) return 2;  // T4-5
  return 1;                    // T6-7
}

// ========== 品质上限 ==========

export function getTierQualityCap(tier: number): string {
  const cfg = getTierConfig(tier);
  return cfg?.qualityCap ?? '优良';
}

export function getTierPopulationRatio(tier: number): number {
  const cfg = getTierConfig(tier);
  return cfg?.populationWeight ?? 0;
}

// ========== 战斗系数 ==========

export function getCombatCoefficient(tier: number): number {
  const cfg = getTierConfig(tier);
  return cfg?.combatCoefficient ?? 2.0;
}

// ========== 层级突破校验 ==========

/** 检查是否可以突破到目标层级 */
export function canBreakthrough(
  currentLevel: number,
  currentTier: number,
  targetTier: number,
  ascensionElements: number,
): { allowed: boolean; reason?: string } {
  if (targetTier <= currentTier) {
    return { allowed: false, reason: '目标层级不高于当前层级' };
  }

  const cfg = getTierConfig(targetTier);
  if (!cfg) return { allowed: false, reason: '无效的目标层级' };

  // 等级要求
  const maxLevelOfCurrent = getTierConfig(currentTier)?.levelRange[1] ?? 0;
  if (currentLevel < maxLevelOfCurrent) {
    return { allowed: false, reason: `需要达到当前层级满级 (Lv.${maxLevelOfCurrent})` };
  }

  // 登神长阶要求 (T4+)
  if (targetTier >= 4 && ascensionElements < Math.min(3, targetTier - 3)) {
    return { allowed: false, reason: `需要更多登神要素 (当前: ${ascensionElements})` };
  }

  return { allowed: true };
}
