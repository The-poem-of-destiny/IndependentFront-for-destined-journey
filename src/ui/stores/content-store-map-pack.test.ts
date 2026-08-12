/**
 * content-store.ts 第 8 面 `mapPack` —— 注册表 → 引擎地图缝的链路测试
 * （地图系统 v1 / 设计 §3.3·§3.4）
 *
 * 🔴 本组守的**不是** `coerceMapPack` 的容错（那在 `map-pack.test.ts`），而是
 * **「有人供值」**：注册表这一面被灌上之后，引擎侧 `map-runtime` 里那一个模块级事实
 * （当前装着哪一份包）必须跟着换。这条链断掉的症状不是报错，是**沿着上一份地图落位**
 * —— 落位、天气、`MAP_CONTEXT`、`$map` 全都读 `getMapPack()`，谁也不读注册表。
 * 先例是 `blurByDefault`：单模块测试能证明逻辑对，**证不了有人供值**。
 *
 * 四条重灌路径逐条覆盖（`setContentRegistry` 是它们共同的唯一失效点）：
 * 首轮占位加载 / 装包 `applyInstall` / 卸载重灌 / 整份替换（= dev overlay 重解析）。
 *
 * 🔴 `import 'fake-indexeddb/auto'` 必须在其它 import 之前：`ensureContentRegistryLoaded()`
 *    内部会先 hydrate 已装内容包，那一步要 Dexie；没有 indexedDB 时那个 await **不 reject、
 *    直接悬着**（`MapPanel.test.ts` 文件头记着同一条）。
 *
 * 🔴 每个用例前后 `resetMapRuntime()`：模块级状态在 vitest 里跨用例存活，装过真包的用例
 *    不还原就会让后面每一个「坏包应当落成空包」的断言悄悄测在一份真包上 —— 那种失败方向
 *    是**变绿**，不是变红。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import {
  useContentStore,
  getContentRegistry,
  seedPlaceholderRegistry,
  setContentRegistry,
  setActivePackRecord,
  ensureContentRegistryLoaded,
  resetContentRegistryLoadedForTests,
  resetPlaceholderHashesCache,
  CONTENT_REGISTRY_SOURCES,
  MAP_PROVINCES_URL,
} from './content-store';
import { getDatabase } from '@engine/database';
import { isEmptyMapPack } from '@engine/map-pack';
import { getMapIndex, getMapPack, resetMapRuntime } from '@engine/map-runtime';
import type { ContentPack } from '@engine/types-content';

const MAP_PACK_URL = '/data/content/map-pack.json';

// ── 夹具 ──

/**
 * 一块能活过 `coerceMapPack` 的地块。
 *
 * 🔴 `centroid` 不是装饰：缺形心的条目会被**整条跳过**（形心参与代价计算，`[0,0]` 兜底
 *    会让这块地贴在原点上）。少写它，这里的「非空包」断言就会测在一个空包上。
 */
function tile(id: number, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    terrain: 'plain',
    water: null,
    impassable: false,
    countryId: 'country_a',
    midTierId: 'mid_a',
    centroid: [id * 10, id * 10],
    areaPx: 100,
    ...extra,
  };
}

/** 一份最小但完整的地图包正文（形状 = 落盘的 `map-pack.json` 本身，没有外层 `data` 壳） */
function mapPackBody(version: string, tiles: unknown[] = [tile(1, 'Alpha'), tile(2, 'Bravo')]) {
  return {
    version,
    contentHash: `${version}-hash`,
    resolution: { w: 100, h: 100 },
    kmPerPx: 1,
    terrains: ['plain'],
    travelRules: {
      rates: { land: 30, nearSea: 60, farSea: 90 },
      embarkCost: 10,
      terrainFactor: { plain: 1 },
    },
    countries: [{ id: 'country_a', name: 'Country A', color: [1, 2, 3], anchorTileId: 1 }],
    midTiers: [{ id: 'mid_a', name: 'Mid A', countryId: 'country_a', climateId: 'climate_a' }],
    climates: {},
    tiles,
    adjacency: [[1, 2, 50]],
    straits: [],
    placeBindings: { Alpha: 1 },
  };
}

/** 占位内容树的应答（只有地图那面要真形状，其余面本组不关心） */
const PLACEHOLDER_BODIES: Record<string, unknown> = {
  [MAP_PACK_URL]: mapPackBody('placeholder-map'),
  '/data/content/catalog.json': { pools: [] },
  '/data/content/locations.json': [],
  '/data/content/bloodlines.json': { bloodlines: [] },
  '/data/content/name-pools.json': { given: [] },
  '/data/content/branding.json': { appTitle: 'Placeholder Engine' },
  '/data/content/image-dialects.json': { dialects: [] },
  '/data/defaults/map-marker-presets.json': [],
};

/**
 * 逐 URL 应答的 fetch mock（照 content-store-registry.test.ts 的口径）。
 *
 * @param overrides `'404'` → 404；`'invalid-json'` → 200 但正文不是 JSON；
 *                  `'network'` → fetch 本身 reject；其它值 → 200 + 该 JSON
 */
