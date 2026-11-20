/**
 * 露骨内容开关的文本过滤器（唯一真源）。
 *
 * 契约见 `docs/planning/2026-11-20-explicit-content-switch-design.md`：
 * - `<nsfw>X</nsfw>`：开关开 → 输出 X；关 → 整段删除。
 * - `<sfw>Y</sfw>`（可选的净版替身）：开关开 → 整段删除；关 → 输出 Y。
 * - 标签本身永远不输出（模型与界面都看不到标记）。
 * - 写坏时 fail-closed：关模式下宁可多删，绝不漏。
 *
 * 🔴 只在「使用时」过滤，永不写回存储（世界书编辑器要原文，存档冻结的文本也要随开关变化）。
 * 🔴 私有内容仓 `tools/nsfw-markup.mjs` 是本文件的镜像，两边共用
 *    `tests/fixtures/nsfw-markup-vectors.json` 这份测试向量，改语义必须两边同改。
 */

/** 四个规范标签。只认精确小写、无属性、无空格的写法。 */
import { getEngineSettings } from '../runtime/engine-settings';
import type { LoreEntryMeta, WorldBook, WorldBookEntry } from '../types/types';

const TAG_RE = /<(\/?)(nsfw|sfw)>/g;
/** 形似标签（大小写/属性/空格不规范），只给 lint 用。`NSFW_content` 因 `\b` 不会命中。 */
const LOOSE_TAG_RE = /<\s*\/?\s*(nsfw|sfw)\b[^>]*>/gi;
const EJS_RE = /<%[\s\S]*?%>/g;

type TagName = 'nsfw' | 'sfw';

/** 文本里是否出现任何规范标签（快速判断，绝大多数条目走这里直接返回）。 */
export function hasNsfwMarkup(text: string): boolean {
  return (
    typeof text === 'string' &&
    (text.includes('<nsfw>') ||
      text.includes('<sfw>') ||
      text.includes('</nsfw>') ||
      text.includes('</sfw>'))
  );
}

/**
 * 标签独占一行时，连同这一行的换行一起吃掉，避免剥标签后留下空行。
 * 返回 [起点, 终点)。
 */
function tagSpan(text: string, start: number, end: number): [number, number] {
  let lineStart = start;
  while (lineStart > 0 && (text[lineStart - 1] === ' ' || text[lineStart - 1] === '\t'))
    lineStart--;
  if (lineStart !== 0 && text[lineStart - 1] !== '\n') return [start, end];
  let lineEnd = end;
  while (lineEnd < text.length && (text[lineEnd] === ' ' || text[lineEnd] === '\t')) lineEnd++;
  if (lineEnd < text.length && text[lineEnd] === '\r') lineEnd++;
  if (lineEnd < text.length && text[lineEnd] === '\n') return [lineStart, lineEnd + 1];
  if (lineEnd === text.length) return [lineStart, lineEnd];
  return [start, end];
}

/**
 * 按开关处理文本。`enabled = true` 表示允许露骨内容。
 * 纯函数；不含标签的文本原样返回（同一个字符串引用）。
 */
export function applyNsfwMode(text: string, enabled: boolean): string {
  if (!hasNsfwMarkup(text)) return text;
  const visible = (tag: TagName) => (tag === 'nsfw' ? enabled : !enabled);
  let out = '';
  let cursor = 0;
  let open: TagName | null = null;
  let openAtLineStart = false;
  let removed = false;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(text); m; m = TAG_RE.exec(text)) {
    const closing = m[1] === '/';
    const tag = m[2] as TagName;
    const [from, to] = tagSpan(text, m.index, m.index + m[0].length);
    if (from < cursor) continue; // 防御：tagSpan 不会回退到已消费区
    const chunk = text.slice(cursor, from);
    if (open === null) {
      out += chunk;
      if (!closing) {
        open = tag; // 孤立闭标签：只删标签本身
        openAtLineStart = from === 0 || text[from - 1] === '\n';
      }
    } else {
      // 处在某个块内部：内层的任何标签（嵌套 / 错配闭标签）都只删标签、不改块边界。
      if (visible(open)) out += chunk;
      else if (chunk) removed = true;
      if (closing && tag === open) {
        // 整行都是被删掉的块（行首开、行尾闭）：连同行尾换行一起删，别留空行。
        if (!visible(open) && openAtLineStart && to === m.index + m[0].length) {
          let end = to;
          while (end < text.length && (text[end] === ' ' || text[end] === '\t')) end++;
          if (text[end] === '\r') end++;
          if (text[end] === '\n') {
            cursor = end + 1;
            open = null;
            continue;
          }
        }
        open = null;
      }
    }
    cursor = to;
  }
  const rest = text.slice(cursor);
  if (open === null || visible(open)) out += rest;
  else if (rest) removed = true; // 未闭合的隐藏块：删到末尾（fail-closed）
  return removed ? out.replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, '\n\n') : out;
}

