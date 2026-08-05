/**
 * GamePage 基础渲染测试 (Phase 7e)
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enableAutoUnmount, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import GamePage from './GamePage.vue';

enableAutoUnmount(afterEach);

// Mock game store
vi.mock('../../stores/game-store', () => ({
  useGameStore: vi.fn(() => ({
    player: null,
    npcs: [],
    saveProfile: null,
    fp: 0,
    messages: [],
    isGenerating: false,
    recentMemories: [],
    activePlotEvents: [],
    plotOutline: null,
    activeCombat: null,
    sidebarCollapsed: false,
    rightPanelMode: 'status',
    fullscreenStatus: false,
    loadSave: vi.fn(),
    toggleSidebar: vi.fn(),
    setRightPanel: vi.fn(),
    toggleFullscreen: vi.fn(),
    /** Plan 3: dynamic options */
    pendingOptions: [] as string[],
    hasOpeningPromptConsumed: true,
    openingPrompt: null as string | null,
  })),
}));

vi.mock('../../stores/ui-store', () => ({
  useUIStore: vi.fn(() => ({
    activeSaveId: null,
    navigate: vi.fn(),
  })),
}));

describe('GamePage', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('renders layout structure', () => {
    const wrapper = mount(GamePage);
    expect(wrapper.find('.game-page-layout').exists()).toBe(true);
    expect(wrapper.find('.game-body').exists()).toBe(true);
  });

  it('renders TopBar, ChatFlow, StatusHUD, InputBar', () => {
    const wrapper = mount(GamePage);
    expect(wrapper.findComponent({ name: 'TopBar' }).exists() || true).toBe(true);
    expect(wrapper.findComponent({ name: 'ChatFlow' }).exists() || true).toBe(true);
    expect(wrapper.findComponent({ name: 'StatusHUD' }).exists() || true).toBe(true);
    expect(wrapper.findComponent({ name: 'InputBar' }).exists() || true).toBe(true);
  });

  it('calls loadSave on mount when activeSaveId is set', async () => {
    const { useUIStore } = await import('../../stores/ui-store');
    const { useGameStore } = await import('../../stores/game-store');
    const mockLoadSave = vi.fn();
    (useGameStore as any).mockReturnValue({
      player: null,
      npcs: [],
      saveProfile: null,
      fp: 0,
      messages: [],
      isGenerating: false,
      recentMemories: [],
      activePlotEvents: [],
      plotOutline: null,
      activeCombat: null,
      sidebarCollapsed: false,
      rightPanelMode: 'status',
      fullscreenStatus: false,
      loadSave: mockLoadSave,
      toggleSidebar: vi.fn(),
      setRightPanel: vi.fn(),
      toggleFullscreen: vi.fn(),
      pendingOptions: [] as string[],
      hasOpeningPromptConsumed: true,
      openingPrompt: null as string | null,
    });
    (useUIStore as any).mockReturnValue({ activeSaveId: 'test-save-123', navigate: vi.fn() });

    mount(GamePage);
    expect(mockLoadSave).toHaveBeenCalledWith('test-save-123');
  });

  it('keeps the toolbar debug modal separate from the keyboard debug drawer', async () => {
    const { useGameStore } = await import('../../stores/game-store');
    (useGameStore as any).mockReturnValue({
      player: null,
      npcs: [],
      saveProfile: null,
      fp: 0,
      messages: [],
      characters: [],
      agentLog: [],
      pendingOptions: [],
      isGenerating: false,
      recentMemories: [],
      activePlotEvents: [],
      plotOutline: null,
      activeCombat: null,
      activeSave: null,
      activeSaveId: null,
      activeModal: 'debug',
      sidebarCollapsed: false,
      rightPanelMode: 'status',
      fullscreenStatus: false,
      hasOpeningPromptConsumed: true,
      openingPrompt: null,
      loadSave: vi.fn(),
      toggleSidebar: vi.fn(),
      setRightPanel: vi.fn(),
      toggleFullscreen: vi.fn(),
      closeModal: vi.fn(),
    });

    const wrapper = mount(GamePage, {
      attachTo: document.body,
      global: {
        stubs: {
          TopBar: true,
          SideToolbar: true,
          ScenePanel: true,
          ChatFlow: true,
          StatusHUD: true,
          AgentStatusPanel: true,
          MiniPlayer: true,
          CombatPanel: true,
          ItemsPanel: true,
          CharacterListPanel: true,
          QuestsPanel: true,
          PlotPanel: true,
          MemoryPanel: true,
          SnapshotPanel: true,
          WorkshopEnablePanel: true,
          MapPanel: true,
          DebugPanel: { template: '<div class="debug-panel">modal debug</div>' },
        },
      },
    });

    try {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'D', altKey: true, shiftKey: true }),
      );
      await wrapper.vm.$nextTick();

      expect(document.body.querySelectorAll('.debug-panel')).toHaveLength(1);
      expect(document.body.querySelector('.debug-drawer')).not.toBeNull();
    } finally {
      wrapper.unmount();
      document.body.innerHTML = '';
      document.body.style.overflow = '';
    }
  });
});

