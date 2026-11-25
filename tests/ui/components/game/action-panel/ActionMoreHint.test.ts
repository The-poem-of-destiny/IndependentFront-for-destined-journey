/**
 * ActionMoreHint — 行动面板收起视图的展开提示（五种样式共用的那一处）
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import ActionMoreHint from '../../../../../src/ui/components/game/action-panel/ActionMoreHint.vue';

describe('ActionMoreHint', () => {
  it('收起时写「算式」，展开时写「收起」并挂 is-open', () => {
    const closed = mount(ActionMoreHint, { props: { open: false } });
    expect(closed.find('.more').text()).toBe('算式');
    expect(closed.find('.more').classes()).not.toContain('is-open');
    const opened = mount(ActionMoreHint, { props: { open: true } });
    expect(opened.find('.more').text()).toBe('收起');
    expect(opened.find('.more').classes()).toContain('is-open');
  });

  it('纯装饰：对读屏隐藏，带一个箭头', () => {
    const w = mount(ActionMoreHint, { props: { open: false } });
    expect(w.find('.more').attributes('aria-hidden')).toBe('true');
    expect(w.find('.more .more-caret').exists()).toBe(true);
  });
});
