/**
 * narrative-reveal.ts — 流式正文「墨迹洇开」的纯状态机（动效 v1 · 特效层）
 *
 * 一个段落的显示被拆成有序的若干片：`plain`（已落定的纯文本）与 `chunk`（刚写出、正在
 * 由模糊变清晰的一小段）。所有片首尾相接**恒等于**段落正文 —— 渲染层逐片输出即可，
 * 文本内容与不开特效时逐字相同。
 *
 * 守则：
 * - 只有**新追加的尾巴**会变成 chunk：与上一拍取最长公共前缀，前缀之内一个字都不重播；
 * - 正文缩短（插画标记、HTML 注释被剥掉）时退回公共前缀，**不动画**；
 * - 单次增量最多 {@link MAX_CHUNKS_PER_DELTA} 片、同时存活最多 {@link MAX_LIVE_CHUNKS} 片，
 *   超出的直接并成纯文本（老的先并）；
 * - chunk 存活满 {@link REVEAL_MS} 即并回纯文本 —— 落定后只剩一个 plain 片。
 *
 * 纯函数、无 DOM、无计时器：时间由调用方以 `now` 传入（组件传 `performance.now()`）。
 */

/** 单片墨迹动画时长（毫秒）—— 与 `--motion-duration-page` 同值，CSS 也引用那个 token */
export const REVEAL_MS = 420;
/** 单次增量最多切出几片动画；再多就是一大段瞬间到达，逐词洇开反而像卡顿 */
export const MAX_CHUNKS_PER_DELTA = 12;
/** 同时存活的动画片上限（每片是一个 span，挡住 DOM 膨胀） */
export const MAX_LIVE_CHUNKS = 48;

type RevealPiece =
  { kind: 'plain'; text: string } | { kind: 'chunk'; id: number; text: string; born: number };

export interface RevealState {
  /** 当前段落全文（= 各片首尾相接） */
  readonly text: string;
  readonly pieces: readonly RevealPiece[];
  /** 下一片 chunk 的 id（单调递增，渲染层拿它当 key，保证已显示的片不被重建） */
  readonly nextId: number;
}

/** 空状态：什么都还没显示 */
export function emptyReveal(): RevealState {
  return { text: '', pieces: [], nextId: 1 };
}

/** 一段已经显示过、不需要动画的正文（例如组件挂载时就已在场的历史） */
export function settledReveal(text: string): RevealState {
  return { text, pieces: text ? [{ kind: 'plain', text }] : [], nextId: 1 };
}

/** 是否还有存活的动画片（没有 = 可以按纯文本渲染） */
export function hasLiveChunks(state: RevealState): boolean {
  return state.pieces.some((piece) => piece.kind === 'chunk');
}

/** 最早一片到期的时刻；没有存活片时为 null（调用方据此排下一次落定） */
export function nextExpiry(state: RevealState): number | null {
  let earliest: number | null = null;
  for (const piece of state.pieces) {
    if (piece.kind !== 'chunk') continue;
    const due = piece.born + REVEAL_MS;
    if (earliest === null || due < earliest) earliest = due;
  }
  return earliest;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  // 不把一个代理对劈成两半：前缀停在高位代理上就退一格
  if (i > 0 && i < max) {
    const code = a.charCodeAt(i - 1);
    if (code >= 0xd800 && code <= 0xdbff) i--;
  }
  return i;
}

/** 相邻 plain 合并；空片丢弃 */
function normalize(pieces: RevealPiece[]): RevealPiece[] {
  const out: RevealPiece[] = [];
  for (const piece of pieces) {
    if (piece.text === '') continue;
    const last = out[out.length - 1];
    if (piece.kind === 'plain' && last?.kind === 'plain') {
      out[out.length - 1] = { kind: 'plain', text: last.text + piece.text };
    } else out.push(piece);
  }
  return out;
}

/** 截到前 `length` 个字符；被截到的 chunk 一律落成纯文本（截断本身不动画） */
function truncate(pieces: readonly RevealPiece[], length: number): RevealPiece[] {
  const out: RevealPiece[] = [];
  let used = 0;
  for (const piece of pieces) {
    if (used >= length) break;
    const room = length - used;
    if (piece.text.length <= room) {
      out.push(piece);
      used += piece.text.length;
    } else {
      out.push({ kind: 'plain', text: piece.text.slice(0, room) });
      used = length;
    }
  }
  return out;
}

type Segmenter = { segment(input: string): Iterable<{ segment: string; isWordLike?: boolean }> };

let cachedSegmenter: Segmenter | null | undefined;

function wordSegmenter(): Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  const ctor = (
    Intl as unknown as { Segmenter?: new (locale: string, options: object) => Segmenter }
  ).Segmenter;
  cachedSegmenter = typeof ctor === 'function' ? new ctor('zh', { granularity: 'word' }) : null;
  return cachedSegmenter;
}

