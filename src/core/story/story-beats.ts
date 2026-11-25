/**
 * 正文分节（交互式推进，2026-11-19）。
 *
 * 模型在 `<maintext>` 内用独占一行的 `<beat/>` 把正文切成节，新角色首次现身那一节前写
 * `<beat enter="人物名"/>`。本模块把标记从正文里剥掉，节与节之间统一以 `\n\n` 拼接，
 * 断点偏移与登场锚点另存为旁路数据（`ChatMessage.stage`）。
 *
 * 🔴 这里**刻意不进 MARKER_SPECS**：那张表的宽松扫描遇到漏写闭合会把后文整段吞掉，
 *    而分节标记写错的代价只该是「少切一刀」，绝不能吃掉正文。
 * 🔴 标记写错一律容忍、从不抛：认不出的属性忽略，空节丢弃，落在 action_info / item_info
 *    面板里的标记只剥不切（面板不能被切成两半）。
 * 🔴 没有任何标记时 content 原样返回（逐字节不变），旧档与不分节的模型零影响。
 */

import type { StoryStage, StoryStageEnter } from '../types/types';

export type { StoryStage, StoryStageEnter } from '../types/types';

/** `extractStoryBeats` 的结果：剥掉标记后的正文 + 断点 + 登场锚点。 */
export interface StoryBeatExtraction {
  content: string;
  /** 第 2 节起每节的起始偏移（严格递增，前两字符恒为 `\n\n`）；无标记时为空。 */
  breaks: number[];
  enters: StoryStageEnter[];
}

/** `resolveStoryStage` 的结果：校验后可直接用于切节的断点与登场锚点。 */
export interface ResolvedStoryStage {
  breaks: number[];
  enters: StoryStageEnter[];
  /** true = 旁路数据缺席或失效，断点是按段落兜底切出来的。 */
  fallback: boolean;
}

/** 认 `<beat>`、`<beat/>`、`</beat>`、`<beat enter="..."/>`（大小写不敏感）。 */
const BEAT_MARKER_SOURCE = String.raw`<\/?beat\b[^>]*>`;
const ENTER_ATTR = /\benter\s*=\s*(?:"([^"]*)"|'([^']*)'|“([^”]*)”|([^\s"'/>]+))/i;
/**
 * 面板标签（开 / 闭）识别的**唯一一份**正则源：`<action_info>`、`< action_info >`、
 * `<action_info type="a">`、`</ action_info >`、`<item_info>`，大小写不敏感。
 * 组 1 = `/`（闭标签）或缺席，组 2 = 标签名。前端的面板拆分（`ui/lib/action-panel.ts`）
 * 与逐节演出（`ui/lib/stage-playback.ts`）都从这里取，别再各写一份 —— 三处口径一旦不同，
 * 同一块面板会一处当面板、一处漏成原文或被切成两节。
 * 写成 `<\s*(?:(\/)\s*)?` 而不是 `<\s*\/?\s*`：两段相邻的 `\s*` 在长空白上会平方级回溯。
 */
const PANEL_TAG_SOURCE = String.raw`<\s*(?:(\/)\s*)?(action_info|item_info)\b[^>]*>`;

/** 按 `PANEL_TAG_SOURCE` 新建一个正则（每次新建，免得共享 lastIndex）。 */
export function panelTagPattern(flags = 'gi'): RegExp {
  return new RegExp(PANEL_TAG_SOURCE, flags);
}

/**
 * 面板块所占区间 `[开标签起点, 闭标签终点)`：从一个开标签起到同名闭标签为止，
 * 其间别的面板标签不算；漏写闭合时视为延伸到文末（流式中常见）。
 */
export function panelBlockRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let openTag: string | null = null;
  let openAt = 0;
  for (const match of text.matchAll(panelTagPattern())) {
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (!closing && openTag === null) {
      openTag = tag;
      openAt = match.index ?? 0;
    } else if (closing && openTag === tag) {
      ranges.push([openAt, (match.index ?? 0) + match[0].length]);
      openTag = null;
    }
  }
  if (openTag !== null) ranges.push([openAt, text.length]);
  return ranges;
}
const PARAGRAPH_GAP = /\n\n+/g;

/** 文本里是否出现了分节标记（任一形态）。 */
export function hasBeatMarkers(text: string): boolean {
  return new RegExp(BEAT_MARKER_SOURCE, 'i').test(text);
}

function insidePanel(ranges: Array<[number, number]>, offset: number): boolean {
  return ranges.some(([start, end]) => offset > start && offset < end);
}

function parseEnterNames(marker: string): string[] {
  const match = ENTER_ATTR.exec(marker);
  if (!match) return [];
  const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? '';
  return value
    .split(/[、,，]/)
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
}

