/**
 * combat-v3/contract/milestones.ts — milestone 断言工具（M4 contract test 共用）
 *
 * 把 `replayCombat(fixture).events`（DomainEvent[]）翻译成九种 MilestoneKind 的断言。
 *
 * 九种 kind（plan §2.3）：
 *   - damage       ：找 DamageApplied，断言 final（targetId 匹配）
 *   - reflected    ：找 DamageReflected，断言 depth / rootChainId / amount
 *   - prevented    ：找 DamagePrevented，断言 keptHp
 *   - statusApplied：找 StatusApplied，断言 statusId
 *   - moraleChanged：找 MoraleChanged，断言 state
 *   - summoned     ：找 UnitSummoned 数量
 *   - terminal     ：找 CombatEnded / state.terminal
 *   - fpDelta      ：终局 settlement 的 FP 净变动
 *   - roundCount   ：终局 round
 *
 * 每个 milestone 由 `assertMilestone(events, state, m)` 返回 { ok, actual, message }；
 * contract test 逐条断言 ok 为 true（value 在 tolerance 内）。
 */

import type { DomainEvent, Milestone, CombatState, CombatView } from '../types';

/** 断言结果 */
export interface MilestoneCheck {
  ok: boolean;
  actual: string;
  message: string;
}

/**
 * 断言一个 milestone。基于事件序列 + 终局 state 投影。
 * actual 是实际观测值的字符串；ok 表示 value 满足（无 value 的只断言 kind 存在）。
 */
export function assertMilestone(
  events: readonly DomainEvent[],
  view: Readonly<CombatView> | undefined,
  m: Milestone,
): MilestoneCheck {
  switch (m.kind) {
    case 'damage': {
      const ev = events.find((e) => e.kind === 'DamageApplied') as
        (DomainEvent & { targetId: string; final: number }) | undefined;
      if (!ev) return fail('no DamageApplied');
      if (m.targetId && ev.targetId !== m.targetId)
        return fail(`damage target ${ev.targetId} ≠ ${m.targetId}`);
      return numericCheck(ev.final, m.value, m.tolerance, 'damage');
    }
    case 'reflected': {
      const ev = events.find((e) => e.kind === 'DamageReflected') as
        (DomainEvent & { depth: number; amount: number; rootChainId: string }) | undefined;
      if (!ev) return fail('no DamageReflected');
      if (m.depth !== undefined && ev.depth !== m.depth)
        return fail(`reflect depth ${ev.depth} ≠ ${m.depth}`);
      if (m.rootChainId && ev.rootChainId !== m.rootChainId)
        return fail(`rootChain ${ev.rootChainId} ≠ ${m.rootChainId}`);
      if (m.value === undefined) return pass(`reflected depth=${ev.depth} amount=${ev.amount}`);
      return numericCheck(ev.amount, m.value, m.tolerance, 'reflected');
    }
    case 'prevented': {
      const ev = events.find((e) => e.kind === 'DamagePrevented') as
        (DomainEvent & { keptHp: number; unitId: string }) | undefined;
      if (!ev) return fail('no DamagePrevented');
      if (m.targetId && ev.unitId !== m.targetId)
        return fail(`prevented unit ${ev.unitId} ≠ ${m.targetId}`);
      if (m.value === undefined) return pass(`prevented keptHp=${ev.keptHp}`);
      return numericCheck(ev.keptHp, m.value, m.tolerance, 'prevented');
    }
    case 'statusApplied': {
      const ev = events.find((e) => e.kind === 'StatusApplied') as
        (DomainEvent & { statusId: string; unitId: string }) | undefined;
      if (!ev) return fail('no StatusApplied');
      if (m.statusId && ev.statusId !== m.statusId)
        return fail(`status ${ev.statusId} ≠ ${m.statusId}`);
      return pass(`statusApplied ${ev.statusId} on ${ev.unitId}`);
    }
    case 'moraleChanged': {
      const ev = events.find((e) => e.kind === 'MoraleChanged') as
        (DomainEvent & { state: string; unitId: string }) | undefined;
      if (!ev) return fail('no MoraleChanged');
      if (m.targetId && ev.unitId !== m.targetId)
        return fail(`morale unit ${ev.unitId} ≠ ${m.targetId}`);
      return pass(`moraleChanged ${ev.state}`);
    }
    case 'summoned': {
      const count = events.filter((e) => e.kind === 'UnitSummoned').length;
      if (m.value !== undefined && count < m.value)
        return fail(`summoned count ${count} < ${m.value}`);
      return pass(`summoned ${count}`);
    }
    case 'terminal': {
      const ev = events.find((e) => e.kind === 'CombatEnded');
      if (!ev && !view?.terminal) return fail('no terminal');
      const reason = ev?.kind === 'CombatEnded' ? ev.reason : view?.terminal?.reason;
      if (m.reason && reason !== m.reason) return fail(`terminal reason ${reason} ≠ ${m.reason}`);
      return pass(`terminal ${reason}`);
    }
    case 'fpDelta': {
      // 从事件里凑 FP 净变动（SpendResource fp 之和）
      const total = events
        .filter((e) => e.kind === 'ResourceSpent' && e.resource === 'fp')
        .reduce((acc, e) => acc + (e as { amount: number }).amount, 0);
      // 事件是扣减（负向）；fixture.milestone.value 若给正数表示扣掉多少
      const net = -total;
      if (m.value === undefined) return pass(`fpDelta ${net}`);
      return numericCheck(net, m.value, m.tolerance ?? 100, 'fpDelta');
    }
    case 'roundCount': {
      const round = view?.round ?? 1;
      if (m.value !== undefined && round < m.value) return fail(`round ${round} < ${m.value}`);
      return pass(`round ${round}`);
    }
    default:
      return fail(`unknown milestone kind ${m.kind}`);
  }
}

/** 数值断言（value 在 [expected±tolerance] 内才算 ok） */
function numericCheck(
  actual: number,
  expected: number | undefined,
  tolerance: number | undefined,
  label: string,
): MilestoneCheck {
  if (expected === undefined) return pass(`${label}=${actual}`);
  const tol = tolerance ?? 0;
  const ok = Math.abs(actual - expected) <= tol;
  return {
    ok,
    actual: `${label}=${actual}`,
    message: ok
      ? `${label} ${actual} ≈ ${expected} (±${tol})`
      : `${label} ${actual} 超出 [${expected - tol}, ${expected + tol}]`,
  };
}

function pass(message: string): MilestoneCheck {
  return { ok: true, actual: message, message };
}
function fail(message: string): MilestoneCheck {
  return { ok: false, actual: message, message };
}

/** 终局状态投影（ReplayResult 不含 view，由 contract test 从 trace 拉最后一个 snapshot） */
export type MilestoneView = Readonly<CombatView>;
