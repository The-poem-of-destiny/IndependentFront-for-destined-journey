/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SideToolbar from './SideToolbar.vue';

const mockState = vi.hoisted(() => ({
  developerMode: false,
  sidebarCollapsed: false,
}));

vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockState }),
}));

vi.mock('../../stores/game-store', () => ({
  useGameStore: () => ({
    get sidebarCollapsed() {
      return mockState.sidebarCollapsed;
    },
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../../stores/audio-store', () => ({
  useAudioStore: () => ({ state: { music: { status: 'idle' } } }),
}));

describe('SideToolbar developer gate', () => {
  beforeEach(() => {
    mockState.developerMode = false;
    mockState.sidebarCollapsed = false;
  });

  it('默认不显示调试入口', () => {
    const wrapper = mount(SideToolbar);
    expect(wrapper.find('[data-tool="debug"]').exists()).toBe(false);
  });

  it('开启开发者模式后显示调试入口', () => {
    mockState.developerMode = true;
    const wrapper = mount(SideToolbar);
    expect(wrapper.get('[data-tool="debug"]').attributes('aria-label')).toBe('调试');
  });

  it('不再有工坊入口（扩展管理才是它的去处）', () => {
    const wrapper = mount(SideToolbar);
    expect(wrapper.find('[data-tool="workshop"]').exists()).toBe(false);
  });

  /**
   * 2026-09-13：设置入口收进顶栏的统一菜单（`GameMenu`），侧栏不再有第二颗 ——
   * 两处入口并存时改设置要猜「哪颗才是真的」，且和顶栏那颗重复。
   */
  it('不再有设置入口（已收进游戏菜单）', () => {
    mockState.developerMode = true;
    const wrapper = mount(SideToolbar);
    expect(wrapper.find('[data-tool="settings"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('设置');
  });

  /**
   * 2026-09-13 第二版：扩展入口同理，从侧栏搬进游戏菜单的第四个位置
   * （原来摆在那儿的是只翻一个布尔值的「全屏」，已退役）。
   */
  it('不再有扩展入口（已收进游戏菜单）', () => {
    const wrapper = mount(SideToolbar);
    expect(wrapper.find('[data-tool="extensions"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('扩展');
  });
});
