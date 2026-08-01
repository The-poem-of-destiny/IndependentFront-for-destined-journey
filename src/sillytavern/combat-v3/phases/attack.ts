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
import { evaluateWindow } from '../windows';
import type { CombatCommand, CombatDefinitionBundle, CombatState, DomainEvent } from '../types';
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
  evaluateWindow(state.activeEffects, 'check.intent', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

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
  evaluateWindow(state.activeEffects, 'collect_attacker_mods', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

  // ── ③ check.hit：取 attackHit 通道 1~2 颗骰 → performAttackCheck（M-5） ──
  evaluateWindow(state.activeEffects, 'check.hit', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

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
  evaluateWindow(state.activeEffects, 'collect_defender_mods', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

  // ── ⑤ damage.compute：8 步管线 + clamp ≥ 0（C7） ──
  evaluateWindow(state.activeEffects, 'damage.compute', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

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

  // ── ⑥ damage.preview 窗口（M1 空转；M3 接 RequestChoice 重算） ──
  evaluateWindow(state.activeEffects, 'damage.preview', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

  const preReduction = initialDamage;
  const postStep6 = damage.afterRating;

  // ── ⑦ checkNonLethal（C6）——在 ⑧ beforeDown 之前 ──
  const nonLethal = checkNonLethal({
    nonLethal: !!command.payload.nonLethal,
    ratingCoefficient: attackCheck.rating.coefficient,
    finalDamage,
    currentHp: defender.hp,
  });

  const hpDelta = nonLethal.applied
    ? nonLethal.adjustedHp - defender.hp
    : -Math.min(finalDamage, defender.hp);

  // 非致死 + 昏迷
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
  evaluateWindow(state.activeEffects, 'unit.beforeDown', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

  // ⑨ damage.after 窗口（M3 接反伤）
  evaluateWindow(state.activeEffects, 'damage.after', {
    selfId: attacker.id,
    targetId: defender.id,
    round: state.round,
  });

  // ── ⑩ 追加 pendingChanges + DomainEvents（攻守双方同批，M-9） ──

  // 攻方资源消耗（costs 或 默认 0）
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

  // 守方 HP（负伤害即增减益，HP 由 applyPending clamp 到 [0,maxHp]）
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
    damageType: ability.damageType,
    targetHpBefore,
    targetHpAfter,
  });

  if (targetHpAfter <= 0) {
    out.events.push({ kind: 'UnitDowned', unitId: defender.id, hp: targetHpAfter });
  }

  return out;
}

/**
 * 校验 DeclareAttack 命令的目标是否在场。
 * reducer 在路由攻击前用它做 TARGET_NOT_PRESENT 拒绝（验收 A1-2）。
 */
export function isAttackTargetLegal(state: CombatState, targetId: string): boolean {
  return Object.prototype.hasOwnProperty.call(state.units, targetId);
}
