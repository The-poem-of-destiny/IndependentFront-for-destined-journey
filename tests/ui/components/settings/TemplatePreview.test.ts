/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import TemplatePreview from '../../../../src/ui/components/settings/TemplatePreview.vue';

describe('TemplatePreview — 资料选择器专用占位符', () => {
  it('识别 LORE_CATALOG 并说明专用装配范围及无正文边界', () => {
    const wrapper = mount(TemplatePreview, {
      props: { template: '{{LORE_CATALOG}}', agentId: 'lore_select' },
    });
    expect(wrapper.get('.badge-text').text()).toBe('{{LORE_CATALOG}}');
    const label = wrapper.get('.badge-label').text();
    expect(label).toContain('lore_select / Story v2 专用装配');
    expect(label).toContain('当前情境与目录元数据');
    expect(label).toContain('不含条目正文');
    expect(wrapper.text()).not.toContain('未注册占位符');
    expect(wrapper.get('.template-badge').attributes('style')).toContain('--color-success');
    wrapper.unmount();
  });

  it('重复出现时保留周边文本，真正未知的占位符仍提示未注册', () => {
    const wrapper = mount(TemplatePreview, {
      props: { template: '前{{LORE_CATALOG}}中{{LORE_CATALOG}}后{{UNKNOWN_KEY}}' },
    });
    expect(wrapper.findAll('.template-text').map((node) => node.text())).toEqual([
      '前',
      '中',
      '后',
    ]);
    const labels = wrapper.findAll('.badge-label').map((node) => node.text());
    expect(labels).toHaveLength(3);
    expect(labels[0]).toBe(labels[1]);
    expect(labels[2]).toBe('(未注册占位符)');
    wrapper.unmount();
  });

  it('模板更新后重新识别，隐藏说明不影响徽章', async () => {
    const wrapper = mount(TemplatePreview, { props: { template: '{{UNKNOWN_KEY}}' } });
    await wrapper.setProps({ template: '{{LORE_CATALOG}}' });
    expect(wrapper.get('.badge-label').text()).toContain('资料选择上下文');
    await wrapper.setProps({ showLabels: false });
    expect(wrapper.find('.badge-label').exists()).toBe(false);
    expect(wrapper.get('.badge-text').text()).toBe('{{LORE_CATALOG}}');
    wrapper.unmount();
  });
});
