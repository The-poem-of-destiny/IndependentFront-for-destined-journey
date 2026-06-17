/**
 * 🎮 战斗集成场景测试 — 模拟实际游玩流程
 *
 * 场景: 主角(T3剑士) + 队友(T2法师) 在森林中遭遇 8只哥布林侦察兵(T1)
 *
 * 本测试模拟 AI 调用 $combat API 的完整流程:
 *   $combat.initCombat() → 集群形成 → rollInitiative → 先攻排序
 *   → $combat.attack() (常规/范围/处决) → resolveAttack → 伤害管线 → 集群减员
 *   → 士气检测 → 处决判定 → endCombat
 *
 * 涉及模块:
 *   combat-intention  (意图解析)
 *   combat-damage     (8步伤害管线)
 *   combat-turn       (先攻回合)
 *   combat-panel      (面板生成)
 *   combat-resolver   ($combat API)
 *   cluster-system    (集群形成/减员/修正)
 *   morale-system     (士气状态机/处决条件)
 */
import { describe, it, expect } from 'vitest';
import type {
  CombatType,
  CombatState,
  CombatParticipant,
  DamageType,
} from './types';

// 战斗模块
import { parseIntentionFromInput, resolveIntention } from './combat-intention';
import type { IntentionCheckInput } from './combat-intention';
import {
  runDamagePipeline,
  performAttackCheck,
  checkStatusTrigger,
  getHitRating,
  type DamagePipelineInput,
} from './combat-damage';
import { rollInitiative, rollAndSortInitiative } from './combat-turn';
import { buildOverviewPanel, buildAttackPanel } from './combat-panel';
import { resolveAttack, initCombat, endCombat } from './combat-resolver';

// 集群系统 (统一从 cluster-system 导入，避免与 combat-damage 重复)
import {
  formClusterState,
  getClusterHpRatio,
  getClusterAttackCountByRatio,
  calcAoEClusterDamage,
  updateClusterAfterDamage,
  getClusterIntentionOverride,
  refreshClusterAttacks,
  isClusterEligible,
  canFormCluster,
  formatClusterPanel,
} from './cluster-system';

// 士气系统
import {
  checkMorale,
  isAutoTriggerType,
  isCheckTriggerType,
  getMoraleThreshold,
  getMoraleModifiers,
  canExecute,
  getExecutionModifiers,
  checkAllMorale,
} from './morale-system';

// ═══════════════════════════════════════════════════════════
// 场景设定工具
// ═══════════════════════════════════════════════════════════

