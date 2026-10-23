/**
 * Story 上下文新模式（v2）第 4 区的纯函数：最近 N 个完整回合 + 窗口外全部未归档摘要。
 *
 * 计划依据：docs/planning/2026-09-30-story-context-memory-content-routing-plan.md §3.2 / §7.2 / §8.3。
 *
 *   第 4 区摘要 = 来源位于窗口 W 之前、且未被有效归档覆盖的摘要片段
 *   第 4 区原文 = W 中的完整玩家输入与 Story 正文
 *   顺序       = 摘要按来源回合排序，随后是原文
 *
 * 🔴 N 只按**完整回合**计：系统卡片、侧链输出不占名额；只有玩家输入没有 Story 正文的
 *    回合（失败草稿 / 本轮未完成输入）不算完整回合。不能拿消息总数除以二代替。
 * 🔴 窗口外未归档摘要**全部**保留：没有 M、Top K、重要度淘汰或隐含时间上限（D05/D33）。
 * 🔴 窗口内只给原文，不重复注入它们的摘要（D06），即使这些回合已经生成了摘要（D28）。
 * 🔴 窗口外某个回合**一条有效摘要片段都没有**时不静默跳过：整回合列进
 *    `missingSummaryTurns`，由调用方明确提示并决定如何补足（Q10）。被归档完整覆盖的回合不算缺口。
 * 🔴 片段只在来源仍属于当前分支时有效：`sourceTurnKey` 必须对得上一个当前回合，且给了
 *    `sourceMessageIds` 时必须与该回合的消息 id 列表逐一相同 —— 重生成换了正文、回退删掉了
 *    消息，旧片段都自动失效（§7.3 / §11.4）。
 *
 * 纯函数、无 I/O、不读时钟。
 */
import type { ChatMessage, StoryArchiveRecord, StoryTurnSummaryRecord } from '../types/types';
import { normalizeStoryWindowTurns } from '../story/story-context-mode';
import {
  storyMemorySourceMatches,
  storyMemorySourcesMatch,
  storyArchiveCoverageMatches,
} from './story-memory-source';

/** 一个完整回合：可选的玩家输入 + 至少一条 Story 正文，保持原消息顺序。 */
export interface StoryTurn {
  /**
   * 回合的稳定引用：玩家输入消息的 id；没有玩家输入（例如开场只渲染 Story 正文）时取
   * 第一条 Story 正文的 id。摘要片段经它绑定来源 —— 不用 `turn` 序号或时间戳，
   * 同回合重生成时两者都可能相同而正文不同（§7.3）。
   */
  key: string;
  userMessage?: ChatMessage;
  storyMessages: ChatMessage[];
}

/** 第 4 区需要的摘要片段最小形状（一回合可分多段，以支持部分归档 §8.3）。 */
export type StoryTurnSummarySegment = Pick<
  StoryTurnSummaryRecord,
  'id' | 'sourceTurnKey' | 'order' | 'content'
> &
  Partial<Pick<StoryTurnSummaryRecord, 'sourceMessageIds' | 'sourceFingerprint' | 'eventName'>>;

export interface StoryZone4Input {
  /** 本轮之前的正式消息（不含本轮玩家输入） */
  messages: readonly ChatMessage[];
  /** 正文窗口 N，必须是正整数 */
  windowTurns: number;
  segments: readonly StoryTurnSummarySegment[];
  /** 已被有效归档覆盖的片段 id */
  archivedSegmentIds: ReadonlySet<string>;
}

/** 窗口外的一项历史：要么是该回合的未归档摘要片段，要么是缺摘要的整回合原文。 */
type StoryZone4HistoryItem =
  { kind: 'summary'; segment: StoryTurnSummarySegment } | { kind: 'missing'; turn: StoryTurn };

export interface StoryZone4 {
  /** 窗口外历史，按来源回合时间顺序 */
  history: StoryZone4HistoryItem[];
  /** 最近 N 个完整回合的原文 */
  windowTurns: StoryTurn[];
  /** 窗口外缺少任何有效摘要的回合（与 history 里的 missing 项一一对应） */
  missingSummaryTurns: StoryTurn[];
}

