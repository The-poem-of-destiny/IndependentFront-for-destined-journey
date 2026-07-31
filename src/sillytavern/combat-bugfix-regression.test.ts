/**
 * combat-bugfix-regression.test.ts — 战斗系统 bugfix 回归测试（2026-07-31 批次）
 *
 * 覆盖本批修复的已知缺陷，防止回退:
 *  1. 意图对抗: 攻守各自独立 d20（旧实现共用一颗 → 同层级对抗永远失败）
 *  2. 非致死锁血: finalHp=1 + [昏迷] + delta_hp patch 与 finalHp 一致（旧实现按全额伤害扣 → 落库死亡）
 *  3. 非致死关键词联动: "打晕"等关键词自动置 nonLethal（旧实现无联动，照样打死）
 *  4. buff effects 消费: 防御姿态 {defense:0.5, dodge:3} 真正参与检定/伤害（旧实现无消费方）
 *  5. 伤害下限: damageMultiplier 累计 < -100% 时 clamp 0（旧实现出负伤害 → 反向加血）
 *  6. sumPercentages 按 target 过滤（heal 百分比不进伤害乘区）
 *  7. removeBuff: name 含点（"Lv.2 强化"）不再被误判成 buffId
 *  8. inferOutcome: 裸"阵亡"绑定主语判方向 + winner='draw' 直通
 *  9. 处决保底: 战意动摇 + 处决意图 → 评级保底暴击(1.3)（旧实现只是字符串从未生效）
 *
 * 脚手架对齐 combat-pipeline.test.ts（EventBus + makeParticipant/makeCombatState 工厂）。
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { resolveAttackPipeline, COMBAT_EVENTS, type PipelineContext } from './combat-pipeline';
import { EventBus } from './game-event';
import type { AttackInput } from './combat-resolver';
import type { CombatState, CombatParticipant, ReadonlyHookSet, StatusEffect } from './types';
import type { PercentageModifier } from './effect-types';
import { sumPercentages } from './effect-types';
import { removeBuff } from './buff-registry';
import { inferOutcome } from './combat-runner';

// ========== 测试工厂 ==========

function makeParticipant(o: Partial<CombatParticipant> = {}): CombatParticipant {
  return {
    characterId: 'default',
    name: '默认',
    tier: 3,
    level: 10,
    attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
    hp: 1000,
    maxHp: 1000, // 高 HP 避免攻击后触发战意（战意在 hpRatio<0.5 时）
    mp: 50,
    maxMp: 50,
    sp: 50,
    maxSp: 50,
    defense: 100,
    dr: 0,
    penetration: 0,
    hitBonus: 3,
    dodgeBonus: 2,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: [],
    weaponAtk: 25,
    side: 'ally',
    canAct: true,
    ...o,
  };
}

/** 攻守同层级（tier 3 vs 3）→ 单 d20，无优劣势第二骰，全程确定性 */
function makeCombatState(o: Partial<CombatState> = {}): CombatState {
  return {
    combatId: 'bugfix-regression-01',
    combatType: '标准',
    round: 1,
    participants: [
      makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
      makeParticipant({
        characterId: 'enemy1',
        name: '哥布林',
        side: 'enemy',
        tier: 3,
        hp: 2000,
        maxHp: 2000,
      }),
    ],
    turnOrder: [],
    currentTurnIndex: 0,
    status: 'active',
    environment: '平原',
    patches: [],
    roundLogs: [],
    ...o,
  };
}

const stubHooks: ReadonlyHookSet = {
  getHp: () => 0,
  getMaxHp: () => 0,
  getMp: () => 0,
  getMaxMp: () => 0,
  getSp: () => 0,
  getMaxSp: () => 0,
  getHpPercent: () => 0,
  getAttr: () => 0,
  getTier: () => 0,
  isPresent: () => false,
  getStatusEffects: () => [],
  hasStatus: () => false,
  getBuffStacks: () => 0,
};

function makeCtx(bus: EventBus): PipelineContext {
  return {
    bus,
    combatants: ['ally1', 'enemy1'],
    readHooks: stubHooks,
    // 不传 combatType → 战意不触发（无额外随机 d20，聚焦被测行为）
  };
}

