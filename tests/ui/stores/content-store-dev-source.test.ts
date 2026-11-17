/**
 * content-store.ts 开发期内容源开关（`lib/dev-content-source.ts` 在 store 侧的接线）
 *
 * 验收：
 *   1. 偏好 'local' + 已装包 → hydrate 不激活包：payload 为空、activePackId 为 null、
 *      内容态 placeholder，Dexie `contentPacks` 行原样保留
 *   2. 偏好 'pack' / 未写偏好 → 与现状一致（包照常激活）
 *   3. 压制期间装 / 升 / 卸（含受保护包入口）一律抛错，且不动 Dexie 行
 *   4. 受保护包（`encryptedEnvelope` / `legacy-locked`）被压制时：
 *      `purgeProtectedPackPlaintext` 照跑（开关必须排在它之后），不解密、不启动租约调度器
 *
 * vitest 下 `import.meta.env.DEV` 为 true、`__POEM_CONTENT_DIR__` 为 false；
 * 偏好经 localStorage 键 `poem_dev_content_source_v1` 注入（node 环境用 Map 替身）。
 */
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import {
  resetPlaceholderHashesCache,
  setActivePackRecord,
  setPlaceholderHashesForTests,
  useContentStore,
} from '../../../src/ui/stores/content-store';
import { DEV_CONTENT_SOURCE_KEY } from '../../../src/ui/lib/dev-content-source';
import { getDatabase } from '@engine/persistence/database';
import { getActivePackPayload } from '@engine/content/pack-runtime';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';
import type { ContentPack } from '@engine/types/types-content';
import type { ContentPackRecord } from '@engine/persistence/database';
import type { EncryptedPackEnvelope } from '@engine/types/types-pack-auth';

// 透传包装：行为不变，只记录「是否尝试解密 / 是否启动租约调度器」
const spies = vi.hoisted(() => ({ decrypt: vi.fn(), schedulerStart: vi.fn() }));
vi.mock('../../../src/ui/lib/pack-crypto', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/ui/lib/pack-crypto')>();
  return {
    ...mod,
    decryptContentPackAtRuntime: (...args: Parameters<typeof mod.decryptContentPackAtRuntime>) => {
      spies.decrypt();
      return mod.decryptContentPackAtRuntime(...args);
    },
  };
});
vi.mock('../../../src/ui/lib/pack-lease-scheduler', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/ui/lib/pack-lease-scheduler')>();
  return {
    ...mod,
    createPackLeaseScheduler: (...args: Parameters<typeof mod.createPackLeaseScheduler>) => {
      const scheduler = mod.createPackLeaseScheduler(...args);
      return {
        ...scheduler,
        start: (...startArgs: Parameters<typeof scheduler.start>) => {
          spies.schedulerStart();
          return scheduler.start(...startArgs);
        },
      };
    },
  };
});

// ── 夹具（取自 content-store-executor.test.ts 的最小子集） ──

function entry(uid: string, name: string, content = `content-${name}`): WorldBookEntry {
  return {
    uid,
    name,
    content,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: 100,
    position: 0,
  };
}

function makePack(version = '1.0.0'): ContentPack {
  return {
    formatVersion: 1,
    packId: 'fated-poem-official',
    packVersion: version,
    name: '测试内容包',
    worldBooks: [
      {
        id: 'system_core',
        name: 'system_core',
        partition: 'system_core',
        builtIn: true,
        entries: [entry('fated:system_core/core_a', '核心A', '真实A')],
      } satisfies WorldBook,
    ],
  };
}

/** Map 替身：node 环境没有可靠的 localStorage */
function stubLocalStorage(initial: Record<string, string> = {}): Map<string, string> {
  const map = new Map(Object.entries(initial));
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  });
  return map;
}

async function cleanDb(): Promise<void> {
  const db = getDatabase();
  await db.contentPacks.clear();
  await db.worldBooks.clear();
  await db.presets.clear();
  await db.promptSessions.clear();
  await db.debugTurns.clear();
  await db.combatSandboxes.clear();
  await db.saves.clear();
  await db.beautifierRules.clear();
  setActivePackRecord(null);
}

