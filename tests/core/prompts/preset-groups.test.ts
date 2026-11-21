/**
 * preset-groups.test.ts — 正文预设互斥组与开关覆写层（纯函数）。
 */
import { describe, it, expect } from 'vitest';
import type { ChatPreset } from '../../../src/core/types/types';
import {
  applyPresetEntryToggles,
  diffPresetEntryToggles,
  mergePresetEntryToggles,
  readPresetGroups,
  resolvePresetGroupState,
  selectPresetGroupOption,
  type PresetGroup,
} from '../../../src/core/prompts/preset-groups';

interface Entry {
  identifier?: string;
  name?: string;
  content?: string;
  enabled?: boolean;
  injection_order?: number;
}

function preset(prompts: Entry[], groups?: unknown): ChatPreset {
  const settings: Record<string, unknown> = { prompts };
  if (groups !== undefined) settings.extensions = { poem: { groups } };
  return { id: 'p1', name: '测试预设', settings, createdAt: 1, updatedAt: 1 };
}

const BASE: Entry[] = [
  { identifier: 'a', name: '文风 A', content: 'A', enabled: true, injection_order: 10 },
  { identifier: 'b', name: '文风 B', content: 'B', enabled: false, injection_order: 20 },
  { identifier: 'c', name: '文风 C', content: 'C', injection_order: 30 },
  { identifier: 'story_zone_1', name: '【上下文分区 1】固定前缀', content: '', enabled: true },
];

function group(overrides: Partial<PresetGroup> = {}): PresetGroup {
  return {
    id: 'style',
    label: '文风',
    allowNone: false,
    options: [
      { identifier: 'a', label: 'A' },
      { identifier: 'b', label: 'B' },
    ],
    ...overrides,
  };
}

