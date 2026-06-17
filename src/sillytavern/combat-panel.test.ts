/**
 * combat-panel.ts 测试
 * 覆盖: 三阶段面板生成 / <action_info> 格式 / 辅助函数
 */
import { describe, it, expect } from 'vitest';
import {
  buildOverviewPanel,
  buildInitiativePanel,
  buildAttackPanel,
  buildFullActionPanel,
  buildCombatSummary,
  buildAoELine,
} from './combat-panel';
import type { CombatState, CombatUnitTurn, CombatDamageBreakdown, IntentionResult, CombatActionRequest } from './types';

// ========== 测试数据工厂 ==========

function makeCombatState(overrides: Partial<CombatState> = {}): CombatState {
  return {
    combatId: 'test-combat',
    combatType: '标准',
    round: 1,
    participants: [
      {
        characterId: 'ally1', name: '勇者', tier: 3, level: 10,
        attributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
        hp: 120, maxHp: 120, mp: 50, maxMp: 50, sp: 50, maxSp: 50,
        defense: 200, dr: 0.1, penetration: 0,
        hitBonus: 3, dodgeBonus: 2,
        speedModifiers: [], fixedInitiativeBonus: 0,
        attacksRemaining: 1, actionsRemaining: 1,
        statusEffects: [
          { id: 's1', name: '战意昂扬', description: '攻击+1', category: '增益', stacks: 1, remainingTime: 3, timeUnit: '回合', source: 'combat', effects: { atk: 1 } },
        ],
        weaponAtk: 25, side: 'ally', canAct: true,
      },
      {
        characterId: 'enemy1', name: '哥布林', tier: 1, level: 3,
        attributes: { str: 8, dex: 10, con: 7, int: 4, spi: 5 },
        hp: 40, maxHp: 40, mp: 10, maxMp: 10, sp: 10, maxSp: 10,
        defense: 50, dr: 0, penetration: 0,
        hitBonus: 1, dodgeBonus: 1,
        speedModifiers: [], fixedInitiativeBonus: 0,
        attacksRemaining: 1, actionsRemaining: 1,
        statusEffects: [],
        weaponAtk: 8, side: 'enemy', canAct: true,
      },
    ],
    turnOrder: [],
    currentTurnIndex: 0,
    status: 'active',
    environment: '平原',
    patches: [],
    roundLogs: [],
    ...overrides,
  };
}

function makeDamageBreakdown(): CombatDamageBreakdown {
  return {
    initialDamage: 670,
    initialFormula: '(14×10×4 + 50 + 30) = 670',
    afterMultiSplit: 670,
    penetration: { originalDef: 50, penetrationRate: 0, effectiveDef: 50 },
    equipmentReduction: 16,
    afterEquipmentReduction: 654,
    typeReductionRate: 0.08,
    typeReductionAmount: 52,
    afterTypeReduction: 602,
    ratingCoefficient: 1.0,
    intentionCoefficient: 1.0,
    afterRating: 602,
    drRate: 0,
    drReduction: 0,
    afterDr: 602,
    finalDamage: 602,
  };
}

function makeIntentionResult(): IntentionResult {
  return {
    level: '常规',
    verdict: '无需判定',
    coefficient: 1.0,
    extraEffects: [],
    narrativeNote: '常规攻击直接检定',
  };
}

function makeRequest(): CombatActionRequest {
  return {
    attackerId: 'ally1',
    defenderId: 'enemy1',
    action: 'attack',
    skillName: '普通攻击',
    intentionKeywords: '砍向敌人',
  };
}

function makeTurnOrder(): CombatUnitTurn[] {
  return [
    { characterId: 'ally1', name: '勇者', agility: 13, d20Roll: 15, speedModifiers: [], totalInitiative: 28, attacksRemaining: 1, actionsRemaining: 1 },
    { characterId: 'enemy1', name: '哥布林', agility: 10, d20Roll: 8, speedModifiers: [], totalInitiative: 18, attacksRemaining: 1, actionsRemaining: 1 },
  ];
}

