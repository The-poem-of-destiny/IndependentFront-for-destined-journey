/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SideToolbar from '../../../../src/ui/components/game/SideToolbar.vue';

const mockState = vi.hoisted(() => ({
  developerMode: false,
  sidebarCollapsed: false,
}));

vi.mock('../../../../src/ui/stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: mockState }),
}));

vi.mock('../../../../src/ui/stores/game-store', () => ({
  useGameStore: () => ({
    get sidebarCollapsed() {
      return mockState.sidebarCollapsed;
    },
    toggleSidebar: vi.fn(),
  }),
}));

vi.mock('../../../../src/ui/stores/audio-store', () => ({
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

  /** 2026-11-21：游戏内「预设」抽屉的入口；点击照常经 toolClick 交给 GamePage 占 activeModal */
  it('有预设入口，点击发出 toolClick(preset)', async () => {
    const wrapper = mount(SideToolbar);
    const btn = wrapper.get('[data-tool="preset"]');
    expect(btn.attributes('aria-label')).toBe('预设');
    expect(btn.find('i').classes()).toContain('fa-sliders');
    await btn.trigger('click');
    expect(wrapper.emitted('toolClick')).toEqual([['preset']]);
  });

  /** 状态树协议 T11：变量修改器常驻侧栏，不需要开发者模式（设计 §9 #13） */
  it('有变量入口（不需开发者模式），点击发出 toolClick(variables)', async () => {
    const wrapper = mount(SideToolbar);
    const btn = wrapper.get('[data-tool="variables"]');
    expect(btn.attributes('aria-label')).toBe('变量');
    await btn.trigger('click');
    expect(wrapper.emitted('toolClick')).toEqual([['variables']]);
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