/**
 * 从消息序列中按顺序取出完整回合。
 *
 * 一条玩家输入开启新回合，随后的 Story 正文归入该回合；系统消息不影响分组。
 * 没有 Story 正文的回合被丢弃（不完整）。
 */
export function collectCompleteStoryTurns(messages: readonly ChatMessage[]): StoryTurn[] {
  const turns: StoryTurn[] = [];
  let current: { userMessage?: ChatMessage; storyMessages: ChatMessage[] } | null = null;
  const flush = () => {
    if (current && current.storyMessages.length > 0) {
      turns.push({
        key: current.userMessage?.id ?? current.storyMessages[0].id,
        ...(current.userMessage ? { userMessage: current.userMessage } : {}),
        storyMessages: current.storyMessages,
      });
    }
  };
  for (const message of messages) {
    if (message.role === 'user') {
      flush();
      current = { userMessage: message, storyMessages: [] };
    } else if (message.role === 'assistant') {
      if (
        message.systemEvent ||
        message.diagnostic ||
        (message.storyTurnStatus !== undefined && message.storyTurnStatus !== 'accepted')
      )
        continue;
      // Explicit ownership cannot fall back to the adjacent turn when its user was removed.
      if (message.storyTurnKey) {
        const owner = current?.userMessage?.id ?? current?.storyMessages[0]?.id;
        // An opening owns itself; later explicitly owned text must match that opening.
        if (owner ? message.storyTurnKey !== owner : message.storyTurnKey !== message.id) continue;
      }
      if (
        current?.userMessage?.storyTurnStatus !== undefined &&
        current.userMessage.storyTurnStatus !== 'accepted'
      )
        continue;
      if (!current) current = { storyMessages: [] };
      current.storyMessages.push(message);
    }
  }
  flush();
  return turns;
}

/** 旧行没有正文指纹 = 无法证明有效，走缺口补建，不用当前正文伪造旧来源。 */
function segmentMatchesTurn(segment: StoryTurnSummarySegment, turn: StoryTurn): boolean {
  return storyMemorySourceMatches(segment, turn);
}

/**
 * 当前分支上仍然有效的阶段归档，按作出判断的时间排成「历史年表」顺序（第 2 区的节点序）。
 *
 * 有效 = 作出归档判断的那个回合的全部消息仍在 `messages` 里。回退 / 重生成删掉了那个回合，
 * 归档自然失效：第 2 区退回上一节点，它覆盖的片段恢复未归档语义（计划 D23）。
 */
export function resolveActiveStoryArchives(
  messages: readonly ChatMessage[],
  archives: readonly StoryArchiveRecord[],
  segments: readonly StoryTurnSummarySegment[] = [],
): StoryArchiveRecord[] {
  const turns = collectCompleteStoryTurns(messages);
  return archives
    .filter(
      (a) =>
        !a.invalidatedReason &&
        storyMemorySourcesMatch([a], turns) &&
        storyMemorySourcesMatch(a.coveredSources, turns) &&
        storyArchiveCoverageMatches(a, segments),
    )
    .sort((a, b) => a.createdAt - b.createdAt || a.sequence - b.sequence);
}

/**
 * 来源仍属于当前分支的摘要片段（窗口内外、归档与否都算），附带来源回合的位置，
 * 按回合先后、回合内顺序排好。未结事件与召回候选共用这一个有效性判据。
 */
export function resolveValidStorySegments<T extends StoryTurnSummarySegment>(
  turns: readonly StoryTurn[],
  segments: readonly T[],
): Array<{ segment: T; turnIndex: number }> {
  const turnIndex = new Map(turns.map((turn, index) => [turn.key, index]));
  const valid: Array<{ segment: T; turnIndex: number }> = [];
  for (const segment of segments) {
    const index = turnIndex.get(segment.sourceTurnKey);
    if (index === undefined || !segmentMatchesTurn(segment, turns[index])) continue;
    valid.push({ segment, turnIndex: index });
  }
  return valid.sort((a, b) => a.turnIndex - b.turnIndex || a.segment.order - b.segment.order);
}

/**
 * 当前分支上一条有效摘要片段都没有的完整回合（时间顺序），供针对性补建（计划 Q10）。
 * 被归档承接的片段仍算有效片段 —— 归档过的回合不是缺口。
 */
