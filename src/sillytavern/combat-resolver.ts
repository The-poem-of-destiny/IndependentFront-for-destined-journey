/**
 * 战斗解析器 — Layer 3 流程级 ($combat namespace, AI 可见)
 *
 * 职责: 整合意图→先攻→攻击→伤害→面板→StatePatch 完整战斗管线。
 * 对齐世界书 #837805 [战斗协议]。
 *
 * $combat API (AI 可见):
 *   $combat.attack()     — 执行单次攻击 (完整管线)
 *   $combat.defend()     — 防御动作
 *   $combat.useSkill()   — 使用技能
 *   $combat.useItem()    — 使用道具
 *   $combat.flee()       — 逃跑
 *   $combat.getState()   — 获取当前战斗状态
 *   $combat.initCombat() — 初始化战斗
 *   $combat.endCombat()  — 结束战斗
 */

import type {
  CombatType,
  DamageType,
  IntentionLevel,
  IntentionResult,
  CombatState,
  CombatParticipant,
  CombatActionRequest,
  CombatActionResult,
  CombatDamageBreakdown,
  CombatRoundLog,
  CombatActionLog,
  HitRating,
  StatePatch,
  StatusEffect,
  CharacterState,
} from './types';
import { getHitRating, INTENTION_CONFIGS } from './types';

import { resolveIntention, parseIntentionFromInput, checkNonLethal } from './combat-intention';
import {
  runDamagePipeline,
  performAttackCheck,
  checkStatusTrigger,
} from './combat-damage';
import { rollInitiative, consumeAttack, consumeAction } from './combat-turn';
import { buildFullActionPanel, buildCombatSummary } from './combat-panel';

// ========== $combat API: 攻击 ==========

export interface AttackInput {
  /** 当前战斗状态 */
  combat: CombatState;
  /** 攻击者 ID */
  attackerId: string;
  /** 目标 ID */
  defenderId: string;
  /** 用户原始输入 (用于意图解析) */
  userInput?: string;
  /** 动作类型 */
  action?: 'attack' | 'skill' | 'item';
  /** 技能 ID */
  skillId?: string;
  /** 技能名称 */
  skillName?: string;
  /** 技能威力 */
  skillPower?: number;
  /** 技能标签 (如多段/连击/范围等) */
  skillTags?: string[];
  /** 武器名称 */
  weaponName?: string;
  /** 武器攻击力 */
  weaponAtk?: number;
  /** 关联属性名 (用于伤害公式) */
  relevantAttribute?: string;
  /** 关联属性值 */
  relevantAttributeValue?: number;
  /** 伤害类型 */
  damageType?: DamageType;
  /** 多段攻击次数 */
  multiHitCount?: number;
  /** 非致死标记 */
  nonLethal?: boolean;
  /** 消耗 */
  costs?: { hp?: number; mp?: number; sp?: number };
  /** d20 骰值 (攻击检定) */
  d20Attack: number;
  /** d20 骰值 (意图判定) */
  d20Intention?: number;
  /** d20 骰值 (状态触发判定) */
  d20Status?: number;
}

/**
 * $combat.attack() — 执行完整的单次攻击管线。
 *
 * 管线顺序:
 *   1. 意图解析 + 判定
 *   2. 攻击检定 (优劣势 + 闪避)
 *   3. 8 步伤害管线
 *   4. 非致死检查
 *   5. 状态施加判定
 *   6. 生成 StatePatch + 面板
 */
