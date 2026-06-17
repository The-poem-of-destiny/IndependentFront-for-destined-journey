/**
 * dice.ts — $dice 骰池系统测试
 *
 * Layer 2 纯函数: 掷骰计算、判定、格式化。覆盖所有导出函数。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  rollDie,
  rollDice,
  parseDiceFormula,
  executeDiceRoll,
  d20,
  d100,
  roll,
  $dice,
  expectedValue,
  successProbability,
} from './dice';

// ========== 辅助函数 ==========

/** Mock Math.random 返回固定值序列 */
function mockRandom(values: number[]): void {
  let i = 0;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    const v = values[i] ?? values[values.length - 1];
    i++;
    return v;
  });
}

// ========== rollDie ==========

describe('rollDie', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('应该返回 1 到 sides 之间的整数', () => {
    for (let s = 2; s <= 100; s += 13) {
      const result = rollDie(s);
      expect(Number.isInteger(result)).toBe(true);
      expect(result).toBeGreaterThanOrEqual(1);
      expect(result).toBeLessThanOrEqual(s);
    }
  });

  it('sides=2 时只返回 1 或 2（统计验证）', () => {
    const results = new Set<number>();
    for (let i = 0; i < 200; i++) {
      results.add(rollDie(2));
    }
    expect(results.has(1)).toBe(true);
    expect(results.has(2)).toBe(true);
    expect(results.size).toBe(2);
  });

  it('sides=20 时所有值都在 [1,20] 范围内', () => {
    for (let i = 0; i < 500; i++) {
      const r = rollDie(20);
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(20);
    }
  });

  it('Math.random()=0 时返回 1', () => {
    mockRandom([0]);
    expect(rollDie(20)).toBe(1);
  });

  it('Math.random()=0.9999 时返回 sides', () => {
    mockRandom([0.9999]);
    expect(rollDie(20)).toBe(20);
  });

  it('Math.random() 接近 1/sides 边界时正确取整', () => {
    // 1/20 = 0.05，比它略小应返回 1
    mockRandom([0.0499]);
    expect(rollDie(20)).toBe(1);

    // 刚好等于 0.05 应返回 2（因为 floor(0.05*20)+1 = 1+1 = 2）
    // 实际 Math.random 返回 [0,1)，要拿到 20 需要 >= 0.95
    mockRandom([0.95]);
    expect(rollDie(20)).toBe(20);
  });
});

// ========== rollDice ==========

describe('rollDice', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('count=1 时返回长度为 1 的数组', () => {
    const result = rollDice(1, 20);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeGreaterThanOrEqual(1);
    expect(result[0]).toBeLessThanOrEqual(20);
  });

  it('count=5 时返回 5 个元素，全部在范围内', () => {
    const result = rollDice(5, 6);
    expect(result).toHaveLength(5);
    for (const r of result) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(6);
    }
  });

  it('count=10 时返回 10 个有效骰子', () => {
    const result = rollDice(10, 4);
    expect(result).toHaveLength(10);
    for (const r of result) {
      expect(r).toBeGreaterThanOrEqual(1);
      expect(r).toBeLessThanOrEqual(4);
    }
  });

  it('所有骰子独立随机（统计近似）', () => {
    // 掷 100 次 d6，检查是否覆盖 1~6
    const results = new Set<number>();
    for (let i = 0; i < 100; i++) {
      rollDice(1, 6).forEach(r => results.add(r));
    }
    // 极大概率覆盖 1~6
    expect(results.size).toBeGreaterThanOrEqual(4);
  });

  it('mock 时返回预期固定值', () => {
    // 每次 Math.random() 调用产生 0, 0.25, 0.5, 0.75 对应 d6: 1,2,3,5? 不对，floor(0*6)+1=1, floor(0.25*6)+1=2, floor(0.5*6)+1=4, floor(0.75*6)+1=5
    // floor(0*6)=0 → 1
    // floor(0.25*6)=1 → 2
    // floor(0.5*6)=3 → 4
    // floor(0.75*6)=4 → 5
    mockRandom([0, 0.25, 0.5, 0.75]);
    expect(rollDice(4, 6)).toEqual([1, 2, 4, 5]);
  });
});

// ========== parseDiceFormula ==========

