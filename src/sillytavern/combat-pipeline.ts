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

import { parseIntentionFromInput, resolveIntention, checkNonLethal } from './combat-intention';
import { runDamagePipeline, performAttackCheck, resolveRelevantAttribute } from './combat-damage';
import { collectAttackerMods, collectDefenderMods } from './modifier-collector';
import { buildCombatSummary } from './combat-panel';
import { foldModsToPipelineModifiers } from './combat-modifier-inject';
import { runMoraleCheckPipeline } from './combat-morale-pipeline';
import { tickBuffs, collectBuffCombatMods } from './buff-registry';
import { HIT_RATINGS, INTENTION_CONFIGS } from './types';
import { isCheckTriggerType } from './morale-system';

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
  const dmgType: DamageType = input.damageType ?? '物理';
  // 🐛修复: 关联属性不再恒为 str —— 可由 AI 显式指定，缺省按伤害类型推导
  // （物理→str / 能量→int / 精神→spi / 真实→str），法系攻击不再错用力量算初伤。
  const relAttrName = resolveRelevantAttribute(input.relevantAttribute, dmgType);
  const relAttrValue =
    input.relevantAttributeValue ?? attacker.attributes[relAttrName] ?? attacker.attributes.str;
  const multiHit = input.multiHitCount ?? 1;
  const chainCtx = {
    combatants: ctx.combatants,
    source: input.attackerId,
    readHooks: ctx.readHooks,
  };
  const randD20 = (): number => Math.floor(Math.random() * 20) + 1;

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
  // 🐛修复: "打晕/活捉"等关键词解析为非致死意图时同步置 nonLethal 标记（此前无联动，照样打死）
  const nonLethal = (input.nonLethal ?? false) || intentionLevel === '非致死';
  const defenderMorale = getMorale(defender);
  const isShakenOrWorse =
    defenderMorale === 'shaken' || defenderMorale === 'wavering' || defenderMorale === 'routing';

  // 🐛修复: 意图对抗攻/守双骰各自独立。旧实现攻守共用 input.d20Intention（两侧 d20 抵消 →
  // 同层级下战术~概念必败）。对抗验证后进一步修正:
  //  - 攻方骰缺省不再是常量 10（AI 漏传时 核心/抹杀/概念 在缺省路径依然恒败），双方缺省都掷真实 d20；
  //  - 仅在"确认会进入对抗分支"时才掷骰/发 dice.roll 事件 —— 层级压制/失能/处决自动成功等
  //    短路分支不消费对抗骰，提前掷会产生幽灵掷骰事件（幸运类脚本会对被丢弃的骰子生效）。
  const config = INTENTION_CONFIGS[intentionLevel];
  const tierSuppressed = attacker.tier < defender.tier - 1;
  const executionAutoSuccess =
    (intentionLevel === '抹杀' || intentionLevel === '概念') && isShakenOrWorse;
  const willContest =
    config?.requiresContest === true && !tierSuppressed && defender.canAct && !executionAutoSuccess;

  let intentionAtkD20 = input.d20Intention;
  let intentionDefD20 = input.d20IntentionDefender;
  if (willContest && (intentionAtkD20 === undefined || intentionDefD20 === undefined)) {
    const initIntentionDice = [intentionAtkD20 ?? randD20(), intentionDefD20 ?? randD20()];
    const intentionDiceParams = await ctx.bus.emitChain(
      COMBAT_EVENTS.DICE_ROLL,
      {
        dice: initIntentionDice,
        sides: 20,
        purpose: 'intention',
        attackerId: input.attackerId,
        defenderId: input.defenderId,
      },
      chainCtx,
    );
    const arr = (intentionDiceParams as any)?.dice;
    intentionAtkD20 =
      intentionAtkD20 ??
      (Array.isArray(arr) && typeof arr[0] === 'number' ? arr[0] : initIntentionDice[0]);
    intentionDefD20 =
      intentionDefD20 ??
      (Array.isArray(arr) && typeof arr[1] === 'number' ? arr[1] : initIntentionDice[1]);
  }

  const intention = resolveIntention({
    intentionLevel,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    defenderIncapacitated: !defender.canAct,
    defenderMorale: defenderMorale as any,
    isExecutionIntent: intentionLevel === '抹杀' || intentionLevel === '概念',
    nonLethal,
    attackerD20: intentionAtkD20 ?? 10,
    defenderD20: intentionDefD20 ?? 10,
  });

  // ===== Step 2-pre: collect attacker + defender mods（检定前收集双方）=====
  // 🐛修复: 守方 mods 提前到攻击检定之前收集。旧实现命中后才收集守方，
  // 守方「检定·闪避」modifier 永远赶不上检定（fold 出的 dodgeBonus 是死代码）。
  const attackCtx = {
    attackerId: input.attackerId,
    defenderId: input.defenderId,
    skillId: input.skillId,
    weaponName: input.weaponName,
    damageType: dmgType,
  };
  const attackerMods: Modifier[] = await collectAttackerMods(ctx.bus, attackCtx, ctx.combatants);
  const defenderMods: Modifier[] = await collectDefenderMods(ctx.bus, attackCtx, ctx.combatants);

  // 提取命中/闪避检定 modifier
  const hitBonusFromMods = attackerMods
    .filter((m): m is CheckModifier => m.category === '检定' && m.checkType === '命中')
    .reduce((sum, m) => sum + m.bonus, 0);
  const dodgeBonusFromMods = defenderMods
    .filter((m): m is CheckModifier => m.category === '检定' && m.checkType === '闪避')
    .reduce((sum, m) => sum + m.bonus, 0);

  // 🐛修复: 折叠双方激活 buff 的 effects 数值（防御姿态/专注/status_apply 施加的 buff
  // 此前无任何消费方，格挡/专注对数值零影响）。
  const attackerBuff = collectBuffCombatMods(attacker.statusEffects ?? []);
  const defenderBuff = collectBuffCombatMods(defender.statusEffects ?? []);

  // ===== event: combat.dice.roll (代码→脚本，脚本可改骰值 — 幸运/诅咒) =====
  // 🐛修复: 层级不同(优/劣势)时第二颗 d20 一并走事件链 —— 旧实现第二骰是 r1±3 的伪骰。
  const needsSecondDie = attacker.tier !== defender.tier;
  const initialDice = needsSecondDie
    ? [input.d20Attack, input.d20Attack2 ?? randD20()]
    : [input.d20Attack];
  const diceParams = await ctx.bus.emitChain(
    COMBAT_EVENTS.DICE_ROLL,
    { dice: initialDice, sides: 20, purpose: 'attack', attackerId: input.attackerId },
    chainCtx,
  );
  const diceArr = (diceParams as any)?.dice;
  const d20Final = Array.isArray(diceArr) && diceArr.length > 0 ? diceArr[0] : input.d20Attack;
  const d20Second: number | undefined = needsSecondDie
    ? Array.isArray(diceArr) && typeof diceArr[1] === 'number'
      ? diceArr[1]
      : initialDice[1]
    : undefined;

  // ===== Step 2: 攻击检定（M3: hitBonus/dodge 加 collect 的检定 modifier + buff 数值）=====
  const dodgeNegated =
    attacker.tier > defender.tier + 1 ||
    !defender.canAct ||
    (isShakenOrWorse && intention.verdict === '自动成功');
  const attackCheck = performAttackCheck({
    d20Roll: d20Final,
    d20Roll2: d20Second,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    hitBonus: attacker.hitBonus + hitBonusFromMods + attackerBuff.hitBonus,
    defenderDodge: defender.dodgeBonus + dodgeBonusFromMods + defenderBuff.dodgeBonus,
    dodgeNegated,
  });

  // 🐛修复: 处决意图承诺"评级保底为暴击(1.3)"，此前只是 extraEffects 字符串从未生效
  let effectiveRating = attackCheck.rating;
  if (intention.level === '处决' && effectiveRating.coefficient < 1.3) {
    const critRating = HIT_RATINGS.find((r) => r.level === '暴击');
    if (critRating) effectiveRating = critRating;
  }

  // ===== event: combat.attack.hit / .miss =====
  const isHit = effectiveRating.coefficient > 0;
  await ctx.bus.emitChain(
    isHit ? COMBAT_EVENTS.ATTACK_HIT : COMBAT_EVENTS.ATTACK_MISS,
    {
      attackerId: input.attackerId,
      defenderId: input.defenderId,
      rating: effectiveRating,
      checkValue: attackCheck.checkValue,
    },
    chainCtx,
  );

  // ===== Step 3-8: 伤害管线（仅命中时） =====
  let damageBreakdown: CombatDamageBreakdown;
  if (isHit) {
    // fold mods + 登神压制 → PipelineModifiers（双方 mods 已在检定前收集）
    const folded = foldModsToPipelineModifiers(attackerMods, defenderMods);
    // buff effects 数值并入 modifier（与脚本声明的 modifier 同权叠加）
    const modifiers: PipelineModifiers = {
      ...folded,
      fixedDamageBonus: (folded.fixedDamageBonus ?? 0) + attackerBuff.fixedDamageBonus,
      damageMultiplier: (folded.damageMultiplier ?? 0) + attackerBuff.damageMultiplier,
      penetrationRateBonus: (folded.penetrationRateBonus ?? 0) + attackerBuff.penetrationBonus,
      drRateBonus: (folded.drRateBonus ?? 0) + defenderBuff.drBonus,
    };

    // 防御姿态等 buff 的 defense 百分比直接作用于守方防御值
    const effectiveDefense = Math.max(
      0,
      Math.floor(defender.defense * (1 + defenderBuff.defenseMultiplier)),
    );

    // 8 步管线（复用 runDamagePipeline，注入 modifiers）
    damageBreakdown = runDamagePipeline({
      relevantAttribute: relAttrValue,
      attackerTier: attacker.tier,
      skillPower,
      weaponAtk,
      multiHitCount: multiHit,
      defenderDefense: effectiveDefense,
      penetrationRate: attacker.penetration,
      damageType: dmgType,
      defenderAttributes: defender.attributes,
      ratingCoefficient: effectiveRating.coefficient,
      intentionCoefficient: intention.coefficient,
      drRate: defender.dr,
      isClusterTarget: false, // 集群在下面单独处理（D10）
      currentHp: defender.hp,
      modifiers,
    });

    // ===== Step 8: 集群修正（D10，守方集群 ×1.5）=====
    const clusterCount = defender.clusterCount ?? 0;
    if (clusterCount >= 3) {
      damageBreakdown = {
        ...damageBreakdown,
        finalDamage: Math.floor(damageBreakdown.finalDamage * 1.5),
      };
    }
  } else {
    damageBreakdown = zeroDamageBreakdown();
  }

  // ===== 非致死 + HP 红线（D6: clamp≥0 + 强制 isDead）=====
  // 🐛修复: 管线版此前完全没有非致死逻辑（nonLethal 收了不用，"打晕"直接打死）。
  const nonLethalResult = checkNonLethal({
    nonLethal,
    ratingCoefficient: effectiveRating.coefficient,
    finalDamage: damageBreakdown.finalDamage,
    currentHp: defender.hp,
  });
  const finalHp = clampHp(nonLethalResult.adjustedHp);
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

  // ===== 战意接线（4.8；HP<阈值且未死时触发）=====
  let moraleOutcome: string | undefined;
  if (!isDead && ctx.combatType) {
    const hpRatio = defender.maxHp > 0 ? finalHp / defender.maxHp : 0;
    // 预过滤: 所有战斗类型阈值 ≤ 0.5（morale-system 内部再按 combatType 精确查表）。
    // 🐛修复(对抗验证): 边界用 <=（压制阈值恰为 0.50，checkMorale 判定 hpRatio > threshold 才不触发）
    if (hpRatio <= 0.5) {
      // 🐛修复: 低阈值类型(死斗/标准/守卫)的战意 d20 此前从未传入 —— checkMorale 恒用
      // 默认 10 (<12)，低于阈值时 100% 战意崩溃。改为掷真实 d20 并走 dice.roll 事件链。
      // 🐛修复(对抗验证): 只有 check 触发型才需要 d20，自动触发型不再发多余的掷骰事件。
      let moraleD20: number | undefined;
      if (isCheckTriggerType(ctx.combatType)) {
        const moraleDiceParams = await ctx.bus.emitChain(
          COMBAT_EVENTS.DICE_ROLL,
          { dice: [randD20()], sides: 20, purpose: 'morale', defenderId: input.defenderId },
          chainCtx,
        );
        const moraleDiceArr = (moraleDiceParams as any)?.dice;
        moraleD20 =
          Array.isArray(moraleDiceArr) && typeof moraleDiceArr[0] === 'number'
            ? moraleDiceArr[0]
            : randD20();
      }
      const moraleResult = await runMoraleCheckPipeline(
        input.defenderId,
        hpRatio,
        ctx.combatType,
        ctx,
        moraleD20,
      );
      moraleOutcome = moraleResult.outcome;
      // 🐛修复(对抗验证): 战意状态落地到 participant —— 此前 moraleState 全链路被丢弃，
      // getMorale() 恒返回 'steady'，处决自动成功/闪避无效分支在真实战斗中永远不可达。
      if (moraleResult.moraleState) {
        defender.morale = moraleResult.moraleState;
      }
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
      rating: effectiveRating,
    },
    chainCtx,
  );

  // ===== StatePatch 生成（HP 扣减 + 技能消耗）=====
  // 🐛修复: patch 与 finalHp 保持一致（非致死锁血时不再按全额伤害扣 HP）
  const patches: StatePatch[] = [
    {
      op: 'delta_hp',
      target: `characters.${defender.characterId}`,
      // 对抗验证补充: min(0,·) 防御性下限，战斗 delta_hp 永不为正（防任何路径反向加血）
      amount: Math.min(0, finalHp - defender.hp),
      metadata: { source: 'combat-pipeline', attackerId: attacker.characterId },
    },
  ];
  const statusApplied: CombatActionResult['statusApplied'] = [];
  if (nonLethalResult.unconscious) {
    statusApplied.push({ name: '昏迷', duration: 2, effect: '失去行动能力，闪避无效' });
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

  // ===== 面板/描述（复用 legacy combat-panel，简化版）=====
  const description = buildCombatSummary({
    attackerName: attacker.name,
    defenderName: defender.name,
    damage: damageBreakdown.finalDamage,
    ratingName: effectiveRating.level,
    isDead,
  });
  const panelLines = [
    `${attacker.name} 攻击 ${defender.name} → ${effectiveRating.level}(${effectiveRating.coefficient}) ${damageBreakdown.finalDamage} 伤害`,
    `${defender.name} HP ${defender.hp} → ${finalHp}${isDead ? ' [阵亡]' : ''}`,
    nonLethalResult.applied && nonLethalResult.narrative
      ? `非致死: ${nonLethalResult.narrative}`
      : '',
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

// ========== runRoundPipeline（4.2 round event + buff tick，简化版） ==========

/**
 * 回合管道（简化版）—— 驱动 round.start/end event + buff tick。
 *
 * 单位行动循环由 M4 Combat Agent 驱动（本函数不包含 AI 决策）。
 * 本函数职责:
 *  1. emit combat.round.start → 结算增益 buff（BuffRegistry.tick round.start）
 *  2. （单位行动由调用方/M4 驱动，此处不实现）
 *  3. emit combat.round.end → 结算减益 buff（tick round.end）
 *
 * 🐛修复: 旧实现只收集 expired、丢弃 tickBuffs 的 remaining（递减后的新数组），
 * buff 持续时间永远不会写回 → 永不过期。现在:
 *  - 若提供 effectsWriter，把每个角色 tick 后的剩余列表写回；
 *  - 同时在返回值 updatedEffects 中给出各角色最终列表，调用方可自行落库。
 */
export async function runRoundPipeline(
  combat: CombatState,
  ctx: PipelineContext,
  defenderEffectsProvider: (charId: string) => StatusEffect[],
  effectsWriter?: (charId: string, effects: StatusEffect[]) => void,
): Promise<{
  combat: CombatState;
  tickExpired: StatusEffect[];
  updatedEffects: Map<string, StatusEffect[]>;
}> {
  const chainCtx = { combatants: ctx.combatants, readHooks: ctx.readHooks };
  const expired: StatusEffect[] = [];
  const updatedEffects = new Map<string, StatusEffect[]>();

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
      updatedEffects.set(p.characterId, ticked.remaining);
      effectsWriter?.(p.characterId, ticked.remaining);
    }
  }

  // round.end：emit + 结算减益 buff
  await ctx.bus.emitChain(
    COMBAT_EVENTS.ROUND_END,
    { round: combat.round, combatType: combat.combatType },
    chainCtx,
  );
  for (const p of combat.participants) {
    // 🐛修复: round.end 必须基于 round.start tick 后的列表继续递减，而不是原始列表
    const base = updatedEffects.get(p.characterId) ?? defenderEffectsProvider(p.characterId);
    if (base && base.length > 0) {
      const ticked = tickBuffs(base, 'round.end');
      expired.push(...ticked.expired);
      updatedEffects.set(p.characterId, ticked.remaining);
      effectsWriter?.(p.characterId, ticked.remaining);
    }
  }

  return { combat, tickExpired: expired, updatedEffects };
}
