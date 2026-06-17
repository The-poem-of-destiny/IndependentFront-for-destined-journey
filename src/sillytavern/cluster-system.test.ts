/**
 * cluster-system.ts 测试
 * 覆盖: 集群形成 / HP比例 / 攻击次数 / 伤害修正 / 减员 / 意图免疫 / 范围结算
 */
import { describe, it, expect } from 'vitest';
import {
  canFormCluster,
  formClusterState,
  getClusterHpRatio,
  getClusterAttackCountByRatio,
  getClusterAttackCount,
  getClusterSurvivingCount,
  calcClusterDamageMultiplier,
  calcAoEClusterDamage,
  updateClusterAfterDamage,
  isClusterIntentionImmune,
  getClusterIntentionOverride,
  refreshClusterAttacks,
  isClusterEligible,
  formatClusterPanel,
  MIN_CLUSTER_SIZE,
  MAX_CLUSTER_TIER,
  CLUSTER_DAMAGE_MULTIPLIER,
  CLUSTER_ATTACK_COUNT_THRESHOLDS,
} from './cluster-system';

// ========== 集群形成判断 ==========

describe('canFormCluster', () => {
  it('≥3 个单位可以形成集群', () => {
    expect(canFormCluster(3)).toBe(true);
    expect(canFormCluster(5)).toBe(true);
    expect(canFormCluster(10)).toBe(true);
  });

  it('<3 个单位不能形成集群', () => {
    expect(canFormCluster(0)).toBe(false);
    expect(canFormCluster(1)).toBe(false);
    expect(canFormCluster(2)).toBe(false);
  });
});

describe('MIN_CLUSTER_SIZE', () => {
  it('最小集群规模为 3', () => {
    expect(MIN_CLUSTER_SIZE).toBe(3);
  });
});

// ========== 集群形成 ==========

describe('formClusterState', () => {
  it('3 个 T1 哥布林合并为集群', () => {
    const result = formClusterState('goblin_t1', 3, 50, 50);
    expect(result.cluster.initialCount).toBe(3);
    expect(result.cluster.currentCount).toBe(3);
    expect(result.cluster.clusterHp).toBe(150);   // 50 × 3
    expect(result.cluster.clusterMaxHp).toBe(150);
    expect(result.cluster.attacksPerRound).toBe(3); // HP=100% → 3次
    expect(result.reason).toContain('合并为集群');
  });

  it('5 个 T2 骷髅兵合并为集群', () => {
    const result = formClusterState('skeleton_t2', 5, 80);
    expect(result.cluster.initialCount).toBe(5);
    expect(result.cluster.currentCount).toBe(5);
    expect(result.cluster.clusterHp).toBe(400);   // 80 × 5
    expect(result.cluster.clusterMaxHp).toBe(400);
    expect(result.cluster.attacksPerRound).toBe(3); // HP=100% → 3次
  });

  it('数量不足时不形成集群', () => {
    const result = formClusterState('goblin_t1', 2, 50);
    expect(result.reason).toContain('不形成集群');
    expect(result.cluster.initialCount).toBe(2);
  });

  it('部分受伤的单位合并，HP 比例影响攻击次数', () => {
    // 3 个单位，每个 50/100 HP → 集群 150/300 = 50%
    const result = formClusterState('wounded', 3, 100, 50);
    expect(result.cluster.clusterHp).toBe(150);
    expect(result.cluster.clusterMaxHp).toBe(300);
    expect(result.cluster.attacksPerRound).toBe(2); // HP=50% → 2次
  });

  it('HP=30%时攻击次数为1', () => {
    const result = formClusterState('low', 3, 100, 30);
    expect(result.cluster.attacksPerRound).toBe(1);
  });

  it('HP=25%时攻击次数为1', () => {
    const result = formClusterState('lower', 3, 100, 25);
    expect(result.cluster.attacksPerRound).toBe(1);
  });
});

// ========== HP 比例计算 ==========

describe('getClusterHpRatio', () => {
  it('满血 → 1.0', () => {
    const cluster = formClusterState('test', 3, 100).cluster;
    expect(getClusterHpRatio(cluster)).toBe(1.0);
  });

  it('半血 → 0.5', () => {
    const cluster = formClusterState('test', 3, 100, 50).cluster;
    expect(getClusterHpRatio(cluster)).toBe(0.5);
  });

  it('空血 → 0', () => {
    const cluster = formClusterState('test', 3, 100, 0).cluster;
    expect(getClusterHpRatio(cluster)).toBe(0);
  });

  it('maxHp=0 → 0 (除零保护)', () => {
    const cluster = formClusterState('zero', 3, 0).cluster;
    expect(getClusterHpRatio(cluster)).toBe(0);
  });
});

