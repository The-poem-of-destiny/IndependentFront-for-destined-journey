/**
 * 直出输出的区块定位与计数（审查 A1，2026-11-25）。
 *
 * 旧做法扫全文数开标签：正文前的思考块、或无包裹的前置说明只要「提到」`<maintext>` /
 * `<direct_updates>` 这些标签名，开标签数就不再是 1，整楼拒收。这里改成：
 *
 * 1. 先剔除完整的 `<think>` / `<thinking>` 块，思考内容不参与计数；
 * 2. 按「闭标签向前配最近的开标签」数完整块 —— 被后一个同名开标签越过、始终没配上闭标签的
 *    开标签是孤立提及，不计；
 * 3. 排在本族最后一个闭标签之后、没配上的开标签算截断（有开无闭），照旧拒收。
 *
 * 正文投影与 JSON 都取这里配出来的那一块（`text` 已剔除思考块与孤立提及的开标签）。
 */

import { STORY_ENVELOPE_TAGS } from '../story/story-output';

const THINKING_BLOCK = /<(think|thinking)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

interface TagEvent {
  tag: string;
  kind: 'open' | 'close';
  /** 标签起点 */
  start: number;
  /** 标签终点（开标签缺 `>` 时到串尾） */
  end: number;
}

interface PairedBlock {
  tag: string;
  open: TagEvent;
  close: TagEvent;
}

interface FamilyScan {
  blocks: PairedBlock[];
  /** 孤立提及：没配上闭标签、但后面还有本族闭标签的开标签 */
  isolated: TagEvent[];
  /** 截断：排在本族最后一个闭标签之后、没配上闭标签的开标签 */
  truncated: TagEvent[];
  /** 本族开标签总数（含孤立与截断） */
  opens: number;
}

interface DirectBlockLayout {
  /** 剔除思考块与孤立开标签后的文本，正文投影从这里取 */
  text: string;
  /** direct_updates 开标签总数（剔除思考块后）；0 = 模型没写更新块 */
  updatesOpens: number;
  /** 唯一完整的 direct_updates 块内文；块数不为 1 或有截断时为 null */
  updatesInner: string | null;
  /** 正文信封（maintext / gametxt）恰好成立：至少一种有完整块、每种至多一块、无截断 */
  envelopeOk: boolean;
}

function tagEvents(text: string, tags: readonly string[]): TagEvent[] {
  const pattern = new RegExp(String.raw`<(\/?)(${tags.join('|')})\b`, 'gi');
  const events: TagEvent[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index;
    const kind = match[1] ? 'close' : 'open';
    const gt = text.indexOf('>', start);
    // 开标签缺 `>`（流到一半被截断）照样算开标签，只是没有内文起点
    const end = gt < 0 ? text.length : gt + 1;
    events.push({ tag: match[2].toLowerCase(), kind, start, end });
  }
  return events;
}

/** 一族标签（同族可嵌套 / 并列）按「闭标签向前配最近的同名开标签」配对 */
function scanFamily(text: string, tags: readonly string[]): FamilyScan {
  const events = tagEvents(text, tags);
  const pending = new Map<string, TagEvent[]>();
  const blocks: PairedBlock[] = [];
  let lastClose = -1;
  let opens = 0;
  for (const event of events) {
    const stack = pending.get(event.tag) ?? [];
    pending.set(event.tag, stack);
    if (event.kind === 'open') {
      opens += 1;
      stack.push(event);
      continue;
    }
    lastClose = Math.max(lastClose, event.start);
    const open = stack.pop();
    if (open) blocks.push({ tag: event.tag, open, close: event });
    // 配上最近的开标签后，更早的同名未配开标签都被越过了 —— 它们只是提及
    stack.length = 0;
  }
  const leftovers = events.filter(
    (event) => event.kind === 'open' && !blocks.some((block) => block.open === event),
  );
  return {
    blocks,
    isolated: leftovers.filter((event) => event.start < lastClose),
    truncated: leftovers.filter((event) => event.start > lastClose),
    opens,
  };
}

function removeSpans(text: string, spans: TagEvent[]): string {
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start))
    out = out.slice(0, span.start) + out.slice(span.end);
  return out;
}

/** 定位直出回复里的正文信封与 direct_updates 块（只做定位与计数，不做 JSON 解析） */
export function locateDirectBlocks(raw: string): DirectBlockLayout {
  const stripped = raw.replace(THINKING_BLOCK, '');

  const updates = scanFamily(stripped, ['direct_updates']);
  const updatesOk = updates.blocks.length === 1 && updates.truncated.length === 0;
  const block = updatesOk ? updates.blocks[0] : undefined;

  const envelope = scanFamily(stripped, STORY_ENVELOPE_TAGS);
  const counts = STORY_ENVELOPE_TAGS.map(
    (tag) => envelope.blocks.filter((paired) => paired.tag === tag).length,
  );
  const envelopeOk =
    envelope.truncated.length === 0 &&
    counts.some((count) => count === 1) &&
    counts.every((count) => count <= 1);

  return {
    // 孤立提及的正文开标签剔掉，投影的「取最后一个开标签」才会落在真实那一块上
    text: removeSpans(stripped, envelope.isolated),
    updatesOpens: updates.opens,
    updatesInner: block ? stripped.slice(block.open.end, block.close.start) : null,
    envelopeOk,
  };
}
