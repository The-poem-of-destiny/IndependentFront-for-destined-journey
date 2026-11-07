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
 * 写入约定：玩家/本地书先 await 落库再更新 ref；授权包只更新可撤销内存 overlay。
 * 落库失败时磁盘投影保持旧值，锁定后受保护 id 不能绕过 overlay 写回正文。
 */
import { defineStore } from 'pinia';
import { computed, onScopeDispose, ref, shallowRef } from 'vue';
import {
  getDatabase,
  migrateLegacyContentPacks,
  purgeProtectedPackPlaintext,
} from '@engine/persistence/database';
import {
  getActivePackPayload,
  isProtectedPackBookId,
  getRuntimePackBooks,
  isProtectedContentInstalled,
  overlayRows,
  setRuntimePackBooks,
  subscribePackRuntime,
} from '@engine/content/pack-runtime';
import { loadBuiltInWorldBooks } from '@engine/content/builtin-worldbooks';
import type { WorldBook, WorldBookEntry } from '@engine/types/types';
import { migrateWorldBooksToDexie, type WorldBookMigrationOutcome } from './worldbook-migration';
import { useSettingsStore } from './settings-store';
import { detach, stamped } from './db-write';
import { legacyStashBookAudiences, type LegacyAgentWorldBookStash } from './agent-settings';

/** 落库前统一盖 updatedAt 戳 + 深拷贝（切断 Vue Proxy —— 理由见 db-write，Q-16） */
function toRow(book: WorldBook): WorldBook {
  return stamped(detach(book));
}

export const useWorldBookStore = defineStore('worldbook', () => {
  /** 全部世界书（内置 / 导入 / 工坊）—— Dexie 的响应式投影 */
  const diskBooks = ref<WorldBook[]>([]);
  const packOverlayBooks = shallowRef(getRuntimePackBooks());
  const books = computed(() => overlayRows(diskBooks.value, packOverlayBooks.value));
  onScopeDispose(
    subscribePackRuntime(() => {
      packOverlayBooks.value = getRuntimePackBooks();
    }),
  );
  function setPackOverlayBooks(rows: WorldBook[]): void {
    setRuntimePackBooks(rows);
  }
  function protectedBook(id: string): boolean {
    return isProtectedPackBookId(id);
  }
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
      await migrateLegacyContentPacks();
      await purgeProtectedPackPlaintext();
      diskBooks.value = await getDatabase().worldBooks.toArray();
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
      const existingIds = new Set(diskBooks.value.map((b) => b.id));
      const missing = builtIn.filter((b) => !existingIds.has(b.id)).map(toRow);
      if (missing.length === 0) return;
      await getDatabase().worldBooks.bulkPut(missing);
      diskBooks.value = [...diskBooks.value, ...missing];
    } catch {
      // fetch / IndexedDB 不可用时静默跳过（与迁移前行为一致）
    }
  }

  // ===== CRUD =====

  /** 新增或整本覆盖 */
  async function upsertBook(book: WorldBook): Promise<void> {
    const row = toRow(book);
    if (protectedBook(book.id)) {
      setPackOverlayBooks(overlayRows(packOverlayBooks.value, [row]));
      return;
    }
    await getDatabase().worldBooks.put(row);
    const idx = diskBooks.value.findIndex((b) => b.id === row.id);
    if (idx >= 0) diskBooks.value[idx] = row;
    else diskBooks.value.push(row);
  }

  /** 批量新增或覆盖（导入 / 工坊安装用） */
  async function upsertBooks(list: WorldBook[]): Promise<void> {
    for (const book of list.filter((row) => protectedBook(row.id))) await upsertBook(book);
    const rows = list.filter((row) => !protectedBook(row.id)).map(toRow);
    if (rows.length === 0) return;
    await getDatabase().worldBooks.bulkPut(rows);
    diskBooks.value = overlayRows(diskBooks.value, rows);
  }

  async function deleteBook(id: string): Promise<void> {
    if (protectedBook(id)) {
      setPackOverlayBooks(packOverlayBooks.value.filter((book) => book.id !== id));
      return;
    }
    await getDatabase().worldBooks.delete(id);
    diskBooks.value = diskBooks.value.filter((b) => b.id !== id);
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
   * Agent 世界书配置退役后的一次性迁移（内容计划 §7.2）：把**玩家自建书**（非内置、
   * 非工坊）曾被哪些 Agent 读取，写成那本书的书级读取范围声明。
   *
   * 内置书与工坊书的范围来自内容声明 / 兼容映射，不受旧设置影响，这里不碰。已有声明的书
   * 不覆盖。返回 true = 迁移完成（调用方据此清掉暂存）；任何一步失败返回 false，下次再来。
   */
  async function adoptLegacyAgentWorldBooks(stash: LegacyAgentWorldBookStash): Promise<boolean> {
    try {
      await init();
      const byBook = legacyStashBookAudiences(stash);
      const adopted = books.value
        .filter(
          (book) =>
            book.builtIn !== true &&
            book.partition !== 'creative_workshop' &&
            byBook[book.id] !== undefined,
        )
        .map((book) => ({
          ...book,
          entries: book.entries.map((entry) =>
            entry.extra?.lore?.audiences !== undefined
              ? entry
              : {
                  ...entry,
                  extra: {
                    ...(entry.extra ?? {}),
                    lore: { ...(entry.extra?.lore ?? {}), audiences: [...byBook[book.id]] },
                  },
                },
          ),
        }));
      if (adopted.length > 0) await upsertBooks(adopted);
      return true;
    } catch (err) {
      console.warn('[worldbook-store] 自建书读取范围迁移失败:', err);
      return false;
    }
  }

  /**
   * 恢复默认：清空整表，从**默认真源**重新加载（§5.6 / D21）。
   *
   * 🔴 内容-引擎分离波 1：默认真源 = 已装 content pack 的 payload > 占位文件
   * （provider `loadAllDefaultBooks`）。导入真实包后 restore 不再把真实书打回占位。
   * 语义与迁移前一致（含清 activeWorldBookId）；fetch 失败 → 什么都不动（绝不先清表再发现拿不回来）。
   */
  async function resetToDefaults(): Promise<void> {
    try {
      // 先 await 确保 pack 已装载到模块缓存（boot 顺序：loadProjectDefaults → 这里）
      const { loadAllDefaultBooks } = await import('./content-store');
      const protectedPack = isProtectedContentInstalled() && !!getActivePackPayload();
      if (protectedPack) setPackOverlayBooks((await loadAllDefaultBooks()).map(toRow));
      const builtIn = protectedPack ? await loadBuiltInWorldBooks() : await loadAllDefaultBooks();
      const rows = builtIn.map(toRow);
      const db = getDatabase();
      await db.transaction('rw', db.worldBooks, async () => {
        await db.worldBooks.clear();
        if (rows.length > 0) await db.worldBooks.bulkPut(rows);
      });
      diskBooks.value = rows;
      useSettingsStore().settings.activeWorldBookId = null;
    } catch {
      return; // fetch / IndexedDB 不可用时静默跳过
    }
  }

  return {
    books,
    setPackOverlayBooks,
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
    adoptLegacyAgentWorldBooks,
    resetToDefaults,
  };
});
