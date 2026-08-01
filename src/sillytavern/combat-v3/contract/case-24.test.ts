/**
 * combat-v3/contract/case-24.test.ts — 第 24 场反射 contract test（M4, A4-1）
 *
 * 断言：攻方打带 50% 反伤被动的守方 → 守方反伤到攻方（DamageReflected），
 * 攻方 HP 被反伤扣减，depth=1。eventHash 冻结（A4-5）。
 */

import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-24-reflection.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-24-reflection', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('反伤落地：攻方被反伤扣血（DamageReflected + hp 下降）', () => {
    const refl = result.events.filter((e) => e.kind === 'DamageReflected');
    expect(refl.length).toBeGreaterThan(0);
    const attackerStart = 3000;
    const attackerEnd = finalSnapshot?.units['处刑人']?.hp ?? 3000;
    expect(attackerEnd).toBeLessThan(attackerStart);
  });

  it('reflected milestone：depth=1', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'reflected')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('damage milestone 命中守方', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'damage')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('eventHash 冻结为具体字符串（A4-5）', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
