/**
 * progress.test.ts — 导入进度条「永不倒退」判定
 *
 * 这层要钉住的是一条不变式: **渲染出来的比例永不下降**，而且在任何分母不作准的
 * 时刻都老实说"不知道"（转圈）而不是瞎画一个会往回抽的百分比。
 *
 * 三条到达"没有分母"的路径都在这里穷举，其中第三条（混合导入）是最新加的 ——
 * 它与解压段的区别在于 `phase` 已经是 `'write'`、`done` 还从上一批的累计值接着走，
 * 所以只认相位的实现会在这里翻车。纯归约器，无 Vue、无 store，node 环境即可跑。
 */

import { describe, it, expect } from 'vitest';
import { createProgressTracker, type ProgressState } from './progress';

/** 把一串观测喂进去，收集每一步的渲染结论 */
function run(seq: readonly (readonly [number, number])[]): ProgressState[] {
  const t = createProgressTracker();
  return seq.map(([done, total]) => ({ ...t.observe(done, total) }));
}

/** 渲染出来的比例序列（不确定态那几帧不参与渲染，但仍不许下降） */
function ratios(states: readonly ProgressState[]): number[] {
  return states.map((s) => s.ratio);
}

function isNonDecreasing(xs: readonly number[]): boolean {
  return xs.every((x, i) => i === 0 || x >= xs[i - 1]);
}

describe('createProgressTracker — 有诚实分母时', () => {
  it('单批导入：分母固定、分子单增 → 一路是确定态，比例单调上升', () => {
    const states = run([
      [0, 0], // 起手归零
      [0, 4], // 写库段开始，分母已定
      [1, 4],
      [2, 4],
      [4, 4],
    ]);
    expect(states.map((s) => s.indeterminate)).toEqual([true, false, false, false, false]);
    expect(ratios(states)).toEqual([0, 0, 0.25, 0.5, 1]);
  });

  it('分子回退（分母没变）→ 退回不确定态，绝不把条往回抽', () => {
    const states = run([
      [0, 0],
      [3, 4],
      [1, 4], // 倒退
    ]);
    expect(states[1].indeterminate).toBe(false);
    expect(states[2].indeterminate).toBe(true);
    expect(states[2].ratio).toBe(0.75); // 高水位守住，没有回落
    expect(isNonDecreasing(ratios(states))).toBe(true);
  });

  it('比例夹在 0..1，分子越界也不会画出超长的条', () => {
    const states = run([
      [0, 0],
      [9, 4],
    ]);
    expect(states[1].ratio).toBe(1);
  });
});

describe('createProgressTracker — 三条「没有分母」的路径', () => {
  it('① 解压段：total 恒为 0 → 全程不确定', () => {
    const states = run([
      [0, 0],
      [1, 0],
      [7, 0],
      [23, 0],
    ]);
    expect(states.every((s) => s.indeterminate)).toBe(true);
  });

  it('② 分母会长（口径回退时的兜底）→ 比例被高水位压住，等它自己追上来才继续画', () => {
    const states = run([
      [0, 0],
      [1, 2], // 先给了个小分母 → 50%
      [2, 5], // 分母长大，新比例 40% 反而更低
      [3, 9],
      [9, 9], // 追过 50% 了，重新确定
    ]);
    expect(states.map((s) => s.indeterminate)).toEqual([true, false, true, true, false]);
    // 关键: 中间那两帧不是"清零重来"，高水位一直守着 50%
    expect(ratios(states)).toEqual([0, 0.5, 0.5, 0.5, 1]);
    expect(isNonDecreasing(ratios(states))).toBe(true);
  });

  it('③ 混合导入：phase 已是 write、done 从上一批累计值接着走，但 total 恒 0 → 仍是不确定', () => {
    // 这是最新加的第三条路径。store 在多半边导入时**故意**不给分母
    // （后面几批各有多少行要等各自规划完才知道），此时 done 从 base 起跳。
    const states = run([
      [0, 0], // importAny 起手
      [0, 0], // 第一半进入写库段，base=0 且不给分母
      [1, 0],
      [3, 0],
      [3, 0], // 第二半开始，base=3 接着走
      [5, 0],
      [8, 0],
    ]);
    expect(states.every((s) => s.indeterminate)).toBe(true);
    expect(ratios(states).every((r) => r === 0)).toBe(true);
  });

  it('③ 变体：先跑了一个有分母的单批，再被切进无分母的一批 → 后半段转圈而不是卡在旧比例', () => {
    const states = run([
      [0, 0],
      [2, 4], // 有分母，画到 50%
      [5, 0], // 分母没了
    ]);
    expect(states[1].indeterminate).toBe(false);
    expect(states[2].indeterminate).toBe(true);
    expect(isNonDecreasing(ratios(states))).toBe(true);
  });
});

describe('createProgressTracker — 复位', () => {
  it('(0, 0) 视为新一轮：高水位清零，上一轮的进度不会渗进来', () => {
    const t = createProgressTracker();
    t.observe(0, 4);
    t.observe(4, 4);
    expect(t.ratio).toBe(1);

    t.observe(0, 0); // 新一轮
    expect(t.ratio).toBe(0);

    const next = t.observe(1, 4);
    expect(next.indeterminate).toBe(false);
    expect(next.ratio).toBe(0.25); // 而不是被上一轮的 1 挡住
  });

  it('reset() 与 (0,0) 等价', () => {
    const t = createProgressTracker();
    t.observe(3, 4);
    t.reset();
    expect(t.ratio).toBe(0);
    expect(t.observe(1, 4).ratio).toBe(0.25);
  });

  it('两轮导入之间分母不同，也不会拿新分子去配旧刻度', () => {
    const t = createProgressTracker();
    t.observe(0, 10);
    t.observe(9, 10); // 90%
    t.observe(0, 0); // 新一轮
    const s = t.observe(1, 3);
    expect(s.indeterminate).toBe(false);
    expect(s.ratio).toBeCloseTo(1 / 3);
  });
});

describe('createProgressTracker — 不变式', () => {
  it('任意乱序观测下，渲染比例都不下降', () => {
    // 拿一串刻意别扭的观测（分母忽有忽无、分子来回跳）压一遍
    const seq: [number, number][] = [
      [0, 0],
      [1, 0],
      [2, 6],
      [1, 6],
      [4, 6],
      [4, 0],
      [9, 12],
      [3, 12],
      [12, 12],
      [5, 0],
    ];
    const states = run(seq);
    expect(isNonDecreasing(ratios(states))).toBe(true);
    // 没有分母的那几帧一律不确定
    seq.forEach(([, total], i) => {
      if (total <= 0) expect(states[i].indeterminate).toBe(true);
    });
  });
});
