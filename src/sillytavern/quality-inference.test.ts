/**
 * quality-inference 专项测试（Q-11）
 *
 * 这条规则此前住在两个 Vue 组件里、零测试。抽下来的同时把「行为等价」钉住：
 * 阈值、绝对值语义、以及**封顶在传说**这三件事都各有断言 —— 尤其最后一条，
 * 它是刻意的规则边界而不是漏写，没有测试的话下一个人会顺手「补全」到唯一。
 */
import { describe, it, expect } from 'vitest';
import { INFERRED_QUALITY_CAP, inferQualityFromStats } from './quality-inference';
import { QUALITY_RANK } from './types';

describe('inferQualityFromStats', () => {
  it('缺 stats / 空表 → 普通', () => {
    expect(inferQualityFromStats(undefined)).toBe('普通');
    expect(inferQualityFromStats({})).toBe('普通');
  });

  it('四档阈值（50/30/20/10）逐档命中', () => {
    expect(inferQualityFromStats({ a: 50 })).toBe('传说');
    expect(inferQualityFromStats({ a: 30 })).toBe('史诗');
    expect(inferQualityFromStats({ a: 20 })).toBe('稀有');
    expect(inferQualityFromStats({ a: 10 })).toBe('优良');
    expect(inferQualityFromStats({ a: 9 })).toBe('普通');
  });

  it('边界值取「大于等于」，差 1 就掉档', () => {
    expect(inferQualityFromStats({ a: 49 })).toBe('史诗');
    expect(inferQualityFromStats({ a: 29 })).toBe('稀有');
    expect(inferQualityFromStats({ a: 19 })).toBe('优良');
  });

  it('多条属性求和', () => {
    expect(inferQualityFromStats({ str: 12, dex: 12, con: 8 })).toBe('史诗');
  });

  it('负数按绝对值计 —— 诅咒装备也是有分量的东西，不该被算成普通', () => {
    expect(inferQualityFromStats({ str: -30 })).toBe('史诗');
    // 20 + |-20| = 40 → 史诗。若按代数和会是 0 → 普通，这一条正是在钉住「取绝对值」
    expect(inferQualityFromStats({ str: 20, luck: -20 })).toBe('史诗');
    expect(inferQualityFromStats({ str: 25, luck: -25 })).toBe('传说');
  });

  it('非数值 / NaN / Infinity 当 0，不把整条推断带崩', () => {
    expect(inferQualityFromStats({ a: NaN, b: 30 })).toBe('史诗');
    expect(inferQualityFromStats({ a: Infinity, b: 10 })).toBe('优良');
    expect(inferQualityFromStats({ a: 'x' as unknown as number, b: 30 })).toBe('史诗');
  });

  it('🔴 封顶在「传说」是规则边界，不是漏写 —— 属性堆再高也推不出神话/唯一', () => {
    expect(inferQualityFromStats({ a: 9999 })).toBe('传说');
    expect(INFERRED_QUALITY_CAP).toBe('传说');
    // 用 rank 表达这条约束，将来品质集合扩容时这行仍然说得通
    expect(QUALITY_RANK[INFERRED_QUALITY_CAP]).toBeLessThan(QUALITY_RANK['神话']);
  });
});
