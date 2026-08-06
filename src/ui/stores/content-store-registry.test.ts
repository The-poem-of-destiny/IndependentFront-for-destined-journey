/**
 * content-store.ts 注册表占位加载器测试（波 2 T8a / D16 / D20 / §5.1）
 *
 * 🔴 覆盖的是**波 2 七个抽取任务共用的那条加载路径**：六面各自 fetch
 * `/data/content/<name>.json`（markers 例外，见 CONTENT_REGISTRY_SOURCES），
 * 逐面独立失败、memoize 一轮、pack 赢过占位。
 *
 * 🔴 fetch **全部 mock**：本 PR 里六个 JSON 只有 `map-marker-presets.json` 真实存在，
 * 其余五个由并行任务在同一 PR 内产出——测试不许依赖它们已落盘。
 */
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';

import {
  useContentStore,
  getContentRegistry,
  seedPlaceholderRegistry,
  setActivePackRecord,
  ensureContentRegistryLoaded,
  resetContentRegistryLoadedForTests,
  CONTENT_REGISTRY_SOURCES,
} from './content-store';
import { getDatabase } from '@engine/database';
import type { ContentPack } from '@engine/types-content';

// ── 夹具 ──

/** 六面的占位内容（值形状随意——注册表各面是 `unknown`，形状由波 2 各任务收窄） */
const PLACEHOLDER_BODIES: Record<string, unknown> = {
  '/data/content/catalog.json': { pools: ['catalog-placeholder'] },
  '/data/content/locations.json': [{ id: 'loc-placeholder' }],
  '/data/content/bloodlines.json': { bloodlines: [{ id: 'bl-placeholder' }] },
  '/data/content/name-pools.json': { given: ['name-placeholder'] },
  '/data/content/branding.json': { appTitle: 'Placeholder Engine' },
  '/data/defaults/map-marker-presets.json': [{ id: 'marker-placeholder' }],
};

/**
 * 装一个逐 URL 应答的 fetch mock。
 *
 * @param overrides 逐 URL 覆写：`'404'` → 404 响应；`'invalid-json'` → 200 但正文不是 JSON；
 *                  `'network'` → fetch 本身 reject；其它值 → 200 + 该 JSON
 */
function installFetchMock(overrides: Record<string, unknown> = {}): {
  spy: ReturnType<typeof vi.spyOn>;
  urls: string[];
} {
  const urls: string[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    urls.push(url);
    const override = overrides[url];
    if (override === 'network') throw new Error('network down');
    if (override === '404') return new Response('not found', { status: 404 });
    if (override === 'invalid-json') return new Response('<html>nope</html>', { status: 200 });
    const body = override !== undefined ? override : PLACEHOLDER_BODIES[url];
    if (body === undefined) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200 });
  });
  return { spy: spy as ReturnType<typeof vi.spyOn>, urls };
}

/** 只声明注册表相关分节的最小 pack（其余分节缺席 → 占位赢） */
function makeRegistryPack(): ContentPack {
  return {
    formatVersion: 1,
    packId: 'registry-pack',
    packVersion: '1.0.0',
    name: '注册表测试包',
    catalog: { data: { pools: ['catalog-from-pack'] } },
    namePools: { data: { given: ['name-from-pack'] } },
    branding: { appTitle: 'Pack Engine' },
  } as ContentPack;
}

async function cleanDb(): Promise<void> {
  const db = getDatabase();
  await db.contentPacks.clear();
  setActivePackRecord(null);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await cleanDb();
  seedPlaceholderRegistry();
  resetContentRegistryLoadedForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanDb();
  seedPlaceholderRegistry();
  resetContentRegistryLoadedForTests();
});

describe('ensureContentRegistryLoaded —— URL 约定', () => {
  it('六面齐全，且 markers 走 /data/defaults/（不在 content/ 下）', () => {
    expect(CONTENT_REGISTRY_SOURCES.map((s) => s.face).sort()).toEqual([
      'bloodlines',
      'branding',
      'catalog',
      'locations',
      'markers',
      'namePools',
    ]);
    const byFace = Object.fromEntries(CONTENT_REGISTRY_SOURCES.map((s) => [s.face, s.url]));
    expect(byFace.catalog).toBe('/data/content/catalog.json');
    expect(byFace.locations).toBe('/data/content/locations.json');
    expect(byFace.bloodlines).toBe('/data/content/bloodlines.json');
    expect(byFace.namePools).toBe('/data/content/name-pools.json');
    expect(byFace.branding).toBe('/data/content/branding.json');
    // 🔴 地图标记预设今天就住在 data/defaults/，抽取时不搬家
    expect(byFace.markers).toBe('/data/defaults/map-marker-presets.json');
  });
});

