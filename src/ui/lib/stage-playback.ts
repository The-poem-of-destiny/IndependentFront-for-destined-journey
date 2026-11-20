/**
 * stage-playback.ts — 直出正文「逐节演出」的纯状态机（交互式推进 T4）
 *
 * 输入是一条正文与它的节断点（字符偏移，每个断点是**一节的起点**）；玩家每推进一次放出一节。
 * 本模块只回答「切成哪几节、放到哪了、该不该等」，不碰 DOM、不读 store、不依赖 Vue。
 *
 * 守则：
 * - 断点缺席（流式中还没见到 `<beat/>`、或旧档无字段）时按 `\n\n` 段落**临时切**，
 *   不切开 `<action_info>` / `<item_info>` 块；
 * - 流式中只有「后面已出现下一个断点」或「流已结束」的节才算**完整**，只有完整的节能放出；
 * - 首节完整即自动放出，不必玩家推进；
 * - 进度用**字符偏移游标**记，不用节序号：临时切换成模型断点时，游标落在新节内部
 *   且该节已完整就并到节尾 —— 已放出的文字一个字都不回退；
 * - `skipAll` 之后进入「全部显示」：此刻与以后每次同步，凡完整的节都直接放出。
 */

/** 登场标记（对应 `<beat enter="名"/>`，`at` 为剥标记后正文里的字符偏移）。
 * 📌 T1 会在 `src/core/story/story-beats.ts` 定义同形类型，届时改为从那里导入。 */
export interface StageEnterMark {
  readonly name: string;
  readonly at: number;
}

export interface StagePlaybackInput {
  /** 剥掉标记后的正文 */
  readonly content: string;
  /** 节起点的字符偏移；空数组 = 按段落临时切 */
  readonly breaks: readonly number[];
  readonly enters: readonly StageEnterMark[];
  /** 流是否已结束（落库的消息恒为 true） */
  readonly closed: boolean;
}

export interface StageSection {
  readonly index: number;
  /** 本节在正文中的起止偏移（半开区间，首尾相接覆盖全文） */
  readonly start: number;
  readonly end: number;
  /** 本节正文（去掉节尾空白，供渲染） */
  readonly text: string;
  /** 后面已出现下一个断点或流已结束 */
  readonly complete: boolean;
}

export interface StagePlaybackState {
  readonly input: StagePlaybackInput;
  /** 已放出正文的末尾偏移 */
  readonly cursor: number;
  /** 是否已按过「全部显示」 */
  readonly showAll: boolean;
}

export type StagePlaybackEvent =
  | { readonly type: 'sync'; readonly input: StagePlaybackInput }
  | { readonly type: 'advance' }
  | { readonly type: 'skipAll' };

export interface StagePlaybackView {
  readonly sections: readonly StageSection[];
  /** 已放出（含部分放出）的节数 —— 渲染 `sections.slice(0, revealedCount)` */
  readonly revealedCount: number;
  /** 已放出正文的末尾偏移（= 游标） */
  readonly visibleEnd: number;
  /** 玩家已追上进度，但流未结束或下一节尚不完整 */
  readonly waiting: boolean;
  /** 流已结束且全部放出 */
  readonly finished: boolean;
  /** 下一节已完整、可以推进 */
  readonly canAdvance: boolean;
}

/** 段落分隔：两个及以上换行（中间可夹空白） */
const PARAGRAPH_GAP = /\n[^\S\n]*\n\s*/g;
/** 不可切开的块：`<action_info>` / `<item_info>`（大小写不敏感，允许属性） */
const BLOCK_TAG = /<(\/?)(action_info|item_info)\b[^>]*>/gi;

