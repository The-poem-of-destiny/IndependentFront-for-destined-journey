/**
 * combat-v3/windows.test.ts — ReactionWindow evaluator 测试（M3, 验收 A3-6）
 *
 * 覆盖（plan §5.8 / §五 5.4）：
 *   - 求值顺序 = window→divinity→priority→id（已由 buildIndex 排序，这里验证收集序）
 *   - owner 离场跳过（在场过滤）
 *   - 单个 automaton 抛错只废该批（错误隔离），不影响其他
 *   - 超 64 个截断 + EffectRejected(BUDGET_EXCEEDED)
 *   - charges 耗尽跳过
 */

import { describe, it, expect } from 'vitest';
import { evaluateWindow, makeWindowRuntimeCtx } from './windows';
import { buildIndex } from './automata/index-active';
import type { CombatState, CompiledAutomaton, WindowKey } from './types';
import { EMPTY_CHANGES } from './types';

function mkAuto(id: string, partial: Partial<CompiledAutomaton> = {}): CompiledAutomaton {
  return {
    id,
    name: id,
    source: '测试',
    owner: '理查德',
    subscribe: 'damage.after',
    priority: 0,
    divinity: 0,
    stableId: id,
    triggerAst: { t: 'bool', v: true },
    intents: [],
    isAdapter: true,
    ...partial,
  };
}

/** 造一个含单位的最小 state（present 检查用） */
function mkStateWith(units: string[]): CombatState {
  return {
    combatId: 't',
    revision: 0,
    phase: 'SlotConsume',
    round: 1,
    initiativeOrder: [],
    currentTurnIndex: 0,
    units: Object.fromEntries(units.map((id) => [id, { id, hp: 100, maxHp: 100 } as never])),
    activeEffects: {
      byWindow: {
        'round.open': [],
        'round.close': [],
        'initiative.before': [],
        'initiative.after': [],
        'turn.open': [],
        'turn.close': [],
        'action.declared': [],
        'check.intent': [],
        'check.hit': [],
        collect_attacker_mods: [],
        collect_defender_mods: [],
        'damage.preview': [],
        'damage.compute': [],
        'damage.after': [],
        'unit.beforeDown': [],
        'morale.before': [],
        'morale.after': [],
        'settlement.before': [],
      },
      byOwner: {},
    },
    dice: undefined as never,
    resourceSnapshots: { FP: 0 },
    journal: [],
    provenance: {
      engineVersion: 'v3',
      schemaVersion: '1',
      rulesetRevision: 't',
      bundleHash: 't',
      eventSequence: 0,
      diceEpochs: [],
    },
  };
}

function rt(state: CombatState, window: WindowKey) {
  return makeWindowRuntimeCtx(state, { round: state.round, window });
}

describe('evaluateWindow — 求值顺序（已由索引排序）', () => {
  it('按已排序队列收集 intent（divinity 高者先）', () => {
    const state = mkStateWith(['理查德']);
    const idx = buildIndex([
      mkAuto('low', {
        subscribe: 'damage.after',
        divinity: 1,
        intents: [{ kind: 'EmitNarrativeCue', text: 'low' }],
      }),
      mkAuto('high', {
        subscribe: 'damage.after',
        divinity: 5,
        intents: [{ kind: 'EmitNarrativeCue', text: 'high' }],
      }),
    ]);
    const { intents } = evaluateWindow(idx, 'damage.after', rt(state, 'damage.after'));
    expect(intents.map((x) => x.automatonId)).toEqual(['high', 'low']);
  });
});

describe('evaluateWindow — 在场过滤（A3-7 相关）', () => {
  it('owner 离场（present false）→ 跳过', () => {
    const state = mkStateWith(['理查德']); // 处刑人不在场
    const idx = buildIndex([
      mkAuto('myself', { owner: '理查德', intents: [{ kind: 'EmitNarrativeCue', text: 'a' }] }),
      mkAuto('gone', { owner: '处刑人', intents: [{ kind: 'EmitNarrativeCue', text: 'b' }] }),
    ]);
    const { intents } = evaluateWindow(idx, 'damage.after', rt(state, 'damage.after'));
    expect(intents.map((x) => x.automatonId)).toEqual(['myself']);
  });
});

describe('evaluateWindow — 错误隔离（§五 5.4）', () => {
  it('单个抛错只废该批，不影响其他', () => {
    const state = mkStateWith(['理查德']);
    // 抛错的 automaton：trigger 引用了 undefined path → evaluate 抛 ExprEvalError
    const bad = mkAuto('bad', {
      triggerAst: { t: 'path', segments: ['self', 'nonexistent'] },
      intents: [{ kind: 'EmitNarrativeCue', text: 'bad' }],
    });
    const ok = mkAuto('ok', { intents: [{ kind: 'EmitNarrativeCue', text: 'good' }] });
    const idx = buildIndex([bad, ok]);
    const { intents, rejections } = evaluateWindow(idx, 'damage.after', rt(state, 'damage.after'));
    // ok 照常收集；bad 被 reject
    expect(intents.map((x) => x.automatonId)).toEqual(['ok']);
    const rej = rejections.find(
      (r) => r.kind === 'EffectRejected' && (r as { automatonId?: string }).automatonId === 'bad',
    );
    expect(rej).toBeTruthy();
    if (rej && rej.kind === 'EffectRejected') expect(rej.code).toBe('EVAL_ERROR');
  });
});

describe('evaluateWindow — 预算 64', () => {
  it('超过 64 截断 + EffectRejected(BUDGET_EXCEEDED)', () => {
    const state = mkStateWith(['理查德']);
    const many = Array.from({ length: 70 }, (_, i) =>
      mkAuto(`m${i}`, { intents: [{ kind: 'EmitNarrativeCue', text: `m${i}` }] }),
    );
    const idx = buildIndex(many);
    const { intents, rejections } = evaluateWindow(idx, 'damage.after', rt(state, 'damage.after'));
    expect(intents.length).toBe(64);
    expect(
      rejections.some(
        (r) => r.kind === 'EffectRejected' && (r as { code?: string }).code === 'BUDGET_EXCEEDED',
      ),
    ).toBe(true);
  });
});

describe('evaluateWindow — charges', () => {
  it('charges 耗尽 → 跳过', () => {
    const state = mkStateWith(['理查德']);
    const idx = buildIndex([
      mkAuto('used', {
        charges: { max: 1, remaining: 0 },
        intents: [{ kind: 'EmitNarrativeCue', text: 'x' }],
      }),
      mkAuto('free', { intents: [{ kind: 'EmitNarrativeCue', text: 'y' }] }),
    ]);
    const { intents } = evaluateWindow(idx, 'damage.after', rt(state, 'damage.after'));
    expect(intents.map((x) => x.automatonId)).toEqual(['free']);
  });
});
