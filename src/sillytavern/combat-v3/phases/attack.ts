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
import { resolveIntention, checkNonLethal, getIntentionConfig } from '../../combat-intention';
import type { IntentionResult } from '../../types';
import { getCombatCoefficient } from '../../tier-constants';
import {
  evaluateWindow,
  hasSubscribers,
  makeWindowRuntimeCtx,
  resolveNumberExpr,
  type RawIntent,
} from '../windows';
import { applyIntents } from '../intents';
import { resolveReflection, REFLECTION_ANNIHILATION_CUE } from '../automata/reflection';
import { divinitySuppression } from '../rule-keys';
import { MAX_REFLECTION_DEPTH } from '../types';
import type {
  CombatCommand,
  CombatDefinitionBundle,
  CombatState,
  DomainEvent,
  DamageRecomputeCtx,
  EffectIntent,
  IntentionLevel,
  WindowCtx,
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

  // A4-4（架构 §八 8.3）：divinity 压制泛化到意图对抗。
  //   - 差 ≥5（攻方高）→ 必成 / 差 ≥5（守方高）→ 必败，**不消费 intentCheck 骰**（跳过 draw，cursor 不进）
  //   - 差 1~4 → 正常掷 2 骰，压制幅度作为攻方检定额外加值（suppress 系数并入 resolve 前的 value）
  const atkDiv = attacker.ability?.divinity ?? 0;
  const defDiv = defender.ability?.divinity ?? 0;
  const suppression = divinitySuppression(atkDiv, defDiv);

  const intention = suppression.certain
    ? forcedIntention(command.payload.intentionLevel, suppression.direction, atkDiv, defDiv)
    : rollIntention(
        command.payload.intentionLevel,
        attacker,
        defender,
        state,
        suppression.magnitude,
        out,
      );
  // 若掷骰路径曾需要续杯（BeginOutput），requiredInput 已由 rollIntention 设置，直接返回
  if (out.requiredInput) {
    return out;
  }

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
  // intent 路径若掷了骰，其 tape 已写入 out.dice；otherwise 用 state.dice（origin 未动）
  const hitDraw = draw(out.dice ?? state.dice, 'attackHit', hitDiceCount);
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
        damage: { preReduction, postStep6, final: finalDamage },
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

  // ── ⑧ unit.beforeDown 窗口（M4 接 death.threshold，架构 §八 8.2 death.threshold） ──
  // PreventDeath 扫描在 ⑩ 一次求值（需先算 targetHpAfter）；此处不重复触发窗口。

  // ── ⑨ damage.after 窗口（M4：反射反摔接线，架构 §九 R1-R8） ──
  // 把反伤 ScheduleIntent 排进**同一原子提交**（不变量④）：反射 automaton 挂守方身上，
  // 在 damage.after 产出 ScheduleIntent(DealDamage isReaction)，写 out.changes.hpChanges
  // （doesNotConsumeSlot 不碰槽位）。R8 反伤命中骰从 attackHit 通道消费。
  const afterEval = evaluateWindow(
    state.activeEffects,
    'damage.after',
    makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'damage.after',
      damage: { preReduction, postStep6, final: finalDamage },
    }),
  );
  out.events.push(...afterEval.rejections);
  if (afterEval.intents.length > 0) {
    applyAfterWindow(out, state, attacker, defender, afterEval.intents, {
      preReduction,
      final: finalDamage,
    });
  }

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
  let targetHpAfter = Math.max(0, Math.min(defender.maxHp, defender.hp + hpDelta));

  // A4-3：death.threshold —— 目标本将被击倒时，unit.beforeDown 窗口的 PreventDeath
  // （divinity ≥ 法则级 5）把伤害截断到 PreventDeath.hp，保留存活并产 DamagePrevented。
  // 与_ConsumeCharge_语义：由 automaton 的 charges 在窗口层消耗，此处只保证「一次原子提交
  // 内恢复 HP」（架构 §八 8.2 显式修订 v2 死亡红线）。
  if (targetHpAfter <= 0 && defender.hp > 0) {
    const beforeDownEval = evaluateWindow(
      state.activeEffects,
      'unit.beforeDown',
      makeWindowRuntimeCtx(state, {
        selfId: attacker.id,
        targetId: defender.id,
        round: state.round,
        window: 'unit.beforeDown',
      }),
    );
    const pd = findPreventDeath(beforeDownEval.intents, defender.id);
    // PreventDeath 声明 slot='death.threshold' 即自认法则级（≥5）——SLOT 即门槛显式声明，
    // 无需重复读取 RULE_KEYS。找不到（目标不在场/非本目标）则按常规击倒。
    if (pd) {
      const keptHp = Math.max(1, Math.min(pd.hp, defender.maxHp));
      // 把 hpChanges 调到保留值（在原 clamp 基础上回补 keptHp - targetHpAfter）
      out.changes.hpChanges[defender.id] =
        (out.changes.hpChanges[defender.id] ?? 0) + (keptHp - targetHpAfter);
      targetHpAfter = keptHp;
      out.events.push({
        kind: 'DamagePrevented',
        unitId: defender.id,
        amount: finalDamage,
        keptHp,
      });
      // 不再产 UnitDowned（下面按 targetHpAfter>0 分支）
    }
  }

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
 * 从窗口求值结果中提取针对某目标、声明 death.threshold 的 PreventDeath intent。
 *
 * beforeDownEval.intents 是 RawIntent[]（{ automatonId, owner, intents }）。
 * 目标不匹配或缺 slot 标记 → 返回 undefined（不触发）；多个命中取首个（内核不叠加）。
 */
