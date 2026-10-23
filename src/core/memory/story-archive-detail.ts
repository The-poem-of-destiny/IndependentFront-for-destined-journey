/**
 * Story 上下文新模式（v2）：**依据事件原文**生成事件详细记录（计划 D29 / §8.2 第 3 步）。
 *
 * 归档判断通过把关后，引擎把该事件涉及的每个回合的玩家输入与 Story 正文原文交给模型，
 * 重写起因 / 经过 / 结局 / 约定 / 持续影响 —— 约定、数字与期限照原文，不靠摘要转述。
 * 调用在写锁外进行；失败时调用方保留总结 Agent 写的简要版本，并把来源标成 `summary`。
 *
 * 🔴 格式定义与解析器同源（同 story-turn-summary.ts）。
 * 纯函数、无 I/O：请求由调用方发出。
 */
import type { StoryArchiveDetail, StoryArchiveRecord } from '../types/types';
import { parseModelJson } from '../utils/model-json';
import type { StoryTurn } from './memory-context';
import { storyArchiveOutcomeLabel } from './story-archive';
import { storyMemorySourcesMatch } from './story-memory-source';

const STORY_ARCHIVE_DETAIL_SYSTEM_PROMPT = [
  '你是叙事档案员。下面是一个已经结束的事件，以及它涉及的每个回合的玩家输入与正文原文。',
  '只依据这些原文写出事件详细记录，供以后回顾时查证：',
  '- cause：事件怎么开始的，谁提出、为什么；',
  '- process：关键经过，按时间顺序，保留转折点；',
  '- ending：怎样结束，结局是什么；',
  '- promises：所有约定、承诺、交易条件、报酬与欠款；人名、物品、数字、期限一律照原文写，不改写、不估算；',
  '- impact：结束后仍在持续的影响、关系变化或尚待处理的后果。',
  '原文里没有的不要写，计划、猜测、传闻要写明是哪一种；某项没有内容就写空串。',
  '只输出一个 <json> 块：',
  '<json>',
  '{ "cause": "", "process": "", "ending": "", "promises": "", "impact": "" }',
  '</json>',
].join('\n');

/**
 * 归档覆盖的片段来自哪些回合（时间顺序），再加上作出判断的回合本身 ——
 * 结局就写在那一回合的正文里，哪怕它没有为这个事件单独写摘要。
 */
export function collectArchiveSourceTurns(
  turns: readonly StoryTurn[],
  archive: Pick<StoryArchiveRecord, 'coveredSegmentIds' | 'sourceTurnKey'> &
    Partial<Pick<StoryArchiveRecord, 'coveredSources' | 'invalidatedReason'>>,
  segments: ReadonlyArray<{ id: string; sourceTurnKey: string }>,
): StoryTurn[] {
  const covered = new Set(archive.coveredSegmentIds);
  const selected = segments.filter((s) => covered.has(s.id));
  // A partially resolved event must not be presented as its complete original text.
  if (
    archive.invalidatedReason ||
    archive.coveredSegmentIds.some((id) => !selected.some((s) => s.id === id))
  )
    return [];
  if (archive.coveredSources && !storyMemorySourcesMatch(archive.coveredSources, turns)) return [];
  const keys = new Set(selected.map((s) => s.sourceTurnKey));
  keys.add(archive.sourceTurnKey);
  const sourceTurns = turns.filter((t) => keys.has(t.key));
  return sourceTurns.length === keys.size ? sourceTurns : [];
}

export function buildStoryArchiveDetailMessages(input: {
  archive: Pick<StoryArchiveRecord, 'eventName' | 'outcome' | 'overview'>;
  turns: readonly StoryTurn[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const { archive, turns } = input;
  const source = turns
    .map((turn, i) =>
      [
        `【第 ${i + 1} 段】`,
        ...(turn.userMessage ? [`玩家：${turn.userMessage.content}`] : []),
        `正文：${turn.storyMessages.map((m) => m.content).join('\n')}`,
      ].join('\n'),
    )
    .join('\n\n');
  return [
    { role: 'system', content: STORY_ARCHIVE_DETAIL_SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        `<事件>${archive.eventName}（${storyArchiveOutcomeLabel(archive.outcome)}）</事件>`,
        `<概括>${archive.overview}</概括>`,
        `<事件原文>\n${source}\n</事件原文>`,
      ].join('\n\n'),
    },
  ];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 解析详细记录；五项全空 / 认不出 → `null`（调用方回落到简要版本）。 */
export function parseStoryArchiveDetail(rawOutput: string): StoryArchiveDetail | null {
  return parseModelJson<StoryArchiveDetail>(rawOutput, (payload) => {
    const o = (payload ?? {}) as Record<string, unknown>;
    const detail: StoryArchiveDetail = {
      cause: text(o.cause),
      process: text(o.process),
      ending: text(o.ending),
      promises: text(o.promises),
      impact: text(o.impact),
    };
    return Object.values(detail).some((v) => v !== '') ? detail : null;
  });
}
