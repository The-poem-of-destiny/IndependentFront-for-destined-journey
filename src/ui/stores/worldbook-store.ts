/**
 * 世界书 Store（Phase 0 / 设计 D2·D3·D4）—— Dexie `worldBooks` 表的**唯一入口**。
 *
 * 对外暴露的 `books` 与迁移前的 `settings.worldBooks` **同形**（`WorldBook[]`），
 * 消费端切过来时只需换数据源，不需要改用法。
 *
 * 🔴 本 store **绝不**把书写回 `settings.worldBooks` ——
 *    settings-store 的 deep watch 会把整个设置对象序列化进 localStorage，
 *    写回去等于把刚搬出来的 ~0.85 MB 又塞回配额里，迁移白做。
 *
 * 写入约定：一律**先 await 落库再更新 ref**。ref 是库的投影，不是第二真相来源；
 * 落库失败时 ref 保持旧值，UI 不会显示一条实际不存在的书。
 */
import { defineStore } from 'pinia';
import { ref } from 'vue';
import { getDatabase } from '@engine/database';
import { loadBuiltInWorldBooks } from '@engine/builtin-worldbooks';
import type { WorldBook, WorldBookEntry } from '@engine/types';
import { migrateWorldBooksToDexie, type WorldBookMigrationOutcome } from './worldbook-migration';
import { useSettingsStore } from './settings-store';

/** 落库前统一盖 updatedAt 戳 + 深拷贝（切断 Vue Proxy，否则 structured clone 抛错） */
function toRow(book: WorldBook): WorldBook {
  return { ...(JSON.parse(JSON.stringify(book)) as WorldBook), updatedAt: Date.now() };
}

export const useWorldBookStore = defineStore('worldbook', () => {
  /** 全部世界书（内置 / 导入 / 工坊）—— Dexie 的响应式投影 */
  const books = ref<WorldBook[]>([]);
  /** init() 是否已完成（含失败收场）——消费端可据此显示加载态 */
  const ready = ref(false);
  /** 上次迁移结果，仅供调试/测试断言 */
  const lastMigration = ref<WorldBookMigrationOutcome | null>(null);

  let initPromise: Promise<void> | null = null;

  // ===== 启动 =====

  /**
   * 启动流程，幂等（并发调用共用同一个 Promise）。
   *
   * 顺序是 D4 第 6 步硬性规定的：**迁移 → hydrate → 内置合并**。
   * 内置合并若先跑，会把内置书写回 localStorage，源数组在迁移脚下漂移。
   */
  async function init(): Promise<void> {
    if (!initPromise) initPromise = doInit();
    return initPromise;
  }

  async function doInit(): Promise<void> {
    const settingsStore = useSettingsStore();
    lastMigration.value = await migrateWorldBooksToDexie({
      settings: settingsStore.settings,
      persistSettings: settingsStore.saveNow,
    });
    await hydrate();
    await mergeBuiltIns();
    ready.value = true;
  }

  /** 从 Dexie 读全表填 ref */
  async function hydrate(): Promise<void> {
    try {
      books.value = await getDatabase().worldBooks.toArray();
    } catch {
      // IndexedDB 不可用 → 留空数组，消费端有 loadWorldBooksWithFallback 兜底
    }
  }

  /**
   * 内置书合并（从 settings-store 原样搬来，语义不变）：
   * 运行时 fetch `data/worldbooks/*.json`，**缺的补进 Dexie，已存在的保留库里的版本**
   * —— 用户编辑不丢。
   */
  async function mergeBuiltIns(): Promise<void> {
    try {
      const builtIn = await loadBuiltInWorldBooks();
      const existingIds = new Set(books.value.map((b) => b.id));
      const missing = builtIn.filter((b) => !existingIds.has(b.id)).map(toRow);
      if (missing.length === 0) return;
      await getDatabase().worldBooks.bulkPut(missing);
      books.value = [...books.value, ...missing];
    } catch {
      // fetch / IndexedDB 不可用时静默跳过（与迁移前行为一致）
    }
  }

  // ===== CRUD =====

  /** 新增或整本覆盖 */
  async function upsertBook(book: WorldBook): Promise<void> {
    const row = toRow(book);
    await getDatabase().worldBooks.put(row);
    const idx = books.value.findIndex((b) => b.id === row.id);
    if (idx >= 0) books.value[idx] = row;
    else books.value.push(row);
  }

  /** 批量新增或覆盖（导入 / 工坊安装用） */
  async function upsertBooks(list: WorldBook[]): Promise<void> {
    if (list.length === 0) return;
    const rows = list.map(toRow);
    await getDatabase().worldBooks.bulkPut(rows);
    for (const row of rows) {
      const idx = books.value.findIndex((b) => b.id === row.id);
      if (idx >= 0) books.value[idx] = row;
      else books.value.push(row);
    }
  }

  async function deleteBook(id: string): Promise<void> {
    await getDatabase().worldBooks.delete(id);
    books.value = books.value.filter((b) => b.id !== id);
  }

  /** 新增或覆盖条目（按 uid 匹配）。书不存在 → 抛，调用方自己决定怎么报 */
  async function upsertEntry(bookId: string, entry: WorldBookEntry): Promise<void> {
    const book = books.value.find((b) => b.id === bookId);
    if (!book) throw new Error(`世界书不存在: ${bookId}`);
    const entries = [...book.entries];
    const idx = entries.findIndex((e) => e.uid === entry.uid);
    if (idx >= 0) entries[idx] = entry;
    else entries.push(entry);
    await upsertBook({ ...book, entries });
  }

  async function deleteEntry(bookId: string, uid: number): Promise<void> {
    const book = books.value.find((b) => b.id === bookId);
    if (!book) throw new Error(`世界书不存在: ${bookId}`);
    await upsertBook({ ...book, entries: book.entries.filter((e) => e.uid !== uid) });
  }

  function getBook(id: string): WorldBook | undefined {
    return books.value.find((b) => b.id === id);
  }

  /**
   * 恢复默认：清空整表，重新从 `data/worldbooks/` 加载。
   * 语义与迁移前的 `settings.resetWorldBooksToDefaults()` 一致（含清 activeWorldBookId）。
   * fetch 失败 → 什么都不动（绝不先清表再发现加载不到）。
   */
  async function resetToDefaults(): Promise<void> {
    let builtIn: WorldBook[];
    try {
      builtIn = await loadBuiltInWorldBooks();
    } catch {
      return;
    }
    const rows = builtIn.map(toRow);
    const db = getDatabase();
    await db.transaction('rw', db.worldBooks, async () => {
      await db.worldBooks.clear();
      if (rows.length > 0) await db.worldBooks.bulkPut(rows);
    });
    books.value = rows;
    useSettingsStore().settings.activeWorldBookId = null;
  }

  return {
    books,
    ready,
    lastMigration,
    init,
    hydrate,
    mergeBuiltIns,
    upsertBook,
    upsertBooks,
    deleteBook,
    upsertEntry,
    deleteEntry,
    getBook,
    resetToDefaults,
  };
});
