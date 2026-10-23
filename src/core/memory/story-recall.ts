/**
 * Story 上下文新模式（v2）的**记忆召回**：候选清单、查询文本、LLM 召回契约与解析、
 * 选中记忆的展开（计划 §9 / D07 / D22 / D31–D33）。
 *
 * 两步召回：先定位（LLM 按编号挑，或 Embedding 按向量排），再读详情 —— 最终交给 Story 的是
 * 摘要正文、事件详细记录和**来源原文**，不是 ID 与分数列表（§9.2）。
 *
 *   候选 = 当前分支上全部有效阶段归档（A1…）+ 来源在正文窗口**之外**的有效摘要片段（S1…，
 *          含已被归档承接、退出第 4 区常驻的片段 —— 它们的原文仍可回查，D30）。
 *          窗口内回合的原文已在第 4 区，不作为候选。
 *   原文 = 两种粒度都实现（D32）：`turn` 整回合玩家输入 + 正文；`snippet` 与查询最相关的
 *          段落加前后各一段。粒度由开发者设置切换，用于比较效果与消耗。
 *
 * 🔴 召回不改变归档状态、不改变第 4 区摘要范围，旧原文也不占最近 N 轮的名额（D33）。
 * 🔴 与窗口内原文重复：不重复贴原文，只写明「原文在最近对话中」（临时规则，计划 P5 待细化）。
 * 🔴 原文总量有上限（`STORY_RECALL_RAW_CHAR_BUDGET`，临时值）：超出的回合只保留摘要与档案，
 *    并明确标注省略；摘要与档案本身不截。
 * 🔴 **格式定义与解析器同源**（同 story-turn-summary.ts）。只在 v2 测试档使用；旧模式召回
 *    （agent-config.json 的 memory_recall + memory-store）原样不动。
 *
 * 纯函数、无 I/O、不读时钟。
 */
import type {
  ChatMessage,
  EmbeddingMetadata,
  StoryArchiveRecord,
  StoryRecallExpansionDiagnostics,
  StoryTurnSummaryRecord,
} from '../types/types';
import { parseModelJson } from '../utils/model-json';
import {
  archivedSegmentIdsOf,
  collectCompleteStoryTurns,
  resolveActiveStoryArchives,
  resolveValidStorySegments,
  type StoryTurn,
  type StoryTurnSummarySegment,
} from './memory-context';
import { normalizedBigrams, storyArchiveOutcomeLabel } from './story-archive';
import { collectArchiveSourceTurns } from './story-archive-detail';
import { buildEmbeddingText } from './memory-store';
import { formatGameTime, type GameTime } from '../time/time-system';

/** 原文读取粒度（D32）：整回合 / 相关片段加前后文。 */
export type StoryRecallRawMode = 'turn' | 'snippet';

/** 召回读到的摘要片段：第 4 区片段形状 + 可选向量。 */
export type StoryRecallSegment = StoryTurnSummarySegment &
  Partial<
    Pick<
      StoryTurnSummaryRecord,
      'embedding' | 'embeddingMeta' | 'characters' | 'locations' | 'topics' | 'gameTimeRange'
    >
  >;

interface StoryRecallCandidateBase {
  /** 本轮清单里的编号（A1 / S1），召回 Agent 只用它指代候选 */
  ref: string;
  /** 清单 / 重排使用的文本 */
  text: string;
  /** 来源回合在当前分支上的位置（越大越新），兜底排序用 */
  position: number;
  embedding?: number[];
  embeddingMeta?: EmbeddingMetadata;
}

export type StoryRecallCandidate =
  | (StoryRecallCandidateBase & { kind: 'archive'; archive: StoryArchiveRecord })
  | (StoryRecallCandidateBase & {
      kind: 'segment';
      segment: StoryRecallSegment;
      /** 已被有效归档承接（不在第 4 区常驻） */
      archived: boolean;
    });

/** 原文总字数上限（临时值，计划 P5 随测试调整）。 */
const STORY_RECALL_RAW_CHAR_BUDGET = 12000;
/** 片段方案在最相关段落前后各带的段数。 */
const SNIPPET_CONTEXT_PARAGRAPHS = 1;
/** 查询文本里最近一回合正文的取尾长度。 */
const QUERY_RECENT_STORY_CHARS = 600;

