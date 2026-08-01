/**
 * combat-v3/contract/case-13.test.ts — 第 13 场时间暂停 contract test（M4, A4-3）
 *
 * 触发链：时间收割者 turn.open 窗口求值 → OverrideIntent(action.freezeSlot, target=理查德)
 * → applyPending 合并进 state.frozenSlots → 理查德 openUnitTurn 读 frozenSlots → 槽位全冻结。
 */
import { describe, expect, it } from 'vitest';
import { replayCombat } from '../replay';
import fixtureJson from '../fixtures/case-13-time-freeze.fixture.json';
import type { CombatFixture } from '../types';
import { assertMilestone } from './milestones';

const fixture = fixtureJson as CombatFixture;

describe('case-13-time-freeze（freezeSlot 端到端）', () => {
  const result = replayCombat(fixture);
  const finalSnapshot = result.trace?.dispatches[result.trace.dispatches.length - 1]?.snapshot;

  it('freezeSlot 触发：理查德开回合槽位被冻结（TurnOpened 0 攻 0 动）', () => {
    const opened = result.events.filter((e) => e.kind === 'TurnOpened' && e.unitId === '理查德');
    expect(opened.length).toBeGreaterThan(0);
    const last = opened[opened.length - 1];
    if (last && last.kind === 'TurnOpened') {
      expect(last.attacksRemaining).toBe(0);
      expect(last.actionsRemaining).toBe(0);
    }
  });

  it('damage milestone（时停斩命中理查德）', () => {
    const m = fixture.expected.milestones.find((x) => x.kind === 'damage')!;
    const check = assertMilestone(result.events, finalSnapshot, m);
    expect(check.ok, check.message).toBe(true);
  });

  it('eventHash 确定性', () => {
    expect(fixture.expected.eventHash).toBeTruthy();
    expect(result.hash).toBe(fixture.expected.eventHash); // A4-5 冻结：hash 变化必须在 PR 说明
  });
});
