/**
 * 世界书 localStorage → Dexie 一次性迁移（Phase 0 / 设计 D4）
 *
 * 🔴 本模块动的是**用户每一条世界书编辑的唯一副本**，且该副本今天不在任何备份里
 *    （`exportAllData()` 从不读 localStorage）。搞砸即不可恢复。
 *
 * **六步流程本身在 `legacy-dexie-migration.ts`**（Q-08：本文件与 beautifier-migration
 * 曾各存一份逐字相同的实现，且回读校验强度已经开始漂移）。本文件只留三样世界书特有的东西：
 *   - `toRow`：深拷贝 + 盖 `updatedAt` 戳
 *   - `verifyRow`：逐本比条目数
 *   - 键名 / 出参形状（`bookCount` / `entryCount`）
 *
 * 启动顺序：迁移 → 之后才跑内置书合并（针对 Dexie）。见 worldbook-store 的 `init()`。
 */
import { getDatabase } from '@engine/database';
import type { WorldBook } from '@engine/types';
import { runLegacyMigration, type IdRename } from './legacy-dexie-migration';

/** `AppDatabase` 类本身未导出，用返回类型取到它 */
type AppDatabase = ReturnType<typeof getDatabase>;

/** 迁移完成标志位在 settings 里的键名 */
export const MIGRATED_FLAG_KEY = 'worldBooksMigratedAt';

/** 世界书在 settings 里的旧键名（迁移后会被删除） */
export const LEGACY_BOOKS_KEY = 'worldBooks';

export interface WorldBookMigrationDeps {
  /** 设置对象本体（settings-store 的 `settings.value`）—— 既是迁移源，也承载标志位 */
  settings: Record<string, unknown>;
  /** 把 settings 同步落 localStorage（settings-store 的 `saveNow`） */
  persistSettings: () => void;
  /** 注入缝：默认取应用单例 */
  db?: AppDatabase;
}

/** id 碰撞化解记录 —— 语义与结构见 `legacy-dexie-migration` 的 `IdRename` */
export type WorldBookIdRename = IdRename;

export type WorldBookMigrationOutcome =
  /** 标志位已置位，什么都没做（幂等路径） */
  | { status: 'already-migrated' }
  /** 迁移成功：localStorage 副本已删、标志位已置 */
  | {
      status: 'migrated';
      bookCount: number;
      entryCount: number;
      /** id 碰撞化解记录；无碰撞时为空数组 */
      renames: WorldBookIdRename[];
    }
  /** 失败：localStorage 完好、标志位未置，下次启动重试 */
  | { status: 'failed'; stage: 'read' | 'write' | 'verify'; message: string };

/**
 * 执行迁移。**永不抛** —— 失败以 outcome 形式返回，调用方（store init）静默继续。
 */
export async function migrateWorldBooksToDexie(
  deps: WorldBookMigrationDeps,
): Promise<WorldBookMigrationOutcome> {
  const now = Date.now();
  let db: AppDatabase;
  try {
    db = deps.db ?? getDatabase();
  } catch (err) {
    return { status: 'failed', stage: 'read', message: String(err) };
  }

  const out = await runLegacyMigration<WorldBook>({
    flagKey: MIGRATED_FLAG_KEY,
    legacyKey: LEGACY_BOOKS_KEY,
    table: db.worldBooks,
    db,
    settings: deps.settings,
    persistSettings: deps.persistSettings,
    unit: '本书',
    nameOf: (book) => book.name,
    // 深拷贝 + 盖 updatedAt 戳（深拷贝的理由见骨架的 `toRow` 文档）
    toRow: (book) => ({
      ...(JSON.parse(JSON.stringify(book)) as WorldBook),
      updatedAt: typeof book.updatedAt === 'number' ? book.updatedAt : now,
    }),
    // 世界书的校验强度：逐本比条目数（**别降级**，不留 localStorage 回滚副本就靠它兜着）
    verifyRow: (expected, actual) => {
      const expectedEntries = expected.entries?.length ?? 0;
      const actualEntries = actual.entries?.length ?? 0;
      return actualEntries === expectedEntries
        ? null
        : `《${expected.name}》条目数不符: 期望 ${expectedEntries}，实际 ${actualEntries}`;
    },
  });

  if (out.status === 'already-migrated') return { status: 'already-migrated' };
  if (out.status === 'failed') {
    return { status: 'failed', stage: out.stage, message: out.message };
  }
  const entryCount = out.rows.reduce((sum, b) => sum + (b.entries?.length ?? 0), 0);
  return {
    status: 'migrated',
    bookCount: out.rows.length,
    entryCount,
    renames: out.renames,
  };
}