function turnLabel(index: number): string {
  return `第${index + 1}回合`;
}

function windowStartOf(turnCount: number, windowTurns: number): number {
  return Math.max(0, turnCount - windowTurns);
}

/** 第 N 回合正文的拼接（回合内多条正文按序合并）。 */
function storyTextOf(turn: StoryTurn): string {
  return turn.storyMessages.map((m) => m.content).join('\n\n');
}

/**
 * 本轮的召回候选（编号在本轮内稳定：归档按年表顺序 A1…，片段按来源回合顺序 S1…）。
 *
 * @param messages   本轮之前的正式消息（不含本轮玩家输入）
 * @param windowTurns 正文窗口 N（调用方已校验为正整数）
 */
export function buildStoryRecallCandidates(input: {
  messages: readonly ChatMessage[];
  windowTurns: number;
  segments: readonly StoryRecallSegment[];
  archives: readonly StoryArchiveRecord[];
}): StoryRecallCandidate[] {
  const turns = collectCompleteStoryTurns(input.messages);
  const turnIndex = new Map(turns.map((t, i) => [t.key, i]));
  const windowStart = windowStartOf(turns.length, input.windowTurns);
  const active = resolveActiveStoryArchives(input.messages, input.archives, input.segments);
  const covered = archivedSegmentIdsOf(active);

  const archiveCandidates: StoryRecallCandidate[] = active.map((archive, i) => ({
    kind: 'archive',
    ref: `A${i + 1}`,
    archive,
    text: `【${archive.eventName}｜${storyArchiveOutcomeLabel(archive.outcome)}】${archive.overview}`,
    position: turnIndex.get(archive.sourceTurnKey) ?? -1,
    ...(archive.embedding ? { embedding: archive.embedding } : {}),
    ...(archive.embeddingMeta ? { embeddingMeta: archive.embeddingMeta } : {}),
  }));

  const segmentCandidates: StoryRecallCandidate[] = resolveValidStorySegments(turns, input.segments)
    .filter((v) => v.turnIndex < windowStart)
    .map(({ segment, turnIndex: index }, i) => {
      const archived = covered.has(segment.id);
      const event = segment.eventName ? `【${segment.eventName}】` : '';
      return {
        kind: 'segment' as const,
        ref: `S${i + 1}`,
        segment,
        archived,
        text: `${turnLabel(index)}${event}${segment.content}${archived ? '（已归档）' : ''}${segmentLocatorText(segment)}`,
        position: index,
        ...(segment.embedding ? { embedding: segment.embedding } : {}),
        ...(segment.embeddingMeta ? { embeddingMeta: segment.embeddingMeta } : {}),
      };
    });

  return [...archiveCandidates, ...segmentCandidates];
}

/** 给召回 Agent 的候选清单（`{{STORY_RECALL_CANDIDATES}}`）。 */
export function renderStoryRecallCandidates(candidates: readonly StoryRecallCandidate[]): string {
  if (candidates.length === 0) return '（没有可召回的记忆）';
  const archives = candidates.filter((c) => c.kind === 'archive');
  const segments = candidates.filter((c) => c.kind === 'segment');
  const parts: string[] = [];
  if (archives.length > 0) {
    parts.push(['事件档案：', ...archives.map((c) => `[${c.ref}] ${c.text}`)].join('\n'));
  }
  if (segments.length > 0) {
    parts.push(['回合摘要：', ...segments.map((c) => `[${c.ref}] ${c.text}`)].join('\n'));
  }
  return parts.join('\n\n');
}

/**
 * 兜底排序（没有可比向量 / 查询向量失败 / 未绑定 Embedding 源）：越新的越靠前，
 * 同一回合里事件档案排在回合摘要前面。不按任何「重要度」—— v2 记录没有这个字段。
 */
export function rankStoryRecallFallback(
  candidates: readonly StoryRecallCandidate[],
): StoryRecallCandidate[] {
  return [...candidates].sort(
    (a, b) => b.position - a.position || (a.kind === b.kind ? 0 : a.kind === 'archive' ? -1 : 1),
  );
}

