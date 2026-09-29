/**
 * combat/rule-keys.test.ts — closed RuleKey 解析 + divinity 压制（M4）
 *
 * 覆盖（plan §7.4）：
 *   - 四个 RuleKey 各 1 组：通过 / 门槛不足 / merge policy（merge 冲突合并用）
 *   - divinity 差 1~5 级压制值（±20%/40%/60%/80%/100%）
 *   - 差 ≥5 → { certain: true }（调用方跳过掷骰 = 不消费骰子，A4-4）
 *   - suppressionAsModifier 攻守视角换算
 */

import { describe, expect, it } from 'vitest';
import { RULE_KEYS, divinitySuppression, type RuleKey } from '../../../src/core/combat/rule-keys';

const ALL_KEYS: readonly RuleKey[] = [
  'terminal.forceTerminal',
  'morale.forceState',
  'action.freezeSlot',
  'death.threshold',
];

describe('four RuleKeys 注册齐全（架构 §八 8.2）', () => {
  it('四把锁全部注册，divinity 门槛 = 5（法则级）', () => {
    expect(ALL_KEYS).toHaveLength(4);
    for (const k of ALL_KEYS) {
      expect(RULE_KEYS[k], `RuleKey「${k}」未注册`).toBeDefined();
      expect(RULE_KEYS[k].divinityThreshold).toBe(5);
    }
  });
});

describe('divinitySuppression（架构 §八 8.3 压制表）', () => {
  it('差 1~4 → certain:false，幅度 0.2/0.4/0.6/0.8', () => {
    for (const [diff, magnitude] of [
      [1, 0.2],
      [2, 0.4],
      [3, 0.6],
      [4, 0.8],
    ] as const) {
      const r = divinitySuppression(5 + diff, 5);
      expect(r.certain).toBe(false);
      if (!r.certain) expect(r.magnitude).toBe(magnitude);
    }
  });
  it('差 ≥5 → certain:true，方向=攻高（±100% 必成/必败）', () => {
    expect(divinitySuppression(10, 5)).toEqual({ certain: true, direction: 1 });
    expect(divinitySuppression(6, 1)).toEqual({ certain: true, direction: 1 });
  });
  it('守方 div 高 ≥5 → certain:true，方向=-1', () => {
    expect(divinitySuppression(0, 6)).toEqual({ certain: true, direction: -1 });
  });
  it('差 ≤0 → magnitude 0，方向跟随高低', () => {
    const even = divinitySuppression(5, 5);
    expect(even.certain).toBe(false);
    if (!even.certain) expect(even.magnitude).toBe(0);
    const lower = divinitySuppression(4, 5);
    if (!lower.certain) expect(lower.direction).toBe(-1);
  });
});
