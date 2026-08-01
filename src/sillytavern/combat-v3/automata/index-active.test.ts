/**
 * combat-v3/automata/index-active.test.ts — ActiveEffectIndex 派生/增量测试（M3）
 *
 * 覆盖（plan §5.8）：
 *   - buildIndex 按 window 分组并排序（divinity 高者先 → priority → stable id）
 *   - updateIndex 增量加 automaton（ApplyStatus 增量加）
 *   - updateIndex 离场移除（removeIds 跨所有窗口过滤 + byOwner 清理）
 */

import { describe, it, expect } from 'vitest';
import { buildIndex, updateIndex, compareAutomata } from './index-active';
import type { CompiledAutomaton } from '../types';

function mkAuto(
  id: string,
  subscribe: CompiledAutomaton['subscribe'],
  partial: Partial<CompiledAutomaton> = {},
): CompiledAutomaton {
  return {
    id,
    name: id,
    source: '测试',
    owner: '理查德',
    subscribe,
    priority: 0,
    divinity: 0,
    stableId: id,
    triggerAst: { t: 'bool', v: true },
    intents: [],
    isAdapter: true,
    ...partial,
  };
}

describe('buildIndex — 按 window 分组并排序', () => {
  it('divinity 高者先（求值顺序 divinity → priority → id）', () => {
    const list = [
      mkAuto('a', 'damage.after', { divinity: 1, priority: 5 }),
      mkAuto('b', 'damage.after', { divinity: 5, priority: 1 }),
      mkAuto('c', 'damage.after', { divinity: 3 }),
    ];
    const idx = buildIndex(list);
    const queue = idx.byWindow['damage.after'];
    expect(queue.map((x) => x.id)).toEqual(['b', 'c', 'a']);
  });

  it('same divinity → priority 升序', () => {
    const list = [
      mkAuto('x', 'check.hit', { divinity: 2, priority: 3 }),
      mkAuto('y', 'check.hit', { divinity: 2, priority: 1 }),
    ];
    const idx = buildIndex(list);
    expect(idx.byWindow['check.hit'].map((x) => x.id)).toEqual(['y', 'x']);
  });

  it('same divinity & priority → stable id 字典序', () => {
    const list = [
      mkAuto('b', 'round.open', { divinity: 0, priority: 0 }),
      mkAuto('a', 'round.open', { divinity: 0, priority: 0 }),
    ];
    const idx = buildIndex(list);
    expect(idx.byWindow['round.open'].map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('缺失窗口补空数组', () => {
    const idx = buildIndex([mkAuto('z', 'check.hit')]);
    expect(idx.byWindow['damage.preview']).toEqual([]);
    expect(idx.byWindow['round.open']).toEqual([]);
  });

  it('byOwner 按持有者分组', () => {
    const idx = buildIndex([
      mkAuto('a', 'check.hit', { owner: '理查德' }),
      mkAuto('b', 'damage.after', { owner: '处刑人' }),
      mkAuto('c', 'damage.after', { owner: '理查德' }),
    ]);
    expect(idx.byOwner['理查德']).toEqual(expect.arrayContaining(['a', 'c']));
    expect(idx.byOwner['处刑人']).toContain('b');
  });
});

describe('updateIndex — 增量加（ApplyStatus 增量加 automaton）', () => {
  it('add 追加并排序', () => {
    const idx = buildIndex([mkAuto('a', 'damage.after', { divinity: 1 })]);
    const next = updateIndex(idx, {
      add: [mkAuto('new', 'damage.after', { divinity: 5 })],
    });
    const queue = next.byWindow['damage.after'];
    expect(queue.map((x) => x.id)).toEqual(['new', 'a']); // divinity 高者先
  });

  it('不可变：入参原索引不被修改', () => {
    const idx = buildIndex([]);
    const before = idx.byWindow['damage.after'];
    updateIndex(idx, { add: [mkAuto('x', 'damage.after')] });
    expect(idx.byWindow['damage.after']).toEqual(before);
  });
});

describe('updateIndex — 离场移除', () => {
  it('removeIds 跨所有窗口过滤 + byOwner 清理', () => {
    const idx = buildIndex([
      mkAuto('keep', 'damage.after'),
      mkAuto('gone', 'damage.after'),
      mkAuto('gone2', 'check.hit'),
    ]);
    const next = updateIndex(idx, { removeIds: ['gone'] });
    expect(next.byWindow['damage.after'].map((x) => x.id)).toEqual(['keep']);
    expect(next.byWindow['check.hit'].map((x) => x.id)).toEqual(['gone2']);
    // byOwner 清理
    for (const ids of Object.values(next.byOwner)) {
      expect(ids).not.toContain('gone');
    }
  });

  it('空 delta 返回原对象', () => {
    const idx = buildIndex([]);
    expect(updateIndex(idx, {})).toBe(idx);
  });
});

describe('compareAutomata — 排序比较器', () => {
  it('优先级：divinity > priority > id', () => {
    const a = { id: 'a', divinity: 1, priority: 0, stableId: 'a' } as CompiledAutomaton;
    const b = { id: 'b', divinity: 2, priority: 0, stableId: 'b' } as CompiledAutomaton;
    expect(compareAutomata(a, b)).toBeGreaterThan(0); // b divinity 更高 → a 排在 b 后
  });
});
