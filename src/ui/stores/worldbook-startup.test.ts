/**
 * P0-4 消费端切换验收 —— 走**完整启动流程**，而不是单测某个 store 方法。
 *
 * `worldbook-store.test.ts` 验的是 store 自己的契约；这里验的是切换本身的两个风险点：
 *
 * 1. **全新用户**（localStorage 里压根没有 `worldBooks` 键）：分支中途 settings-store 已经
 *    移除了 `worldBooks` 默认值，任何还在读 `s.worldBooks.length` 的消费端都会当场炸。
 *    这条测试就是那根钉子 —— 启动跑完不抛，且内置书确实可用。
 * 2. **老用户**：迁移 + 消费端切换必须同批上线，否则「书搬走了但消费端还看旧地方」＝
 *    世界书当场消失。断言三件事同时成立：用户编辑还在 · localStorage 键没了 ·
 *    Dexie 里是全量数据。
 *
 * 外加一条消费端联调：捏人页的 `loadWorldBookEntries()` 必须从 store 取
 * `system_core` / `character`（此前直读 `data/worldbooks/*.json`，用户编辑进不来）。
 *
 * 内置书 fetch 在 Node 下不可用 → mock `loadBuiltInWorldBooks`；
 * 但**保留真实的 `loadWorldBooksWithFallback`**，因为消费端切换后走的正是它。
 * 数据层是真 Dexie + fake-indexeddb。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { WorldBook, WorldBookEntry } from '@engine/types';
import { getDatabase } from '@engine/database';

const builtInBooks = vi.hoisted(() => ({ value: [] as WorldBook[] }));
vi.mock('@engine/builtin-worldbooks', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/builtin-worldbooks')>();
  return { ...actual, loadBuiltInWorldBooks: vi.fn(async () => builtInBooks.value) };
});

// create-store 顺带拉进 AgentClient（只有大纲链用得到），这里不碰网络
vi.mock('@engine/agent-client', () => ({
  AgentClient: class {
    chat() {
      throw new Error('本测试不应触发 AgentClient');
    }
  },
}));

import { useWorldBookStore } from './worldbook-store';
import { useSettingsStore } from './settings-store';
import { useCreateStore } from './create-store';
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

function makeBook(
  id: string,
  entryCount: number,
  partition: WorldBook['partition'] = 'world_setting',
): WorldBook {
  return {
    id,
    name: `《${id}》`,
    partition,
    entries: Array.from({ length: entryCount }, (_, i) => makeEntry(i + 1)),
    builtIn: true,
  };
}

/** 出厂内置书集合（含捏人页要用的两个分区） */
function defaultBuiltIns(): WorldBook[] {
  return [
    makeBook('world_setting', 3),
    makeBook('system_core', 2, 'system_core'),
    makeBook('character', 4, 'character'),
  ];
}