describe('readPresetGroups', () => {
  it('没有元数据或元数据形状错误时返回空数组且不抛', () => {
    expect(readPresetGroups(preset(BASE))).toEqual([]);
    expect(readPresetGroups(preset(BASE, 'oops'))).toEqual([]);
    expect(readPresetGroups(preset(BASE, { id: 'x' }))).toEqual([]);
    expect(readPresetGroups({ settings: null } as unknown as ChatPreset)).toEqual([]);
    expect(readPresetGroups(undefined as unknown as ChatPreset)).toEqual([]);
  });

  it('读取合法组并补齐缺省字段', () => {
    const groups = readPresetGroups(
      preset(BASE, [
        {
          id: 'style',
          label: '文风',
          description: '只能选一个',
          allowNone: true,
          options: [{ identifier: 'a', label: 'A' }, { identifier: 'b' }],
        },
      ]),
    );
    expect(groups).toEqual([
      {
        id: 'style',
        label: '文风',
        description: '只能选一个',
        allowNone: true,
        options: [
          { identifier: 'a', label: 'A' },
          { identifier: 'b', label: 'b' },
        ],
      },
    ]);
  });

  it('丢弃没有 id 的组、options 为空的组与坏选项', () => {
    const groups = readPresetGroups(
      preset(BASE, [
        { label: '无 id', options: [{ identifier: 'a', label: 'A' }] },
        { id: '', options: [{ identifier: 'a', label: 'A' }] },
        { id: 'empty', options: [] },
        { id: 'noOptions' },
        null,
        42,
        {
          id: 'mixed',
          options: [
            null,
            { label: '缺 identifier' },
            { identifier: 'missing', label: '不存在' },
            { identifier: 'story_zone_1', label: '占位' },
            { identifier: 'c', label: 'C' },
          ],
        },
        { id: 'allBad', options: [{ identifier: 'story_zone_1', label: '占位' }] },
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('mixed');
    expect(groups[0].label).toBe('mixed');
    expect(groups[0].allowNone).toBe(false);
    expect(groups[0].options).toEqual([{ identifier: 'c', label: 'C' }]);
  });

  it('组 id 重复与 identifier 跨组重复时取第一个', () => {
    const groups = readPresetGroups(
      preset(BASE, [
        { id: 'g1', label: '一', options: [{ identifier: 'a', label: 'A' }] },
        { id: 'g1', label: '重复', options: [{ identifier: 'b', label: 'B' }] },
        {
          id: 'g2',
          label: '二',
          options: [
            { identifier: 'a', label: 'A 再次' },
            { identifier: 'b', label: 'B' },
            { identifier: 'b', label: 'B 同组重复' },
          ],
        },
        { id: 'g3', options: [{ identifier: 'a', label: 'A' }] },
      ]),
    );
    expect(groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(groups[0].label).toBe('一');
    expect(groups[1].options).toEqual([{ identifier: 'b', label: 'B' }]);
  });
});

describe('resolvePresetGroupState', () => {
  it('恰好一个启用 → ok', () => {
    expect(resolvePresetGroupState(preset(BASE), group())).toEqual({
      status: 'ok',
      selected: 'a',
    });
  });

  it('一个都没启用 → none', () => {
    const p = preset(BASE.map((e) => (e.identifier === 'a' ? { ...e, enabled: false } : e)));
    expect(resolvePresetGroupState(p, group())).toEqual({ status: 'none' });
  });

  it('enabled 缺省视为启用，多个启用 → conflict（按选项顺序）', () => {
    const g = group({
      options: [
        { identifier: 'c', label: 'C' },
        { identifier: 'b', label: 'B' },
        { identifier: 'a', label: 'A' },
      ],
    });
    expect(resolvePresetGroupState(preset(BASE), g)).toEqual({
      status: 'conflict',
      enabled: ['c', 'a'],
    });
  });

  it('预设里已不存在的选项不算启用', () => {
    const p = preset(BASE.filter((e) => e.identifier !== 'a'));
    expect(resolvePresetGroupState(p, group())).toEqual({ status: 'none' });
  });
});

describe('selectPresetGroupOption', () => {
  it('选中一项时其余选项一律关闭', () => {
    expect(selectPresetGroupOption(preset(BASE), group(), 'b')).toEqual({ a: false, b: true });
  });

  it('null 只在 allowNone 时允许', () => {
    expect(selectPresetGroupOption(preset(BASE), group(), null)).toBeNull();
    expect(selectPresetGroupOption(preset(BASE), group({ allowNone: true }), null)).toEqual({
      a: false,
      b: false,
    });
  });

  it('不在组内的 identifier 返回 null', () => {
    expect(selectPresetGroupOption(preset(BASE), group(), 'c')).toBeNull();
  });

  it('补丁套用后组状态即为所选', () => {
    const p = preset(BASE);
    const patch = selectPresetGroupOption(p, group(), 'b');
    const next = applyPresetEntryToggles(p, patch);
    expect(resolvePresetGroupState(next, group())).toEqual({ status: 'ok', selected: 'b' });
  });
});

describe('applyPresetEntryToggles', () => {
  it('套用覆写且不修改入参', () => {
    const p = preset(BASE);
    const before = JSON.stringify(p);
    const next = applyPresetEntryToggles(p, { a: false, b: true });
    expect(next).not.toBe(p);
    expect(JSON.stringify(p)).toBe(before);
    const byId = Object.fromEntries(
      (next.settings.prompts as Entry[]).map((e) => [e.identifier, e.enabled]),
    );
    expect(byId).toMatchObject({ a: false, b: true, c: undefined });
    // 未改动的条目保持原引用
    expect(next.settings.prompts[2]).toBe(p.settings.prompts[2]);
  });

  it('没有变化时返回原引用', () => {
    const p = preset(BASE);
    expect(applyPresetEntryToggles(p, {})).toBe(p);
    expect(applyPresetEntryToggles(p, { a: true, c: true })).toBe(p);
    expect(applyPresetEntryToggles(p, { unknown: false })).toBe(p);
    expect(applyPresetEntryToggles(p, null)).toBe(p);
    expect(applyPresetEntryToggles(p, undefined)).toBe(p);
  });

  it('未知 identifier、非布尔值与五区占位条目被忽略', () => {
    const p = preset(BASE);
    const next = applyPresetEntryToggles(p, {
      unknown: true,
      story_zone_1: false,
      a: 'no' as unknown as boolean,
      b: true,
    });
    const entries = next.settings.prompts as Entry[];
    expect(entries.find((e) => e.identifier === 'story_zone_1')?.enabled).toBe(true);
    expect(entries.find((e) => e.identifier === 'a')?.enabled).toBe(true);
    expect(entries.find((e) => e.identifier === 'b')?.enabled).toBe(true);
  });

  it('settings.prompts 缺失时返回原引用', () => {
    const p = { id: 'x', name: 'x', settings: {}, createdAt: 1, updatedAt: 1 } as ChatPreset;
    expect(applyPresetEntryToggles(p, { a: false })).toBe(p);
  });
});

describe('diffPresetEntryToggles', () => {
  it('只保留与原始行不同的键', () => {
    expect(
      diffPresetEntryToggles(preset(BASE), {
        a: true,
        b: true,
        c: false,
        unknown: false,
        story_zone_1: false,
      }),
    ).toEqual({ b: true, c: false });
  });

  it('全部与原始行一致或入参为空时返回空对象', () => {
    expect(diffPresetEntryToggles(preset(BASE), { a: true, b: false, c: true })).toEqual({});
    expect(diffPresetEntryToggles(preset(BASE), null)).toEqual({});
  });
});

describe('mergePresetEntryToggles', () => {
  const GROUPS = [
    {
      id: 'style',
      options: [
        { identifier: 'a', label: 'A' },
        { identifier: 'b', label: 'B' },
      ],
    },
  ];

  it('pin：整组键全留，哪怕与原始行相同', () => {
    const p = preset(BASE, GROUPS);
    expect(mergePresetEntryToggles(p, {}, { a: true, b: false }, { pin: true })).toEqual({
      a: true,
      b: false,
    });
  });

  it('已钉住的组在后续单条开关（不碰组成员）时保留', () => {
    const p = preset(BASE, GROUPS);
    expect(mergePresetEntryToggles(p, { a: true, b: false }, { c: false })).toEqual({
      a: true,
      b: false,
      c: false,
    });
  });

  it('单条开关碰到已钉住组的成员：该组解除钉住，按 diff 归一', () => {
    const p = preset(BASE, GROUPS);
    expect(mergePresetEntryToggles(p, { a: true, b: false }, { b: true })).toEqual({ b: true });
  });

  it('不钉住时与 diff 相同', () => {
    const p = preset(BASE, GROUPS);
    expect(mergePresetEntryToggles(p, {}, { a: true, c: true })).toEqual({});
  });
});
