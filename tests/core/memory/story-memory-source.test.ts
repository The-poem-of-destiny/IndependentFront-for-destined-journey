import { describe, expect, it } from 'vitest';
import type {
  ChatMessage,
  StoryArchiveRecord,
  StoryTurnSummaryRecord,
} from '../../../src/core/types/types';
import {
  collectCompleteStoryTurns,
  findStoryTurnsMissingSummary,
  resolveActiveStoryArchives,
  collectOpenStoryEvents,
} from '../../../src/core/memory/memory-context';
import {
  storyTurnSource,
  storyMemorySourceMatches,
  storyTurnGameTimeRange,
  storySegmentFingerprint,
} from '../../../src/core/memory/story-memory-source';
import { buildStoryArchiveRecords } from '../../../src/core/memory/story-archive';
import { collectArchiveSourceTurns } from '../../../src/core/memory/story-archive-detail';

const history: ChatMessage[] = [
  { id: 'u1', role: 'user', content: '接信', timestamp: 1 },
  { id: 'a1', role: 'assistant', content: '你答应送信。', timestamp: 2 },
  { id: 'u2', role: 'user', content: '交付', timestamp: 3 },
  { id: 'a2', role: 'assistant', content: '老人收到信，委托就此完成。', timestamp: 4 },
];
function fixture(): { segments: StoryTurnSummaryRecord[]; archive: StoryArchiveRecord } {
  const turns = collectCompleteStoryTurns(history);
  const segments = turns.map((turn, i) => ({
    id: `s${i}`,
    saveId: 's',
    ...storyTurnSource(turn),
    order: 0,
    eventName: '送信',
    content: `摘要${i}`,
    createdAt: i,
  }));
  const { records } = buildStoryArchiveRecords({
    saveId: 's',
    turn: turns[1],
    turnSegments: [segments[1]],
    openEvents: [{ eventName: '送信', segments: [segments[0]] }],
    decisions: [
      {
        eventName: '送信',
        outcome: 'completed',
        evidence: '委托就此完成',
        overview: '送信完成',
        detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
      },
    ],
    now: 4,
    makeId: () => 'arc',
  });
  return { segments, archive: records[0] };
}

describe('shared Story source contract', () => {
  it('ID重映射保持正文指纹，但消息列表必须精确匹配；同ID正文变化失效', () => {
    const turn = collectCompleteStoryTurns(history)[0],
      source = storyTurnSource(turn);
    const remapped = collectCompleteStoryTurns(
      history.map((m) => ({ ...m, id: `new-${m.id}` })),
    )[0];
    expect(storyTurnSource(remapped).sourceFingerprint).toBe(source.sourceFingerprint);
    expect(storyMemorySourceMatches(source, remapped)).toBe(false);
    expect(storyMemorySourceMatches(storyTurnSource(remapped), remapped)).toBe(true);
    const edited = collectCompleteStoryTurns(
      history.map((m) => (m.id === 'a1' ? { ...m, content: '你拒绝送信。' } : m)),
    )[0];
    expect(storyMemorySourceMatches(source, edited)).toBe(false);
  });

  it('旧v2缺正文指纹不冒充有效摘要/归档，也不伪造语义字段', () => {
    const { segments, archive } = fixture();
    const old = { ...segments[0], sourceFingerprint: undefined };
    expect(findStoryTurnsMissingSummary(history, [old, segments[1]]).map((t) => t.key)).toEqual([
      'u1',
    ]);
    expect(
      resolveActiveStoryArchives(history, [{ ...archive, sourceFingerprint: undefined }], segments),
    ).toEqual([]);
    expect(old.characters).toBeUndefined();
  });

  it('读取复核覆盖IDs/语义fingerprint，不能只凭结局来源接纳归档', () => {
    const { segments, archive } = fixture();
    expect(resolveActiveStoryArchives(history, [archive], segments)).toHaveLength(1);
    for (const rows of [
      segments.slice(1),
      [{ ...segments[0], content: '同ID新摘要' }, segments[1]],
    ]) {
      expect(resolveActiveStoryArchives(history, [archive], rows)).toEqual([]);
      expect(collectOpenStoryEvents(history, rows, [archive])).toHaveLength(1);
    }
    expect(resolveActiveStoryArchives(history, [archive])).toEqual([]);
    expect(
      resolveActiveStoryArchives(
        history,
        [{ ...archive, coveredSegmentFingerprints: undefined }],
        segments,
      ),
    ).toEqual([]);
  });

  it('较早正文同ID改写使全部依赖归档失效，结局回合未变也不能沿用', () => {
    const { segments, archive } = fixture();
    const edited = history.map((m) => (m.id === 'a1' ? { ...m, content: '实际拒绝送信。' } : m));
    expect(resolveActiveStoryArchives(edited, [archive], segments)).toEqual([]);
    expect(collectArchiveSourceTurns(collectCompleteStoryTurns(edited), archive, segments)).toEqual(
      [],
    );
    expect(
      collectArchiveSourceTurns(collectCompleteStoryTurns(history), archive, segments.slice(1)),
    ).toEqual([]);
  });

  it('摘要语义指纹不含物理ID，语义变化（含人物/地点/时间）会改变', () => {
    const { segments } = fixture();
    const row = segments[0];
    const remapped = { ...row, id: 'new-id' };
    expect(storySegmentFingerprint(remapped)).toBe(storySegmentFingerprint(row));
    expect(storySegmentFingerprint({ ...row, characters: ['老人'] })).not.toBe(
      storySegmentFingerprint(row),
    );
  });
});