function makeAttackInput(combat: CombatState, o: Partial<AttackInput> = {}): AttackInput {
  return {
    combat,
    attackerId: 'ally1',
    defenderId: 'enemy1',
    weaponName: '长剑',
    weaponAtk: 25,
    skillName: '斩击',
    skillPower: 30,
    relevantAttribute: 'str',
    relevantAttributeValue: 14,
    damageType: '物理',
    d20Attack: 20,
    ...o,
  };
}

function makeBuff(o: Partial<StatusEffect> & { name: string }): StatusEffect {
  return {
    description: '测试 buff',
    category: '增益',
    stacks: 1,
    remainingTime: 1,
    timeUnit: '回合',
    source: '增益-测试;回合结束解除',
    effects: {},
    lifecycle: '战斗',
    ...o,
  };
}

// ═══════════════════════════════════════════════════════════

describe('战斗 bugfix 回归 — 意图对抗独立掷骰', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  it('同层级 + 攻方高骰(d20=20 vs 1) 的战术意图判定成功（旧实现共用一骰必败）', async () => {
    const combat = makeCombatState();
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, {
        userInput: '瞄准要害', // '要害'/'瞄准' → 战术意图（难度3，需对抗）
        d20Attack: 15,
        d20Intention: 20,
        d20IntentionDefender: 1,
      }),
      makeCtx(bus),
    );

    expect(result.intention.level).toBe('战术');
    // 同层级: 攻 (3×5+20)=35 vs 守 (3×5+1+难度3)=19 → 成功
    expect(result.intention.verdict).toBe('成功');
    expect(result.intention.contested?.attackerValue).toBe(35);
    expect(result.intention.contested?.defenderValue).toBe(19);
    expect(result.intention.coefficient).toBeCloseTo(1.2); // 战术成功系数
  });
});

describe('战斗 bugfix 回归 — 非致死锁血', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  /** 守方 50 HP / 0 防御，攻方 500 武攻 → 伤害必然足以致死 */
  function lethalSetup(): CombatState {
    return makeCombatState({
      participants: [
        makeParticipant({
          characterId: 'ally1',
          name: '勇者',
          side: 'ally',
          tier: 3,
          weaponAtk: 500,
        }),
        makeParticipant({
          characterId: 'enemy1',
          name: '哥布林',
          side: 'enemy',
          tier: 3,
          hp: 50,
          maxHp: 50,
          defense: 0,
        }),
      ],
    });
  }

  it('nonLethal=true 且伤害致死: finalHp=1 + 昏迷 + delta_hp patch === 1 - 原HP（patch 与 finalHp 一致）', async () => {
    const combat = lethalSetup();
    const result = await resolveAttackPipeline(
      // d20=12 → checkValue 12+3-2=13 → 有效(1.0)，评级<1.3 不触发失手致死
      makeAttackInput(combat, { weaponAtk: 500, d20Attack: 12, nonLethal: true }),
      makeCtx(bus),
    );

    expect(result.damage.finalDamage).toBeGreaterThanOrEqual(50); // 伤害确实足以致死
    expect(result.finalHp).toBe(1);
    expect(result.isDead).toBe(false);
    expect(result.statusApplied.some((s) => s.name === '昏迷')).toBe(true);

    // patch 与 finalHp 一致: amount = 1 - 原HP(50) = -49，而不是 -finalDamage
    const hpPatch = result.patches.find(
      (p) => p.op === 'delta_hp' && p.target === 'characters.enemy1',
    )!;
    expect(hpPatch).toBeDefined();
    expect(hpPatch.amount).toBe(1 - 50);
    // 同时生成昏迷状态 patch
    expect(
      result.patches.some(
        (p) => p.op === 'add_status_effect' && (p.value as StatusEffect)?.name === '昏迷',
      ),
    ).toBe(true);
  });

  it("userInput='把他打晕' 未显式传 nonLethal 也触发锁血（关键词→非致死联动）", async () => {
    const combat = lethalSetup();
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { weaponAtk: 500, d20Attack: 12, userInput: '把他打晕' }),
      makeCtx(bus),
    );

    expect(result.intention.level).toBe('非致死');
    expect(result.finalHp).toBe(1);
    expect(result.isDead).toBe(false);
    expect(result.statusApplied.some((s) => s.name === '昏迷')).toBe(true);
    const hpPatch = result.patches.find(
      (p) => p.op === 'delta_hp' && p.target === 'characters.enemy1',
    )!;
    expect(hpPatch.amount).toBe(1 - 50);
  });
});

