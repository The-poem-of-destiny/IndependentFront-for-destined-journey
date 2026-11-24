/**
 * ActionPanelCalc — 行动面板展开体（算式分节）
 *
 * 守的是：一节一个 section，标题带色相点、空标题兜底「行动详情」；结论行 `is-result`、
 * 带结论色的行 `tone-*`；值按 token 着色；无标签散行跨两列、不出空标签格；全程文本插值。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionPanelCalc from '../../../../../src/ui/components/game/action-panel/ActionPanelCalc.vue';
import { EXCHANGE, viewOf } from './fixtures';

function mountCalc(raw: string) {
  return mount(ActionPanelCalc, { props: { sections: viewOf(raw).calc } });
}

describe('ActionPanelCalc', () => {
  it('分节标题、色相点与色相变量', () => {
    const w = mountCalc(`${EXCHANGE}\n{反击}\n| 结果: 未命中 |`);
    const secs = w.findAll('.calc-sec');
    expect(secs).toHaveLength(2);
    expect(secs[0].find('.calc-title').text()).toBe('出手 · 裂风斩');
    expect(secs[0].find('.calc-dot').exists()).toBe(true);
    expect(secs[0].attributes('style')).toContain('--calc-hue: var(--theme-hue-');
  });

  it('结论行加粗、结论色上到行上；值里的骰子 / 箭头 / 涨跌按 token 着色', () => {
    const w = mountCalc(EXCHANGE);
    const verdict = w.findAll('.calc-row').find((r) => r.find('.calc-k').text() === '判定')!;
    expect(verdict.classes()).toEqual(expect.arrayContaining(['is-result', 'tone-success']));
    const actor = w.findAll('.calc-row').find((r) => r.find('.calc-k').text() === '行动者')!;
    expect(actor.classes()).not.toContain('is-result');
    expect(w.find('.hl-dice').text()).toBe('d20=17');
    expect(w.find('.hl-arrow').text()).toBe('→');
  });

  it('空标题兜底「行动详情」', () => {
    const w = mountCalc('| 检定 | d20=12，成功 |');
    expect(w.find('.calc-title').text()).toBe('行动详情');
  });

  it('无标签的散行跨两列、没有空标签格', () => {
    const w = mountCalc('{检定}\n| 掷骰: d20=9 |\n灰刃在侧翼牵制');
    expect(w.findAll('.calc-k')).toHaveLength(1);
    const wide = w.find('.calc-row.is-wide');
    expect(wide.find('.calc-k').exists()).toBe(false);
    expect(wide.find('.calc-v').text()).toBe('灰刃在侧翼牵制');
  });

  it('不走 v-html：原文里的标签按字面显示', () => {
    const w = mountCalc('{<b>粗体</b>}\n| 结果: <script>alert(1)</script> |');
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('b').exists()).toBe(false);
    expect(w.find('.calc-title').text()).toBe('<b>粗体</b>');
    expect(w.text()).toContain('<script>alert(1)</script>');
  });
});
