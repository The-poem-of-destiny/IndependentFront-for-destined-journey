/**
 * CustomItemForm — 自定义物品消耗超出可用点数时就地提示（C-06）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { defineComponent, h } from 'vue';
import CustomItemForm from '../../../../src/ui/components/create/CustomItemForm.vue';

const AppModalStub = defineComponent({
  name: 'AppModal',
  props: { open: Boolean },
  setup(_props, { slots }) {
    return () => h('div', [slots.header?.(), slots.default?.(), slots.footer?.()]);
  },
});

function mountForm(props: Record<string, unknown>) {
  return mount(CustomItemForm, {
    props: { visible: true, ...props },
    global: { stubs: { AppModal: AppModalStub } },
  });
}

describe('CustomItemForm — 超支提示', () => {
  it('消耗未超出可用点数时不提示', () => {
    const wrapper = mountForm({ availablePoints: 50 });
    expect(wrapper.find('.overspend-hint').exists()).toBe(false);
  });

  it('★ 消耗超出可用点数时写出保存后超支多少', () => {
    const wrapper = mountForm({ availablePoints: 30 }); // 默认消耗 50
    expect(wrapper.find('.overspend-hint').text()).toContain('超支 20 点');
  });

  it('未提供可用点数时不提示', () => {
    const wrapper = mountForm({});
    expect(wrapper.find('.overspend-hint').exists()).toBe(false);
  });
});