function findPreventDeath(
  raws: readonly { automatonId: string; owner: string; intents: readonly EffectIntent[] }[],
  defenderId: string,
): { hp: number } | undefined {
  for (const raw of raws) {
    for (const intent of raw.intents) {
      if (
        intent.kind === 'PreventDeath' &&
        intent.targetId === defenderId &&
        intent.slot === 'death.threshold' &&
        typeof intent.hp === 'number'
      ) {
        return { hp: intent.hp };
      }
    }
  }
  return undefined;
}

/**
 * M4：damage.after 窗口的 intent 接线（架构 §九 反伤 R1-R8，含互反熔断）。
 *
 * 遍历窗口收集的 RawIntent 批，对每条 automaton：
 *   - **反射**（ScheduleIntent 内包 DealDamage isReaction）：按 §九 解析——
 *       只认**受击方**（defender）的反伤被动触发；命中写
 *       `out.changes.hpChanges[反射目标] - reflectedAmount` + 产 DamageReflected。
 *       反射伤害落地后，**链式反伤**（R6/R7，case-x1 互反熔断）：受击的目标若带反伤被动，
 *       以该反射为新一轮伤害源继续传播（depth 递增），直到 depth ≥ MAX 产 mutual_cancel。
 *     - 反射目标 = ctx.damage.attackerId（原攻击者，builtins #9 的 targetId 表达式）。
 *   - **非反射 intent**（Heal / SpendResource / ApplyStatus / EmitNarrativeCue）：
 *       经 applyIntents 并入 out.changes（不传 reflectBase，避免与反射重复结算）。
 *
 * 全部写在 `out.changes`（PhaseOutcome 末尾原子提交），doesNotConsumeSlot 不碰槽位。
 * 通道耗尽 → 设 out.requiredInput（BeginOutput），反射整批跳过（等待续杯），不半提交。
 */
