/**
 * preset-entries.test.ts — 预设条目增删改序纯函数单测。
 */
import { describe, it, expect } from 'vitest';
import type { ChatPreset } from '@engine/types';
import {
  canonicalPresetEntries,
  makeCustomPresetEntry,
  appendPresetEntry,
  updatePresetEntry,
  removePresetEntry,
  movePresetEntry,
  duplicatePresetEntry,
} from './preset-entries';

function makePreset(
  prompts: Array<{ name: string; injection_order?: number; content?: string }>,
): ChatPreset {
  return {
    id: 'preset-1',
    name: '测试预设',
    settings: { prompts: prompts.map((p) => ({ ...p, role: 'system', enabled: true })) },
    createdAt: 1,
    updatedAt: 1,
  } as ChatPreset;
}

describe('canonicalPresetEntries', () => {
  it('按 injection_order 升序（缺省 0）返回，不改原数组', () => {
    const preset = makePreset([
      { name: 'C', injection_order: 30 },
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    expect(canonicalPresetEntries(preset).map((e) => e.name)).toEqual(['A', 'B', 'C']);
    // 原 settings.prompts 顺序不变
    expect((preset.settings.prompts as any[]).map((e) => e.name)).toEqual(['C', 'A', 'B']);
  });

  it('无 prompts 时返回空数组', () => {
    const preset = { id: 'x', name: 'x', settings: {}, createdAt: 0, updatedAt: 0 } as ChatPreset;
    expect(canonicalPresetEntries(preset)).toEqual([]);
  });
});

describe('makeCustomPresetEntry', () => {
  it('带 custom_ 前缀标识、默认 system/enabled、可注入 id', () => {
    const entry = makeCustomPresetEntry({ name: '新条目', content: '正文' }, () => 'abc');
    expect(entry.identifier).toBe('custom_abc');
    expect(entry.role).toBe('system');
    expect(entry.enabled).toBe(true);
    expect(entry.injection_order).toBeUndefined();
  });
});

describe('appendPresetEntry', () => {
  it('追加到生效顺序末尾并按位置重编号（步长 10），不改原预设', () => {
    const preset = makePreset([
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    const next = appendPresetEntry(
      preset,
      makeCustomPresetEntry({ name: 'C' }, () => 'c'),
    );

    expect(next).not.toBe(preset);
    expect(next.settings.prompts).toHaveLength(3);
    expect((next.settings.prompts as any[]).map((e) => e.name)).toEqual(['A', 'B', 'C']);
    expect((next.settings.prompts as any[]).map((e) => e.injection_order)).toEqual([10, 20, 30]);
    // 原预设未被动过
    expect(preset.settings.prompts).toHaveLength(2);
    expect(next.updatedAt).toBeGreaterThan(0);
  });

  it('非 10 步长的既有 order 会被规范化为位置序', () => {
    const preset = makePreset([
      { name: 'A', injection_order: 5 },
      { name: 'B', injection_order: 7 },
    ]);
    const next = appendPresetEntry(
      preset,
      makeCustomPresetEntry({ name: 'C' }, () => 'c'),
    );
    expect((next.settings.prompts as any[]).map((e) => e.injection_order)).toEqual([10, 20, 30]);
  });
});

describe('updatePresetEntry', () => {
  it('按生效顺序下标浅合并 patch', () => {
    const preset = makePreset([
      { name: 'B', injection_order: 20 },
      { name: 'A', injection_order: 10 },
    ]);
    const next = updatePresetEntry(preset, 0, { content: '改过' }); // 生效顺序第一条是 A
    expect((next.settings.prompts as any[]).find((e) => e.name === 'A').content).toBe('改过');
  });

  it('越界返回原引用', () => {
    const preset = makePreset([{ name: 'A', injection_order: 10 }]);
    expect(updatePresetEntry(preset, 9, { content: 'x' })).toBe(preset);
  });
});

describe('removePresetEntry', () => {
  it('按生效顺序下标删除并重编号', () => {
    const preset = makePreset([
      { name: 'C', injection_order: 30 },
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    const next = removePresetEntry(preset, 1); // 生效顺序 = A,B,C → 删 B
    expect((next.settings.prompts as any[]).map((e) => e.name)).toEqual(['A', 'C']);
    expect((next.settings.prompts as any[]).map((e) => e.injection_order)).toEqual([10, 20]);
  });

  it('越界返回原引用', () => {
    const preset = makePreset([{ name: 'A', injection_order: 10 }]);
    expect(removePresetEntry(preset, -1)).toBe(preset);
    expect(removePresetEntry(preset, 5)).toBe(preset);
  });
});

describe('movePresetEntry', () => {
  const preset = makePreset([
    { name: 'A', injection_order: 10 },
    { name: 'B', injection_order: 20 },
    { name: 'C', injection_order: 30 },
  ]);

  it('下移一位', () => {
    const next = movePresetEntry(preset, 0, 1);
    expect((next.settings.prompts as any[]).map((e) => e.name)).toEqual(['B', 'A', 'C']);
    expect((next.settings.prompts as any[]).map((e) => e.injection_order)).toEqual([10, 20, 30]);
  });

  it('上移一位', () => {
    const next = movePresetEntry(preset, 2, -1);
    expect((next.settings.prompts as any[]).map((e) => e.name)).toEqual(['A', 'C', 'B']);
  });

  it('越界（顶部上移 / 底部下移）返回原引用', () => {
    expect(movePresetEntry(preset, 0, -1)).toBe(preset);
    expect(movePresetEntry(preset, 2, 1)).toBe(preset);
  });
});

describe('duplicatePresetEntry', () => {
  it('副本插在原条目正下方，内容照抄、identifier 换新', () => {
    const preset = makePreset([
      { name: 'A', injection_order: 10, content: '甲' },
      { name: 'B', injection_order: 20, content: '乙' },
    ]);
    const next = duplicatePresetEntry(preset, 0, () => 'dup');
    const prompts = next.settings.prompts as any[];
    expect(prompts.map((e) => e.name)).toEqual(['A', 'A', 'B']);
    expect(prompts.map((e) => e.injection_order)).toEqual([10, 20, 30]);
    expect(prompts[0].content).toBe('甲');
    expect(prompts[1].content).toBe('甲');
    expect(prompts[1].identifier).toBe('custom_dup');
    expect(prompts[1].identifier).not.toBe(prompts[0].identifier);
  });

  it('越界返回原引用', () => {
    const preset = makePreset([{ name: 'A', injection_order: 10 }]);
    expect(duplicatePresetEntry(preset, 1)).toBe(preset);
    expect(duplicatePresetEntry(preset, -1)).toBe(preset);
  });
});
