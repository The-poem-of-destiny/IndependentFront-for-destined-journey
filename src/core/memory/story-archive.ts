/**
 * Story 上下文新模式（v2）的**阶段归档**：归档判断的校验、归档记录生成，以及两段渲染
 * ——第 2 区长期记忆总览与给总结 Agent 的「未结事件」清单（计划 §8 / D09 / D20–D23 / D29–D30）。
 *
 * 判断由每轮运行的总结 Agent 在写本回合摘要**之前**作出（计划 Q13 的裁定）；本模块只做
 * 代码侧的把关，不信任模型自报：
 *   - 事件名必须是本轮开始时的未结事件，或本回合摘要里新出现的事件（同一回合开始又结束）；
 *   - 结局依据必须出自本回合正文（`evidenceAppearsInStory`：去标点空白后子串命中，或字二元
 *     覆盖率达标，容忍改写措辞）—— 回合数、转场、跨日、摘要变长都不是结束证据，
 *     正文里根本没有的「结局」在这里被拦下；
 *   - 覆盖范围按事件名取该事件全部未归档片段（含本回合新片段），由代码绑定 id。
 * 被拦下的判断不生效，事件保持未归档（计划 §8.2「归档失败时不提前移除摘要」）。
 *
 * 纯函数、无 I/O、不读时钟（时间由调用方传入）。
 */
import type {
  StoryArchiveOutcome,
  StoryArchiveRecord,
  StoryTurnSummaryRecord,
} from '../types/types';
import {
  type OpenStoryEvent,
  type StoryTurn,
  type StoryTurnSummarySegment,
} from './memory-context';
import type { ParsedStoryArchiveDecision } from './story-turn-summary';
import { storyTurnSource, storySegmentFingerprint } from './story-memory-source';

/** 结局的展示措辞（存储用英文枚举，中文只在渲染面）。 */
const OUTCOME_LABELS: Record<StoryArchiveOutcome, string> = {
  completed: '成功完成',
  abandoned: '放弃',
  failed: '失败',
};

/** 结局的中文标签（第 2 区、详细记录提示词与记忆面板共用这一份）。 */
export function storyArchiveOutcomeLabel(outcome: StoryArchiveOutcome): string {
  return OUTCOME_LABELS[outcome];
}

type StoryArchiveRejectReason =
  'unknown-event' | 'duplicate-event' | 'evidence-not-in-story' | 'nothing-to-cover';

export interface StoryArchiveRejection {
  eventName: string;
  reason: StoryArchiveRejectReason;
}

