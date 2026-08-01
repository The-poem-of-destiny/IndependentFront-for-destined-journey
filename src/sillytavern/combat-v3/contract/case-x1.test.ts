/**
 * combat-v3/contract/case-x1.test.ts — 互反反射 contract test（M4, A4-2）
 */
import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-x1-mutual-reflection.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-x1-mutual-reflection', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('反射落地：攻方打守方 → 守方反伤攻方（DamageReflected），攻方 HP 下降', () => {
    const refl = result.events.filter((e) => e.kind === 'DamageReflected');
    expect(refl.length).toBeGreaterThan(0);
    const attackerEnd = finalSnapshot?.units['甲']?.hp ?? 5000;
    expect(attackerEnd).toBeLessThan(5000);
  });

  it('reflected milestone（depth=1）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'reflected')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('互反熔断：反伤落地后受击方的被动在 depth 2 触发 mutual_cancel + 反射湮灭（A4-2 / R6）', () => {
    // 双方各带 30% 反伤：乙反甲（depth1）落地后，甲的反伤被动触发 → resolveReflection(2)
    // 返回 mutual_cancel + NarrativeCue('反射湮灭')（R6 熔断）。断言湮灭叙事已产。
    const cue = result.events.filter((e) => e.kind === 'NarrativeCue' && e.text === '反射湮灭');
    expect(cue.length).toBeGreaterThan(0);
    // 互反最多 2 层：depth 1 的事件有（首次反伤落地），不存在 depth ≥ 2 的事件（熔断不产 DamageReflected）
    const refls = result.events.filter((e) => e.kind === 'DamageReflected');
    expect(refls.every((e) => e.depth === 1)).toBe(true);
  });

  it('eventHash 确定性', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
