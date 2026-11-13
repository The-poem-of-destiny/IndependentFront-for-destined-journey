/**
 * CreateFooter — 下一步被禁用时的缺项提示与跳转
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import CreateFooter from '../../../../src/ui/components/create/CreateFooter.vue';

const blocked = {
  prefix: '开始旅程前还需补全：',
  currentStep: 7,
  items: [
    { label: '难度', step: 0 },
    { label: '命定核心', step: 2 },
  ],
};

describe('CreateFooter', () => {
  it('其他步骤的缺项渲染为跳转按钮，点击发出 jump', async () => {
    const wrapper = mount(CreateFooter, { props: { canNext: false, blocked } });
    expect(wrapper.find('.blocked-hint').text()).toBe('开始旅程前还需补全：难度、命定核心');
    const links = wrapper.findAll('.blocked-link');
    expect(links).toHaveLength(2);
    await links[1].trigger('click');
    expect(wrapper.emitted('jump')).toEqual([[2]]);
  });

  it('当前步骤自己的缺项不给跳转', () => {
    const wrapper = mount(CreateFooter, {
      props: { canNext: false, blocked: { ...blocked, currentStep: 0 } },
    });
    expect(wrapper.findAll('.blocked-link')).toHaveLength(1);
  });

  it('下一步可用时不显示提示', () => {
    const wrapper = mount(CreateFooter, { props: { canNext: true, blocked } });
    expect(wrapper.find('.blocked-hint').exists()).toBe(false);
  });
});