describe('ensureContentRegistryLoaded —— 逐面加载', () => {
  it('六面全成功 → 六面都灌上占位值', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();
    const r = getContentRegistry();
    expect(r.catalog).toEqual({ pools: ['catalog-placeholder'] });
    expect(r.locations).toEqual([{ id: 'loc-placeholder' }]);
    expect(r.bloodlines).toEqual({ bloodlines: [{ id: 'bl-placeholder' }] });
    expect(r.namePools).toEqual({ given: ['name-placeholder'] });
    expect(r.branding).toEqual({ appTitle: 'Placeholder Engine' });
    expect(r.markers).toEqual([{ id: 'marker-placeholder' }]);
  });

  it('单面 404 → 只有该面保持原值，其余五面照常灌上 + 上报失败', async () => {
    installFetchMock({ '/data/content/locations.json': '404' });
    const c = useContentStore();
    await ensureContentRegistryLoaded();
    const r = getContentRegistry();
    expect(r.locations).toBeUndefined(); // 失败面保持原值（空骨架）
    expect(r.catalog).toEqual({ pools: ['catalog-placeholder'] });
    expect(r.markers).toEqual([{ id: 'marker-placeholder' }]);
    const failed = c.fetchReports.filter((rep) => !rep.ok);
    expect(failed.map((rep) => rep.source)).toEqual(['content-registry:locations']);
    expect(failed[0].status).toBe(404);
  });

  it('单面 JSON 解析失败 → 与 404 同档（该面保持原值 + 上报失败，不抛）', async () => {
    installFetchMock({ '/data/content/catalog.json': 'invalid-json' });
    const c = useContentStore();
    await expect(ensureContentRegistryLoaded()).resolves.toBeUndefined();
    expect(getContentRegistry().catalog).toBeUndefined();
    expect(getContentRegistry().bloodlines).toEqual({ bloodlines: [{ id: 'bl-placeholder' }] });
    expect(c.fetchReports.some((rep) => !rep.ok && rep.source === 'content-registry:catalog')).toBe(
      true,
    );
  });

  it('单面网络异常 → 不影响其余五面（fetch 自身 reject）', async () => {
    installFetchMock({ '/data/content/branding.json': 'network' });
    const c = useContentStore();
    await ensureContentRegistryLoaded();
    expect(getContentRegistry().branding).toBeUndefined();
    expect(getContentRegistry().namePools).toEqual({ given: ['name-placeholder'] });
    const rep = c.fetchReports.find((x) => x.source === 'content-registry:branding');
    expect(rep?.ok).toBe(false);
    expect(rep?.error).toContain('network down');
  });

  it('六面全 404 → 不抛、骨架仍非 null 且六键齐（应用不崩）', async () => {
    installFetchMock(
      Object.fromEntries(CONTENT_REGISTRY_SOURCES.map((s) => [s.url, '404'])) as Record<
        string,
        unknown
      >,
    );
    await expect(ensureContentRegistryLoaded()).resolves.toBeUndefined();
    const r = getContentRegistry();
    expect(r).not.toBeNull();
    expect(Object.keys(r).sort()).toEqual([
      'bloodlines',
      'branding',
      'catalog',
      'locations',
      'markers',
      'namePools',
    ]);
    expect(Object.values(r).every((v) => v === undefined)).toBe(true);
  });

  it('memoize：重复调只 fetch 一轮（六次）', async () => {
    const { urls } = installFetchMock();
    await ensureContentRegistryLoaded();
    await ensureContentRegistryLoaded();
    await Promise.all([ensureContentRegistryLoaded(), ensureContentRegistryLoaded()]);
    expect(urls).toHaveLength(CONTENT_REGISTRY_SOURCES.length);
  });

  it('并发首调共享同一 promise（不会 fetch 两轮）', async () => {
    const { urls } = installFetchMock();
    const a = ensureContentRegistryLoaded();
    const b = ensureContentRegistryLoaded();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(urls).toHaveLength(CONTENT_REGISTRY_SOURCES.length);
  });

  it('resetContentRegistryLoadedForTests 之后会重新 fetch', async () => {
    const { urls } = installFetchMock();
    await ensureContentRegistryLoaded();
    resetContentRegistryLoadedForTests();
    await ensureContentRegistryLoaded();
    expect(urls).toHaveLength(CONTENT_REGISTRY_SOURCES.length * 2);
  });
});

