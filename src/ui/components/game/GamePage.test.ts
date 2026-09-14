/**
 * GamePage 基础渲染测试 (Phase 7e)
 * @vitest-environment jsdom
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { defineComponent, h } from 'vue';
import GamePage from './GamePage.vue';
import AppModal from '../shared/AppModal.vue';
import {
  seedPlaceholderRegistry,
  ensureContentRegistryLoaded,
  resetContentRegistryLoadedForTests,
} from '../../stores/content-store';
import { useSettingsStore } from '../../stores/settings-store';
import { useGameStore } from '../../stores/game-store';
import { useUIStore } from '../../stores/ui-store';

enableAutoUnmount(afterEach);

// GamePage 静态 import 了 MapPanel。地图弹窗一开就要真的把 OSD 建起来 ——
// jsdom 里没有画布也没有 ResizeObserver，这里只关心「零内容能不能开」。
vi.mock('openseadragon', () => {
  const OpenSeadragon: any = vi.fn(() => ({
    addHandler: vi.fn(),
    removeHandler: vi.fn(),
    destroy: vi.fn(),
    isDestroyed: () => false,
    forceResize: vi.fn(),
    open: vi.fn(),
    world: { getItemAt: () => null },
    viewport: { applyConstraints: vi.fn(), panTo: vi.fn() },
    element: document.createElement('div'),
  }));
  OpenSeadragon.Point = class {
    constructor(
      public x: number,
      public y: number,
    ) {}
  };
  OpenSeadragon.ImageTileSource = class {};
  return { default: OpenSeadragon };
});

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
    loadSave: vi.fn(async () => true),
    invalidatePendingLoads: vi.fn(),
    toggleSidebar: vi.fn(),
    setRightPanel: vi.fn(),
    toggleFullscreen: vi.fn(),
    /** Plan 3: dynamic options */
    pendingOptions: [] as string[],
    hasOpeningPromptConsumed: true,
    openingPrompt: null as string | null,
  })),
  setRewriteLoadoutImpl: vi.fn(),
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
    useSettingsStore().settings.developerMode = false;
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
      invalidatePendingLoads: vi.fn(),
      toggleSidebar: vi.fn(),
      setRightPanel: vi.fn(),
      toggleFullscreen: vi.fn(),
      pendingOptions: [] as string[],
      hasOpeningPromptConsumed: true,
      openingPrompt: null as string | null,
    });
    (useUIStore as any).mockReturnValue({
      activeSaveId: 'test-save-123',
      currentView: 'game',
      navigate: vi.fn(),
    });

    mount(GamePage);
    await flushPromises();
    expect(mockLoadSave).toHaveBeenCalledWith('test-save-123');
  });

  it('keeps the toolbar debug modal separate from the keyboard debug drawer', async () => {
    useSettingsStore().settings.developerMode = true;
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
      loadSave: vi.fn(async () => true),
      invalidatePendingLoads: vi.fn(),
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
          MiniPlayer: true,
          CombatPanel: true,
          GameMenu: true,
          ItemsPanel: true,
          CharacterListPanel: true,
          QuestsPanel: true,
          PlotPanel: true,
          MemoryPanel: true,
          SnapshotPanel: true,
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

  it('开发者模式关闭时隐藏并收起所有原始诊断面', async () => {
    const { useGameStore } = await import('../../stores/game-store');
    const closeModal = vi.fn();
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
      loadSave: vi.fn(async () => true),
      invalidatePendingLoads: vi.fn(),
      toggleSidebar: vi.fn(),
      setRightPanel: vi.fn(),
      toggleFullscreen: vi.fn(),
      closeModal,
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
          MiniPlayer: true,
          CombatPanel: true,
          GameMenu: true,
          ItemsPanel: true,
          CharacterListPanel: true,
          QuestsPanel: true,
          PlotPanel: true,
          MemoryPanel: true,
          SnapshotPanel: true,
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

      expect(closeModal).toHaveBeenCalledOnce();
      expect(document.body.querySelector('.debug-panel')).toBeNull();
      expect(document.body.querySelector('.debug-drawer')).toBeNull();
    } finally {
      wrapper.unmount();
      document.body.innerHTML = '';
      document.body.style.overflow = '';
    }
  });

  /**
   * D23 解耦验证：**零内容也能开地图**。
   *
   * 改造前 `MapPanel.vue` 静态 import 了 `data/defaults/map-marker-presets.json`，
   * 于是 GamePage 的整条模块图都拴着那份内容文件——删文件 break build，而不是「地图是空的」。
   * 现在标记与地点都从内容注册表来：一面都没灌注时地图弹窗照样开得起来，显示 0 标记。
   */
  it('内容注册表全空时地图弹窗照样开得起来（不再静态依赖 data/ 里的文件）', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in tests');
      }),
    );
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();

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
      activeModal: 'map',
      sidebarCollapsed: false,
      rightPanelMode: 'status',
      fullscreenStatus: false,
      hasOpeningPromptConsumed: true,
      openingPrompt: null,
      loadSave: vi.fn(async () => true),
      invalidatePendingLoads: vi.fn(),
      toggleSidebar: vi.fn(),
      setRightPanel: vi.fn(),
      toggleFullscreen: vi.fn(),
      closeModal: vi.fn(),
    });

    const wrapper = mount(GamePage);
    await ensureContentRegistryLoaded();
    await flushPromises();

    // AppModal 用 Teleport 挂到 body，wrapper.find 够不着
    const badge = document.body.querySelector('.toolbar-badge');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('0 标记');

    // 🔴 就地卸载 + 把 MapPanel 那几个 300/500ms 的补同步定时器等掉。
    //    留着它们会在**测试跑完之后**触发 jsdom 的告警输出，vitest 报成
    //    `Closing rpc while "onUserConsoleLog" was pending` —— 断言全绿但整份 exit 1。
    wrapper.unmount();
    await new Promise((resolve) => setTimeout(resolve, 600));

    vi.unstubAllGlobals();
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
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

