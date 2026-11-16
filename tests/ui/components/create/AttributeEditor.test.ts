/**
 * AttributeEditor.vue — 五维属性 +/- 步进器测试
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { nextTick } from 'vue';
import { mount } from '@vue/test-utils';
import AttributeEditor from '../../../../src/ui/components/create/AttributeEditor.vue';

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

  it('非 editable 时数值位仍是 span，没有输入框', () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '力量', modelValue: 3, max: 6, remaining: 20 },
    });
    expect(wrapper.find('input').exists()).toBe(false);
    expect(wrapper.find('span.attr-value').text()).toBe('3');
  });

  it('editable 时渲染数字输入框，带含属性名的 aria-label', () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '体质', label: '', modelValue: 4, max: 6, remaining: 20, editable: true },
    });
    const input = wrapper.find('[data-test="value-input"]');
    expect(input.exists()).toBe(true);
    expect(input.attributes('type')).toBe('text');
    expect(input.attributes('inputmode')).toBe('numeric');
    expect(input.attributes('aria-label')).toContain('体质');
    expect((input.element as HTMLInputElement).value).toBe('4');
  });

  it('提交数字发 set 事件', async () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '智力', label: '', modelValue: 2, max: 6, remaining: 20, editable: true },
    });
    await wrapper.find('[data-test="value-input"]').setValue('5');
    expect(wrapper.emitted('set')?.[0]).toEqual(['智力', 5]);
  });

  it('被钳回原值（modelValue 不变）时输入框写回实际值', async () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '力量', label: '', modelValue: 6, max: 6, remaining: 0, editable: true },
    });
    const input = wrapper.find('[data-test="value-input"]');
    await input.setValue('9');
    expect(wrapper.emitted('set')?.[0]).toEqual(['力量', 9]);
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe('6');
  });

  it('空串或非数字不发 set，恢复原值', async () => {
    const wrapper = mount(AttributeEditor, {
      props: { attrKey: '精神', label: '', modelValue: 3, max: 6, remaining: 20, editable: true },
    });
    const input = wrapper.find('[data-test="value-input"]');
    await input.setValue('');
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe('3');
    await input.setValue('abc');
    await nextTick();
    expect((input.element as HTMLInputElement).value).toBe('3');
    expect(wrapper.emitted('set')).toBeUndefined();
  });
});