// ========== 攻击次数 ==========

describe('getClusterAttackCountByRatio', () => {
  it('HP ≥ 80% → 3次', () => {
    expect(getClusterAttackCountByRatio(1.0)).toBe(3);
    expect(getClusterAttackCountByRatio(0.8)).toBe(3);
    expect(getClusterAttackCountByRatio(0.9)).toBe(3);
  });

  it('80% > HP ≥ 50% → 2次', () => {
    expect(getClusterAttackCountByRatio(0.79)).toBe(2);
    expect(getClusterAttackCountByRatio(0.5)).toBe(2);
    expect(getClusterAttackCountByRatio(0.65)).toBe(2);
  });

  it('HP < 50% → 1次', () => {
    expect(getClusterAttackCountByRatio(0.49)).toBe(1);
    expect(getClusterAttackCountByRatio(0.3)).toBe(1);
    expect(getClusterAttackCountByRatio(0.0)).toBe(1);
  });
});

describe('getClusterAttackCount', () => {
  it('使用 currentHp/maxHp 版本', () => {
    expect(getClusterAttackCount(300, 300)).toBe(3); // 100%
    expect(getClusterAttackCount(160, 200)).toBe(3); // 80% → 阈值正好 → 3次
    // 80% 刚好 → 3次
    expect(getClusterAttackCount(80, 100)).toBe(3);
    expect(getClusterAttackCount(79, 100)).toBe(2); // 79%
    expect(getClusterAttackCount(50, 100)).toBe(2); // 50%
    expect(getClusterAttackCount(49, 100)).toBe(1); // 49%
    expect(getClusterAttackCount(10, 100)).toBe(1); // 10%
  });

  it('maxHp=0 → 1次', () => {
    expect(getClusterAttackCount(0, 0)).toBe(1);
  });
});

describe('CLUSTER_ATTACK_COUNT_THRESHOLDS', () => {
  it('有 3 个阈值档位', () => {
    expect(CLUSTER_ATTACK_COUNT_THRESHOLDS).toHaveLength(3);
  });

  it('阈值档位正确', () => {
    expect(CLUSTER_ATTACK_COUNT_THRESHOLDS[0].attacks).toBe(3);
    expect(CLUSTER_ATTACK_COUNT_THRESHOLDS[0].minRatio).toBe(0.8);
    expect(CLUSTER_ATTACK_COUNT_THRESHOLDS[1].attacks).toBe(2);
    expect(CLUSTER_ATTACK_COUNT_THRESHOLDS[1].minRatio).toBe(0.5);
    expect(CLUSTER_ATTACK_COUNT_THRESHOLDS[2].attacks).toBe(1);
  });
});

// ========== 存活数量 ==========

describe('getClusterSurvivingCount', () => {
  it('满血 → 全部存活', () => {
    expect(getClusterSurvivingCount(10, 1000, 1000)).toBe(10);
  });

  it('50% HP → ceil(10 × 0.5) = 5', () => {
    expect(getClusterSurvivingCount(10, 500, 1000)).toBe(5);
  });

  it('30% HP → ceil(10 × 0.3) = 3', () => {
    expect(getClusterSurvivingCount(10, 300, 1000)).toBe(3);
  });

  it('11% HP → ceil(10 × 0.11) = 2', () => {
    expect(getClusterSurvivingCount(10, 110, 1000)).toBe(2);
  });

  it('1% HP → ceil(10 × 0.01) = 1 (最少1)', () => {
    expect(getClusterSurvivingCount(10, 10, 1000)).toBe(1);
  });

  it('0 HP → 0', () => {
    expect(getClusterSurvivingCount(10, 0, 1000)).toBe(0);
  });

  it('maxHp=0 → 0', () => {
    expect(getClusterSurvivingCount(10, 0, 0)).toBe(0);
  });

  it('数量不超过 initialCount', () => {
    // ceil(5 × 1.0) = 5, max 5
    expect(getClusterSurvivingCount(5, 500, 500)).toBe(5);
  });
});

