/**
 * combat-resolver.ts 测试
 * 覆盖: $combat API / 攻击管线 / 防御/逃跑 / 战斗管理 / 参与者转换
 */
import { describe, it, expect } from 'vitest';
import {
  resolveAttack,
  resolveDefend,
  resolveFlee,
  initCombat,
  endCombat,
  getCombatState,
  characterToCombatParticipant,
} from './combat-resolver';
import type { CombatState, CombatParticipant, CharacterState } from './types';

// ========== 测试工厂 ==========

function makeCombatState(overrides: Partial<CombatState> = {}): CombatState {
  return {
    combatId: 'test-combat-01',
    combatType: '标准',
    round: 1,
    participants: [
      makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
      makeParticipant({ characterId: 'enemy1', name: '哥布林', side: 'enemy', tier: 1 }),
    ],
    turnOrder: [
      { characterId: 'ally1', name: '勇者', agility: 13, d20Roll: 15, speedModifiers: [], totalInitiative: 28, attacksRemaining: 1, actionsRemaining: 1 },
      { characterId: 'enemy1', name: '哥布林', agility: 10, d20Roll: 8, speedModifiers: [], totalInitiative: 18, attacksRemaining: 1, actionsRemaining: 1 },
    ],
    currentTurnIndex: 0,
    status: 'active',
    environment: '平原',
    patches: [],
    roundLogs: [],
    ...overrides,
  };
}

function makeParticipant(overrides: Partial<CombatParticipant> = {}): CombatParticipant {
  return {
    characterId: 'default',
    name: '默认',
    tier: 3,
    level: 10,
    attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
    hp: 100, maxHp: 100,
    mp: 50, maxMp: 50,
    sp: 50, maxSp: 50,
    defense: 200,
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
    ...overrides,
  };
}

// ========== $combat.attack() ==========