/** 不可切开块所占的区间；未闭合的块一直保护到正文末尾（流式中常见） */
function protectedRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let openTag: string | null = null;
  let openAt = 0;
  for (const match of content.matchAll(BLOCK_TAG)) {
    const closing = match[1] === '/';
    const tag = match[2].toLowerCase();
    if (!closing && openTag === null) {
      openTag = tag;
      openAt = match.index;
    } else if (closing && openTag === tag) {
      ranges.push([openAt, match.index + match[0].length]);
      openTag = null;
    }
  }
  if (openTag !== null) ranges.push([openAt, content.length]);
  return ranges;
}

/** 按段落临时切出的节起点（不含 0）；分隔符后面必须已有正文，否则下一段还没开始 */
export function paragraphBreaks(content: string): number[] {
  const ranges = protectedRanges(content);
  const breaks: number[] = [];
  for (const match of content.matchAll(PARAGRAPH_GAP)) {
    const at = match.index + match[0].length;
    if (at >= content.length || match.index === 0) continue;
    if (ranges.some(([from, to]) => match.index > from && match.index < to)) continue;
    breaks.push(at);
  }
  return breaks;
}

/** 断点规整：去掉越界、首位 0 与重复，升序 */
function normalizeBreaks(breaks: readonly number[], length: number): number[] {
  const valid = breaks.filter((at) => Number.isInteger(at) && at > 0 && at < length);
  return [...new Set(valid)].sort((a, b) => a - b);
}

/** 把正文切成节；断点为空时按段落临时切 */
export function splitStageSections(input: StagePlaybackInput): StageSection[] {
  const { content, closed } = input;
  if (!content.trim()) return [];
  const starts = [
    0,
    ...(input.breaks.length > 0
      ? normalizeBreaks(input.breaks, content.length)
      : paragraphBreaks(content)),
  ];
  return starts.map((start, index) => {
    const isLast = index === starts.length - 1;
    const end = isLast ? content.length : starts[index + 1];
    return {
      index,
      start,
      end,
      text: content.slice(start, end).replace(/\s+$/, ''),
      complete: !isLast || closed,
    };
  });
}

/**
 * 把游标规整到合法位置并执行自动放出：
 * 收进正文长度；落在某节内部且该节已完整就并到节尾；首节完整即放出；「全部显示」下放出所有完整节。
 */
function settle(input: StagePlaybackInput, cursor: number, showAll: boolean): StagePlaybackState {
  const sections = splitStageSections(input);
  let next = Math.min(Math.max(cursor, 0), input.content.length);
  const inside = sections.find((section) => section.start < next && next < section.end);
  if (inside?.complete) next = inside.end;
  if (next === 0 && sections[0]?.complete) next = sections[0].end;
  if (showAll) {
    for (const section of sections) {
      if (section.end > next && section.start >= next && section.complete) next = section.end;
    }
  }
  return { input, cursor: next, showAll };
}

export function createStagePlayback(input: StagePlaybackInput): StagePlaybackState {
  return settle(input, 0, false);
}

export function stepStagePlayback(
  state: StagePlaybackState,
  event: StagePlaybackEvent,
): StagePlaybackState {
  switch (event.type) {
    case 'sync':
      return settle(event.input, state.cursor, state.showAll);
    case 'advance': {
      const target = splitStageSections(state.input).find(
        (section) => section.start >= state.cursor && section.end > state.cursor,
      );
      if (!target?.complete) return state;
      return settle(state.input, target.end, state.showAll);
    }
    case 'skipAll':
      return settle(state.input, state.cursor, true);
  }
}

export function deriveStagePlayback(state: StagePlaybackState): StagePlaybackView {
  const sections = splitStageSections(state.input);
  const { cursor } = state;
  const revealedCount = sections.filter((section) => section.start < cursor).length;
  const pending = sections.find((section) => section.end > cursor);
  const canAdvance = pending !== undefined && pending.start >= cursor && pending.complete;
  const finished = state.input.closed && pending === undefined;
  return {
    sections,
    revealedCount,
    visibleEnd: cursor,
    waiting: !finished && !canAdvance,
    finished,
    canAdvance,
  };
}