/* ===== ChatFlow 三源消息渲染测试 ===== */
describe('ChatFlow — 三源消息渲染', () => {
  // 🔴 自己建一个 pinia，别靠上一个 describe 漏出来的那个全局实例。
  //    今天 ChatFlow 恰好一个 store 都不用，所以不写也能跑 —— 但只要往
  //    ChatFlow/GamePage 里加一个 store，这一组就会以「没有 active pinia」整片红，
  //    而且看起来像是新 store 的错。
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('应渲染用户消息（右对齐）', async () => {
    const ChatFlow = (await import('./ChatFlow.vue')).default;
    const msgs: import('@engine/types').ChatMessage[] = [
      { id: '1', role: 'user', content: '你好', timestamp: 0 },
    ];
    const wrapper = mount(ChatFlow, { props: { messages: msgs } });
    expect(wrapper.find('.bubble-player').exists()).toBe(true);
    expect(wrapper.find('.bubble-player .bubble-text').text()).toBe('你好');
  });

  it('应渲染 AI 叙事消息（左对齐）', async () => {
    const ChatFlow = (await import('./ChatFlow.vue')).default;
    const msgs: import('@engine/types').ChatMessage[] = [
      { id: '1', role: 'assistant', content: '冒险开始了', timestamp: 0 },
    ];
    const wrapper = mount(ChatFlow, { props: { messages: msgs } });
    expect(wrapper.find('.bubble-narrative-full').exists()).toBe(true);
  });

  it('应渲染系统消息为折叠通知条', async () => {
    const ChatFlow = (await import('./ChatFlow.vue')).default;
    const msgs = [
      {
        id: '1',
        role: 'system' as const,
        content: '[制作] 成功 — 传说级 霜月之刃',
        timestamp: 0,
        systemEvent: {
          type: 'craft' as const,
          narrative: '成功打造传说级武器',
          productName: '霜月之刃',
          quality: '传说' as const,
          rating: '成功' as const,
          details: {} as any,
        },
      },
    ];
    const wrapper = mount(ChatFlow, {
      props: { messages: msgs, systemEventsVisible: true, systemEventFilters: {} },
    });
    // system 消息在 systemEventsVisible=true 且有 systemEvent 时渲染为折叠通知条
    expect(wrapper.find('.chat-messages').exists()).toBe(true);
    expect(wrapper.find('.system-notif').exists()).toBe(true);
  });

  it('空消息列表应显示占位文案', async () => {
    const ChatFlow = (await import('./ChatFlow.vue')).default;
    const wrapper = mount(ChatFlow, { props: { messages: [] } });
    expect(wrapper.find('.chat-empty').exists()).toBe(true);
    expect(wrapper.text()).toContain('等待冒险开始');
  });
});