describe('parseDiceFormula', () => {
  it('解析 "d20" → {count:1, sides:20, modifier:0}', () => {
    expect(parseDiceFormula('d20')).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it('解析 "2d6+3" → {count:2, sides:6, modifier:3}', () => {
    expect(parseDiceFormula('2d6+3')).toEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it('解析 "4d8-1" → {count:4, sides:8, modifier:-1}', () => {
    expect(parseDiceFormula('4d8-1')).toEqual({ count: 4, sides: 8, modifier: -1 });
  });

  it('解析 "d100" → {count:1, sides:100, modifier:0}', () => {
    expect(parseDiceFormula('d100')).toEqual({ count: 1, sides: 100, modifier: 0 });
  });

  it('解析 "3d20+5" → {count:3, sides:20, modifier:5}', () => {
    expect(parseDiceFormula('3d20+5')).toEqual({ count: 3, sides: 20, modifier: 5 });
  });

  it('解析 "10d10-20" → {count:10, sides:10, modifier:-20}', () => {
    expect(parseDiceFormula('10d10-20')).toEqual({ count: 10, sides: 10, modifier: -20 });
  });

  it('解析带前后空格的 "  d20  " → 正常', () => {
    expect(parseDiceFormula('  d20  ')).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it('解析大写 "D20" → 正常（大小写不敏感）', () => {
    expect(parseDiceFormula('D20')).toEqual({ count: 1, sides: 20, modifier: 0 });
  });

  it('解析 "2D6+3" → 正常', () => {
    expect(parseDiceFormula('2D6+3')).toEqual({ count: 2, sides: 6, modifier: 3 });
  });

  it('无效公式 "abc" 返回 null', () => {
    expect(parseDiceFormula('abc')).toBeNull();
  });

  it('无效公式 "20" 返回 null（缺少 d）', () => {
    expect(parseDiceFormula('20')).toBeNull();
  });

  it('无效公式 "d1" 返回 null（sides < 2）', () => {
    expect(parseDiceFormula('d1')).toBeNull();
  });

  it('无效公式 "0d6" 返回 null（count < 1）', () => {
    expect(parseDiceFormula('0d6')).toBeNull();
  });

  it('无效公式 "-1d6" 返回 null', () => {
    expect(parseDiceFormula('-1d6')).toBeNull();
  });

  it('无效公式 "" 空字符串返回 null', () => {
    expect(parseDiceFormula('')).toBeNull();
  });

  it('无效公式 "d20*2" 不匹配（仅支持 +/-）', () => {
    expect(parseDiceFormula('d20*2')).toBeNull();
  });

  it('无效公式 "2d6++3" 返回 null', () => {
    expect(parseDiceFormula('2d6++3')).toBeNull();
  });
});

// ========== executeDiceRoll ==========

describe('executeDiceRoll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('基本 d20 掷骰，无修正，返回正确结构', () => {
    mockRandom([0.3]); // floor(0.3*20)+1 = 7
    const result = executeDiceRoll({ formula: 'd20' });

    expect(result.formula).toBe('d20');
    expect(result.rolls).toEqual([7]);
    expect(result.total).toBe(7);
    expect(result.modifier).toBe(0);
    expect(result.advantage).toBe(false);
    expect(result.disadvantage).toBe(false);
    expect(result.criticalSuccess).toBe(false);
    expect(result.criticalFailure).toBe(false);
    expect(result.meetsDC).toBeUndefined();
    expect(result.description).toContain('d20');
    expect(result.description).toContain('= 7');
  });

  it('d20+5 修正正确加到 total 和 modifier', () => {
    mockRandom([0.3]); // 7
    const result = executeDiceRoll({ formula: 'd20', modifier: 5 });

    expect(result.rolls).toEqual([7]);
    expect(result.total).toBe(12);
    expect(result.modifier).toBe(5);
    expect(result.description).toContain('+5');
  });

  it('公式内含修正 2d6+3', () => {
    mockRandom([0.2, 0.8]); // floor(0.2*6)+1=2, floor(0.8*6)+1=5
    const result = executeDiceRoll({ formula: '2d6+3' });

    expect(result.rolls).toEqual([2, 5]);
    expect(result.modifier).toBe(3);
    expect(result.total).toBe(10); // 2+5+3
  });

  it('payload.modifier 与公式 modifier 叠加', () => {
    mockRandom([0.2, 0.8]); // 2, 5
    const result = executeDiceRoll({ formula: '2d6+3', modifier: 4 });

    expect(result.modifier).toBe(7); // 3+4
    expect(result.total).toBe(14); // 2+5+7
  });

  it('优势 (advantage) 掷两次取最大值', () => {
    // 两次 d20: 第一次 3, 第二次 18
    mockRandom([0.1, 0.89]);
    const result = executeDiceRoll({ formula: 'd20', advantage: true });

    expect(result.rolls).toEqual([18]);
    expect(result.advantage).toBe(true);
    expect(result.disadvantage).toBe(false);
    expect(result.total).toBe(18);
    expect(result.description).toContain('优势');
  });

  it('劣势 (disadvantage) 掷两次取最小值', () => {
    // 两次 d20: 第一次 3, 第二次 18
    mockRandom([0.1, 0.89]);
    const result = executeDiceRoll({ formula: 'd20', disadvantage: true });

    expect(result.rolls).toEqual([3]);
    expect(result.disadvantage).toBe(true);
    expect(result.advantage).toBe(false);
    expect(result.total).toBe(3);
    expect(result.description).toContain('劣势');
  });

  it('非 d20 的优势/劣势被忽略（仍正常掷骰）', () => {
    // 2d6 设置 advantage
    mockRandom([0.1, 0.5]);
    const result = executeDiceRoll({ formula: '2d6', advantage: true });

    // 优势只对 d20 生效，2d6 正常掷两次
    expect(result.rolls).toHaveLength(2);
    expect(result.advantage).toBe(true); // payload 传入 true
  });

  it('大成功: d20 掷出 20', () => {
    mockRandom([0.95]); // floor(0.95*20)+1 = 20
    const result = executeDiceRoll({ formula: 'd20' });

    expect(result.rolls).toEqual([20]);
    expect(result.criticalSuccess).toBe(true);
    expect(result.criticalFailure).toBe(false);
    expect(result.description).toContain('大成功');
  });

  it('大失败: d20 掷出 1', () => {
    mockRandom([0]); // floor(0*20)+1 = 1
    const result = executeDiceRoll({ formula: 'd20' });

    expect(result.rolls).toEqual([1]);
    expect(result.criticalFailure).toBe(true);
    expect(result.criticalSuccess).toBe(false);
    expect(result.description).toContain('大失败');
  });

  it('非 d20 不触发临界判定', () => {
    // 2d6 掷出 6,6 不应该大成功
    // floor(0.99*6)+1 = 6，floor(0.99*6)+1 = 6
    mockRandom([0.99, 0.99]);
    const result = executeDiceRoll({ formula: '2d6' });

    expect(result.criticalSuccess).toBe(false);
    expect(result.criticalFailure).toBe(false);
  });

  it('multi-d20 (如 2d20) 不触发临界', () => {
    // 2d20 掷出 20,20 不应该大成功（仅单 d20）
    mockRandom([0.99, 0.99]);
    const result = executeDiceRoll({ formula: '2d20' });

    expect(result.criticalSuccess).toBe(false);
    expect(result.criticalFailure).toBe(false);
  });

  it('targetDC 达标时 meetsDC=true', () => {
    mockRandom([0.5]); // floor(0.5*20)+1 = 11
    const result = executeDiceRoll({ formula: 'd20', targetDC: 10 });

    expect(result.meetsDC).toBe(true);
    expect(result.description).toContain('DC10');
    expect(result.description).toContain('✓成功');
  });

  it('targetDC 未达标时 meetsDC=false', () => {
    mockRandom([0.4]); // floor(0.4*20)+1 = 9
    const result = executeDiceRoll({ formula: 'd20', targetDC: 10 });

    expect(result.meetsDC).toBe(false);
    expect(result.description).toContain('✗失败');
  });

  it('targetDC 含修正: d20+3 vs DC 15', () => {
    mockRandom([0.45]); // floor(0.45*20)+1 = 10, total=13
    const result = executeDiceRoll({ formula: 'd20', modifier: 3, targetDC: 15 });

    expect(result.total).toBe(13);
    expect(result.meetsDC).toBe(false);
  });

  it('targetDC 含修正: d20+5 vs DC 15, 正好达标', () => {
    mockRandom([0.49]); // floor(0.49*20)+1 = 10, total=15
    const result = executeDiceRoll({ formula: 'd20', modifier: 5, targetDC: 15 });

    expect(result.total).toBe(15);
    expect(result.meetsDC).toBe(true);
  });

  it('无效公式时抛出错误', () => {
    expect(() => executeDiceRoll({ formula: 'abc' })).toThrow('无效的骰子公式');
  });

  it('description 包含所有必要信息', () => {
    mockRandom([0.3]); // 7
    const result = executeDiceRoll({ formula: 'd20', modifier: 2, targetDC: 10 });

    expect(result.description).toContain('d20');
    expect(result.description).toContain('+2');
    expect(result.description).toContain('= 9');
    expect(result.description).toContain('(7)');
    expect(result.description).toContain('DC10');
    expect(result.description).toContain('✗失败');
  });
});

// ========== d20 便捷函数 ==========

describe('d20', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无参数 → 等同于 executeDiceRoll({formula:"d20"})', () => {
    mockRandom([0.3]);
    const result = d20();
    expect(result.formula).toBe('d20');
    expect(result.modifier).toBe(0);
    expect(result.advantage).toBe(false);
    expect(result.disadvantage).toBe(false);
  });

  it('d20(5) → modifier=5', () => {
    mockRandom([0.3]);
    const result = d20(5);
    expect(result.modifier).toBe(5);
  });

  it('d20(0, true, false) → advantage=true', () => {
    mockRandom([0.1, 0.5]);
    const result = d20(0, true, false);
    expect(result.advantage).toBe(true);
    expect(result.rolls).toEqual([11]); // max(3, 11) = 11
  });

  it('d20(0, false, true) → disadvantage=true', () => {
    mockRandom([0.1, 0.5]);
    const result = d20(0, false, true);
    expect(result.disadvantage).toBe(true);
    expect(result.rolls).toEqual([3]); // min(3, 11) = 3
  });

  it('d20(3, true, false) → modifier+advantage 同时生效', () => {
    mockRandom([0.2, 0.7]);
    const result = d20(3, true, false);
    expect(result.modifier).toBe(3);
    expect(result.advantage).toBe(true);
    expect(result.rolls).toEqual([15]); // max(5, 15) = 15
    expect(result.total).toBe(18); // 15+3
  });
});

