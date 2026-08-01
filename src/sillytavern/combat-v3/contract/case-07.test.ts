/**
 * combat-v3/contract/case-07.test.ts — 第 07 场保命 contract test（M4, A4-1）
 */
import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-07-prevent-death.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-07-prevent-death', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('PreventDeath 保命：守方被打至 0 前被截断，存活', () => {
    const prevented = result.events.filter((e) => e.kind === 'DamagePrevented');
    expect(prevented.length).toBeGreaterThan(0);
    const hp = finalSnapshot?.units['理查德']?.hp ?? 0;
    expect(hp).toBeGreaterThan(0);
  });

  it('prevented milestone（keptHp=400）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'prevented')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('eventHash 确定性', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