// ========== 集群伤害修正 ==========

describe('calcClusterDamageMultiplier', () => {
  it('集群目标 → 伤害 ×1.5', () => {
    expect(calcClusterDamageMultiplier(100, true)).toBe(150);
    expect(calcClusterDamageMultiplier(200, true)).toBe(300);
    expect(calcClusterDamageMultiplier(33, true)).toBe(49); // floor(33*1.5)
  });

  it('非集群目标 → 伤害不变', () => {
    expect(calcClusterDamageMultiplier(100, false)).toBe(100);
    expect(calcClusterDamageMultiplier(200, false)).toBe(200);
  });

  it('CLUSTER_DAMAGE_MULTIPLIER = 1.5', () => {
    expect(CLUSTER_DAMAGE_MULTIPLIER).toBe(1.5);
  });
});

// ========== 范围技能 vs 集群 ==========

describe('calcAoEClusterDamage', () => {
  it('范围3 vs 集群5 → × min(3,5) = ×3', () => {
    expect(calcAoEClusterDamage(100, 3, 5)).toBe(300);
  });

  it('范围5 vs 集群3 → × min(5,3) = ×3', () => {
    expect(calcAoEClusterDamage(100, 5, 3)).toBe(300);
  });

  it('范围1 vs 集群10 → ×1', () => {
    expect(calcAoEClusterDamage(100, 1, 10)).toBe(100);
  });

  it('集群只剩1个 → ×1', () => {
    expect(calcAoEClusterDamage(100, 5, 1)).toBe(100);
  });
});

// ========== 集群减员 ==========

describe('updateClusterAfterDamage', () => {
  it('轻伤不减员', () => {
    const cluster = formClusterState('test', 10, 100).cluster; // 1000/1000
    const result = updateClusterAfterDamage(cluster, 50); // 950/1000 = 95%
    expect(result.cluster).not.toBeNull();
    expect(result.cluster!.currentCount).toBe(10); // ceil(10 × 0.95) = 10
    expect(result.cluster!.clusterHp).toBe(950);
    expect(result.casualtiesThisRound).toBe(0);
  });

  it('20%受伤减员', () => {
    const cluster = formClusterState('test', 10, 100).cluster; // 1000/1000
    const result = updateClusterAfterDamage(cluster, 250); // 750/1000 = 75%
    expect(result.cluster).not.toBeNull();
    expect(result.cluster!.currentCount).toBe(8); // ceil(10 × 0.75) = 8
    expect(result.casualtiesThisRound).toBe(2);  // 10 - 8
  });

  it('半血减员', () => {
    const cluster = formClusterState('test', 10, 100).cluster; // 1000/1000
    const result = updateClusterAfterDamage(cluster, 500); // 500/1000 = 50%
    expect(result.cluster!.currentCount).toBe(5);
    expect(result.casualtiesThisRound).toBe(5);
  });

  it('重伤减员 + 攻击次数下降', () => {
    const cluster = formClusterState('test', 10, 100).cluster; // 1000/1000
    const result = updateClusterAfterDamage(cluster, 700); // 300/1000 = 30%
    expect(result.cluster!.currentCount).toBe(3); // ceil(10 × 0.3) = 3
    expect(result.cluster!.attacksPerRound).toBe(1); // HP<50% → 1次
    expect(result.casualtiesThisRound).toBe(7);
  });

  it('全灭', () => {
    const cluster = formClusterState('test', 10, 100).cluster; // 1000/1000
    const result = updateClusterAfterDamage(cluster, 1100); // -100
    expect(result.cluster).toBeNull();
    expect(result.casualtiesThisRound).toBe(10);
    expect(result.hpPercentAfter).toBe(0);
  });

  it('恰好打死', () => {
    const cluster = formClusterState('test', 10, 100).cluster;
    const result = updateClusterAfterDamage(cluster, 1000);
    expect(result.cluster).toBeNull();
    expect(result.casualtiesThisRound).toBe(10);
  });

  it('HP降至1 → 存活1个', () => {
    const cluster = formClusterState('test', 10, 100).cluster; // 1000/1000
    const result = updateClusterAfterDamage(cluster, 999); // 1/1000 = 0.1%
    expect(result.cluster!.currentCount).toBe(1); // ceil(10 × 0.001) = 1
    expect(result.cluster!.clusterHp).toBe(1);
  });

  it('HP比例影响后续攻击次数', () => {
    // 初始: 10单位 × 100HP = 1000HP, 100% → 3次
    const cluster = formClusterState('test', 10, 100).cluster;
    expect(cluster.attacksPerRound).toBe(3);

    // 受到600伤害 → 400/1000 = 40% → 1次
    const result = updateClusterAfterDamage(cluster, 600);
    expect(result.cluster!.attacksPerRound).toBe(1);

    // 再受100伤害 → 300/1000 = 30% → 仍1次
    const result2 = updateClusterAfterDamage(result.cluster!, 100);
    expect(result2.cluster!.attacksPerRound).toBe(1);
  });
});