describe('ensureContentRegistryLoaded —— pack 优先（D20 三态）', () => {
  /** 把 pack 写进 Dexie：加载器内部 hydrate 会把它捞进模块缓存（与 boot 真实路径同形） */
  async function installPackRecord(pack: ContentPack): Promise<void> {
    await getDatabase().contentPacks.put({
      packId: pack.packId,
      packVersion: pack.packVersion,
      installedAt: Date.now(),
      payload: pack,
    });
  }

  it('pack 声明的分节赢过占位 fetch；未声明的分节回落占位', async () => {
    await installPackRecord(makeRegistryPack());
    installFetchMock();
    await ensureContentRegistryLoaded();
    const r = getContentRegistry();
    // pack 声明的三面（catalog/namePools 取 .data，branding 整节）
    expect(r.catalog).toEqual({ pools: ['catalog-from-pack'] });
    expect(r.namePools).toEqual({ given: ['name-from-pack'] });
    expect(r.branding).toEqual({ appTitle: 'Pack Engine' });
    // pack 没声明的三面 → 占位 fetch 结果
    expect(r.locations).toEqual([{ id: 'loc-placeholder' }]);
    expect(r.bloodlines).toEqual({ bloodlines: [{ id: 'bl-placeholder' }] });
    expect(r.markers).toEqual([{ id: 'marker-placeholder' }]);
  });

  it('占位 fetch 全 404 时 pack 分节照样在（失败面不抹 pack 值）', async () => {
    await installPackRecord(makeRegistryPack());
    installFetchMock(
      Object.fromEntries(CONTENT_REGISTRY_SOURCES.map((s) => [s.url, '404'])) as Record<
        string,
        unknown
      >,
    );
    await ensureContentRegistryLoaded();
    expect(getContentRegistry().catalog).toEqual({ pools: ['catalog-from-pack'] });
    expect(getContentRegistry().locations).toBeUndefined();
  });

  it('装包后再跑一轮加载不会把 pack 面冲掉（memo 已生效 → 零 fetch）', async () => {
    await installPackRecord(makeRegistryPack());
    const { urls } = installFetchMock();
    await ensureContentRegistryLoaded();
    const before = getContentRegistry().catalog;
    await ensureContentRegistryLoaded();
    expect(getContentRegistry().catalog).toBe(before);
    expect(urls).toHaveLength(CONTENT_REGISTRY_SOURCES.length);
  });

  it('即使重置 memo 重跑，pack 面仍然赢（规则 2 与 memo 无关）', async () => {
    await installPackRecord(makeRegistryPack());
    installFetchMock();
    await ensureContentRegistryLoaded();
    resetContentRegistryLoadedForTests();
    await ensureContentRegistryLoaded();
    expect(getContentRegistry().catalog).toEqual({ pools: ['catalog-from-pack'] });
    expect(getContentRegistry().branding).toEqual({ appTitle: 'Pack Engine' });
  });
});

describe('loadProjectDefaults —— 接进 boot 链但语义不变', () => {
  it('成功路径：仍返回 agent-config.json 的内容，且顺带灌好注册表', async () => {
    const payload = { version: 1, agents: { story: { model: 'gpt-4' } } };
    installFetchMock({ '/data/defaults/agent-config.json': payload });
    const c = useContentStore();
    const result = (await c.loadProjectDefaults()) as { version: number };
    expect(result.version).toBe(1);
    expect(getContentRegistry().catalog).toEqual({ pools: ['catalog-placeholder'] });
    expect(c.contentStatus).toBe('placeholder');
  });

  it('六面全 404 时 loadProjectDefaults 行为与今日一致（返回值不受影响、不抛）', async () => {
    const payload = { version: 1, agents: { story: { model: 'gpt-4' } } };
    installFetchMock({
      ...(Object.fromEntries(CONTENT_REGISTRY_SOURCES.map((s) => [s.url, '404'])) as Record<
        string,
        unknown
      >),
      '/data/defaults/agent-config.json': payload,
    });
    const c = useContentStore();
    const result = (await c.loadProjectDefaults()) as { version: number };
    expect(result.version).toBe(1);
    // 六面缺席只让内容态可见（§5.5 census），不改返回值、不阻塞启动
    expect(getContentRegistry().catalog).toBeUndefined();
  });

  it('agent-config 自身 404 时仍回落空骨架（原语义）', async () => {
    installFetchMock({ '/data/defaults/agent-config.json': '404' });
    const c = useContentStore();
    const result = await c.loadProjectDefaults();
    expect(result).toEqual({ version: 1, agents: {} });
    expect(c.contentStatus).toBe('error');
  });

  it('注册表加载只在首次 loadProjectDefaults 时发生（后续调用零额外 fetch）', async () => {
    const payload = { version: 1, agents: {} };
    const { urls } = installFetchMock({ '/data/defaults/agent-config.json': payload });
    const c = useContentStore();
    await c.loadProjectDefaults();
    const afterFirst = urls.length;
    await c.loadProjectDefaults();
    // 第二轮只多了 agent-config 自己那一次
    expect(urls.length - afterFirst).toBe(1);
  });
});
