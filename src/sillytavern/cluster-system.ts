/**
 * 集群系统 — Layer 3 流程级 (AI 不可见)
 *
 * 职责: ≥3 同类低级单位自动合并为[集群]，管理集群 HP/攻击次数/减员。
 * 对齐世界书 #837805 [战斗协议] 第一阶段 §3 + 第三阶段 §2/§5/§6。
 *
 * 核心规则:
 *   - 形成: ≥3 个同模板单位 → 自动聚合 (资源 = 个体 × N)
 *   - 攻击次数: HP≥80%→3次, HP≥50%→2次, HP<50%→1次
 *   - 伤害修正: 对集群最终伤害 ×1.5
 *   - 意图免疫: 集群无法触发意图/部位攻击
 *   - 减员: 按 HP% 折算存活个体数
 *   - 范围结算: 总伤害 = 单体修正伤害 × min(范围x, 集群当前数量n)
 */

import type {
  ClusterState,
  ClusterFormResult,
  ClusterAttritionResult,
} from './types';
import { MORALE_OUTCOME_POOL } from './types';

// ========== 集群形成 ==========

/** 检查是否可以形成集群: ≥3 个同类型单位 */
export function canFormCluster(unitCount: number): boolean {
  return unitCount >= 3;
}

/** 最小集群规模 */
export const MIN_CLUSTER_SIZE = 3;

/**
 * 从同模板单位形成集群。
 *
 * @param unitTemplateId - 组成单位的模板 ID
 * @param count - 单位数量 (必须 ≥3)
 * @param unitMaxHp - 单体最大 HP
 * @param unitCurrentHp - 单体当前 HP (默认等于 maxHp)
 */
export function formClusterState(
  unitTemplateId: string,
  count: number,
  unitMaxHp: number,
  unitCurrentHp?: number,
): ClusterFormResult {
  if (count < MIN_CLUSTER_SIZE) {
    return {
      cluster: {
        unitTemplateId,
        initialCount: count,
        currentCount: count,
        clusterHp: (unitCurrentHp ?? unitMaxHp) * count,
        clusterMaxHp: unitMaxHp * count,
        attacksPerRound: 1,
      },
      mergedIds: [],
      reason: `单位数量 ${count} < ${MIN_CLUSTER_SIZE}，不形成集群`,
    };
  }

  const currentHp = unitCurrentHp ?? unitMaxHp;
  const clusterMaxHp = unitMaxHp * count;
  const clusterHp = currentHp * count;
  const hpRatio = clusterMaxHp > 0 ? clusterHp / clusterMaxHp : 0;
  const attacksPerRound = getClusterAttackCountByRatio(hpRatio);

  const cluster: ClusterState = {
    unitTemplateId,
    initialCount: count,
    currentCount: count,
    clusterHp,
    clusterMaxHp,
    attacksPerRound,
  };

  return {
    cluster,
    mergedIds: [],
    reason: `${count} 个同类单位合并为集群 (HP: ${clusterHp}/${clusterMaxHp}, 攻击次数: ${attacksPerRound})`,
  };
}

// ========== HP 比例与攻击次数 ==========

/**
 * 获取集群当前 HP 比例 (0.0 ~ 1.0)
 */
export function getClusterHpRatio(cluster: ClusterState): number {
  if (cluster.clusterMaxHp <= 0) return 0;
  return Math.min(1, Math.max(0, cluster.clusterHp / cluster.clusterMaxHp));
}

/**
 * 根据 HP 比例计算集群攻击次数 (对齐世界书):
 *   HP ≥ 80% → 3次
 *   HP ≥ 50% → 2次
 *   HP ≥ 30% → 1次
 *   HP < 30% → 1次
 */
export function getClusterAttackCountByRatio(hpRatio: number): number {
  if (hpRatio >= 0.8) return 3;
  if (hpRatio >= 0.5) return 2;
  return 1;
}

/**
 * 根据当前HP和最大HP计算集群攻击次数。
 * (与 combat-damage.ts 的 getClusterAttackCount 等效，集群模块提供权威版本)
 */
export function getClusterAttackCount(currentHp: number, maxHp: number): number {
  const hpRatio = maxHp > 0 ? currentHp / maxHp : 0;
  return getClusterAttackCountByRatio(hpRatio);
}

/** HP 比例阈值 → 攻击次数映射 (世界书) */
export const CLUSTER_ATTACK_COUNT_THRESHOLDS = [
  { minRatio: 0.8, attacks: 3, label: 'HP ≥ 80% → 3次' },
  { minRatio: 0.5, attacks: 2, label: 'HP ≥ 50% → 2次' },
  { minRatio: 0.0, attacks: 1, label: 'HP < 50% → 1次' },
] as const;

// ========== 集群存活数量 ==========

/**
 * 按 HP 百分比折算集群当前存活个体数 (对齐世界书)。
 *
 * 公式: currentCount = ceil(initialCount × hpRatio)
 * 至少为 0 (全灭)，最多为 initialCount。
 */
