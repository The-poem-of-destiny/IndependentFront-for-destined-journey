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
import { getHitRating, INTENTION_CONFIGS, HIT_RATINGS } from './types';

import { resolveIntention, parseIntentionFromInput, checkNonLethal } from './combat-intention';
import {
  runDamagePipeline,
  performAttackCheck,
  checkStatusTrigger,
  resolveRelevantAttribute,
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
  /** 🐛修复: 第二颗攻击 d20（层级优劣势 2d20 用；不提供时引擎内部掷独立均匀 d20） */
  d20Attack2?: number;
  /** d20 骰值 (意图判定·攻方) */
  d20Intention?: number;
  /** 🐛修复: d20 骰值 (意图判定·守方)。旧实现攻守共用一颗骰(管线版)或守方随机(legacy)，
   *  对抗公式两侧的 d20 会互相抵消 → 同层级下对抗必败。规范要求双方各自独立掷骰。 */
  d20IntentionDefender?: number;
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
  const dmgType: DamageType = input.damageType ?? '物理';
  // 🐛修复(对抗验证): 与管线版一致 —— 关联属性可显式指定，缺省按伤害类型推导
  // （物理→str/能量→int/精神→spi），法系攻击不再错用力量算初伤。
  const relAttrName = resolveRelevantAttribute(input.relevantAttribute, dmgType);
  const relAttrValue =
    input.relevantAttributeValue ?? attacker.attributes[relAttrName] ?? attacker.attributes.str;
  const multiHit = input.multiHitCount ?? 1;

  // ===== Step 1: 意图解析 + 判定 =====
  const intentionLevel: IntentionLevel = input.userInput
    ? parseIntentionFromInput(input.userInput)
    : '常规';

  // 🐛修复: "打晕/活捉"等关键词解析为非致死意图时，必须同步置 nonLethal 标记，
  // 否则叙事承诺"HP锁1昏迷"而引擎照样打死（关键词解析与 checkNonLethal 此前无联动）
  const nonLethal = (input.nonLethal ?? false) || intentionLevel === '非致死';

  const isShakenOrWorse =
    defender.morale === 'shaken' || defender.morale === 'wavering' || defender.morale === 'routing';

  const intention = resolveIntention({
    intentionLevel,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    defenderIncapacitated: !defender.canAct,
    defenderMorale: defender.morale,
    isExecutionIntent: intentionLevel === '抹杀' || intentionLevel === '概念',
    nonLethal,
    // 🐛修复(对抗验证): 攻方骰缺省也掷真实 d20（旧常量 10 使缺省路径下高难度意图恒败），
    // 守方骰优先用外部提供值（支持骰池/确定性测试），缺省保持随机
    attackerD20: input.d20Intention ?? Math.floor(Math.random() * 20) + 1,
    // 🐛修复: 守方骰优先用外部提供值（支持骰池/确定性测试），缺省保持原随机行为
    defenderD20: input.d20IntentionDefender ?? Math.floor(Math.random() * 20) + 1,
  });

  // ===== Step 2: 攻击检定 =====
  const dodgeNegated =
    attacker.tier > defender.tier + 1 ||
    !defender.canAct ||
    (isShakenOrWorse && intention.verdict === '自动成功');

  const attackCheck = performAttackCheck({
    d20Roll: input.d20Attack,
    d20Roll2: input.d20Attack2,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    hitBonus: attacker.hitBonus,
    defenderDodge: defender.dodgeBonus,
    dodgeNegated,
  });

  // 🐛修复: 处决意图承诺"评级保底为暴击(1.3)"，此前只是 extraEffects 字符串从未生效
  let effectiveRating = attackCheck.rating;
  if (intention.level === '处决' && effectiveRating.coefficient < 1.3) {
    const critRating = HIT_RATINGS.find((r) => r.level === '暴击');
    if (critRating) effectiveRating = critRating;
  }

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
    ratingCoefficient: effectiveRating.coefficient,
    intentionCoefficient: intention.coefficient,
    drRate: defender.dr,
    isClusterTarget: false, // Phase 6c
    currentHp: defender.hp,
  });

  // ===== Step 4: 非致死检查 =====
  const nonLethalResult = checkNonLethal({
    nonLethal,
    ratingCoefficient: effectiveRating.coefficient,
    finalDamage: damageBreakdown.finalDamage,
    currentHp: defender.hp,
  });

  const finalHp = nonLethalResult.adjustedHp;
  const isDead = finalHp <= 0;

  // ===== Step 5: 状态施加判定 =====
  const statusApplied: CombatActionResult['statusApplied'] = [];
  if (effectiveRating.coefficient >= 1.3) {
    // 暴击必触发 — 此处仅为示例
    statusApplied.push({
      name: `${effectiveRating.level}冲击`,
      duration: 1,
      effect: '目标下一次闪避-2',
    });
  }
  if (nonLethalResult.unconscious) {
    statusApplied.push({
      name: '昏迷',
      duration: 2,
      effect: '失去行动能力，闪避无效',
    });
  }

  // ===== Step 6: StatePatch 生成 =====
  // 🐛修复: patch 必须与 finalHp 一致。旧实现非致死锁血时面板显示 HP=1、
  // patch 却按全额伤害扣 → 落库后角色死亡。统一改为 amount = finalHp - 当前HP。
  const patches: StatePatch[] = [
    {
      op: 'delta_hp',
      target: `characters.${defender.characterId}`,
      // 🐛修复(对抗验证): 战斗产生的 delta_hp 永不为正（防御性下限，防止任何路径反向加血）
      amount: Math.min(0, finalHp - defender.hp),
      metadata: { source: 'combat', attackerId: attacker.characterId },
    },
  ];
  if (nonLethalResult.unconscious) {
    patches.push({
      op: 'add_status_effect',
      target: `characters.${defender.characterId}`,
      value: {
        name: '昏迷',
        description: '非致死攻击击昏，失去行动能力',
        category: '减益',
        stacks: 1,
        remainingTime: 2,
        timeUnit: '回合',
        source: '减益-战斗;休息或治疗解除',
        sourceKey: '战斗',
        effects: {},
        lifecycle: '战斗',
      },
      metadata: { source: 'combat-nonlethal' },
    });
  }

  // 🐛修复: costs.hp 此前从不生成 patch（HP 代价技能白嫖），与 mp/sp 对齐
  if (input.costs?.hp) {
    patches.push({
      op: 'delta_hp',
      target: `characters.${attacker.characterId}`,
      amount: -input.costs.hp,
      metadata: { source: 'combat_skill_cost' },
    });
  }
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
    ratingName: effectiveRating.level,
    ratingCoeff: effectiveRating.coefficient,
    advantage: attackCheck.advantage,
    disadvantage: attackCheck.disadvantage,
    statusApplied: statusApplied.map((s) => ({
      ...s,
      triggered: true,
      reason: s.name === '昏迷' ? '非致死锁血击昏' : `暴击(≥1.3)必触发`,
    })),
    isDead,
    nonLethalNote: nonLethalResult.narrative || undefined,
  }).split('\n');

  // ===== 描述 =====
  const description = buildCombatSummary({
    attackerName: attacker.name,
    defenderName: defender.name,
    damage: damageBreakdown.finalDamage,
    ratingName: effectiveRating.level,
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
      rating: effectiveRating,
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
          // 🐛修复: 补齐 category/timeUnit/lifecycle —— 缺 category 时 tickBuffs 两个阶段都
          // 不处理该 buff（round.start 只 tick 增益、round.end 只 tick 减益/特殊），永不过期
          category: '增益',
          stacks: 1,
          remainingTime: 1,
          timeUnit: '回合',
          source: 'combat-defend',
          sourceKey: '战斗',
          effects: { defense: 0.5, dodge: 3 },
          lifecycle: '战斗',
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

  // 逃跑检定: 敏捷 + d20 vs DC = 15 + 对方平均层级×2
  // 🐛修复: 旧实现固定按 side==='enemy' 算 DC —— 敌方单位逃跑时错拿己方层级当阻拦方。
  // 改为「与逃跑者敌对的一方」的平均层级。
  const opponents = combat.participants.filter((p) => p.side !== participant.side);
  const avgEnemyTier =
    opponents.length > 0 ? opponents.reduce((sum, p) => sum + p.tier, 0) / opponents.length : 0;

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
    ...params.allies.map((a) => ({ ...a, side: 'ally' as const })),
    ...params.enemies.map((e) => ({ ...e, side: 'enemy' as const })),
  ];

  const turns = allParticipants.map((p, i) => rollInitiative(p, params.d20Rolls[i] ?? 10));
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
    .filter((p) => p.side === 'ally')
    .map((p) => `${p.name}: HP ${p.hp}/${p.maxHp}`)
    .join(', ');

  const enemyStatus = combat.participants
    .filter((p) => p.side === 'enemy')
    .map((p) => `${p.name}: HP ${p.hp}/${p.maxHp}`)
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
  // M2: 装备 = inventory 中 equippedSlot 非空的物品（规范 §3，槽位为中文枚举 EQUIP_SLOTS）
  const weapon = char.inventory.find((i) => i.equippedSlot === '武器');
  const armor = char.inventory.find((i) => i.equippedSlot === '身体');

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
    // 🐛修复(2026-07-31 定向压测): clusterCount 此前不拷贝 —— 管线 Step 8(×1.5)与结算 EXP 衰减
    // 都从 participant 读该字段,真实链路恒 undefined,集群机制只在手工构造 participant 的单测里活着
    clusterCount: (char as CharacterState & { clusterCount?: number }).clusterCount,
    ...overrides,
  };
}

// ========== 内部工具 ==========

function findParticipant(combat: CombatState, characterId: string): CombatParticipant | undefined {
  return combat.participants.find((p) => p.characterId === characterId);
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
