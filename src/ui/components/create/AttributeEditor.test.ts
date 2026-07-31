/**
 * AttributeEditor.vue — 五维属性 +/- 步进器测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import AttributeEditor from './AttributeEditor.vue';

describe('AttributeEditor', () => {
  it('渲染属性名和当前值', () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '力量', modelValue: 5, max: 6, remaining: 20 },
    });
    expect(wrapper.text()).toContain('5');
  });

  it('点击 + 按钮触发 inc 事件并传递 attrKey', async () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '力量', modelValue: 3, max: 6, remaining: 20 },
    });
    const incBtn = wrapper.find('[data-test="inc-btn"]');
    expect(incBtn.exists()).toBe(true);
    await incBtn.trigger('click');
    expect(wrapper.emitted('inc')?.[0]).toEqual(['力量']);
  });

  it('点击 - 按钮触发 dec 事件并传递 attrKey', async () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '敏捷', label: '敏捷', modelValue: 3, max: 6, remaining: 20 },
    });
    const decBtn = wrapper.find('[data-test="dec-btn"]');
    expect(decBtn.exists()).toBe(true);
    await decBtn.trigger('click');
    expect(wrapper.emitted('dec')?.[0]).toEqual(['敏捷']);
  });

  it('remaining=0 时 + 按钮应 disabled', () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '力量', modelValue: 3, max: 6, remaining: 0 },
    });
    const incBtn = wrapper.find('[data-test="inc-btn"]');
    expect(incBtn.attributes('disabled')).toBeDefined();
  });

  it('值达到 max 时 + 按钮应 disabled', () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '力量', modelValue: 6, max: 6, remaining: 20 },
    });
    const incBtn = wrapper.find('[data-test="inc-btn"]');
    expect(incBtn.attributes('disabled')).toBeDefined();
  });

  it('值为 0 时 - 按钮应 disabled', () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '力量', modelValue: 0, max: 6, remaining: 20 },
    });
    const decBtn = wrapper.find('[data-test="dec-btn"]');
    expect(decBtn.attributes('disabled')).toBeDefined();
  });
});
