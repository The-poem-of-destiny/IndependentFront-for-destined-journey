/**
 * ResourceBar.vue — HP/MP/SP 资源条测试
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import ResourceBar from '../../../../src/ui/components/shared/ResourceBar.vue';
import { syncFxGate, useFxEnabled } from '../../../../src/ui/lib/fx-gate';

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

  it('特效关闭时上涨：不进入 is-rising、不渲染波峰（保持 v1 行为）', async () => {
    const wrapper = mount(ResourceBar, {
      props: { label: 'HP', current: 40, max: 100 },
    });
    await wrapper.setProps({ current: 90 });
    expect(wrapper.find('.res-track').classes()).not.toContain('is-rising');
    expect(wrapper.find('.res-crest').exists()).toBe(false);
    expect(wrapper.find('.res-fill').attributes('style')).toContain('translateX(-10%)');
  });

  describe('特效开启（治疗上涨）', () => {
    beforeEach(() => {
      document.documentElement.setAttribute('data-fx', 'on');
    });
    afterEach(() => {
      document.documentElement.removeAttribute('data-fx');
      // 让共享镜像跟回 DOM，免得污染后续用例
      useFxEnabled();
    });

    it('上涨时进入 is-rising，并在填充前沿渲染一次性波峰', async () => {
      const wrapper = mount(ResourceBar, {
        props: { label: 'HP', current: 40, max: 100 },
      });
      expect(wrapper.find('.res-crest').exists()).toBe(false);

      await wrapper.setProps({ current: 70 });
      expect(wrapper.find('.res-track').classes()).toContain('is-rising');
      expect(wrapper.find('.res-track').classes()).not.toContain('is-draining');
      // 波峰住在填充层里，随填充一起平移
      expect(wrapper.find('.res-fill .res-crest').exists()).toBe(true);
      // 残影与填充指向同一个目标 —— 只是先后到达
      expect(wrapper.find('.res-ghost').attributes('style')).toContain('translateX(-30%)');
      expect(wrapper.find('.res-fill').attributes('style')).toContain('translateX(-30%)');
    });

    it('连续上涨各自重挂波峰（重播一次）', async () => {
      const wrapper = mount(ResourceBar, {
        props: { label: 'HP', current: 10, max: 100 },
      });
      await wrapper.setProps({ current: 30 });
      const first = wrapper.find('.res-crest').element;
      await wrapper.setProps({ current: 60 });
      expect(wrapper.find('.res-crest').element).not.toBe(first);
    });

    it('运行中闸门关闭：不等下一次数值变化就摘掉 is-rising 与波峰，再开闸也不重播', async () => {
      syncFxGate(true);
      const wrapper = mount(ResourceBar, {
        props: { label: 'HP', current: 40, max: 100 },
      });
      await wrapper.setProps({ current: 70 });
      expect(wrapper.find('.res-track').classes()).toContain('is-rising');
      expect(wrapper.find('.res-crest').exists()).toBe(true);

      syncFxGate(false);
      await nextTick();
      expect(wrapper.find('.res-track').classes()).not.toContain('is-rising');
      expect(wrapper.find('.res-crest').exists()).toBe(false);
      expect(wrapper.find('.res-fill').attributes('style')).toContain('translateX(-30%)');

      syncFxGate(true);
      await nextTick();
      expect(wrapper.find('.res-track').classes()).not.toContain('is-rising');
      expect(wrapper.find('.res-crest').exists()).toBe(false);
      syncFxGate(false);
    });

    it('下降时退出 is-rising、摘掉波峰，残影态照旧', async () => {
      const wrapper = mount(ResourceBar, {
        props: { label: 'HP', current: 40, max: 100 },
      });
      await wrapper.setProps({ current: 80 });
      await wrapper.setProps({ current: 20 });
      const track = wrapper.find('.res-track');
      expect(track.classes()).not.toContain('is-rising');
      expect(track.classes()).toContain('is-draining');
      expect(wrapper.find('.res-crest').exists()).toBe(false);
    });
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
