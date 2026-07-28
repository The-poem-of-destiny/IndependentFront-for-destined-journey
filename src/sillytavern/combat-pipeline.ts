/**
 * combat-pipeline — 战斗管道 v2 (M3 战斗 v2 · 核心主文件)
 *
 * 职责: 把同步纯函数的 resolveAttack 升级为 async 管道版 resolveAttackPipeline，
 *      接入 M1 emitChain（19 event）+ M2 collect_mods（modifier 注入）+ 登神压制 + HP 红线 + 集群。
 *
 * 定位 (RFC D1): combat-resolver.ts 保留为 legacy（同步，193 测试零破坏）；
 *               本文件是管道版（async），M6 真机验证后才删 legacy。
 *
 * 子功能（stub，M3 agent 实现）:
 *  - combat-modifier-inject: foldModsToPipelineModifiers（4.4/4.5）
 *  - combat-morale-pipeline: runMoraleCheckPipeline（4.8）
 *  - combat-settlement-pipeline: runSettlementPipeline（4.9）
 *  - combat-actions-pipeline: useSkill/Item/block/move/focus（4.7）
 *
 * 对齐:
 *  - docs/reference/combat-system-architecture.md §六（19 event + 回合循环 + 攻击子流程）/ §八（8 步管线）/ §七（计算分工）
 *  - docs/planning/2026-07-28-combat-v2-m3-rfc.md（11 决策 + API 草案）
 */

import type { EventBus } from './game-event';
import type {
  CombatState,
  CombatActionResult,
  CombatParticipant,
  CombatDamageBreakdown,
  IntentionLevel,
  DamageType,
  StatePatch,
  StatusEffect,
  ReadonlyHookSet,
  CombatType,
} from './types';
import type { AttackInput } from './combat-resolver';
import type { Modifier, CheckModifier } from './effect-types';
import type { PipelineModifiers } from './combat-damage';

import { parseIntentionFromInput, resolveIntention } from './combat-intention';
import { runDamagePipeline, performAttackCheck } from './combat-damage';
import { collectAttackerMods, collectDefenderMods } from './modifier-collector';
import { buildCombatSummary } from './combat-panel';
import { foldModsToPipelineModifiers } from './combat-modifier-inject';
import { runMoraleCheckPipeline } from './combat-morale-pipeline';
import { tickBuffs } from './buff-registry';

// ========== 19 event 常量（集中定义，M4 Agent / M5 前端复用） ==========

export const COMBAT_EVENTS = {
  START: 'combat.start',
  END: 'combat.end',
  ROUND_START: 'combat.round.start',
  ROUND_END: 'combat.round.end',
  TURN_START: 'combat.turn.start',
  TURN_END: 'combat.turn.end',
  ATTACK_REQUEST: 'combat.attack.request',
  DICE_ROLL: 'combat.dice.roll',
  ATTACK_COLLECT_ATK: 'combat.attack.collect_attacker_mods',
  ATTACK_HIT: 'combat.attack.hit',
  ATTACK_MISS: 'combat.attack.miss',
  ATTACK_COLLECT_DEF: 'combat.attack.collect_defender_mods',
  ATTACK_DAMAGE: 'combat.attack.damage',
  ATTACK_RESULT: 'combat.attack.result',
  ACTION_USE: 'combat.action.use',
  FLEE_REQUEST: 'combat.flee.request',
  MORALE_CHECK: 'combat.morale.check',
  MORALE_RESULT: 'combat.morale.result',
  SETTLE_LOOT: 'combat.settle.loot',
  SETTLE_COMPLETE: 'combat.settle.complete',
} as const;

// ========== 管道上下文 ==========

export interface PipelineContext {
  bus: EventBus;
  /** 参战者 charId 列表（在场过滤） */
  combatants: string[];
  /** 只读查询钩子（M1，供 handler / $status 查角色状态） */
  readHooks?: ReadonlyHookSet;
  /** 当前回合号（round.start/end 用） */
  currentRound?: number;
  /** 战斗类型（战意阈值查表用） */
  combatType?: CombatType;
}

// ========== helper ==========

function findParticipant(combat: CombatState, characterId: string): CombatParticipant | undefined {
  return combat.participants.find((p) => p.characterId === characterId);
}

/** HP 红线 clamp（≥0） */
function clampHp(hp: number): number {
  return Math.max(0, hp);
}

/** 取参战者的 morale（CombatParticipant 可能有该字段，缺省 steady） */
function getMorale(p: CombatParticipant): string {
  return (p as any).morale ?? 'steady';
}

/** 零伤害 breakdown（miss 时用） */
function zeroDamageBreakdown(): CombatDamageBreakdown {
  return {
    initialDamage: 0,
    initialFormula: 'miss',
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
  };
}

