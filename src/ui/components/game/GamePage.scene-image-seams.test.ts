/**
 * GamePage.scene-image-seams.test.ts — 「内容注册表 / 方言 → 出图侧链」的**接线**
 *
 * 🔴 这个文件存在的唯一理由与 `scene-image-chain.test.ts` 完全相同：
 * `scene-image-seams.test.ts` 那种缝层测试**发现不了没接线**。
 * `SceneImageSeamDeps` 里 `rawDialects?` 与 `runPromptAgent` 的第三参都是**可选的**
 * （类型上就是），于是 GamePage 里那两行谁被删掉：
 *
 *     rawDialects: () => getContentRegistry().imageDialects,     // ← 删了 tsc 照过
 *     runPromptAgent: (r, s, systemPrompt) => pipeline.runImagePromptAgent(r, s, systemPrompt),
 *                                             // ← 第三参丢掉 tsc 照过
 *
 * 编译、单测、缝层测试**全绿**，行为却静悄悄退回图像 v1：内容包换的方言到不了侧链，
 * 模型仍按老吃法说话，图照出、Anlas 照扣，只是内容不对。这正是 `blurByDefault` 当年
 * 的死法（D46 打码声明了但没人传值）。
 *
 * 所以这里**从 GamePage 真的挂起来**，取它交给 store 的那套缝，再走一遍侧链：
 *
 *     content-store.imageDialects（内容包写的 systemPrompt）
 *       → GamePage      rawDialects
 *       → buildSceneImageSeams  resolveDialect().systemPrompt
 *       → GamePage      runPromptAgent 第三参
 *       → GamePipeline.runImagePromptAgent(_, _, systemPrompt)
 *
 * 被替身的只有**两端**（openseadragon / GamePipeline 的网络），不是链路本身。
 */
/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { DEFAULT_IMAGE_PROMPT_SYSTEM } from '@engine/image-defaults';
import type { ImagePromptOutput, ImagePromptRequest } from '@engine/types-image';
import GamePage from './GamePage.vue';
import {
  getContentRegistry,
  setContentRegistry,
  type ContentRegistry,
} from '../../stores/content-store';
import { useSceneImageStore, type SceneImageSeams } from '../../stores/scene-image-store';

enableAutoUnmount(afterEach);

/** 内容包里那段话 —— 与兜底方言的 `DEFAULT_IMAGE_PROMPT_SYSTEM` 逐字不同，才分得出走了哪条路 */
const PACK_PROMPT = '内容包写的：把场景写成一句英文散文。<image_prompt></image_prompt>';

/** 侧链真正收到的第三参（GamePipeline 是替身，这里是它唯一的产出） */
const promptCalls: (string | undefined)[] = [];