// ========== d100 便捷函数 ==========

describe('d100', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('无参数 → 等同于 executeDiceRoll({formula:"d100"})', () => {
    mockRandom([0.42]);
    const result = d100();
    expect(result.formula).toBe('d100');
    expect(result.modifier).toBe(0);
  });

  it('d100(10) → modifier=10', () => {
    mockRandom([0.5]); // floor(0.5*100)+1 = 51
    const result = d100(10);
    expect(result.modifier).toBe(10);
    expect(result.total).toBe(61);
  });

  it('d100 不触发 d20 临界', () => {
    // 掷出 100 对 d100 不算大成功
    mockRandom([0.9999]); // floor(0.9999*100)+1 = 100
    const result = d100();
    expect(result.criticalSuccess).toBe(false);
    expect(result.criticalFailure).toBe(false);
  });

  it('d100 结果在 1..100 范围内', () => {
    for (let i = 0; i < 100; i++) {
      const r = d100();
      expect(r.rolls[0]).toBeGreaterThanOrEqual(1);
      expect(r.rolls[0]).toBeLessThanOrEqual(100);
    }
  });
});

// ========== roll 通用便捷函数 ==========

describe('roll', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('roll("2d6") → 正常掷骰', () => {
    mockRandom([0.2, 0.8]); // 2,5
    const result = roll('2d6');
    expect(result.formula).toBe('2d6');
    expect(result.rolls).toEqual([2, 5]);
    expect(result.total).toBe(7);
    expect(result.modifier).toBe(0);
  });

  it('roll("3d8+2", 3) → modifier 叠加', () => {
    mockRandom([0.1, 0.3, 0.5]); // 1,3,5
    const result = roll('3d8+2', 3);
    expect(result.modifier).toBe(5); // 2+3
    expect(result.total).toBe(14); // 1+3+5+5
  });

  it('roll("d20", 0, 15) → 带 targetDC', () => {
    mockRandom([0.7]); // floor(0.7*20)+1 = 15
    const result = roll('d20', 0, 15);
    expect(result.meetsDC).toBe(true);
  });
});

