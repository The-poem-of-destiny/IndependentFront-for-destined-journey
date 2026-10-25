/**
 * story-zone-placeholders.test.ts — Story 预设五区占位条目（D24–D27，T50–T53）。
 */
import { describe, it, expect } from 'vitest';
import type { AgentPreset } from '../../../src/core/types/types';
import {
  ensureStoryZonePlaceholders,
  isStoryZonePlaceholder,
  segmentPresetByStoryZones,
  storyZoneIdentifier,
  storyZoneOf,
} from '../../../src/core/prompts/story-zone-placeholders';
import {
  assemblePresetContent,
  preprocessPresetForPreview,
} from '../../../src/core/prompts/preset-loader';

interface Entry {
  identifier?: string;
  name?: string;
  content?: string;
  role?: string;
  enabled?: boolean;
  injection_order?: number;
}

function zone(n: 1 | 2 | 3 | 4 | 5, order: number): Entry {
  return {
    identifier: storyZoneIdentifier(n),
    name: [
      '',
      '【上下文分区 1】固定前缀',
      '【上下文分区 2】长期记忆总览',
      '【上下文分区 3】区域背景',
      '【上下文分区 4】摘要与近期正文',
      '【上下文分区 5】本轮资料与召回',
    ][n],
    role: 'system',
    enabled: true,
    content: '',
    injection_order: order,
  };
}

function entry(name: string, order: number, extra: Partial<Entry> = {}): Entry {
  return {
    identifier: `custom_${name}`,
    name,
    content: name,
    role: 'system',
    enabled: true,
    injection_order: order,
    ...extra,
  };
}

const labels = (list: Entry[]) => list.map((e) => storyZoneOf(e) ?? e.name);

describe('storyZoneOf / isStoryZonePlaceholder', () => {
  it('只认 story_zone_1…5 的 identifier', () => {
    expect(storyZoneOf({ identifier: 'story_zone_3' })).toBe(3);
    expect(storyZoneOf({ identifier: 'story_zone_6' })).toBeNull();
    expect(storyZoneOf({ identifier: 'story_zone_x' })).toBeNull();
    expect(storyZoneOf({ name: '【上下文分区 1】固定前缀' })).toBeNull();
    expect(isStoryZonePlaceholder({ identifier: 'story_zone_1' })).toBe(true);
    expect(isStoryZonePlaceholder(undefined)).toBe(false);
  });
});

describe('ensureStoryZonePlaceholders', () => {
  it('已规范的预设原样返回，不改 injection_order', () => {
    const input = [
      zone(1, 10),
      entry('A', 20),
      zone(2, 30),
      zone(3, 40),
      entry('B', 50),
      zone(4, 60),
      zone(5, 70),
    ];
    const result = ensureStoryZonePlaceholders(input);
    expect(result.changed).toBe(false);
    expect(result.entries.map((e) => e.injection_order)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('一个占位都没有时 5 条依次追加到末尾并重编号', () => {
    const result = ensureStoryZonePlaceholders([entry('B', 20), entry('A', 10)]);
    expect(result.changed).toBe(true);
    expect(labels(result.entries)).toEqual(['A', 'B', 1, 2, 3, 4, 5]);
    expect(result.entries.map((e) => e.injection_order)).toEqual([10, 20, 30, 40, 50, 60, 70]);
  });

  it('缺失分区紧跟在编号更小的已有占位之后，没有更小的就放在更大的之前', () => {
    const result = ensureStoryZonePlaceholders([
      entry('A', 10),
      zone(2, 20),
      entry('B', 30),
      zone(4, 40),
      entry('C', 50),
    ]);
    expect(labels(result.entries)).toEqual(['A', 1, 2, 3, 'B', 4, 5, 'C']);
  });

  it('占位相对顺序被打乱时按 1→5 回到原槽位，普通条目不动', () => {
    const result = ensureStoryZonePlaceholders([
      zone(3, 10),
      entry('A', 20),
      zone(1, 30),
      zone(2, 40),
      entry('B', 50),
      zone(5, 60),
      zone(4, 70),
    ]);
    expect(result.changed).toBe(true);
    expect(labels(result.entries)).toEqual([1, 'A', 2, 3, 'B', 4, 5]);
  });

  it('重复的同号占位只留第一条；被改动的占位恢复规范形状', () => {
    const tampered = { ...zone(1, 10), content: '偷偷写进去', enabled: false, name: '改名' };
    const result = ensureStoryZonePlaceholders([
      tampered,
      zone(1, 15),
      zone(2, 20),
      zone(3, 30),
      zone(4, 40),
      zone(5, 50),
    ]);
    expect(result.changed).toBe(true);
    expect(labels(result.entries)).toEqual([1, 2, 3, 4, 5]);
    expect(result.entries[0]).toMatchObject({
      content: '',
      enabled: true,
      name: '【上下文分区 1】固定前缀',
    });
  });
});

describe('segmentPresetByStoryZones', () => {
  it('普通条目段与分区位置交替，停用的普通条目跳过', () => {
    const segments = segmentPresetByStoryZones([
      zone(1, 10),
      entry('A', 20),
      entry('off', 25, { enabled: false }),
      zone(2, 30),
      zone(3, 40),
      entry('B', 50),
      zone(4, 60),
      zone(5, 70),
      entry('C', 80),
    ]);
    expect(
      segments.map((s) => (s.kind === 'zone' ? s.zone : s.entries.map((e) => e.name).join('+'))),
    ).toEqual([1, 'A', 2, 3, 'B', 4, 5, 'C']);
  });
});

describe('旧模式装配：占位展开为空（D27）', () => {
  function preset(prompts: Entry[], extra: Partial<AgentPreset> = {}): AgentPreset {
    return {
      id: 'p',
      name: 'p',
      fixedSystem: '',
      fixedExamples: '',
      ...extra,
      settings: { prompts },
    } as AgentPreset;
  }

  it('有无占位条目，拼接结果逐字节一致（不留空行）', () => {
    const plain = [entry('甲', 10), entry('乙{{NARRATIVE}}', 20)];
    const withZones = [
      zone(1, 5),
      entry('甲', 10),
      zone(2, 12),
      zone(3, 14),
      entry('乙{{NARRATIVE}}', 20),
      zone(4, 30),
      zone(5, 40),
    ];
    expect(assemblePresetContent(preset(withZones), '')).toBe(
      assemblePresetContent(preset(plain), ''),
    );
    expect(assemblePresetContent(preset(withZones), '')).toBe('甲\n乙{{NARRATIVE}}');
  });

  it('预览也不显示占位条目', () => {
    const withZones = [
      zone(1, 5),
      entry('甲', 10),
      zone(2, 12),
      zone(3, 14),
      zone(4, 30),
      zone(5, 40),
    ];
    expect(preprocessPresetForPreview(preset(withZones))).toBe('甲');
  });

  it('只剩占位的 fixedSystem 形老预设仍走 fixedSystem 路径', () => {
    const onlyZones = [zone(1, 10), zone(2, 20), zone(3, 30), zone(4, 40), zone(5, 50)];
    expect(assemblePresetContent(preset(onlyZones, { fixedSystem: '老系统提示' }), '')).toBe(
      '老系统提示',
    );
  });
});
