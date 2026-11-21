import { describe, expect, it } from 'vitest';
import {
  countDirectDice,
  formatDirectDicePool,
  rollDirectDice,
} from '../../../src/core/agents/direct-dice';

describe('直出骰池', () => {
  it('按 d4,d6,d8,d10,d12,d20,d100 分组掷出 80 颗，值落在 1..骰面数', () => {
    const pool = rollDirectDice();
    expect(pool.map((g) => g.sides)).toEqual([4, 6, 8, 10, 12, 20, 100]);
    expect(pool.map((g) => g.values.length)).toEqual([10, 10, 10, 10, 10, 20, 10]);
    expect(countDirectDice(pool)).toBe(80);
    for (const { sides, values } of pool)
      expect(values.every((v) => Number.isInteger(v) && v >= 1 && v <= sides)).toBe(true);
  });

  it('每组格式化成一行 `d面数: {值, 值}`', () => {
    expect(
      formatDirectDicePool([
        { sides: 20, values: [12, 5, 17] },
        { sides: 6, values: [3] },
      ]),
    ).toEqual(['d20: {12, 5, 17}', 'd6: {3}']);
  });
});