function applyAfterWindow(
  out: PhaseOutcome,
  state: CombatState,
  attacker: CombatState['units'][string],
  defender: CombatState['units'][string],
  raws: readonly RawIntent[],
  damageBase: { preReduction: number; final: number },
): void {
  for (const raw of raws) {
    // 窗口 ctx（带真实伤害覆盖）——resolveNumberExpr 求反射比例用的
    const winCtx = makeWindowRuntimeCtx(state, {
      selfId: attacker.id,
      targetId: defender.id,
      round: state.round,
      window: 'damage.after',
      damage: { preReduction: damageBase.preReduction, final: damageBase.final },
    });

    const nonReflect: EffectIntent[] = [];
    for (const intent of raw.intents) {
      // 反射 ScheduleIntent → 单独走 §九（只认**受击方**的反伤被动，raw.owner === defender）
      if (intent.kind === 'ScheduleIntent') {
        const inner = intent.intent;
        if (inner.kind === 'DealDamage' && inner.isReaction) {
          if (raw.owner === defender.id) {
            // 受击方（defender）的反伤被动：链式反伤从 depth=1 起传播（R1/R6/R7）
            reflectChain(out, state, defender, attacker, 1, damageBase.preReduction);
          }
          continue;
        }
      }
      // 其余 intent（Heal/SpendResource/ApplyStatus/NarrativeCue 等）累积到批
      nonReflect.push(intent);
    }

    // 非反射 intent → applyIntents（不传 reflectBase，反射已单独处理，避免重复）
    if (nonReflect.length > 0) {
      const r = applyIntents(
        {
          state,
          automatonOwner: raw.owner,
          resolveNumber: (expr, fb) => resolveNumberExpr(expr, winCtx.ctx, fb),
          present: (id) => {
            const u = state.units[id];
            return !!u && u.hp > 0;
          },
        },
        nonReflect,
        {
          hpChanges: out.changes.hpChanges,
          mpChanges: out.changes.mpChanges,
          spChanges: out.changes.spChanges,
          fpDelta: out.changes.fpDelta,
          statusPatches: out.changes.statusPatches,
          slotConsumptions: out.changes.slotConsumptions,
        },
      );
      out.changes.hpChanges = r.changes.hpChanges;
      out.changes.mpChanges = r.changes.mpChanges;
      out.changes.spChanges = r.changes.spChanges;
      out.changes.fpDelta = r.changes.fpDelta;
      out.changes.statusPatches = r.changes.statusPatches;
      if (r.narrative.length > 0) {
        for (const text of r.narrative) {
          out.events.push({ kind: 'NarrativeCue', text });
        }
      }
    }
  }
}

/**
 * M4：链式反伤（架构 §九 R6/R7，case-x1 互反熔断）。
 *
 * 从「受击方 victim 的反伤被动」出发，把该反伤作为一轮新伤害源传播：
 *   - 以 victim 视角求值 damage.after 窗口，只认 owner === victim 的反伤被动
 *   - 每条反伤 intent 经 applyReflectionIntent 以 `depth` 深度解析：
 *       · depth < MAX → 反伤命中目标（source），产 DamageReflected
 *       · depth ≥ MAX → mutual_cancel + 湮灭叙事（R6），不再传播
 *   - 反伤痛到 source 后，source 成为新一轮受击方，继续查其反伤被动（depth+1）
 *
 * 深度传播：根攻击 depth 0 → 首次反伤 depth 1 → 互反 depth 2（mutual_cancel 熔断）。
 * 基准固定取 rootChain 的 preReduction（R7，不放大）。递归天然有界（depth 每次 +1，
 * resolveReflection 在 depth≥2 返回 mutual_cancel，链在 2 层内终止，不会无限递归）。
 *
 * @param victim 受击方（本应查反伤被动的一方）
 * @param source 攻击者（反伤的目标）
 * @param depth  本轮反伤解析的深度（1 = 首次反伤；2 = 反伤对反伤 → 熔断）
 * @param rootBase  rootChain 原始伤害基准（R7，不放大）
 */
function reflectChain(
  out: PhaseOutcome,
  state: CombatState,
  victim: CombatState['units'][string],
  source: CombatState['units'][string],
  depth: number,
  rootBase: number,
): void {
  if (depth > MAX_REFLECTION_DEPTH) return; // 防御纵深：超出上限不再往下（正常走 resolveReflection 熔断）

  // 以 victim 视角求值 damage.after 窗口（伤害基准固定 rootBase，R7）
  const winCtx = makeWindowRuntimeCtx(state, {
    selfId: victim.id,
    targetId: source.id,
    round: state.round,
    window: 'damage.after',
    damage: { preReduction: rootBase, final: rootBase },
  });
  const evalResult = evaluateWindow(state.activeEffects, 'damage.after', winCtx);
  out.events.push(...evalResult.rejections);

  for (const raw of evalResult.intents) {
    // 只认受击方自身的反伤被动（owner 门控，R5）
    if (raw.owner !== victim.id) continue;
    for (const intent of raw.intents) {
      if (
        intent.kind === 'ScheduleIntent' &&
        intent.intent.kind === 'DealDamage' &&
        intent.intent.isReaction
      ) {
        // 深度解析：depth 1 → 反伤落地；depth ≥ MAX → mutual_cancel（applyReflectionIntent 内熔断）
        const landed = applyReflectionIntent(
          out,
          state,
          source,
          victim,
          intent.intent,
          { preReduction: rootBase, final: rootBase },
          winCtx,
          depth,
        );
        // 反伤落地到 source 后，source 成为新一轮受击方 → 继续查其反伤被动（互反链）
        if (landed) {
          reflectChain(out, state, source, victim, depth + 1, rootBase);
        }
      }
    }
  }
}

