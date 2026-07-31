/**
 * ResourceBar.vue — HP/MP/SP 资源条测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ResourceBar from '../shared/ResourceBar.vue';

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

  it('填充宽度 = current/max * 100%', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 75, max: 100 },
    });
    const fill = wrapper.find('.res-fill');
    expect(fill.attributes('style')).toContain('width: 75%');
  });

  it('current=0 时宽度 0%', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 0, max: 100 },
    });
    const fill = wrapper.find('.res-fill');
    expect(fill.attributes('style')).toContain('width: 0%');
  });

  it('max=0 时宽度 0% (避免除零)', () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 0, max: 0 },
    });
    const fill = wrapper.find('.res-fill');
    expect(fill.attributes('style')).toContain('width: 0%');
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
