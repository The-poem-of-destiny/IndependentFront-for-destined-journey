/**
 * combat-v3/automata/interpreter.test.ts — 表达式解释器测试（M3, 验收 A3-2）
 *
 * 覆盖（plan §5.8）：
 *   - 算术 / 比较 / 逻辑 / 一元
 *   - 除零返回 0（不抛）
 *   - 内建函数 min / max / floor / ceil / abs / percent / has
 *   - 未定义 ctx 路径抛 ExprEvalError（automaton 整批 reject 的错误隔离入口）
 */

import { describe, it, expect } from 'vitest';
import { parseExpression } from './parser';
import { evaluate, ExprEvalError, windowCtxRoots } from './interpreter';
import type { WindowCtx, WindowKey } from '../types';

/** 一个 damage.preview 的测试 ctx（PlanCtx 三档伤害 + self/target） */
const previewCtx: WindowCtx<'damage.preview'> = {
  self: {
    id: '理查德',
    hp: 22069,
    maxHp: 30079,
    hpPercent: 22069 / 30079,
    mp: 52500,
    sp: 38500,
    tier: 5,
    divinity: 5,
    statuses: [],
  },
  target: {
    id: '处刑人',
    hp: 2800,
    maxHp: 2800,
    hpPercent: 1,
    mp: 1000,
    sp: 1200,
    tier: 4,
    divinity: 0,
    statuses: ['昏迷'],
  },
  damage: {
    attackerId: '理查德',
    targetId: '处刑人',
    preReduction: 2400,
    postStep6: 1200,
    final: 487,
    type: '物理',
    rating: '有效',
  },
  round: { index: 1, phase: 'SlotConsume' },
  charges: { remaining: 3 },
};

function run(src: string, ctx: WindowKeyWide = previewCtx): number | string | boolean {
  return evaluate(parseExpression(src) as never, ctx as never);
}

// 宽化 ctx 类型供测试直接传对象
type WindowKeyWide = WindowCtx<WindowKey>;

describe('interpreter — 算术', () => {
  it('四则运算', () => {
    expect(run('1 + 2 * 3')).toBe(7);
    expect(run('(1 + 2) * 3')).toBe(9);
    expect(run('100 / 4')).toBe(25);
    expect(run('10 - 3 - 2')).toBe(5);
  });
  it('除零返回 0（不抛）', () => {
    expect(run('ctx.damage.final / 0')).toBe(0);
  });
  it('一元负号', () => {
    expect(run('-5 + 10')).toBe(5);
    expect(run('-ctx.damage.final')).toBe(-487);
  });
});

describe('interpreter — 比较', () => {
  it('数值比较', () => {
    expect(run('ctx.damage.final > 400')).toBe(true);
    expect(run('ctx.damage.final < 400')).toBe(false);
    expect(run('ctx.damage.final >= 487')).toBe(true);
    expect(run('ctx.damage.final <= 486')).toBe(false);
  });
  it('相等 / 不等', () => {
    expect(run("ctx.damage.type == '物理'")).toBe(true);
    expect(run("ctx.damage.type != '物理'")).toBe(false);
    expect(run('ctx.self.divinity == 5')).toBe(true);
  });
});

describe('interpreter — 逻辑与 一元 !', () => {
  it('and / or / not', () => {
    expect(run('ctx.self.hp > 10000 && ctx.target.hp < 3000')).toBe(true);
    expect(run('ctx.self.hp < 10000 || ctx.target.hp < 3000')).toBe(true);
    expect(run('!(ctx.self.hp > 10000)')).toBe(false);
  });
  it('短路不触发未定义路径', () => {
    // ctx.self.hp > 0 为真 → || 短路，右侧 ctx.nonexist 不求值（不抛）
    expect(run('ctx.self.hp > 0 || ctx.nonexist.x > 1')).toBe(true);
  });
});

describe('interpreter — 内建函数', () => {
  it('min / max', () => {
    expect(run('min(3, 1, 2)')).toBe(1);
    expect(run('max(3, 1, 2)')).toBe(3);
  });
  it('floor / ceil / abs', () => {
    expect(run('floor(3.7)')).toBe(3);
    expect(run('ceil(3.1)')).toBe(4);
    expect(run('abs(-9)')).toBe(9);
  });
  it('percent(a, b) = a*b/100', () => {
    expect(run('percent(30, 100)')).toBe(30);
    expect(run('percent(ctx.damage.preReduction, 50)')).toBe(1200);
  });
  it('has(list, x)', () => {
    expect(run("has(ctx.target.statuses, '昏迷')")).toBe(true);
    expect(run("has(ctx.target.statuses, '灼烧')")).toBe(false);
  });
  it('ctx 路径运算', () => {
    expect(run('ctx.damage.preReduction * 0.3')).toBeCloseTo(720);
  });
});

describe('interpreter — 未定义 ctx 路径', () => {
  it('抛 ExprEvalError 带路径', () => {
    expect(() => run('ctx.self.nonexistent > 1')).toThrowError(ExprEvalError);
    try {
      run('ctx.foo.bar == 1');
      expect.unreachable('应抛 ExprEvalError');
    } catch (e) {
      expect(e).toBeInstanceOf(ExprEvalError);
      const err = e as ExprEvalError;
      expect(err.message).toContain('foo');
    }
  });
  it('type 可用性错误（如对 string 求值算术）也抛', () => {
    // ctx.round.phase 是字符串，做 < 不抛（toNumber 强制），但访问其子字段会抛
    expect(() => run('ctx.round.phase.length > 2')).toThrowError(ExprEvalError);
  });
});

describe('interpreter — window 根段白名单', () => {
  it('windowCtxRoots 暴露每窗口可访问根段', () => {
    expect(windowCtxRoots('damage.preview')).toEqual(
      expect.arrayContaining(['self', 'target', 'damage', 'round', 'charges']),
    );
    expect(windowCtxRoots('collect_attacker_mods')).toEqual(
      expect.arrayContaining(['self', 'target']),
    );
  });
});