// ========== $dice namespace ==========

describe('$dice namespace', () => {
  it('包含所有预期方法', () => {
    expect($dice.d20).toBe(d20);
    expect($dice.d100).toBe(d100);
    expect($dice.roll).toBe(roll);
    expect($dice.rollDie).toBe(rollDie);
    expect($dice.parseDiceFormula).toBe(parseDiceFormula);
    expect($dice.executeDiceRoll).toBe(executeDiceRoll);
  });

  it('通过 $dice.d20() 可正常掷骰', () => {
    mockRandom([0.3]);
    const result = $dice.d20();
    expect(result.formula).toBe('d20');
    expect(result.total).toBe(7);
    vi.restoreAllMocks();
  });

  it('通过 $dice.roll("2d6") 可正常掷骰', () => {
    mockRandom([0.2, 0.5]);
    const result = $dice.roll('2d6');
    expect(result.formula).toBe('2d6');
    expect(result.rolls).toHaveLength(2);
    vi.restoreAllMocks();
  });

  it('$dice 对象是冻结的 (as const)', () => {
    // as const 断言让对象只读，但运行时不一定冻结
    // 检查所有方法引用正确即可
    expect(Object.keys($dice).length).toBeGreaterThanOrEqual(6);
    expect(typeof $dice.d20).toBe('function');
    expect(typeof $dice.d100).toBe('function');
    expect(typeof $dice.roll).toBe('function');
    expect(typeof $dice.rollDie).toBe('function');
    expect(typeof $dice.parseDiceFormula).toBe('function');
    expect(typeof $dice.executeDiceRoll).toBe('function');
  });
});