/** 去掉节首的空行与节尾空白；节首缩进（含全角空格）保留。 */
function tidySegment(segment: string): string {
  return segment.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

/**
 * 剥掉分节标记，返回拼接后的正文、断点与登场锚点。
 * 无标记时 `content === text`、`breaks` 与 `enters` 皆空。
 */
export function extractStoryBeats(text: string): StoryBeatExtraction {
  if (!hasBeatMarkers(text)) return { content: text, breaks: [], enters: [] };

  const panels = panelBlockRanges(text);
  const segments: Array<{ text: string; enters: string[] }> = [];
  let current = '';
  let currentEnters: string[] = [];
  let cursor = 0;

  for (const match of text.matchAll(new RegExp(BEAT_MARKER_SOURCE, 'gi'))) {
    const index = match.index ?? 0;
    const names = parseEnterNames(match[0]);
    let end = index + match[0].length;
    if (insidePanel(panels, index)) {
      // 面板里的标记只剥不切；独占一行时连同行尾换行一起剥，免得面板中间多出空行
      if ((index === 0 || text[index - 1] === '\n') && text[end] === '\n') end += 1;
      current += text.slice(cursor, index);
      currentEnters.push(...names);
    } else {
      segments.push({ text: current + text.slice(cursor, index), enters: currentEnters });
      current = '';
      currentEnters = names;
    }
    cursor = end;
  }
  segments.push({ text: current + text.slice(cursor), enters: currentEnters });

  let content = '';
  const breaks: number[] = [];
  const enters: StoryStageEnter[] = [];
  const seen = new Set<string>();
  let carried: string[] = [];
  for (const segment of segments) {
    const body = tidySegment(segment.text);
    const names = [...carried, ...segment.enters];
    if (!body) {
      // 空节丢弃，登场名顺延到下一个非空节
      carried = names;
      continue;
    }
    carried = [];
    if (content) {
      content += '\n\n';
      breaks.push(content.length);
    }
    const at = content.length;
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      enters.push({ name, at });
    }
    content += body;
  }
  return { content, breaks, enters };
}

function paragraphBreaks(content: string): number[] {
  const panels = panelBlockRanges(content);
  const breaks: number[] = [];
  PARAGRAPH_GAP.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PARAGRAPH_GAP.exec(content)) !== null) {
    const offset = match.index + match[0].length;
    if (offset < content.length && !insidePanel(panels, offset)) breaks.push(offset);
  }
  return breaks;
}

function breaksValid(content: string, breaks: readonly number[]): boolean {
  if (!Array.isArray(breaks) || breaks.length === 0) return false;
  const panels = panelBlockRanges(content);
  let previous = 0;
  for (const offset of breaks) {
    if (!Number.isInteger(offset) || offset <= previous || offset >= content.length) return false;
    if (content.slice(offset - 2, offset) !== '\n\n') return false;
    if (insidePanel(panels, offset)) return false;
    previous = offset;
  }
  return true;
}

/**
 * 校验旁路断点并给出可用的断点表。
 * 断点缺席、为空或任一处失效（越界 / 非递增 / 前两字符不是 `\n\n` / 落在面板里）时，
 * 整体回退为按段落切（不切开 action_info / item_info）。返回值不含 0。
 */
export function resolveBeatBreaks(content: string, stage?: StoryStage | null): number[] {
  if (stage && breaksValid(content, stage.breaks)) return [...stage.breaks];
  return paragraphBreaks(content);
}

/**
 * `resolveBeatBreaks` 的完整版：同时校正登场锚点。
 * 断点有效时只保留落在节首的锚点；回退时锚点归到其所在的段落节首。越界锚点丢弃。
 */
export function resolveStoryStage(content: string, stage?: StoryStage | null): ResolvedStoryStage {
  const fallback = !(stage && breaksValid(content, stage.breaks));
  const breaks = resolveBeatBreaks(content, stage);
  const starts = new Set([0, ...breaks]);
  const enters: StoryStageEnter[] = [];
  for (const enter of stage?.enters ?? []) {
    if (!enter || typeof enter.name !== 'string' || !enter.name) continue;
    if (!Number.isInteger(enter.at) || enter.at < 0 || enter.at >= content.length) continue;
    if (!fallback) {
      if (starts.has(enter.at)) enters.push({ name: enter.name, at: enter.at });
      continue;
    }
    let at = 0;
    for (const offset of breaks) {
      if (offset > enter.at) break;
      at = offset;
    }
    enters.push({ name: enter.name, at });
  }
  return { breaks, enters, fallback };
}
