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
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import type { MapMarker } from '@engine/types';
import type { MapPack, MapTile } from '@engine/types-map';
import {
  setContentRegistry,
  seedPlaceholderRegistry,
  ensureContentRegistryLoaded,
  resetContentRegistryLoadedForTests,
} from '../../stores/content-store';
import {
  buildTileColorLookup,
  decodeProvinceIds,
  provinceColorForTileId,
  type RasterPixels,
} from '../../lib/map-political';
import type { ProvinceRasterResult } from '../../lib/map-provinces-raster';
import { loadProvinceRaster } from '../../lib/map-provinces-raster';
import { removeMapMarker, setMapMarker } from '@engine/save-profile';
import { findPath } from '@engine/map-path';

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
  useGameStore: vi.fn(() => ({
    player: null,
    npcs: [],
    saveProfile: null,
    fillInput: vi.fn(),
    closeModal: vi.fn(),
  })),
}));

// provinces.png 的解码是**唯一**碰 canvas 的一步（jsdom 没有 2D 上下文），所以在那条缝上 mock：
// 势力页签的其余部分（着色/描边/命中/信息卡/路线/出发）都吃这份合成栅格，全都是真代码。
vi.mock('../../lib/map-provinces-raster', () => ({
  loadProvinceRaster: vi.fn(async () => rasterResult),
}));

// 落库两个写入口按 spy 换掉（真的会写 Dexie）；getMapFlags / getMapMarkers 保持真实实现
vi.mock('@engine/save-profile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/save-profile')>();
  return {
    ...actual,
    setMapMarker: vi.fn(async (profile: unknown) => profile),
    removeMapMarker: vi.fn(async (profile: unknown) => profile),
  };
});

// findPath 是引擎纯函数：默认透传真实实现，需要看入参的用例把它换成 spy
vi.mock('@engine/map-path', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/map-path')>();
  return { findPath: vi.fn(actual.findPath) };
});

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
    imageDialects: undefined,
    mapPack: undefined,
  };
}

// ═══════════════════════════════════════════════════════════
// 势力地图页签的夹具（地图系统 v1 / 设计 §9）
// ═══════════════════════════════════════════════════════════

function tile(partial: Partial<MapTile> & { id: number }): MapTile {
  return {
    name: `块${partial.id}`,
    terrain: '平地',
    water: null,
    impassable: false,
    countryId: null,
    midTierId: null,
    centroid: [0, 0],
    areaPx: 1,
    ...partial,
  };
}

/** 6×1 的合成包：甲一 | 甲二 | 雪脊（不可通行）| 乙一 | 内海 | 荒地 */
const MAP_PACK: MapPack = {
  version: '1',
  contentHash: 'test-hash',
  resolution: { w: 6, h: 1 },
  kmPerPx: 1,
  terrains: ['平地', '山地', '水面'],
  travelRules: { rates: { land: 10, nearSea: 20, farSea: 30 }, embarkCost: 1, terrainFactor: {} },
  countries: [
    { id: 'c-a', name: '甲国', color: [10, 20, 30], anchorTileId: 1 },
    { id: 'c-b', name: '乙国', color: [200, 100, 50], anchorTileId: 4 },
  ],
  midTiers: [{ id: 'm-1', name: '甲州', countryId: 'c-a', climateId: '', anchorTileId: 1 }],
  climates: {},
  tiles: [
    tile({ id: 1, name: '甲一', countryId: 'c-a', midTierId: 'm-1', centroid: [0, 0] }),
    tile({ id: 2, name: '甲二', countryId: 'c-a', centroid: [1, 0] }),
    tile({ id: 3, name: '雪脊', terrain: '山地', impassable: true, centroid: [2, 0] }),
    tile({ id: 4, name: '乙一', countryId: 'c-b', centroid: [3, 0] }),
    tile({ id: 5, name: '内海', terrain: '水面', water: 'sea', centroid: [4, 0] }),
    tile({ id: 6, name: '荒地', centroid: [5, 0] }),
  ],
  adjacency: [
    [1, 2, 10],
    [2, 3, 10],
    [3, 4, 10],
    // 绕过雪脊的那条边：少了它 1→4 只能穿不可通行块，findPath 恒为 null，
    // 于是「有路线时显示天数」那条断言测的是一张永远无路的图
    [2, 4, 5],
    [4, 5, 10],
    [5, 6, 10],
  ],
  straits: [],
  placeBindings: {},
};

