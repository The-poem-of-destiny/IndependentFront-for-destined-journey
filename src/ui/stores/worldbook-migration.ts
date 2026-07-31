/**
 * 世界书 localStorage → Dexie 一次性迁移（Phase 0 / 设计 D4）
 *
 * 🔴 本模块动的是**用户每一条世界书编辑的唯一副本**，且该副本今天不在任何备份里
 *    （`exportAllData()` 从不读 localStorage）。搞砸即不可恢复。
 *
 *    因此全程遵循一条铁律：**宁可迁移永不成功，也不能半成功。**
 *    任何一步失败都让 localStorage 原封不动、标志位不置，应用继续走旧路径，下次启动重试。
 *
 * D4 六步（顺序不可变）：
 *   1. 以显式标志位 `settings.worldBooksMigratedAt` 判定，**不**以「表里有没有行」判定
 *      —— 半失败的运行会留下行，看起来像已完成。
 *   2. 单个 `db.transaction` 内 `bulkPut`，写入全有或全无。
 *   3. 销毁前回读校验：书数量 + 逐本条目数量与源数组完全一致。
 *   4. 校验通过**才**删 localStorage 副本、置标志位（顺序不可颠倒）。
 *   5. 任何一步失败：localStorage 原封不动、标志位不置。
 *   6. 启动顺序：迁移 → 之后才跑内置书合并（针对 Dexie）。见 worldbook-store 的 `init()`。
 *
 * 不保留 localStorage 回滚副本 —— 留着就没释放配额，而释放配额正是本次迁移的目的。
 * 代价由第 3 步的校验强度承担。
 */
import { getDatabase } from '@engine/database';
import type { WorldBook } from '@engine/types';

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

/**
 * 迁移期间为化解 id 碰撞而做的重命名记录。
 *
 * 结构化返回（而非只打 console）是为了上层将来能如实告诉用户
 * 「你有两本重名的书，第二本已改名为 X」—— 静默改 id 和静默丢书一样不可接受。
 */
export interface WorldBookIdRename {
  /** 碰撞前的原 id（= 首次出现者保留的那个） */
  from: string;
  /** 分配到的新唯一 id */
  to: string;
  /** 书名，供 UI 提示时指认是哪一本 */
  name: string;
  /** 该书在源数组里的下标，便于排查 */
  sourceIndex: number;
}

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

/** 源数组读取 —— 只接受数组；其它形状（undefined/null/被写坏）一律当空 */
function readSource(settings: Record<string, unknown>): WorldBook[] {
  const raw = settings[LEGACY_BOOKS_KEY];
  return Array.isArray(raw) ? (raw as WorldBook[]) : [];
}

/**
 * 深拷贝 + 盖 updatedAt 戳。
 *
 * 深拷贝是必须的：源数组来自 Vue 响应式 ref，直接塞给 Dexie 会连 Proxy 一起走
 * structured clone（抛 DataCloneError）。同时也切断与源的引用，保证第 3 步校验
 * 比的是真正回读出来的字节，而不是同一个对象。
 */
function toRows(source: WorldBook[], now: number): WorldBook[] {
  return source.map((book) => ({
    ...(JSON.parse(JSON.stringify(book)) as WorldBook),
    updatedAt: typeof book.updatedAt === 'number' ? book.updatedAt : now,
  }));
}

/**
 * id 唯一化 —— **保内容优先**。
 *
 * 🔴 为什么必须有这一步：`settings.worldBooks` 里的 id 是可以撞的。
 *    `SettingsPage` 的新建按书名派生 id、导入按文件名派生 id，两处都是裸 `push`，
 *    没有任何去重。两本同 id 的书进 `bulkPut` 只会落一行 —— 而回读校验若按下标比对，
 *    `bulkGet(['x','x'])` 会把同一行返回两次，书数量/ id /条目数全对得上
 *    （同 id 通常来自重复导入同一文件，条目数必然相同）→ 校验通过 → 删 localStorage
 *    → **其中一本静默永久丢失**。
 *
 * 处置原则：
 * - **首次出现者保留原 id** —— 它可能已被 Agent 配置的 `worldBookIds` 引用，改了会断绑定。
 * - 后续碰撞者赋确定性新 id `${id}__dup2` / `__dup3` …，编号一直递增到不再与
 *   **任何**已占用 id 冲突（包括源里正好存在一本真的叫 `x__dup2` 的书）。
 * - 一条内容都不丢；重命名如实记账返回。
 *
 * 刻意**不**采取「碰撞即 verify 失败」：那会让这类用户永远卡在 localStorage 上、
 * 没有前进路径，把小问题变成死局。
 */