function installFetchMock(overrides: Record<string, unknown> = {}): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    const override = overrides[url];
    if (override === 'network') throw new Error('network down');
    if (override === '404') return new Response('not found', { status: 404 });
    if (override === 'invalid-json') return new Response('<html>nope</html>', { status: 200 });
    const body = override !== undefined ? override : PLACEHOLDER_BODIES[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
}

/** 只声明 mapPack 分节的最小内容包（其余分节缺席 → 占位赢，D20 三态） */
function makeMapPack(version = '1.0.0'): ContentPack {
  return {
    formatVersion: 1,
    packId: 'map-content-pack',
    packVersion: version,
    name: '地图内容包',
    mapPack: mapPackBody('pack-map') as unknown as ContentPack['mapPack'],
  } as ContentPack;
}

/** 把 pack 直接写进 Dexie（加载器内部 hydrate 会把它捞进模块缓存，与 boot 真实路径同形） */
async function seedPackRecord(pack: ContentPack): Promise<void> {
  await getDatabase().contentPacks.put({
    packId: pack.packId,
    packVersion: pack.packVersion,
    installedAt: Date.now(),
    payload: pack,
  });
}

async function cleanDb(): Promise<void> {
  const db = getDatabase();
  await db.contentPacks.clear();
  await db.worldBooks.clear();
  await db.presets.clear();
  await db.saves.clear();
  setActivePackRecord(null);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await cleanDb();
  resetMapRuntime();
  seedPlaceholderRegistry();
  resetContentRegistryLoadedForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanDb();
  resetPlaceholderHashesCache();
  resetMapRuntime();
  seedPlaceholderRegistry();
  resetContentRegistryLoadedForTests();
});

describe('第 8 面 mapPack —— 面注册与资源约定', () => {
  it('面在加载表里，URL 约定 `/data/content/map-pack.json`', () => {
    const byFace = Object.fromEntries(CONTENT_REGISTRY_SOURCES.map((s) => [s.face, s.url]));
    expect(byFace.mapPack).toBe(MAP_PACK_URL);
  });

  it('骨架里 mapPack 键齐（值 undefined，键不能缺）', () => {
    expect('mapPack' in getContentRegistry()).toBe(true);
    expect(getContentRegistry().mapPack).toBeUndefined();
  });

  it('provinces.png 是常量 URL 而**不是**注册表的一面（字节不进注册表）', () => {
    expect(MAP_PROVINCES_URL).toBe('/data/content/provinces.png');
    // 🔴 它进了加载表就会被当成 JSON 去 `res.json()`，每次启动都多一条假的失败上报
    expect(CONTENT_REGISTRY_SOURCES.some((s) => s.url === MAP_PROVINCES_URL)).toBe(false);
  });
});

describe('第 8 面 mapPack —— 首轮占位加载装上包', () => {
  it('占位 fetch 成功 → 引擎侧装的是非空包（索引也按新包重建）', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();

    const pack = getMapPack();
    expect(isEmptyMapPack(pack)).toBe(false);
    expect(pack.version).toBe('placeholder-map');
    expect(pack.tiles.map((t) => t.name)).toEqual(['Alpha', 'Bravo']);
    // 索引跟着包换（`installMapPack` 是那份缓存唯一的失效点）
    expect(getMapIndex().tileIdByName.exact.get('Alpha')).toBe(1);
  });

  it('注册表那一面留的是**原始 JSON**（收窄只发生在引擎缝里）', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(getContentRegistry().mapPack).toEqual(mapPackBody('placeholder-map'));
  });

  it('boot 收口入口 loadProjectDefaults 也会把地图装上（不必谁另外去调）', async () => {
    installFetchMock({ '/data/defaults/agent-config.json': { version: 1, agents: {} } });
    await useContentStore().loadProjectDefaults();
    expect(isEmptyMapPack(getMapPack())).toBe(false);
  });
});