// ========== Phase 1: 战况总览 ==========

describe('buildOverviewPanel', () => {
  it('包含 <action_info> 标签和战况总览标记', () => {
    const panel = buildOverviewPanel(makeCombatState());
    expect(panel).toContain('<action_info>');
    expect(panel).toContain('{战况总览}');
    expect(panel).toContain('</action_info>');
  });

  it('列出所有参战单位和属性', () => {
    const panel = buildOverviewPanel(makeCombatState());
    expect(panel).toContain('勇者');
    expect(panel).toContain('哥布林');
    expect(panel).toContain('HP 120/120');
    expect(panel).toContain('HP 40/40');
    expect(panel).toContain('力14');
    expect(panel).toContain('敏13');
  });

  it('包含回合/类型/环境', () => {
    const panel = buildOverviewPanel(makeCombatState());
    expect(panel).toContain('回合: 1');
    expect(panel).toContain('类型: 标准');
    expect(panel).toContain('环境: 平原');
  });

  it('状态效果的展示', () => {
    const panel = buildOverviewPanel(makeCombatState());
    expect(panel).toContain('战意昂扬');
    expect(panel).toContain('3回合');
  });

  it('包含叙事指导', () => {
    const panel = buildOverviewPanel(makeCombatState());
    expect(panel).toContain('叙事指导');
  });
});

// ========== Phase 2: 行动顺序 ==========

describe('buildInitiativePanel', () => {
  it('包含先攻计算详情', () => {
    const panel = buildInitiativePanel(makeTurnOrder());
    expect(panel).toContain('{行动顺序}');
    expect(panel).toContain('勇者');
    expect(panel).toContain('哥布林');
    expect(panel).toContain('序列');
  });

  it('按先攻降序列出', () => {
    const panel = buildInitiativePanel(makeTurnOrder());
    const yuushaIdx = panel.indexOf('勇者');
    const gobIdx = panel.indexOf('哥布林');
    expect(yuushaIdx).toBeLessThan(gobIdx);
  });
});

// ========== Phase 3: 攻击行动 ==========

describe('buildAttackPanel', () => {
  const baseParams = {
    attackerName: '勇者',
    defenderName: '哥布林',
    skillName: '斩击',
    weaponName: '长剑',
    costs: { mp: 5 },
    intention: makeIntentionResult(),
    damage: makeDamageBreakdown(),
    request: makeRequest(),
    attackerAttributes: { str: 14, dex: 13, con: 12, int: 10, spi: 11 },
    defenderAttributes: { str: 8, dex: 10, con: 7, int: 4, spi: 5 },
    diceRolls: [15],
    hitBonus: 3,
    dodgeBonus: 1,
    checkValue: 17,
    ratingName: '有效',
    ratingCoeff: 1.0,
    advantage: false,
    disadvantage: false,
  };

  it('包含攻击行动标记', () => {
    const panel = buildAttackPanel(baseParams);
    expect(panel).toContain('{攻击行动}');
    expect(panel).toContain('<action_info>');
  });

  it('显示攻守双方和武器/技能', () => {
    const panel = buildAttackPanel(baseParams);
    expect(panel).toContain('勇者');
    expect(panel).toContain('哥布林');
    expect(panel).toContain('斩击');
    expect(panel).toContain('长剑');
    expect(panel).toContain('MP 5');
  });

  it('显示意图判定结果', () => {
    const panel = buildAttackPanel(baseParams);
    expect(panel).toContain('意图');
    expect(panel).toContain('常规');
  });

  it('显示伤害基准计算', () => {
    const panel = buildAttackPanel(baseParams);
    expect(panel).toContain('{伤害基准计算}');
    expect(panel).toContain('初始伤害');
    expect(panel).toContain('结算基值');
  });

  it('显示结算清单', () => {
    const panel = buildAttackPanel(baseParams);
    expect(panel).toContain('{结算清单}');
    expect(panel).toContain('掷骰');
    expect(panel).toContain('检定结果');
    expect(panel).toContain('有效');
  });

  it('带意图对抗检定的面板', () => {
    const contestedIntention: IntentionResult = {
      level: '战术',
      verdict: '成功',
      coefficient: 1.2,
      extraEffects: [],
      narrativeNote: '战术意图成功',
      contested: {
        attackerFormula: '(T3×5 + d20[15])',
        attackerValue: 30,
        defenderFormula: '(T1×5 + d20[8] + 意图难度[3])',
        defenderValue: 16,
      },
    };

    const panel = buildAttackPanel({ ...baseParams, intention: contestedIntention });
    expect(panel).toContain('意图判定: (T3×5 + d20[15])');
  });
});

