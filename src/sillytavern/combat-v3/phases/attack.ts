/**
 * combat-v3/phases/attack.ts — 攻击结算微步骤链（M1）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十四 14.4 / plan §3.4
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §3.4 / §3.5
 *
 * 微步骤链（plan §3.4）：
 *   ① check.intent 窗口（M1 空转）→ 取 intentCheck 通道 2 颗骰 → resolveIntention（C5 ✅）
 *   ② collect_attacker_mods 窗口（M1 空转）
 *   ③ check.hit 窗口（M1 空转）→ 取 attackHit 通道 1~2 颗骰 → performAttackCheck（M-5 ✅）
 *   ④ collect_defender_mods 窗口（M1 空转）
 *   ⑤ damage.compute → runDamagePipeline → clamp ≥ 0（C7 ✅）
 *   ⑥ damage.preview 窗口（M1 空转；M3 接 RequestChoice）
 *   ⑦ checkNonLethal（C6 ✅）—— 在 ⑧ 之前
 *   ⑧ unit.beforeDown 窗口（M1 空转；M4 接 death.threshold）
 *   ⑨ damage.after 窗口（M1 空转；M3 接反伤）
 *   ⑩ 追加 pendingChanges + DomainEvents（攻守双方资源同批提交，M-9 ✅）
 *
 * 验收断言：
 *   A1-8  意图对抗消费 intentCheck 通道两颗独立骰（C5）→ 触发 resolveIntention
 *   A1-9  非致死攻击：checkNonLethal 在伤害后、beforeDown 前调用，HP 锁 1 + 施加[昏迷]（C6）
 *   A1-10 最终伤害 ≥ 0（C7）；负 modifier 不产生治疗
 *   A1-2  命中丢骰 / 意图丢骰 通道耗尽 → BeginOutput（不吞骰）
 */

import { draw } from '../dice-tape';
import { performAttackCheck, runDamagePipeline } from '../../combat-damage';
import { resolveIntention, checkNonLethal } from '../../combat-intention';
import { getCombatCoefficient } from '../../tier-constants';
import { evaluateWindow, hasSubscribers, makeWindowRuntimeCtx } from '../windows';
import type {
  CombatCommand,
  CombatDefinitionBundle,
  CombatState,
  DomainEvent,
  DamageRecomputeCtx,
} from '../types';
import { emptyChanges, type PhaseOutcome } from './outcome';

/**
 * 执行一次攻击结算（DeclareAttack → 微步骤链 → PhaseOutcome）。
 * 消费的骰子都从 state.dice 各通道取；通道耗尽返回 requiredInput BeginOutput。
 */
