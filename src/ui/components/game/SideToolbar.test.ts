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
});