/** 世界书条目 / 预设提示词 / 角色定义上的整条标记。 */
export function isNsfwFlagged(value: unknown): boolean {
  return typeof value === 'object' && value !== null && (value as { nsfw?: unknown }).nsfw === true;
}

export interface NsfwMarkupIssue {
  level: 'error' | 'warning';
  code: 'unclosed' | 'orphan-close' | 'nested' | 'malformed' | 'inside-ejs' | 'empty';
  /** 问题标签在原文中的字符偏移 */
  offset: number;
  message: string;
}

/**
 * 静态校验（内容仓构建 / 编辑器保存 / 引擎装包共用同一套规则）。
 * EJS 条目只检查模板字面文本；运行期条件分支造成的不配平由 `applyNsfwMode` fail-closed 兜底。
 */
export function lintNsfwMarkup(text: string): NsfwMarkupIssue[] {
  if (typeof text !== 'string' || !/<\s*\/?\s*s?n?sfw/i.test(text)) return [];
  const issues: NsfwMarkupIssue[] = [];
  const ejs: Array<[number, number]> = [];
  EJS_RE.lastIndex = 0;
  for (let m = EJS_RE.exec(text); m; m = EJS_RE.exec(text))
    ejs.push([m.index, m.index + m[0].length]);
  const inEjs = (offset: number) => ejs.some(([a, b]) => offset > a && offset < b);

  LOOSE_TAG_RE.lastIndex = 0;
  for (let m = LOOSE_TAG_RE.exec(text); m; m = LOOSE_TAG_RE.exec(text)) {
    if (!/^<\/?(nsfw|sfw)>$/.test(m[0]))
      issues.push({
        level: 'error',
        code: 'malformed',
        offset: m.index,
        message: `不规范的标记 ${m[0]}：只认 <nsfw> </nsfw> <sfw> </sfw>（小写、无属性、无空格）`,
      });
  }

  let open: { tag: TagName; offset: number; end: number } | null = null;
  TAG_RE.lastIndex = 0;
  for (let m = TAG_RE.exec(text); m; m = TAG_RE.exec(text)) {
    const closing = m[1] === '/';
    const tag = m[2] as TagName;
    if (inEjs(m.index)) {
      issues.push({
        level: 'error',
        code: 'inside-ejs',
        offset: m.index,
        message: `${m[0]} 写在 <% %> 代码块内部；标记只能写在模板字面文本里`,
      });
      continue;
    }
    if (!closing) {
      if (open) {
        issues.push({
          level: 'error',
          code: 'nested',
          offset: m.index,
          message: `<${tag}> 嵌套在 <${open.tag}> 内部；标记不可嵌套`,
        });
        continue;
      }
      open = { tag, offset: m.index, end: m.index + m[0].length };
      continue;
    }
    if (!open) {
      issues.push({
        level: 'error',
        code: 'orphan-close',
        offset: m.index,
        message: `孤立的 ${m[0]}`,
      });
      continue;
    }
    if (open.tag !== tag) {
      issues.push({
        level: 'error',
        code: 'nested',
        offset: m.index,
        message: `${m[0]} 与 <${open.tag}> 不匹配`,
      });
      continue;
    }
    if (text.slice(open.end, m.index).trim() === '')
      issues.push({
        level: 'warning',
        code: 'empty',
        offset: open.offset,
        message: `空的 <${tag}></${tag}>`,
      });
    open = null;
  }
  if (open)
    issues.push({
      level: 'error',
      code: 'unclosed',
      offset: open.offset,
      message: `<${open.tag}> 未闭合`,
    });
  return issues.sort((a, b) => a.offset - b.offset);
}

/** 当前是否允许露骨内容（经 `engine-settings` 注入缝每次现读）。 */
export function nsfwEnabled(): boolean {
  return getEngineSettings().nsfwContent;
}

/** 按当前开关过滤（`applyNsfwMode` 的便捷形式）。 */
export function filterNsfwText(text: string): string {
  return applyNsfwMode(text, nsfwEnabled());
}

