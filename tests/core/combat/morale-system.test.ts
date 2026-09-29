/**
 * morale-system.ts 测试
 * 覆盖: 阈值查询 / 战意状态判定 / 高阈值自动触发 / 低阈值d20检定 / 结果池 / 处决条件
 */
import { describe, it, expect } from 'vitest';
import {
  getMoraleThreshold,
  isAutoTriggerType,
  isCheckTriggerType,
  checkMorale,
  pickRandomOutcome,
} from '../../../src/core/combat/morale-system';

// ========== 阈值查询 ==========

describe('getMoraleThreshold', () => {
  it('切磋 → 40%', () => {
    expect(getMoraleThreshold('切磋')).toBe(0.4);
  });

  it('竞技 → 30%', () => {
    expect(getMoraleThreshold('竞技')).toBe(0.3);
  });

  it('压制 → 50%', () => {
    expect(getMoraleThreshold('压制')).toBe(0.5);
  });

  it('死斗 → 10%', () => {
    expect(getMoraleThreshold('死斗')).toBe(0.1);
  });

  it('标准 → 30%', () => {
    expect(getMoraleThreshold('标准')).toBe(0.3);
  });

  it('守卫 → 35%', () => {
    expect(getMoraleThreshold('守卫')).toBe(0.35);
  });
});

// ========== 触发类型判定 ==========

describe('isAutoTriggerType', () => {
  it('切磋/竞技/压制 → 自动触发', () => {
    expect(isAutoTriggerType('切磋')).toBe(true);
    expect(isAutoTriggerType('竞技')).toBe(true);
    expect(isAutoTriggerType('压制')).toBe(true);
  });

  it('死斗/标准/守卫 → 非自动', () => {
    expect(isAutoTriggerType('死斗')).toBe(false);
    expect(isAutoTriggerType('标准')).toBe(false);
    expect(isAutoTriggerType('守卫')).toBe(false);
  });
});

describe('isCheckTriggerType', () => {
  it('死斗/标准/守卫 → 需要检定', () => {
    expect(isCheckTriggerType('死斗')).toBe(true);
    expect(isCheckTriggerType('标准')).toBe(true);
    expect(isCheckTriggerType('守卫')).toBe(true);
  });

  it('切磋/竞技/压制 → 不需要检定', () => {
    expect(isCheckTriggerType('切磋')).toBe(false);
    expect(isCheckTriggerType('竞技')).toBe(false);
    expect(isCheckTriggerType('压制')).toBe(false);
  });
});

// ========== 完整士气检测 ==========

describe('checkMorale', () => {
  // --- HP 高于阈值 ---
  it('HP 高于阈值 → 不触发', () => {
    const result = checkMorale(0.5, '切磋'); // 50% > 40%
    expect(result.triggered).toBe(false);
    expect(result.triggerType).toBe('none');
    expect(result.moraleState).toBe('steady');
    expect(result.narrative).toContain('战意坚定');
  });

  it('HP 等于阈值 → 触发 (刚好低于或等于)', () => {
    // checkMorale: hpRatio > threshold → steady; hpRatio <= threshold → triggered
    const result = checkMorale(0.4, '切磋'); // 40% = threshold → 触发
    // Actually 40% is NOT > 40%, so trigger
    expect(result.triggered).toBe(true);
  });

  // --- 高阈值类型：自动触发 ---
  it('切磋 HP=35% → 自动触发 wavering', () => {
    const result = checkMorale(0.35, '切磋');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
    expect(result.moraleState).toBe('wavering');
    expect(result.outcome).toBeTruthy();
  });

  it('竞技 HP=25% → 自动触发 wavering', () => {
    const result = checkMorale(0.25, '竞技');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
    expect(result.moraleState).toBe('wavering');
  });

  it('压制 HP=40% → 自动触发 wavering', () => {
    const result = checkMorale(0.4, '压制');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
    expect(result.moraleState).toBe('wavering');
  });

  it('切磋 HP=8% → 自动触发 routing', () => {
    // 0.08 ≤ 0.40*0.25=0.10 → routing
    const result = checkMorale(0.08, '切磋');
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('auto');
    expect(result.moraleState).toBe('routing');
  });

  // --- 低阈值类型：d20 检定 ---
  it('死斗 HP=8% → d20=5 < 12 → routing', () => {
    const result = checkMorale(0.08, '死斗', 5);
    expect(result.triggered).toBe(true);
    expect(result.triggerType).toBe('check');
    expect(result.moraleState).toBe('routing');
    expect(result.checkRoll).toBeDefined();
    expect(result.checkRoll!.d20Roll).toBe(5);
    expect(result.checkRoll!.target).toBe(12);
    expect(result.checkRoll!.passed).toBe(true);
    expect(result.outcome).toBeTruthy();
  });

  it('死斗 HP=8% → d20=15 ≥ 12 → shaken (未崩溃)', () => {
    const result = checkMorale(0.08, '死斗', 15);
    expect(result.triggered).toBe(false);
    expect(result.triggerType).toBe('check');
    expect(result.moraleState).toBe('shaken');
    expect(result.checkRoll!.passed).toBe(false);
    expect(result.outcome).toBeUndefined();
  });

  it('标准 HP=25% → d20=11 < 12 → routing', () => {
    const result = checkMorale(0.25, '标准', 11);
    expect(result.triggered).toBe(true);
    expect(result.moraleState).toBe('routing');
  });

  it('守卫 HP=30% → d20=12 ≥ 12 → shaken', () => {
    const result = checkMorale(0.3, '守卫', 12);
    expect(result.triggered).toBe(false);
    expect(result.moraleState).toBe('shaken');
  });

  it('标准 HP=50% > 阈值30% → 不触发', () => {
    const result = checkMorale(0.5, '标准');
    expect(result.triggered).toBe(false);
    expect(result.triggerType).toBe('none');
    expect(result.moraleState).toBe('steady');
  });

  // --- 死斗特殊: 阈值仅10% ---
  it('死斗 HP=15% > 阈值10% → 不触发', () => {
    const result = checkMorale(0.15, '死斗');
    expect(result.triggered).toBe(false);
    expect(result.triggerType).toBe('none');
    expect(result.moraleState).toBe('steady');
  });
});

// ========== 结果池 ==========

describe('pickRandomOutcome', () => {
  it('steady → 空结果池 → 默认', () => {
    expect(pickRandomOutcome('steady', 0)).toBe('坚守阵地');
  });

  it('wavering seed=0 → 第1个结果', () => {
    const outcome = pickRandomOutcome('wavering', 0);
    expect(outcome).toBe('投降');
  });

  it('wavering seed=1 → 第2个结果', () => {
    const outcome = pickRandomOutcome('wavering', 1);
    expect(outcome).toBe('认输');
  });

  it('routing seed=0 → 第1个结果', () => {
    expect(pickRandomOutcome('routing', 0)).toBe('溃逃');
  });

  it('routing seed=3 → 第4个结果', () => {
    expect(pickRandomOutcome('routing', 3)).toBe('被俘虏');
  });

  it('seed 取模循环', () => {
    const pool = ['溃逃', '阵线溃散', '被击昏', '被俘虏', '内讧', '投降', '求饶'];
    expect(pickRandomOutcome('routing', pool.length)).toBe(pool[0]);
  });
});
