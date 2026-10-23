/**
 * story-archive.test.ts — 阶段归档的代码侧把关、未结事件派生与第 2 区渲染
 * （计划 §8 / D09 / D20–D23 / D29–D30，Q13，T17/T45/T46/T49）。
 */
import { describe, it, expect } from 'vitest';
import {
  storyTurnSource,
  storySegmentFingerprint,
} from '../../../src/core/memory/story-memory-source';
import type {
  ChatMessage,
  StoryArchiveRecord,
  StoryTurnSummaryRecord,
} from '../../../src/core/types/types';
import {
  archivedSegmentIdsOf,
  collectCompleteStoryTurns,
  collectOpenStoryEvents,
  resolveActiveStoryArchives,
} from '../../../src/core/memory/memory-context';
import {
  buildStoryArchiveRecords,
  evidenceAppearsInStory,
  renderLongTermOverview,
  renderOpenEventsForSummary,
} from '../../../src/core/memory/story-archive';
import {
  buildStoryArchiveDetailMessages,
  collectArchiveSourceTurns,
  parseStoryArchiveDetail,
} from '../../../src/core/memory/story-archive-detail';
import type { ParsedStoryArchiveDecision } from '../../../src/core/memory/story-turn-summary';

function msg(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: 0 };
}

const messages: ChatMessage[] = [
  msg('u1', 'user', '接委托'),
  msg('a1', 'assistant', '你接下了送信的委托。'),
  msg('u2', 'user', '赶路'),
  msg('a2', 'assistant', '路上遇到一只走失的猫。'),
  msg('u3', 'user', '交信'),
  msg('a3', 'assistant', '老人接过信，连声道谢。委托就此完成。'),
];

function seg(
  id: string,
  turnKey: string,
  eventName: string | undefined,
  content: string,
): StoryTurnSummaryRecord {
  return {
    id,
    saveId: 's',
    ...storyTurnSource(
      collectCompleteStoryTurns(messages).find((t) => t.key === turnKey) ?? {
        key: turnKey,
        storyMessages: [],
      },
    ),
    order: 0,
    content,
    ...(eventName ? { eventName } : {}),
    createdAt: 0,
  };
}

function decision(
  eventName: string,
  evidence: string,
  outcome: ParsedStoryArchiveDecision['outcome'] = 'completed',
): ParsedStoryArchiveDecision {
  return {
    eventName,
    outcome,
    evidence,
    overview: `${eventName}的结局`,
    detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
  };
}

function archiveOf(
  id: string,
  turnKey: string,
  covered: string[],
  createdAt = 1,
  sourceSegments: StoryTurnSummaryRecord[] = [],
): StoryArchiveRecord {
  return {
    id,
    saveId: 's',
    eventName: id,
    outcome: 'completed',
    evidence: 'x',
    overview: `${id}概括`,
    detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
    detailSource: 'summary',
    coveredSegmentIds: covered,
    coveredSources: sourceSegments.map(
      ({ sourceTurnKey, sourceMessageIds, sourceFingerprint }) => ({
        sourceTurnKey,
        sourceMessageIds,
        sourceFingerprint,
      }),
    ),
    coveredSegmentFingerprints: Object.fromEntries(
      sourceSegments.map((s) => [s.id, storySegmentFingerprint(s)]),
    ),
    ...storyTurnSource(
      collectCompleteStoryTurns(messages).find((t) => t.key === turnKey) ?? {
        key: turnKey,
        storyMessages: [],
      },
    ),
    sequence: 0,
    createdAt,
  };
}

