/**
 * story-context-mode.test.ts — Story 上下文新模式的测试档标记与存档准入（计划 §11.3，T35/T41/T43/T44）。
 */
import { describe, it, expect } from 'vitest';
import type { SaveSlot } from '../../../src/core/types/types';
import {
  createStoryContextV2Marker,
  decideStoryContextAdmission,
  isStoryContextV2Save,
  normalizeStoryWindowTurns,
  assessStoryContextBudget,
} from '../../../src/core/story/story-context-mode';

describe('assessStoryContextBudget', () => {
  it('按字符粗估 token；超过端点窗口才报超限，没配窗口不判断', () => {
    expect(assessStoryContextBudget({ totalChars: 300 }, 100)).toEqual({
      estimatedTokens: 200,
      contextWindowTokens: 100,
      overBudget: true,
    });
    expect(assessStoryContextBudget({ totalChars: 300 }, 1000).overBudget).toBe(false);
    expect(assessStoryContextBudget({ totalChars: 300 }, undefined)).toEqual({
      estimatedTokens: 200,
      overBudget: false,
    });
    expect(assessStoryContextBudget({ totalChars: 300 }, 0).overBudget).toBe(false);
  });
});

function save(metadata: Record<string, unknown> = {}): Pick<SaveSlot, 'metadata'> {
  return {
    metadata: {
      characterName: '甲',
      userName: '玩家',
      gameStartTime: '',
      totalTurns: 0,
      ...metadata,
    } as SaveSlot['metadata'],
  };
}

describe('isStoryContextV2Save', () => {
  it('有标记对象即为测试档，缺席即为普通档', () => {
    expect(isStoryContextV2Save(save({ storyContextV2: createStoryContextV2Marker(1) }))).toBe(
      true,
    );
    expect(isStoryContextV2Save(save())).toBe(false);
    expect(isStoryContextV2Save(null)).toBe(false);
    expect(isStoryContextV2Save(undefined)).toBe(false);
  });

  it('未来 schema 的标记仍被认作测试档（认不出就放行等于标记失效）', () => {
    expect(isStoryContextV2Save(save({ storyContextV2: { schema: 9, markedAt: 1 } }))).toBe(true);
  });

  it('非对象的值不算标记', () => {
    expect(isStoryContextV2Save(save({ storyContextV2: true }))).toBe(false);
    expect(isStoryContextV2Save(save({ storyContextV2: null }))).toBe(false);
  });
});

describe('decideStoryContextAdmission', () => {
  const v2 = save({ storyContextV2: createStoryContextV2Marker(1) });
  const legacy = save();

  it('普通档 + 开关关闭 → 旧模式', () => {
    expect(decideStoryContextAdmission(legacy, false)).toEqual({ ok: true, mode: 'legacy' });
  });

  it('测试档 + 开关开启 → 新模式', () => {
    expect(decideStoryContextAdmission(v2, true)).toEqual({ ok: true, mode: 'v2' });
  });

  it('测试档 + 开关关闭 → 拒绝，不降级到旧模式', () => {
    expect(decideStoryContextAdmission(v2, false)).toEqual({
      ok: false,
      reason: 'v2-save-requires-v2-mode',
    });
  });

  it('普通档 + 开关开启 → 拒绝，不自动升级为测试档', () => {
    expect(decideStoryContextAdmission(legacy, true)).toEqual({
      ok: false,
      reason: 'legacy-save-in-v2-mode',
    });
  });
});

describe('normalizeStoryWindowTurns', () => {
  it('只接受正整数', () => {
    expect(normalizeStoryWindowTurns(1)).toBe(1);
    expect(normalizeStoryWindowTurns(6)).toBe(6);
  });

  it('N=0、负数、小数、非数字一律拒绝', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '4', null, undefined]) {
      expect(normalizeStoryWindowTurns(bad)).toBeNull();
    }
  });
});
