/**
 * MessagesSection.vue — 行动面板样式下拉框接线
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, reactive } from 'vue';
import MessagesSection from '../../../../src/ui/components/settings/MessagesSection.vue';

const mockSettings: Record<string, any> = reactive({});
vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}));

beforeEach(() => {
  for (const k of Object.keys(mockSettings)) delete mockSettings[k];
  Object.assign(mockSettings, {
    stagedNarrative: true,
    systemEventsVisible: true,
    systemEventFilters: { craft: true },
  });
});

function styleSelect(wrapper: ReturnType<typeof mount>) {
  return wrapper.get('[data-testid="action-panel-style"] select');
}

describe('MessagesSection 行动面板样式', () => {
  it('列出五种样式，缺键时选中对决条', () => {
    const wrapper = mount(MessagesSection);
    expect(wrapper.text()).toContain('行动面板样式');
    const select = styleSelect(wrapper);
    expect(select.findAll('option').map((o) => o.text())).toEqual([
      '对决条',
      '血条残影',
      '战报行',
      '跳字舞台',
      '打出的牌',
    ]);
    expect((select.element as HTMLSelectElement).value).toBe('duel');
  });

  it('存了无效值时显示对决条', () => {
    mockSettings.actionPanelStyle = 'neon';
    const wrapper = mount(MessagesSection);
    expect((styleSelect(wrapper).element as HTMLSelectElement).value).toBe('duel');
  });

  it('切换下拉框写入设置袋，说明随之更新', async () => {
    const wrapper = mount(MessagesSection);
    await styleSelect(wrapper).setValue('battlelog');
    expect(mockSettings.actionPanelStyle).toBe('battlelog');
    await nextTick();
    expect(wrapper.get('.action-panel-style-desc').text()).toContain('战报');
  });
});