export function resolveAttack(input: AttackInput): CombatActionResult {
  const combat = input.combat;
  const attacker = findParticipant(combat, input.attackerId);
  const defender = findParticipant(combat, input.defenderId);

  if (!attacker) {
    return createErrorResult(input, `攻击者 ${input.attackerId} 不在战斗中`);
  }
  if (!defender) {
    return createErrorResult(input, `目标 ${input.defenderId} 不在战斗中`);
  }

  // 确定伤害计算参数 (使用默认值或传入值)
  const weaponAtk = input.weaponAtk ?? attacker.weaponAtk;
  const skillPower = input.skillPower ?? 0;
  const relAttrValue = input.relevantAttributeValue ?? attacker.attributes.str;
  const dmgType: DamageType = input.damageType ?? '物理';
  const multiHit = input.multiHitCount ?? 1;

  // ===== Step 1: 意图解析 + 判定 =====
  const intentionLevel: IntentionLevel = input.userInput
    ? parseIntentionFromInput(input.userInput)
    : '常规';

  const isShakenOrWorse =
    defender.morale === 'shaken' ||
    defender.morale === 'wavering' ||
    defender.morale === 'routing';

  const intention = resolveIntention({
    intentionLevel,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    defenderIncapacitated: !defender.canAct,
    defenderMorale: defender.morale,
    isExecutionIntent: intentionLevel === '抹杀' || intentionLevel === '概念',
    nonLethal: input.nonLethal ?? false,
    attackerD20: input.d20Intention ?? 10,
    defenderD20: Math.floor(Math.random() * 20) + 1, // deterministic alternative would be better
  });

  // ===== Step 2: 攻击检定 =====
  const dodgeNegated =
    attacker.tier > defender.tier + 1 ||
    !defender.canAct ||
    (isShakenOrWorse && intention.verdict === '自动成功');

  const attackCheck = performAttackCheck({
    d20Roll: input.d20Attack,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    hitBonus: attacker.hitBonus,
    defenderDodge: defender.dodgeBonus,
    dodgeNegated,
  });

  // ===== Step 3: 8 步伤害管线 =====
  const damageBreakdown = runDamagePipeline({
    relevantAttribute: relAttrValue,
    attackerTier: attacker.tier,
    skillPower,
    weaponAtk,
    multiHitCount: multiHit,
    defenderDefense: defender.defense,
    penetrationRate: attacker.penetration,
    damageType: dmgType,
    defenderAttributes: defender.attributes,
    ratingCoefficient: attackCheck.rating.coefficient,
    intentionCoefficient: intention.coefficient,
    drRate: defender.dr,
    isClusterTarget: false, // Phase 6c
    currentHp: defender.hp,
  });

  // ===== Step 4: 非致死检查 =====
  const nonLethalResult = checkNonLethal({
    nonLethal: input.nonLethal ?? false,
    ratingCoefficient: attackCheck.rating.coefficient,
    finalDamage: damageBreakdown.finalDamage,
    currentHp: defender.hp,
  });

  const finalHp = nonLethalResult.adjustedHp;
  const isDead = finalHp <= 0;

  // ===== Step 5: 状态施加判定 =====
  const statusApplied: CombatActionResult['statusApplied'] = [];
  if (attackCheck.rating.coefficient >= 1.3) {
    // 暴击必触发 — 此处仅为示例
    statusApplied.push({
      name: `${attackCheck.rating.level}冲击`,
      duration: 1,
      effect: '目标下一次闪避-2',
    });
  }

  // ===== Step 6: StatePatch 生成 =====
  const patches: StatePatch[] = [
    {
      op: 'delta_hp',
      target: `characters.${defender.characterId}`,
      amount: -damageBreakdown.finalDamage,
      metadata: { source: 'combat', attackerId: attacker.characterId },
    },
  ];

  if (input.costs?.mp) {
    patches.push({
      op: 'delta_mp',
      target: `characters.${attacker.characterId}`,
      amount: -input.costs.mp,
      metadata: { source: 'combat_skill_cost' },
    });
  }
  if (input.costs?.sp) {
    patches.push({
      op: 'delta_sp',
      target: `characters.${attacker.characterId}`,
      amount: -input.costs.sp,
      metadata: { source: 'combat_skill_cost' },
    });
  }

  // ===== Step 7: 面板生成 =====
  const panelLines = buildFullActionPanel({
    attackerName: attacker.name,
    defenderName: defender.name,
    attackerHp: { before: attacker.hp, after: attacker.hp, max: attacker.maxHp },
    defenderHp: { before: defender.hp, after: finalHp, max: defender.maxHp },
    skillName: input.skillName ?? '普通攻击',
    weaponName: input.weaponName ?? '徒手',
    costs: input.costs ?? {},
    intention,
    damage: damageBreakdown,
    request: {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      action: input.action ?? 'attack',
      skillId: input.skillId,
      intentionKeywords: input.userInput,
      nonLethal: input.nonLethal,
      skillTags: input.skillTags,
      multiHitCount: multiHit,
      combatType: combat.combatType,
      round: combat.round,
      skillPower,
      relevantAttribute: input.relevantAttribute,
      damageType: dmgType,
      costs: input.costs,
    },
    diceRolls: attackCheck.diceRolls,
    hitBonus: attackCheck.hitBonus,
    dodgeBonus: attackCheck.effectiveDodge,
    checkValue: attackCheck.checkValue,
    ratingName: attackCheck.rating.level,
    ratingCoeff: attackCheck.rating.coefficient,
    advantage: attackCheck.advantage,
    disadvantage: attackCheck.disadvantage,
    statusApplied: statusApplied.map(s => ({
      ...s,
      triggered: true,
      reason: `暴击(≥1.3)必触发`,
    })),
    isDead,
    nonLethalNote: nonLethalResult.narrative || undefined,
  }).split('\n');

  // ===== 描述 =====
  const description = buildCombatSummary({
    attackerName: attacker.name,
    defenderName: defender.name,
    damage: damageBreakdown.finalDamage,
    ratingName: attackCheck.rating.level,
    isDead,
  });

  return {
    request: {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      action: input.action ?? 'attack',
      skillId: input.skillId,
      intentionKeywords: input.userInput,
      nonLethal: input.nonLethal,
      skillTags: input.skillTags,
      multiHitCount: multiHit,
      combatType: combat.combatType,
      round: combat.round,
      skillPower,
      relevantAttribute: input.relevantAttribute,
      damageType: dmgType,
      costs: input.costs,
    },
    intention,
    attackRoll: {
      diceUsed: attackCheck.diceUsed,
      advantage: attackCheck.advantage,
      disadvantage: attackCheck.disadvantage,
      diceRolls: attackCheck.diceRolls,
      dodgeNegated: attackCheck.dodgeNegated,
      dodgeNegatedReason: attackCheck.dodgeNegatedReason,
      hitBonus: attackCheck.hitBonus,
      dodgeBonus: attackCheck.effectiveDodge,
      checkValue: attackCheck.checkValue,
      rating: attackCheck.rating,
    },
    damage: damageBreakdown,
    finalHp,
    maxHp: defender.maxHp,
    isDead,
    isNarrativeAlive: !isDead,
    statusApplied,
    patches,
    panelLines,
    description,
  };
}