describe('collectOpenStoryEvents / resolveActiveStoryArchives', () => {
  const history = messages.slice(0, 4);
  const segments = [
    seg('s1', 'u1', '送信', '接下送信委托'),
    seg('s2', 'u2', '寻猫', '遇到走失的猫'),
    seg('s3', 'u2', undefined, '天气不错'),
  ];

  it('按事件名分组未归档片段；闲聊片段不构成事件', () => {
    const open = collectOpenStoryEvents(history, segments, []);
    expect(open.map((e) => e.eventName)).toEqual(['送信', '寻猫']);
  });

  it('被有效归档覆盖的片段不再算未结；回退掉的归档不算（D23）', () => {
    const live = archiveOf('寻猫归档', 'u2', ['s2'], 1, [segments[1]]);
    const rolledBack = archiveOf('幽灵', 'u9', ['s1']);
    expect(
      collectOpenStoryEvents(history, segments, [live, rolledBack]).map((e) => e.eventName),
    ).toEqual(['送信']);
    const active = resolveActiveStoryArchives(history, [rolledBack, live], segments);
    expect(active.map((a) => a.id)).toEqual(['寻猫归档']);
    expect([...archivedSegmentIdsOf(active)]).toEqual(['s2']);
  });

  it('有效归档按作出判断的时间排成年表', () => {
    const later = archiveOf('后', 'u2', ['s2'], 5, [segments[1]]);
    const earlier = archiveOf('前', 'u1', ['s1'], 2, [segments[0]]);
    expect(
      resolveActiveStoryArchives(history, [later, earlier], segments).map((a) => a.id),
    ).toEqual(['前', '后']);
  });
});

describe('buildStoryArchiveRecords', () => {
  const turn = collectCompleteStoryTurns(messages).find((t) => t.key === 'u3')!;
  const openEvents = collectOpenStoryEvents(
    messages.slice(0, 4),
    [seg('s1', 'u1', '送信', '接下送信委托')],
    [],
  );
  const turnSegments = [seg('s9', 'u3', '送信', '把信交给老人')];
  let n = 0;
  const base = {
    saveId: 's',
    turn,
    openEvents,
    turnSegments,
    now: 100,
    makeId: () => `arc${++n}`,
  };

  it('未结事件 + 正文逐字依据 → 归档覆盖事件全部片段（含本回合新片段）', () => {
    const { records, rejected } = buildStoryArchiveRecords({
      ...base,
      decisions: [decision('送信', '委托就此完成。')],
    });
    expect(rejected).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      eventName: '送信',
      outcome: 'completed',
      coveredSegmentIds: ['s1', 's9'],
      sourceTurnKey: 'u3',
      sourceMessageIds: ['u3', 'a3'],
      createdAt: 100,
      // 先记成据摘要：原文重写由管线随后完成
      detailSource: 'summary',
    });
  });

  it('放宽匹配：改写措辞、增删个别字、标点不同都能通过；正文里没有的内容与过短片段不通过', () => {
    const story = '老人接过信，连声道谢。委托就此完成。';
    expect(evidenceAppearsInStory('老人接过了信件，连声道谢', story)).toBe(true);
    expect(evidenceAppearsInStory('委托就此完成！', story)).toBe(true);
    expect(evidenceAppearsInStory('城门在身后缓缓关上', story)).toBe(false);
    expect(evidenceAppearsInStory('完成', story)).toBe(false);
    expect(evidenceAppearsInStory('', story)).toBe(false);
  });

  it('依据比对忽略空白；放弃与失败同样可以归档', () => {
    const { records } = buildStoryArchiveRecords({
      ...base,
      decisions: [decision('送信', '委托 就此\n完成', 'abandoned')],
    });
    expect(records[0].outcome).toBe('abandoned');
  });

  it('依据不在本回合正文里、事件不存在、重复判断 → 拦下，事件保持未归档（T17/T49）', () => {
    const { records, rejected } = buildStoryArchiveRecords({
      ...base,
      decisions: [
        decision('送信', '你接下了送信的委托。'), // 上一回合的原文，不是本回合的结局
        decision('不存在的事件', '委托就此完成。'),
      ],
    });
    expect(records).toEqual([]);
    expect(rejected).toEqual([
      { eventName: '送信', reason: 'evidence-not-in-story' },
      { eventName: '不存在的事件', reason: 'unknown-event' },
    ]);
    const dup = buildStoryArchiveRecords({
      ...base,
      decisions: [decision('送信', '委托就此完成。'), decision('送信', '委托就此完成。')],
    });
    expect(dup.records).toHaveLength(1);
    expect(dup.rejected).toEqual([{ eventName: '送信', reason: 'duplicate-event' }]);
  });

  it('同一回合开始又结束的事件也能归档', () => {
    const { records } = buildStoryArchiveRecords({
      ...base,
      openEvents: [],
      turnSegments: [seg('s10', 'u3', '道谢', '老人道谢')],
      decisions: [decision('道谢', '连声道谢')],
    });
    expect(records[0].coveredSegmentIds).toEqual(['s10']);
  });
});

