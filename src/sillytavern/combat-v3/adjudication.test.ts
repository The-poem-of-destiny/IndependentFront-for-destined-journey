/**
 * combat-v3/adjudication.test.ts — BoundedAdjudication 六步验证纯函数（M3.5）
 *
 * 验收（plan §6.8 / 架构 §十一 11.2 / §6.1）：
 *   A35-4  divinity < 5 被 reject（硬门槛）
 *   六步验证逐条：目标非法 / 未注册 RuleKey / 不变量违反 → reject
 *   通过 → AdjudicationAccepted（accepted：RuleOverridden 或 MiracleTriggered）
 *   理由进 AdjudicationResult.reason（供 journal/A35-5）
 */

import { describe, it, expect } from 'vitest';
import { evaluateAdjudication, ADJUDICATION_MIN_DIVINITY } from './adjudication';
import { createCombatState } from './state';
import { mkBundle } from './test-utils';
import type { CombatState, ProposedAdjudication } from './types';

/** 构造一个合法的 baseline 提案（divinity 达标、targetLegal、invariant 全 true） */
function mkProposal(over: Partial<ProposedAdjudication> = {}): ProposedAdjudication {
  return {
    effectDescription: '认知丧失 → 永久失能',
    divinity: 6,
    verifiableBounds: {
      targetLegal: true,
      invariantCompliant: [{ name: 'units.invariant', ok: true }],
    },
    reason: '概念宕机',
    ...over,
  };
}

function mkState(): CombatState {
  // 乙带 divinity 的 ability，测试「神性不足」分支
  const bundle = mkBundle();
  const s = createCombatState(bundle);
  return {
    ...s,
    units: {
      ...s.units,
      乙: { ...s.units['乙'], ability: { ...s.units['乙'].ability!, divinity: 4 } },
    },
  };
}

describe('A35-4：divinity < 5 被 reject（法则级硬门槛）', () => {
  it('divinity = 4 → rejected 未达裁决门槛', () => {
    const r = evaluateAdjudication(mkProposal({ divinity: 4 }), mkState());
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toContain('未达裁决门槛');
  });

  it('divinity = 5（边界值）→ accepted', () => {
    const r = evaluateAdjudication(mkProposal({ divinity: 5 }), mkState());
    expect(r.kind).toBe('accepted');
  });

  it('常量 ADJUDICATION_MIN_DIVINITY === 5', () => {
    expect(ADJUDICATION_MIN_DIVINITY).toBe(5);
  });
});

describe('六步验证：目标非法', () => {
  it('targetLegal = false → rejected 目标非法', () => {
    const r = evaluateAdjudication(
      mkProposal({ verifiableBounds: { targetLegal: false, invariantCompliant: [] } }),
      mkState(),
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toContain('目标非法');
  });
});

describe('六步验证：神性不足（divinity ≥ target.divinity）', () => {
  it('targetId 指定且 target.divinity > proposal → rejected 神性不足', () => {
    // 乙 ability.divinity = 4，提案 divinity = 3
    const r = evaluateAdjudication(mkProposal({ targetId: '乙', divinity: 3 }), mkState());
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toContain('神性不足');
  });

  it('targetId 指定且 target.divinity ≤ proposal → accepted', () => {
    const r = evaluateAdjudication(mkProposal({ targetId: '乙', divinity: 6 }), mkState());
    expect(r.kind).toBe('accepted');
  });
});

describe('六步验证：未注册 RuleKey reject', () => {
  it('requestedRuleOverride 不在 closed 白名单 → rejected 未注册 RuleKey', () => {
    const r = evaluateAdjudication(
      mkProposal({ requestedRuleOverride: 'nonsense.key' }),
      mkState(),
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toContain('未注册 RuleKey');
  });

  it('registered terminal.forceTerminal → accepted + RuleOverridden', () => {
    const r = evaluateAdjudication(
      mkProposal({ requestedRuleOverride: 'terminal.forceTerminal' }),
      mkState(),
    );
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.effect.eventKind).toBe('RuleOverridden');
      expect(r.reason).toBe('概念宕机');
    }
  });
});

describe('六步验证：不变量违反 reject', () => {
  it('invariantCompliant 含一条 !ok → rejected 违反不变量', () => {
    const r = evaluateAdjudication(
      mkProposal({
        verifiableBounds: {
          targetLegal: true,
          invariantCompliant: [
            { name: 'hp.clamp', ok: true },
            { name: 'slot.conserve', ok: false, detail: '扣血超上限' },
          ],
        },
      }),
      mkState(),
    );
    expect(r.kind).toBe('rejected');
    if (r.kind === 'rejected') expect(r.reason).toContain('违反不变量');
  });
});

describe('通过 → AdjudicationAccepted', () => {
  it('无 RuleKey → MiracleTriggered + reason 透传', () => {
    const r = evaluateAdjudication(mkProposal({ reason: '禁忌之门' }), mkState());
    expect(r.kind).toBe('accepted');
    if (r.kind === 'accepted') {
      expect(r.effect.eventKind).toBe('MiracleTriggered');
      expect(r.reason).toBe('禁忌之门');
    }
  });

  it('numericalRange 合法（min ≤ max）且其余全通过 → accepted', () => {
    const r = evaluateAdjudication(
      mkProposal({
        verifiableBounds: {
          targetLegal: true,
          numericalRange: { min: 0, max: 10000 },
          invariantCompliant: [],
        },
      }),
      mkState(),
    );
    expect(r.kind).toBe('accepted');
  });
});
