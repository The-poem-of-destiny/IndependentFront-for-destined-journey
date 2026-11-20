/**
 * CombatMessageFlow.test.ts — 战斗中栏对话流
 *
 * 守的是：AI 正文的面板（`<action_info>` 包裹的与不包裹的裸 `{标题}` + 竖线表）都交给
 * ActionPanel 渲染、叙事仍是段落；流式中半截残标签不漏出；顶部「战况总览」由权威状态现算、
 * 默认展开。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import type { CombatState } from '@engine/combat/sandbox/types';
import type { CombatFlowEntry } from '../../../../../src/ui/stores/game-store';
import CombatMessageFlow from '../../../../../src/ui/components/game/combat/CombatMessageFlow.vue';

function assistant(text: string, round = 1): CombatFlowEntry {
  return { id: `a-${round}-${text.length}`, round, text, role: 'assistant' } as CombatFlowEntry;
}

function state(): CombatState {
  return {
    meta: { actionOrder: ['莱恩', '林狼'] },
    units: {
      林狼: { name: '林狼', hp: 26, maxHp: 60, mp: 0, maxMp: 0, sp: 10, maxSp: 10, pos: 5 },
      莱恩: { name: '莱恩', hp: 90, maxHp: 100, mp: 20, maxMp: 20, sp: 128, maxSp: 140, pos: 2 },
    },
  } as unknown as CombatState;
}

describe('CombatMessageFlow', () => {
  it('裸 {标题} + 竖线表（无外层标签）也渲染成 ActionPanel，叙事是段落', () => {
    const text = [
      '莱恩踏前一步。',
      '{莱恩 -> 林狼 · 斩击}',
      '| 结果: 命中 |',
      '| 林狼 HP: 60 → 26 |',
      '林狼哀鸣。',
    ].join('\n');
    const w = mount(CombatMessageFlow, { props: { state: null, flow: [assistant(text)] } });
    const panels = w.findAll('.action-panel-card');
    expect(panels).toHaveLength(1);
    expect(panels[0].find('.ap-title-text').text()).toContain('林狼 · 斩击');
    expect(panels[0].find('.ap-title-arrow').text()).toBe('→');
    expect(w.findAll('.narr').map((n) => n.text())).toEqual(['莱恩踏前一步。', '林狼哀鸣。']);
  });

  it('<action_info> 包裹的面板同样走 ActionPanel', () => {
    const w = mount(CombatMessageFlow, {
      props: {
        state: null,
        flow: [assistant('挥剑。<action_info>| 检定: 17\n| 伤害: 620</action_info>')],
      },
    });
    expect(w.find('.action-panel-card').text()).toContain('620');
    expect(w.text()).not.toContain('action_info');
  });

  it('流式预览：结尾半截残标签不漏出', () => {
    const w = mount(CombatMessageFlow, {
      props: { state: null, flow: [], stream: '刀光一闪。<action_inf' },
    });
    expect(w.find('.narr').text()).toBe('刀光一闪。');
  });

  it('战况总览：按行动顺序列出单位，默认展开', () => {
    const w = mount(CombatMessageFlow, { props: { state: state(), flow: [] } });
    const overview = w.find('.combat-overview');
    expect(overview.exists()).toBe(true);
    expect(overview.find('.ap-title-text').text()).toBe('战况总览');
    expect((overview.find('details').element as HTMLDetailsElement).open).toBe(true);
    expect(overview.findAll('.ap-k').map((k) => k.text())).toEqual(['莱恩', '林狼']);
    expect(overview.text()).toContain('HP 26/60');
  });

  it('没有状态时不画战况总览', () => {
    const w = mount(CombatMessageFlow, { props: { state: null, flow: [] } });
    expect(w.find('.combat-overview').exists()).toBe(false);
  });
});