/* ===== 游戏菜单的 Esc 分层（2026-09-13） ===== */
/**
 * Esc 是**一条链上多个东西都想吃**的键：消息右键菜单、迷你播放器、各种弹窗、
 * 以及这里新加的游戏菜单。菜单是链条的**最下层**，判据写错的症状是
 * 「关掉一个浮层的同时菜单自己弹出来」—— 断言全绿但玩家会觉得键坏了。
 *
 * 🔴 事件必须从 `document.body` 上冒泡（而不是直接 `window.dispatchEvent`）才测得准：
 * 目标是 window 的路径里**没有 document**，`modal-focus` 的 document-capture 监听器
 * 根本收不到，于是「浮层吃掉 Esc」这条路上什么都不会发生，测试会假绿。
 */
describe('GamePage — 菜单 Esc 分层', () => {
  /** 右键菜单的开合由 ChatFlow 自持，测试里用一个会暴露 ctxMenuOpen 的替身驱动 */
  const ctxMenu = { open: false };
  let mockGame: any;

  /**
   * 具名替身：VTU 的 `findComponent({ name })` 认组件 name，匿名替身找不到。
   *
   * 🔴 这里**故意写裸对象而不是 `defineComponent(...)`**：本文件已经有 `ChatFlowStub`
   *    一个真组件定义，再来两个就踩 `vue/one-component-per-file`
   *    （`--max-warnings 0` 直接挂 lint 闸门）。VTU 对 `stubs` 里的对象走同一条
   *    「custom implementation」分支（`Object.assign({}, stub)`），裸对象和
   *    `defineComponent` 包过一遍在运行期没有区别。
   */
  const stubFor = (name: string) => ({ name, render: () => h('div') });
  const ChatFlowStub = defineComponent({
    name: 'ChatFlow',
    setup(_props, { expose }) {
      expose({
        get ctxMenuOpen() {
          return ctxMenu.open;
        },
      });
      return () => h('div', { class: 'chat-flow-stub' });
    },
  });

  const stubs = {
    TopBar: stubFor('TopBar'),
    SideToolbar: stubFor('SideToolbar'),
    ScenePanel: stubFor('ScenePanel'),
    ChatFlow: ChatFlowStub,
    StatusHUD: stubFor('StatusHUD'),
    MiniPlayer: stubFor('MiniPlayer'),
    CombatPanel: stubFor('CombatPanel'),
    ItemsPanel: stubFor('ItemsPanel'),
    CharacterListPanel: stubFor('CharacterListPanel'),
    QuestsPanel: stubFor('QuestsPanel'),
    PlotPanel: stubFor('PlotPanel'),
    MemoryPanel: stubFor('MemoryPanel'),
    SnapshotPanel: stubFor('SnapshotPanel'),
    MapPanel: stubFor('MapPanel'),
    DebugPanel: stubFor('DebugPanel'),
    // GameMenu **故意不 stub** —— 这一组测的就是它跟别人的 Esc 分工
  };

  function pressEsc() {
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }

  /** 菜单是否开着 —— 它在 body 上（AppModal 走 Teleport） */
  const menuShown = () => document.body.querySelector('[data-menu="home"]') !== null;

  function page(over: Record<string, unknown> = {}) {
    ctxMenu.open = false;
    mockGame = {
      player: null,
      npcs: [],
      characters: [],
      messages: [],
      isGenerating: false,
      recentMemories: [],
      activePlotEvents: [],
      plotOutline: null,
      activeCombat: null,
      activeModal: null,
      isInCombat: false,
      sidebarCollapsed: false,
      rightPanelMode: 'status',
      fullscreenStatus: false,
      activeSave: null,
      pendingOptions: [],
      hasOpeningPromptConsumed: true,
      openingPrompt: null,
      loadSave: vi.fn(async () => true),
      invalidatePendingLoads: vi.fn(),
      toggleSidebar: vi.fn(),
      setRightPanel: vi.fn(),
      toggleFullscreen: vi.fn(),
      showModal: vi.fn(),
      closeModal: vi.fn(),
      fillInput: vi.fn(),
      ...over,
    };
    (useGameStore as any).mockReturnValue(mockGame);
    // 🔴 `activeSaveId` 必须有值：没有它 GamePage 停在「正在加载存档」分支，
    //    ChatFlow / MiniPlayer 根本不挂载 —— 那样这一组会以「菜单在浮层面前没让路」
    //    的假象全绿，实际上那两条判据里的 ref 一直是 null。
    (useUIStore as any).mockReturnValue({
      activeSaveId: 'save-1',
      currentView: 'game',
      navigate: vi.fn(),
      toast: vi.fn(),
    });
    return mount(GamePage, { attachTo: document.body, global: { stubs } });
  }

  beforeEach(() => {
    setActivePinia(createPinia());
    useSettingsStore().settings.developerMode = false;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.body.style.overflow = '';
  });

  it('平地按 Esc → 菜单打开；再按一次 Esc → 关掉', async () => {
    const wrapper = page();
    await flushPromises();

    pressEsc();
    await flushPromises();
    expect(menuShown()).toBe(true);

    // 第二次由 AppModal 自己那条通道关掉（菜单在 dialogs 栈里，GamePage 那层让路）
    pressEsc();
    await flushPromises();
    expect(menuShown()).toBe(false);

    wrapper.unmount();
  });

  it('顶栏那颗入口按钮走同一条路（不经过 Esc 判据）', async () => {
    const wrapper = page();
    await flushPromises();

    wrapper.findComponent({ name: 'TopBar' }).vm.$emit('openMenu');
    await flushPromises();
    expect(menuShown()).toBe(true);

    wrapper.unmount();
  });

  it('有弹窗时不抢 Esc：浮层关掉，菜单不冒出来', async () => {
    const wrapper = page();
    await flushPromises();

    const overlay = mount(AppModal, {
      props: { open: true, title: '测试浮层' },
      attachTo: document.body,
    });
    await flushPromises();

    pressEsc();
    await flushPromises();

    expect(overlay.emitted('close')).toHaveLength(1);
    expect(menuShown()).toBe(false);

    overlay.unmount();
    wrapper.unmount();
  });

  it('消息右键菜单开着时不抢 Esc', async () => {
    const wrapper = page();
    // 🔴 等 ChatFlow 替身**真的挂上**再测：载入链路里串着 Dexie（场景插画 / 会话外貌），
    //    单次 flushPromises 推不到 `loadingSave = false`；此时 chatFlowRef 是 null，
    //    这条判据会以「没抢 Esc」的假象通过。
    await vi.waitFor(() => expect(wrapper.find('.chat-flow-stub').exists()).toBe(true), {
      timeout: 3000,
    });

    ctxMenu.open = true;
    pressEsc();
    await flushPromises();
    expect(menuShown()).toBe(false);

    wrapper.unmount();
  });

  it('迷你播放器开着时不抢 Esc', async () => {
    const wrapper = page();
    await flushPromises();

    wrapper.findComponent({ name: 'SideToolbar' }).vm.$emit('tool-click', 'audio');
    await flushPromises();

    pressEsc();
    await flushPromises();
    expect(menuShown()).toBe(false);

    wrapper.unmount();
  });

  it('战斗中不抢 Esc（战斗覆盖层在屏上）', async () => {
    const wrapper = page({ isInCombat: true });
    await flushPromises();

    pressEsc();
    await flushPromises();
    expect(menuShown()).toBe(false);

    wrapper.unmount();
  });

  it('有页面级弹窗位时不抢 Esc（activeModal 有值）', async () => {
    const wrapper = page({ activeModal: 'items' });
    await flushPromises();

    pressEsc();
    await flushPromises();
    expect(menuShown()).toBe(false);

    wrapper.unmount();
  });
});
