/**
 * MapPanel — 地图标记 provider 化（D23 / D25①）
 * @vitest-environment jsdom
 *
 * 这一组守两件事：
 *
 * 1. **内容不再编译进 bundle**。原来 `MapPanel.vue` 顶上有一条
 *    `import presetMarkersJson from '../../../../data/defaults/map-marker-presets.json'`，
 *    还有 `@engine/location-db` 的 `DEFAULT_LOCATIONS` 模块常量 —— 删数据文件会**直接
 *    break build**。这条耦合是源码层面的事实，所以用源码断言守；行为测试守不住它
 *    （注册表恰好也能供出同样的值，两条路都通时看不出静态 import 还在）。
 *
 * 2. **注册表未就绪不许崩**。六面在首轮加载完成前是 `undefined`，面板要么等、要么空态。
 */
// 🔴 必须在其它 import 之前：`ensureContentRegistryLoaded()` 会先 hydrate 已装内容包，
//    那一步要 Dexie。jsdom 里没有 indexedDB 时那个 await **不 reject、直接悬着**，
//    于是 onMounted 后半段（setMarkers / createViewer）永远不跑，测试看到的是
//    「0 标记 + 一直在加载」—— 一个看起来像组件 bug 的环境问题。
import 'fake-indexeddb/auto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// 源码文本走 Vite 的 `?raw`，**不用 node 的 fs/path** —— `src/` 那份 tsconfig 不带
// @types/node，写 `readFileSync` 测试能跑但 `npm run typecheck` 会红
// （`ejs-scrambled-corpus.test.ts` 里记着同一条）。
import mapPanelSource from './MapPanel.vue?raw';
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MapMarker } from '@engine/types';
import {
  setContentRegistry,
  seedPlaceholderRegistry,
  ensureContentRegistryLoaded,
  resetContentRegistryLoadedForTests,
} from '../../stores/content-store';

enableAutoUnmount(afterEach);

// OpenSeadragon 在 jsdom 里没有画布可用 —— 本组测的是数据供给，不是渲染引擎。
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
  useGameStore: vi.fn(() => ({ player: null, npcs: [], saveProfile: null })),
}));

const MARKERS: MapMarker[] = [
  { id: 'm-1', name: '测试营地', group: '据点', position: { nx: 0.25, ny: 0.4 } },
  { id: 'm-2', name: '测试港口', group: '据点', position: { nx: 0.6, ny: 0.7 } },
];

function emptyRegistry() {
  return {
    catalog: undefined,
    locations: undefined,
    bloodlines: undefined,
    namePools: undefined,
    markers: undefined,
    branding: undefined,
  };
}

async function mountPanel() {
  const MapPanel = (await import('./MapPanel.vue')).default;
  const wrapper = mount(MapPanel, { attachTo: document.body });
  // 🔴 `flushPromises()` 单独用**不够**：onMounted 卡在 `ensureContentRegistryLoaded()` 上，
  //    而它内部是真的 fetch。await 同一个（memo 化的）promise 才能确保 onMounted 后半段
  //    （setMarkers / createViewer / loadSource）已经跑完。
  await ensureContentRegistryLoaded();
  await flushPromises();
  await wrapper.vm.$nextTick();
  return wrapper;
}

describe('MapPanel — 内容从注册表来（D23）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    // jsdom 没有 ResizeObserver。缺了它 createViewer **抛在 onMounted 里**，
    // 后面的 loadSource 一句都不跑 —— 症状是「地图永远在加载中」，看着像本组件的锅。
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // 占位 JSON 在测试环境里取不到（也不该去取）：钉成立刻失败，注册表保持测试灌进去的值。
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline in tests');
      }),
    );
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
  });

  it('源码里不许再出现任何指向 data/ 的 import（删内容文件不得 break build）', () => {
    const src = mapPanelSource;
    // 🔴 只看 **import 语句**，不拿整份文本做否定断言 —— 解释这些坑的注释里必然写着
    //    `data/` 与 `DEFAULT_LOCATIONS` 这些词，整份扫会被自己的注释绊倒
    //    （`no-external-assets.test.ts` 里同一个坑已经栽过两次）。
    const imports = src.match(/^\s*import\s[^;]*;/gm) ?? [];
    expect(imports.filter((line) => /['"][^'"]*\/data\//.test(line))).toEqual([]);
    // location 数据同理：模块常量 DEFAULT_LOCATIONS 已换成注册表 locations 面
    expect(imports.filter((line) => line.includes('DEFAULT_LOCATIONS'))).toEqual([]);
    expect(imports.some((line) => line.includes('getContentRegistry'))).toBe(true);
  });

  it('注册表 markers 面供给预设标记', async () => {
    setContentRegistry({ ...emptyRegistry(), markers: MARKERS });
    const wrapper = await mountPanel();
    expect(wrapper.find('.toolbar-badge').text()).toBe('2 标记');
  });

  it('markers 面为空（内容未装/未就绪）时渲染空态而不是崩', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('.toolbar-badge').text()).toBe('0 标记');
    expect(wrapper.find('.map-panel').exists()).toBe(true);
  });

  it('markers 面是坏形状（不是数组）时按空处理', async () => {
    setContentRegistry({ ...emptyRegistry(), markers: { nope: true } });
    const wrapper = await mountPanel();
    expect(wrapper.find('.toolbar-badge').text()).toBe('0 标记');
  });

  it('没有图源（branding 缺 mapSources）时不画切换组，并明说需要内容包', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find('.source-group').exists()).toBe(false);
    expect(wrapper.find('.map-overlay-error').text()).toContain('内容包');
  });

  it('branding.mapSources 供给图源时画出切换组', async () => {
    setContentRegistry({
      ...emptyRegistry(),
      branding: {
        mapSources: [
          { key: 'small', name: '高清地图', url: '/data/content/map-small.webp' },
          { key: 'large', name: '超清地图', url: '/data/content/map-large.webp' },
        ],
      },
    });
    const wrapper = await mountPanel();
    const buttons = wrapper.findAll('.source-group .btn');
    expect(buttons).toHaveLength(2);
    expect(buttons.map((b) => b.text())).toEqual(['高清地图', '超清地图']);
  });

  it('locations 面供给地点名（玩家位置条走注册表解析，不是模块常量）', async () => {
    const { useGameStore } = await import('../../stores/game-store');
    (useGameStore as any).mockReturnValue({
      player: { location: 'test_harbor' },
      npcs: [],
      saveProfile: null,
    });
    setContentRegistry({
      ...emptyRegistry(),
      markers: MARKERS,
      locations: [{ id: 'test_harbor', name: '测试港口', type: 'city', tier: 3 }],
    });
    const wrapper = await mountPanel();
    const bar = wrapper.find('.player-location-bar');
    expect(bar.exists()).toBe(true);
    expect(bar.text()).toContain('测试港口');
    // 名字匹配上了预设标记 → 已定位
    expect(bar.text()).toContain('已定位');
  });
});
