/**
 * Phase 8: 项目内置世界书预加载
 *
 * 运行时通过 fetch 加载 data/worldbooks/*.json，确保始终获取最新文件内容。
 * （不用 import.meta.glob eager，否则构建时打包旧数据，且 HMR 全页刷新）
 */

import type { WorldBook } from './types';
import { reportContentFetch } from './content-source';

/** 内置世界书文件名列表 */
const BUILTIN_IDS = [
  'world_setting',
  'race',
  'faction',
  'character',
  'event',
  'adventure_area',
  'monster_ecology',
  'industry',
  'organization',
  'system_core',
  'variable',
  'quick_feature',
  'extra_setting',
  'cot',
  'dlc',
];

/** 运行时从 /data/worldbooks/ 加载所有内置世界书 */
export async function loadBuiltInWorldBooks(): Promise<WorldBook[]> {
  const books: WorldBook[] = [];
  for (const id of BUILTIN_IDS) {
    try {
      const res = await fetch(`/data/worldbooks/${id}.json`);
      if (!res.ok) {
        // 内容-引擎分离（波 1 T2 / §5.5 census）：上报内容态，不阻塞启动。
        reportContentFetch({
          source: 'builtin-worldbooks.loadBuiltInWorldBooks',
          status: res.status,
          ok: false,
          error: `book ${id}: HTTP ${res.status}`,
        });
        continue;
      }
      const book = (await res.json()) as WorldBook;
      if (book.builtIn) {
        books.push({ ...book, entries: book.entries || [] });
      }
    } catch (err) {
      // 文件不存在或加载失败，跳过
      reportContentFetch({
        source: 'builtin-worldbooks.loadBuiltInWorldBooks',
        ok: false,
        error: `book ${id}: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  if (books.length > 0) {
    reportContentFetch({ source: 'builtin-worldbooks.loadBuiltInWorldBooks', ok: true });
  }
  return books;
}

/**
 * 统一世界书数据源（所有 agent 共用）：Pinia store 优先（含用户在 WorldBookEditor 的
 * enabled 修改 + 自建书），store 尚未填充时兜底 fetch 本地 JSON。
 *
 * 消除"plot_outline 读文件、game-pipeline 读 store"的分裂——用户的条目级 enabled 修改
 * 对所有 agent 一致生效，不再有 agent 绕过 store 直接读原始文件。
 */
export async function loadWorldBooksWithFallback(
  storeBooks: WorldBook[] | undefined | null,
): Promise<WorldBook[]> {
  if (storeBooks && storeBooks.length > 0) return storeBooks;
  return loadBuiltInWorldBooks();
}