function dedupeIds(rows: WorldBook[]): { rows: WorldBook[]; renames: WorldBookIdRename[] } {
  const taken = new Set<string>(rows.map((b) => b.id)); // 先占住全部原始 id，新 id 不许撞上它们
  const seen = new Set<string>();
  const renames: WorldBookIdRename[] = [];

  const out = rows.map((book, sourceIndex) => {
    if (!seen.has(book.id)) {
      seen.add(book.id);
      return book;
    }
    // 撞了：为这一本找一个没人占的确定性新 id
    let n = 2;
    let candidate = `${book.id}__dup${n}`;
    while (taken.has(candidate) || seen.has(candidate)) {
      n += 1;
      candidate = `${book.id}__dup${n}`;
    }
    taken.add(candidate);
    seen.add(candidate);
    renames.push({ from: book.id, to: candidate, name: book.name, sourceIndex });
    return { ...book, id: candidate };
  });

  return { rows: out, renames };
}

/**
 * 执行迁移。**永不抛** —— 失败以 outcome 形式返回，调用方（store init）静默继续。
 */
export async function migrateWorldBooksToDexie(
  deps: WorldBookMigrationDeps,
): Promise<WorldBookMigrationOutcome> {
  const { settings, persistSettings } = deps;

  // ── 第 1 步：显式标志位判定 ──────────────────────────────
  // 刻意不看 `db.worldBooks.count()`：半失败的运行会留下行，看起来像已完成。
  if (settings[MIGRATED_FLAG_KEY]) {
    return { status: 'already-migrated' };
  }

  let db: AppDatabase;
  let rows: WorldBook[];
  let renames: WorldBookIdRename[];
  const now = Date.now();
  try {
    db = deps.db ?? getDatabase();
    // 预检 + 唯一化必须在写库**之前**：同 id 进 bulkPut 就已经只剩一行了，
    // 事后无论怎么校验都救不回来。
    const deduped = dedupeIds(toRows(readSource(settings), now));
    rows = deduped.rows;
    renames = deduped.renames;
  } catch (err) {
    return { status: 'failed', stage: 'read', message: String(err) };
  }

  // ── 第 2 步：单事务 bulkPut，全有或全无 ──────────────────
  // 空数组（全新用户）走同一条路径：bulkPut([]) 是 no-op，随后校验平凡通过，
  // 标志位置位收工。刻意**不 clear 表** —— 迁移只搬源里有的行，绝不销毁 Dexie 里
  // 已有的内容（例如上一轮失败后重试、或 resetAll 清掉标志位后的重跑）。
  try {
    await db.transaction('rw', db.worldBooks, async () => {
      if (rows.length > 0) await db.worldBooks.bulkPut(rows);
    });
  } catch (err) {
    return { status: 'failed', stage: 'write', message: String(err) };
  }

  // ── 第 3 步：销毁前回读校验 ──────────────────────────────
  try {
    const ids = rows.map((b) => b.id);
    // 不变式守卫：dedupeIds 之后 id 必然唯一。若这里还能撞，说明唯一化本身坏了 ——
    // 此时按下标比对会被「同一行返回两次」骗过去，宁可判失败也不能往下走。
    const uniqueIds = new Set(ids);
    if (uniqueIds.size !== ids.length) {
      return {
        status: 'failed',
        stage: 'verify',
        message: `id 唯一化失效: ${ids.length} 本书只有 ${uniqueIds.size} 个不同 id`,
      };
    }
    const readBack = await db.worldBooks.bulkGet(ids);
    if (readBack.length !== rows.length) {
      return {
        status: 'failed',
        stage: 'verify',
        message: `回读书数量不符: 期望 ${rows.length}，实际 ${readBack.length}`,
      };
    }
    for (let i = 0; i < rows.length; i++) {
      const expected = rows[i];
      const actual = readBack[i];
      if (!actual) {
        return { status: 'failed', stage: 'verify', message: `回读缺书: ${expected.id}` };
      }
      if (actual.id !== expected.id) {
        return {
          status: 'failed',
          stage: 'verify',
          message: `回读书 id 不符: 期望 ${expected.id}，实际 ${actual.id}`,
        };
      }
      const expectedEntries = expected.entries?.length ?? 0;
      const actualEntries = actual.entries?.length ?? 0;
      if (actualEntries !== expectedEntries) {
        return {
          status: 'failed',
          stage: 'verify',
          message: `《${expected.name}》条目数不符: 期望 ${expectedEntries}，实际 ${actualEntries}`,
        };
      }
    }
  } catch (err) {
    return { status: 'failed', stage: 'verify', message: String(err) };
  }

  // ── 第 4 步：校验通过才销毁源 + 置标志位（顺序不可颠倒）──
  // 从 settings 对象上删键，而不是只改 localStorage 字符串 —— settings-store 的
  // deep watch 会把整个对象重新序列化写回去，只改字符串下一拍就被覆盖。
  delete settings[LEGACY_BOOKS_KEY];
  settings[MIGRATED_FLAG_KEY] = Date.now();
  persistSettings();

  const entryCount = rows.reduce((sum, b) => sum + (b.entries?.length ?? 0), 0);
  return { status: 'migrated', bookCount: rows.length, entryCount, renames };
}