describe('战斗 bugfix 回归 — 守方 buff effects 参与数值', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  it('防御姿态 {defense:0.5, dodge:3}: checkValue 低 3、最终伤害更低（旧实现 buff 是空气）', async () => {
    // 基线: 无 buff
    const baseCombat = makeCombatState();
    // d20=18 → 基线 checkValue 18+3-2=19(有效)，buff 后 16(有效)——同评级，伤害差纯来自防御+50%
    const baseResult = await resolveAttackPipeline(
      makeAttackInput(baseCombat, { d20Attack: 18 }),
      makeCtx(bus),
    );

    // 对照: 守方带防御姿态 buff
    const buffedCombat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
        makeParticipant({
          characterId: 'enemy1',
          name: '哥布林',
          side: 'enemy',
          tier: 3,
          hp: 2000,
          maxHp: 2000,
          statusEffects: [
            makeBuff({
              name: '防御姿态',
              description: '本回合防御+50%，闪避+3',
              sourceKey: '战斗',
              effects: { defense: 0.5, dodge: 3 },
            }),
          ],
        }),
      ],
    });
    const buffedResult = await resolveAttackPipeline(
      makeAttackInput(buffedCombat, { d20Attack: 18 }),
      makeCtx(new EventBus({ maxHistory: 50 })),
    );

    // dodge+3 进检定
    expect(buffedResult.attackRoll.dodgeBonus).toBe(baseResult.attackRoll.dodgeBonus + 3);
    expect(buffedResult.attackRoll.checkValue).toBe(baseResult.attackRoll.checkValue - 3);
    // 同评级下 defense+50% → 伤害严格更低
    expect(buffedResult.attackRoll.rating.level).toBe(baseResult.attackRoll.rating.level);
    expect(buffedResult.damage.finalDamage).toBeGreaterThan(0);
    expect(buffedResult.damage.finalDamage).toBeLessThan(baseResult.damage.finalDamage);
  });
});

describe('战斗 bugfix 回归 — 伤害下限 clamp', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  it('damageMultiplier 累计 -1.5 时 finalDamage=0 而非负数（负伤害会反向加血）', async () => {
    const curseA: PercentageModifier = {
      category: '百分比',
      source: '诅咒之雾',
      coefficient: -0.8,
      target: 'damage',
    };
    const curseB: PercentageModifier = {
      category: '百分比',
      source: '衰弱光环',
      coefficient: -0.7,
      target: 'damage',
    };
    bus.subscribeChain({
      type: COMBAT_EVENTS.ATTACK_COLLECT_ATK,
      handler: (params) => ({ ...params, mods: [...params.mods, curseA, curseB] }),
    });

    const combat = makeCombatState();
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { d20Attack: 20 }), // checkValue 21 → 暴击，确保命中分支
      makeCtx(bus),
    );

    expect(result.damage.finalDamage).toBe(0);
    expect(result.damage.finalDamage).toBeGreaterThanOrEqual(0);
    // HP 不得反向增加
    expect(result.finalHp).toBe(2000);
    const hpPatch = result.patches.find(
      (p) => p.op === 'delta_hp' && p.target === 'characters.enemy1',
    )!;
    expect(hpPatch.amount).toBe(0);
  });
});

describe('战斗 bugfix 回归 — sumPercentages 按 target 过滤', () => {
  it("target='damage' 只累加伤害百分比，heal/resource 被过滤", () => {
    const mods: PercentageModifier[] = [
      { category: '百分比', source: '狂暴', coefficient: 0.5, target: 'damage' },
      { category: '百分比', source: '治疗强化', coefficient: 2.0, target: 'heal' },
      { category: '百分比', source: '法力涌动', coefficient: 1.0, target: 'resource' },
    ];

    expect(sumPercentages(mods, 'damage')).toBeCloseTo(0.5);
    // 不传 target 保持旧行为（全量累加）
    expect(sumPercentages(mods)).toBeCloseTo(3.5);
  });
});