export function handleAttack(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  command: Extract<CombatCommand, { kind: 'DeclareAttack' }>,
): PhaseOutcome {
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume', // 攻击完成后回到槽位消费（同单位可能还有动作槽）
  };

  const attacker = state.units[command.actorId];
  const defender = state.units[command.payload.targetId];
  if (!attacker || !defender) {
    out.rejection = {
      code: 'TARGET_NOT_PRESENT',
      message: !attacker ? '攻击者不在场' : '目标不在场',
    };
    return out;
  }

  const ability = command.payload.ability ??
    attacker.ability ?? {
      relevantAttribute: attacker.attributes.str,
      skillPower: 0,
      damageType: (command.payload.damageType ?? '物理') as never,
      intentionLevel: command.payload.intentionLevel,
      multiHitCount: 1,
      divinity: 0,
    };

  // ── ① check.intent：取 intentCheck 通道 2 颗骰 → resolveIntention（C5） ──
  evaluateWindow(
    state.activeEffects,
    'check.intent',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'check.intent',
    }),
  );

  const intentDraw = draw(state.dice, 'intentCheck', 2);
  if ('exhausted' in intentDraw) {
    out.requiredInput = { kind: 'BeginOutput', channel: 'intentCheck' };
    return out;
  }
  const [attackerIntentRoll, defenderIntentRoll] = intentDraw.rolls;

  const intention = resolveIntention({
    intentionLevel: command.payload.intentionLevel,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    defenderIncapacitated: defender.hp <= 0 || !defender.canAct,
    defenderMorale: defender.morale,
    isExecutionIntent: command.payload.intentionLevel === '处决',
    nonLethal: !!command.payload.nonLethal,
    attackerD20: attackerIntentRoll,
    defenderD20: defenderIntentRoll,
  });

  // ── ② collect_attacker_mods 窗口（M1 空转；M3 接 modifier push-handler） ──
  evaluateWindow(
    state.activeEffects,
    'collect_attacker_mods',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'collect_attacker_mods',
    }),
  );

  // ── ③ check.hit：取 attackHit 通道 1~2 颗骰 → performAttackCheck（M-5） ──
  evaluateWindow(
    state.activeEffects,
    'check.hit',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'check.hit',
    }),
  );

  // 同层级 1 颗；优/劣势 2 颗
  const hitDiceCount = attacker.tier === defender.tier ? 1 : 2;
  const hitDraw = draw(intentDraw.tape, 'attackHit', hitDiceCount);
  if ('exhausted' in hitDraw) {
    out.requiredInput = { kind: 'BeginOutput', channel: 'attackHit' };
    return out;
  }
  out.dice = hitDraw.tape;
  const rolls: [number, number?] =
    hitDiceCount === 1 ? [hitDraw.rolls[0]] : [hitDraw.rolls[0], hitDraw.rolls[1]];

  const attackCheck = performAttackCheck({
    rolls,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    hitBonus: attacker.hitBonus,
    defenderDodge: defender.dodgeBonus,
    dodgeNegated: !defender.canAct,
  });

  out.events.push({
    kind: 'AttackDeclared',
    attackerId: attacker.id,
    targetId: defender.id,
    skill: command.payload.skill,
    intentionLevel: command.payload.intentionLevel,
  });
  out.events.push({
    kind: 'AttackResolved',
    attackerId: attacker.id,
    targetId: defender.id,
    checkValue: attackCheck.checkValue,
    rating: attackCheck.rating.level,
    hit: attackCheck.rating.coefficient > 0,
    dice: hitDraw.rolls,
  });

  // ④ collect_defender_mods 窗口（M1 空转）
  evaluateWindow(
    state.activeEffects,
    'collect_defender_mods',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'collect_defender_mods',
    }),
  );

  // ── ⑤ damage.compute：8 步管线 + clamp ≥ 0（C7） ──
  evaluateWindow(
    state.activeEffects,
    'damage.compute',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'damage.compute',
    }),
  );

  const coeff = getCombatCoefficient(attacker.tier);
  const initialDamage =
    ability.relevantAttribute * 10 * coeff + ability.skillPower + attacker.weaponAtk;
  const intentionCoefficient = intention.coefficient;

  const damage = runDamagePipeline({
    relevantAttribute: ability.relevantAttribute,
    attackerTier: attacker.tier,
    skillPower: ability.skillPower,
    weaponAtk: attacker.weaponAtk,
    multiHitCount: ability.multiHitCount || 1,
    defenderDefense: defender.defense,
    penetrationRate: attacker.penetration,
    damageType: ability.damageType,
    defenderAttributes: defender.attributes,
    ratingCoefficient: attackCheck.rating.coefficient,
    intentionCoefficient,
    drRate: defender.dr,
    isClusterTarget: false,
    currentHp: defender.hp,
    fixedDamageBonus: 0,
    modifiers: {
      hitBonus: 0,
      dodgeBonus: 0,
    },
  });

  // C7: 最终伤害 clamp ≥ 0（负 modifier 不产生治疗）
  const finalDamage = Math.max(0, Math.floor(damage.finalDamage));

  // ── ⑥ damage.preview 窗口（M3 接 RequestChoice 补暂停 / 格挡重算） ──
  const preReduction = initialDamage;
  const postStep6 = damage.afterRating;

  // A3-6：无订阅者 → 直接跳过窗口，不暂停（架构 §五 5.2 约束 3）
  if (hasSubscribers(state.activeEffects, 'damage.preview')) {
    const evalResult = evaluateWindow(
      state.activeEffects,
      'damage.preview',
      makeWindowRuntimeCtx(state, {
        selfId: attacker.id,
        targetId: defender.id,
        round: state.round,
        window: 'damage.preview',
      }),
    );

    // 收集 preview 窗口里的 RequestChoiceIntent（格挡/招架反应），
    // 触发 RequiredInput.EffectChoice（dispatch 暂停，A3-5）
    const choice = derefPreview(evalResult.intents);
    // 错误隔离：preview 里单个 automaton 抛错不打断核心攻击（rejections 记录）
    out.events.push(...evalResult.rejections);

    if (choice) {
      // ★ 冻结 ResolutionFrame（damage.preview）+ 返回 EffectChoice
      const recompute: DamageRecomputeCtx = {
        attackerId: attacker.id,
        targetId: defender.id,
        relevantAttribute: ability.relevantAttribute,
        skillPower: ability.skillPower,
        weaponAtk: attacker.weaponAtk,
        multiHitCount: ability.multiHitCount || 1,
        intentionCoefficient,
        ratingCoefficient: attackCheck.rating.coefficient,
        damageTakenFactor: choice.blockDamageFactor ?? 1,
        fixedDamageAdjust: 0,
      };
      out.requiredInput = {
        kind: 'EffectChoice',
        choiceId: choice.choiceId,
        unitId: defender.id,
        damagePreview: finalDamage,
        options: choice.options,
        cost: choice.cost,
        blockDamageFactor: choice.blockDamageFactor,
        damageTakenOverrideId: choice.damageTakenOverrideId,
      };
      out.suspended = { recompute, finalDamage };
      out.nextPhase = 'SlotConsume';
      // 不继续 ⑦⑧⑨⑩——reducer 冻结 frame 后等 DeclareBlock
      return out;
    }
  }

  // 无 RequestChoice → 沿用当前 finalDamage 走完整结算
  finalizeAttack(out, bundle, state, attacker, defender, ability, command, {
    finalDamage,
    preReduction,
    postStep6,
    attackCheckRatingCoef: attackCheck.rating.coefficient,
  });
  return out;
}

