/**
 * preset-entries.test.ts — 预设条目增删改序纯函数单测（含五区占位条目守卫，T50/T53）。
 */
import { describe, it, expect } from 'vitest';
import type { ChatPreset } from '@engine/types/types';
import { storyZoneIdentifier, storyZoneOf } from '@engine/prompts/story-zone-placeholders';
import {
  canonicalPresetEntries,
  makeCustomPresetEntry,
  appendPresetEntry,
  updatePresetEntry,
  removePresetEntry,
  movePresetEntry,
  duplicatePresetEntry,
  isZonePlaceholderEntry,
} from '../../../src/ui/lib/preset-entries';

function makePreset(
  prompts: Array<{ name: string; injection_order?: number; content?: string; identifier?: string }>,
): ChatPreset {
  return {
    id: 'preset-1',
    name: '测试预设',
    settings: { prompts: prompts.map((p) => ({ ...p, role: 'system', enabled: true })) },
    createdAt: 1,
    updatedAt: 1,
  } as ChatPreset;
}

/** 生效顺序里的标签：占位条目显示为分区号，普通条目显示名称 */
function labels(preset: ChatPreset): Array<string | number> {
  return canonicalPresetEntries(preset).map((e) => storyZoneOf(e) ?? (e.name as string));
}

/** 只看普通条目的名称 */
function names(preset: ChatPreset): string[] {
  return canonicalPresetEntries(preset)
    .filter((e) => !isZonePlaceholderEntry(e))
    .map((e) => e.name as string);
}

function orders(preset: ChatPreset): number[] {
  return (preset.settings.prompts as any[]).map((e) => e.injection_order);
}

/** 一份已含五区占位的预设：A | 1 | B | 2 | 3 | C | 4 | 5 */
function zonedPreset(): ChatPreset {
  const zone = (n: 1 | 2 | 3 | 4 | 5, order: number) => ({
    identifier: storyZoneIdentifier(n),
    name: '',
    injection_order: order,
  });
  return makePreset([
    { name: 'A', injection_order: 10 },
    zone(1, 20),
    { name: 'B', injection_order: 30 },
    zone(2, 40),
    zone(3, 50),
    { name: 'C', injection_order: 60 },
    zone(4, 70),
    zone(5, 80),
  ]);
}

describe('canonicalPresetEntries', () => {
  it('按 injection_order 升序（缺省 0）返回，不改原数组', () => {
    const preset = makePreset([
      { name: 'C', injection_order: 30 },
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    expect(names(preset)).toEqual(['A', 'B', 'C']);
    // 原 settings.prompts 顺序不变
    expect((preset.settings.prompts as any[]).map((e) => e.name)).toEqual(['C', 'A', 'B']);
  });

  it('没有占位条目的预设在读取视图里补齐 5 条，追加在末尾、相对顺序 1→5', () => {
    const preset = makePreset([
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    expect(labels(preset)).toEqual(['A', 'B', 1, 2, 3, 4, 5]);
    // 读取视图不落库：原预设不被改写
    expect(preset.settings.prompts).toHaveLength(2);
  });

  it('无 prompts 时也只有 5 条占位', () => {
    const preset = { id: 'x', name: 'x', settings: {}, createdAt: 0, updatedAt: 0 } as ChatPreset;
    expect(labels(preset)).toEqual([1, 2, 3, 4, 5]);
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
  it('追加到生效顺序末尾并按位置重编号（步长 10），不改原预设；占位随这次改动落库', () => {
    const preset = makePreset([
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    const next = appendPresetEntry(
      preset,
      makeCustomPresetEntry({ name: 'C' }, () => 'c'),
    );

    expect(next).not.toBe(preset);
    expect(labels(next)).toEqual(['A', 'B', 1, 2, 3, 4, 5, 'C']);
    expect(orders(next)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
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
    expect(orders(next)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
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
    expect(updatePresetEntry(preset, 99, { content: 'x' })).toBe(preset);
  });

  it('占位条目不可编辑或停用', () => {
    const preset = zonedPreset();
    expect(updatePresetEntry(preset, 1, { content: '写点东西' })).toBe(preset);
    expect(updatePresetEntry(preset, 1, { enabled: false })).toBe(preset);
  });

  it('patch 不能改 identifier（普通条目不能被改成占位）', () => {
    const preset = zonedPreset();
    const next = updatePresetEntry(preset, 0, { identifier: storyZoneIdentifier(1), content: 'x' });
    expect(labels(next)).toEqual(['A', 1, 'B', 2, 3, 'C', 4, 5]);
  });
});

describe('removePresetEntry', () => {
  it('按生效顺序下标删除并重编号', () => {
    const preset = makePreset([
      { name: 'C', injection_order: 30 },
      { name: 'A', injection_order: 10 },
      { name: 'B', injection_order: 20 },
    ]);
    const next = removePresetEntry(preset, 1); // 生效顺序 = A,B,C,1..5 → 删 B
    expect(names(next)).toEqual(['A', 'C']);
    expect(orders(next)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('越界返回原引用', () => {
    const preset = makePreset([{ name: 'A', injection_order: 10 }]);
    expect(removePresetEntry(preset, -1)).toBe(preset);
    expect(removePresetEntry(preset, 99)).toBe(preset);
  });

  it('占位条目不可删除', () => {
    const preset = zonedPreset();
    for (const index of [1, 3, 4, 6, 7]) {
      expect(removePresetEntry(preset, index)).toBe(preset);
    }
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
    expect(names(next)).toEqual(['B', 'A', 'C']);
    expect(orders(next)).toEqual([10, 20, 30, 40, 50, 60, 70, 80]);
  });

  it('上移一位', () => {
    const next = movePresetEntry(preset, 2, -1);
    expect(names(next)).toEqual(['A', 'C', 'B']);
  });

  it('越界（顶部上移 / 底部下移）返回原引用', () => {
    expect(movePresetEntry(preset, 0, -1)).toBe(preset);
    expect(movePresetEntry(preset, 7, 1)).toBe(preset);
  });

  it('占位条目可与普通条目互换位置（普通条目插到分区之间）', () => {
    const next = movePresetEntry(zonedPreset(), 1, -1); // 1 上移越过 A
    expect(labels(next)).toEqual([1, 'A', 'B', 2, 3, 'C', 4, 5]);
  });

  it('两条占位之间不能互换（相对顺序恒为 1→5）', () => {
    const zoned = zonedPreset();
    expect(movePresetEntry(zoned, 3, 1)).toBe(zoned); // 2 ↔ 3
    expect(movePresetEntry(zoned, 7, -1)).toBe(zoned); // 5 ↔ 4
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
    expect(names(next)).toEqual(['A', 'A', 'B']);
    expect(prompts[0].content).toBe('甲');
    expect(prompts[1].content).toBe('甲');
    expect(prompts[1].identifier).toBe('custom_dup');
    expect(prompts[1].identifier).not.toBe(prompts[0].identifier);
  });

  it('越界返回原引用', () => {
    const preset = makePreset([{ name: 'A', injection_order: 10 }]);
    expect(duplicatePresetEntry(preset, 99)).toBe(preset);
    expect(duplicatePresetEntry(preset, -1)).toBe(preset);
  });

  it('占位条目不可复制（不能出现第六个分区）', () => {
    const preset = zonedPreset();
    expect(duplicatePresetEntry(preset, 1)).toBe(preset);
  });
});