export function findStoryTurnsMissingSummary(
  messages: readonly ChatMessage[],
  segments: readonly StoryTurnSummarySegment[],
): StoryTurn[] {
  const turns = collectCompleteStoryTurns(messages);
  const covered = new Set(
    resolveValidStorySegments(turns, segments).map((v) => v.segment.sourceTurnKey),
  );
  return turns.filter((t) => !covered.has(t.key));
}

/** 有效归档覆盖的片段 id 并集（这些片段退出第 4 区常驻范围）。 */
export function archivedSegmentIdsOf(archives: readonly StoryArchiveRecord[]): Set<string> {
  return new Set(archives.flatMap((a) => a.coveredSegmentIds));
}

/** 一个尚未结束的事件：事件名 + 它在当前分支上的全部未归档片段（时间顺序）。 */
export interface OpenStoryEvent {
  eventName: string;
  segments: StoryTurnSummarySegment[];
}

/**
 * 本轮开始时仍未结束的事件（供总结 Agent 先做归档判断，计划 Q13）。
 *
 * 只看当前分支上有效的片段（窗口内外都算 —— 归档判断要看事件的全部经过），
 * 去掉已被有效归档覆盖的，按事件名分组；没有事件名的闲聊片段不构成事件。
 * 跨回合的「同一事件」靠事件名逐字一致关联，由总结 Agent 负责沿用名字。
 */
export function collectOpenStoryEvents(
  messages: readonly ChatMessage[],
  segments: readonly StoryTurnSummarySegment[],
  archives: readonly StoryArchiveRecord[],
): OpenStoryEvent[] {
  const turns = collectCompleteStoryTurns(messages);
  const covered = archivedSegmentIdsOf(resolveActiveStoryArchives(messages, archives, segments));
  const valid = resolveValidStorySegments(turns, segments)
    .map((v) => v.segment)
    .filter((s) => !covered.has(s.id) && typeof s.eventName === 'string' && s.eventName !== '');
  const byName = new Map<string, StoryTurnSummarySegment[]>();
  for (const segment of valid) {
    const name = segment.eventName as string;
    const list = byName.get(name) ?? [];
    list.push(segment);
    byName.set(name, list);
  }
  return [...byName].map(([eventName, list]) => ({ eventName, segments: list }));
}

/** 组装第 4 区。N 非法（含 N=0）直接抛 RangeError —— 不静默换成默认值。 */
export function buildStoryZone4(input: StoryZone4Input): StoryZone4 {
  const windowTurns = normalizeStoryWindowTurns(input.windowTurns);
  if (windowTurns === null) {
    throw new RangeError(`Story 正文窗口 N 必须是正整数，收到 ${String(input.windowTurns)}`);
  }

  const turns = collectCompleteStoryTurns(input.messages);
  const windowStart = Math.max(0, turns.length - windowTurns);
  const outside = turns.slice(0, windowStart);
  const inside = turns.slice(windowStart);

  const outsideByKey = new Map(outside.map((turn) => [turn.key, turn]));
  const segmentsByTurn = new Map<string, StoryTurnSummarySegment[]>();
  for (const segment of input.segments) {
    const turn = outsideByKey.get(segment.sourceTurnKey);
    if (!turn) continue; // 窗口内，或来源已不在当前分支
    if (!segmentMatchesTurn(segment, turn)) continue; // 来源正文已被重生成替换
    const list = segmentsByTurn.get(segment.sourceTurnKey) ?? [];
    list.push(segment);
    segmentsByTurn.set(segment.sourceTurnKey, list);
  }

  const history: StoryZone4HistoryItem[] = [];
  const missingSummaryTurns: StoryTurn[] = [];
  for (const turn of outside) {
    const list = segmentsByTurn.get(turn.key);
    if (!list || list.length === 0) {
      missingSummaryTurns.push(turn);
      history.push({ kind: 'missing', turn });
      continue;
    }
    const ordered = [...list].sort((a, b) => a.order - b.order);
    for (const segment of ordered) {
      if (!input.archivedSegmentIds.has(segment.id)) history.push({ kind: 'summary', segment });
    }
  }

  return { history, windowTurns: inside, missingSummaryTurns };
}
