/**
 * worldbook-migration 专项测试（设计 D4）—— Phase 0 的核心资产。
 *
 * 这不是覆盖率练习：`settings.worldBooks` 是用户每一条世界书编辑的**唯一副本**，
 * 且当前不在任何备份里。下面每一条都在钉死同一句话——
 * **宁可迁移永不成功，也不能半成功。**
 *
 * 数据层是真 Dexie + fake-indexeddb（src/test-setup.ts 注入）；
 * 失败注入用 `vi.spyOn` 打真表的方法，让「事务中途抛错」走真实的 Dexie 回滚，
 * 而不是靠一个假 db 对象假装回滚过。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { WorldBook, WorldBookEntry } from '@engine/types';
import { getDatabase } from '@engine/database';
import {
  migrateWorldBooksToDexie,
  MIGRATED_FLAG_KEY,
  LEGACY_BOOKS_KEY,
} from './worldbook-migration';

// ===== 夹具 =====

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

function makeBook(id: string, entryCount: number): WorldBook {
  return {
    id,
    name: `《${id}》`,
    partition: 'world_setting',
    entries: Array.from({ length: entryCount }, (_, i) => makeEntry(i + 1)),
    builtIn: true,
  };
}

/** 模拟 settings-store：一个普通对象 + 一个把它序列化进 localStorage 的 saveNow */
const STORAGE_KEY = 'fated-poem-settings';
function makeSettingsHarness(books: WorldBook[] | undefined) {
  const settings: Record<string, unknown> = { plotMode: 'off' };
  if (books !== undefined) settings[LEGACY_BOOKS_KEY] = books;
  const persistSettings = () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  };
  persistSettings(); // 起点：localStorage 里确实有一份副本
  return { settings, persistSettings };
}

function readLocalStorage(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
}

// localStorage 在 Node 环境不存在
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