/**
 * 从 preview 收集的 intent 中提取第一条 RequestChoiceIntent（若无则 null）。
 */
function derefPreview(
  batches: readonly {
    automatonId: string;
    owner: string;
    intents: readonly { kind: string }[];
  }[],
): {
  choiceId: string;
  options: readonly string[];
  cost?: { sp?: number; slot?: 'action' };
  blockDamageFactor?: number;
  damageTakenOverrideId?: string;
} | null {
  for (const b of batches) {
    for (const intent of b.intents) {
      if (intent.kind === 'RequestChoiceIntent') {
        const rc = intent as unknown as {
          choiceId: string;
          options?: readonly string[];
          cost?: { sp?: number; slot?: 'action' };
          blockDamageFactor?: number;
          damageTakenOverrideId?: string;
        };
        return {
          choiceId: rc.choiceId,
          options: rc.options ?? ['是', '否'],
          cost: rc.cost,
          blockDamageFactor: rc.blockDamageFactor,
          damageTakenOverrideId: rc.damageTakenOverrideId,
        };
      }
    }
  }
  return null;
}

/**
 * 结算伤害后的全部微步骤（⑦ checkNonLethal → ⑧ beforeDown → ⑨ damage.after → ⑩ 提交）。
 * M3 同时被 正常路径 与 格挡重算路径 复用（恢复后从 frame 提供 recompute 结果）。
 */
function finalizeAttack(
  out: PhaseOutcome,
  bundle: CombatDefinitionBundle,
  state: CombatState,
  attacker: CombatState['units'][string],
  defender: CombatState['units'][string],
  ability: Record<string, unknown> & {
    relevantAttribute: number;
    skillPower: number;
    weaponAtk?: number;
    multiHitCount?: number;
    damageType: string;
    intentionLevel: string;
    divinity: number;
  },
  /** finalizeAttack 所需的最小 Command 视图（costs / nonLethal） */
  command: { payload: { costs?: { mp?: number; sp?: number }; nonLethal?: boolean } },
  params: {
    finalDamage: number;
    preReduction: number;
    postStep6: number;
    attackCheckRatingCoef: number;
  },
): void {
  const { finalDamage, preReduction, postStep6, attackCheckRatingCoef } = params;

  // ── ⑦ checkNonLethal（C6）——在 ⑧ beforeDown 之前 ──
  const nonLethal = checkNonLethal({
    nonLethal: !!command.payload.nonLethal,
    ratingCoefficient: attackCheckRatingCoef,
    finalDamage,
    currentHp: defender.hp,
  });

  const hpDelta = nonLethal.applied
    ? nonLethal.adjustedHp - defender.hp
    : -Math.min(finalDamage, defender.hp);

  if (nonLethal.unconscious) {
    out.changes.statusPatches.push({
      op: 'apply',
      unitId: defender.id,
      status: {
        name: '昏迷',
        description: '非致死攻击致昏迷',
        category: '减益',
        stacks: 1,
        remainingTime: 1,
        timeUnit: '回合',
        source: `[减益]-[${attacker.id}];[苏醒]`,
        effects: {},
        lifecycle: '战斗',
      },
    });
  }

  // ── ⑧ unit.beforeDown 窗口（M4 接 death.threshold，M1 空转） ──
  evaluateWindow(
    state.activeEffects,
    'unit.beforeDown',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'unit.beforeDown',
    }),
  );

  // ⑨ damage.after 窗口（M3 接反伤）
  evaluateWindow(
    state.activeEffects,
    'damage.after',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'damage.after',
    }),
  );

  // ── ⑩ 追加 pendingChanges + DomainEvents（攻守双方同批，M-9） ──
  const mpCost = command.payload.costs?.mp ?? 0;
  const spCost = command.payload.costs?.sp ?? 0;
  if (mpCost > 0) {
    out.changes.mpChanges[attacker.id] = (out.changes.mpChanges[attacker.id] ?? 0) - mpCost;
    out.events.push({ kind: 'ResourceSpent', unitId: attacker.id, resource: 'mp', amount: mpCost });
  }
  if (spCost > 0) {
    out.changes.spChanges[attacker.id] = (out.changes.spChanges[attacker.id] ?? 0) - spCost;
    out.events.push({ kind: 'ResourceSpent', unitId: attacker.id, resource: 'sp', amount: spCost });
  }

  if (hpDelta !== 0) {
    out.changes.hpChanges[defender.id] = (out.changes.hpChanges[defender.id] ?? 0) + hpDelta;
  }

  const targetHpBefore = defender.hp;
  const targetHpAfter = Math.max(0, Math.min(defender.maxHp, defender.hp + hpDelta));

  out.events.push({
    kind: 'DamageApplied',
    attackerId: attacker.id,
    targetId: defender.id,
    preReduction,
    postStep6,
    final: finalDamage,
    damageType: ability.damageType as never,
    targetHpBefore,
    targetHpAfter,
  });

  if (targetHpAfter <= 0) {
    out.events.push({ kind: 'UnitDowned', unitId: defender.id, hp: targetHpAfter });
  }
}

