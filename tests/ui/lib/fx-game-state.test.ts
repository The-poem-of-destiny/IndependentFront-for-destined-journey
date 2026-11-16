/**
 * fx-game-state.ts — 游戏状态 → 特效氛围的纯函数投影
 */
import { describe, it, expect } from 'vitest';
import { daypartOf, weatherKindOf, settledTurnOf } from '../../../src/ui/lib/fx-game-state';

describe('daypartOf', () => {
  it('按小时分四段', () => {
    expect(daypartOf({ hour: 5 })).toBe('dawn');
    expect(daypartOf({ hour: 7 })).toBe('dawn');
    expect(daypartOf({ hour: 8 })).toBe('day');
    expect(daypartOf({ hour: 16 })).toBe('day');
    expect(daypartOf({ hour: 17 })).toBe('dusk');
    expect(daypartOf({ hour: 19 })).toBe('dusk');
    expect(daypartOf({ hour: 20 })).toBe('night');
    expect(daypartOf({ hour: 0 })).toBe('night');
    expect(daypartOf({ hour: 4 })).toBe('night');
  });

  it('缺时间 / 非法值按白天（不加氛围）', () => {
    expect(daypartOf(null)).toBe('day');
    expect(daypartOf(undefined)).toBe('day');
    expect(daypartOf({ hour: Number.NaN })).toBe('day');
  });
});

describe('weatherKindOf', () => {
  it('雨类标签 → rain', () => {
    for (const s of ['小雨', '暴雨', '雷阵雨', '阵雨', '雷暴', '细雨绵绵']) {
      expect(weatherKindOf(s)).toBe('rain');
    }
  });

  it('雾类标签 → fog', () => {
    for (const s of ['薄雾', '大雾', '雾霾', '霾']) {
      expect(weatherKindOf(s)).toBe('fog');
    }
  });

  it('未知 / 空 → null', () => {
    expect(weatherKindOf('晴')).toBeNull();
    expect(weatherKindOf('多云')).toBeNull();
    expect(weatherKindOf('')).toBeNull();
    expect(weatherKindOf('   ')).toBeNull();
    expect(weatherKindOf(null)).toBeNull();
    expect(weatherKindOf(undefined)).toBeNull();
  });
});

describe('settledTurnOf', () => {
  it('只数完成且未废弃的 assistant 正文', () => {
    expect(
      settledTurnOf([
        { role: 'system' },
        { role: 'user', storyTurnStatus: 'accepted' },
        { role: 'assistant' },
        { role: 'assistant', storyTurnStatus: 'accepted' },
        { role: 'assistant', storyTurnStatus: 'failed' },
        { role: 'assistant', storyTurnStatus: 'pending' },
        { role: 'assistant', diagnostic: true },
      ]),
    ).toBe(2);
  });

  it('空列表为 0', () => {
    expect(settledTurnOf([])).toBe(0);
  });
});