describe('worldbook-migration (D4)', () => {
  beforeEach(async () => {
    lsBacking.clear();
    await getDatabase().worldBooks.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── 1. 正常迁移 ────────────────────────────────────────
  it('正常迁移: 数据完整 · localStorage 的 worldBooks 消失 · 标志位置位', async () => {
    const source = [makeBook('world_setting', 3), makeBook('race', 5)];
    const h = makeSettingsHarness(source);

    const out = await migrateWorldBooksToDexie(h);

    expect(out).toEqual({ status: 'migrated', bookCount: 2, entryCount: 8, renames: [] });

    // 数据完整：书数量 + 逐本条目数量
    const rows = await getDatabase().worldBooks.toArray();
    expect(rows).toHaveLength(2);
    expect(rows.find((b) => b.id === 'world_setting')!.entries).toHaveLength(3);
    expect(rows.find((b) => b.id === 'race')!.entries).toHaveLength(5);
    // 正文逐字保真，不是只对上了数量
    expect(rows.find((b) => b.id === 'race')!.entries[4].content).toBe('正文 5');
    // updatedAt 已盖戳（v14 索引字段）
    expect(typeof rows[0].updatedAt).toBe('number');

    // 源销毁 + 标志位
    expect(h.settings[LEGACY_BOOKS_KEY]).toBeUndefined();
    expect(typeof h.settings[MIGRATED_FLAG_KEY]).toBe('number');
    const persisted = readLocalStorage();
    expect(persisted[LEGACY_BOOKS_KEY]).toBeUndefined();
    expect(typeof persisted[MIGRATED_FLAG_KEY]).toBe('number');
    // 其余设置不受影响
    expect(persisted.plotMode).toBe('off');
  });

  // ── 2. 事务中途抛错 ────────────────────────────────────
  it('事务中途抛错: Dexie 无残留 · localStorage 完好 · 标志位未置 · 重跑能成功', async () => {
    const source = [makeBook('world_setting', 3), makeBook('race', 5)];
    const h = makeSettingsHarness(source);
    const db = getDatabase();

    // 真的写进去了，然后在同一个事务里炸 —— 靠 Dexie 自己回滚，不是靠我们没写
    const realBulkPut = db.worldBooks.bulkPut.bind(db.worldBooks);
    // `as never`: Dexie 的 bulkPut 是重载签名且返回 PromiseExtended，普通 async 函数对不上
    const spy = vi.spyOn(db.worldBooks, 'bulkPut').mockImplementation((async (
      rows: readonly WorldBook[],
    ) => {
      await realBulkPut(rows);
      throw new Error('模拟写入中途失败');
    }) as never);

    const failed = await migrateWorldBooksToDexie(h);
    expect(failed.status).toBe('failed');
    expect(failed).toMatchObject({ stage: 'write' });

    // Dexie 无残留（事务回滚）
    expect(await db.worldBooks.count()).toBe(0);
    // localStorage 完好、标志位未置
    expect(h.settings[LEGACY_BOOKS_KEY]).toBe(source);
    expect(h.settings[MIGRATED_FLAG_KEY]).toBeUndefined();
    expect(readLocalStorage()[LEGACY_BOOKS_KEY]).toHaveLength(2);

    // 重跑能成功 —— 这是「宁可永不成功」之所以可接受的前提
    spy.mockRestore();
    const retry = await migrateWorldBooksToDexie(h);
    expect(retry).toEqual({ status: 'migrated', bookCount: 2, entryCount: 8, renames: [] });
    expect(await db.worldBooks.count()).toBe(2);
    expect(readLocalStorage()[LEGACY_BOOKS_KEY]).toBeUndefined();
  });

  // ── 3. 校验失败 ────────────────────────────────────────
  it('校验失败(回读数量不符): 不删 localStorage · 不置标志位', async () => {
    const source = [makeBook('world_setting', 3), makeBook('race', 5)];
    const h = makeSettingsHarness(source);
    const db = getDatabase();

    // 人为构造回读少一本（`as never` 同上，绕 PromiseExtended 签名）
    const realGet = db.worldBooks.get.bind(db.worldBooks);
    vi.spyOn(db.worldBooks, 'bulkGet').mockImplementation((async () => [
      await realGet('world_setting'),
    ]) as never);

    const out = await migrateWorldBooksToDexie(h);
    expect(out.status).toBe('failed');
    expect(out).toMatchObject({ stage: 'verify' });

    expect(h.settings[LEGACY_BOOKS_KEY]).toBe(source);
    expect(h.settings[MIGRATED_FLAG_KEY]).toBeUndefined();
    expect(readLocalStorage()[LEGACY_BOOKS_KEY]).toHaveLength(2);
  });

  it('校验失败(逐本条目数不符): 不删 localStorage · 不置标志位', async () => {
    const source = [makeBook('world_setting', 3)];
    const h = makeSettingsHarness(source);
    const db = getDatabase();

    // 回读到一本条目被吞掉的书
    vi.spyOn(db.worldBooks, 'bulkGet').mockImplementation((async () => [
      { ...makeBook('world_setting', 1) },
    ]) as never);

    const out = await migrateWorldBooksToDexie(h);
    expect(out).toMatchObject({ status: 'failed', stage: 'verify' });
    expect(h.settings[LEGACY_BOOKS_KEY]).toBe(source);
    expect(h.settings[MIGRATED_FLAG_KEY]).toBeUndefined();
  });

  // ── 4. 幂等 ────────────────────────────────────────────
  it('已迁移状态重复启动: 幂等，不重复写', async () => {
    const h = makeSettingsHarness([makeBook('world_setting', 3)]);
    await migrateWorldBooksToDexie(h);
    const db = getDatabase();
    const before = await db.worldBooks.get('world_setting');

    // 第二次启动：即便 settings 里被塞回一份脏数据，标志位在就一律不动
    h.settings[LEGACY_BOOKS_KEY] = [makeBook('world_setting', 99)];
    const putSpy = vi.spyOn(db.worldBooks, 'bulkPut');

    const out = await migrateWorldBooksToDexie(h);

    expect(out).toEqual({ status: 'already-migrated' });
    expect(putSpy).not.toHaveBeenCalled();
    expect((await db.worldBooks.get('world_setting'))!.entries).toHaveLength(3);
    expect(await db.worldBooks.get('world_setting')).toEqual(before);
  });

  it('以显式标志位判定，而非「表里有没有行」', async () => {
    const db = getDatabase();
    // 表里已经有行（模拟上一轮半失败留下的残留），但标志位没置 → 必须照跑
    await db.worldBooks.put(makeBook('race', 1));
    const h = makeSettingsHarness([makeBook('race', 5)]);

    const out = await migrateWorldBooksToDexie(h);

    expect(out).toEqual({ status: 'migrated', bookCount: 1, entryCount: 5, renames: [] });
    // 源覆盖残留（用户编辑赢）
    expect((await db.worldBooks.get('race'))!.entries).toHaveLength(5);
  });

  // ── 5. 空 / 缺失源 ─────────────────────────────────────
  it('空 worldBooks(全新用户): 不炸，标志位置位', async () => {
    const h = makeSettingsHarness([]);
    const out = await migrateWorldBooksToDexie(h);
    expect(out).toEqual({ status: 'migrated', bookCount: 0, entryCount: 0, renames: [] });
    expect(typeof h.settings[MIGRATED_FLAG_KEY]).toBe('number');
  });

  it('压根没有 worldBooks 键: 不炸', async () => {
    const h = makeSettingsHarness(undefined);
    const out = await migrateWorldBooksToDexie(h);
    expect(out).toEqual({ status: 'migrated', bookCount: 0, entryCount: 0, renames: [] });
  });

  it('空源迁移不清空 Dexie 已有的行', async () => {
    const db = getDatabase();
    await db.worldBooks.put(makeBook('dlc', 2));
    const h = makeSettingsHarness([]);
    await migrateWorldBooksToDexie(h);
    expect(await db.worldBooks.count()).toBe(1);
  });

  // ── 6. id 碰撞（源数组里有重复 id）──────────────────────
  //
  // 这不是理论问题：SettingsPage 的「新建」按书名派生 id、「导入」按文件名派生 id，
  // 两处都是裸 push 没有去重。若不处理，同 id 的第二本会在 bulkPut 里被吞掉，
  // 而按下标做的回读校验会被「bulkGet(['x','x']) 同一行返回两次」骗过去 → 静默丢书。
  describe('id 碰撞: 保内容优先', () => {
    it('两本同 id: Dexie 落 2 行 · 内容都在 · 首本 id 不变 · 第二本被重命名', async () => {
      const first = makeBook('世界设定', 3);
      first.entries[0].content = '第一本的正文';
      const second = makeBook('世界设定', 2);
      second.name = '《重名的第二本》';
      second.entries[0].content = '第二本的正文';
      const h = makeSettingsHarness([first, second]);

      const out = await migrateWorldBooksToDexie(h);

      expect(out).toMatchObject({ status: 'migrated', bookCount: 2, entryCount: 5 });
      expect(out).toMatchObject({
        renames: [
          { from: '世界设定', to: '世界设定__dup2', name: '《重名的第二本》', sourceIndex: 1 },
        ],
      });

      const db = getDatabase();
      expect(await db.worldBooks.count()).toBe(2);

      // 首本保留原 id —— 它可能已被 Agent 配置的 worldBookIds 引用
      const kept = await db.worldBooks.get('世界设定');
      expect(kept!.entries).toHaveLength(3);
      expect(kept!.entries[0].content).toBe('第一本的正文');

      // 第二本换了 id，但一条内容都没丢
      const renamed = await db.worldBooks.get('世界设定__dup2');
      expect(renamed!.entries).toHaveLength(2);
      expect(renamed!.entries[0].content).toBe('第二本的正文');
      expect(renamed!.name).toBe('《重名的第二本》');
    });

    it('两本同 id 且内容完全一致(重复导入同一文件): 仍然两行都在', async () => {
      // 最阴险的一档：条目数相同 → 老校验的每一项都对得上 → 静默丢一本
      const h = makeSettingsHarness([makeBook('race', 4), makeBook('race', 4)]);
      const out = await migrateWorldBooksToDexie(h);
      expect(out).toMatchObject({ status: 'migrated', bookCount: 2, entryCount: 8 });
      expect(await getDatabase().worldBooks.count()).toBe(2);
    });

    it('三本同 id: 编号递增，互不再碰撞', async () => {
      const h = makeSettingsHarness([makeBook('dlc', 1), makeBook('dlc', 2), makeBook('dlc', 3)]);

      const out = await migrateWorldBooksToDexie(h);

      expect(out).toMatchObject({ status: 'migrated', bookCount: 3, entryCount: 6 });
      expect((out as { renames: unknown[] }).renames).toEqual([
        { from: 'dlc', to: 'dlc__dup2', name: '《dlc》', sourceIndex: 1 },
        { from: 'dlc', to: 'dlc__dup3', name: '《dlc》', sourceIndex: 2 },
      ]);

      const db = getDatabase();
      expect(await db.worldBooks.count()).toBe(3);
      expect((await db.worldBooks.get('dlc'))!.entries).toHaveLength(1);
      expect((await db.worldBooks.get('dlc__dup2'))!.entries).toHaveLength(2);
      expect((await db.worldBooks.get('dlc__dup3'))!.entries).toHaveLength(3);
    });

    it('新 id 本身也可能被占用: 跳过已存在的 __dup2', async () => {
      // 源里正好有一本真的叫 `dlc__dup2` —— 新 id 不许把它踩掉
      const occupied = makeBook('dlc__dup2', 9);
      const h = makeSettingsHarness([makeBook('dlc', 1), occupied, makeBook('dlc', 2)]);

      const out = await migrateWorldBooksToDexie(h);

      expect(out).toMatchObject({ status: 'migrated', bookCount: 3 });
      expect((out as { renames: { to: string }[] }).renames).toEqual([
        { from: 'dlc', to: 'dlc__dup3', name: '《dlc》', sourceIndex: 2 },
      ]);
      expect((await getDatabase().worldBooks.get('dlc__dup2'))!.entries).toHaveLength(9);
      expect((await getDatabase().worldBooks.get('dlc__dup3'))!.entries).toHaveLength(2);
    });

    it('碰撞场景下 localStorage 仍是校验通过后才删', async () => {
      const source = [makeBook('dlc', 1), makeBook('dlc', 2)];
      const h = makeSettingsHarness(source);
      const db = getDatabase();

      // 先验一遍失败路径：碰撞 + 写入炸 → 源必须完好
      const spy = vi.spyOn(db.worldBooks, 'bulkPut').mockImplementation((async () => {
        throw new Error('模拟写入失败');
      }) as never);
      const failed = await migrateWorldBooksToDexie(h);
      expect(failed).toMatchObject({ status: 'failed', stage: 'write' });
      expect(h.settings[LEGACY_BOOKS_KEY]).toBe(source);
      expect(h.settings[MIGRATED_FLAG_KEY]).toBeUndefined();
      expect(readLocalStorage()[LEGACY_BOOKS_KEY]).toHaveLength(2);

      // 再放行：这次才允许删源
      spy.mockRestore();
      const ok = await migrateWorldBooksToDexie(h);
      expect(ok).toMatchObject({ status: 'migrated', bookCount: 2 });
      expect(readLocalStorage()[LEGACY_BOOKS_KEY]).toBeUndefined();
      expect(await db.worldBooks.count()).toBe(2);
    });

    it('无碰撞的正常路径不产生任何重命名', async () => {
      const h = makeSettingsHarness([makeBook('dlc', 1), makeBook('race', 2)]);
      const out = await migrateWorldBooksToDexie(h);
      expect(out).toEqual({ status: 'migrated', bookCount: 2, entryCount: 3, renames: [] });
      expect(await getDatabase().worldBooks.get('dlc__dup2')).toBeUndefined();
    });
  });
});