/** 降级切分：中日韩字符逐字，其余按连续非空白成词，空白与标点单独成段 */
const FALLBACK_TOKEN = /[぀-ヿ㐀-鿿豈-﫿]|[^\s　-〿぀-ヿ㐀-鿿豈-﫿＀-￯]+|\s+|[\s\S]/gu;

/** 拆成「词 + 紧随其后的空白/标点」的片段 —— 标点不单独洇开，跟着前一个词走 */
export function splitRevealTokens(text: string, segmenter = wordSegmenter()): string[] {
  const raw: { text: string; word: boolean }[] = [];
  if (segmenter) {
    for (const part of segmenter.segment(text)) {
      raw.push({ text: part.segment, word: part.isWordLike !== false });
    }
  } else {
    for (const match of text.match(FALLBACK_TOKEN) ?? []) {
      raw.push({ text: match, word: /[\p{L}\p{N}]/u.test(match) });
    }
  }
  const out: string[] = [];
  for (const part of raw) {
    if (!part.word && out.length > 0) out[out.length - 1] += part.text;
    else out.push(part.text);
  }
  return out;
}

/** 存活片按出生先后取最老的若干片并成纯文本，直到不超过上限 */
function capLive(pieces: RevealPiece[], limit: number): RevealPiece[] {
  const live = pieces.filter((piece) => piece.kind === 'chunk');
  let excess = live.length - limit;
  if (excess <= 0) return pieces;
  const retire = new Set<number>();
  for (const piece of [...live].sort((a, b) => a.born - b.born || a.id - b.id)) {
    if (excess-- <= 0) break;
    retire.add(piece.id);
  }
  return pieces.map((piece) =>
    piece.kind === 'chunk' && retire.has(piece.id) ? { kind: 'plain', text: piece.text } : piece,
  );
}

/**
 * 同一条流式正文里各段落的显示记忆。
 *
 * 段落组件按位置做 key，正文结构一变（插画标记被切走、行动面板拆段）就可能换 key 重挂；
 * 新挂的段落先来这里认领一份「文本互为前缀」的旧状态，已经显示过的字就不会再洇一次。
 */
export interface RevealMemory {
  readonly states: Map<string, RevealState>;
  readonly claimed: Set<string>;
}

export function createRevealMemory(): RevealMemory {
  return { states: new Map(), claimed: new Set() };
}

function isPrefixRelated(a: string, b: string): boolean {
  if (a === '' || b === '') return false;
  return a.length <= b.length ? b.startsWith(a) : a.startsWith(b);
}

/**
 * 段落挂载时取初始状态：先认自己的 key，再认任意未被占用、与当前文本互为前缀的旧状态；
 * 都没有就从空开始（整段都是新写出的）。
 */
export function claimReveal(memory: RevealMemory, key: string, text: string): RevealState {
  memory.claimed.add(key);
  const own = memory.states.get(key);
  if (own && isPrefixRelated(own.text, text)) return own;
  for (const [otherKey, state] of memory.states) {
    if (otherKey === key || memory.claimed.has(otherKey)) continue;
    if (!isPrefixRelated(state.text, text)) continue;
    memory.states.delete(otherKey);
    return state;
  }
  return emptyReveal();
}

/** 段落卸载时交还占用（状态留在记忆里，供换 key 重挂的自己认领） */
export function releaseReveal(memory: RevealMemory, key: string, state: RevealState): void {
  memory.claimed.delete(key);
  memory.states.set(key, state);
}

/**
 * 推进一拍：把上一拍状态对到新正文上。
 *
 * - 到期的 chunk 并回纯文本；
 * - 新正文以旧正文为前缀 → 只把追加的尾巴切成 chunk（尾部最多 12 片，更早的部分直接落定）；
 * - 新正文与旧正文分叉或变短 → 退回公共前缀，分叉之后的内容以纯文本出现，不动画。
 */
export function advanceReveal(prev: RevealState, text: string, now: number): RevealState {
  let pieces: RevealPiece[] = prev.pieces.map((piece) =>
    piece.kind === 'chunk' && now - piece.born >= REVEAL_MS
      ? { kind: 'plain', text: piece.text }
      : piece,
  );
  let nextId = prev.nextId;
  const common = commonPrefixLength(prev.text, text);

  if (common < prev.text.length) {
    // 缩短 / 改写：不追究哪一段变了，公共前缀之外一律静默落定
    pieces = truncate(pieces, common);
    pieces.push({ kind: 'plain', text: text.slice(common) });
    return { text, pieces: normalize(pieces), nextId };
  }

  const tail = text.slice(common);
  if (tail !== '') {
    const tokens = splitRevealTokens(tail);
    const animated = tokens.slice(-MAX_CHUNKS_PER_DELTA);
    const flushed = tokens.slice(0, tokens.length - animated.length).join('');
    if (flushed) pieces.push({ kind: 'plain', text: flushed });
    for (const token of animated)
      pieces.push({ kind: 'chunk', id: nextId++, text: token, born: now });
  }
  pieces = capLive(normalize(pieces), MAX_LIVE_CHUNKS);
  return { text, pieces: normalize(pieces), nextId };
}