// ========== $combat API: 防御 ==========

export function resolveDefend(
  combat: CombatState,
  characterId: string,
): { success: boolean; patches: StatePatch[]; description: string } {
  const participant = findParticipant(combat, characterId);
  if (!participant) {
    return { success: false, patches: [], description: `${characterId} 不在战斗中` };
  }

  consumeAction({ sequence: combat.turnOrder, round: combat.round }, characterId);

  return {
    success: true,
    patches: [
      {
        op: 'add_status_effect',
        target: `characters.${characterId}`,
        value: {
          name: '防御姿态',
          description: '本回合防御+50%，闪避+3',
          stacks: 1,
          remainingTime: 1,
          source: 'combat-defend',
          effects: { defense: 0.5, dodge: 3 },
        },
      },
    ],
    description: `${participant.name} 进入防御姿态`,
  };
}

// ========== $combat API: 逃跑 ==========

export function resolveFlee(
  combat: CombatState,
  characterId: string,
  d20Roll: number,
): { success: boolean; description: string; patches: StatePatch[] } {
  const participant = findParticipant(combat, characterId);
  if (!participant) {
    return { success: false, description: `${characterId} 不在战斗中`, patches: [] };
  }

  // 逃跑检定: 敏捷 + d20 vs DC 15 + 敌方平均层级
  const avgEnemyTier = combat.participants
    .filter(p => p.side === 'enemy')
    .reduce((sum, p, _i, arr) => sum + p.tier / arr.length, 0);

  const dc = 15 + Math.floor(avgEnemyTier * 2);
  const roll = participant.attributes.dex + d20Roll;
  const success = roll >= dc;

  return {
    success,
    description: success
      ? `${participant.name} 成功逃脱！`
      : `${participant.name} 逃跑失败 (${roll} vs DC${dc})`,
    patches: success
      ? [{ op: 'set_location', target: `characters.${characterId}`, value: 'escape' }]
      : [],
  };
}

// ========== $combat API: 战斗管理 ==========

/**
 * 初始化一场新战斗。
 * 从角色列表创建 CombatState。
 */
