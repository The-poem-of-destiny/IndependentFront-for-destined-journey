/**
 * combat-v3/contract/case-09.test.ts — 第 09 场概念 contract test（M4, A4-1）
 */
import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-09-concept.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-09-concept', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('驱动内核：伤害 milestone（真理火球 > 0）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'damage')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('roundCount milestone', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'roundCount')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('forceTerminal 终局：Adjudicate 裁决 → reducer 应用 state.terminal（reason=force_terminal）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'terminal')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
    // RuleOverridden(terminal.forceTerminal) 事件已产
    expect(
      result.events.some(
        (e) => e.kind === 'RuleOverridden' && e.ruleKey === 'terminal.forceTerminal',
      ),
    ).toBe(true);
  });

  it('eventHash 确定性（连跑两次相同）', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