describe('resolveAttack', () => {
  it('完整攻击管线返回有效结果', () => {
    const combat = makeCombatState();
    const result = resolveAttack({
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      userInput: '砍向敌人',
      skillName: '斩击',
      weaponName: '长剑',
      weaponAtk: 25,
      skillPower: 30,
      relevantAttribute: 'str',
      relevantAttributeValue: 14,
      damageType: '物理',
      d20Attack: 15,
      d20Intention: 12,
    });

    expect(result.description).toContain('勇者');
    expect(result.description).toContain('哥布林');
    expect(result.damage.initialDamage).toBeGreaterThan(0);
    expect(result.damage.finalDamage).toBeGreaterThanOrEqual(0);
    expect(result.patches).toHaveLength(1); // delta_hp
    expect(result.patches[0].op).toBe('delta_hp');
    expect(result.patches[0].amount).toBeLessThan(0); // 负值表示扣血

    // 面板含关键信息
    const panelText = result.panelLines.join('\n');
    expect(panelText).toContain('{攻击行动}');
    expect(panelText).toContain('勇者');
  });

  it('暴击意图攻击', () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '剑圣', side: 'ally', tier: 5, attributes: { str: 18, dex: 16, con: 14, int: 12, spi: 14 } }),
        makeParticipant({ characterId: 'enemy1', name: '魔物', side: 'enemy', tier: 2, hp: 200, maxHp: 200 }),
      ],
    });

    const result = resolveAttack({
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      userInput: '斩首',
      skillPower: 100,
      weaponAtk: 60,
      relevantAttributeValue: 18,
      damageType: '物理',
      d20Attack: 18, // 高d20
      d20Intention: 15,
    });

    // 意图应为 '抹杀' (斩首→抹杀)
    expect(result.intention.level).toBe('抹杀');
    expect(result.attackRoll.rating.coefficient).toBeGreaterThanOrEqual(1.0);
  });

  it('真实伤害跳过减免', () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '法师', side: 'ally', tier: 4, attributes: { str: 8, dex: 10, con: 8, int: 18, spi: 16 } }),
        makeParticipant({ characterId: 'enemy1', name: '高防魔像', side: 'enemy', tier: 4, hp: 500, maxHp: 500, defense: 1000, dr: 0.3 }),
      ],
    });

    const resultTrue = resolveAttack({
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      userInput: '魔力贯穿',
      skillPower: 80,
      weaponAtk: 0,
      relevantAttributeValue: 18,
      damageType: '真实',
      d20Attack: 14,
    });

    // 真实伤害: typeReductionRate = 0
    expect(resultTrue.damage.typeReductionRate).toBe(0);
    expect(resultTrue.damage.typeReductionAmount).toBe(0);
  });

  it('穿透效果减少装备减免', () => {
    const penAttacker = makeParticipant({
      characterId: 'ally1', name: '穿甲弓手', side: 'ally', tier: 3,
      penetration: 0.5, weaponAtk: 40,
      attributes: { str: 10, dex: 16, con: 10, int: 10, spi: 10 },
    });
    const highDefDefender = makeParticipant({
      characterId: 'enemy1', name: '重甲骑士', side: 'enemy', tier: 3,
      defense: 2000, hp: 500, maxHp: 500,
    });

    const combat: CombatState = {
      combatId: 'pen-test',
      combatType: '切磋',
      round: 1,
      participants: [penAttacker, highDefDefender],
      turnOrder: [
        { characterId: 'ally1', name: '穿甲弓手', agility: 16, d20Roll: 14, speedModifiers: [], totalInitiative: 30, attacksRemaining: 1, actionsRemaining: 1 },
        { characterId: 'enemy1', name: '重甲骑士', agility: 10, d20Roll: 8, speedModifiers: [], totalInitiative: 18, attacksRemaining: 1, actionsRemaining: 1 },
      ],
      currentTurnIndex: 0,
      status: 'active',
      environment: '竞技场',
      patches: [],
      roundLogs: [],
    };

    const result = resolveAttack({
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      skillPower: 0,
      weaponAtk: 40,
      relevantAttributeValue: 16,
      damageType: '物理',
      d20Attack: 12,
    });

    // 穿透 50%: 2000 → 1000 effective def
    expect(result.damage.penetration.effectiveDef).toBe(1000);
    // 有效防御降低 → 装备减免减少 → 伤害更高
    expect(result.damage.finalDamage).toBeGreaterThan(0);
  });

  it('攻击不在场的角色返回错误', () => {
    const combat = makeCombatState();
    const result = resolveAttack({
      combat,
      attackerId: 'nonexistent',
      defenderId: 'enemy1',
      d20Attack: 10,
    });
    expect(result.description).toContain('不在战斗中');
    expect(result.damage.finalDamage).toBe(0);
    expect(result.patches).toHaveLength(0);
  });

  it('多段攻击正确分割伤害', () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({ characterId: 'ally1', name: '连击剑士', side: 'ally', tier: 3, attributes: { str: 14, dex: 14, con: 12, int: 10, spi: 10 } }),
        makeParticipant({ characterId: 'enemy1', name: '大型史莱姆', side: 'enemy', tier: 2, hp: 300, maxHp: 300 }),
      ],
    });

    const result = resolveAttack({
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      skillName: '三连斩',
      skillPower: 60,
      weaponAtk: 30,
      relevantAttributeValue: 14,
      damageType: '物理',
      multiHitCount: 3,
      d20Attack: 13,
    });

    // 多段分割: 初始伤害 / 3
    const initDmg = result.damage.initialDamage;
    const perHit = Math.floor(initDmg / 3);
    expect(result.damage.multiSplitInfo?.count).toBe(3);
    expect(result.damage.multiSplitInfo?.perHit).toBe(perHit);

    // 修复: 世界书公式在末尾 ×攻击次数 → 最终伤害 ≈ perHit × 3
    // (经减免后应大致接近 perHit × 3，具体值取决于防御减免)
    expect(result.damage.finalDamage).toBeGreaterThan(perHit);
    expect(result.damage.finalDamage).toBeLessThanOrEqual(initDmg);
  });

  it('DR 修正降低最终伤害', () => {
    const drDefender = makeParticipant({
      characterId: 'enemy1', name: '石像鬼', side: 'enemy', tier: 4,
      hp: 500, maxHp: 500,
      defense: 500, dr: 0.4, // 40% DR
      attributes: { str: 12, dex: 8, con: 18, int: 4, spi: 6 },
    });

    const combat: CombatState = {
      combatId: 'dr-test',
      combatType: '标准',
      round: 1,
      participants: [
        makeParticipant({ characterId: 'ally1', name: '勇者', side: 'ally', tier: 3 }),
        drDefender,
      ],
      turnOrder: [
        { characterId: 'ally1', name: '勇者', agility: 13, d20Roll: 15, speedModifiers: [], totalInitiative: 28, attacksRemaining: 1, actionsRemaining: 1 },
        { characterId: 'enemy1', name: '石像鬼', agility: 8, d20Roll: 5, speedModifiers: [], totalInitiative: 13, attacksRemaining: 1, actionsRemaining: 1 },
      ],
      currentTurnIndex: 0,
      status: 'active',
      environment: '遗迹',
      patches: [],
      roundLogs: [],
    };

    const result = resolveAttack({
      combat,
      attackerId: 'ally1',
      defenderId: 'enemy1',
      skillPower: 50,
      weaponAtk: 25,
      relevantAttributeValue: 14,
      damageType: '物理',
      d20Attack: 12,
    });

    // DR > 0 → drReduction > 0
    expect(result.damage.drRate).toBe(0.4);
    expect(result.damage.drReduction).toBeGreaterThan(0);
    expect(result.damage.finalDamage).toBeLessThan(result.damage.afterDr + result.damage.drReduction);
  });
});