/** 去掉空白与标点符号后比较（全角半角一并处理）。 */
function normalizeForEvidence(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(text: string): string[] {
  const chars = Array.from(text);
  const out: string[] = [];
  for (let i = 0; i + 1 < chars.length; i++) out.push(chars[i] + chars[i + 1]);
  return out;
}

/** 去标点空白后的字二元集合（召回挑原文片段时与结局依据比对用同一套口径）。 */
export function normalizedBigrams(text: string): Set<string> {
  return new Set(bigrams(normalizeForEvidence(text)));
}

/** 依据至少要有的有效字数（去标点空白后），太短的片段在任何正文里都能「命中」。 */
const EVIDENCE_MIN_CHARS = 4;
/** 依据的字二元在本回合正文中出现的比例下限 —— 容忍改写措辞、增删个别字词。 */
const EVIDENCE_MIN_OVERLAP = 0.6;

/**
 * 结局依据是否出自本回合正文（放宽匹配）。
 *
 * 先比去标点空白后的子串；不中时按字二元覆盖率判断 —— 模型常把原句换个说法、
 * 删几个字，逐字匹配会把这类正确的判断也拦下。阈值只挡住正文里根本没有的内容。
 */
export function evidenceAppearsInStory(evidence: string, storyText: string): boolean {
  const ev = normalizeForEvidence(evidence);
  if (Array.from(ev).length < EVIDENCE_MIN_CHARS) return false;
  const story = normalizeForEvidence(storyText);
  if (story.includes(ev)) return true;
  const storyGrams = new Set(bigrams(story));
  const evGrams = bigrams(ev);
  const hit = evGrams.filter((g) => storyGrams.has(g)).length;
  return hit / evGrams.length >= EVIDENCE_MIN_OVERLAP;
}

/**
 * 校验本回合的归档判断并生成归档记录。
 *
 * @param openEvents       本轮开始时的未结事件（`collectOpenStoryEvents`）
 * @param turnSegments     本回合刚生成、即将落库的摘要片段（已分配 id）
 */
export function buildStoryArchiveRecords(input: {
  saveId: string;
  turn: StoryTurn;
  decisions: readonly ParsedStoryArchiveDecision[];
  openEvents: readonly OpenStoryEvent[];
  turnSegments: readonly StoryTurnSummaryRecord[];
  now: number;
  makeId: () => string;
}): { records: StoryArchiveRecord[]; rejected: StoryArchiveRejection[] } {
  const storyText = input.turn.storyMessages.map((m) => m.content).join('\n');
  const openByName = new Map(input.openEvents.map((e) => [e.eventName, e]));
  const turnNames = new Set(
    input.turnSegments.map((s) => s.eventName).filter((n): n is string => !!n),
  );
  const source = storyTurnSource(input.turn);

  const records: StoryArchiveRecord[] = [];
  const rejected: StoryArchiveRejection[] = [];
  const seen = new Set<string>();
  for (const decision of input.decisions) {
    const name = decision.eventName;
    if (seen.has(name)) {
      rejected.push({ eventName: name, reason: 'duplicate-event' });
      continue;
    }
    seen.add(name);
    if (!openByName.has(name) && !turnNames.has(name)) {
      rejected.push({ eventName: name, reason: 'unknown-event' });
      continue;
    }
    if (!evidenceAppearsInStory(decision.evidence, storyText)) {
      rejected.push({ eventName: name, reason: 'evidence-not-in-story' });
      continue;
    }
    const coveredSegments = [
      ...(openByName.get(name)?.segments ?? []),
      ...input.turnSegments.filter((s) => s.eventName === name),
    ];
    const covered = [...new Set(coveredSegments.map((s) => s.id))];
    const coveredSources = [
      ...new Map(
        coveredSegments.map((s) => [
          s.sourceTurnKey,
          {
            sourceTurnKey: s.sourceTurnKey,
            sourceMessageIds: s.sourceMessageIds ?? [],
            sourceFingerprint: s.sourceFingerprint,
          },
        ]),
      ).values(),
    ];
    if (covered.length === 0) {
      rejected.push({ eventName: name, reason: 'nothing-to-cover' });
      continue;
    }
    records.push({
      id: input.makeId(),
      saveId: input.saveId,
      eventName: name,
      outcome: decision.outcome,
      evidence: decision.evidence,
      overview: decision.overview,
      detail: { ...decision.detail },
      // 先记成「据摘要」：管线随后用事件原文重写详细记录，成功才改为 source-text
      detailSource: 'summary',
      coveredSegmentIds: covered,
      ...source,
      coveredSources,
      coveredSegmentFingerprints: Object.fromEntries(
        coveredSegments.map((s) => [s.id, storySegmentFingerprint(s)]),
      ),
      sequence: records.length,
      createdAt: input.now,
    });
  }
  return { records, rejected };
}

/** 第 2 区：全部有效归档的概括记录，形如历史年表（不按本轮话题筛选，计划 D20/D21）。 */
export function renderLongTermOverview(archives: readonly StoryArchiveRecord[]): string {
  if (archives.length === 0) return '';
  const lines = archives.map(
    (a) => `- 【${a.eventName}｜${OUTCOME_LABELS[a.outcome]}】${a.overview}`,
  );
  return `<长期记忆总览>\n${lines.join('\n')}\n</长期记忆总览>`;
}

/** 给总结 Agent 的未结事件清单（`{{STORY_OPEN_EVENTS}}`）。没有未结事件时写明「无」。 */
export function renderOpenEventsForSummary(events: readonly OpenStoryEvent[]): string {
  if (events.length === 0) return '（当前没有未结束的事件）';
  return events
    .map((event) =>
      [
        `【${event.eventName}】`,
        ...event.segments.map((s: StoryTurnSummarySegment) => `- ${s.content}`),
      ].join('\n'),
    )
    .join('\n\n');
}