describe('战斗 bugfix 回归 — removeBuff 名字含点', () => {
  it("name='Lv.2 强化'（无 sourceKey）能按裸名删除", () => {
    const existing: StatusEffect[] = [
      makeBuff({ name: 'Lv.2 强化', effects: { damage: 0.2 } }), // 无 sourceKey，name 含点
      makeBuff({ name: '灼烧', category: '减益' }),
    ];

    const result = removeBuff(existing, 'Lv.2 强化');
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].name).toBe('Lv.2 强化');
    expect(result.remaining).toHaveLength(1);
    expect(result.remaining[0].name).toBe('灼烧');
  });

  it("name='Lv.2 强化' 带 sourceKey 时按裸名也能删除（旧实现 includes('.') 误判成 buffId 永远删不掉）", () => {
    const existing: StatusEffect[] = [
      makeBuff({ name: 'Lv.2 强化', sourceKey: '秘药', effects: { damage: 0.2 } }), // buffId='秘药.Lv.2 强化'
    ];

    const result = removeBuff(existing, 'Lv.2 强化');
    expect(result.removed).toHaveLength(1);
    expect(result.removed[0].name).toBe('Lv.2 强化');
    expect(result.remaining).toHaveLength(0);
  });
});

describe('战斗 bugfix 回归 — inferOutcome 主语绑定', () => {
  it("'敌军全部阵亡' → ally_win（旧实现裸'阵亡'误判为敌方胜）", () => {
    expect(inferOutcome('敌军全部阵亡', undefined)).toBe('ally_win');
  });

  it("'主角阵亡' → enemy_win", () => {
    expect(inferOutcome('主角阵亡', undefined)).toBe('enemy_win');
  });

  it("winner='draw' → draw", () => {
    expect(inferOutcome(undefined, 'draw')).toBe('draw');
  });
});

describe('战斗 bugfix 回归 — 处决评级保底', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  it("守方 shaken + '斩首' + 低攻击骰(d20=5): 评级系数保底 ≥1.3（旧实现保底只是字符串）", async () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
        makeParticipant({
          characterId: 'enemy1',
          name: '哥布林',
          side: 'enemy',
          tier: 3,
          hp: 2000,
          maxHp: 2000,
          morale: 'shaken',
        }),
      ],
    });
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, {
        userInput: '将他斩首', // '斩首' → 抹杀意图 + isExecutionIntent
        d20Attack: 5, // 低骰: 5+3-闪避(处决自动成功→闪避无效0)=8 → 本应 勉强(0.8)
        d20Intention: 10,
        d20IntentionDefender: 10, // 显式传守方骰保持确定性（自动成功分支不消费，但避免事件链随机掷骰）
      }),
      makeCtx(bus),
    );

    // 战意动摇 + 处决意图 → 自动成功，升级为处决
    expect(result.intention.level).toBe('处决');
    expect(result.intention.verdict).toBe('自动成功');
    // 评级保底暴击: 系数 ≥ 1.3（旧实现 rating 仍是 勉强 0.8）
    expect(result.attackRoll.rating.coefficient).toBeGreaterThanOrEqual(1.3);
    expect(result.attackRoll.rating.level).toBe('暴击');
    // 处决意图系数进伤害管线（INTENTION_CONFIGS['处决'].coefficient = 1.3；
    // 注: combat-intention.ts 自动成功分支旁的 "// 2.0" 注释与配置表不符，以配置表为准）
    expect(result.damage.intentionCoefficient).toBeCloseTo(1.3);
  });
});

// ═══════════════════════════════════════════════════════════
// 第二轮（对抗性验证发现）回归
// ═══════════════════════════════════════════════════════════

import { runDamagePipeline, performAttackCheck } from './combat-damage';
import { checkNonLethal } from './combat-intention';
import { tickBuffs } from './buff-registry';
import { runSettlementPipeline } from './combat-settlement-pipeline';
import { applyStatusIntents, removeStatusIntents } from './status-api';

