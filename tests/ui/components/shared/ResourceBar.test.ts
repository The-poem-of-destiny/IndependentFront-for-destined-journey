/**
 * ResourceBar.vue — HP/MP/SP 资源条测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ResourceBar from '../../../../src/ui/components/shared/ResourceBar.vue';

describe('ResourceBar', () => {
  it('渲染 label 标签', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 150, max: 200 },
    });
    expect(wrapper.text()).toContain('HP');
  });

  it('渲染 current/max 数值', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 150, max: 200, showValues: true },
    });
    const valuesEl = wrapper.find('.res-values');
    expect(valuesEl.exists()).toBe(true);
    expect(valuesEl.text()).toContain('150');
    expect(valuesEl.text()).toContain('200');
  });

  it('showValues=false 时不显示数值', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 150, max: 200, showValues: false },
    });
    expect(wrapper.find('.res-values').exists()).toBe(false);
  });

  // 条宽用 translateX 表达（design.md §1 不过渡 width）：填充层整条宽、左移 (100 - 百分比)%
  it('填充位移 = current/max 对应的 translateX', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 75, max: 100 },
    });
    const fill = wrapper.find('.res-fill');
    expect(fill.attributes('style')).toContain('translateX(-25%)');
    expect(fill.attributes('style')).not.toContain('width');
  });

  it('current=0 时整条移出（-100%）', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 0, max: 100 },
    });
    const fill = wrapper.find('.res-fill');
    expect(fill.attributes('style')).toContain('translateX(-100%)');
  });

  it('max=0 时整条移出 (避免除零)', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 0, max: 0 },
    });
    const fill = wrapper.find('.res-fill');
    expect(fill.attributes('style')).toContain('translateX(-100%)');
  });

  it('数值下降时轨道进入残影态，回升时退出', async () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 80, max: 100 },
    });
    const track = () => wrapper.find('.res-track');
    expect(track().classes()).not.toContain('is-draining');

    await wrapper.setProps({ current: 50 });
    expect(track().classes()).toContain('is-draining');
    // 残影与填充指向同一个目标位置 —— 残影只是晚到，不是另一个数
    expect(wrapper.find('.res-ghost').attributes('style')).toContain('translateX(-50%)');

    await wrapper.setProps({ current: 90 });
    expect(track().classes()).not.toContain('is-draining');
  });

  it('使用自定义颜色', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'MP', current: 50, max: 100, color: '#3498db' },
    });
    const fill = wrapper.find('.res-fill');
    // jsdom 将 hex 转为 rgb
    expect(fill.attributes('style')).toMatch(/rgb\(52,\s*152,\s*219\)/);
  });

  it('自定义 height', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 50, max: 100, height: 20 },
    });
    const bar = wrapper.find('.resource-bar');
    expect(bar.attributes('style')).toContain('height: 20px');
  });
});
