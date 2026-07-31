/**
 * CreateSteps.vue — 8 步指示器测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CreateSteps from './CreateSteps.vue';

describe('CreateSteps', () => {
  it('渲染 8 个步骤按钮', () => {
    const wrapper = mount(CreateSteps, {
      props: { current: 0 },
    });
    const dots = wrapper.findAll('.step-dot');
    expect(dots).toHaveLength(8);
  });

  it('当前步骤有 active class', () => {
    const wrapper = mount(CreateSteps, {
      props: { current: 3 },
    });
    const dots = wrapper.findAll('.step-dot');
    expect(dots[3].classes()).toContain('active');
    expect(dots[0].classes()).not.toContain('active');
  });

  it('已完成步骤有 done class', () => {
    const wrapper = mount(CreateSteps, {
      props: { current: 3 },
    });
    const dots = wrapper.findAll('.step-dot');
    expect(dots[0].classes()).toContain('done');
    expect(dots[1].classes()).toContain('done');
    expect(dots[2].classes()).toContain('done');
    expect(dots[3].classes()).not.toContain('done');
  });

  it('步骤标签文本正确', () => {
    const wrapper = mount(CreateSteps, {
      props: { current: 0 },
    });
    const labels = wrapper.findAll('.step-label');
    expect(labels[0].text()).toBe('难度选择');
    expect(labels[6].text()).toBe('剧情规划');
    expect(labels[7].text()).toBe('确认提交');
  });
});