function createErrorResult(input: AttackInput, error: string): CombatActionResult {
  return {
    request: {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      action: input.action ?? 'attack',
    },
    intention: {
      level: '常规' as IntentionLevel,
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
    damage: zeroDamageBreakdown(),
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

// ========== resolveAttackPipeline 核心（4.1/4.2/4.3/4.4/4.5/4.6/4.10） ==========

/**
 * async 攻击管道 —— 19 event 的攻击子流程链（架构 §6.3）。
 *
 * 管线: request → dice.roll → collect_attacker_mods → 检定 → hit/miss →
 *      collect_defender_mods → 8步(含登神+modifier) → HP红线 → damage event → 战意 → result event
 *
 * 红线 (D6): HP 扣减 clamp≥0；HP≤0 强制 isDead。
 * 集群 (D10): 守方集群时 finalDamage ×1.5（Step 8）。
 */
export async function resolveAttackPipeline(
  input: AttackInput,
  ctx: PipelineContext,
): Promise<CombatActionResult> {
  const combat = input.combat;
  const attacker = findParticipant(combat, input.attackerId);
  const defender = findParticipant(combat, input.defenderId);

  if (!attacker) return createErrorResult(input, `攻击者 ${input.attackerId} 不在战斗中`);
  if (!defender) return createErrorResult(input, `目标 ${input.defenderId} 不在战斗中`);

  // 参数确定（复用 legacy 默认值逻辑）
  const weaponAtk = input.weaponAtk ?? attacker.weaponAtk;
  const skillPower = input.skillPower ?? 0;
  const relAttrValue = input.relevantAttributeValue ?? attacker.attributes.str;
  const dmgType: DamageType = input.damageType ?? '物理';
  const multiHit = input.multiHitCount ?? 1;
  const chainCtx = { combatants: ctx.combatants, source: input.attackerId, readHooks: ctx.readHooks };

  // ===== event: combat.attack.request (AI→代码) =====
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ATTACK_REQUEST,
    {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      skillId: input.skillId,
      weaponName: input.weaponName,
      intentionKeywords: input.userInput,
      nonLethal: input.nonLethal,
    },
    chainCtx,
  );

  // ===== Step 1: 意图解析（复用 combat-intention） =====
  const intentionLevel: IntentionLevel = input.userInput
    ? parseIntentionFromInput(input.userInput)
    : '常规';
  const defenderMorale = getMorale(defender);
  const isShakenOrWorse =
    defenderMorale === 'shaken' || defenderMorale === 'wavering' || defenderMorale === 'routing';
  const intention = resolveIntention({
    intentionLevel,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    defenderIncapacitated: !defender.canAct,
    defenderMorale: defenderMorale as any,
    isExecutionIntent: intentionLevel === '抹杀' || intentionLevel === '概念',
    nonLethal: input.nonLethal ?? false,
    attackerD20: input.d20Intention ?? 10,
    defenderD20: input.d20Intention ?? 10,
  });

  // ===== Step 2-pre: collect attacker mods（命中/检定 modifier 在检定前收集）=====
  const attackCtx = {
    attackerId: input.attackerId,
    defenderId: input.defenderId,
    skillId: input.skillId,
    weaponName: input.weaponName,
    damageType: dmgType,
  };
  const attackerMods: Modifier[] = await collectAttackerMods(ctx.bus, attackCtx, ctx.combatants);

  // 提取命中检定 modifier（CheckModifier·命中）
  const hitBonusFromMods = attackerMods
    .filter((m): m is CheckModifier => m.category === '检定' && m.checkType === '命中')
    .reduce((sum, m) => sum + m.bonus, 0);

  // ===== event: combat.dice.roll (代码→脚本，脚本可改骰值 — 幸运/诅咒) =====
  const diceParams = await ctx.bus.emitChain(
    COMBAT_EVENTS.DICE_ROLL,
    { dice: [input.d20Attack], sides: 20, purpose: 'attack', attackerId: input.attackerId },
    chainCtx,
  );
  const diceArr = (diceParams as any)?.dice;
  const d20Final = Array.isArray(diceArr) && diceArr.length > 0 ? diceArr[0] : input.d20Attack;

  // ===== Step 2: 攻击检定（M3: hitBonus 加 collect 的命中 modifier）=====
  const dodgeNegated =
    attacker.tier > defender.tier + 1 ||
    !defender.canAct ||
    (isShakenOrWorse && intention.verdict === '自动成功');
  const attackCheck = performAttackCheck({
    d20Roll: d20Final,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    hitBonus: attacker.hitBonus + hitBonusFromMods,
    defenderDodge: defender.dodgeBonus,
    dodgeNegated,
  });

  // ===== event: combat.attack.hit / .miss =====
  const isHit = attackCheck.rating.coefficient > 0;
  await ctx.bus.emitChain(
    isHit ? COMBAT_EVENTS.ATTACK_HIT : COMBAT_EVENTS.ATTACK_MISS,
    {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      rating: attackCheck.rating,
      checkValue: attackCheck.checkValue,
    },
    chainCtx,
  );

  // ===== Step 3-8: 伤害管线（仅命中时） =====
  let damageBreakdown: CombatDamageBreakdown;
  if (isHit) {
    // collect defender mods（命中后才收集守方 DR/穿透 modifier）
    const defenderMods = await collectDefenderMods(ctx.bus, attackCtx, ctx.combatants);

    // fold mods + 登神压制 → PipelineModifiers（stub 实现，M3 agent 替换）
    const modifiers: PipelineModifiers | undefined = foldModsToPipelineModifiers(attackerMods, defenderMods);

    // 8 步管线（复用 runDamagePipeline，注入 modifiers）
    damageBreakdown = runDamagePipeline({
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
      isClusterTarget: false, // 集群在下面单独处理（D10）
      currentHp: defender.hp,
      modifiers,
    });

    // ===== Step 8: 集群修正（D10，守方集群 ×1.5）=====
    const clusterCount = (defender as any).clusterCount ?? 0;
    if (clusterCount >= 3) {
      damageBreakdown = {
        ...damageBreakdown,
        finalDamage: Math.floor(damageBreakdown.finalDamage * 1.5),
      };
    }
  } else {
    damageBreakdown = zeroDamageBreakdown();
  }

  // ===== HP 红线（D6: clamp≥0 + 强制 isDead）=====
  const finalHp = clampHp(defender.hp - damageBreakdown.finalDamage);
  const isDead = finalHp <= 0;

  // ===== event: combat.attack.damage (代码→AI，救场/状态施加) =====
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ATTACK_DAMAGE,
    {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      damage: damageBreakdown.finalDamage,
      finalHp,
      isDead,
      breakdown: damageBreakdown,
    },
    chainCtx,
  );

  // ===== 战意接线（4.8 stub；HP<阈值且未死时触发）=====
  let moraleOutcome: string | undefined;
  if (!isDead && ctx.combatType) {
    const hpRatio = defender.maxHp > 0 ? finalHp / defender.maxHp : 0;
    // 战意阈值简化（M3 agent 在 runMoraleCheckPipeline 内按 combatType 查表）
    if (hpRatio < 0.5) {
      const moraleResult = await runMoraleCheckPipeline(
        input.defenderId,
        hpRatio,
        ctx.combatType,
        ctx,
      );
      moraleOutcome = moraleResult.outcome;
    }
  }

  // ===== event: combat.attack.result (代码→AI，完整面板数据) =====
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ATTACK_RESULT,
    {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      finalHp,
      isDead,
      moraleOutcome,
      rating: attackCheck.rating,
    },
    chainCtx,
  );

  // ===== StatePatch 生成（HP 扣减 + 技能消耗）=====
  const patches: StatePatch[] = [
    {
      op: 'delta_hp',
      target: `characters.${defender.characterId}`,
      amount: -damageBreakdown.finalDamage,
      metadata: { source: 'combat-pipeline', attackerId: attacker.characterId },
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

  // ===== 面板/描述（复用 legacy combat-panel，简化版）=====
  const description = buildCombatSummary({
    attackerName: attacker.name,
    defenderName: defender.name,
    damage: damageBreakdown.finalDamage,
    ratingName: attackCheck.rating.level,
    isDead,
  });
  const panelLines = [
    `${attacker.name} 攻击 ${defender.name} → ${attackCheck.rating.level}(${attackCheck.rating.coefficient}) ${damageBreakdown.finalDamage} 伤害`,
    `${defender.name} HP ${defender.hp} → ${finalHp}${isDead ? ' [阵亡]' : ''}`,
    moraleOutcome ? `战意: ${moraleOutcome}` : '',
  ].filter(Boolean);

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
    statusApplied: [],
    patches,
    panelLines,
    description,
  };
}

// ========== runRoundPipeline（4.2 round event + buff tick，简化版） ==========

/**
 * 回合管道（简化版）—— 驱动 round.start/end event + buff tick。
 *
 * 单位行动循环由 M4 Combat Agent 驱动（本函数不包含 AI 决策）。
 * 本函数职责:
 *  1. emit combat.round.start → 结算增益 buff（BuffRegistry.tick round.start）
 *  2. （单位行动由调用方/M4 驱动，此处不实现）
 *  3. emit combat.round.end → 结算减益 buff（tick round.end）
 */
export async function runRoundPipeline(
  combat: CombatState,
  ctx: PipelineContext,
  defenderEffectsProvider: (charId: string) => StatusEffect[],
): Promise<{ combat: CombatState; tickExpired: StatusEffect[] }> {
  const chainCtx = { combatants: ctx.combatants, readHooks: ctx.readHooks };
  const expired: StatusEffect[] = [];

  // round.start：emit + 结算增益 buff
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ROUND_START,
    { round: combat.round, combatType: combat.combatType },
    chainCtx,
  );
  for (const p of combat.participants) {
    const effects = defenderEffectsProvider(p.characterId);
    if (effects && effects.length > 0) {
      const ticked = tickBuffs(effects, 'round.start');
      expired.push(...ticked.expired);
    }
  }

  // round.end：emit + 结算减益 buff
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ROUND_END,
    { round: combat.round, combatType: combat.combatType },
    chainCtx,
  );
  for (const p of combat.participants) {
    const effects = defenderEffectsProvider(p.characterId);
    if (effects && effects.length > 0) {
      const ticked = tickBuffs(effects, 'round.end');
      expired.push(...ticked.expired);
    }
  }

  return { combat, tickExpired: expired };
}
