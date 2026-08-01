/**
 * combat-v3/contract/case-06.test.ts — 第 06 场召唤 contract test（M4, A4-1）
 *
 * 召唤触发链：召唤师·艾萨 action.declared 窗口求值 → SpawnOrDespawnIntent →
 * CharGenRequest（冻结 spawn frame）→ resumeSpawn（SupplyUnit）→ UnitSummoned + FP 扣减。
 */
import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-06-summon.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-06-summon（召唤端到端）', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('召唤落地：产 UnitSummoned + 当回合参战（this_round_tail joinTiming）', () => {
    const summoned = result.events.filter((e) => e.kind === 'UnitSummoned');
    expect(summoned.length).toBeGreaterThan(0);
    const ev = summoned[0];
    expect(ev).toBeDefined();
    if (ev && ev.kind === 'UnitSummoned') {
      expect(ev.joinTiming).toBe('this_round_tail');
    }
  });

  it('summoned milestone', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'summoned')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('fpDelta milestone（召唤扣 100 FP）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'fpDelta')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
    // FP 实际从 300 降到 200
    expect(finalSnapshot?.resourceSnapshots?.FP).toBe(200);
  });

  it('eventHash 确定性', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
