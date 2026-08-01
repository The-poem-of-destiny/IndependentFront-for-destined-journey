/**
 * combat-v3/contract/case-x2.test.ts — 真死复活 contract test（M4, A4-2）
 */
import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-x2-true-death-revive.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-x2-true-death-revive', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('death.threshold 生效：攻方一击致死被 PreventDeath 截断，守方存活', () => {
    const prevented = result.events.filter((e) => e.kind === 'DamagePrevented');
    expect(prevented.length).toBeGreaterThan(0);
    const hp = finalSnapshot?.units['理查德']?.hp ?? 0;
    expect(hp).toBeGreaterThan(0);
  });

  it('prevented milestone（keptHp=30）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'prevented')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('eventHash 确定性', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
