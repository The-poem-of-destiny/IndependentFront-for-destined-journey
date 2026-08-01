/**
 * combat-v3/projection-agent.test.ts — 投影 B：文本面板（M2）
 *
 * 验收对应（plan §4.9）：
 *   - 文本面板从唯一 CombatView 取数（单位 HP/状态/先攻序列/FP）
 *   - 格式与 combat-panel 一致（<action_info> 风格）
 */

import { describe, expect, it } from 'vitest';
import { projectToAgent } from './projection-agent';
import { toView } from './state';
import { createCombatState } from './state';
import { mkBundle } from './test-utils';
import type { CombatState } from './types';

describe('projectToAgent：从唯一 CombatView 取数', () => {
  it('输出 <action_info> 面板，含回合/单位 HP%/先攻序列/FP', () => {
    const bundle = mkBundle();
    const state = createCombatState(bundle);
    const view = toView(state);
    const panel = projectToAgent(view);

    expect(panel).toContain('<action_info>');
    expect(panel).toContain('{战况总览}');
    expect(panel).toContain('回合: 1');
    expect(panel).toContain('甲');
    expect(panel).toContain('乙');
    expect(panel).toContain('HP 500/500');
    // 先攻序列 + FP
    expect(panel).toContain('{行动顺序}');
    expect(panel).toContain('FP: 1000');
  });

  it('输出带状态与战意详情', () => {
    const bundle = mkBundle();
    const state = createCombatState(bundle);
    // 给甲注入一个 buff + 战意
    const withBuff: CombatState = {
      ...state,
      units: {
        ...state.units,
        甲: {
          ...state.units['甲'],
          morale: 'routing',
          statusEffects: [
            {
              name: '流血',
              description: '持续掉血',
              category: '减益' as const,
              stacks: 1,
              remainingTime: 2,
              timeUnit: '回合' as const,
              source: '[减益]-[测试]',
              effects: {},
            },
          ],
        },
      },
    };
    const view = toView(withBuff);
    const panel = projectToAgent(view);
    expect(panel).toContain('状态: 流血');
    expect(panel).toContain('战意: routing');
  });
});
