/**
 * FP 命运点数系统 — 计算函数 (Phase 4.6)
 *
 * 纯逻辑模块，所有 FP 相关计算公式
 */

// ========== 契约花费 ==========

/** 计算命定契约的 FP 花费 */
export function calcContractCost(
  targetTier: number,
  affectionModifier: number = 0, // -100 ~ +100, positive=easier (hostile=expensive)
): { base: number; modifier: number; total: number } {
  const tierCosts: Record<number, number> = {
    1: 200,
    2: 500,
    3: 2500,
    4: 5000,
    5: 50000,
    6: 150000,
    7: -1, // Tier 7 需要对方同意，不消耗 FP
  };

  const base = tierCosts[targetTier] ?? 200;
  if (base < 0) return { base: 0, modifier: 0, total: 0 };

  const modifier = Math.round(base * (-affectionModifier / 100)) || 0;
  const total = Math.max(1, base + modifier);

  return { base, modifier, total };
}

// ========== FP 获取 ==========

/** 任务完成 FP 奖励 */
export function calcFPFromTask(grade: string): number {
  const rewards: Record<string, number> = {
    'D': 50,
    'C': 100,
    'B': 500,
    'A': 1000,
    'S': 10000,
  };
  return rewards[grade] ?? 50;
}

/** 成就解锁 FP 奖励 */
export function calcFPFromAchievement(scale: 'minor' | 'major' | 'legendary'): number {
  return { minor: 500, major: 5000, legendary: 50000 }[scale];
}

/** 亲密行为 FP 奖励 */
export function calcFPFromIntimacy(type: string): number {
  const rewards: Record<string, number> = {
    'daily': 100,
    'crisis': 2000,
    'bond': 2000,
    'first_time': 500,
    'sex': 50,
    'orgasm': 100,
    'special': 500,
  };
  return rewards[type] ?? 100;
}

/** 制作 FP 奖励 */
export function calcFPFromCraft(quality: string): number {
  const rewards: Record<string, number> = {
    '普通': 0,
    '优良': 50,
    '稀有': 100,
    '史诗': 400,
    '传说': 1000,
    '神话': 3000,
    '唯一': 6000,
  };
  return rewards[quality] ?? 0;
}

/** 技能融合 FP 花费 */
export function calcSkillFusionCost(currentTier: number, targetTier: number): number {
  const diff = targetTier - currentTier;
  if (diff <= 0) return 0;
  return diff * 500 * currentTier;
}

// ========== $fp Namespace ==========

export const $fp = {
  calcContractCost,
  calcFPFromTask,
  calcFPFromAchievement,
  calcFPFromIntimacy,
  calcFPFromCraft,
  calcSkillFusionCost,
} as const;
