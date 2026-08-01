/**
 * combat-v3/adjudication.ts — BoundedAdjudication 有界裁决纯函数（M3.5）
 *
 * 架构真源：docs/reference/combat-system-architecture-v3.md §十一（BoundedAdjudication 11.2/11.4）
 * 实施计划：docs/planning/2026-07-31-combat-v3-implementation-plan.md §6.5
 *
 * `evaluateAdjudication(p, state)`：对战斗 Agent 提交的 `ProposedAdjudication` 做**六步边界验证**。
 *
 * 定位（架构 §十一 11.1）：「奇迹 / 概念抹杀」等剧情级开放性创意硬塞进 closed EffectIntent
 * 词汇既破坏封闭性又表达不了 → 让战斗 Agent 自己判创造性，**内核只验边界**（ADR-11）。
 *
 * ······ 内核验证流程（架构 §十一 11.2，**不验证创造性**）：
 *   1. verifiableBounds.targetLegal          否 ⇒ Reject('目标非法')
 *   2. divinity ≥ target.divinity            否 ⇒ Reject('神性不足')
 *   3. divinity ≥ 5（法则级硬门槛）           否 ⇒ Reject('未达裁决门槛')
 *   4. requestedRuleOverride ∈ closed 白名单  否 ⇒ Reject('未注册 RuleKey')
 *   5. invariantCompliant 全 true             否 ⇒ Reject('违反不变量')
 *   6. numericalRange 超品质上限              是 ⇒ clamp（v2 §13.2 决策 j，不 reject）
 *   ⇒ 通过：产 AdjudicationResult.accepted（含 RuleOverridden / MiracleTriggered 事件策略）
 *   ⇒ 未通过：AdjudicationResult.rejected（coordinator 据此产 EffectRejected ADJUDICATION_REJECTED）
 *
 * 防滥用硬门槛（架构 §十一 11.4，验收 A35-4）：`divinity ≥ 5（微弱法则）` 才能提交裁决。
 * 低于法则级的"创意效果"必须用标准 EffectIntent 组合表达——否则封闭性形同虚设。
 *
 * 铁律（plan §1.3）：本文件零 Math.random / new Function / eval；纯函数 + 不可变。
 */

import type { AdjudicationResult, CombatState, ProposedAdjudication } from './types';
import { V3_RULE_KEYS } from '../combat-item-validator';

/** 法则级硬门槛（架构 §十一 11.4，A35-4） */
export const ADJUDICATION_MIN_DIVINITY = 5;

/**
 * hex 数值护栏（v2 §13.2 决策 j：数值超品质上限 clamp 而非 reject）。
 * 与 automata/compile.ts 的 ±10000 护栏对齐，保证跨模块数值上限一致。
 */
const NUMBER_GUARD = 10000;

/**
 * 内核实锤一次有界裁决（纯函数，六步验证照架构 §十一 11.2）。
 *
 * 只验 verifiableBounds 边界 + divinity 门槛，不验证 effectDescription/reason 的创造性。
 * 返回 AdjudicationResult：
 *   - accepted：附加事件策略（RuleOverridden 或 MiracleTriggered）+ 透传 reason
 *   - rejected：人类可读原因（coordinator 转成 EffectRejected code:'ADJUDICATION_REJECTED'）
 */
export function evaluateAdjudication(
  p: ProposedAdjudication,
  state: CombatState,
): AdjudicationResult {
  // 1. 目标合法（架构 §十一 11.2 step 1）
  if (!p.verifiableBounds.targetLegal) {
    return { kind: 'rejected', reason: '目标非法' };
  }

  // 若指定目标，必须实际在场，且其 divinity 必须被提案 divinity 压住（step 2）
  if (p.targetId !== undefined) {
    const target = state.units[p.targetId];
    if (!target) {
      return { kind: 'rejected', reason: `目标「${p.targetId}」不在场` };
    }
    const targetDivinity = target.ability?.divinity ?? 0;
    if (p.divinity < targetDivinity) {
      return { kind: 'rejected', reason: `神性不足（${p.divinity} < 目标 ${targetDivinity}）` };
    }
  }

  // 3. 法则级硬门槛（架构 §十一 11.4，A35-4）
  if (p.divinity < ADJUDICATION_MIN_DIVINITY) {
    return {
      kind: 'rejected',
      reason: `未达裁决门槛（divinity ${p.divinity} < ${ADJUDICATION_MIN_DIVINITY}）`,
    };
  }

  // 4. requestedRuleOverride ∈ closed RuleKey 白名单（架构 §十一 11.2 step 4）
  if (p.requestedRuleOverride !== undefined && !V3_RULE_KEYS.has(p.requestedRuleOverride)) {
    return { kind: 'rejected', reason: `未注册 RuleKey「${p.requestedRuleOverride}」` };
  }

  // 5. invariantCompliant 全 true（架构 §十一 11.2 step 5）
  if (p.verifiableBounds.invariantCompliant.some((c) => !c.ok)) {
    const failed = p.verifiableBounds.invariantCompliant.find((c) => !c.ok);
    return {
      kind: 'rejected',
      reason: `违反不变量「${failed?.name ?? '未知'}」${failed?.detail ? `：${failed.detail}` : ''}`,
    };
  }

  // 6. numericalRange 超护栏 → clamp（v2 §13.2 决策 j，不 reject）
  // numericalRange 不直接出现在 AdjudicationResult 载荷里——它是给协调器/事件 payload 的
  // 数值护栏提示；超上限时 clamp 后放行（prop 透传由 Adjudicate Command 携带）。
  // 这里只断言范围合法（min ≤ max），越界值由下游按 NUMBER_GUARD clamp。
  const range = p.verifiableBounds.numericalRange;
  if (range && range.min > range.max) {
    return { kind: 'rejected', reason: 'numericalRange 范围非法（min > max）' };
  }

  // 通过：产 accepted + 事件策略（RuleOverridden 优先；无 RuleKey 则 MiracleTriggered）
  const reason = p.reason || p.effectDescription;
  return p.requestedRuleOverride !== undefined
    ? {
        kind: 'accepted' as const,
        effect: { eventKind: 'RuleOverridden' as const, ruleKey: p.requestedRuleOverride },
        reason,
      }
    : {
        kind: 'accepted' as const,
        effect: { eventKind: 'MiracleTriggered' as const },
        reason,
      };
}

export { NUMBER_GUARD };
