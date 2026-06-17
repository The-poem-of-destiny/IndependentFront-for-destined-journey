/**
 * morale-system.ts 测试
 * 覆盖: 阈值查询 / 战意状态判定 / 高阈值自动触发 / 低阈值d20检定 / 结果池 / 处决条件
 */
import { describe, it, expect } from 'vitest';
import {
  getMoraleThreshold,
  isAutoTriggerType,
  isCheckTriggerType,
  getBaseMoraleState,
  getMoraleSeverity,
  checkMorale,
  pickRandomOutcome,
  getMoraleOutcomePool,
  getMoraleModifiers,
  canExecute,
  getExecutionModifiers,
  formatMoralePanel,
  checkAllMorale,
  AUTO_TRIGGER_TYPES,
  CHECK_TRIGGER_TYPES,
  type BatchMoraleResult,
} from './morale-system';
import type { CombatType, MoraleState } from './types';

// ========== 阈值查询 ==========

describe('getMoraleThreshold', () => {
  it('切磋 → 40%', () => {
    expect(getMoraleThreshold('切磋')).toBe(0.40);
  });

  it('竞技 → 30%', () => {
    expect(getMoraleThreshold('竞技')).toBe(0.30);
  });

  it('压制 → 50%', () => {
    expect(getMoraleThreshold('压制')).toBe(0.50);
  });

  it('死斗 → 10%', () => {
    expect(getMoraleThreshold('死斗')).toBe(0.10);
  });

  it('标准 → 30%', () => {
    expect(getMoraleThreshold('标准')).toBe(0.30);
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

describe('AUTO_TRIGGER_TYPES', () => {
  it('有 3 个高阈值类型', () => {
    expect(AUTO_TRIGGER_TYPES).toHaveLength(3);
    expect(AUTO_TRIGGER_TYPES).toContain('切磋');
    expect(AUTO_TRIGGER_TYPES).toContain('竞技');
    expect(AUTO_TRIGGER_TYPES).toContain('压制');
  });
});

describe('CHECK_TRIGGER_TYPES', () => {
  it('有 3 个低阈值类型', () => {
    expect(CHECK_TRIGGER_TYPES).toHaveLength(3);
    expect(CHECK_TRIGGER_TYPES).toContain('死斗');
    expect(CHECK_TRIGGER_TYPES).toContain('标准');
    expect(CHECK_TRIGGER_TYPES).toContain('守卫');
  });
});

// ========== 基础战意状态 ==========

describe('getBaseMoraleState', () => {
  it('HP > 阈值 → steady', () => {
    expect(getBaseMoraleState(0.5, 0.3)).toBe('steady');
    expect(getBaseMoraleState(0.31, 0.3)).toBe('steady');
  });

  it('阈值 ≥ HP > 阈值×50% → shaken', () => {
    expect(getBaseMoraleState(0.3, 0.3)).toBe('shaken');
    expect(getBaseMoraleState(0.2, 0.3)).toBe('shaken'); // 0.2 > 0.15
    expect(getBaseMoraleState(0.16, 0.3)).toBe('shaken'); // 0.16 > 0.15
  });

  it('阈值×50% ≥ HP > 阈值×25% → wavering', () => {
    expect(getBaseMoraleState(0.15, 0.3)).toBe('wavering'); // 0.15 = 0.3*0.5
    expect(getBaseMoraleState(0.1, 0.3)).toBe('wavering');  // 0.1 > 0.075
    expect(getBaseMoraleState(0.08, 0.3)).toBe('wavering'); // 0.08 > 0.075
  });

  it('HP ≤ 阈值×25% → routing', () => {
    expect(getBaseMoraleState(0.075, 0.3)).toBe('routing');
    expect(getBaseMoraleState(0.05, 0.3)).toBe('routing');
    expect(getBaseMoraleState(0.0, 0.3)).toBe('routing');
  });
});

describe('getMoraleSeverity', () => {
  it('steady → 0', () => expect(getMoraleSeverity('steady')).toBe(0));
  it('shaken → 1', () => expect(getMoraleSeverity('shaken')).toBe(1));
  it('wavering → 2', () => expect(getMoraleSeverity('wavering')).toBe(2));
  it('routing → 3', () => expect(getMoraleSeverity('routing')).toBe(3));
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
    const result = checkMorale(0.40, '切磋'); // 40% = threshold → 触发
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
    const result = checkMorale(0.40, '压制');
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
    const result = checkMorale(0.30, '守卫', 12);
    expect(result.triggered).toBe(false);
    expect(result.moraleState).toBe('shaken');
  });

  it('标准 HP=50% > 阈值30% → 不触发', () => {
    const result = checkMorale(0.50, '标准');
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
    const pool = getMoraleOutcomePool('routing');
    expect(pickRandomOutcome('routing', pool.length)).toBe(pool[0]);
  });
});

describe('getMoraleOutcomePool', () => {
  it('steady 结果池为空', () => {
    expect(getMoraleOutcomePool('steady')).toEqual([]);
  });

  it('shaken 有2个结果', () => {
    expect(getMoraleOutcomePool('shaken')).toHaveLength(2);
  });

  it('wavering 有5个结果', () => {
    expect(getMoraleOutcomePool('wavering')).toHaveLength(5);
  });

  it('routing 有7个结果', () => {
    expect(getMoraleOutcomePool('routing')).toHaveLength(7);
  });
});

// ========== 战意修正 ==========

describe('getMoraleModifiers', () => {
  it('steady → 无惩罚', () => {
    const mod = getMoraleModifiers('steady');
    expect(mod.attackPenalty).toBe(0);
    expect(mod.dodgeNegated).toBe(false);
    expect(mod.canAct).toBe(true);
    expect(mod.canBeExecuted).toBe(false);
  });

  it('shaken → 攻击-2', () => {
    const mod = getMoraleModifiers('shaken');
    expect(mod.attackPenalty).toBe(-2);
    expect(mod.dodgeNegated).toBe(false);
    expect(mod.canAct).toBe(true);
    expect(mod.canBeExecuted).toBe(false);
  });

  it('wavering → 攻击-4, 闪避无效, 无法行动, 可被处决', () => {
    const mod = getMoraleModifiers('wavering');
    expect(mod.attackPenalty).toBe(-4);
    expect(mod.dodgeNegated).toBe(true);
    expect(mod.canAct).toBe(false);
    expect(mod.canBeExecuted).toBe(true);
  });

  it('routing → 无法行动, 闪避无效, 可被处决', () => {
    const mod = getMoraleModifiers('routing');
    expect(mod.attackPenalty).toBe(-999);
    expect(mod.dodgeNegated).toBe(true);
    expect(mod.canAct).toBe(false);
    expect(mod.canBeExecuted).toBe(true);
  });
});

// ========== 处决条件 ==========

describe('canExecute', () => {
  it('wavering → 可处决', () => {
    expect(canExecute('wavering')).toBe(true);
  });

  it('routing → 可处决', () => {
    expect(canExecute('routing')).toBe(true);
  });

  it('steady → 不可处决', () => {
    expect(canExecute('steady')).toBe(false);
  });

  it('shaken → 不可处决', () => {
    expect(canExecute('shaken')).toBe(false);
  });
});

describe('getExecutionModifiers', () => {
  it('提供处决修正', () => {
    const mod = getExecutionModifiers();
    expect(mod.intentionAutoSuccess).toBe(true);
    expect(mod.dodgeNegated).toBe(true);
    expect(mod.minRatingCoefficient).toBe(1.3);
    expect(mod.narrativeNote).toContain('保底暴击');
  });
});

// ========== 面板格式化 ==========

describe('formatMoralePanel', () => {
  it('HP 高于阈值时生成未触发面板', () => {
    const panel = formatMoralePanel('哥布林A', 80, 100, 0.3, '标准');
    expect(panel).toContain('哥布林A');
    expect(panel).toContain('HP [80/100]');
    expect(panel).toContain('未触发');
  });

  it('低阈值 d20 检定面板', () => {
    const panel = formatMoralePanel('兽人战士', 20, 100, 0.3, '标准', 8);
    expect(panel).toContain('兽人战士');
    expect(panel).toContain('需要检定');
    expect(panel).toContain('d20=8 vs 12');
    expect(panel).toContain('崩溃');
  });

  it('高阈值自动触发面板', () => {
    const panel = formatMoralePanel('竞技场对手', 30, 100, 0.4, '切磋');
    expect(panel).toContain('无需检定');
    expect(panel).toContain('自动触发');
  });
});

// ========== 批量士气检测 ==========

describe('checkAllMorale', () => {
  it('对所有非user单位执行检测', () => {
    const participants = [
      { id: 'usr', name: '主角', hp: 100, maxHp: 100, isUser: true },
      { id: 'a1', name: '盟友A', hp: 80, maxHp: 100, isUser: false },
      { id: 'e1', name: '敌人A', hp: 15, maxHp: 100, isUser: false },
      { id: 'e2', name: '敌人B', hp: 8, maxHp: 100, isUser: false },
    ];

    const results = checkAllMorale(participants, '标准', [10, 10, 5, 8]);
    // 只检测非user: a1(e1,e2)
    // a1: HP 80% > 30% → 不触发
    // e1: HP 15% < 30%, d20=5 < 12 → routing ✓
    // e2: HP 8% < 30%, d20=8 < 12 → routing ✓
    expect(results).toHaveLength(2);
    expect(results[0].participantId).toBe('e1');
    expect(results[0].result.triggered).toBe(true);
    expect(results[0].result.moraleState).toBe('routing');
    expect(results[1].participantId).toBe('e2');
  });

  it('user 不会被检测', () => {
    const participants = [
      { id: 'usr', name: '主角', hp: 10, maxHp: 100, isUser: true },
    ];
    const results = checkAllMorale(participants, '死斗', [5]);
    expect(results).toHaveLength(0);
  });

  it('全部高于阈值 → 无触发', () => {
    const participants = [
      { id: 'e1', name: '敌人A', hp: 80, maxHp: 100, isUser: false },
      { id: 'e2', name: '敌人B', hp: 70, maxHp: 100, isUser: false },
    ];
    const results = checkAllMorale(participants, '压制', [10, 10]);
    expect(results).toHaveLength(0);
  });
});
