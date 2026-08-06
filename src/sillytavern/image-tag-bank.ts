/**
 * image-tag-bank.ts — 标签词库的目录与查询（**全部是纯函数**）
 *
 * 检索模型（用户裁定，2026-08-05）：**AI 看目录 → 调工具 → 拿到标签 → 自己组装提示词**。
 * 不是「Code 按关键词挑好塞进提示词」——那个方案把「这张图该用哪几条」的判断交给了
 * 子串匹配，而它恰恰是 AI 比正则强的地方。
 *
 * 于是本模块只提供三件事，一件 I/O 都没有：
 *   ① {@link formatTagBankCatalogue} —— 几千条 → 一份**只有名字**的目录（进 system 消息）
 *   ② {@link lookupTagEntries}       —— `get_image_tags` 的实现：按名精确取标签
 *   ③ {@link searchTagEntries}       —— `search_image_tags` 的实现：按别名子串找
 *
 * 🔴 **目录必须逐字节稳定**。它是几万字符、每次出图都要发一遍的东西，唯一能让它不烧钱的
 *    办法是落进 prompt cache 的稳定前缀（与 `LORE_BOOK_STATIC` 的静态区同一条道理）。
 *    所以这里排序不用 `localeCompare`（依赖运行环境 ICU 数据）、不掺时间戳、不掺随机数：
 *    同一本词库渲染两次必须是同一串字节，否则每张图都在为一份没变的目录付全价。
 */

import type { TagAlternatives, TagBank, TagBankEntry } from './types-image';

// ═══════════════════════════════════════════════════════════
// 取数
// ═══════════════════════════════════════════════════════════

/**
 * 若干本词库 → 真正生效的条目。
 *
 * 两层开关都要过：整本 `enabled`（不删就能试）与条目 `enabled`（上游 `disable`）。
 */