describe('渲染', () => {
  it('第 2 区：有效归档的年表，结局用中文标签；没有归档时为空', () => {
    expect(renderLongTermOverview([])).toBe('');
    const text = renderLongTermOverview([
      { ...archiveOf('送信', 'u3', []), outcome: 'failed', overview: '信没送到' },
    ]);
    expect(text).toBe('<长期记忆总览>\n- 【送信｜失败】信没送到\n</长期记忆总览>');
  });

  it('未结事件清单：按事件列出摘要；没有时写明', () => {
    expect(renderOpenEventsForSummary([])).toBe('（当前没有未结束的事件）');
    expect(
      renderOpenEventsForSummary([
        { eventName: '送信', segments: [seg('s1', 'u1', '送信', '接下送信委托')] },
      ]),
    ).toBe('【送信】\n- 接下送信委托');
  });
});

describe('依据事件原文的详细记录（D29）', () => {
  const turns = collectCompleteStoryTurns(messages);
  const archive = {
    eventName: '送信',
    outcome: 'completed' as const,
    overview: '把信送到',
    coveredSegmentIds: ['s1', 's9'],
    sourceTurnKey: 'u3',
  };
  const segments = [
    { id: 's1', sourceTurnKey: 'u1' },
    { id: 's2', sourceTurnKey: 'u2' }, // 别的事件，不在覆盖范围
    { id: 's9', sourceTurnKey: 'u3' },
  ];

  it('来源回合 = 覆盖片段的回合 + 作出判断的回合，按时间排列', () => {
    expect(collectArchiveSourceTurns(turns, archive, segments).map((t) => t.key)).toEqual([
      'u1',
      'u3',
    ]);
    // 判断回合没有该事件的片段时也带上（结局写在那一回合的正文里）
    expect(
      collectArchiveSourceTurns(turns, { ...archive, coveredSegmentIds: ['s1'] }, segments).map(
        (t) => t.key,
      ),
    ).toEqual(['u1', 'u3']);
  });

  it('请求里带上每个来源回合的玩家输入与正文原文', () => {
    const msgs = buildStoryArchiveDetailMessages({
      archive,
      turns: collectArchiveSourceTurns(turns, archive, segments),
    });
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].content).toContain('送信（成功完成）');
    expect(msgs[1].content).toContain('玩家：接委托');
    expect(msgs[1].content).toContain('正文：你接下了送信的委托。');
    expect(msgs[1].content).toContain('委托就此完成。');
    expect(msgs[1].content).not.toContain('走失的猫');
  });

  it('解析详细记录；五项全空或认不出时返回 null', () => {
    expect(
      parseStoryArchiveDetail('<json>{"cause":"老人托付","promises":"报酬 30 银币"}</json>'),
    ).toEqual({
      cause: '老人托付',
      process: '',
      ending: '',
      promises: '报酬 30 银币',
      impact: '',
    });
    expect(parseStoryArchiveDetail('{"cause":""}')).toBeNull();
    expect(parseStoryArchiveDetail('不是 JSON')).toBeNull();
  });
});