export function initCombat(params: {
  combatType: CombatType;
  allies: CombatParticipant[];
  enemies: CombatParticipant[];
  environment: string;
  d20Rolls: number[];
}): CombatState {
  const allParticipants = [
    ...params.allies.map(a => ({ ...a, side: 'ally' as const })),
    ...params.enemies.map(e => ({ ...e, side: 'enemy' as const })),
  ];

  const turns = allParticipants.map((p, i) =>
    rollInitiative(p, params.d20Rolls[i] ?? 10),
  );
  turns.sort((a, b) => b.totalInitiative - a.totalInitiative);

  const combatId = `combat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  return {
    combatId,
    combatType: params.combatType,
    round: 1,
    participants: allParticipants,
    turnOrder: turns,
    currentTurnIndex: 0,
    status: 'active',
    environment: params.environment,
    patches: [],
    roundLogs: [],
  };
}

/** 结束战斗并生成结算 Patch */
export function endCombat(combat: CombatState, winner: 'ally' | 'enemy' | 'draw'): CombatState {
  return {
    ...combat,
    status: 'ended',
    winner,
  };
}

/** 获取当前战斗状态摘要 */
export function getCombatState(combat: CombatState): string {
  const allyStatus = combat.participants
    .filter(p => p.side === 'ally')
    .map(p => `${p.name}: HP ${p.hp}/${p.maxHp}`)
    .join(', ');

  const enemyStatus = combat.participants
    .filter(p => p.side === 'enemy')
    .map(p => `${p.name}: HP ${p.hp}/${p.maxHp}`)
    .join(', ');

  return `回合${combat.round} | 类型${combat.combatType} | 友方: ${allyStatus} | 敌方: ${enemyStatus}`;
}

// ========== 参与者转换 ==========

/**
 * 从 CharacterState 创建 CombatParticipant。
 * 填充战斗所需的衍生字段。
 */
export function characterToCombatParticipant(
  char: CharacterState,
  side: 'ally' | 'enemy',
  overrides?: Partial<CombatParticipant>,
): CombatParticipant {
  const weapon = char.equipment.find(e => e.slot === 'weapon');
  const armor = char.equipment.find(e => e.slot === 'armor');

  return {
    characterId: char.id,
    name: char.name,
    tier: char.tier,
    level: char.level,
    attributes: { ...char.attributes },
    hp: char.hp,
    maxHp: char.maxHp,
    mp: char.mp,
    maxMp: char.maxMp,
    sp: char.sp,
    maxSp: char.maxSp,
    defense: armor?.stats?.defense ?? 10,
    dr: armor?.stats?.dr ?? 0,
    penetration: weapon?.stats?.penetration ?? 0,
    hitBonus: weapon?.stats?.hit ?? 0,
    dodgeBonus: armor?.stats?.dodge ?? 0,
    speedModifiers: [],
    fixedInitiativeBonus: 0,
    attacksRemaining: 1,
    actionsRemaining: 1,
    statusEffects: char.statusEffects,
    weaponAtk: weapon?.stats?.atk ?? 0,
    side,
    canAct: char.hp > 0,
    ...overrides,
  };
}

// ========== 内部工具 ==========

function findParticipant(combat: CombatState, characterId: string): CombatParticipant | undefined {
  return combat.participants.find(p => p.characterId === characterId);
}

function createErrorResult(input: AttackInput, error: string): CombatActionResult {
  return {
    request: {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      action: input.action ?? 'attack',
    },
    intention: {
      level: '常规',
      verdict: '无需判定',
      coefficient: 1.0,
      extraEffects: [],
      narrativeNote: error,
    },
    attackRoll: {
      diceUsed: 0,
      advantage: false,
      disadvantage: false,
      diceRolls: [],
      dodgeNegated: false,
      hitBonus: 0,
      dodgeBonus: 0,
      checkValue: 0,
      rating: { level: '失手', coefficient: 0, minCheckValue: -999, triggersStatus: false },
    },
    damage: {
      initialDamage: 0,
      initialFormula: error,
      afterMultiSplit: 0,
      penetration: { originalDef: 0, penetrationRate: 0, effectiveDef: 0 },
      equipmentReduction: 0,
      afterEquipmentReduction: 0,
      typeReductionRate: 0,
      typeReductionAmount: 0,
      afterTypeReduction: 0,
      ratingCoefficient: 0,
      intentionCoefficient: 1,
      afterRating: 0,
      drRate: 0,
      drReduction: 0,
      afterDr: 0,
      finalDamage: 0,
    },
    finalHp: 0,
    maxHp: 0,
    isDead: false,
    isNarrativeAlive: true,
    statusApplied: [],
    patches: [],
    panelLines: [error],
    description: error,
  };
}

// ========== $combat namespace (AI-visible aggregator) ==========

/**
 * $combat namespace — AI 通过此 API 调用战斗功能。
 *
 * 语义级抽象 (ADR-19): AI 声明意图 ($combat.attack)，引擎内部执行公式。
 * AI 不直接接触数值管线。
 */
export const $combat = {
  /** 执行单次攻击 (完整管线) */
  attack: resolveAttack,

  /** 防御动作 */
  defend: resolveDefend,

  /** 逃跑检定 */
  flee: resolveFlee,

  /** 初始化战斗 */
  initCombat,

  /** 结束战斗 */
  endCombat,

  /** 获取战斗状态摘要 */
  getState: getCombatState,

  /** 将角色转为战斗参与者 */
  characterToParticipant: characterToCombatParticipant,
};

// Re-export sub-module functions for $combat.helpers
export { parseIntentionFromInput, resolveIntention, checkNonLethal };
export { rollInitiative, consumeAttack, consumeAction };
export { runDamagePipeline, performAttackCheck, checkStatusTrigger };
export { buildFullActionPanel, buildCombatSummary };
