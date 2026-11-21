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

describe('CustomItemForm — 保存到我的自定义库', () => {
  const custom = {
    id: 'custom_skill_aaaa0001',
    name: '自制火花',
    category: 'skill' as const,
    type: '主动',
    rarity: 'common' as const,
    tag: [],
    effect: {},
    description: '一点火花',
    cost: 10,
  };

  async function clickSave(wrapper: ReturnType<typeof mountForm>) {
    const btn = wrapper.findAll('button').find((b) => b.text() === '确认添加')!;
    await btn.trigger('click');
  }

  it('新建时默认不勾选，保存 emit toLibrary: false', async () => {
    const wrapper = mountForm({});
    const checkbox = wrapper.find('.library-checkbox');
    expect(checkbox.exists()).toBe(true);
    expect((checkbox.element as HTMLInputElement).checked).toBe(false);
    await wrapper.find('.form-input').setValue('新技能');
    await clickSave(wrapper);
    const saved = wrapper.emitted('save')?.[0];
    expect(saved?.[1]).toEqual({ toLibrary: false });
  });

  it('★ 勾选后保存 emit toLibrary: true', async () => {
    const wrapper = mountForm({});
    await wrapper.find('.form-input').setValue('新技能');
    await wrapper.find('.library-checkbox').setValue(true);
    await clickSave(wrapper);
    expect(wrapper.emitted('save')?.[0]?.[1]).toEqual({ toLibrary: true });
  });

  it('★ 编辑已在库中的条目：inLibrary 让勾选初始为真', async () => {
    const wrapper = mountForm({ editItem: custom, inLibrary: true });
    expect((wrapper.find('.library-checkbox').element as HTMLInputElement).checked).toBe(true);
    await clickSave(wrapper);
    const saved = wrapper.emitted('save')?.[0];
    expect(saved?.[0]).toMatchObject({ id: custom.id, name: custom.name });
    expect(saved?.[1]).toEqual({ toLibrary: true });
  });

  it('编辑不在库中的条目：勾选初始为假', () => {
    const wrapper = mountForm({ editItem: custom, inLibrary: false });
    expect((wrapper.find('.library-checkbox').element as HTMLInputElement).checked).toBe(false);
  });

  it('编辑目录条目（非 custom_ id）时不提供存库选项，emit toLibrary: false', async () => {
    const wrapper = mountForm({ editItem: { ...custom, id: 's_主动_火花' }, inLibrary: false });
    expect(wrapper.find('.library-checkbox').exists()).toBe(false);
    await clickSave(wrapper);
    expect(wrapper.emitted('save')?.[0]?.[1]).toEqual({ toLibrary: false });
  });
});
