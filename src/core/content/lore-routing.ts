/**
 * 世界书条目路由 —— **哪个 Agent 能读哪一条**的唯一判据（内容计划 §3.1 / §3.2 / §5 / §7）。
 *
 * 读取范围只由条目 `extra.lore.audiences` 决定；书级（原「类」级）声明已取消，旧内容包的
 * 兼容映射（`agentDefaults` 的 `worldBookEnabled` + `worldBookIds`、内置/工坊默认范围）
 * 已随本次改动一并移除。没有声明读取范围的条目**不注入**，并出现在
 * `collectLoreRoutingIssues` 的诊断里（CQ01）。
 *
 * 🔴 依赖、EJS 的 `lore.get`、模板、Delta 签名全部经 `isLoreEntryVisibleTo` 这一个判据；
 *    依赖关系不授予额外读取权限（§3.2）。
 * 纯函数、无 I/O；不修改入参。
 */
import type { LoreSection, LoreReadContext, WorldBook, WorldBookEntry } from '../types/types';

type BookLike = Pick<WorldBook, 'id' | 'lore'> & Partial<Pick<WorldBook, 'name' | 'partition'>>;
type EntryLike = Pick<WorldBookEntry, 'uid'> & Partial<Pick<WorldBookEntry, 'extra' | 'name'>>;

/** 稳定条目键：声明了就用声明的，否则派生 `命名空间#uid`（uid 只在单本书内唯一）。 */
export function loreEntryKey(book: BookLike, entry: EntryLike): string {
  const declared = entry.extra?.lore?.key;
  if (typeof declared === 'string' && declared.trim() !== '') return declared.trim();
  return `${book.lore?.namespace ?? book.id}#${entry.uid}`;
}

/** 条目的读取范围：只认条目自己的 `extra.lore.audiences`；没有 = 谁也不能读。 */
function loreEntryAudiences(_book: BookLike, entry: EntryLike): readonly string[] {
  return entry.extra?.lore?.audiences ?? [];
}

/** 条目在 Story 新模式里的放置：只认条目自己的声明；没有 = 未声明（消费端默认固定区）。 */
export function loreEntrySection(_book: BookLike, entry: EntryLike): LoreSection | undefined {
  return entry.extra?.lore?.section;
}

/** 唯一的可见性判据。 */
export function isLoreEntryVisibleTo(agentId: string, book: BookLike, entry: EntryLike): boolean {
  return agentId !== '' && loreEntryAudiences(book, entry).includes(agentId);
}

/** 一本书里某 Agent 可见的条目，附带书与稳定键（资料选择与调试用）。 */
export interface RoutedLoreEntry {
  book: WorldBook;
  entry: WorldBookEntry;
  key: string;
}

/** 某 Agent 可见的全部条目（书序 + 书内原序；不过滤 enabled，交给 `filterActiveEntries`）。 */
export function routeLoreEntriesForAgent(
  agentId: string,
  books: readonly WorldBook[],
): RoutedLoreEntry[] {
  const out: RoutedLoreEntry[] = [];
  for (const book of books) {
    for (const entry of book.entries ?? []) {
      if (isLoreEntryVisibleTo(agentId, book, entry)) {
        out.push({ book, entry, key: loreEntryKey(book, entry) });
      }
    }
  }
  return out;
}

/** Shared deterministic read gate. Selection may add relevance, never relax this gate. */
export function resolveLoreDependenciesForAgent(
  agentId: string,
  books: readonly WorldBook[],
  recentText = '',
  readContext?: LoreReadContext,
): {
  entries: RoutedLoreEntry[];
  closures: ReadonlyMap<string, readonly RoutedLoreEntry[]>;
  blockedDependencyKeys: string[];
  rejectedRoots: Array<{ key: string; dependencyKey: string; reason: string }>;
  excludedEntries: Array<{ key: string; reason: string }>;
} {
  const all = new Map<string, RoutedLoreEntry>();
  const duplicates = new Set<string>();
  for (const book of books) {
    for (const entry of book.entries ?? []) {
      const key = loreEntryKey(book, entry);
      if (all.has(key)) duplicates.add(key);
      else all.set(key, { book, entry, key });
    }
  }
  const unavailable = (key: string): string | undefined => {
    const r = all.get(key);
    if (!r) return 'missing';
    if (duplicates.has(key)) return 'duplicate-key';
    if (!r.entry.enabled) return 'disabled';
    if (!isLoreEntryVisibleTo(agentId, r.book, r.entry)) return 'not-readable';
    if (
      (r.entry.extra?.lore?.activation?.excludeKeywords ?? []).some(
        (word) => word !== '' && (readContext?.recentText ?? recentText).includes(word),
      )
    )
      return 'excluded';
    return undefined;
  };
  const closures = new Map<string, readonly RoutedLoreEntry[]>();
  const failures = new Map<string, { dependencyKey: string; reason: string }>();
  const visiting = new Set<string>();
  const expand = (key: string): readonly RoutedLoreEntry[] | null => {
    if (closures.has(key)) return closures.get(key)!;
    if (failures.has(key)) return null;
    const reason = unavailable(key) ?? (visiting.has(key) ? 'cycle' : undefined);
    if (reason) {
      failures.set(key, { dependencyKey: key, reason });
      return null;
    }
    const r = all.get(key)!;
    visiting.add(key);
    const result = new Map<string, RoutedLoreEntry>();
    for (const dep of r.entry.extra?.lore?.dependsOn ?? []) {
      const closure = expand(dep);
      if (!closure) {
        failures.set(key, failures.get(dep)!);
        visiting.delete(key);
        return null;
      }
      for (const item of closure) result.set(item.key, item);
    }
    visiting.delete(key);
    result.set(key, r);
    const closure = [...result.values()];
    closures.set(key, closure);
    return closure;
  };
  const entries: RoutedLoreEntry[] = [];
  const rejectedRoots: Array<{ key: string; dependencyKey: string; reason: string }> = [];
  const excludedEntries: Array<{ key: string; reason: string }> = [];
  for (const r of all.values()) {
    // Disabled, excluded and unreadable entries are never roots, but may explain a failed dependency.
    const reason = unavailable(r.key);
    if (reason) {
      excludedEntries.push({ key: r.key, reason });
      continue;
    }
    if (expand(r.key)) entries.push(r);
    else rejectedRoots.push({ key: r.key, ...failures.get(r.key)! });
  }
  return {
    entries,
    closures,
    blockedDependencyKeys: [...new Set(rejectedRoots.map((r) => r.dependencyKey))],
    rejectedRoots,
    excludedEntries,
  };
}

