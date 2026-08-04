/**
 * worldbook-store 测试（Phase 0 / 设计 D2·D3·D4）
 *
 * 两条主线：
 * 1. **CRUD 往返** —— ref 是 Dexie 的投影，重新 hydrate 必须一字不差地拿回来。
 * 2. **`settings` 永不再承载书内容** —— 这是整次迁移的目的（释放 localStorage 配额）。
 *    每个改动操作后都断言一遍：settings 对象里既没有 `worldBooks` 键，
 *    序列化出来的 localStorage 字符串里也搜不到书名。写回去等于迁移白做。
 *
 * 内置书 fetch 在 Node 下不可用，故 mock `@engine/builtin-worldbooks`；
 * 数据层是真 Dexie + fake-indexeddb。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { WorldBook, WorldBookEntry } from '@engine/types';
import { getDatabase } from '@engine/database';

const builtInBooks = vi.hoisted(() => ({ value: [] as unknown[] }));
vi.mock('@engine/builtin-worldbooks', () => ({
  loadBuiltInWorldBooks: vi.fn(async () => builtInBooks.value),
  loadWorldBooksWithFallback: vi.fn(async (books: unknown[]) => books ?? []),
}));

import { useWorldBookStore } from './worldbook-store';
import { useSettingsStore } from './settings-store';
import { MIGRATED_FLAG_KEY, LEGACY_BOOKS_KEY } from './worldbook-migration';

// ===== 夹具 =====

const STORAGE_KEY = 'fated-poem-settings';
const lsBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsBacking.get(k) ?? null,
  setItem: (k: string, v: string) => void lsBacking.set(k, v),
  removeItem: (k: string) => void lsBacking.delete(k),
  clear: () => lsBacking.clear(),
  get length() {
    return lsBacking.size;
  },
  key: (i: number) => [...lsBacking.keys()][i] ?? null,
});

function makeEntry(uid: number, name = `条目${uid}`): WorldBookEntry {
  return {
    uid,
    name,
    content: `正文 ${uid}`,
    enabled: true,
    key: [],
    keysecondary: [],
    selectiveLogic: 0,
    order: uid,
    position: 0,
  };
}

function makeBook(id: string, entryCount: number, builtIn = false): WorldBook {
  return {
    id,
    name: `《${id}》`,
    partition: 'world_setting',
    entries: Array.from({ length: entryCount }, (_, i) => makeEntry(i + 1)),
    builtIn,
  };
}

// Q-18: 已迁出的历史键（worldBooks / *MigratedAt）**刻意不在 `UiSettings` 上** ——
//        声明它们等于把「设置袋子还是真相来源」这条错觉还回去（理由见 settings-types.ts
//        文件头）。迁移测试要按运行时字符串键读它们，所以在这里显式放宽一次，
//        而不是给类型开一个所有笔误都能钻的口子。
const loose = (s: unknown): Record<string, unknown> => s as Record<string, unknown>;

/** 迁移的目的：书内容一个字节都不许再落在 settings / localStorage 里 */
function expectSettingsFreeOfBooks(bookNames: string[] = []) {
  const s = useSettingsStore().settings;
  expect(loose(s)[LEGACY_BOOKS_KEY]).toBeUndefined();
  const serialized = JSON.stringify(s) + (lsBacking.get(STORAGE_KEY) ?? '');
  for (const name of bookNames) {
    expect(serialized).not.toContain(name);
  }
  expect(serialized).not.toContain('"entries"');
}

