/** Shared source contract for pipeline, memory reads, persistence and backup.
 * Fingerprints exclude physical IDs/timestamps; backup only remaps references.
 * Missing fingerprints on old v2 rows are unknown, never retroactively trusted.
 */
import type {
  StoryMemorySource,
  StoryTurnSummaryRecord,
  StoryMemoryGameTimeRange,
  StoryArchiveRecord,
} from '../types/types';
import { hashContentDeterministic } from '../content/content-source';
import type { StoryTurn } from './memory-context';

export function storyTurnSource(
  turn: StoryTurn,
): StoryMemorySource & { sourceFingerprint: string } {
  const messages = [...(turn.userMessage ? [turn.userMessage] : []), ...turn.storyMessages];
  return {
    sourceTurnKey: turn.key,
    sourceMessageIds: messages.map((message) => message.id),
    sourceFingerprint: `story-source-v1:${hashContentDeterministic(
      JSON.stringify(messages.map((message) => [message.role, message.content])),
    )}`,
  };
}

export function storyMemorySourceMatches(
  source: Partial<StoryMemorySource>,
  turn: StoryTurn,
): boolean {
  const current = storyTurnSource(turn);
  return (
    source.sourceTurnKey === current.sourceTurnKey &&
    !!source.sourceFingerprint &&
    source.sourceFingerprint === current.sourceFingerprint &&
    !!source.sourceMessageIds &&
    source.sourceMessageIds.length === current.sourceMessageIds.length &&
    source.sourceMessageIds.every((id, index) => id === current.sourceMessageIds[index])
  );
}

/** Only original turn facts are admissible, never the current profile or wall clock. */
export function storyTurnGameTimeRange(turn: StoryTurn): StoryMemoryGameTimeRange {
  const last = turn.storyMessages[turn.storyMessages.length - 1];
  return {
    start: turn.userMessage?.storyGameTime ? { ...turn.userMessage.storyGameTime } : null,
    end: last?.storyGameTime ? { ...last.storyGameTime } : null,
  };
}

/** Semantic revision of a summary, also stable across physical ID remapping. */
export function storySegmentFingerprint(
  segment: Pick<
    StoryTurnSummaryRecord,
    'content' | 'eventName' | 'order' | 'characters' | 'locations' | 'topics' | 'gameTimeRange'
  >,
): string {
  return `story-segment-v1:${hashContentDeterministic(
    JSON.stringify([
      segment.content,
      segment.eventName ?? null,
      segment.order,
      segment.characters ?? null,
      segment.locations ?? null,
      segment.topics ?? null,
      segment.gameTimeRange ?? null,
    ]),
  )}`;
}

/** Complete current coverage, including same-ID semantic edits. No guessed ID remapping. */
export function storyArchiveCoverageMatches(
  record: Pick<
    StoryArchiveRecord,
    'coveredSegmentIds' | 'coveredSources' | 'coveredSegmentFingerprints' | 'invalidatedReason'
  >,
  segments: readonly (Pick<StoryTurnSummaryRecord, 'id' | 'sourceTurnKey' | 'content' | 'order'> &
    Partial<StoryTurnSummaryRecord>)[],
): boolean {
  if (
    record.invalidatedReason ||
    !record.coveredSources ||
    !record.coveredSegmentFingerprints ||
    !record.coveredSegmentIds.length
  )
    return false;
  const byId = new Map(segments.map((segment) => [segment.id, segment]));
  return record.coveredSegmentIds.every((id) => {
    const segment = byId.get(id);
    return (
      !!segment &&
      !!segment.sourceFingerprint &&
      record.coveredSegmentFingerprints![id] === storySegmentFingerprint(segment) &&
      record.coveredSources!.some(
        (source) =>
          source.sourceTurnKey === segment.sourceTurnKey &&
          source.sourceFingerprint === segment.sourceFingerprint &&
          JSON.stringify(source.sourceMessageIds) === JSON.stringify(segment.sourceMessageIds),
      )
    );
  });
}

export function storyMemorySourcesMatch(
  sources: readonly StoryMemorySource[] | undefined,
  turns: readonly StoryTurn[],
): boolean {
  if (!sources) return false;
  const byKey = new Map(turns.map((turn) => [turn.key, turn]));
  return sources.every((source) => {
    const turn = byKey.get(source.sourceTurnKey);
    return !!turn && storyMemorySourceMatches(source, turn);
  });
}