describe('对抗验证回归 — 伤害管线入参消毒', () => {
  const baseInput = {
    relevantAttribute: 14,
    attackerTier: 3,
    skillPower: 30,
    weaponAtk: 25,
    defenderDefense: 100,
    penetrationRate: 0,
    damageType: '物理' as const,
    defenderAttributes: { str: 10, dex: 10, con: 10, int: 10, spi: 10 },
    ratingCoefficient: 1.0,
    intentionCoefficient: 1.0,
    drRate: 0,
    isClusterTarget: false,
    currentHp: 1000,
  };

  it('multiHitCount 负数不再产出负伤害（曾实测 -2 段 → finalDamage=-1070 反向加血）', () => {
    const r = runDamagePipeline({ ...baseInput, multiHitCount: -2 });
    expect(r.finalDamage).toBeGreaterThanOrEqual(0);
    // 消毒为 1 段 → 与正常单段一致
    const single = runDamagePipeline({ ...baseInput, multiHitCount: 1 });
    expect(r.finalDamage).toBe(single.finalDamage);
  });

  it('骰值越界被 clamp 到 [1,20]（伪造 d20Roll2=100 不再必定超暴击）', () => {
    const r = performAttackCheck({
      d20Roll: 10,
      d20Roll2: 100,
      attackerTier: 4,
      defenderTier: 3,
      hitBonus: 0,
      defenderDodge: 0,
      dodgeNegated: false,
    });
    expect(Math.max(...r.diceRolls)).toBeLessThanOrEqual(20);
    expect(r.checkValue).toBeLessThanOrEqual(20);
  });
});

describe('对抗验证回归 — 非致死不复活尸体', () => {
  it('目标 HP=0 时非致死锁血不生效（曾把死者拉回 1 HP + 正向 delta patch）', () => {
    const r = checkNonLethal({
      nonLethal: true,
      ratingCoefficient: 1.0,
      finalDamage: 50,
      currentHp: 0,
    });
    expect(r.applied).toBe(false);
    expect(r.adjustedHp).toBe(0);
    expect(r.unconscious).toBe(false);
  });
});

describe('对抗验证回归 — inferOutcome 分句主语绑定', () => {
  it('跨句借词: "敌人全灭，主角获胜" → ally_win（曾误判 draw）', () => {
    expect(inferOutcome('敌人全灭，主角获胜', undefined)).toBe('ally_win');
  });
  it('"我方战败，敌人获胜" → enemy_win（曾误判 draw）', () => {
    expect(inferOutcome('我方战败，敌人获胜', undefined)).toBe('enemy_win');
  });
  it('"英雄倒下了，敌人获胜" → enemy_win', () => {
    expect(inferOutcome('英雄倒下了，敌人获胜', undefined)).toBe('enemy_win');
  });
  it('复合词裸字: "主角率领众人经过艰苦卓绝的殊死搏斗最终获胜" → ally_win（"殊死"曾触发 enemy_win）', () => {
    expect(inferOutcome('主角率领众人经过艰苦卓绝的殊死搏斗最终获胜', undefined)).toBe('ally_win');
  });
  it('winner=draw 时逃跑摘要仍判 fled（combat_end 无 fled 枚举，曾不可达）', () => {
    expect(inferOutcome('主角成功逃脱，战斗结束', 'draw')).toBe('fled');
  });
});

describe('对抗验证回归 — 结算不给逃跑者发经验', () => {
  it('逃跑成功(fled 标记)的敌人不计 EXP，被击倒的计', async () => {
    const bus = new EventBus({ maxHistory: 20 });
    const fledEnemy = makeParticipant({
      characterId: 'e1',
      name: '逃兵',
      side: 'enemy',
      tier: 2,
      level: 8,
      hp: 500,
      canAct: false,
    });
    (fledEnemy as { fled?: boolean }).fled = true;
    const deadEnemy = makeParticipant({
      characterId: 'e2',
      name: '战死者',
      side: 'enemy',
      tier: 2,
      level: 8,
      hp: 0,
      canAct: false,
    });
    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally' }),
        fledEnemy,
        deadEnemy,
      ],
    });
    const r = await runSettlementPipeline(combat, 'ally', {
      bus,
      combatants: ['ally1', 'e1', 'e2'],
      readHooks: stubHooks,
    });
    // 只有战死者计入: level 8 × T2 战斗系数（逃兵曾因 !canAct 被误当"被击败"）
    const single = await runSettlementPipeline(
      makeCombatState({
        participants: [
          makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally' }),
          { ...deadEnemy },
        ],
      }),
      'ally',
      { bus, combatants: ['ally1', 'e2'], readHooks: stubHooks },
    );
    expect(r.exp).toBe(single.exp);
    expect(r.exp).toBeGreaterThan(0);
  });
});