/** 以「内容包」偏好装好一个包，然后复位模块缓存，模拟下一次启动 */
async function installPackThenReboot(): Promise<void> {
  stubLocalStorage();
  setActivePinia(createPinia());
  const outcome = await useContentStore().installPack(makePack());
  expect(outcome.ok).toBe(true);
  setActivePackRecord(null);
  vi.unstubAllGlobals();
}

const PROTECTED_BOOK_ID = 'protected_core';
const PROTECTED_PRESET_ID = 'protected-preset';

/** 假信封：只用来让行「看起来受保护」，压制时根本不该被解密 */
function fakeEnvelope(): EncryptedPackEnvelope {
  return {
    formatVersion: 1,
    packId: 'fixture',
    packVersion: '1.0.0',
    boundUserId: '123',
    issuedAt: 1,
    expiresAt: Date.now() + 86400000,
    wrapNonceB64: 'AA==',
    wrappedDekB64: 'AA==',
    bodyNonceB64: 'AA==',
    ciphertextB64: 'AA==',
    plainSha256: 'x',
  };
}

/**
 * 直接写一行受保护包（不走安装流程），再种入「旧备份复活」的包属明文：
 * 一本内置世界书 + 一条预设，外加一本玩家自建书（必须保留）。
 */
async function seedProtectedRow(kind: 'encrypted' | 'legacy-locked'): Promise<ContentPackRecord> {
  const db = getDatabase();
  const row: ContentPackRecord = {
    packId: 'fixture',
    packVersion: '1.0.0',
    installedAt: 1,
    ownedBookIds: [PROTECTED_BOOK_ID],
    ownedPresetIds: [PROTECTED_PRESET_ID],
    ...(kind === 'encrypted'
      ? { source: 'discord' as const, encryptedEnvelope: fakeEnvelope(), boundUserId: '123' }
      : { source: 'legacy-locked' as const }),
  };
  await db.contentPacks.put(row);
  await db.worldBooks.bulkPut([
    {
      id: PROTECTED_BOOK_ID,
      name: PROTECTED_BOOK_ID,
      partition: 'system_core',
      builtIn: true,
      entries: [entry('fated:system_core/secret', '密文', '旧备份复活的明文')],
    },
    {
      id: 'player_book',
      name: 'player_book',
      partition: 'system_core',
      builtIn: false,
      entries: [entry('player/a', '玩家', '玩家自建')],
    },
  ]);
  await db.presets.put({
    id: PROTECTED_PRESET_ID,
    name: '旧备份复活的预设',
    settings: { prompts: [] },
    createdAt: 1,
    updatedAt: 1,
  });
  return (await db.contentPacks.get('fixture'))!;
}

/** 新 pinia = 新 store 实例（hydratePromise 按实例缓存），模拟重新启动后 hydrate */
async function bootWith(pref: string | null) {
  stubLocalStorage(pref === null ? {} : { [DEV_CONTENT_SOURCE_KEY]: pref });
  setActivePinia(createPinia());
  const store = useContentStore();
  await store.hydratePackState();
  return store;
}

beforeEach(async () => {
  spies.decrypt.mockClear();
  spies.schedulerStart.mockClear();
  await cleanDb();
  setPlaceholderHashesForTests({ version: '1', byBook: {} });
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('', { status: 404 }));
});