type LoreRoutingIssueKind =
  /** 条目与书都没有声明读取范围 → 不会注入给任何 Agent（显式声明 `[]` 不算） */
  | 'no-audiences'
  /** 读取范围里有不认识的 Agent ID */
  | 'unknown-agent'
  /** 两条启用条目的稳定键相同 */
  | 'duplicate-key'
  /** 依赖指向不存在的条目键 */
  | 'missing-dependency'
  /** 依赖存在，但依赖方的读取范围里有 Agent 读不到被依赖条目（依赖不授予权限） */
  | 'dependency-not-readable';

export interface LoreRoutingIssue {
  kind: LoreRoutingIssueKind;
  bookId: string;
  bookName: string;
  entryUid: number;
  entryName: string;
  key: string;
  detail?: string;
}

/**
 * 路由诊断（内容计划 §7.3）：缺元数据、未知 Agent、重复键、依赖缺失或不可读，
 * 都能定位到具体书与条目。只看启用条目（停用条目本来就不注入）。
 *
 * @param knownAgentIds 给了才检查未知 Agent ID
 */
export function collectLoreRoutingIssues(
  books: readonly WorldBook[],
  knownAgentIds?: readonly string[],
): LoreRoutingIssue[] {
  const issues: LoreRoutingIssue[] = [];
  const known = knownAgentIds ? new Set(knownAgentIds) : null;
  const byKey = new Map<string, { book: WorldBook; entry: WorldBookEntry }>();
  const enabled: Array<{ book: WorldBook; entry: WorldBookEntry; key: string }> = [];
  for (const book of books) {
    for (const entry of book.entries ?? []) {
      if (!entry.enabled) continue;
      enabled.push({ book, entry, key: loreEntryKey(book, entry) });
    }
  }
  const at = (book: WorldBook, entry: WorldBookEntry, key: string) => ({
    bookId: book.id,
    bookName: book.name,
    entryUid: entry.uid,
    entryName: entry.name,
    key,
  });
  for (const { book, entry, key } of enabled) {
    const audiences = loreEntryAudiences(book, entry);
    // 显式声明为空（`audiences: []`）是作者的决定，不算缺元数据
    if (entry.extra?.lore?.audiences === undefined) {
      issues.push({ kind: 'no-audiences', ...at(book, entry, key) });
    }
    if (known) {
      const unknown = audiences.filter((id) => !known.has(id));
      if (unknown.length > 0) {
        issues.push({ kind: 'unknown-agent', ...at(book, entry, key), detail: unknown.join(',') });
      }
    }
    if (byKey.has(key)) issues.push({ kind: 'duplicate-key', ...at(book, entry, key) });
    else byKey.set(key, { book, entry });
  }
  for (const { book, entry, key } of enabled) {
    const audiences = loreEntryAudiences(book, entry);
    for (const dep of entry.extra?.lore?.dependsOn ?? []) {
      const target = byKey.get(dep);
      if (!target) {
        issues.push({ kind: 'missing-dependency', ...at(book, entry, key), detail: dep });
        continue;
      }
      const targetAudiences = loreEntryAudiences(target.book, target.entry);
      const blocked = audiences.filter((id) => !targetAudiences.includes(id));
      if (blocked.length > 0) {
        issues.push({
          kind: 'dependency-not-readable',
          ...at(book, entry, key),
          detail: `${dep} → ${blocked.join(',')}`,
        });
      }
    }
  }
  return issues;
}