/**
 * 从 damage.preview 冻结的 frame 恢复：格挡 → 回到 damage.compute **重算**（§5.4 约束 4）。
 *
 * 不在 final 上打折，而是重新计算管线结果（preReduction × blockDamageFactor 后 clamp ≥ 0），
 * 再走 ⑦⑧⑨⑩（不重取骰、不重跑 ①-③）。用于 reducer 的 DeclareBlock frame 恢复分支。
 */
export function resumeBlockedAttack(
  bundle: CombatDefinitionBundle,
  state: CombatState,
  recompute: DamageRecomputeCtx,
): PhaseOutcome {
  const attacker = state.units[recompute.attackerId];
  const defender = state.units[recompute.targetId];
  const out: PhaseOutcome = {
    changes: emptyChanges(),
    events: [],
    nextPhase: 'SlotConsume',
  };
  if (!attacker || !defender) {
    out.rejection = { code: 'TARGET_NOT_PRESENT', message: '格挡重算单位不在场' };
    return out;
  }

  // ★ 回到 damage.compute 重算（架构 §五 5.2 约束 4）：blockDamageFactor 折后 clamp ≥ 0
  const coeff = getCombatCoefficient(attacker.tier);
  const initialDamage =
    recompute.relevantAttribute * 10 * coeff + recompute.skillPower + attacker.weaponAtk;
  const damage = runDamagePipeline({
    relevantAttribute: recompute.relevantAttribute,
    attackerTier: attacker.tier,
    skillPower: recompute.skillPower,
    weaponAtk: attacker.weaponAtk,
    multiHitCount: recompute.multiHitCount || 1,
    defenderDefense: defender.defense,
    penetrationRate: attacker.penetration,
    damageType: attacker.ability?.damageType ?? '物理',
    defenderAttributes: defender.attributes,
    ratingCoefficient: recompute.ratingCoefficient,
    intentionCoefficient: recompute.intentionCoefficient,
    drRate: defender.dr,
    isClusterTarget: false,
    currentHp: defender.hp,
    fixedDamageBonus: recompute.fixedDamageAdjust,
    modifiers: { hitBonus: 0, dodgeBonus: 0 },
  });
  // 折减因子（格挡 damageTaken -0.8 → ×0.2）∈ 管线重算，非 final 打折
  const recomputed = Math.max(
    0,
    Math.floor(damage.finalDamage * (recompute.damageTakenFactor ?? 1)),
  );

  finalizeAttack(
    out,
    bundle,
    state,
    attacker,
    defender,
    attacker.ability ?? {
      relevantAttribute: recompute.relevantAttribute,
      skillPower: recompute.skillPower,
      damageType: '物理',
      intentionLevel: '常规',
      multiHitCount: recompute.multiHitCount || 1,
      divinity: 0,
    },
    {
      // 无 costs —— 格挡的 SP/动作槽由 reducer 单独并入（DeclareBlock cost:action）
      payload: {},
    },
    {
      finalDamage: recomputed,
      preReduction: initialDamage,
      postStep6: damage.afterRating,
      attackCheckRatingCoef: recompute.ratingCoefficient,
    },
  );

  return out;
}

/**
 * 校验 DeclareAttack 命令的目标是否在场。
 * reducer 在路由攻击前用它做 TARGET_NOT_PRESENT 拒绝（验收 A1-2）。
 */
export function isAttackTargetLegal(state: CombatState, targetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.units, targetId);
}