describe('第 8 面 mapPack —— 坏包一律落成空包且不抛（应用照常起）', () => {
  it('JSON 解析失败 → 空包 + 不抛 + 上报失败', async () => {
    installFetchMock({ [MAP_PACK_URL]: 'invalid-json' });
    const c = useContentStore();
    await expect(ensureContentRegistryLoaded()).resolves.toBeUndefined();
    expect(isEmptyMapPack(getMapPack())).toBe(true);
    expect(c.fetchReports.some((r) => !r.ok && r.source === 'content-registry:mapPack')).toBe(true);
  });

  it('404 → 空包（这一面缺席不是错误：落位永远 null、天气不断言）', async () => {
    installFetchMock({ [MAP_PACK_URL]: '404' });
    await ensureContentRegistryLoaded();
    expect(isEmptyMapPack(getMapPack())).toBe(true);
    // 其余面照常灌上 —— 地图坏了不牵连别人
    expect(getContentRegistry().branding).toEqual({ appTitle: 'Placeholder Engine' });
  });

  it('网络异常 → 空包（fetch 自身 reject）', async () => {
    installFetchMock({ [MAP_PACK_URL]: 'network' });
    await expect(ensureContentRegistryLoaded()).resolves.toBeUndefined();
    expect(isEmptyMapPack(getMapPack())).toBe(true);
  });

  it('整份不是对象（裸数组）→ 空包', async () => {
    installFetchMock({ [MAP_PACK_URL]: [1, 2, 3] });
    await ensureContentRegistryLoaded();
    expect(isEmptyMapPack(getMapPack())).toBe(true);
  });

  it('地块条目坏（缺形心 / 缺名字）→ 逐条跳过，跳空了就是空包', async () => {
    installFetchMock({
      [MAP_PACK_URL]: mapPackBody('broken-tiles', [
        { id: 1, name: 'NoCentroid' },
        { id: 2, centroid: [1, 2] },
        'not-an-object',
      ]),
    });
    await ensureContentRegistryLoaded();
    expect(isEmptyMapPack(getMapPack())).toBe(true);
    // 但注册表那一面仍是原文（回落发生在缝里，不改注册表）
    expect((getContentRegistry().mapPack as { version?: string }).version).toBe('broken-tiles');
  });

  it('一块好一块坏 → 半懂的包照样装上（好的那块在图上）', async () => {
    installFetchMock({
      [MAP_PACK_URL]: mapPackBody('half-good', [tile(1, 'Alpha'), { id: 2, name: 'NoCentroid' }]),
    });
    await ensureContentRegistryLoaded();
    expect(getMapPack().tiles.map((t) => t.name)).toEqual(['Alpha']);
  });
});

describe('第 8 面 mapPack —— 四条重灌路径都重新装包', () => {
  it('① 已装 pack 的 mapPack 分节赢过占位 fetch（整节替换，无 `.data` 壳）', async () => {
    await seedPackRecord(makeMapPack());
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(getMapPack().version).toBe('pack-map');
    expect(getContentRegistry().mapPack).toEqual(mapPackBody('pack-map'));
  });

  it('① pack 未声明 mapPack → 回落占位地图（三态里的 absent）', async () => {
    const bare = makeMapPack();
    delete (bare as { mapPack?: unknown }).mapPack;
    await seedPackRecord(bare);
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(getMapPack().version).toBe('placeholder-map');
  });

  it('② 真装包（installPack → applyInstall）后装的是 pack 的地图', async () => {
    installFetchMock();
    const c = useContentStore();
    // 先跑一轮占位加载（与真机同序：boot 装占位地图，之后用户装包）
    await ensureContentRegistryLoaded();
    expect(getMapPack().version).toBe('placeholder-map');

    const outcome = await c.installPack(makeMapPack());
    expect(outcome.ok).toBe(true);
    // 🔴 applyInstall 的注册表重灌漏了这一面时，这里仍然是 placeholder-map —— 不报错、
    //    只是从此沿着占位地图落位
    expect(getMapPack().version).toBe('pack-map');
    expect(isEmptyMapPack(getMapPack())).toBe(false);
  });

  it('③ 卸载后回落占位地图（卸载流的注册表重灌把图也换回来）', async () => {
    installFetchMock();
    const c = useContentStore();
    await ensureContentRegistryLoaded();
    await c.installPack(makeMapPack());
    expect(getMapPack().version).toBe('pack-map');

    const out = await c.uninstallPack({ confirmEdits: true });
    expect(out.ok).toBe(true);
    expect(getMapPack().version).toBe('placeholder-map');
  });

  it('③ 卸载中间态：seedPlaceholderRegistry 把地图清回空包', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(isEmptyMapPack(getMapPack())).toBe(false);
    // 🔴 清注册表不连带清地图，卸载与重拉占位之间那一段就仍沿旧图落位
    seedPlaceholderRegistry();
    expect(isEmptyMapPack(getMapPack())).toBe(true);
  });

  it('④ 整份替换即换图（dev overlay 重解析走的就是这条）', () => {
    setContentRegistry({ ...getContentRegistry(), mapPack: mapPackBody('overlay-map') });
    expect(getMapPack().version).toBe('overlay-map');
    expect(getMapIndex().tileIdByName.exact.get('Alpha')).toBe(1);

    // 换成另一份 → 包与索引一起换（索引缓存不失效的症状是沿旧图落位）
    setContentRegistry({
      ...getContentRegistry(),
      mapPack: mapPackBody('overlay-map-2', [tile(7, 'Golf')]),
    });
    expect(getMapPack().version).toBe('overlay-map-2');
    expect(getMapIndex().tileIdByName.exact.has('Alpha')).toBe(false);
    expect(getMapIndex().tileIdByName.exact.get('Golf')).toBe(7);
  });

  it('④ 替换成缺席（这一面被清掉）→ 空包，不是留着上一份', () => {
    setContentRegistry({ ...getContentRegistry(), mapPack: mapPackBody('overlay-map') });
    setContentRegistry({ ...getContentRegistry(), mapPack: undefined });
    expect(isEmptyMapPack(getMapPack())).toBe(true);
  });
});
