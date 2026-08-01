/**
 * ejs-rng.ts 测试 —— 种子随机（能力面 §3.10 / §7 / 切片 T2）
 *
 * 核心不变式只有一条：**同种子同序列**。它撑着快照回退重放的一致性 ——
 * 回到同一个存档点重发，世界书正文必须逐字节一样。
 */

import { describe, it, expect } from 'vitest';
import { createEjsRng, buildPassSeed, hashSeed } from './ejs-rng';

describe('buildPassSeed', () => {
  it('存档 + 回合决定种子；缺存档时退化但仍确定', () => {
    expect(buildPassSeed('save-1', 7)).toBe('save-1#7');
    expect(buildPassSeed(undefined, undefined)).toBe(buildPassSeed(undefined, undefined));
    expect(buildPassSeed('save-1', 7)).not.toBe(buildPassSeed('save-1', 8));
    expect(buildPassSeed('save-1', 7)).not.toBe(buildPassSeed('save-2', 7));
  });
});

describe('hashSeed', () => {
  it('确定、非负、32 位内', () => {
    expect(hashSeed('abc')).toBe(hashSeed('abc'));
    expect(hashSeed('abc')).not.toBe(hashSeed('abd'));
    expect(hashSeed('abc')).toBeGreaterThanOrEqual(0);
    expect(hashSeed('abc')).toBeLessThan(2 ** 32);
  });
});

describe('createEjsRng · 确定性', () => {
  it('同种子 → 逐值一致的完整序列', () => {
    const seq = (): unknown[] => {
      const r = createEjsRng('save-1#7|条目A');
      return [r.float(), r.roll('2d6+1'), r.int(1, 100), r.pick([1, 2, 3, 4, 5]), r.chance(0.5)];
    };
    expect(seq()).toEqual(seq());
  });

  it('不同种子 → 序列不同', () => {
    const a = createEjsRng('save-1#7|条目A');
    const b = createEjsRng('save-1#8|条目A');
    const rollsA = Array.from({ length: 10 }, () => a.roll('1d1000'));
    const rollsB = Array.from({ length: 10 }, () => b.roll('1d1000'));
    expect(rollsA).not.toEqual(rollsB);
  });

  it('同回合不同条目互不相关（条目正文进种子）', () => {
    const a = createEjsRng('save-1#7|条目A');
    const b = createEjsRng('save-1#7|条目B');
    expect(Array.from({ length: 10 }, () => a.roll('1d1000'))).not.toEqual(
      Array.from({ length: 10 }, () => b.roll('1d1000')),
    );
  });
});

describe('createEjsRng · 值域', () => {
  const rng = () => createEjsRng('值域测试');

  it('roll：区间正确，不可解析取 0', () => {
    const r = rng();
    for (let i = 0; i < 200; i++) {
      const v = r.roll('2d6+1');
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(13);
    }
    expect(rng().roll('不是公式')).toBe(0);
    expect(rng().roll('')).toBe(0);
  });

  it('rollDetail：骰值条数与修正量对得上', () => {
    const d = rng().rollDetail('3d8-2');
    expect(d.骰值).toHaveLength(3);
    expect(d.修正).toBe(-2);
    expect(d.总计).toBe(d.骰值.reduce((a, b) => a + b, 0) - 2);
    for (const v of d.骰值) {
      expect(v).toBeGreaterThanOrEqual(1);
      expect(v).toBeLessThanOrEqual(8);
    }
  });

  it('int：闭区间；min>max 或非数 → 0', () => {
    const r = rng();
    for (let i = 0; i < 200; i++) {
      const v = r.int(3, 5);
      expect([3, 4, 5]).toContain(v);
    }
    expect(rng().int(5, 3)).toBe(0);
    expect(rng().int(NaN, 3)).toBe(0);
  });

  it('float ∈ [0,1)', () => {
    const r = rng();
    for (let i = 0; i < 200; i++) {
      const v = r.float();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('pick：空表 undefined；非数组 undefined', () => {
    expect(rng().pick([])).toBeUndefined();
    expect(rng().pick(undefined as unknown as unknown[])).toBeUndefined();
    expect(['a', 'b']).toContain(rng().pick(['a', 'b']));
  });

  it('pickN：不重复、数量夹紧、n 超长返回整份', () => {
    const items = [1, 2, 3, 4, 5];
    const got = rng().pickN(items, 3);
    expect(got).toHaveLength(3);
    expect(new Set(got).size).toBe(3);
    for (const v of got) expect(items).toContain(v);

    expect(rng().pickN(items, 99)).toHaveLength(5);
    expect(rng().pickN(items, 0)).toEqual([]);
    expect(rng().pickN(items, -3)).toEqual([]);
  });

  it('shuffle：不改原数组，元素集合不变', () => {
    const items = [1, 2, 3, 4, 5];
    const copy = items.slice();
    const shuffled = rng().shuffle(items);
    expect(items).toEqual(copy);
    expect(shuffled.slice().sort()).toEqual(copy.slice().sort());
  });

  it('chance：p 越界自动夹紧（0 恒假、1 恒真）', () => {
    const r = rng();
    for (let i = 0; i < 50; i++) {
      expect(r.chance(0)).toBe(false);
      expect(r.chance(-5)).toBe(false);
      expect(r.chance(1)).toBe(true);
      expect(r.chance(9)).toBe(true);
    }
    expect(rng().chance(NaN as unknown as number)).toBe(false);
  });

  it('chance(0.5) 大样本落在合理区间（不是恒真恒假）', () => {
    const r = createEjsRng('分布检查');
    let hits = 0;
    for (let i = 0; i < 2000; i++) if (r.chance(0.5)) hits++;
    expect(hits).toBeGreaterThan(800);
    expect(hits).toBeLessThan(1200);
  });
});
