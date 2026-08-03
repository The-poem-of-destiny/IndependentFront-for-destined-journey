/**
 * 🎮 战斗集成场景测试 — 模拟实际游玩流程
 *
 * 场景: 主角(T3剑士) + 队友(T2法师) 在森林中遭遇 8只哥布林侦察兵(T1)
 *
 * M5-PR2 后 v2 战斗运行时（combat-resolver 的 $combat API / resolveAttack / initCombat /
 * endCombat）已退役删除。原第九章/第十章（走 $combat 编排）随删除一并移除。
 *
 * 本文件覆盖**存活的 v2 纯计算**（仍被 v3 内核使用的数值/规则部分）:
 *   - 意图解析 → resolveAttack → 伤害管线
 *   - 士气检测 → 处决判定
 *
 * 涉及模块（全部保留）:
 *   combat-intention  (意图解析)
 *   combat-damage     (8步伤害管线)
 *   combat-turn       (先攻回合)
 *   morale-system     (士气状态机/处决条件)
 */
import { describe, it, expect } from 'vitest';
import type { CombatType, CombatState, CombatParticipant, DamageType } from './types';

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

function makeParticipant(
  overrides: Partial<CombatParticipant> & {
    characterId: string;
    name: string;
    side: 'ally' | 'enemy';
  },
): CombatParticipant {
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
  characterId: 'player',
  name: '艾伦',
  side: 'ally',
  tier: 3,
  level: 12,
  attributes: { str: 14, dex: 15, con: 13, int: 10, spi: 12 },
  hp: 450,
  maxHp: 450,
  mp: 120,
  maxMp: 120,
  sp: 180,
  maxSp: 180,
  defense: 45,
  weaponAtk: 35,
  penetration: 0.15,
  hitBonus: 5,
  dodgeBonus: 3,
  speedModifiers: [0.1],
  fixedInitiativeBonus: 2,
});

const ALLY = makeParticipant({
  characterId: 'ally_mage',
  name: '莉亚',
  side: 'ally',
  tier: 2,
  level: 8,
  attributes: { str: 6, dex: 10, con: 8, int: 16, spi: 15 },
  hp: 200,
  maxHp: 200,
  mp: 350,
  maxMp: 350,
  sp: 100,
  maxSp: 100,
  defense: 20,
  weaponAtk: 8,
  hitBonus: 4,
  dodgeBonus: 1,
  speedModifiers: [0.05],
  fixedInitiativeBonus: 1,
});

const GOBLIN_TEMPLATE = {
  tier: 1,
  level: 3,
  attributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
  maxHp: 60,
  maxMp: 10,
  maxSp: 20,
  defense: 8,
  weaponAtk: 5,
  hitBonus: 1,
  dodgeBonus: 2,
  speedModifiers: [0.05],
  fixedInitiativeBonus: 0,
};

// ═══════════════════════════════════════════════════════════
// 第一章: 遭遇战 — 集群形成
// ═══════════════════════════════════════════════════════════

describe('🎮 第一章: 遭遇战 — 战斗类型与士气阈值', () => {
  it('战斗类型判定: 野外遭遇 → 标准战斗', () => {
    const combatType: CombatType = '标准';
    expect(getMoraleThreshold('标准')).toBe(0.3);
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
      characterId: 'goblin_leader',
      name: '哥布林头目',
      side: 'enemy',
      tier: 1,
      level: 4,
      attributes: { str: 9, dex: 13, con: 8, int: 6, spi: 5 },
      hp: 80,
      maxHp: 80,
      speedModifiers: [0.05],
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

describe('🎮 第三章: 玩家攻击哥布林 — 意图/检定/伤害管线', () => {
  it('Step 1: AI 声明攻击 — "艾伦挥剑砍向哥布林群" → 常规意图', () => {
    const intention = parseIntentionFromInput('艾伦挥剑砍向哥布林群');
    expect(intention).toBe('常规');
  });

  it('Step 2: 攻击检定 — T3 vs T1 → 优势 + 闪避无效', () => {
    const check = performAttackCheck({
      // v3 M0: 传两颗骰（架构 §1.4 M-5）。传同值 16 等效 v2 行为下界，
      // max(16,16)=16 → 检定值 16+5-0=21 → 暴击(1.3)。
      rolls: [16, 16],
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
      skillPower: 60, // 斩击
      weaponAtk: 35, // 精钢长剑
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

  it('Step 5: 状态施加 — 暴击必触发', () => {
    const result = checkStatusTrigger(1.3, 14, 8, 16, 5, false);
    expect(result.triggered).toBe(true);
    expect(result.narrative).toContain('暴击');
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
    const result = checkMorale(0.3, '守卫', 12);
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
  it('完整流程: 遇敌 → 攻击检定 → 伤害 → 士气崩溃 → 处决', () => {
    const combatType: CombatType = '标准';

    // ═══ 回合 1: 玩家攻击哥布林 ═══
    const r1Input: DamagePipelineInput = {
      relevantAttribute: 14,
      attackerTier: 3,
      skillPower: 60,
      weaponAtk: 35,
      multiHitCount: 1,
      defenderDefense: 8,
      penetrationRate: 0.15,
      damageType: '物理',
      defenderAttributes: { str: 8, dex: 12, con: 7, int: 5, spi: 4 },
      ratingCoefficient: 1.3,
      intentionCoefficient: 1.0,
      drRate: 0,
      isClusterTarget: false,
      currentHp: 60,
    };
    const r1Damage = runDamagePipeline(r1Input).finalDamage;
    // 高额伤害直接把哥布林 HP 打到 0 以下 → 战意崩溃
    expect(r1Damage).toBeGreaterThan(60);

    // ═══ 士气检测：敌方受重创 → 崩溃/溃逃 ═══
    const moraleAfter = checkMorale(0.05, combatType, 8); // HP≈5%, d20=8 < 12
    expect(moraleAfter.triggered).toBe(true);
    expect(moraleAfter.moraleState).toBe('routing');

    // ═══ 处决：routing 目标可被终结 ═══
    expect(canExecute('routing')).toBe(true);
    const exec = getExecutionModifiers();
    expect(exec.intentionAutoSuccess).toBe(true);
    expect(exec.minRatingCoefficient).toBe(1.3);

    // ═══ 处决意图判定：routing 目标 → 自动成功 ═══
    const execInput: IntentionCheckInput = {
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
    const execResult = resolveIntention(execInput);
    expect(execResult.verdict).toBe('自动成功');
    expect(execResult.coefficient).toBe(1.3);

    // ═══ 战斗结算：敌方崩溃 → 胜利 ═══
    expect(getMoraleThreshold(combatType)).toBe(0.3);
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
      { id: 'clusterB', name: '哥布林群B', hp: 30, maxHp: 180, isUser: false }, // 17%
    ];

    const results = checkAllMorale(participants, '标准', [10, 10, 5, 9]);
    // 用户不检测
    // 莉亚: 75% > 30% → 不触发
    // clusterA: 25% < 30%, d20=5 < 12 → routing
    // clusterB: 17% < 30%, d20=9 < 12 → routing
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.result.moraleState === 'routing')).toBe(true);
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
    { type: '切磋', threshold: 0.4, isAuto: true },
    { type: '竞技', threshold: 0.3, isAuto: true },
    { type: '压制', threshold: 0.5, isAuto: true },
    { type: '死斗', threshold: 0.1, isAuto: false },
    { type: '标准', threshold: 0.3, isAuto: false },
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