vi.mock('../../lib/game-pipeline', () => ({
  GamePipeline: class {
    async runImagePromptAgent(
      _request: ImagePromptRequest,
      _signal?: AbortSignal,
      systemPromptOverride?: string,
    ): Promise<ImagePromptOutput> {
      promptCalls.push(systemPromptOverride);
      return { scenePrompt: 'tavern interior', sceneNegative: '', desc: '' };
    }
    primeSceneAudio(): void {}
    async sendOpeningPrompt(): Promise<void> {}
    // COR-02 起 GamePage.onUnmounted 会调它 —— 替身缺这个方法，卸载当场 TypeError，
    // 而报出来的是 vue-test-utils 的 `Cannot read properties of null`，指向完全无关的地方
    abort(): void {}
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

vi.mock('../../stores/game-store', () => ({
  useGameStore: vi.fn(() => ({
    player: null,
    npcs: [],
    characters: [],
    agentLog: [],
    saveProfile: null,
    fp: 0,
    messages: [],
    pendingOptions: [],
    isGenerating: false,
    recentMemories: [],
    activePlotEvents: [],
    plotOutline: null,
    activeCombat: null,
    activeSave: null,
    activeModal: null,
    sidebarCollapsed: false,
    rightPanelMode: 'status',
    fullscreenStatus: false,
    // 开场白已消费：这条测试只关心缝，不该顺带跑一遍开场生成
    hasOpeningPromptConsumed: true,
    openingPrompt: null,
    loadSave: vi.fn(),
    toggleSidebar: vi.fn(),
    setRightPanel: vi.fn(),
    toggleFullscreen: vi.fn(),
    closeModal: vi.fn(),
  })),
}));

vi.mock('../../stores/ui-store', () => ({
  useUIStore: vi.fn(() => ({ activeSaveId: 'save_seam_wiring', navigate: vi.fn() })),
}));

/** 一条内容包方言：id 用默认那个，于是设置一格都不用动 */
function packRegistry(): ContentRegistry {
  return {
    ...getContentRegistry(),
    imageDialects: {
      dialects: [
        {
          id: 'danbooru-anime',
          label: '动漫标签',
          separator: ', ',
          normalize: 'danbooru',
          appearance: 'danbooru',
          world: 'tags',
          rating: 'tag',
          count: 'tag',
          supportsNegative: true,
          qualitySuffix: 'masterpiece',
          baseNegative: '',
          composition: '',
          systemPrompt: PACK_PROMPT,
        },
      ],
    },
  };
}

const STUBS = {
  TopBar: true,
  SideToolbar: true,
  ScenePanel: true,
  ChatFlow: true,
  StatusHUD: true,
  InputBar: true,
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

/** 挂起 GamePage，把它交给 store 的那套缝取回来 */
async function mountAndTakeSeams(): Promise<{
  seams: SceneImageSeams;
  unmount: () => void;
}> {
  const store = useSceneImageStore();
  const setSeams = vi.spyOn(store, 'setSeams');
  const wrapper = mount(GamePage, { global: { stubs: STUBS } });
  // onMounted 里一路 await 的是 Dexie（真 IndexedDB 事务，靠宏任务推进），
  // 光 flushPromises 只清微任务队列 —— 轮着等，别一次性 setTimeout 猜个数字
  for (let i = 0; i < 100 && setSeams.mock.calls.length === 0; i += 1) {
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  // 🔴 缝一次都没挂 = 每次 generate() 都以 prompt-agent 失败告终（「按了没反应、记录直接变红」）
  expect(setSeams).toHaveBeenCalledTimes(1);
  const seams = setSeams.mock.calls[0][0];
  // `SceneImageSeams` 三格全是可选的（store 允许只挂一部分）—— 这一条正是要它别缺
  expect(typeof seams.runPromptAgent).toBe('function');
  return { seams, unmount: () => wrapper.unmount() };
}

/** 走一次侧链；它收到的第三参落在 `promptCalls` 里 */
async function callPromptAgent(seams: SceneImageSeams): Promise<void> {
  await seams.runPromptAgent?.(request(), new AbortController().signal);
}

function request(): ImagePromptRequest {
  return {
    intent: '苏婉坐在壁炉旁',
    narrative: '壁炉噼啪作响。',
    characters: ['苏婉'],
    rating: 'general',
  } as ImagePromptRequest;
}

describe('GamePage → 出图缝的接线（rawDialects / 方言 systemPrompt）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    promptCalls.length = 0;
  });

  afterEach(() => {
    // 注册表是模块级的（不是 store），跑完必须放回去，否则污染同进程后面的用例
    setContentRegistry({ ...getContentRegistry(), imageDialects: undefined });
  });

  it('🔴 内容包方言那段 systemPrompt 一路到达侧链（删掉 rawDialects 或第三参这里就红）', async () => {
    setContentRegistry(packRegistry());

    const { seams, unmount } = await mountAndTakeSeams();
    try {
      await callPromptAgent(seams);

      // 侧链收到的必须是**内容包那段**：
      // - `rawDialects` 那行被删 → 缝落到兜底方言 → 这里会是 DEFAULT_IMAGE_PROMPT_SYSTEM
      // - `runPromptAgent` 第三参被丢 → 这里会是 undefined
      expect(promptCalls).toEqual([PACK_PROMPT]);
    } finally {
      unmount();
    }
  });

  it('注册表这一面缺席时收到的是兜底那段 v1 原文（缺席不是崩，也不是不传）', async () => {
    setContentRegistry({ ...getContentRegistry(), imageDialects: undefined });

    const { seams, unmount } = await mountAndTakeSeams();
    try {
      await callPromptAgent(seams);
      expect(promptCalls).toEqual([DEFAULT_IMAGE_PROMPT_SYSTEM]);
    } finally {
      unmount();
    }
  });
});