describe('对抗验证回归 — buff 时长/层数数据卫生', () => {
  it('remainingTime=undefined（status_apply 未传 duration）不再被 tick 成 NaN', () => {
    const buff = makeBuff({ name: '中毒', category: '减益' });
    delete (buff as Partial<StatusEffect>).remainingTime;
    const r = tickBuffs([buff], 'round.end');
    expect(r.expired).toHaveLength(0);
    expect(r.remaining).toHaveLength(1);
    expect(Number.isNaN(r.remaining[0].remainingTime as number)).toBe(false);
  });

  it('removeBuff 裸 name 删除所有同名（含带 sourceKey 前缀与裸名实例共存场景）', () => {
    const effects = [
      makeBuff({ name: '流血' }), // 裸名实例
      makeBuff({ name: '流血', sourceKey: '毒刃' }), // 前缀实例
    ];
    const r = removeBuff(effects, '流血');
    expect(r.removed).toHaveLength(2);
    expect(r.remaining).toHaveLength(0);
  });

  it('status-api patch 携带增量而非合并总量（累加语义落库方不再层数双计）', () => {
    const existing = [makeBuff({ name: '中毒', sourceKey: '毒刃', stacks: 2, category: '减益' })];
    const r = applyStatusIntents(existing, [
      {
        target: 'hero',
        buffDef: { name: '中毒', category: '减益', sourceKey: '毒刃', stacks: 1 },
      },
    ]);
    // 本地合并 = 3；patch 带增量 1（state-manager stacks += 1 → 3，而非 += 3 → 5）
    expect(r.updated[0].stacks).toBe(3);
    expect((r.patches[0].value as StatusEffect).stacks).toBe(1);
  });

  it('status-api remove patch 用 {name} 对象（string 曾在落库层直接抛错）', () => {
    const existing = [makeBuff({ name: '流血', sourceKey: '毒刃', category: '减益' })];
    const r = removeStatusIntents(existing, [{ target: 'hero', buffIdOrName: '毒刃.流血' }]);
    expect(r.patches).toHaveLength(1);
    expect(r.patches[0].value).toEqual({ name: '流血' });
  });
});

describe('对抗验证回归 — 意图对抗事件链', () => {
  let bus: EventBus;
  beforeEach(() => {
    bus = new EventBus({ maxHistory: 50 });
  });

  it('AI 未传意图骰时走 dice.roll(purpose=intention) 事件，脚本可改写双骰', async () => {
    const seen: string[] = [];
    bus.subscribeChain({
      type: COMBAT_EVENTS.DICE_ROLL,
      handler: (p: Record<string, unknown>) => {
        if (p.purpose === 'intention') {
          seen.push('intention');
          return { ...p, dice: [20, 1] }; // 攻方高骰、守方低骰
        }
        return p;
      },
    });
    const combat = makeCombatState();
    const result = await resolveAttackPipeline(
      makeAttackInput(combat, { userInput: '瞄准弱点' }), // 战术意图, 未传 d20Intention*
      makeCtx(bus),
    );
    expect(seen).toContain('intention');
    // 攻 20 vs 守 1+难度3 → (T3×5+20)=35 vs (T3×5+1+3)=19 → 成功
    expect(result.intention.verdict).toBe('成功');
    expect(result.intention.coefficient).toBe(1.2);
  });

  it('常规攻击不发 intention 掷骰事件（无对抗不掷幽灵骰）', async () => {
    const seen: string[] = [];
    bus.subscribeChain({
      type: COMBAT_EVENTS.DICE_ROLL,
      handler: (p: Record<string, unknown>) => {
        if (p.purpose === 'intention') seen.push('intention');
        return p;
      },
    });
    const combat = makeCombatState();
    await resolveAttackPipeline(makeAttackInput(combat), makeCtx(bus));
    expect(seen).toHaveLength(0);
  });
});

describe('真机压测回归 — 意图骰引擎侧 clamp', () => {
  it('AI 误传 roll_d20 总值(21)时 clamp 到 20，公式与叙事同步（schema max 不可依赖）', async () => {
    const { resolveIntention } = await import('./combat-intention');
    const r = resolveIntention({
      intentionLevel: '战术',
      attackerTier: 3,
      defenderTier: 3,
      defenderIncapacitated: false,
      isExecutionIntent: false,
      nonLethal: false,
      attackerD20: 21,
      defenderD20: 1,
    });
    expect(r.contested?.attackerValue).toBe(3 * 5 + 20); // 21 → clamp 20
    expect(r.contested?.attackerFormula).toContain('d20[20]');
    expect(r.verdict).toBe('成功');
  });
});

