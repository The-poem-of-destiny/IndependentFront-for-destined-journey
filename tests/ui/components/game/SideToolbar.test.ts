/**
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SideToolbar from '../../../../src/ui/components/game/SideToolbar.vue';
import {
  pluginEntriesFake,
  pluginEntry,
  pluginRuntimeFake,
  resetPluginUiFakes,
} from '../../../helpers/plugin-ui-fakes';

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

// 插件运行时与贡献点用替身（真 store 会去读 game.saves，这里的 game-store 是精简 mock）
vi.mock('../../../../src/ui/stores/plugin-runtime-store', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginRuntimeStoreModule(),
);
vi.mock('../../../../src/ui/composables/usePluginContributions', async () =>
  (await import('../../../helpers/plugin-ui-fakes')).pluginContributionsModule(),
);

describe('SideToolbar developer gate', () => {
  beforeEach(() => {
    mockState.developerMode = false;
    mockState.sidebarCollapsed = false;
    resetPluginUiFakes();
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

/**
 * 插件贡献按钮（插件系统设计 §5.7、§4.4）：`game.toolbar` 与 `game.overlay` 的触发按钮
 * 追加在内置工具之后；标签只做文本插值，图标只认宿主重编码的 PNG data URL。
 */
describe('SideToolbar 插件按钮', () => {
  beforeEach(() => {
    mockState.developerMode = false;
    mockState.sidebarCollapsed = false;
    resetPluginUiFakes();
  });

  it('没有生效插件时不渲染任何插件按钮', () => {
    const wrapper = mount(SideToolbar);
    expect(wrapper.findAll('[data-plugin-tool]')).toHaveLength(0);
  });

  it('toolbar 与 overlay 贡献各出一颗按钮，排在内置工具之后；menu / 面板贡献不进侧栏', () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'game.toolbar', contributionId: 'shop' }),
      pluginEntry({ slot: 'game.overlay', contributionId: 'board', label: '告示板' }),
      pluginEntry({ slot: 'game.menu', contributionId: 'm' }),
      pluginEntry({ slot: 'panel.items.footer', contributionId: 'f' }),
    ];
    const wrapper = mount(SideToolbar);
    const keys = wrapper.findAll('[data-plugin-tool]').map((b) => b.attributes('data-plugin-tool'));
    expect(keys).toEqual(['shop/shop', 'shop/board']);
    const buttons = wrapper.findAll('button.tool-btn');
    expect(buttons[buttons.length - 1].attributes('data-plugin-tool')).toBe('shop/board');
  });

  it('标签按纯文本插值：带标签的字符串原样显示，不生成元素', () => {
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'game.toolbar', label: '<img src=x onerror=alert(1)>商店' }),
    ];
    const wrapper = mount(SideToolbar);
    const btn = wrapper.get('[data-plugin-tool="shop/main"]');
    expect(btn.find('.tool-label').text()).toBe('<img src=x onerror=alert(1)>商店');
    expect(btn.find('img').exists()).toBe(false);
    expect(btn.attributes('aria-label')).toContain('插件：杂货铺');
  });

  it('有图标时用宿主重编码的 data:image/png，没有时退回拼图字形', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    pluginEntriesFake.value = [
      pluginEntry({ slot: 'game.toolbar', contributionId: 'a', icon: png }),
      pluginEntry({ slot: 'game.toolbar', contributionId: 'b', icon: null }),
    ];
    const wrapper = mount(SideToolbar);
    expect(wrapper.get('[data-plugin-tool="shop/a"] img').attributes('src')).toBe(png);
    expect(wrapper.find('[data-plugin-tool="shop/b"] img').exists()).toBe(false);
    expect(wrapper.find('[data-plugin-tool="shop/b"] .fa-puzzle-piece').exists()).toBe(true);
  });

  it('点按钮 → openSurface(pluginId, contributionId)，不经过 toolClick', async () => {
    pluginEntriesFake.value = [pluginEntry({ slot: 'game.toolbar', contributionId: 'shop' })];
    const wrapper = mount(SideToolbar);
    await wrapper.get('[data-plugin-tool="shop/shop"]').trigger('click');
    expect(pluginRuntimeFake.openSurface).toHaveBeenCalledWith('shop', 'shop');
    expect(wrapper.emitted('toolClick')).toBeUndefined();
  });

  it('侧栏折叠时插件按钮也只剩图标', () => {
    mockState.sidebarCollapsed = true;
    pluginEntriesFake.value = [pluginEntry({ slot: 'game.toolbar' })];
    const wrapper = mount(SideToolbar);
    const label = wrapper.get('[data-plugin-tool="shop/main"] .tool-label');
    expect((label.element as HTMLElement).style.display).toBe('none');
  });
});
