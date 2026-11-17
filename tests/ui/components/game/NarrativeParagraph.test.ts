/**
 * NarrativeParagraph — 带特效层呈现的正文段落
 *
 * 守的是：根恒为 `<p>`、textContent 恒等于正文；plain 档与 `<p>{{ text }}</p>` 的 DOM 相同；
 * 流式档到期后并回单个文本节点；名字区间包成下划线 span。
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import NarrativeParagraph from '../../../../src/ui/components/game/NarrativeParagraph.vue';
import paragraphSource from '../../../../src/ui/components/game/NarrativeParagraph.vue?raw';
import { createRevealMemory } from '../../../../src/ui/lib/narrative-reveal';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance', 'Date'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('NarrativeParagraph', () => {
  it('plain 档：与裸 <p> 输出相同（单个文本节点，无属性）', () => {
    const wrapper = mount(NarrativeParagraph, { props: { text: '  前导空格也保留' } });
    expect(wrapper.element.outerHTML).toBe('<p>  前导空格也保留</p>');
    expect(wrapper.element.childNodes).toHaveLength(1);
  });

  it('stream 档：切成展示性 span，到期后并回单个文本节点', async () => {
    const wrapper = mount(NarrativeParagraph, {
      props: { text: 'one two', mode: 'stream', memory: createRevealMemory(), memoryKey: 'k' },
    });
    const chunks = wrapper.findAll('.fx-ink-chunk');
    expect(chunks.length).toBe(2);
    expect(chunks.every((chunk) => chunk.attributes('role') === 'presentation')).toBe(true);
    expect(wrapper.element.textContent).toBe('one two');

    vi.advanceTimersByTime(1000);
    await nextTick();
    expect(wrapper.html()).toBe('<p>one two</p>');
  });

  it('ink 档：整段挂浮现类与交错序号，不逐词', () => {
    const wrapper = mount(NarrativeParagraph, { props: { text: '整段', mode: 'ink', order: 3 } });
    expect(wrapper.classes()).toContain('fx-ink-para');
    expect(wrapper.attributes('style')).toContain('--fx-ink-order: 3');
    expect(wrapper.findAll('span')).toHaveLength(0);
  });

  it('名字区间包成下划线 span，文本不变', () => {
    const wrapper = mount(NarrativeParagraph, {
      props: { text: '他见到艾琳娜。', marks: [{ start: 3, end: 6 }] },
    });
    expect(wrapper.find('.fx-first-name').text()).toBe('艾琳娜');
    expect(wrapper.element.textContent).toBe('他见到艾琳娜。');
  });

  it('默认插槽接在段末，不改变文字', () => {
    const wrapper = mount(NarrativeParagraph, {
      props: { text: '收尾' },
      slots: { default: '<svg class="probe"></svg>' },
    });
    expect(wrapper.find('svg.probe').exists()).toBe(true);
    expect(wrapper.element.textContent).toBe('收尾');
  });

  it('样式：模糊只给流式 chunk；整段 / 整块浮现只动 opacity（不逐帧重栅格化 iframe 与卡片）', () => {
    const css = paragraphSource.slice(paragraphSource.indexOf('<style>'));
    /** 从起始标记截到第一个右花括号（@keyframes 取到 from 块为止，足够判断属性） */
    const blockAfter = (marker: string) => {
      const at = css.indexOf(marker);
      expect(at).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at) + 1);
    };
    expect(blockAfter('@keyframes fx-ink-bleed')).toContain('blur');
    expect(blockAfter('@keyframes fx-ink-fade')).not.toMatch(/filter|blur/);
    expect(blockAfter(":root[data-fx='on'] .fx-ink-chunk {")).toContain('fx-ink-bleed');
    const paraBlock = blockAfter(":root[data-fx='on'] .fx-ink-para,");
    expect(paraBlock).toContain('.fx-ink-block');
    expect(paraBlock).toContain('fx-ink-fade');
    expect(paraBlock).not.toContain('fx-ink-bleed');
  });
});