describe('真机压测回归 — 胜负推断(按名主语 + 终局状态)', () => {
  it('agent 摘要用角色名("刀疤溃败投降")时按名单绑定主语 → ally_win（曾误判 draw）', async () => {
    const { inferOutcome } = await import('./combat-runner');
    const sides = { allyNames: ['罗兰'], enemyNames: ['刀疤'] };
    expect(inferOutcome('刀疤溃败投降，生死系于罗兰一念。', undefined, sides)).toBe('ally_win');
    expect(
      inferOutcome('卡恩胜，黑牙战死。', undefined, { allyNames: ['卡恩'], enemyNames: ['黑牙'] }),
    ).toBe('ally_win');
  });

  it('deriveWinnerFromState: 敌方全部倒下/逃光而我方仍有战力 → ally', async () => {
    const { deriveWinnerFromState } = await import('./combat-runner');
    const combat = makeCombatState();
    combat.participants[1].hp = 0;
    combat.participants[1].canAct = false;
    expect(deriveWinnerFromState(combat)).toBe('ally');
    // 双方均有战力 → undefined（交回文本推断）
    expect(deriveWinnerFromState(makeCombatState())).toBeUndefined();
  });
});

describe('定向压测回归 — clusterCount 全链拷贝(集群 ×1.5 / EXP 衰减断线)', () => {
  it('characterToCombatParticipant 拷贝 clusterCount（旧实现不拷 → 管线/结算读 participant 恒 undefined，集群机制真实链路死代码）', async () => {
    const { characterToCombatParticipant } = await import('./combat-resolver');
    const { createDefaultCharacterState } = await import('./types');
    const char = createDefaultCharacterState({ saveId: 'save1' });
    char.name = '骷髅集群';
    (char as { clusterCount?: number }).clusterCount = 8;
    const p = characterToCombatParticipant(char, 'enemy');
    expect(p.clusterCount).toBe(8);
    // 非集群角色缺省 undefined，不误伤单体
    const solo = createDefaultCharacterState({ saveId: 'save1' });
    expect(characterToCombatParticipant(solo, 'enemy').clusterCount).toBeUndefined();
  });

  it('管线 Step 8: 集群守方(clusterCount≥3) finalDamage ×1.5（经 characterToCombatParticipant 构造的 participant）', async () => {
    const { characterToCombatParticipant } = await import('./combat-resolver');
    const { createDefaultCharacterState } = await import('./types');
    const cluster = createDefaultCharacterState({ saveId: 'save1' });
    cluster.name = '骷髅集群';
    cluster.hp = 2000;
    cluster.maxHp = 2000;
    (cluster as { clusterCount?: number }).clusterCount = 8;
    const defender = characterToCombatParticipant(cluster, 'enemy', {
      characterId: 'enemy1',
      // 与攻击方同层级(tier 3) —— 跨层级会触发优劣势第二骰(引擎自掷均匀骰,非确定性)
      tier: 3,
      level: 10,
      hp: 2000,
      maxHp: 2000,
      defense: 100,
      dr: 0,
      dodgeBonus: 2,
    });
    const combat = makeCombatState();
    combat.participants[1] = defender;
    const bus = new EventBus({ maxHistory: 100 });
    const ctx: PipelineContext = {
      bus,
      combatants: ['ally1', 'enemy1'],
      readHooks: {} as ReadonlyHookSet,
    };
    const input: AttackInput = {
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      userInput: '横扫骨群',
      action: 'attack',
      damageType: '物理',
      d20Attack: 15,
      d20Intention: 10,
      d20IntentionDefender: 10,
    };
    const withCluster = await resolveAttackPipeline(input, ctx);
    // 对照组: 同参数、无 clusterCount
    const combat2 = makeCombatState();
    combat2.participants[1] = { ...defender, clusterCount: undefined };
    const solo = await resolveAttackPipeline({ ...input, combat: combat2 }, ctx);
    if (solo.damage.finalDamage > 0) {
      expect(withCluster.damage.finalDamage).toBe(Math.floor(solo.damage.finalDamage * 1.5));
    } else {
      expect(withCluster.damage.finalDamage).toBe(0);
    }
  });
});