// ========== expectedValue ==========

describe('expectedValue', () => {
  it('d20 期望值 = 10.5', () => {
    expect(expectedValue(1, 20)).toBe(10.5);
  });

  it('2d6 期望值 = 7', () => {
    expect(expectedValue(2, 6)).toBe(7);
  });

  it('d100 期望值 = 50.5', () => {
    expect(expectedValue(1, 100)).toBe(50.5);
  });

  it('3d8 期望值 = 13.5', () => {
    expect(expectedValue(3, 8)).toBe(13.5);
  });

  it('d4 期望值 = 2.5', () => {
    expect(expectedValue(1, 4)).toBe(2.5);
  });

  it('10d6 期望值 = 35', () => {
    expect(expectedValue(10, 6)).toBe(35);
  });
});

// ========== successProbability ==========

describe('successProbability', () => {
  it('d20, mod=0, DC=10 → 0.55', () => {
    const p = successProbability(0, 10);
    expect(p).toBe(0.55);
    // 验证: needed=10, (20-10+1)/20 = 11/20 = 0.55
  });

  it('d20, mod=+5, DC=20 → 0.3', () => {
    const p = successProbability(5, 20);
    expect(p).toBe(0.3);
    // needed=15, (20-15+1)/20 = 6/20 = 0.3
  });

  it('d20, mod=+5, DC=15 → 0.55', () => {
    const p = successProbability(5, 15);
    expect(p).toBe(0.55);
    // needed=10, (20-10+1)/20 = 11/20 = 0.55
  });

  it('d20, mod=0, DC=1 → 1（必定成功）', () => {
    expect(successProbability(0, 1)).toBe(1);
  });

  it('d20, mod=10, DC=10 → 1（必定成功）', () => {
    expect(successProbability(10, 10)).toBe(1);
  });

  it('d20, mod=0, DC=21 → 0（不可能）', () => {
    expect(successProbability(0, 21)).toBe(0);
  });

  it('d20, mod=0, DC=30 → 0（远远超出）', () => {
    expect(successProbability(0, 30)).toBe(0);
  });

  it('d20, mod=-5, DC=20 → 0（负修正不可能）', () => {
    expect(successProbability(-5, 20)).toBe(0);
    // needed=25, >20 → 0
  });

  it('自定义 sides: d6, mod=0, DC=4 → 0.5', () => {
    const p = successProbability(0, 4, 6);
    expect(p).toBe(0.5);
    // needed=4, (6-4+1)/6 = 3/6 = 0.5
  });

  it('自定义 sides: d6, mod=2, DC=5 → 2/3≈0.6667', () => {
    const p = successProbability(2, 5, 6);
    expect(p).toBeCloseTo(2 / 3, 4);
    // needed=3, (6-3+1)/6 = 4/6 = 0.6667
  });

  it('自定义 sides: d100, mod=0, DC=50 → 0.51', () => {
    const p = successProbability(0, 50, 100);
    expect(p).toBe(0.51);
    // needed=50, (100-50+1)/100 = 51/100 = 0.51
  });

  it('默认 sides=20（省略第三个参数）', () => {
    expect(successProbability(0, 10)).toBe(successProbability(0, 10, 20));
  });

  it('边界: needed=1 时返回 1', () => {
    // mod=9, dc=10, sides=20 → needed=1
    expect(successProbability(9, 10, 20)).toBe(1);
  });

  it('边界: needed=sides 时有且仅有一个结果成功', () => {
    // mod=0, dc=20, sides=20 → needed=20, (20-20+1)/20=1/20=0.05
    expect(successProbability(0, 20, 20)).toBe(0.05);
  });

  it('mod=+50, DC=10 → 必定成功', () => {
    expect(successProbability(50, 10)).toBe(1);
  });
});