// ========== 完整行动面板 ==========

describe('buildFullActionPanel', () => {
  const fullParams = {
    attackerName: '勇者',
    defenderName: '哥布林',
    attackerHp: { before: 120, after: 120, max: 120 },
    defenderHp: { before: 40, after: 0, max: 40 },
    skillName: '致命一击',
    weaponName: '长剑',
    costs: { mp: 10 },
    intention: makeIntentionResult(),
    damage: makeDamageBreakdown(),
    request: makeRequest(),
    diceRolls: [18],
    hitBonus: 5,
    dodgeBonus: 1,
    checkValue: 22,
    ratingName: '暴击',
    ratingCoeff: 1.3,
    advantage: false,
    disadvantage: false,
    statusApplied: [
      { name: '重伤', effect: '每回合-5HP', duration: 3, triggered: true, reason: '暴击必触发' },
      { name: '眩晕', effect: '无法行动', duration: 1, triggered: false, reason: '对抗失败' },
    ],
    isDead: true,
  };

  it('包含完整的行动面板', () => {
    const panel = buildFullActionPanel(fullParams);
    expect(panel).toContain('<action_info>');
    expect(panel).toContain('</action_info>');
    expect(panel).toContain('{攻击行动}');
  });

  it('显示 HP 变更和存活状态', () => {
    const panel = buildFullActionPanel(fullParams);
    expect(panel).toContain('HP 40 → 0');
    expect(panel).toContain('死亡/毁坏');
  });

  it('状态施加: 成功和失败都展示', () => {
    const panel = buildFullActionPanel(fullParams);
    expect(panel).toContain('重伤');
    expect(panel).toContain('触发成功');
    expect(panel).toContain('眩晕');
    expect(panel).toContain('失败');
  });

  it('暴击评定显示', () => {
    const panel = buildFullActionPanel(fullParams);
    expect(panel).toContain('暴击');
    expect(panel).toContain('1.3');
  });
});

// ========== 简单摘要 ==========

describe('buildCombatSummary', () => {
  it('生成单行摘要', () => {
    const summary = buildCombatSummary({
      attackerName: '勇者',
      defenderName: '哥布林',
      damage: 50,
      ratingName: '有效',
      isDead: false,
    });
    expect(summary).toContain('勇者');
    expect(summary).toContain('哥布林');
    expect(summary).toContain('50伤害');
    expect(summary).not.toContain('[击杀]');
  });

  it('击杀标注', () => {
    const summary = buildCombatSummary({
      attackerName: '勇者',
      defenderName: '哥布林',
      damage: 50,
      ratingName: '暴击',
      isDead: true,
    });
    expect(summary).toContain('[击杀]');
  });
});

// ========== AoE ==========

describe('buildAoELine', () => {
  it('生成 AoE 目标行', () => {
    const line = buildAoELine('哥布林B', 15, '有效', 45);
    expect(line).toContain('→ 哥布林B');
    expect(line).toContain('15(有效)');
    expect(line).toContain('45');
  });
});