describe('worldbook-store', () => {
  beforeEach(async () => {
    lsBacking.clear();
    builtInBooks.value = [];
    await getDatabase().worldBooks.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── CRUD 往返 ─────────────────────────────────────────
  it('upsertBook / deleteBook 往返: 先落库再更新 ref', async () => {
    const store = useWorldBookStore();
    await store.init();

    await store.upsertBook(makeBook('race', 2));
    expect(store.books).toHaveLength(1);
    expect(await getDatabase().worldBooks.count()).toBe(1);

    // 覆盖同 id 不产生第二行
    await store.upsertBook(makeBook('race', 4));
    expect(store.books).toHaveLength(1);
    expect(store.books[0].entries).toHaveLength(4);

    // 重新 hydrate 拿回同样的东西
    store.books = [];
    await store.hydrate();
    expect(store.books).toHaveLength(1);
    expect(store.books[0].entries).toHaveLength(4);
    expect(store.books[0].entries[3].content).toBe('正文 4');

    await store.deleteBook('race');
    expect(store.books).toHaveLength(0);
    expect(await getDatabase().worldBooks.count()).toBe(0);

    expectSettingsFreeOfBooks(['《race》']);
  });

  it('upsertEntry / deleteEntry 按 uid 增改删并整本落库', async () => {
    const store = useWorldBookStore();
    await store.init();
    await store.upsertBook(makeBook('dlc', 2));

    // 新增
    await store.upsertEntry('dlc', makeEntry(9, '新条目'));
    expect(store.getBook('dlc')!.entries).toHaveLength(3);
    // 覆盖同 uid
    await store.upsertEntry('dlc', { ...makeEntry(9), content: '改过的正文' });
    expect(store.getBook('dlc')!.entries).toHaveLength(3);
    expect(store.getBook('dlc')!.entries.find((e) => e.uid === 9)!.content).toBe('改过的正文');

    // 落库了，不只是改了 ref
    const row = await getDatabase().worldBooks.get('dlc');
    expect(row!.entries.find((e) => e.uid === 9)!.content).toBe('改过的正文');

    await store.deleteEntry('dlc', 9);
    expect(store.getBook('dlc')!.entries).toHaveLength(2);
    expect((await getDatabase().worldBooks.get('dlc'))!.entries).toHaveLength(2);

    expectSettingsFreeOfBooks(['《dlc》', '改过的正文']);
  });

  it('对不存在的书 upsertEntry 抛错，且不写库', async () => {
    const store = useWorldBookStore();
    await store.init();
    await expect(store.upsertEntry('nope', makeEntry(1))).rejects.toThrow();
    expect(await getDatabase().worldBooks.count()).toBe(0);
  });

  it('upsertBooks 批量写', async () => {
    const store = useWorldBookStore();
    await store.init();
    await store.upsertBooks([makeBook('a', 1), makeBook('b', 2)]);
    expect(store.books).toHaveLength(2);
    expect(await getDatabase().worldBooks.count()).toBe(2);
  });

  // ── 启动顺序（D4 第 6 步）─────────────────────────────
  it('init 顺序: 先迁移后内置合并 —— 内置书不会被写回 localStorage', async () => {
    builtInBooks.value = [makeBook('world_setting', 3, true), makeBook('race', 2, true)];

    // 老用户：localStorage 里有一本被用户改过的内置书
    const edited = makeBook('world_setting', 1, true);
    edited.entries[0].content = '用户改过的正文';
    lsBacking.set(STORAGE_KEY, JSON.stringify({ [LEGACY_BOOKS_KEY]: [edited] }));
    setActivePinia(createPinia());

    const store = useWorldBookStore();
    await store.init();

    expect(store.lastMigration).toMatchObject({ status: 'migrated', bookCount: 1 });
    // 迁移的那本保留用户版本（内置合并只补缺的）
    expect(store.getBook('world_setting')!.entries).toHaveLength(1);
    expect(store.getBook('world_setting')!.entries[0].content).toBe('用户改过的正文');
    // 缺的那本补进来了
    expect(store.getBook('race')!.entries).toHaveLength(2);
    expect(await getDatabase().worldBooks.count()).toBe(2);

    // ★ 关键：合并结果没有一个字节回到 localStorage
    useSettingsStore().saveNow();
    expectSettingsFreeOfBooks(['《race》', '用户改过的正文']);
    expect(typeof loose(useSettingsStore().settings)[MIGRATED_FLAG_KEY]).toBe('number');
  });

  it('init 幂等: 并发/重复调用只跑一次', async () => {
    builtInBooks.value = [makeBook('race', 2, true)];
    const store = useWorldBookStore();
    await Promise.all([store.init(), store.init()]);
    await store.init();
    expect(store.books).toHaveLength(1);
    expect(await getDatabase().worldBooks.count()).toBe(1);
    expect(store.ready).toBe(true);
  });

  it('内置合并保留库里已有的版本（用户编辑不丢）', async () => {
    await getDatabase().worldBooks.put({ ...makeBook('race', 7, true), updatedAt: 1 });
    builtInBooks.value = [makeBook('race', 2, true)];

    const store = useWorldBookStore();
    await store.init();

    expect(store.books).toHaveLength(1);
    expect(store.getBook('race')!.entries).toHaveLength(7);
  });

  // ── resetToDefaults ───────────────────────────────────
  it('resetToDefaults 清表重灌内置书并清空 activeWorldBookId', async () => {
    const store = useWorldBookStore();
    await store.init();
    await store.upsertBook(makeBook('my-own', 1));
    useSettingsStore().settings.activeWorldBookId = 'my-own';

    builtInBooks.value = [makeBook('world_setting', 3, true)];
    await store.resetToDefaults();

    expect(store.books).toHaveLength(1);
    expect(store.books[0].id).toBe('world_setting');
    expect(await getDatabase().worldBooks.count()).toBe(1);
    expect(useSettingsStore().settings.activeWorldBookId).toBeNull();
    expectSettingsFreeOfBooks(['《world_setting》', '《my-own》']);
  });
});