// ========== $combat.defend() ==========

describe('resolveDefend', () => {
  it('防御成功施加防御姿态', () => {
    const combat = makeCombatState();
    const result = resolveDefend(combat, 'ally1');

    expect(result.success).toBe(true);
    expect(result.patches).toHaveLength(1);
    expect(result.patches[0].op).toBe('add_status_effect');
    expect(result.description).toContain('勇者');
  });

  it('防御不存在的角色 → 失败', () => {
    const combat = makeCombatState();
    const result = resolveDefend(combat, '不存在');
    expect(result.success).toBe(false);
    expect(result.patches).toHaveLength(0);
  });
});

// ========== $combat.flee() ==========

describe('resolveFlee', () => {
  it('逃跑检定: 高敏捷 vs 低 T 敌人 → 成功', () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({
          characterId: 'ally1', name: '敏捷贼',
          side: 'ally', tier: 3,
          attributes: { str: 8, dex: 18, con: 8, int: 8, spi: 8 },
        }),
        makeParticipant({
          characterId: 'enemy1', name: '迟钝兽',
          side: 'enemy', tier: 1,
        }),
      ],
    });

    // 敏捷 18 + d20(15) = 33, DC = 15 + T1×2 = 17 → 成功
    const result = resolveFlee(combat, 'ally1', 15);
    expect(result.success).toBe(true);
    expect(result.description).toContain('逃脱');
  });

  it('逃跑检定: 低敏捷 vs 高 T 敌人 → 失败', () => {
    const combat = makeCombatState({
      participants: [
        makeParticipant({
          characterId: 'ally1', name: '缓慢法师',
          side: 'ally', tier: 3,
          attributes: { str: 6, dex: 6, con: 6, int: 18, spi: 14 },
        }),
        makeParticipant({
          characterId: 'enemy1', name: '迅影龙',
          side: 'enemy', tier: 6,
        }),
      ],
    });

    // 敏捷 6 + d20(5) = 11, DC = 15 + T6×2 = 27 → 失败
    const result = resolveFlee(combat, 'ally1', 5);
    expect(result.success).toBe(false);
    expect(result.description).toContain('失败');
  });
});

// ========== 战斗管理 ==========

describe('initCombat / endCombat', () => {
  it('initCombat 创建正确的战斗状态', () => {
    const ally = makeParticipant({ characterId: 'a1', name: '勇者', side: 'ally' });
    const enemy = makeParticipant({ characterId: 'e1', name: '哥布林', side: 'enemy' });

    const combat = initCombat({
      combatType: '标准',
      allies: [{
        ...ally,
        side: 'ally',
      }],
      enemies: [{
        ...enemy,
        side: 'enemy',
      }],
      environment: '洞窟',
      d20Rolls: [15, 8],
    });

    expect(combat.status).toBe('active');
    expect(combat.round).toBe(1);
    expect(combat.participants).toHaveLength(2);
    expect(combat.participants[0].side).toBe('ally');
    expect(combat.participants[1].side).toBe('enemy');
    expect(combat.turnOrder).toHaveLength(2);
    // 先攻降序排列
    expect(combat.turnOrder[0].totalInitiative).toBeGreaterThanOrEqual(combat.turnOrder[1].totalInitiative);
    expect(combat.environment).toBe('洞窟');
  });

  it('endCombat 设置结束状态', () => {
    const combat = makeCombatState();
    const ended = endCombat(combat, 'ally');
    expect(ended.status).toBe('ended');
    expect(ended.winner).toBe('ally');
  });

  it('endCombat 平局', () => {
    const combat = makeCombatState();
    const ended = endCombat(combat, 'draw');
    expect(ended.winner).toBe('draw');
  });
});

// ========== getCombatState ==========

describe('getCombatState', () => {
  it('返回友方和敌方的 HP 摘要', () => {
    const combat = makeCombatState();
    const state = getCombatState(combat);

    expect(state).toContain('勇者');
    expect(state).toContain('HP 100/100');
    expect(state).toContain('哥布林');
    expect(state).toContain('HP 100/100');
    expect(state).toContain('回合1');
    expect(state).toContain('标准');
  });
});

