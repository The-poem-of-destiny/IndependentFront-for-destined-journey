/**
 * GamePage.abort-on-unmount.test.ts — COR-02：离开游戏页必须 abort 在飞的管线
 *
 * 🔴 这个文件存在的理由与 `GamePage.scene-image-seams.test.ts` 同形：
 * 「有没有人调 abort」是**接线**问题，任何 GamePipeline 层的单测都证明不了它。
 *
 * 失败场景（2026-08-09 审查复核确认）：
 *   存档 A 正在生成（story 在飞，约 20 秒）→ 玩家点「← 首页」（TopBar 上一个**始终
 *   可点**的按钮）→ 打开存档 B。应用没有 KeepAlive（App.vue 用 `:key="ui.currentView"`），
 *   所以 GamePage 当场卸载，而 `onUnmounted` 此前只清 `isGenerating`、不调 abort。
 *   仍在跑的 `run()` 之后走到 `handleAgentResult` → `game.addMessage(...)`，
 *   而 game-store 是从 **store** 取存档号的 → 为 A 生成的正文落进 B 并永久留在 B 的历史里。
 *   顺带，清掉的 `isGenerating` 还解锁了 handleSend，重进游戏页能再起一个并发 run()。
 *
 * 第二道闸（存档归属检查）在 `game-pipeline.test.ts` 的 COR-02 一节。
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import GamePage from './GamePage.vue';

enableAutoUnmount(afterEach);

/** 本次挂载建出来的那个管线替身的 abort spy */
const abortSpy = vi.fn();
/** 管线替身被构造了几次 —— 用来等 onMounted 里那串 await 走完，不靠猜时间 */
const constructedSpy = vi.fn();

vi.mock('../../lib/game-pipeline', () => ({
  GamePipeline: class {
    constructor() {
      constructedSpy();
    }
    abort = abortSpy;
    primeSceneAudio(): void {}
    async sendOpeningPrompt(): Promise<void> {}
    async runImagePromptAgent(): Promise<unknown> {
      return { scenePrompt: '', sceneNegative: '', desc: '' };
    }
  },
}));

// GamePage 静态 import 了 MapPanel，它模块级就要 OSD；jsdom 里没有画布
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

const gameStore = {
  player: null,
  npcs: [],
  characters: [],
  agentLog: [],
  saveProfile: null,
  fp: 0,
  messages: [],
  pendingOptions: [],
  isGenerating: true, // 生成中途离开 —— 这条用例的全部前提
  recentMemories: [],
  activePlotEvents: [],
  plotOutline: null,
  activeCombat: null,
  activeSave: null,
  activeModal: null,
  activeSaveId: 'save_A',
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
};

vi.mock('../../stores/game-store', () => ({
  useGameStore: vi.fn(() => gameStore),
}));

vi.mock('../../stores/ui-store', () => ({
  useUIStore: vi.fn(() => ({ activeSaveId: 'save_A', navigate: vi.fn() })),
}));

const STUBS = {
  TopBar: true,
  SideToolbar: true,
  ScenePanel: true,
  ChatFlow: true,
  StatusHUD: true,
  InputBar: true,
  AgentStatusPanel: true,
  MiniPlayer: true,
  CombatPanel: true,
  ItemsPanel: true,
  CharacterListPanel: true,
  QuestsPanel: true,
  PlotPanel: true,
  MemoryPanel: true,
  SnapshotPanel: true,
  CgGalleryPanel: true,
  WorkshopEnablePanel: true,
  MapPanel: true,
  DebugPanel: true,
};

describe('COR-02：GamePage 卸载时 abort 在飞的管线', () => {
  it('🔴 生成中途卸载 → pipeline.abort() 被调用', async () => {
    setActivePinia(createPinia());
    abortSpy.mockClear();
    constructedSpy.mockClear();
    gameStore.isGenerating = true;

    const wrapper = mount(GamePage, { global: { stubs: STUBS } });
    // onMounted 一路 await Dexie（真 IndexedDB 事务，靠宏任务推进），光 flushPromises
    // 只清微任务队列 —— 轮着等管线真的建出来，别一次性 setTimeout 猜个数字
    for (let i = 0; i < 100 && constructedSpy.mock.calls.length === 0; i += 1) {
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // 管线没建出来的话下面那条断言会以「abort 没被调用」的面目失败，指向错误的方向
    expect(constructedSpy).toHaveBeenCalledTimes(1);

    wrapper.unmount();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    // 兜底解锁仍在（abort 之后才清，顺序见 GamePage.onUnmounted 的注释）
    expect(gameStore.isGenerating).toBe(false);
  });
});
