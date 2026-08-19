/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import ExtensionManagementPage from './ExtensionManagementPage.vue';

const global = {
  stubs: {
    CommunityExtensionSettings: { template: '<div data-testid="community-settings" />' },
  },
};

const h = vi.hoisted(() => ({
  ui: {
    navigate: vi.fn(),
    back: vi.fn(),
  },
  workshop: {
    ready: true,
    projects: [{ id: 'p1' }, { id: 'p2' }],
    init: vi.fn(async () => {}),
  },
}));

vi.mock('../../stores/ui-store', () => ({ useUIStore: () => h.ui }));
vi.mock('../../stores/workshop-store', () => ({ useWorkshopStore: () => h.workshop }));

beforeEach(() => {
  vi.clearAllMocks();
  h.workshop.ready = true;
  h.workshop.projects = [{ id: 'p1' }, { id: 'p2' }];
});

describe('ExtensionManagementPage', () => {
  it('为未实现的原版扩展显示明确占位，不渲染假开关', () => {
    const wrapper = mount(ExtensionManagementPage, { global });

    expect(wrapper.get('h2').text()).toBe('扩展管理');
    expect(wrapper.text()).toContain('原版扩展');
    expect(wrapper.text()).toContain('功能尚未实现');
    expect(wrapper.get('.extension-card-placeholder button').attributes('disabled')).toBeDefined();
  });

  it('展示已安装工坊项目数并进入创意工坊子页面', async () => {
    const wrapper = mount(ExtensionManagementPage, { global });

    expect(wrapper.text()).toContain('已安装 2 项');
    const enter = wrapper
      .findAll('button')
      .find((button) => button.text().includes('进入创意工坊'));
    expect(enter).toBeTruthy();
    await enter!.trigger('click');

    expect(h.ui.navigate).toHaveBeenCalledWith('workshop');
  });

  it('返回动作交给多层页面历史', async () => {
    const wrapper = mount(ExtensionManagementPage, { global });
    await wrapper.get('header button').trigger('click');
    expect(h.ui.back).toHaveBeenCalledWith('home');
  });

  it('把社区扩展启用设置放在扩展管理页', () => {
    const wrapper = mount(ExtensionManagementPage, { global });
    expect(wrapper.get('[data-testid="community-settings"]').exists()).toBe(true);
  });
});