afterEach(() => {
  setActivePackRecord(null);
  resetPlaceholderHashesCache();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('content-store 开发期内容源 —— 偏好「本地内容目录」', () => {
  it('已装包被压制：不激活 payload、activePackId 为 null，Dexie 行原样保留', async () => {
    await installPackThenReboot();
    const before = await getDatabase().contentPacks.toArray();
    expect(before).toHaveLength(1);

    const store = await bootWith('local');

    expect(getActivePackPayload()).toBeUndefined();
    expect(store.activePackId).toBeNull();
    expect(store.activePackVersion).toBeNull();
    expect(store.contentStatus).toBe('placeholder');
    expect(store.devContentSource).toMatchObject({
      preference: 'local',
      suppressPack: true,
      suppressedPack: { packId: 'fated-poem-official', packVersion: '1.0.0' },
    });
    // 未加密包的世界书已物化 + 测试环境未配置本地目录
    expect(store.devContentSource?.notices).toEqual(
      expect.arrayContaining(['local-dir-missing', 'local-file-pack-materialized']),
    );

    const after = await getDatabase().contentPacks.toArray();
    expect(after).toEqual(before);
  });

  it('没有已装包时不压制，仅给出提示', async () => {
    const store = await bootWith('local');
    expect(store.devContentSource).toMatchObject({
      preference: 'local',
      suppressPack: false,
      suppressedPack: null,
    });
    expect(store.activePackId).toBeNull();
    expect(store.contentStatus).toBe('placeholder');
  });

  it('压制期间装 / 升 / 卸一律抛错，Dexie 行不动', async () => {
    await installPackThenReboot();
    const before = await getDatabase().contentPacks.toArray();
    const store = await bootWith('local');

    await expect(store.installPack(makePack('2.0.0'))).rejects.toThrow(/本地内容目录/);
    await expect(store.upgradePack(makePack('2.0.0'))).rejects.toThrow(/本地内容目录/);
    await expect(store.uninstallPack()).rejects.toThrow(/本地内容目录/);
    await expect(store.uninstallPack({ confirmEdits: true })).rejects.toThrow(/本地内容目录/);
    await expect(store.installProtectedPack({} as never)).rejects.toThrow(/本地内容目录/);

    expect(await getDatabase().contentPacks.toArray()).toEqual(before);
    expect(getActivePackPayload()).toBeUndefined();
  });
});

describe('content-store 开发期内容源 —— 受保护包被压制', () => {
  it.each([
    ['加密包（encryptedEnvelope）', 'encrypted' as const],
    ['旧锁定包（legacy-locked）', 'legacy-locked' as const],
  ])('%s：明文清理照跑，不解密、不启动租约调度器，Dexie 行不动', async (_label, kind) => {
    const before = await seedProtectedRow(kind);

    const store = await bootWith('local');

    // 开关排在 purgeProtectedPackPlaintext 之后：包属明文已被清掉，玩家书保留
    const db = getDatabase();
    expect(await db.worldBooks.get(PROTECTED_BOOK_ID)).toBeUndefined();
    expect(await db.presets.get(PROTECTED_PRESET_ID)).toBeUndefined();
    expect(await db.worldBooks.get('player_book')).toBeDefined();

    expect(spies.decrypt).not.toHaveBeenCalled();
    expect(spies.schedulerStart).not.toHaveBeenCalled();

    expect(getActivePackPayload()).toBeUndefined();
    expect(store.activePackId).toBeNull();
    expect(store.contentStatus).toBe('placeholder');
    expect(store.devContentSource).toMatchObject({
      preference: 'local',
      suppressPack: true,
      suppressedPack: { packId: 'fixture', packVersion: '1.0.0' },
    });
    // 受保护包没有物化明文，不应出现「仍保留世界书/预设」的提示
    expect(store.devContentSource?.notices).not.toContain('local-file-pack-materialized');

    expect(await db.contentPacks.toArray()).toEqual([before]);
  });
});

describe('content-store 开发期内容源 —— 偏好「内容包」/ 未设置（现状）', () => {
  it.each([
    ['pack', 'pack'],
    ['未写偏好', null],
    ['无法识别的值', 'garbage'],
  ])('%s：已装包照常激活', async (_label, pref) => {
    await installPackThenReboot();
    const store = await bootWith(pref);

    expect(getActivePackPayload()?.packId).toBe('fated-poem-official');
    expect(store.activePackId).toBe('fated-poem-official');
    expect(store.activePackVersion).toBe('1.0.0');
    expect(store.contentStatus).toBe('pack');
    expect(store.devContentSource).toEqual({
      preference: 'pack',
      suppressPack: false,
      suppressedPack: null,
      notices: [],
    });
  });

  it('未压制时卸载照常可用', async () => {
    await installPackThenReboot();
    const store = await bootWith('pack');
    const outcome = await store.uninstallPack({ confirmEdits: true });
    expect(outcome.ok).toBe(true);
    expect(await getDatabase().contentPacks.count()).toBe(0);
  });

  it('偏好「内容包」但没有包：提示回落 /data', async () => {
    const store = await bootWith('pack');
    expect(store.devContentSource?.notices).toEqual(['pack-missing']);
    expect(store.activePackId).toBeNull();
  });
});