describe('formal turns and original game time facts', () => {
  it('pending/failed/诊断/systemEvent不进入窗口或补建；缺标记旧正文兼容', () => {
    const messages: ChatMessage[] = [
      history[0],
      { ...history[1], storyTurnStatus: 'failed' },
      { ...history[1], id: 'pending', storyTurnStatus: 'pending' },
      { ...history[1], id: 'diagnostic', diagnostic: true },
      {
        ...history[1],
        id: 'system',
        systemEvent: { type: 'character_update', characterName: '甲', narrative: '状态更新' },
      },
      history[2],
      history[3],
    ];
    expect(collectCompleteStoryTurns(messages).map((t) => t.key)).toEqual(['u2']);
    expect(findStoryTurnsMissingSummary(messages, []).map((t) => t.key)).toEqual(['u2']);
  });

  it('显式归属找不到user不能并入邻回合；无user开场self key及其后同key正文有效', () => {
    const opening: ChatMessage = {
      ...history[1],
      id: 'opening',
      storyTurnKey: 'opening',
      storyTurnStatus: 'accepted',
    };
    const messages: ChatMessage[] = [
      opening,
      { ...opening, id: 'opening-more' },
      ...history.slice(0, 2),
      { ...history[3], id: 'orphan', storyTurnKey: 'removed-user', storyTurnStatus: 'accepted' },
    ];
    const turns = collectCompleteStoryTurns(messages);
    expect(turns.map((t) => t.key)).toEqual(['opening', 'u1']);
    expect(turns[0].storyMessages.map((m) => m.id)).toEqual(['opening', 'opening-more']);
    expect(turns[1].storyMessages.map((m) => m.id)).toEqual(['a1']);
  });

  it('游戏时间范围仅取原回合事实，未知端保留null，不使用真实timestamp/现在时间', () => {
    const start = { era: '测试纪元', year: 10, month: 2, day: 3, weekday: 2, hour: 8, minute: 0 };
    const end = { ...start, hour: 10 };
    const turn = collectCompleteStoryTurns([
      { ...history[0], storyGameTime: start },
      { ...history[1], storyGameTime: end },
    ])[0];
    expect(storyTurnGameTimeRange(turn)).toEqual({ start, end });
    expect(storyTurnGameTimeRange(collectCompleteStoryTurns(history)[0])).toEqual({
      start: null,
      end: null,
    });
    expect(storyTurnGameTimeRange({ ...turn, userMessage: { ...history[0] } })).toEqual({
      start: null,
      end,
    });
  });
});
