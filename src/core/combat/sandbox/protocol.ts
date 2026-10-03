/**
 * 战斗沙盒协议文本装载（Phase 2 战斗重写）
 *
 * 战斗协议正文住在新增世界书 `combat_extra`（引擎占位 `public/data/worldbooks/combat_extra.json`，
 * 真实内容由私有内容仓 pack 供给）。战斗时由 **Code 直接注入**协议条目正文，
 * **不依赖世界书 EJS 激活**（那套是 ST 的 `$('#chat .mes')` 判断，本引擎跑不了）。
 *
 * 🔴 取正文时**不看条目 `enabled`**：这里不是世界书激活路径，而是 Code 点名取文。
 *    pack 若把协议条目默认关闭，仍应能被战斗会话取到。
 * 🔴 注册表/Dexie 读取一律按调用时刻惰性发生（承 content-registry-runtime 时序契约）。
 */

import type { WorldBook, WorldBookEntry } from '../../types/types';

/** `combat_extra` 世界书 id */
export const COMBAT_EXTRA_BOOK_ID = 'combat_extra';

/**
 * 战斗协议相关条目名（真实内容的条目名）。`name` 完全等于或包含其中之一即命中。
 * 顺序即建议注入顺序（最终仍按条目 `order` 排序）。
 */
export const COMBAT_PROTOCOL_ENTRY_NAMES = [
  '战斗协议',
  '战斗协议概览',
  '战前资源推演',
  '战斗生产规则',
  '状态规则',
  '核心数值表',
] as const;

/**
 * 纯函数：从世界书条目里挑出战斗协议条目并拼成注入正文。
 *
 * 命中判据 = `name` 恰好等于或包含 {@link COMBAT_PROTOCOL_ENTRY_NAMES} 中任一项；
 * 命中集按 `order` 升序（同 order 按 name 稳定）拼接，段间空行分隔。无命中返回 ''。
 */
export function assembleCombatProtocolText(entries: readonly WorldBookEntry[]): string {
  const matched = entries.filter((entry) =>
    COMBAT_PROTOCOL_ENTRY_NAMES.some((n) => entry.name === n || entry.name.includes(n)),
  );
  if (matched.length === 0) return '';

  return matched
    .slice()
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((entry) => entry.content.trim())
    .filter((content) => content.length > 0)
    .join('\n\n');
}

/** 世界书装载依赖（测试注入用；缺省走 Dexie → 占位文件） */
export interface CombatProtocolLoaderDeps {
  getWorldBook?: (id: string) => Promise<WorldBook | undefined>;
}

/** 缺省装载：先查本机 Dexie（含 pack/用户编辑），再回落占位文件 fetch */
async function defaultGetWorldBook(id: string): Promise<WorldBook | undefined> {
  try {
    const { getDatabase } = await import('../../persistence/database');
    const row = await getDatabase().worldBooks.get(id);
    if (row) return row;
  } catch {
    /* DB 未就绪（引擎单测/无 UI）→ 回落文件 */
  }
  try {
    const res = await fetch(`/data/worldbooks/${id}.json`);
    if (res.ok) return (await res.json()) as WorldBook;
  } catch {
    /* 离线/占位文件缺失 → 无协议 */
  }
  return undefined;
}

/**
 * 装载战斗协议注入文本。找不到书 / 无命中条目 → ''（调用方自行决定兜底措辞）。
 */
export async function loadCombatProtocolText(deps: CombatProtocolLoaderDeps = {}): Promise<string> {
  const getWorldBook = deps.getWorldBook ?? defaultGetWorldBook;
  const book = await getWorldBook(COMBAT_EXTRA_BOOK_ID);
  if (!book) return '';
  return assembleCombatProtocolText(book.entries ?? []);
}