/**
 * M4：单条反伤 intent（ScheduleIntent 包 DealDamage isReaction）的 §九 解析。
 *
 * @param depth 本轮反伤解析深度（1 = 首次反伤；2 = 反伤对反伤 → resolveReflection 熔断）
 * @returns true = 反伤命中且落地（写 hpChanges + 产 DamageReflected）；false = 熔断/未命中/目标离场
 */
function applyReflectionIntent(
  out: PhaseOutcome,
  state: CombatState,
  attacker: CombatState['units'][string],
  defender: CombatState['units'][string],
  inner: Extract<EffectIntent, { kind: 'DealDamage' }>,
  damageBase: { preReduction: number; final: number },
  winCtx: ReturnType<typeof makeWindowRuntimeCtx>,
  depth: number,
): boolean {
  // 比例：从 amount 表达式（`ctx.damage.preReduction * N`）求值。
  // coerceAmount 语义：若 amount 是纯数字用字面量，否则 resolveNumberExpr 算。
  const amt =
    typeof inner.amount === 'number'
      ? inner.amount
      : resolveNumberExpr(inner.amount, winCtx.ctx, damageBase.preReduction);
  const ratio = damageBase.preReduction > 0 ? amt / damageBase.preReduction : 0;
  if (ratio <= 0) return false; // 无法求比例 → 反伤不触发（保守）

  const res = resolveReflection(depth, damageBase, ratio);
  if (res.kind === 'mutual_cancel') {
    // R6：depth ≥ MAX → 双方本链反伤互相抵消 + 湮灭叙事
    out.events.push({ kind: 'NarrativeCue', text: REFLECTION_ANNIHILATION_CUE });
    return false;
  }

  // 反射目标：builtins #9 的 targetId = 'ctx.damage.attackerId' → 原攻击者
  const targetId = resolveReflectionTarget(inner.targetId, attacker.id);
  const targetU = state.units[targetId];
  if (!targetU || targetU.hp <= 0) return false; // 目标不在场 → drop（Q5 语义）

  // R8：反伤命中骰（hitPolicy.consumeDice → attackHit 通道）。优势/劣势取 2 颗。
  if (inner.hitPolicy?.consumeDice) {
    const adv = inner.hitPolicy.advantage ?? 'none';
    const n = adv === 'none' ? 1 : 2;
    const r = draw(out.dice ?? state.dice, 'attackHit', n);
    if ('exhausted' in r) {
      // 通道耗尽 → 等待续杯（BeginOutput），反伤整批跳过，不半提交
      out.requiredInput = { kind: 'BeginOutput', channel: 'attackHit' };
      return false;
    }
    out.dice = r.tape;
    const rolls =
      adv === 'adv'
        ? [Math.max(r.rolls[0], r.rolls[1]), Math.max(r.rolls[0], r.rolls[1])]
        : adv === 'dis'
          ? [Math.min(r.rolls[0], r.rolls[1]), Math.min(r.rolls[0], r.rolls[1])]
          : [r.rolls[0]];
    // 命中检定（攻方=反射方 defender，守方=原攻击者）
    const hit = performAttackCheck({
      rolls: adv === 'none' ? [rolls[0]] : [rolls[0], rolls[1]],
      attackerTier: defender.tier,
      defenderTier: targetU.tier,
      hitBonus: defender.hitBonus,
      defenderDodge: targetU.dodgeBonus,
      dodgeNegated: !targetU.canAct,
    });
    if (hit.rating.coefficient <= 0) return false; // 未命中 → 反伤不结算
  }

  // 写反射伤害到目标 HP（doesNotConsumeSlot 不碰槽位）
  out.changes.hpChanges[targetId] = (out.changes.hpChanges[targetId] ?? 0) - res.reflectedAmount;
  out.events.push({
    kind: 'DamageReflected',
    rootChainId: typeof inner.rootChainId === 'string' ? inner.rootChainId : '',
    // 反伤深度 = 本轮解析深度（1 = 首次反伤；R6 熔断的 depth=2 不产此事件）
    depth,
    base: res.baseDamage,
    amount: res.reflectedAmount,
  });
  return true;
}