function makeParticipant(overrides: Partial<CombatParticipant> & { characterId: string; name: string; side: 'ally' | 'enemy' }): CombatParticipant {
  return {
    characterId: overrides.characterId,
    name: overrides.name,
    tier: overrides.tier ?? 1,
    level: overrides.level ?? 3,
    attributes: overrides.attributes ?? { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    hp: overrides.hp ?? 100,
    maxHp: overrides.maxHp ?? 100,
    mp: overrides.mp ?? 50,
    maxMp: overrides.maxMp ?? 50,
    sp: overrides.sp ?? 50,
    maxSp: overrides.maxSp ?? 50,
    defense: overrides.defense ?? 10,
    dr: overrides.dr ?? 0,
    penetration: overrides.penetration ?? 0,
    hitBonus: overrides.hitBonus ?? 2,
    dodgeBonus: overrides.dodgeBonus ?? 0,
    speedModifiers: overrides.speedModifiers ?? [],
    fixedInitiativeBonus: overrides.fixedInitiativeBonus ?? 0,
    attacksRemaining: overrides.attacksRemaining ?? 1,
    actionsRemaining: overrides.actionsRemaining ?? 1,
    statusEffects: overrides.statusEffects ?? [],
    weaponAtk: overrides.weaponAtk ?? 5,
    side: overrides.side,
    canAct: overrides.canAct ?? true,
    morale: overrides.morale ?? 'steady',
  };
}

// ═══════════════════════════════════════════════════════════
// 固定测试数据
// ═══════════════════════════════════════════════════════════

const PLAYER = makeParticipant({
  characterId: 'player', name: '艾伦', side: 'ally',
  tier: 3, level: 12,
  attributes: { str: 14, dex: 15, con: 13, int: 10, spi: 12 },
  hp: 450, maxHp: 450, mp: 120, maxMp: 120, sp: 180, maxSp: 180,
  defense: 45, weaponAtk: 35, penetration: 0.15,
  hitBonus: 5, dodgeBonus: 3,
  speedModifiers: [0.1], fixedInitiativeBonus: 2,
});

const ALLY = makeParticipant({
  characterId: 'ally_mage', name: '莉亚', side: 'ally',
  tier: 2, level: 8,
  attributes: { str: 6, dex: 10, con: 8, int: 16, spi: 15 },
  hp: 200, maxHp: 200, mp: 350, maxMp: 350, sp: 100, maxSp: 100,
  defense: 20, weaponAtk: 8,
  hitBonus: 4, dodgeBonus: 1,
  speedModifiers: [0.05], fixedInitiativeBonus: 1,
});

const GOBLIN_TEMPLATE = {
  tier: 1, level: 3,
  attributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
  maxHp: 60, maxMp: 10, maxSp: 20,
  defense: 8, weaponAtk: 5,
  hitBonus: 1, dodgeBonus: 2,
  speedModifiers: [0.05], fixedInitiativeBonus: 0,
};

// ═══════════════════════════════════════════════════════════
// 第一章: 遭遇战 — 集群形成
// ═══════════════════════════════════════════════════════════

describe('🎮 第一章: 森林遭遇战 — 集群形成', () => {
  it('场景设定: 8只哥布林 → 判定可集群化', () => {
    // AI 检测到 8 只 T1 哥布林 → isClusterEligible 判定
    expect(isClusterEligible(1, 8)).toBe(true);
    expect(canFormCluster(8)).toBe(true);

    // T4 敌人不能集群
    expect(isClusterEligible(4, 5)).toBe(false);

    // 不足3只不能集群
    expect(isClusterEligible(1, 2)).toBe(false);
  });

  it('战术分群: 前排5只 + 侧翼3只', () => {
    const clusterA = formClusterState('goblin_scout', 5, GOBLIN_TEMPLATE.maxHp);
    const clusterB = formClusterState('goblin_scout', 3, GOBLIN_TEMPLATE.maxHp);

    expect(clusterA.cluster.initialCount).toBe(5);
    expect(clusterA.cluster.currentCount).toBe(5);
    expect(clusterA.cluster.clusterHp).toBe(300);    // 60 × 5
    expect(clusterA.cluster.clusterMaxHp).toBe(300);
    expect(clusterA.cluster.attacksPerRound).toBe(3); // 100% HP → 3次

    expect(clusterB.cluster.initialCount).toBe(3);
    expect(clusterB.cluster.clusterHp).toBe(180);     // 60 × 3

    // 面板输出
    expect(formatClusterPanel(clusterA.cluster, '哥布林群A')).toContain('(5/5)');
    expect(formatClusterPanel(clusterA.cluster, '哥布林群A')).toContain('HP [300/300]');
    expect(formatClusterPanel(clusterB.cluster, '哥布林群B')).toContain('(3/3)');
    expect(formatClusterPanel(clusterB.cluster, '哥布林群B')).toContain('HP [180/180]');
  });

  it('战斗类型判定: 野外遭遇 → 标准战斗', () => {
    const combatType: CombatType = '标准';
    expect(getMoraleThreshold('标准')).toBe(0.30);
    expect(isAutoTriggerType('标准')).toBe(false);
    expect(isCheckTriggerType('标准')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════
// 第二章: 先攻排序
// ═══════════════════════════════════════════════════════════

describe('🎮 第二章: 先攻排序 — 第1回合', () => {
  it('rollInitiative: 玩家先攻 = floor(15×1.1) + 14 + 2 = 32', () => {
    const turn = rollInitiative(PLAYER, 14);
    expect(turn.totalInitiative).toBe(32);
    expect(turn.characterId).toBe('player');
  });

  it('rollInitiative: 队友先攻 = floor(10×1.05) + 8 + 1 = 19', () => {
    const turn = rollInitiative(ALLY, 8);
    expect(turn.totalInitiative).toBe(19);
  });

  it('rollAndSortInitiative: 全队排序 → 艾伦 > 莉亚', () => {
    // 模拟哥布林集群代表 (集群不参与先攻排序，用头目代替)
    const goblinLeader = makeParticipant({
      characterId: 'goblin_leader', name: '哥布林头目', side: 'enemy',
      tier: 1, level: 4,
      attributes: { str: 9, dex: 13, con: 8, int: 6, spi: 5 },
      hp: 80, maxHp: 80, speedModifiers: [0.05],
    });

    const turnOrder = rollAndSortInitiative(
      [PLAYER, ALLY, goblinLeader],
      [14, 8, 12], // d20 骰值
    );

    // 按先攻排序: player(32) > goblin_leader(18) > ally(19)
    // 实际: goblin (13×1.05)+12+0 = floor(13.65)+12 = 13+12=25
    // 重算: player=32, goblin=25, ally=19
    expect(turnOrder.sequence[0].characterId).toBe('player');
    expect(turnOrder.round).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 第三章: 玩家攻击集群 — 完整 resolveAttack 管线
// ═══════════════════════════════════════════════════════════

describe('🎮 第三章: 玩家攻击集群 — resolveAttack 完整管线', () => {
  it('Step 1: AI 声明攻击 — "砍向哥布林群" → 常规意图', () => {
    const intention = parseIntentionFromInput('艾伦挥剑砍向哥布林群');
    expect(intention).toBe('常规');

    // 集群意图免疫检查
    const override = getClusterIntentionOverride();
    expect(override.coefficient).toBe(1.0);
    expect(override.narrativeNote).toContain('集群');
  });

  it('Step 2: 攻击检定 — T3 vs T1 → 优势 + 闪避无效', () => {
    const check = performAttackCheck({
      d20Roll: 16,
      attackerTier: 3,
      defenderTier: 1,
      hitBonus: 5,
      defenderDodge: 2,
      dodgeNegated: false,
    });

    // T3 > T1+1 (3 > 2) → 闪避自动无效
    expect(check.effectiveDodge).toBe(0);
    expect(check.dodgeNegated).toBe(true);
    // 优势
    expect(check.advantage).toBe(true);
    // 检定总值 ≥ 16+5 = 21 → 暴击(1.3)
    expect(check.rating.level).toBe('暴击');
    expect(check.rating.coefficient).toBe(1.3);
  });

  it('Step 3: 伤害管线 — 完整的 8 步计算', () => {
    const input: DamagePipelineInput = {
      relevantAttribute: 14,
      attackerTier: 3,
      skillPower: 60,      // 斩击
      weaponAtk: 35,        // 精钢长剑
      multiHitCount: 1,
      defenderDefense: 8,
      penetrationRate: 0.15,
      damageType: '物理',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.3,
      intentionCoefficient: 1.0,
      drRate: 0,
      isClusterTarget: true,
      currentHp: 300,
    };

    const breakdown = runDamagePipeline(input);

    // Step 1: 14×10×4.0 + 60 + 35 = 560 + 95 = 655
    expect(breakdown.initialDamage).toBe(655);
    // Step 3: 穿透 → 有效防 = 8 × 0.85 = 6
    expect(breakdown.penetration.effectiveDef).toBe(6);
    // Step 8: 集群 ×1.5 生效
    expect(breakdown.finalDamage).toBeGreaterThan(0);

    // 对比无集群修正的伤害
    const withoutCluster = runDamagePipeline({ ...input, isClusterTarget: false });
    expect(breakdown.finalDamage).toBeGreaterThan(withoutCluster.finalDamage);
  });

  it('Step 4: 集群减员 — 伤害后存活数更新', () => {
    const clusterA = formClusterState('goblin_scout', 5, 60).cluster;

    const input: DamagePipelineInput = {
      relevantAttribute: 14, attackerTier: 3, skillPower: 60, weaponAtk: 35,
      multiHitCount: 1, defenderDefense: 8, penetrationRate: 0.15,
      damageType: '物理',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.3, intentionCoefficient: 1.0,
      drRate: 0, isClusterTarget: true, currentHp: 300,
    };

    const damage = runDamagePipeline(input).finalDamage;
    const result = updateClusterAfterDamage(clusterA, damage);

    if (result.cluster) {
      expect(result.cluster.clusterHp).toBeLessThan(300);
      expect(result.cluster.currentCount).toBeLessThanOrEqual(5);
      // 攻击次数随 HP 变化
      const hpRatio = getClusterHpRatio(result.cluster);
      expect(result.cluster.attacksPerRound).toBe(getClusterAttackCountByRatio(hpRatio));
    }
  });

  it('Step 5: 状态施加 — 暴击必触发', () => {
    const result = checkStatusTrigger(1.3, 14, 8, 16, 5, false);
    expect(result.triggered).toBe(true);
    expect(result.narrative).toContain('暴击');
  });
});

// ═══════════════════════════════════════════════════════════
// 第四章: 集群反击 — HP%决定攻击次数
// ═══════════════════════════════════════════════════════════

describe('🎮 第四章: 集群反击 — 攻击次数动态变化', () => {
  it('满血 → 3次', () => {
    const cluster = formClusterState('goblin', 5, 60).cluster;
    expect(cluster.attacksPerRound).toBe(3);
  });

  it('HP=75% → 2次 (< 80%)', () => {
    const damaged = { ...formClusterState('goblin', 5, 60).cluster, clusterHp: 225 };
    expect(refreshClusterAttacks(damaged).attacksPerRound).toBe(2);
  });

  it('HP=50% → 2次', () => {
    const damaged = { ...formClusterState('goblin', 5, 60).cluster, clusterHp: 150 };
    expect(refreshClusterAttacks(damaged).attacksPerRound).toBe(2);
  });

  it('HP=35% → 1次', () => {
    const damaged = { ...formClusterState('goblin', 5, 60).cluster, clusterHp: 105 };
    expect(refreshClusterAttacks(damaged).attacksPerRound).toBe(1);
  });

  it('HP=10% → 仅1只存活, 1次攻击', () => {
    const cluster = formClusterState('goblin', 5, 60).cluster;
    const result = updateClusterAfterDamage(cluster, 270);
    expect(result.cluster!.currentCount).toBe(1);
    expect(result.cluster!.attacksPerRound).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════
// 第五章: 法师范围攻击 — AoE vs 集群
// ═══════════════════════════════════════════════════════════

describe('🎮 第五章: 法师范围攻击 — 火球术 vs 集群', () => {
  it('火球术(范围:3) vs 集群B(3只)', () => {
    const clusterB = formClusterState('goblin_scout', 3, 60).cluster;

    // 单体伤害 = 16×10×2.8 + 80 + 8 = 448+88 = 536
    const singleInput: DamagePipelineInput = {
      relevantAttribute: 16, attackerTier: 2, skillPower: 80, weaponAtk: 8,
      multiHitCount: 1, defenderDefense: 8, penetrationRate: 0,
      damageType: '能量',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.0, intentionCoefficient: 1.0,
      drRate: 0, isClusterTarget: true, currentHp: 180,
    };

    const singleDamage = runDamagePipeline(singleInput).finalDamage;

    // AoE: × min(范围3, 集群数3) = ×3
    const totalAoE = calcAoEClusterDamage(singleDamage, 3, 3);
    expect(totalAoE).toBe(singleDamage * 3);

    // 应用 AoE 伤害
    const result = updateClusterAfterDamage(clusterB, totalAoE);
    // 3只哥布林总HP=180, 单体伤害~500+, AoE总伤害>1500 → 全灭
    expect(result.cluster).toBeNull();
    expect(result.casualtiesThisRound).toBe(3);
  });

  it('范围5 vs 集群只剩1只 → ×min(5,1)=×1', () => {
    expect(calcAoEClusterDamage(100, 5, 1)).toBe(100);
  });
});

// ═══════════════════════════════════════════════════════════
// 第六章: 士气检测 — 6种战斗类型全覆盖
// ═══════════════════════════════════════════════════════════

describe('🎮 第六章: 士气检测 — 全战斗类型覆盖', () => {
  it('标准战斗 HP=25% → d20=8 < 12 → routing', () => {
    const result = checkMorale(0.25, '标准', 8);
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('check');
    expect(result.moraleState).toBe('routing');
    expect(result.outcome).toBeTruthy();
  });

  it('标准战斗 HP=25% → d20=15 ≥ 12 → shaken (未崩溃)', () => {
    const result = checkMorale(0.25, '标准', 15);
    expect(result.triggered).toBe(false);
    expect(result.moraleState).toBe('shaken');
  });

  it('切磋 HP=35% < 40% → 自动 wavering', () => {
    const result = checkMorale(0.35, '切磋');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
    expect(result.moraleState).toBe('wavering');
  });

  it('死斗 HP=8% < 10% → d20=3 < 12 → routing', () => {
    const result = checkMorale(0.08, '死斗', 3);
    expect(result.triggered).toBe(true);
    expect(result.moraleState).toBe('routing');
  });

  it('压制 HP=45% < 50% → 自动 wavering', () => {
    const result = checkMorale(0.45, '压制');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
  });

  it('守卫 HP=30% < 35% → d20=12 ≥ 12 → 未崩溃', () => {
    const result = checkMorale(0.30, '守卫', 12);
    expect(result.triggered).toBe(false);
    expect(result.moraleState).toBe('shaken');
  });

  it('竞技 HP=25% < 30% → 自动 wavering', () => {
    const result = checkMorale(0.25, '竞技');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
  });
});

// ═══════════════════════════════════════════════════════════
// 第七章: 处决 — 崩溃目标的终结
// ═══════════════════════════════════════════════════════════

describe('🎮 第七章: 处决 — 战意崩溃目标的处决流程', () => {
  it('wavering → 可处决, 闪避无效, 无法行动', () => {
    const mods = getMoraleModifiers('wavering');
    expect(mods.canBeExecuted).toBe(true);
    expect(mods.dodgeNegated).toBe(true);
    expect(mods.canAct).toBe(false);
    expect(mods.attackPenalty).toBe(-4);
  });

  it('routing → 可处决, 保底暴击', () => {
    expect(canExecute('routing')).toBe(true);
    const exec = getExecutionModifiers();
    expect(exec.intentionAutoSuccess).toBe(true);
    expect(exec.dodgeNegated).toBe(true);
    expect(exec.minRatingCoefficient).toBe(1.3);
  });

  it('steady/shaken → 不可处决', () => {
    expect(canExecute('steady')).toBe(false);
    expect(canExecute('shaken')).toBe(false);
  });

  it('处决意图判定 — resolveIntention 自动成功', () => {
    const input: IntentionCheckInput = {
      intentionLevel: '处决',
      attackerTier: 3,
      defenderTier: 1,
      defenderIncapacitated: false,
      defenderMorale: 'routing',
      isExecutionIntent: true,
      nonLethal: false,
      attackerD20: 14,
      defenderD20: 8,
    };

    const result = resolveIntention(input);
    expect(result.verdict).toBe('自动成功');
    expect(result.coefficient).toBe(1.3);
    expect(result.narrativeNote).toContain('自动成功');
  });

  it('常规意图 vs routing目标 — 正常检定', () => {
    const input: IntentionCheckInput = {
      intentionLevel: '常规',
      attackerTier: 3,
      defenderTier: 1,
      defenderIncapacitated: false,
      defenderMorale: 'routing',
      isExecutionIntent: false,
      nonLethal: false,
      attackerD20: 14,
      defenderD20: 8,
    };

    const result = resolveIntention(input);
    // 常规意图不需要对抗检定
    expect(result.verdict).toBe('无需判定');
    expect(result.coefficient).toBe(1.0);
  });
});

// ═══════════════════════════════════════════════════════════
// 第八章: 全流程走通 — 端到端集成
// ═══════════════════════════════════════════════════════════

describe('🎮 第八章: 完整战斗流程 — 从遇敌到结算', () => {
  it('完整流程: 8只哥布林 → 集群 → 3回合 → 敌方崩溃/全灭', () => {
    const combatType: CombatType = '标准';

    // ═══ 集群形成 ═══
    const clusterA = formClusterState('goblin_scout', 5, 60).cluster;
    const clusterB = formClusterState('goblin_scout', 3, 60).cluster;

    expect(clusterA.clusterHp + clusterB.clusterHp).toBe(480); // 300 + 180

    // ═══ 回合 1: 玩家攻击集群A ═══
    const r1Input: DamagePipelineInput = {
      relevantAttribute: 14, attackerTier: 3, skillPower: 60, weaponAtk: 35,
      multiHitCount: 1, defenderDefense: 8, penetrationRate: 0.15,
      damageType: '物理',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.3, intentionCoefficient: 1.0,
      drRate: 0, isClusterTarget: true, currentHp: 300,
    };
    const r1Damage = runDamagePipeline(r1Input).finalDamage;
    const aAfterR1 = updateClusterAfterDamage(clusterA, r1Damage);

    expect(aAfterR1.cluster ? aAfterR1.cluster.clusterHp : 0).toBeLessThan(300);

    // 刷新攻击次数
    const aRefreshed = aAfterR1.cluster ? refreshClusterAttacks(aAfterR1.cluster) : null;
    if (aRefreshed) {
      expect(aRefreshed.attacksPerRound).toBeGreaterThanOrEqual(1);
    }

    // ═══ 回合 2: 法师 AoE 火球术 vs 集群A ═══
    const r2SingleInput: DamagePipelineInput = {
      relevantAttribute: 16, attackerTier: 2, skillPower: 80, weaponAtk: 8,
      multiHitCount: 1, defenderDefense: 8, penetrationRate: 0,
      damageType: '能量',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.0, intentionCoefficient: 1.0,
      drRate: 0, isClusterTarget: true,
      currentHp: aAfterR1.cluster?.clusterHp ?? 300,
    };
    const r2Single = runDamagePipeline(r2SingleInput).finalDamage;
    const currentA = aAfterR1.cluster?.currentCount ?? 5;
    const aoeDmg = calcAoEClusterDamage(r2Single, 3, currentA);
    const aAfterR2 = aAfterR1.cluster
      ? updateClusterAfterDamage(aAfterR1.cluster, aoeDmg)
      : { cluster: null, casualtiesThisRound: 0, hpPercentBefore: 0, hpPercentAfter: 0 };

    // ═══ 士气检测 (回合2结束) ═══
    const moraleB = checkMorale(1.0, combatType, 18); // 集群B满血
    expect(moraleB.triggered).toBe(false);

    // ═══ 回合 3: 玩家攻击集群B ═══
    const r3Input: DamagePipelineInput = {
      relevantAttribute: 14, attackerTier: 3, skillPower: 60, weaponAtk: 35,
      multiHitCount: 1, defenderDefense: 8, penetrationRate: 0.15,
      damageType: '物理',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.3, intentionCoefficient: 1.0,
      drRate: 0, isClusterTarget: true, currentHp: 180,
    };
    const r3Damage = runDamagePipeline(r3Input).finalDamage;
    const bAfterR3 = updateClusterAfterDamage(clusterB, r3Damage);

    // ═══ 回合3结束: 士气检测 — 集群B可能崩溃 ═══
    const bHpRatio = bAfterR3.cluster
      ? bAfterR3.cluster.clusterHp / bAfterR3.cluster.clusterMaxHp
      : 0;
    const finalMorale = checkMorale(bHpRatio, combatType, 8); // d20=8 < 12

    if (finalMorale.triggered) {
      expect(finalMorale.moraleState).toBe('routing');
      expect(canExecute('routing')).toBe(true);
    }

    // ═══ 战斗结算 ═══
    const totalInitial = clusterA.initialCount + clusterB.initialCount;
    const aSurvivors = aAfterR2.cluster?.currentCount ?? 0;
    const bSurvivors = bAfterR3.cluster?.currentCount ?? 0;
    expect(aSurvivors + bSurvivors).toBeLessThan(totalInitial);
  });
});

// ═══════════════════════════════════════════════════════════
// 第九章: $combat API 实际调用模式
// ═══════════════════════════════════════════════════════════

describe('🎮 第九章: $combat.initCombat / resolveAttack / endCombat', () => {
  it('$combat.initCombat() — AI 初始化战斗', () => {
    const combat = initCombat({
      combatType: '标准',
      allies: [PLAYER, ALLY],
      enemies: [
        makeParticipant({ characterId: 'clusterA', name: '哥布林群A', side: 'enemy', tier: 1, hp: 300, maxHp: 300, attributes: GOBLIN_TEMPLATE.attributes, defense: 8, weaponAtk: 5, hitBonus: 1, dodgeBonus: 2 }),
        makeParticipant({ characterId: 'clusterB', name: '哥布林群B', side: 'enemy', tier: 1, hp: 180, maxHp: 180, attributes: GOBLIN_TEMPLATE.attributes, defense: 8, weaponAtk: 5, hitBonus: 1, dodgeBonus: 2 }),
      ],
      environment: '迷雾森林 - 清晨林间空地',
      d20Rolls: [14, 8, 12, 5],
    });

    expect(combat.combatId).toContain('combat_');
    expect(combat.combatType).toBe('标准');
    expect(combat.status).toBe('active');
    expect(combat.round).toBe(1);
    expect(combat.environment).toContain('迷雾森林');
    expect(combat.participants).toHaveLength(4);
    // 先攻自动排序
    expect(combat.turnOrder.length).toBe(4);
  });

  it('$combat.resolveAttack() — AI 调用攻击的完整管线', () => {
    // 先创建战斗状态
    const combat = initCombat({
      combatType: '标准',
      allies: [PLAYER],
      enemies: [
        makeParticipant({ characterId: 'clusterA', name: '哥布林群A', side: 'enemy', tier: 1, hp: 300, maxHp: 300, attributes: GOBLIN_TEMPLATE.attributes, defense: 8, weaponAtk: 5, hitBonus: 1, dodgeBonus: 2 }),
      ],
      environment: '迷雾森林',
      d20Rolls: [14, 12],
    });

    // AI 调用: $combat.attack({ combat, attackerId: 'player', defenderId: 'clusterA', ... })
    const result = resolveAttack({
      combat,
      attackerId: 'player',
      defenderId: 'clusterA',
      userInput: '砍向哥布林群',
      action: 'attack',
      skillName: '斩击',
      skillPower: 60,
      weaponName: '精钢长剑',
      weaponAtk: 35,
      relevantAttribute: 'str',
      relevantAttributeValue: 14,
      damageType: '物理',
      d20Attack: 16,
      d20Intention: 14,
      d20Status: 16,
      costs: { sp: 15 },
    });

    // 验证结果完整性
    expect(result.request.action).toBe('attack');
    expect(result.intention.coefficient).toBe(1.0); // 集群意图免疫
    expect(result.attackRoll.checkValue).toBeGreaterThan(0);
    expect(result.damage.finalDamage).toBeGreaterThan(0);
    expect(result.patches.length).toBeGreaterThan(0);
    expect(result.panelLines.length).toBeGreaterThan(0);
    expect(result.description.length).toBeGreaterThan(0);
  });

  it('$combat.endCombat() — 战斗结束', () => {
    const combat = initCombat({
      combatType: '标准',
      allies: [PLAYER],
      enemies: [],
      environment: '迷雾森林',
      d20Rolls: [14],
    });

    const ended = endCombat(combat, 'ally');
    expect(ended.status).toBe('ended');
    expect(ended.winner).toBe('ally');
  });
});

// ═══════════════════════════════════════════════════════════
// 第十章: 面板生成 — AI 可见的战斗信息
// ═══════════════════════════════════════════════════════════

describe('🎮 第十章: <action_info> 面板生成', () => {
  it('buildOverviewPanel: 战况总览包含所有参战者', () => {
    const combat = initCombat({
      combatType: '标准',
      allies: [PLAYER, ALLY],
      enemies: [
        makeParticipant({ characterId: 'clusterA', name: '哥布林群A', side: 'enemy', tier: 1, hp: 300, maxHp: 300, attributes: GOBLIN_TEMPLATE.attributes }),
        makeParticipant({ characterId: 'clusterB', name: '哥布林群B', side: 'enemy', tier: 1, hp: 180, maxHp: 180, attributes: GOBLIN_TEMPLATE.attributes }),
      ],
      environment: '迷雾森林 - 20m距离',
      d20Rolls: [14, 8, 12, 5],
    });

    const panel = buildOverviewPanel(combat);
    expect(panel).toContain('<action_info>');
    expect(panel).toContain('战况总览');
    expect(panel).toContain('回合: 1');
    expect(panel).toContain('标准');
    expect(panel).toContain('艾伦');
    expect(panel).toContain('莉亚');
    expect(panel).toContain('哥布林群A');
    expect(panel).toContain('哥布林群B');
    expect(panel).toContain('HP');
  });

  it('buildAttackPanel: 攻击行动面板包含伤害管线', () => {
    const combat = initCombat({
      combatType: '标准',
      allies: [PLAYER],
      enemies: [
        makeParticipant({ characterId: 'clusterA', name: '哥布林群A', side: 'enemy', tier: 1, hp: 300, maxHp: 300, attributes: GOBLIN_TEMPLATE.attributes }),
      ],
      environment: '迷雾森林',
      d20Rolls: [14, 12],
    });

    const result = resolveAttack({
      combat,
      attackerId: 'player',
      defenderId: 'clusterA',
      userInput: '砍向哥布林群',
      action: 'attack',
      skillName: '斩击',
      skillPower: 60,
      weaponName: '精钢长剑',
      weaponAtk: 35,
      relevantAttribute: 'str',
      relevantAttributeValue: 14,
      damageType: '物理',
      d20Attack: 16,
      d20Intention: 14,
      d20Status: 16,
    });

    // panelLines 由 resolveAttack 内部生成
    expect(result.panelLines.length).toBeGreaterThan(0);
    const panel = result.panelLines.join('\n');
    expect(panel).toContain('<action_info>');
    expect(panel).toContain('攻击行动');
    expect(panel).toContain('艾伦');
    expect(panel).toContain('哥布林群A');
  });
});

// ═══════════════════════════════════════════════════════════
// 第十一章: 批量士气检测
// ═══════════════════════════════════════════════════════════

describe('🎮 第十一章: 批量士气检测 — 战后状态检查', () => {
  it('检测所有非user单位的士气', () => {
    const participants = [
      { id: 'user', name: '艾伦', hp: 300, maxHp: 450, isUser: true },
      { id: 'ally', name: '莉亚', hp: 150, maxHp: 200, isUser: false },
      { id: 'clusterA', name: '哥布林群A', hp: 75, maxHp: 300, isUser: false }, // 25%
      { id: 'clusterB', name: '哥布林群B', hp: 30, maxHp: 180, isUser: false },  // 17%
    ];

    const results = checkAllMorale(participants, '标准', [10, 10, 5, 9]);
    // 用户不检测
    // 莉亚: 75% > 30% → 不触发
    // clusterA: 25% < 30%, d20=5 < 12 → routing
    // clusterB: 17% < 30%, d20=9 < 12 → routing
    expect(results).toHaveLength(2);
    expect(results.every(r => r.result.moraleState === 'routing')).toBe(true);
  });

  it('全部高于阈值 → 无人触发', () => {
    const participants = [
      { id: 'e1', name: '敌人A', hp: 80, maxHp: 100, isUser: false },
      { id: 'e2', name: '敌人B', hp: 70, maxHp: 100, isUser: false },
    ];
    const results = checkAllMorale(participants, '压制', [10, 10]);
    expect(results).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 第十二章: 全战斗类型士气覆盖
// ═══════════════════════════════════════════════════════════

describe('🎮 第十二章: 6种战斗类型 × 士气交互', () => {
  const cases: Array<{ type: CombatType; threshold: number; isAuto: boolean }> = [
    { type: '切磋', threshold: 0.40, isAuto: true },
    { type: '竞技', threshold: 0.30, isAuto: true },
    { type: '压制', threshold: 0.50, isAuto: true },
    { type: '死斗', threshold: 0.10, isAuto: false },
    { type: '标准', threshold: 0.30, isAuto: false },
    { type: '守卫', threshold: 0.35, isAuto: false },
  ];

  for (const c of cases) {
    it(`${c.type}: 阈值=${(c.threshold * 100).toFixed(0)}%, ${c.isAuto ? '自动' : '需检定'}`, () => {
      expect(getMoraleThreshold(c.type)).toBe(c.threshold);
      expect(isAutoTriggerType(c.type)).toBe(c.isAuto);
      expect(isCheckTriggerType(c.type)).toBe(!c.isAuto);

      // HP高于阈值 → 不触发
      const above = checkMorale(c.threshold + 0.05, c.type);
      expect(above.triggered).toBe(false);
      expect(above.moraleState).toBe('steady');

      // HP低于阈值 → 触发 (或检定)
      const below = checkMorale(c.threshold - 0.05, c.type, 5);
      if (c.isAuto) {
        expect(below.triggerType).toBe('auto');
      } else {
        expect(below.triggerType).toBe('check');
        // d20=5 < 12 → 崩溃
        expect(below.triggered).toBe(true);
      }
    });
  }
});
