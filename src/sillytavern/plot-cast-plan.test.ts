/**
 * 本轮角色计划（castPlan，设计 2026-09-12）纯函数 + 占位符 + pre 解析测试。
 */
import { describe, it, expect } from 'vitest';
import {
  parsePlotCastPlan,
  projectPlotCastPlan,
  findCastPlanEntry,
  formatPlotCastPlanLines,
} from './plot-threads';
import { PLACEHOLDER_REGISTRY } from './placeholder-registry';
import { parsePreCheckOutput } from './plot-engine';
import type { AgentContext } from './types';

function entry(over?: Record<string, unknown>) {
  return {
    ref: '奥古斯都家的使者',
    nodeRef: '旧王都的阴影',
    role: '陌生使者',
    behavior: '回避出身，对矿脉行情异常敏感',
    surface: '深灰斗篷，指尖有墨迹',
    nameConstraint: { mode: 'segment' as const, value: '奥古斯都' },
    secret: '其实是幕后主使',
    ...over,
  };
}

function callResolver(ctx: Partial<AgentContext>): string {
  const resolver = PLACEHOLDER_REGISTRY['PLOT_CAST_PLAN'];
  expect(resolver).toBeTruthy();
  return resolver(ctx as AgentContext, {} as never, {} as never);
}

describe('parsePlotCastPlan', () => {
  it('非数组 → 空数组', () => {
    expect(parsePlotCastPlan(undefined)).toEqual([]);
    expect(parsePlotCastPlan('x')).toEqual([]);
    expect(parsePlotCastPlan({})).toEqual([]);
  });

  it('无 ref 的坏条目逐条丢弃，不连坐', () => {
    const out = parsePlotCastPlan([{ role: '无主' }, entry(), 42, null]);
    expect(out).toHaveLength(1);
    expect(out[0].ref).toBe('奥古斯都家的使者');
  });

  it('同名 ref 去重（保留首条）', () => {
    const out = parsePlotCastPlan([entry({ role: '首' }), entry({ role: '次' })]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('首');
  });

  it('nameConstraint 归一化：未知 mode / 空 value → undefined', () => {
    expect(
      parsePlotCastPlan([entry({ nameConstraint: { mode: 'x', value: 'y' } })])[0].nameConstraint,
    ).toBeUndefined();
    expect(
      parsePlotCastPlan([entry({ nameConstraint: { mode: 'full', value: '  ' } })])[0]
        .nameConstraint,
    ).toBeUndefined();
    expect(
      parsePlotCastPlan([entry({ nameConstraint: { mode: 'full', value: ' 赵 ' } })])[0]
        .nameConstraint,
    ).toEqual({
      mode: 'full',
      value: '赵',
    });
  });

  it('secret 原样保留在结构里（由投影层负责外发边界）', () => {
    expect(parsePlotCastPlan([entry()])[0].secret).toBe('其实是幕后主使');
  });
});

describe('projectPlotCastPlan', () => {
  it('剥离 secret，只留安全面', () => {
    const [surface] = projectPlotCastPlan(parsePlotCastPlan([entry()]));
    expect(surface).not.toHaveProperty('secret');
    expect(surface.ref).toBe('奥古斯都家的使者');
    expect(surface.role).toBe('陌生使者');
    expect(surface.behavior).toContain('回避出身');
    expect(surface.nameConstraint).toEqual({ mode: 'segment', value: '奥古斯都' });
  });
});

describe('findCastPlanEntry', () => {
  it('精确 ref 命中（trim）；空/未命中 → undefined', () => {
    const plan = parsePlotCastPlan([entry()]);
    expect(findCastPlanEntry(plan, ' 奥古斯都家的使者 ')?.role).toBe('陌生使者');
    expect(findCastPlanEntry(plan, '另一个人')).toBeUndefined();
    expect(findCastPlanEntry(plan, undefined)).toBeUndefined();
    expect(findCastPlanEntry(undefined, 'x')).toBeUndefined();
  });
});

describe('formatPlotCastPlanLines', () => {
  it('空计划 → 空串', () => {
    expect(formatPlotCastPlanLines([])).toBe('');
  });
  it('含命名约束时给出对应措辞', () => {
    const lines = formatPlotCastPlanLines(projectPlotCastPlan(parsePlotCastPlan([entry()])));
    expect(lines).toContain('命名约束');
    expect(lines).toContain('奥古斯都');
    expect(lines).not.toContain('幕后主使');
  });
});

describe('{{PLOT_CAST_PLAN}} resolver', () => {
  it('有值 → <plot_cast_plan> 外壳', () => {
    const out = callResolver({ plotCastPlan: parsePlotCastPlan([entry()]) });
    expect(out).toContain('<plot_cast_plan>');
    expect(out).toContain('奥古斯都家的使者');
    expect(out).not.toContain('幕后主使');
  });
  it('空/缺席 → 空串零 token', () => {
    expect(callResolver({})).toBe('');
    expect(callResolver({ plotCastPlan: [] })).toBe('');
  });
});

describe('parsePreCheckOutput.castPlan', () => {
  it('缺字段 → 空数组（旧输出兼容）', () => {
    const r = parsePreCheckOutput(JSON.stringify({ triggeredEvents: [] }));
    expect(r?.castPlan).toEqual([]);
  });
  it('有字段 → 解析', () => {
    const r = parsePreCheckOutput(JSON.stringify({ triggeredEvents: [], castPlan: [entry()] }));
    expect(r?.castPlan).toHaveLength(1);
    expect(r?.castPlan[0].ref).toBe('奥古斯都家的使者');
  });
});