/** 一行 6 像素，第 x 个像素就是第 (x+1) 块地 —— jsdom 里 rect 全 0，故点击 clientX=n 命中块 n+1 */
function syntheticRaster(): RasterPixels {
  const data = new Uint8ClampedArray(6 * 4);
  for (let x = 0; x < 6; x++) {
    const [r, g, b] = provinceColorForTileId(x + 1);
    data[x * 4] = r;
    data[x * 4 + 1] = g;
    data[x * 4 + 2] = b;
    data[x * 4 + 3] = 255;
  }
  return { width: 6, height: 1, data };
}

/** mock 掉的 `loadProvinceRaster` 每次返回它；用例可改成缺图/坏图 */
let rasterResult: ProvinceRasterResult = { ok: false, reason: 'missing' };

function readyRaster(): ProvinceRasterResult {
  return {
    ok: true,
    raster: decodeProvinceIds(syntheticRaster(), buildTileColorLookup(MAP_PACK.tiles)),
  };
}

/** 切到「势力地图」页签并等它把舞台建好 */
async function openPoliticalTab(wrapper: ReturnType<typeof mount>) {
  const tab = wrapper.findAll('.tab-item').find((b) => b.text().includes('势力地图'));
  expect(tab).toBeDefined();
  await tab!.trigger('click');
  await flushPromises();
  await wrapper.vm.$nextTick();
  await flushPromises();
  return wrapper;
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

// ═══════════════════════════════════════════════════════════
// 势力地图页签（地图系统 v1 / 设计 §9）
// ═══════════════════════════════════════════════════════════

interface GameStub {
  player: unknown;
  npcs: unknown[];
  saveProfile: unknown;
  fillInput: ReturnType<typeof vi.fn>;
  closeModal: ReturnType<typeof vi.fn>;
}

function makeProfile(map: Record<string, unknown>, markers: MapMarker[] = []) {
  return { worldFlags: { map, mapMarkers: markers } };
}

async function useGameStub(stub: Partial<GameStub>): Promise<GameStub> {
  const { useGameStore } = await import('../../stores/game-store');
  const full: GameStub = {
    player: null,
    npcs: [],
    saveProfile: null,
    fillInput: vi.fn(),
    closeModal: vi.fn(),
    ...stub,
  };
  (useGameStore as unknown as { mockReturnValue: (v: GameStub) => void }).mockReturnValue(full);
  return full;
}

/** 按可见文字点一个按钮（作用域内），找不到就让用例红在这里而不是静默什么都没点 */
async function clickButton(wrapper: VueWrapper, scope: string, label: string): Promise<void> {
  const button = wrapper.findAll(`${scope} button`).find((b) => b.text().includes(label));
  expect(button, `按钮「${label}」不存在`).toBeDefined();
  await button!.trigger('click');
  await wrapper.vm.$nextTick();
}

/** findPath 的最后一次入参（仓库 tsconfig 的 lib 没有 `Array.prototype.at`） */
function lastFindPathCall() {
  const calls = vi.mocked(findPath).mock.calls;
  return calls[calls.length - 1];
}

describe('MapPanel — 势力地图页签（地图 v1 / §9）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
    // jsdom 没有 2D 上下文；钉成 null 是为了让「拿不到上下文就不画」那条守卫真的被走过
    // （否则 jsdom 会往 virtual console 喷 not-implemented，还掩盖掉守卫有没有生效）
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
    rasterResult = readyRaster();
    vi.mocked(loadProvinceRaster).mockClear();
    vi.mocked(findPath).mockClear();
    vi.mocked(setMapMarker).mockClear();
    vi.mocked(removeMapMarker).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
  });

  it('两个页签，默认停在标记地图（既有内容一字未动）', async () => {
    await useGameStub({});
    setContentRegistry({ ...emptyRegistry(), markers: MARKERS });
    const wrapper = await mountPanel();
    const labels = wrapper.findAll('.tab-item').map((b) => b.text());
    expect(labels).toEqual(['标记地图', '势力地图']);
    expect(wrapper.find('.map-toolbar').exists()).toBe(true);
    expect(wrapper.find('.toolbar-badge').text()).toBe('2 标记');
    expect(wrapper.find('.pol-panel').exists()).toBe(false);
  });

  it('势力页签首次打开才解码像素（懒构建），且标记页签的 OSD 容器不被拆掉', async () => {
    await useGameStub({});
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    expect(loadProvinceRaster).not.toHaveBeenCalled();

    await openPoliticalTab(wrapper);
    expect(loadProvinceRaster).toHaveBeenCalledTimes(1);
    expect(wrapper.find('.pol-stage').exists()).toBe(true);
    // v-show 而不是 v-if：OSD 的挂载容器必须还在，否则切回来地图是白的
    expect(wrapper.find('.map-viewer').exists()).toBe(true);
  });

  it('没装地图内容包 → 友好空态，且一个字节都不去取', async () => {
    await useGameStub({});
    setContentRegistry({ ...emptyRegistry() });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    expect(wrapper.find('.pol-empty').text()).toContain('地图数据未安装');
    expect(loadProvinceRaster).not.toHaveBeenCalled();
  });

  it('缺 provinces.png（公开仓占位包的常态）→ 空态说明缺图，标记页签照常可用', async () => {
    await useGameStub({});
    rasterResult = { ok: false, reason: 'missing', detail: 'HTTP 404' };
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK, markers: MARKERS });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    expect(wrapper.find('.pol-empty').text()).toContain('provinces.png');
    expect(wrapper.find('.pol-world').exists()).toBe(false);
    // 标记页签没被牵连
    expect(wrapper.find('.toolbar-badge').text()).toBe('2 标记');
  });

  it('图解不开 → 报错态而不是白屏', async () => {
    await useGameStub({});
    rasterResult = { ok: false, reason: 'decode', detail: 'bad png' };
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    expect(wrapper.find('.pol-empty-error').text()).toContain('bad png');
    expect(wrapper.find('.map-panel').exists()).toBe(true);
  });

  it('点地块 → 信息卡给出名字/国家/中层/地形/通行性', async () => {
    await useGameStub({ saveProfile: makeProfile({ lastTileId: 1 }) });
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);

    // 一行 6 像素、jsdom 的 rect 全 0 → clientX=3 命中第 4 块（乙一）
    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    const card = wrapper.find('.pol-card');
    expect(card.exists()).toBe(true);
    expect(card.find('.pol-card-title').text()).toBe('乙一');
    expect(card.text()).toContain('乙国');
    expect(card.text()).toContain('平地');
    expect(card.text()).toContain('可通行');

    // 不可通行块与水域块各自照标
    await wrapper.find('.pol-stage').trigger('click', { clientX: 2, clientY: 0 });
    expect(wrapper.find('.pol-card').text()).toContain('不可通行');
    await wrapper.find('.pol-stage').trigger('click', { clientX: 4, clientY: 0 });
    expect(wrapper.find('.pol-card').text()).toContain('海域');
  });

  it('点空白（未绘制像素）→ 收起信息卡', async () => {
    await useGameStub({ saveProfile: makeProfile({ lastTileId: 1 }) });
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    expect(wrapper.find('.pol-card').exists()).toBe(true);
    await wrapper.find('.pol-stage').trigger('click', { clientX: 99, clientY: 0 });
    expect(wrapper.find('.pol-card').exists()).toBe(false);
  });

  it('「查看路线」从玩家位置跑 findPath；途经/回避进入入参并实时重算', async () => {
    await useGameStub({ saveProfile: makeProfile({ lastTileId: 1 }) });
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);

    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    await clickButton(wrapper, '.pol-card', '查看路线');
    const firstCall = lastFindPathCall();
    expect(firstCall?.[1]).toBe(1);
    expect(firstCall?.[2]).toBe(4);
    expect(firstCall?.[3]).toEqual({ via: [], avoid: [] });
    expect(wrapper.find('.pol-route-days').exists()).toBe(true);

    // 把甲二设为途经点，再选回乙一 → 同一条 computed 带着 via 重算
    await wrapper.find('.pol-stage').trigger('click', { clientX: 1, clientY: 0 });
    await clickButton(wrapper, '.pol-card', '设为途经点');
    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    const withVia = lastFindPathCall();
    expect(withVia?.[3]).toEqual({ via: [2], avoid: [] });
    expect(wrapper.find('.pol-card').text()).toContain('取道：甲二');

    // 「避开此地」与「设为途经点」互斥（同一块地既取道又避开是永远无解的查询）
    await wrapper.find('.pol-stage').trigger('click', { clientX: 1, clientY: 0 });
    await clickButton(wrapper, '.pol-card', '避开此地');
    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    const withAvoid = lastFindPathCall();
    expect(withAvoid?.[3]).toEqual({ via: [], avoid: [2] });
  });

  it('「出发」把指令填进输入框、关掉 Modal —— 不自动发送（§8.2）', async () => {
    const game = await useGameStub({ saveProfile: makeProfile({ lastTileId: 1 }) });
    // 天数固定，断言才能钉逐字的措辞
    vi.mocked(findPath).mockReturnValue({ tilePath: [1, 2, 3, 4], days: 7, crossings: ['甲州'] });
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);

    await wrapper.find('.pol-stage').trigger('click', { clientX: 1, clientY: 0 });
    await clickButton(wrapper, '.pol-card', '设为途经点');
    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    await clickButton(wrapper, '.pol-card', '查看路线');
    await clickButton(wrapper, '.pol-card', '出发');

    expect(game.fillInput).toHaveBeenCalledTimes(1);
    expect(game.fillInput).toHaveBeenCalledWith('【地图】玩家决定启程前往乙一，取道甲二，约 7 天');
    expect(game.closeModal).toHaveBeenCalledTimes(1);
  });

  it('在途旗 → 页签头显示目的地与按当前位置重估的剩余天数', async () => {
    await useGameStub({
      saveProfile: makeProfile({
        lastTileId: 1,
        journey: { toTileId: 4, arriveAtMinute: 999 },
      }),
    });
    vi.mocked(findPath).mockReturnValue({ tilePath: [1, 2, 3, 4], days: 5, crossings: [] });
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    const header = wrapper.find('.pol-chip-journey');
    expect(header.exists()).toBe(true);
    expect(header.text()).toContain('前往乙一');
    expect(header.text()).toContain('约还需 5 天');
  });

  it('玩家未落位 → 「位置未定位」，且路线区如实说不能规划（不瞎指）', async () => {
    await useGameStub({ saveProfile: makeProfile({}) });
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    expect(wrapper.find('.pol-chip-muted').text()).toContain('位置未定位');
    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    expect(wrapper.find('.pol-card').text()).toContain('玩家位置未在地图上定位');
  });

  it('页签来回切不重建（缓存按 contentHash 命中；8.7M 像素解码不该每切一次重来）', async () => {
    await useGameStub({});
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    expect(loadProvinceRaster).toHaveBeenCalledTimes(1);

    const markerTab = wrapper.findAll('.tab-item')[0];
    await markerTab.trigger('click');
    await flushPromises();
    await openPoliticalTab(wrapper);
    expect(loadProvinceRaster).toHaveBeenCalledTimes(1);
  });

  it('中途换了地图包（contentHash 变）→ 再切回来重建，不拿旧像素配新数据', async () => {
    await useGameStub({});
    setContentRegistry({ ...emptyRegistry(), mapPack: MAP_PACK });
    const wrapper = await mountPanel();
    await openPoliticalTab(wrapper);
    expect(loadProvinceRaster).toHaveBeenCalledTimes(1);

    await wrapper.findAll('.tab-item')[0].trigger('click');
    await flushPromises();
    // 换一份包：同样 6 块地，但 hash 与名字都不同
    setContentRegistry({
      ...emptyRegistry(),
      mapPack: {
        ...MAP_PACK,
        contentHash: 'test-hash-2',
        tiles: MAP_PACK.tiles.map((t) => ({ ...t, name: `${t.name}·新` })),
      },
    });
    await openPoliticalTab(wrapper);
    expect(loadProvinceRaster).toHaveBeenCalledTimes(2);

    await wrapper.find('.pol-stage').trigger('click', { clientX: 3, clientY: 0 });
    expect(wrapper.find('.pol-card-title').text()).toBe('乙一·新');
  });

  it('势力页签的源码里也不许出现指向 data/ 的 import', async () => {
    const src = (await import('./MapPoliticalTab.vue?raw')).default;
    const imports = src.match(/^\s*import\s[^;]*;/gm) ?? [];
    expect(imports.filter((line) => /['"][^'"]*\/data\//.test(line))).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════
// 标记落库（修 schedulePersist 空壳）
// ═══════════════════════════════════════════════════════════

describe('MapPanel — 标记落库（schedulePersist 不再是空壳）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
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
    vi.mocked(setMapMarker).mockClear();
    vi.mocked(removeMapMarker).mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    seedPlaceholderRegistry();
    resetContentRegistryLoadedForTests();
  });

  /** 打开工作台并选中第一个标记（进编辑页） */
  async function openEditor(wrapper: VueWrapper): Promise<void> {
    await clickButton(wrapper, '.toolbar-actions', '标记工作台');
    await wrapper.find('.marker-item').trigger('click');
    await wrapper.vm.$nextTick();
  }

  it('改名字 → 防抖后经 setMapMarker 落库（只落改过的那一条）', async () => {
    const profile = makeProfile({}, [{ ...MARKERS[0] }, { ...MARKERS[1] }]);
    await useGameStub({ saveProfile: profile });
    setContentRegistry({ ...emptyRegistry(), markers: MARKERS });
    const wrapper = await mountPanel();
    await openEditor(wrapper);

    vi.useFakeTimers();
    const input = wrapper.find('.workbench-editor .form-input');
    await input.setValue('新营地');
    await input.trigger('change');
    expect(setMapMarker).not.toHaveBeenCalled(); // 防抖窗口内不写

    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await flushPromises();

    expect(setMapMarker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(setMapMarker).mock.calls[0][1]).toMatchObject({
      id: 'm-1',
      name: '新营地',
    });
  });

  it('删除标记 → removeMapMarker', async () => {
    const profile = makeProfile({}, [{ ...MARKERS[0] }, { ...MARKERS[1] }]);
    await useGameStub({ saveProfile: profile });
    setContentRegistry({ ...emptyRegistry(), markers: MARKERS });
    const wrapper = await mountPanel();
    await openEditor(wrapper);

    vi.useFakeTimers();
    await wrapper.find('.workbench-editor .btn-danger').trigger('click');
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await flushPromises();

    expect(removeMapMarker).toHaveBeenCalledTimes(1);
    expect(vi.mocked(removeMapMarker).mock.calls[0][1]).toBe('m-1');
  });

  it('挂载时灌入的预设不算改动 —— 绝不悄悄复制进存档', async () => {
    // 🔴 若挂载本身就落库，内容包此后更新地图标记，这个存档永远看不到（取值口径是
    //    「存档里有就用存档的」）。这条用例守的就是那道静默的单向门。
    await useGameStub({ saveProfile: makeProfile({}, []) });
    setContentRegistry({ ...emptyRegistry(), markers: MARKERS });
    await mountPanel();

    vi.useFakeTimers();
    vi.advanceTimersByTime(2000);
    vi.useRealTimers();
    await flushPromises();

    expect(setMapMarker).not.toHaveBeenCalled();
    expect(removeMapMarker).not.toHaveBeenCalled();
  });

  it('没有存档时不落库也不抛', async () => {
    await useGameStub({ saveProfile: null });
    setContentRegistry({ ...emptyRegistry(), markers: MARKERS });
    const wrapper = await mountPanel();
    await openEditor(wrapper);

    vi.useFakeTimers();
    const input = wrapper.find('.workbench-editor .form-input');
    await input.setValue('无档改名');
    await input.trigger('change');
    vi.advanceTimersByTime(1000);
    vi.useRealTimers();
    await flushPromises();

    expect(setMapMarker).not.toHaveBeenCalled();
  });
});