describe('P0-4 世界书消费端切换 —— 启动流程', () => {
  beforeEach(async () => {
    lsBacking.clear();
    builtInBooks.value = defaultBuiltIns();
    await getDatabase().worldBooks.clear();
    setActivePinia(createPinia());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. 全新用户 ────────────────────────────────────────
  it('全新用户(localStorage 无 worldBooks 键): 启动不炸，内置书可用', async () => {
    // settings-store 惰性建档，此刻 localStorage 是真的空的
    expect(lsBacking.get(STORAGE_KEY)).toBeUndefined();

    const wb = useWorldBookStore();
    await expect(wb.init()).resolves.toBeUndefined();

    expect(wb.ready).toBe(true);
    // 空源数组也算迁移成功（bulkPut([]) → 校验平凡通过 → 置标志位）
    expect(wb.lastMigration).toMatchObject({ status: 'migrated', bookCount: 0 });

    // 内置书补齐了 —— 这是「不炸」之外真正要的东西
    expect(wb.books.map((b) => b.id).sort()).toEqual(['character', 'system_core', 'world_setting']);
    expect(await getDatabase().worldBooks.count()).toBe(3);

    // 消费端读的是 `wb.books.length`，不再是被移除的 `s.worldBooks.length`
    expect(useSettingsStore().settings[LEGACY_BOOKS_KEY]).toBeUndefined();
  });

  it('全新用户: 捏人页 loadWorldBookEntries() 拿得到 system_core / character 条目', async () => {
    const create = useCreateStore();
    await create.loadWorldBookEntries();

    expect(create.systemCoreEntries).toHaveLength(2);
    expect(create.characterEntries).toHaveLength(4);
    // 内容而不只是条数 —— 断言真的是那两本书的条目
    expect(create.systemCoreEntries.map((e) => e.content)).toEqual(['正文 1', '正文 2']);
  });

  // ── 2. 老用户 ──────────────────────────────────────────
  it('老用户(localStorage 有书 + 有编辑): 编辑仍在 · localStorage 键消失 · Dexie 全量', async () => {
    // 用户把 world_setting 改瘦了一条并改了正文，另外自建了一本非内置书
    const edited = makeBook('world_setting', 1);
    edited.entries[0].content = '用户改过的正文';
    const own: WorldBook = { ...makeBook('my_own', 2), builtIn: false, name: '我自己的书' };
    lsBacking.set(STORAGE_KEY, JSON.stringify({ [LEGACY_BOOKS_KEY]: [edited, own] }));
    setActivePinia(createPinia());

    const wb = useWorldBookStore();
    await wb.init();

    expect(wb.lastMigration).toMatchObject({ status: 'migrated', bookCount: 2 });

    // ① 编辑仍在（内置合并只补缺的，不覆盖库里的版本）
    expect(wb.getBook('world_setting')!.entries).toHaveLength(1);
    expect(wb.getBook('world_setting')!.entries[0].content).toBe('用户改过的正文');
    // 自建书也在
    expect(wb.getBook('my_own')!.name).toBe('我自己的书');

    // ② localStorage 键消失 + 标志位置位，且序列化里搜不到书内容
    const settings = useSettingsStore().settings;
    expect(settings[LEGACY_BOOKS_KEY]).toBeUndefined();
    expect(typeof settings[MIGRATED_FLAG_KEY]).toBe('number');
    useSettingsStore().saveNow();
    const serialized = JSON.stringify(settings) + (lsBacking.get(STORAGE_KEY) ?? '');
    expect(serialized).not.toContain('用户改过的正文');
    expect(serialized).not.toContain('我自己的书');
    expect(serialized).not.toContain('"entries"');

    // ③ Dexie 里是全量：迁移的 2 本 + 内置补的 2 本
    const rows = await getDatabase().worldBooks.toArray();
    expect(rows.map((r) => r.id).sort()).toEqual([
      'character',
      'my_own',
      'system_core',
      'world_setting',
    ]);
  });

  it('老用户: 捏人页读到的是**用户编辑过的** character 条目，不是出厂 JSON', async () => {
    const editedChars = makeBook('character', 1, 'character');
    editedChars.entries[0].name = '玩家自己加的角色';
    lsBacking.set(STORAGE_KEY, JSON.stringify({ [LEGACY_BOOKS_KEY]: [editedChars] }));
    setActivePinia(createPinia());

    const create = useCreateStore();
    await create.loadWorldBookEntries();

    // 出厂 character 有 4 条；用户版只有 1 条 —— 拿到 1 条才证明读的是 store 不是文件
    expect(create.characterEntries).toHaveLength(1);
    expect(create.characterEntries[0].name).toBe('玩家自己加的角色');
    // 缺的 system_core 由内置合并补上，同样进得了捏人页
    expect(create.systemCoreEntries).toHaveLength(2);
  });

  // ── 3. 幂等：重复启动不重复写 ──────────────────────────
  it('重复启动: 第二次 init 不再迁移、不重复写库', async () => {
    lsBacking.set(STORAGE_KEY, JSON.stringify({ [LEGACY_BOOKS_KEY]: [makeBook('dlc', 2)] }));
    setActivePinia(createPinia());

    await useWorldBookStore().init();
    const countAfterFirst = await getDatabase().worldBooks.count();

    // 新一轮应用启动（新 pinia，settings 从 localStorage 恢复，标志位已在里面）
    setActivePinia(createPinia());
    const wb2 = useWorldBookStore();
    await wb2.init();

    expect(wb2.lastMigration).toEqual({ status: 'already-migrated' });
    expect(await getDatabase().worldBooks.count()).toBe(countAfterFirst);
    expect(wb2.books).toHaveLength(countAfterFirst);
  });
});