/** 反射目标 id 解析：builtins #9 的 targetId 是 'ctx.damage.attackerId' 表达式 → 原攻击者 */
function resolveReflectionTarget(targetId: string, attackerId: string): string {
  if (targetId === 'ctx.damage.attackerId') return attackerId;
  // 其他表达式串 → 保守回退为原攻击者（reflect automaton 的守方身份即原攻击对象）
  if (targetId.startsWith('ctx.')) return attackerId;
  return targetId;
}

/**
 * 校验 DeclareAttack 命令的目标是否在场。
 * reducer 在路由攻击前用它做 TARGET_NOT_PRESENT 拒绝（验收 A1-2）。
 */
export function isAttackTargetLegal(state: CombatState, targetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.units, targetId);
}

// ──────────────────────────────────────────────────────────────────────────────
// A4-4 divinity 压制意图对抗（架构 §八 8.3）
// ──────────────────────────────────────────────────────────────────────────────

/**
 * 差 ≥5 的意图对抗（必成/必败）——不消费 intentCheck 骰（A4-4）。
 *
 * 直接构造 IntentionResult：
 *   - direction=1（攻方 divinity 高）→ 必成，系数取意图配置
 *   - direction=-1（守方 divinity 高）→ 必败，系数 1.0
 *
 * 返回值供 handleAttack 下游（coefficient 参与伤害管线）。
 */
function forcedIntention(
  intentionLevel: IntentionLevel,
  direction: 1 | -1,
  _atkDiv: number,
  _defDiv: number,
): IntentionResult {
  const config = getIntentionConfig(intentionLevel);
  const success = direction === 1;
  return {
    level: intentionLevel,
    verdict: success ? '成功' : '失败',
    coefficient: success ? config.coefficient : 1.0,
    extraEffects: success && config.triggersExtraEffects ? [`${intentionLevel}意图额外效果`] : [],
    narrativeNote: `divinity 差 ≥5 压制：${success ? '攻方 div 高必成（不掷意图骰）' : '守方 div 高必败（不掷意图骰）'}`,
  };
}

/**
 * 差 1~4 的意图对抗——正常消费 intentCheck 2 颗骰（C5），
 * 压制幅度（0.2/0.4/0.6/0.8）作为攻方检定额外加值并入 resolveIntention 前的 value。
 *
 * 通道耗尽 → 设置 out.requiredInput（BeginOutput），返回一个惰性占位（调用方据
 * requiredInput 提前返回，不消费占位结果）。
 */
function rollIntention(
  intentionLevel: IntentionLevel,
  attacker: CombatState['units'][string],
  defender: CombatState['units'][string],
  state: CombatState,
  suppressMagnitude: number,
  out: PhaseOutcome,
): IntentionResult {
  const intentDraw = draw(state.dice, 'intentCheck', 2);
  if ('exhausted' in intentDraw) {
    out.requiredInput = { kind: 'BeginOutput', channel: 'intentCheck' };
    // 占位意图（不会真用——调用方看到 requiredInput 立即返回）
    return {
      level: intentionLevel,
      verdict: '失败',
      coefficient: 1.0,
      extraEffects: [],
      narrativeNote: 'intentCheck 通道耗尽，等待续杯',
    };
  }
  out.dice = intentDraw.tape;
  const [attackerIntentRoll, defenderIntentRoll] = intentDraw.rolls;

  // C5 语义：对抗检定 value = T×5 + d20(+难度)；divinity 压制幅度作为攻方加值
  // （攻高 positive / 守高 negative），等价于把压制系数落到攻方 value 上。
  const attackerOffset = Math.round(suppressMagnitude * 20); // 0.2~0.8 → 4~16 点
  const attackerScaled = attackerIntentRoll + attackerOffset;

  return resolveIntention({
    intentionLevel,
    attackerTier: attacker.tier,
    defenderTier: defender.tier,
    defenderIncapacitated: defender.hp <= 0 || !defender.canAct,
    defenderMorale: defender.morale,
    isExecutionIntent: intentionLevel === '处决',
    nonLethal: false,
    attackerD20: attackerScaled,
    defenderD20: defenderIntentRoll,
  });
}
