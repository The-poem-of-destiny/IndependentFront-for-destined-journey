/**
 * content-store.ts 第 13 面 `randomEvents` —— 注册表 → 引擎随机事件缝的链路测试
 * （随机事件系统 v1 / 设计 §3.3）
 *
 * 🔴 本组守的**不是** `coerceRandomEventPack` 的容错（那在 `random-event-pack.test.ts`），
 * 而是**「有人供值」**：注册表这一面被灌上之后，引擎侧 `random-event-runtime` 里那一个
 * 模块级事实（当前装着哪一份事件包）必须跟着换。这条链断掉的症状不是报错，是
 * **一条事件都不触发**（空包 → 四条钩子整段 no-op），或者换包之后**沿着上一份事件包掷骰**。
 * 先例逐字同 `content-store-map-pack.test.ts`（第 8 面），以及在它之前的 `blurByDefault`：
 * 单模块测试能证明逻辑对，**证不了有人供值**。
 *
 * 🔴 `import 'fake-indexeddb/auto'` 必须在其它 import 之前：`ensureContentRegistryLoaded()`
 *    内部会先 hydrate 已装内容包，那一步要 Dexie；没有 indexedDB 时那个 await **不 reject、
 *    直接悬着**。
 *
 * 🔴 每个用例前后 `resetRandomEventRuntime()`：模块级状态在 vitest 里跨用例存活，装过真包的
 *    用例不还原就会让后面每一个「空包应当整段 no-op」的断言悄悄测在一份真包上 —— 那种失败
 *    方向是**变绿**，不是变红。
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
} from './content-store';
import { getDatabase } from '@engine/database';
import { isEmptyRandomEventPack } from '@engine/random-event-pack';
import { getRandomEventPack, resetRandomEventRuntime } from '@engine/random-event-runtime';
import { DEFAULT_RANDOM_EVENT_CONFIG } from '@engine/types-random-events';
import type { ContentPack } from '@engine/types-content';

const RANDOM_EVENTS_URL = '/data/content/random-events.json';

// ── 夹具 ──

/** 一条能活过 `coerceRandomEventPack` 的最小 mtth 定义（name / brief / trigger 三样缺一不可） */
function def(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    brief: `${name}的简报`,
    trigger: { type: 'mtth', mtthDays: 20 },
    ...extra,
  };
}

/** 一份最小但完整的事件包正文（形状 = 落盘的 `random-events.json` 本身，没有外层 `data` 壳） */
function eventsBody(names: string[], config?: Record<string, unknown>) {
  return {
    ...(config ? { config } : {}),
    defs: names.map((n) => def(n)),
  };
}

/** 占位内容树的应答（只有随机事件那面要真形状，其余面本组不关心） */
const PLACEHOLDER_BODIES: Record<string, unknown> = {
  [RANDOM_EVENTS_URL]: eventsBody(['占位事件甲', '占位事件乙']),
  '/data/content/catalog.json': { pools: [] },
  '/data/content/locations.json': [],
  '/data/content/bloodlines.json': { bloodlines: [] },
  '/data/content/name-pools.json': { given: [] },
  '/data/content/branding.json': { appTitle: 'Placeholder Engine' },
  '/data/content/image-dialects.json': { dialects: [] },
  '/data/content/map-pack.json': { version: 'placeholder-map', tiles: [] },
  '/data/defaults/map-marker-presets.json': [],
};