export function collectEnabledEntries(banks: TagBank[]): TagBankEntry[] {
  const out: TagBankEntry[] = [];
  for (const bank of banks) {
    if (!bank.enabled) continue;
    for (const entry of bank.entries) {
      if (entry.enabled) out.push(entry);
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// ① 目录
// ═══════════════════════════════════════════════════════════

/** 条目名之间的分隔符。**不能用 `/`** —— 名字里就有斜杠（`公园/长椅`） */
const NAME_SEP = '、';

/** 目录默认上限（字符）。超了不静默砍，见 {@link formatTagBankCatalogue} */
export const CATALOGUE_DEFAULT_MAX_CHARS = 60_000;

export interface CatalogueOptions {
  /** 字符上限；超出部分照实报，不静默丢 */
  maxChars?: number;
}

/**
 * 词库 → 给 AI 看的目录（**只有名字，没有标签**）。
 *
 * `alwaysOn` 的条目是例外：它们**连标签一起印**。那一档是作者标记的「每张图都成立」
 * （画风基调这类），让 AI 为它们各跑一次工具往返纯属浪费。
 *
 * 超过 `maxChars` 时**明说截断了多少条**并指路 `search_image_tags` ——
 * 静默截断会让模型以为目录就是全部，它不会去搜自己不知道存在的东西。
 */
export function formatTagBankCatalogue(
  entries: TagBankEntry[],
  options: CatalogueOptions = {},
): string {
  if (entries.length === 0) return '';
  const maxChars = options.maxChars ?? CATALOGUE_DEFAULT_MAX_CHARS;

  const alwaysOn = entries.filter((e) => e.alwaysOn);
  const listed = entries.filter((e) => !e.alwaysOn);

  const lines: string[] = [];

  if (alwaysOn.length > 0) {
    lines.push('── 常驻标签（每张图都适用，无需查询）──');
    for (const e of sortEntries(alwaysOn)) {
      lines.push(`[${e.category}] ${e.name}：${formatTags(e.tags)}`);
    }
    lines.push('');
  }

  const groups = groupByCategory(listed);
  const total = listed.length;
  lines.push(`── 词库目录（${total} 条 / ${groups.length} 类，只列名字）──`);

  let used = lines.join('\n').length;
  let printed = 0;
  let truncated = false;

  for (const group of groups) {
    const line = `[${group.category}] ${group.names.join(NAME_SEP)}`;
    if (used + line.length + 1 > maxChars) {
      truncated = true;
      break;
    }
    lines.push(line);
    used += line.length + 1;
    printed += group.names.length;
  }

  if (truncated) {
    // 🔴 照实说漏了多少 —— 模型不会去搜一个它不知道存在的东西
    lines.push(
      `（目录过长，此处只列出 ${printed}/${total} 条；未列出的请用 search_image_tags 按中文关键词查找）`,
    );
  }

  return lines.join('\n');
}

/** 分类 → 名字列表。分类之间按**首次出现的 order** 排，于是保住上游的聚簇 */
function groupByCategory(entries: TagBankEntry[]): Array<{ category: string; names: string[] }> {
  const groups = new Map<string, { category: string; minOrder: number; entries: TagBankEntry[] }>();
  for (const e of entries) {
    const g = groups.get(e.category);
    if (g) {
      g.entries.push(e);
      if (e.order < g.minOrder) g.minOrder = e.order;
    } else {
      groups.set(e.category, { category: e.category, minOrder: e.order, entries: [e] });
    }
  }
  return [...groups.values()]
    .sort((a, b) => a.minOrder - b.minOrder || compareStable(a.category, b.category))
    .map((g) => ({ category: g.category, names: sortEntries(g.entries).map((e) => e.name) }));
}

/** 条目排序：order 优先，同 order 按名字 —— 同一本书每次渲染都是同一串字节 */
function sortEntries(entries: TagBankEntry[]): TagBankEntry[] {
  return [...entries].sort((a, b) => a.order - b.order || compareStable(a.name, b.name));
}

/**
 * 字符串比较 —— **不用 `localeCompare`**。
 *
 * 它依赖运行环境的 ICU 数据，同一份词库在不同浏览器里会排出不同顺序，
 * 目录字节一变，prompt cache 的前缀当场作废（`ejs-fmt.compareName` 同一条）。
 */
function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ═══════════════════════════════════════════════════════════
// 标签格式化（工具返回值与目录共用同一份写法）
// ═══════════════════════════════════════════════════════════

/** 同类候选之间的分隔符。工具说明里会解释一次它的含义 */
const ALT_SEP = ' | ';

/**
 * 标签格 → 一行字符串。
 *
 * `[['onsen'],['hot spring']]`            → `onsen, hot spring`
 * `[['animal ears','cat ears']]`          → `animal ears | cat ears`
 *
 * 逗号 = 同时成立，`|` = 同类候选（通常择一）。这两个语义在上游语料里是分开的，
 * 到这里仍然分开 —— 压平会让模型把六种耳朵一起画上去。
 */
export function formatTags(tags: TagAlternatives[]): string {
  return tags.map((alternatives) => alternatives.join(ALT_SEP)).join(', ');
}

/**
 * 工具返回给模型的一条。字段刻意少 —— 它每一个字节都要过 token。
 *
 * **刻意不 export**：它只作为 `TagBankLookupResult` / `TagBankSearchResult` 的字段类型出现，
 * 外部拿到的是那两个结构、按属性读即可。导出一个没人按名字引用的类型会被 knip 棘轮记成
 * 死代码（正确修法是去掉 `export` 而非删代码）。真有消费方要按名引用时再导出。
 */
interface TagBankHit {
  name: string;
  category: string;
  /** 见 {@link formatTags} */
  tags: string;
}

function toHit(entry: TagBankEntry): TagBankHit {
  return { name: entry.name, category: entry.category, tags: formatTags(entry.tags) };
}

// ═══════════════════════════════════════════════════════════
// ② 精确取
// ═══════════════════════════════════════════════════════════

export interface TagBankLookupResult {
  found: TagBankHit[];
  /** 没查到的名字。**必须回报** —— 少给一条而不吭声，模型会以为那条本来就没标签 */
  notFound: string[];
}

/**
 * `get_image_tags` 的实现：按目录里的名字取标签。
 *
 * 匹配是**精确的**（trim 之后逐字节相等），另外接受 `分类:名字` 的写法供同名条目消歧。
 * 不做模糊回退：目录里的名字是模型刚刚读到的字符串，它写不对就是真的写错了，
 * 而模糊匹配会把「写错」变成「安静地给了另一条的标签」。找不到的走 `search_image_tags`。
 *
 * 同名条目（不同分类）**全部返回** —— 这是导入期 `duplicate` note 说过的事。
 */
export function lookupTagEntries(entries: TagBankEntry[], names: string[]): TagBankLookupResult {
  const found: TagBankHit[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();

  for (const rawName of names) {
    if (typeof rawName !== 'string') continue;
    const query = rawName.trim();
    if (query === '') continue;

    // `分类:名字` 消歧写法；全角冒号同权
    const sep = query.search(/[:：]/);
    const qCategory = sep > 0 ? query.slice(0, sep).trim() : '';
    const qName = sep > 0 ? query.slice(sep + 1).trim() : query;

    const matches = entries.filter(
      (e) => e.name.trim() === qName && (qCategory === '' || e.category === qCategory),
    );

    if (matches.length === 0) {
      // 带分类找不到时，退一步只按名字找 —— 分类写错不该让标签消失
      const byNameOnly = qCategory === '' ? [] : entries.filter((e) => e.name.trim() === qName);
      if (byNameOnly.length === 0) {
        notFound.push(query);
        continue;
      }
      matches.push(...byNameOnly);
    }

    for (const m of matches) {
      if (seen.has(m.key)) continue;
      seen.add(m.key);
      found.push(toHit(m));
    }
  }

  return { found, notFound };
}

// ═══════════════════════════════════════════════════════════
// ③ 模糊找
// ═══════════════════════════════════════════════════════════

/** 一次搜索最多回几条 —— 回太多等于把目录又发了一遍 */
export const SEARCH_DEFAULT_LIMIT = 12;

export interface TagBankSearchResult {
  query: string;
  hits: TagBankHit[];
  /** 命中数超过 limit 时的实际总数；照实报，不装作只有这些 */
  totalMatches: number;
}

/**
 * `search_image_tags` 的实现：按**别名**子串找。
 *
 * 别名在导入期就已经含了名字本身（`buildAliases`），所以这里只看 `aliases` 一个字段。
 * 打分取**最长命中别名的长度** —— 查「猫耳」时，别名恰好是「猫耳朵」的那条比某个
 * 名字里碰巧含「耳」的条目更该排前面。
 *
 * ASCII 大小写不敏感（有些词库的别名是英文）；中文没有大小写，`toLowerCase` 对它无害。
 */
export function searchTagEntries(
  entries: TagBankEntry[],
  query: string,
  limit: number = SEARCH_DEFAULT_LIMIT,
): TagBankSearchResult {
  const needle = (query ?? '').trim().toLowerCase();
  if (needle === '') return { query: query ?? '', hits: [], totalMatches: 0 };

  const scored: Array<{ entry: TagBankEntry; score: number }> = [];
  for (const entry of entries) {
    let best = 0;
    for (const alias of entry.aliases) {
      const a = alias.toLowerCase();
      // 双向包含：查「猫耳」命中别名「猫耳朵」，查「森林小屋」命中别名「小屋」
      if (a.includes(needle) || needle.includes(a)) {
        best = Math.max(best, Math.min(a.length, needle.length));
      }
    }
    if (best > 0) scored.push({ entry, score: best });
  }

  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.order - b.entry.order ||
      compareStable(a.entry.name, b.entry.name),
  );

  return {
    query,
    hits: scored.slice(0, Math.max(1, limit)).map((s) => toHit(s.entry)),
    totalMatches: scored.length,
  };
}
