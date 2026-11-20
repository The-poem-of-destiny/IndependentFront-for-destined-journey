/**
 * ActionPanel — `<action_info>` 行动面板渲染
 *
 * 守的是：一个分节一个 `<details>` 且默认收起；标题条右侧 chip ≤3、结论格带 tone 类；
 * 空标题兜底「行动详情」；全程文本插值，原文里的标签按字面显示、绝不进 DOM。
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionPanel from '../../../../src/ui/components/game/ActionPanel.vue';
import { parseActionPanel } from '../../../../src/ui/lib/action-panel';

const COMBAT = `{战况总览}
| 回合: 1 | 先攻: 莱恩 18 > 灰刃 12 |
{莱恩 → 林狼 · 斩击}
| 检定: d20=15 +5 = 20 | 闪避: 13 | 结果: 命中 |
| 伤害: 42 物理 − 防御 8 = 34 |
| 林狼 HP: 60 → 26 |
| 莱恩 SP: 140 → 128 |
{反击}
| 结果: 未命中 |`;

describe('ActionPanel', () => {
  it('一个分节一个 details，默认全部收起，summary 可聚焦', () => {
    const w = mount(ActionPanel, { props: { raw: COMBAT } });
    const secs = w.findAll('details.ap-sec');
    expect(secs).toHaveLength(3);
    for (const s of secs) {
      expect(s.attributes('open')).toBeUndefined();
      expect(s.find('summary').exists()).toBe(true);
    }
  });

  it('分节色相类与 --accent-s', () => {
    const w = mount(ActionPanel, { props: { raw: COMBAT } });
    const secs = w.findAll('details.ap-sec');
    expect(secs[0].classes()).toContain('ap-hue-info');
    expect(secs[1].classes()).toContain('ap-hue-strike');
    expect(secs[1].attributes('style')).toContain('--accent-s: var(--theme-hue-strike)');
  });

  it('标题里的 → 单独成 muted 片段', () => {
    const w = mount(ActionPanel, { props: { raw: COMBAT } });
    const title = w.findAll('.ap-title-text')[1];
    expect(title.text()).toBe('莱恩 → 林狼 · 斩击');
    expect(title.find('.ap-title-arrow').text()).toBe('→');
  });

  it('chip ≤3，结论 chip 只显示结论并带 tone 类', () => {
    const w = mount(ActionPanel, { props: { raw: COMBAT } });
    const chips = w.findAll('details.ap-sec')[1].findAll('.ap-chip');
    expect(chips).toHaveLength(3);
    expect(chips[0].text()).toBe('命中');
    expect(chips[0].classes()).toContain('tone-success');
    expect(chips[1].text()).toBe('伤害 42 物理 − 防御 8 = 34');
    const miss = w.findAll('details.ap-sec')[2].find('.ap-chip');
    expect(miss.classes()).toContain('tone-error');
  });

  it('明细：结论格整格 tone，其余按 token 上色', () => {
    const w = mount(ActionPanel, { props: { raw: COMBAT } });
    const body = w.findAll('details.ap-sec')[1].find('.ap-body');
    expect(body.find('.ap-v.tone-success').text()).toBe('命中');
    expect(body.find('.hl-dice').text()).toBe('d20=15');
    expect(body.findAll('.hl-down').map((n) => n.text())).toContain('26');
    expect(body.find('.hl-arrow').text()).toBe('→');
  });

  it('无标题面板兜底显示「行动详情」', () => {
    const w = mount(ActionPanel, { props: { raw: '| 检定 | d20=12，成功 |' } });
    expect(w.find('.ap-title-text').text()).toBe('行动详情');
    expect(w.find('.ap-chip').classes()).toContain('tone-success');
  });

  it('散行备注占满一行、没有空标签格', () => {
    const w = mount(ActionPanel, { props: { raw: '{检定}\n| 掷骰: d20=9 |\n灰刃在侧翼牵制' } });
    expect(w.findAll('.ap-k')).toHaveLength(1);
    expect(w.find('.ap-v-wide').text()).toBe('灰刃在侧翼牵制');
  });

  it('也接受已解析的 panel', () => {
    const w = mount(ActionPanel, { props: { panel: parseActionPanel(COMBAT) } });
    expect(w.findAll('details.ap-sec')).toHaveLength(3);
  });

  it('空面板不渲染', () => {
    const w = mount(ActionPanel, { props: { raw: '  ' } });
    expect(w.find('.action-panel-card').exists()).toBe(false);
  });

  it('defaultOpen：全部分节初始展开（战况总览用）', () => {
    const w = mount(ActionPanel, { props: { raw: COMBAT, defaultOpen: true } });
    for (const s of w.findAll('details.ap-sec')) {
      expect((s.element as HTMLDetailsElement).open).toBe(true);
    }
  });

  it('不走 v-html：原文里的标签按字面显示', () => {
    const raw = '{<b>粗体</b>}\n| 结果: <script>alert(1)</script> |\n<img src=x onerror=alert(1)>';
    const w = mount(ActionPanel, { props: { raw } });
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    expect(w.find('b').exists()).toBe(false);
    expect(w.find('.ap-title-text').text()).toBe('<b>粗体</b>');
    expect(w.text()).toContain('<script>alert(1)</script>');
    expect(w.text()).toContain('<img src=x onerror=alert(1)>');
  });
});