// ========== 集群意图免疫 ==========

describe('isClusterIntentionImmune', () => {
  it('集群始终免疫意图攻击', () => {
    expect(isClusterIntentionImmune()).toBe(true);
  });
});

describe('getClusterIntentionOverride', () => {
  it('返回意图重置信息', () => {
    const override = getClusterIntentionOverride();
    expect(override.coefficient).toBe(1.0);
    expect(override.extraEffects).toEqual([]);
    expect(override.narrativeNote).toContain('集群');
    expect(override.narrativeNote).toContain('重置为 1.0');
  });
});

// ========== 攻击次数刷新 ==========

describe('refreshClusterAttacks', () => {
  it('HP 下降后刷新攻击次数', () => {
    const cluster = formClusterState('test', 5, 100).cluster; // 500/500, 3次
    expect(cluster.attacksPerRound).toBe(3);

    // 模拟损伤后手动设置 HP
    const damaged = { ...cluster, clusterHp: 250 }; // 50% → 2次
    const refreshed = refreshClusterAttacks(damaged);
    expect(refreshed.attacksPerRound).toBe(2);
  });

  it('重伤后 → 1次', () => {
    const cluster = formClusterState('test', 5, 100).cluster;
    const damaged = { ...cluster, clusterHp: 100 }; // 20% → 1次
    const refreshed = refreshClusterAttacks(damaged);
    expect(refreshed.attacksPerRound).toBe(1);
  });
});

// ========== 集群资格判定 ==========

describe('isClusterEligible', () => {
  it('T1 + ≥3 → 可集群', () => {
    expect(isClusterEligible(1, 3)).toBe(true);
    expect(isClusterEligible(1, 10)).toBe(true);
  });

  it('T2 + ≥3 → 可集群', () => {
    expect(isClusterEligible(2, 3)).toBe(true);
    expect(isClusterEligible(2, 5)).toBe(true);
  });

  it('T3 + ≥3 → 可集群', () => {
    expect(isClusterEligible(3, 3)).toBe(true);
  });

  it('T4+ 不可集群 (个体过强)', () => {
    expect(isClusterEligible(4, 5)).toBe(false);
    expect(isClusterEligible(5, 10)).toBe(false);
    expect(isClusterEligible(6, 20)).toBe(false);
    expect(isClusterEligible(7, 100)).toBe(false);
  });

  it('数量不足不可集群', () => {
    expect(isClusterEligible(1, 2)).toBe(false);
    expect(isClusterEligible(2, 1)).toBe(false);
    expect(isClusterEligible(3, 0)).toBe(false);
  });

  it('MAX_CLUSTER_TIER = 3', () => {
    expect(MAX_CLUSTER_TIER).toBe(3);
  });
});

// ========== 面板格式化 ==========

describe('formatClusterPanel', () => {
  it('生成集群面板行', () => {
    const cluster = formClusterState('goblin', 5, 50).cluster;
    const panel = formatClusterPanel(cluster, '哥布林群');
    expect(panel).toContain('哥布林群 (5/5)');
    expect(panel).toContain('HP [250/250]');
    expect(panel).toContain('攻击×3');
  });

  it('受损集群面板包含当前存活数', () => {
    const cluster = formClusterState('goblin', 5, 100).cluster;
    const damaged = updateClusterAfterDamage(cluster, 400).cluster!; // 100/500
    const panel = formatClusterPanel(damaged, '哥布林群');
    expect(panel).toContain('(1/5)'); // ceil(5 × 0.2) = 1
    expect(panel).toContain('HP [100/500]');
    expect(panel).toContain('攻击×1');
  });
});