/**
 * 逐 URL 应答的 fetch mock（照 content-store-map-pack.test.ts 的口径）。
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

/** 只声明 randomEvents 分节的最小内容包（其余分节缺席 → 占位赢，D20 三态） */
function makeEventsPack(names = ['包内事件甲']): ContentPack {
  return {
    formatVersion: 1,
    packId: 'random-events-pack',
    packVersion: '1.0.0',
    name: '随机事件内容包',
    randomEvents: eventsBody(names) as unknown as ContentPack['randomEvents'],
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

/** 现行包里的事件名（断言用；顺序 = 包里的书写顺序） */
function installedNames(): string[] {
  return getRandomEventPack().defs.map((d) => d.name);
}

beforeEach(async () => {
  setActivePinia(createPinia());
  await cleanDb();
  resetRandomEventRuntime();
  seedPlaceholderRegistry();
  resetContentRegistryLoadedForTests();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanDb();
  resetPlaceholderHashesCache();
  resetRandomEventRuntime();
  seedPlaceholderRegistry();
  resetContentRegistryLoadedForTests();
});

describe('第 13 面 randomEvents —— 面注册与骨架', () => {
  it('面在加载表里，URL 约定 `/data/content/random-events.json`', () => {
    const byFace = Object.fromEntries(CONTENT_REGISTRY_SOURCES.map((s) => [s.face, s.url]));
    expect(byFace.randomEvents).toBe(RANDOM_EVENTS_URL);
  });

  it('骨架里 randomEvents 键齐（值 undefined，键不能缺）', () => {
    expect('randomEvents' in getContentRegistry()).toBe(true);
    expect(getContentRegistry().randomEvents).toBeUndefined();
  });

  it('没人装过 → 空包 + 默认 config（兜底合同，不是异常）', () => {
    const pack = getRandomEventPack();
    expect(isEmptyRandomEventPack(pack)).toBe(true);
    expect(pack.config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
  });
});

describe('第 13 面 randomEvents —— 首轮占位加载装上包', () => {
  it('占位 fetch 成功 → 引擎侧装的是非空包', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();

    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(false);
    expect(installedNames()).toEqual(['占位事件甲', '占位事件乙']);
  });

  it('注册表那一面留的是**原始 JSON**（收窄只发生在引擎缝里）', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(getContentRegistry().randomEvents).toEqual(eventsBody(['占位事件甲', '占位事件乙']));
  });

  it('boot 收口入口 loadProjectDefaults 也会把事件包装上（不必谁另外去调）', async () => {
    installFetchMock({ '/data/defaults/agent-config.json': { version: 1, agents: {} } });
    await useContentStore().loadProjectDefaults();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(false);
  });

  it('包里的 config 跟着一起进引擎（三格部分覆盖，其余取默认）', async () => {
    installFetchMock({
      [RANDOM_EVENTS_URL]: eventsBody(['占位事件甲'], { maxPending: 7 }),
    });
    await ensureContentRegistryLoaded();
    expect(getRandomEventPack().config).toEqual({
      ...DEFAULT_RANDOM_EVENT_CONFIG,
      maxPending: 7,
    });
  });

  it('仓库里真实落盘的占位文件本身能被解析成非空包', async () => {
    // 🔴 这条不 mock 那一面，用**真文件字节**：占位集写坏（少个 brief / trigger 写成
    //    不认识的 type）时，coerce 会把定义整条跳过而**不报错** —— 症状是「装了包却一条
    //    事件都不起」。fixtures 全绿也照样漏，只有喂真字节才拦得住。
    const raw = await import('../../../public/data/content/random-events.json');
    installFetchMock({ [RANDOM_EVENTS_URL]: raw.default ?? raw });
    await ensureContentRegistryLoaded();
    const pack = getRandomEventPack();
    expect(isEmptyRandomEventPack(pack)).toBe(false);
    // 两条示例（一条 mtth 无 available、一条 mtth 带 available + 权重 ×0）都要活下来
    expect(pack.defs).toHaveLength(2);
    expect(pack.config).toEqual(DEFAULT_RANDOM_EVENT_CONFIG);
    // 🔴 占位集**刻意没有 first_visit**（裁定 §13-3：scope 必填、只认点名地块，
    //    而公开仓的占位地图没有可指的权威地名）
    expect(pack.defs.every((d) => d.trigger.type === 'mtth')).toBe(true);
    // 一条带硬门槛 + 一条 ×0 权重（示范「在途时城内事件不触发」，设计 §12）
    expect(pack.defs.some((d) => d.available !== undefined)).toBe(true);
    expect(pack.defs.some((d) => d.weights?.some((w) => w.multiply === 0))).toBe(true);
  });
});

describe('第 13 面 randomEvents —— 缺席/坏包一律落成空包且不抛（应用照常起）', () => {
  it('404 → 空包（这一面缺席不是错误：四条钩子整段 no-op）', async () => {
    installFetchMock({ [RANDOM_EVENTS_URL]: '404' });
    await ensureContentRegistryLoaded();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
    // 其余面照常灌上 —— 事件包缺席不牵连别人
    expect(getContentRegistry().branding).toEqual({ appTitle: 'Placeholder Engine' });
  });

  it('JSON 解析失败 → 空包 + 不抛 + 上报失败', async () => {
    installFetchMock({ [RANDOM_EVENTS_URL]: 'invalid-json' });
    const c = useContentStore();
    await expect(ensureContentRegistryLoaded()).resolves.toBeUndefined();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
    expect(c.fetchReports.some((r) => !r.ok && r.source === 'content-registry:randomEvents')).toBe(
      true,
    );
  });

  it('网络异常 → 空包（fetch 自身 reject）', async () => {
    installFetchMock({ [RANDOM_EVENTS_URL]: 'network' });
    await expect(ensureContentRegistryLoaded()).resolves.toBeUndefined();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
  });

  it('整份不是对象（裸数组）→ 空包', async () => {
    installFetchMock({ [RANDOM_EVENTS_URL]: [def('甲')] });
    await ensureContentRegistryLoaded();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
  });

  it('一条好一条坏 → 半懂的包照样装上（好的那条在池子候选里）', async () => {
    installFetchMock({
      [RANDOM_EVENTS_URL]: { defs: [def('好事件'), { name: '缺简报的事件' }] },
    });
    await ensureContentRegistryLoaded();
    expect(installedNames()).toEqual(['好事件']);
  });

  it('`defs: []`（刻意清空）→ 空包，但注册表那一面仍是原文', async () => {
    installFetchMock({ [RANDOM_EVENTS_URL]: { defs: [] } });
    await ensureContentRegistryLoaded();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
    expect(getContentRegistry().randomEvents).toEqual({ defs: [] });
  });
});

describe('第 13 面 randomEvents —— 四条重灌路径都重新装包', () => {
  it('① 已装 pack 的 randomEvents 分节赢过占位 fetch（整节替换，无 `.data` 壳）', async () => {
    await seedPackRecord(makeEventsPack());
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(installedNames()).toEqual(['包内事件甲']);
    expect(getContentRegistry().randomEvents).toEqual(eventsBody(['包内事件甲']));
  });

  it('① pack 未声明 randomEvents → 回落占位事件包（三态里的 absent）', async () => {
    const bare = makeEventsPack();
    delete (bare as { randomEvents?: unknown }).randomEvents;
    await seedPackRecord(bare);
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(installedNames()).toEqual(['占位事件甲', '占位事件乙']);
  });

  it('② 真装包（installPack → applyInstall）后装的是 pack 的事件包', async () => {
    installFetchMock();
    const c = useContentStore();
    // 先跑一轮占位加载（与真机同序：boot 装占位事件，之后用户装包）
    await ensureContentRegistryLoaded();
    expect(installedNames()).toEqual(['占位事件甲', '占位事件乙']);

    const outcome = await c.installPack(makeEventsPack(['包内事件甲', '包内事件乙']));
    expect(outcome.ok).toBe(true);
    // 🔴 applyInstall 的注册表重灌漏了这一面时，这里仍然是占位那两条 —— 不报错、
    //    只是从此沿着占位事件包掷骰，pack 里的事件永不出现
    expect(installedNames()).toEqual(['包内事件甲', '包内事件乙']);
  });

  it('② 装包计划里这一节是整节替换（updated 收整个分节）', async () => {
    installFetchMock();
    const c = useContentStore();
    await ensureContentRegistryLoaded();
    const outcome = await c.installPack(makeEventsPack());
    expect(outcome.plan?.sections.randomEvents?.updated).toEqual([eventsBody(['包内事件甲'])]);
  });

  it('③ 卸载后回落占位事件包（卸载流的注册表重灌把包也换回来）', async () => {
    installFetchMock();
    const c = useContentStore();
    await ensureContentRegistryLoaded();
    await c.installPack(makeEventsPack());
    expect(installedNames()).toEqual(['包内事件甲']);

    const out = await c.uninstallPack({ confirmEdits: true });
    expect(out.ok).toBe(true);
    expect(installedNames()).toEqual(['占位事件甲', '占位事件乙']);
  });

  it('③ 卸载中间态：seedPlaceholderRegistry 把事件包清回空包', async () => {
    installFetchMock();
    await ensureContentRegistryLoaded();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(false);
    // 🔴 清注册表不连带清事件包，卸载与重拉占位之间那一段就仍沿旧包掷骰
    seedPlaceholderRegistry();
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
  });

  it('④ 整份替换即换包（dev overlay 重解析走的就是这条）', () => {
    setContentRegistry({ ...getContentRegistry(), randomEvents: eventsBody(['覆盖事件甲']) });
    expect(installedNames()).toEqual(['覆盖事件甲']);

    setContentRegistry({ ...getContentRegistry(), randomEvents: eventsBody(['覆盖事件乙']) });
    expect(installedNames()).toEqual(['覆盖事件乙']);
  });

  it('④ 替换成缺席（这一面被清掉）→ 空包，不是留着上一份', () => {
    setContentRegistry({ ...getContentRegistry(), randomEvents: eventsBody(['覆盖事件甲']) });
    setContentRegistry({ ...getContentRegistry(), randomEvents: undefined });
    expect(isEmptyRandomEventPack(getRandomEventPack())).toBe(true);
  });
});