export function getClusterSurvivingCount(
  initialCount: number,
  currentHp: number,
  maxHp: number,
): number {
  if (maxHp <= 0) return 0;
  const hpRatio = Math.min(1, Math.max(0, currentHp / maxHp));
  const count = Math.ceil(initialCount * hpRatio);
  return Math.min(initialCount, Math.max(0, count));
}

// ========== 集群伤害修正 ==========

/** 集群伤害倍率 (对齐世界书: ×1.5) */
export const CLUSTER_DAMAGE_MULTIPLIER = 1.5;

/**
 * 对集群单位的伤害修正: 最终伤害 × 1.5
 */
export function calcClusterDamageMultiplier(
  damage: number,
  isClusterTarget: boolean,
): number {
  return isClusterTarget ? Math.floor(damage * CLUSTER_DAMAGE_MULTIPLIER) : damage;
}

// ========== 范围技能 vs 集群 ==========

/**
 * 范围技能对集群: 总伤害 = 修正后单体伤害 × min(范围x, 集群当前数量n)
 *
 * 对齐世界书 #837805 第三阶段 §6: 对集群总伤害 = 修正后的单体伤害 × min(技能标签范围x, 集群当前数量n)
 */
export function calcAoEClusterDamage(
  singleTargetDamage: number,
  aoeRange: number,
  clusterCount: number,
): number {
  return singleTargetDamage * Math.min(aoeRange, clusterCount);
}

// ========== 集群减员 ==========

/**
 * 更新集群在承受伤害后的状态。
 * 减员数 = initialCount - ceil(initialCount × 新HP比例)
 */
export function updateClusterAfterDamage(
  cluster: ClusterState,
  damageTaken: number,
): ClusterAttritionResult {
  const hpPercentBefore = getClusterHpRatio(cluster);

  const newHp = Math.max(0, cluster.clusterHp - damageTaken);
  const newCount = getClusterSurvivingCount(
    cluster.initialCount,
    newHp,
    cluster.clusterMaxHp,
  );

  const casualtiesThisRound = cluster.currentCount - newCount;
  const hpPercentAfter = cluster.clusterMaxHp > 0 ? newHp / cluster.clusterMaxHp : 0;

  // 全灭
  if (newHp <= 0 || newCount <= 0) {
    return {
      cluster: null,
      casualtiesThisRound: cluster.currentCount,
      hpPercentBefore,
      hpPercentAfter: 0,
    };
  }

  const updatedCluster: ClusterState = {
    ...cluster,
    clusterHp: newHp,
    currentCount: newCount,
    attacksPerRound: getClusterAttackCountByRatio(hpPercentAfter),
  };

  return {
    cluster: updatedCluster,
    casualtiesThisRound,
    hpPercentBefore,
    hpPercentAfter,
  };
}

// ========== 集群意图免疫 ==========

/**
 * 集群无法触发意图/部位攻击 (对齐世界书 #837805 第三阶段 §5)。
 * 对集群攻击时，意图系数强制重置为 1.0，无额外状态效果。
 */
export function isClusterIntentionImmune(): true {
  return true;
}

/**
 * 对集群使用意图攻击时的结果修正:
 *   - 意图系数 → 1.0
 *   - 额外状态效果 → 清除
 *   - 部位攻击 → 无效
 */
export function getClusterIntentionOverride() {
  return {
    coefficient: 1.0,
    extraEffects: [],
    narrativeNote: '目标为集群 → 意图/部位攻击无效，伤害系数重置为 1.0',
  };
}

// ========== 集群攻击次数更新 ==========

/**
 * 刷新集群的攻击次数 (每回合开始时调用)。
 * 根据当前 HP 百分比重新计算 attacksPerRound。
 */
export function refreshClusterAttacks(cluster: ClusterState): ClusterState {
  const hpRatio = getClusterHpRatio(cluster);
  return {
    ...cluster,
    attacksPerRound: getClusterAttackCountByRatio(hpRatio),
  };
}

// ========== 集群判定查询 ==========

/**
 * 检查一个角色是否有资格被聚合为集群。
 * 条件: ≥3 个同模板的低级单位 (层级 ≤ T3 标准)
 *
 * @param tier - 单位层级
 * @param count - 同模板单位数量
 */
export function isClusterEligible(tier: number, count: number): boolean {
  // 仅 T1-T3 标准单位可形成集群
  // T4+ 单位个体过强，不适合集群化
  return tier <= 3 && count >= MIN_CLUSTER_SIZE;
}

/** 集群可形成的最高层级 */
export const MAX_CLUSTER_TIER = 3;

/**
 * 集群面板展示信息 — 用于 <action_info> 中的集群行。
 *
 * 格式: "[集群名] (存活数/初始数): HP [X/X] | ..."
 */
export function formatClusterPanel(cluster: ClusterState, displayName: string): string {
  return `${displayName} (${cluster.currentCount}/${cluster.initialCount}): HP [${cluster.clusterHp}/${cluster.clusterMaxHp}] | 攻击×${cluster.attacksPerRound}`;
}