/** 条目是否整条标记为露骨（`extra.lore.nsfw === true`）。 */
export function isNsfwEntry(entry: Pick<WorldBookEntry, 'extra'>): boolean {
  return isNsfwFlagged(entry.extra?.lore);
}

function filterLoreMeta(
  lore: LoreEntryMeta,
  enabled: boolean,
  removed: Set<string>,
): LoreEntryMeta {
  let next = lore;
  const patch = (key: keyof LoreEntryMeta, value: unknown) => {
    if (next === lore) next = { ...lore };
    (next as Record<string, unknown>)[key] = value;
  };
  if (typeof lore.summary === 'string') {
    const summary = applyNsfwMode(lore.summary, enabled);
    if (summary !== lore.summary) patch('summary', summary);
  }
  if (Array.isArray(lore.aliases) && lore.aliases.some(hasNsfwMarkup))
    patch(
      'aliases',
      lore.aliases.map((a) => applyNsfwMode(a, enabled)).filter((a) => a.trim()),
    );
  if (lore.definitions && Object.values(lore.definitions).some(hasNsfwMarkup))
    patch(
      'definitions',
      Object.fromEntries(
        Object.entries(lore.definitions).map(([k, v]) => [k, applyNsfwMode(v, enabled)]),
      ),
    );
  // 依赖指向被剔除的露骨条目：去掉这条边。否则路由把「依赖缺失」当失败，连带拒掉全年龄的根条目。
  if (removed.size > 0 && lore.dependsOn?.some((d) => removed.has(d)))
    patch(
      'dependsOn',
      lore.dependsOn.filter((d) => !removed.has(d)),
    );
  return next;
}

/**
 * 游戏侧世界书的开关投影：关模式剔除整条标记条目，并过滤路由元数据里会进提示词的文本
 * （summary / aliases / definitions）。**条目正文不在这里剥** —— 正文要等 EJS 渲染之后
 * 再过滤（见 worldbook-loader），否则跨越标签的 if/for 会被切坏。
 *
 * 纯函数、不改入参：没有任何变化时原样返回同一个数组（多数情况零拷贝）。
 * 🔴 世界书编辑器读的是 store 原书，绝不能把这里的结果写回去。
 */
export function filterNsfwBooks<T extends WorldBook>(books: readonly T[], enabled: boolean): T[] {
  const removed = new Set<string>();
  if (!enabled)
    for (const book of books)
      for (const entry of book.entries) if (isNsfwEntry(entry)) removed.add(entry.uid);
  let changed = false;
  const out = books.map((book) => {
    let bookChanged = false;
    const entries: WorldBookEntry[] = [];
    for (const entry of book.entries) {
      if (removed.has(entry.uid)) {
        bookChanged = true;
        continue;
      }
      const lore = entry.extra?.lore;
      const nextLore = lore ? filterLoreMeta(lore, enabled, removed) : lore;
      if (nextLore !== lore) {
        bookChanged = true;
        entries.push({ ...entry, extra: { ...entry.extra, lore: nextLore } });
      } else entries.push(entry);
    }
    if (!bookChanged) return book;
    changed = true;
    return { ...book, entries };
  });
  return changed ? out : (books as T[]);
}

/**
 * 预设提示词条目是否参与组装：自身 `enabled !== false`，且露骨内容开关关闭时排除
 * `nsfw: true` 的条目。所有「按 enabled 挑预设条目」的地方都要走这里，别各写各的。
 */
export function isPresetPromptActive(prompt: { enabled?: unknown; nsfw?: unknown }): boolean {
  if (prompt.enabled === false) return false;
  return !(prompt.nsfw === true && !nsfwEnabled());
}

/**
 * LLM 请求出口的安全网（`AgentClient.buildRequestBody`）：对每条消息的字符串 `content`
 * 再过一遍。🔴 只碰 `content`，不碰 `native`（Anthropic thinking / signature 块、Gemini
 * thoughtSignature 必须逐字回传，改一个字节就验签失败）。
 * 没有任何消息变化时返回同一个数组。
 */
export function filterNsfwMessages<T extends { content: string | null }>(
  messages: readonly T[],
  enabled: boolean,
): T[] {
  let changed = false;
  const out = messages.map((m) => {
    if (typeof m.content !== 'string') return m;
    const content = applyNsfwMode(m.content, enabled);
    if (content === m.content) return m;
    changed = true;
    return { ...m, content };
  });
  return changed ? out : (messages as T[]);
}