// ========== 参与者转换 ==========

describe('characterToCombatParticipant', () => {
  it('从 CharacterState 创建 CombatParticipant', () => {
    const char: CharacterState = {
      id: 'char1',
      type: 'player',
      name: '勇者',
      race: '人类',
      identity: [],
      occupation: [],
      tier: 3,
      tierName: '精英',
      level: 10,
      totalExp: 5000,
      expToNext: 1200,
      attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
      freeAttrPoints: 2,
      hp: 100, maxHp: 100,
      mp: 50, maxMp: 50,
      sp: 50, maxSp: 50,
      ascension: {
        enabled: false,
        elements: {},
        authority: {},
        law: {},
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      equipment: [
        { slot: 'weapon', itemId: 'w1', name: '长剑', stats: { atk: 25, hit: 3 } },
        { slot: 'armor', itemId: 'a1', name: '皮甲', stats: { defense: 200, dr: 0.1 } },
      ],
      skills: [],
      inventory: [],
      statusEffects: [],
      money: 100,
      location: '城镇',
      adventurerRank: 'C',
      currentAction: '',
      customFields: {},
    };

    const cp = characterToCombatParticipant(char, 'ally');

    expect(cp.characterId).toBe('char1');
    expect(cp.name).toBe('勇者');
    expect(cp.tier).toBe(3);
    expect(cp.weaponAtk).toBe(25);
    expect(cp.hitBonus).toBe(3);
    expect(cp.defense).toBe(200);
    expect(cp.dr).toBe(0.1);
    expect(cp.side).toBe('ally');
    expect(cp.canAct).toBe(true);
  });

  it('HP=0 的角色 canAct=false', () => {
    const char: CharacterState = {
      id: 'char2',
      type: 'monster',
      name: '濒死哥布林',
      race: '兽族',
      identity: [],
      occupation: [],
      tier: 1,
      tierName: '普通',
      level: 3,
      totalExp: 100,
      expToNext: 200,
      attributes: { str: 8, dex: 10, con: 7, int: 4, spi: 5 },
      freeAttrPoints: 0,
      hp: 0, maxHp: 40,
      mp: 10, maxMp: 10,
      sp: 10, maxSp: 10,
      ascension: {
        enabled: false,
        elements: {},
        authority: {},
        law: {},
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      equipment: [],
      skills: [],
      inventory: [],
      statusEffects: [],
      money: 0,
      location: '',
      adventurerRank: '未评级',
      currentAction: '',
      customFields: {},
    };

    const cp = characterToCombatParticipant(char, 'enemy');
    expect(cp.canAct).toBe(false);
  });

  it('overrides 可以覆盖转换值', () => {
    const char: CharacterState = {
      id: 'char3',
      type: 'npc',
      name: '佣兵',
      race: '人类',
      identity: [],
      occupation: [],
      tier: 2,
      tierName: '中坚',
      level: 6,
      totalExp: 2000,
      expToNext: 600,
      attributes: { str: 12, dex: 10, con: 11, int: 8, spi: 8 },
      freeAttrPoints: 1,
      hp: 80, maxHp: 80,
      mp: 30, maxMp: 30,
      sp: 30, maxSp: 30,
      ascension: {
        enabled: false,
        elements: {},
        authority: {},
        law: {},
        deityPosition: '',
        divineKingdom: { name: '', description: '' },
      },
      equipment: [],
      skills: [],
      inventory: [],
      statusEffects: [],
      money: 50,
      location: '',
      adventurerRank: '未评级',
      currentAction: '',
      customFields: {},
    };

    const cp = characterToCombatParticipant(char, 'enemy', {
      hitBonus: 5,
      weaponAtk: 30,
    });

    expect(cp.hitBonus).toBe(5);
    expect(cp.weaponAtk).toBe(30);
  });
});

// ========== $combat namespace ==========

describe('$combat namespace', () => {
  it('所有方法可调用', async () => {
    const mod = await import('./combat-resolver');
    const { $combat } = mod;
    expect(typeof $combat.attack).toBe('function');
    expect(typeof $combat.defend).toBe('function');
    expect(typeof $combat.flee).toBe('function');
    expect(typeof $combat.initCombat).toBe('function');
    expect(typeof $combat.endCombat).toBe('function');
    expect(typeof $combat.getState).toBe('function');
    expect(typeof $combat.characterToParticipant).toBe('function');
  });
});