/** LLM failure only: keep a few query-matching memories, without filling unrelated slots. */
export function selectStoryRecallQueryFallback(
  candidates: readonly StoryRecallCandidate[],
  query: string,
  maxCount: number,
): StoryRecallCandidate[] {
  const grams = normalizedBigrams(
    query.replace(/^(?:本轮|上回合玩家|上回合正文|上回合定位)：/gm, ''),
  );
  return rankStoryRecallFallback(candidates)
    .map((candidate) => {
      const document =
        candidate.kind === 'archive'
          ? [
              candidate.archive.eventName,
              candidate.archive.overview,
              ...Object.values(candidate.archive.detail),
            ]
          : [
              candidate.segment.eventName ?? '',
              candidate.segment.content,
              ...(candidate.segment.characters ?? []),
              ...(candidate.segment.locations ?? []),
              ...(candidate.segment.topics ?? []),
            ];
      const terms = normalizedBigrams(document.join('\n'));
      const overlap = [...terms].filter((term) => grams.has(term)).length;
      return { candidate, score: overlap / Math.sqrt(Math.max(1, terms.size * grams.size)) };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.min(3, maxCount))
    .map(({ candidate }) => candidate);
}

/**
 * Embedding / 重排用的查询文本：本轮玩家输入 + 最近一回合的玩家输入与正文末尾。
 * 玩家只说「继续」时，靠最近的场景与人物定位（计划 §9.1 不能只依靠一句「继续」）。
 */
export function buildStoryRecallQuery(input: {
  userInput: string;
  messages: readonly ChatMessage[];
  /** 当前分支摘要中的实体与时间用于定位；旧行缺失字段不补猜。 */
  segments?: readonly StoryRecallSegment[];
}): string {
  const turns = collectCompleteStoryTurns(input.messages);
  const last = turns.length > 0 ? turns[turns.length - 1] : undefined;
  const parts = [`本轮：${input.userInput.trim()}`];
  if (last) {
    const story = storyTextOf(last);
    const tail =
      story.length > QUERY_RECENT_STORY_CHARS ? story.slice(-QUERY_RECENT_STORY_CHARS) : story;
    if (last.userMessage?.content.trim())
      parts.push(`上回合玩家：${last.userMessage.content.trim()}`);
    if (tail.trim()) parts.push(`上回合正文：${tail.trim()}`);
    const locators = resolveValidStorySegments(turns, input.segments ?? [])
      .filter(({ segment }) => segment.sourceTurnKey === last.key)
      .map(({ segment }) => segmentLocatorText(segment).trim())
      .filter(Boolean);
    if (locators.length) parts.push(`上回合定位：${[...new Set(locators)].join('；')}`);
  }
  return parts.join('\n');
}

function segmentLocatorText(segment: Partial<StoryTurnSummaryRecord>): string {
  const parts: string[] = [];
  for (const [field, label] of [
    ['characters', '人物'],
    ['locations', '地点'],
    ['topics', '主题'],
  ] as const) {
    if (segment[field]?.length) parts.push(`${label}：${segment[field].join('、')}`);
  }
  if (segment.gameTimeRange) {
    const time = (value: GameTime | null) => (value ? formatGameTime(value) : '未知');
    parts.push(`时间：${time(segment.gameTimeRange.start)} — ${time(segment.gameTimeRange.end)}`);
  }
  return parts.length ? `\n${parts.join('；')}` : '';
}

/** 摘要片段落库前的向量化输入（事件名当关键词，与旧记忆同一拼接规则）。 */
export function storySegmentEmbeddingText(
  segment: Pick<StoryTurnSummaryRecord, 'eventName' | 'content'> & Partial<StoryTurnSummaryRecord>,
): string {
  return buildEmbeddingText(
    segment.eventName ? [segment.eventName] : [],
    segment.content + segmentLocatorText(segment),
  );
}

/** 阶段归档落库前的向量化输入：概括 + 详细记录（按最终详细记录计算）。 */
export function storyArchiveEmbeddingText(
  archive: Pick<StoryArchiveRecord, 'eventName' | 'overview' | 'detail'>,
): string {
  const d = archive.detail;
  const body = [archive.overview, d.cause, d.process, d.ending, d.promises, d.impact]
    .filter((s) => s.trim() !== '')
    .join('\n');
  return buildEmbeddingText([archive.eventName], body);
}

// ========== LLM 召回契约 ==========

/** v2 召回的 systemPrompt（覆盖 memory_recall 在 v2 回合中的提示词）。 */
export const STORY_RECALL_SYSTEM_PROMPT = [
  '你是记忆召回系统。即将书写本轮剧情，请从 <候选记忆> 里挑出本轮需要回查具体细节的过往记忆。',
  '候选分两类：[A编号] 已结束事件的档案；[S编号] 某一回合的短期摘要（标了「已归档」的已被事件档案承接）。',
  '选中后，引擎会把档案的详细记录与当时的原文交给正文作者。',
  '',
  '判断依据：<玩家输入>、<当前时空> 的场景、<角色状态> 里的在场人物，以及 <最近对话>。',
  '玩家输入很短（如「继续」）时，按当前场景与最近对话判断接下来会涉及什么。',
  '优先选择：本轮会涉及的约定、承诺、交易条件、欠款与期限；对白原话；数字；人物之间的过往与关系变化；关键因果。',
  '<最近对话> 里已经写明的内容不必再选。只是「有点相关」的不要选，宁缺毋滥；没有需要的就给空数组。',
  '只能使用候选清单里出现的编号，绝不编造。',
  '',
  '只输出一个 <json> 块：',
  '<json>',
  '{ "memories": [ { "id": "S3", "reason": "为什么本轮需要它" } ] }',
  '</json>',
].join('\n');

/** v2 召回的上下文模板（覆盖 memory_recall 在 v2 回合中的模板）。 */
export const STORY_RECALL_TEMPLATE = [
  '{{SYS_PROMPT}}',
  '',
  '<候选记忆>',
  '{{STORY_RECALL_CANDIDATES}}',
  '</候选记忆>',
  '',
  '<当前时空>',
  '{{GAME_TIME}}',
  '</当前时空>',
  '',
  '<角色状态>',
  '{{CHARACTER_STATE}}',
  '</角色状态>',
  '',
  '<最近对话>',
  '{{NARRATIVE:layers=3}}',
  '</最近对话>',
  '',
  '<玩家输入>',
  '{{USER_INPUT}}',
  '</玩家输入>',
].join('\n');

export interface StoryRecallSelection {
  /** 清单里确实存在的编号，按模型给出的顺序去重 */
  refs: string[];
  /** 模型给出、但清单里没有的编号（不生效，进诊断） */
  unknownRefs: string[];
}

function normalizeRef(value: unknown): string | null {
  const raw =
    typeof value === 'string'
      ? value
      : value && typeof value === 'object' && 'id' in value
        ? (value as { id: unknown }).id
        : null;
  if (typeof raw !== 'string') return null;
  const ref = raw
    .trim()
    .replace(/^\[|\]$/g, '')
    .trim()
    .toUpperCase();
  return ref === '' ? null : ref;
}

/**
 * 解析召回 Agent 的输出。认不出 → `null`；空数组是合法的「本轮不需要回忆」。
 * 编号必须出现在本轮清单里，超出 `maxCount` 的部分丢弃。
 */
export function parseStoryRecallSelection(
  rawOutput: string,
  candidates: readonly StoryRecallCandidate[],
  maxCount: number,
): StoryRecallSelection | null {
  const known = new Set(candidates.map((c) => c.ref));
  return parseModelJson<StoryRecallSelection>(rawOutput, (payload) => {
    const list = Array.isArray(payload)
      ? payload
      : payload && typeof payload === 'object'
        ? (payload as { memories?: unknown }).memories
        : undefined;
    if (!Array.isArray(list)) return null;
    const refs: string[] = [];
    const unknownRefs: string[] = [];
    for (const item of list) {
      const ref = normalizeRef(item);
      if (!ref) continue;
      if (!known.has(ref)) {
        if (!unknownRefs.includes(ref)) unknownRefs.push(ref);
        continue;
      }
      if (!refs.includes(ref)) refs.push(ref);
    }
    return { refs: refs.slice(0, Math.max(0, maxCount)), unknownRefs };
  });
}

// ========== 展开 ==========

// 诊断与回报的形状住在 types.ts（调试记录 `StoryContextDebugRecord` 要原样收它们）

export interface StoryRecallExpansion {
  /** 召回块正文（不含外壳，由 Story 第 5 区 / 前置检查模板各自包标签）；无选中 = 空串 */
  text: string;
  diagnostics: StoryRecallExpansionDiagnostics;
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

/** 片段方案：与探针最相关的段落加前后文；段落不多时整段给出。 */
function storySnippet(storyText: string, probe: string): { start: number; end: number } {
  const paragraphs = splitParagraphs(storyText);
  if (paragraphs.length <= 1 + 2 * SNIPPET_CONTEXT_PARAGRAPHS) {
    return { start: 0, end: paragraphs.length - 1 };
  }
  const probeGrams = normalizedBigrams(probe);
  let best = 0;
  let bestScore = -1;
  paragraphs.forEach((p, i) => {
    let score = 0;
    for (const g of normalizedBigrams(p)) if (probeGrams.has(g)) score++;
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
  });
  const start = Math.max(0, best - SNIPPET_CONTEXT_PARAGRAPHS);
  const end = Math.min(paragraphs.length - 1, best + SNIPPET_CONTEXT_PARAGRAPHS);
  return { start, end };
}

function renderArchiveHead(archive: StoryArchiveRecord): string[] {
  const d = archive.detail;
  const lines = [
    `【事件档案】${archive.eventName}（${storyArchiveOutcomeLabel(archive.outcome)}）`,
    `概括：${archive.overview}`,
  ];
  const fields: Array<[string, string]> = [
    ['起因', d.cause],
    ['经过', d.process],
    ['结局', d.ending],
    ['约定', d.promises],
    ['影响', d.impact],
  ];
  for (const [label, value] of fields) if (value.trim()) lines.push(`${label}：${value}`);
  if (archive.detailSource === 'summary') lines.push('（详细记录依据摘要整理，未经原文核对）');
  return lines;
}

/**
 * 把选中的候选展开成召回块（计划 §9.2）。
 *
 * @param selected  已按相关性排好的候选（排前的先占原文额度）
 * @param probe     片段方案挑段落用的探针（查询文本；每个候选再叠加它自己的文本）
 */
export function expandStoryRecall(input: {
  selected: readonly StoryRecallCandidate[];
  messages: readonly ChatMessage[];
  windowTurns: number;
  /** 本档全部摘要片段（归档的来源回合要靠它们定位） */
  segments: readonly StoryRecallSegment[];
  rawMode: StoryRecallRawMode;
  probe: string;
  rawCharBudget?: number;
}): StoryRecallExpansion {
  const turns = collectCompleteStoryTurns(input.messages);
  const turnIndex = new Map(turns.map((t, i) => [t.key, i]));
  const windowStart = windowStartOf(turns.length, input.windowTurns);
  const budget = input.rawCharBudget ?? STORY_RECALL_RAW_CHAR_BUDGET;
  const diagnostics: StoryRecallExpansionDiagnostics = {
    rawMode: input.rawMode,
    selectedRefs: input.selected.map((c) => c.ref),
    rawTurnKeys: [],
    inWindowTurnKeys: [],
    omittedTurnKeys: [],
    rawChars: 0,
    chars: 0,
  };
  if (input.selected.length === 0) return { text: '', diagnostics };

  // 只记真正输出的段落范围；回合去重会丢掉同回合后选的不同原文。
  const shown = new Map<string, Set<number>>();
  diagnostics.paragraphRanges = [];
  const renderSourceTurns = (
    sourceTurns: readonly StoryTurn[],
    probe: string,
    ref: string,
  ): string[] => {
    if (sourceTurns.length === 0) return ['（原文缺失，只能提供以上摘要）'];
    const lines: string[] = [];
    for (const turn of sourceTurns) {
      const index = turnIndex.get(turn.key) ?? -1;
      const label = `〔${turnLabel(index)}〕`;
      const locators = resolveValidStorySegments(turns, input.segments)
        .filter(({ segment }) => segment.sourceTurnKey === turn.key)
        .map(({ segment }) => segmentLocatorText(segment).trim())
        .filter(Boolean);
      if (locators.length) lines.push(`${label}来源定位：${[...new Set(locators)].join('；')}`);
      if (index >= windowStart) {
        if (!diagnostics.inWindowTurnKeys.includes(turn.key)) {
          diagnostics.inWindowTurnKeys.push(turn.key);
        }
        lines.push(`${label}原文在最近对话中。`);
        continue;
      }
      const original = storyTextOf(turn);
      const paragraphs = splitParagraphs(original);
      const range =
        input.rawMode === 'snippet'
          ? storySnippet(original, probe)
          : { start: 0, end: paragraphs.length - 1 };
      const covered = shown.get(turn.key) ?? new Set<number>();
      const ranges: Array<{ start: number; end: number }> = [];
      for (let i = range.start; i <= range.end; i++) {
        if (covered.has(i)) continue;
        const last = ranges[ranges.length - 1];
        if (last && last.end === i - 1) last.end = i;
        else ranges.push({ start: i, end: i });
      }
      if (!ranges.length && shown.has(turn.key)) {
        lines.push(`${label}原文见前文。`);
        continue;
      }
      const user = shown.has(turn.key) ? '' : (turn.userMessage?.content.trim() ?? '');
      const partial =
        ranges.length !== 1 || ranges[0]?.start !== 0 || ranges[0]?.end !== paragraphs.length - 1;
      const body =
        input.rawMode === 'turn'
          ? original
          : ranges
              .map(
                ({ start, end }) =>
                  `${start > 0 ? '……\n' : ''}${paragraphs.slice(start, end + 1).join('\n')}${end < paragraphs.length - 1 ? '\n……' : ''}`,
              )
              .join('\n');
      const block = [
        `${label}原文：`,
        ...(user ? [`玩家：${user}`] : []),
        `${partial ? '正文（节选）' : '正文'}：${body}`,
      ].join('\n');
      const omitted = diagnostics.rawChars + block.length > budget;
      for (const r of ranges)
        diagnostics.paragraphRanges!.push({
          ref,
          turnKey: turn.key,
          start: r.start,
          end: r.end,
          omitted,
        });
      if (omitted) {
        if (!diagnostics.omittedTurnKeys.includes(turn.key))
          diagnostics.omittedTurnKeys.push(turn.key);
        lines.push(`${label}原文因本轮篇幅上限省略，以上摘要为准。`);
        continue;
      }
      for (const r of ranges) for (let i = r.start; i <= r.end; i++) covered.add(i);
      shown.set(turn.key, covered);
      if (!diagnostics.rawTurnKeys.includes(turn.key)) diagnostics.rawTurnKeys.push(turn.key);
      diagnostics.rawChars += block.length;
      lines.push(block);
    }
    return lines;
  };

  const items = input.selected.map((candidate) => {
    const probe = `${input.probe}\n${candidate.text}`;
    if (candidate.kind === 'archive') {
      const source = collectArchiveSourceTurns(turns, candidate.archive, input.segments);
      const detail = candidate.archive.detail;
      const archiveProbe = `${probe}\n${detail.process}\n${detail.promises}\n${detail.ending}`;
      return [
        ...renderArchiveHead(candidate.archive),
        ...renderSourceTurns(source, archiveProbe, candidate.ref),
      ];
    }
    const index = turnIndex.get(candidate.segment.sourceTurnKey) ?? -1;
    const event = candidate.segment.eventName ? `【${candidate.segment.eventName}】` : '';
    const source = turns.filter((t) => t.key === candidate.segment.sourceTurnKey);
    return [
      `【回合摘要】${turnLabel(index)}${event}${candidate.segment.content}`,
      ...[segmentLocatorText(candidate.segment).trim()].filter(Boolean),
      ...renderSourceTurns(source, probe, candidate.ref),
    ];
  });

  const text = [
    '以下是与本轮相关的过往记忆。摘要与档案是整理稿；涉及原话、约定、数字与期限时，以「原文」为准。',
    ...items.map((lines) => lines.join('\n')),
  ].join('\n\n');
  diagnostics.chars = text.length;
  return { text, diagnostics };
}
