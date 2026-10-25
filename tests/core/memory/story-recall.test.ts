/**
 * story-recall.test.ts — Story 上下文 v2 的记忆召回：候选、查询、LLM 契约解析、展开
 * （计划 §9 / D07 / D22 / D30–D33，T19/T20/T47）。
 */
import { describe, it, expect } from 'vitest';
import { collectCompleteStoryTurns } from '../../../src/core/memory/memory-context';
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
  STORY_RECALL_SYSTEM_PROMPT,
  STORY_RECALL_TEMPLATE,
  buildStoryRecallCandidates,
  buildStoryRecallQuery,
  expandStoryRecall,
  parseStoryRecallSelection,
  rankStoryRecallFallback,
  selectStoryRecallQueryFallback,
  renderStoryRecallCandidates,
  storyArchiveEmbeddingText,
  storySegmentEmbeddingText,
} from '../../../src/core/memory/story-recall';

function msg(id: string, role: ChatMessage['role'], content: string): ChatMessage {
  return { id, role, content, timestamp: 0 };
}

/** 五个完整回合；N=2 时第 1–3 回合在窗口外，第 4–5 回合在窗口内。 */
const messages: ChatMessage[] = [
  msg('u1', 'user', '找铁匠'),
  msg('a1', 'assistant', '铁匠答应三天后交剑，收了十枚银币定金。'),
  msg('u2', 'user', '去酒馆'),
  msg('a2', 'assistant', '酒馆里很吵。\n老板娘提起北边的狼。\n角落有人在赌钱。\n门外下起了雨。'),
  msg('u3', 'user', '回铁匠铺'),
  msg('a3', 'assistant', '剑已打好，交易完成。'),
  msg('u4', 'user', '出城'),
  msg('a4', 'assistant', '城门外是一条泥路。'),
  msg('u5', 'user', '继续走'),
  msg('a5', 'assistant', '天色渐暗。'),
];

function seg(
  id: string,
  turn: number,
  content: string,
  eventName?: string,
  order = 0,
): StoryTurnSummaryRecord {
  return {
    id,
    saveId: 's',
    ...storyTurnSource(collectCompleteStoryTurns(messages).find((t) => t.key === `u${turn}`)!),
    order,
    content,
    ...(eventName ? { eventName } : {}),
    createdAt: turn,
  };
}

const segments: StoryTurnSummaryRecord[] = [
  seg('s1', 1, '铁匠答应三天后交剑，定金十枚银币', '订剑'),
  seg('s2', 2, '老板娘说北边有狼'),
  seg('s3', 3, '取到剑，交易完成', '订剑'),
  seg('s4', 4, '出城'),
  // 来源正文已被替换（重生成）：无效
  { ...seg('stale', 2, '旧版本'), sourceMessageIds: ['u2', 'a2-old'] },
];

const archive: StoryArchiveRecord = {
  id: 'ar1',
  saveId: 's',
  eventName: '订剑',
  outcome: 'completed',
  evidence: '剑已打好，交易完成',
  overview: '向铁匠订剑并按期取到',
  detail: {
    cause: '需要武器',
    process: '付定金，三天后取剑',
    ending: '取到剑',
    promises: '三天交剑，定金十枚银币',
    impact: '',
  },
  detailSource: 'source-text',
  coveredSegmentIds: ['s1', 's3'],
  ...storyTurnSource(collectCompleteStoryTurns(messages)[2]),
  coveredSources: [0, 2].map((i) => storyTurnSource(collectCompleteStoryTurns(messages)[i])),
  coveredSegmentFingerprints: Object.fromEntries(
    [segments[0], segments[2]].map((s) => [s.id, storySegmentFingerprint(s)]),
  ),
  sequence: 0,
  createdAt: 3,
};

const base = { messages, windowTurns: 2, segments, archives: [archive] };

describe('buildStoryRecallCandidates', () => {
  it('候选 = 有效归档 + 窗口外的有效片段（含已归档片段），编号按时间顺序', () => {
    const candidates = buildStoryRecallCandidates(base);
    expect(candidates.map((c) => c.ref)).toEqual(['A1', 'S1', 'S2', 'S3']);
    expect(candidates.map((c) => (c.kind === 'archive' ? c.archive.id : c.segment.id))).toEqual([
      'ar1',
      's1',
      's2',
      's3',
    ]);
    const s1 = candidates[1];
    expect(s1.kind === 'segment' && s1.archived).toBe(true);
    expect(s1.text).toContain('第1回合【订剑】');
    expect(s1.text).toContain('（已归档）');
  });

  it('窗口内回合的片段不进候选；来源失效的片段不进候选', () => {
    const ids = buildStoryRecallCandidates(base).map((c) =>
      c.kind === 'segment' ? c.segment.id : c.archive.id,
    );
    expect(ids).not.toContain('s4');
    expect(ids).not.toContain('stale');
  });

  it('回退掉作出判断的回合 → 归档失效，不进候选，片段不再标已归档', () => {
    const candidates = buildStoryRecallCandidates({ ...base, messages: messages.slice(0, 4) });
    expect(candidates.some((c) => c.kind === 'archive')).toBe(false);
    expect(candidates.every((c) => c.kind === 'segment' && !c.archived)).toBe(true);
  });

  it('带上落库时存的向量', () => {
    const meta = {
      spaceId: 'x',
      model: 'm',
      dimensions: 2,
      preprocessingVersion: 'fmt-v1',
      contentRevision: 'r',
    };
    const withVector = [{ ...segments[0], embedding: [1, 0], embeddingMeta: meta }];
    const [candidate] = buildStoryRecallCandidates({ ...base, segments: withVector, archives: [] });
    expect(candidate.embedding).toEqual([1, 0]);
    expect(candidate.embeddingMeta).toEqual(meta);
  });
});

describe('renderStoryRecallCandidates / 兜底排序 / 查询', () => {
  it('清单分「事件档案」「回合摘要」两段，带编号', () => {
    const text = renderStoryRecallCandidates(buildStoryRecallCandidates(base));
    expect(text).toContain('事件档案：\n[A1] 【订剑｜成功完成】向铁匠订剑并按期取到');
    expect(text).toContain('回合摘要：\n[S1] 第1回合【订剑】');
    expect(renderStoryRecallCandidates([])).toBe('（没有可召回的记忆）');
  });

  it('兜底：越新越前，同回合事件档案在前', () => {
    const ranked = rankStoryRecallFallback(buildStoryRecallCandidates(base));
    expect(ranked.map((c) => c.ref)).toEqual(['A1', 'S3', 'S2', 'S1']);
  });

  it('查询 = 本轮输入 + 上回合玩家输入与正文末尾（「继续」也有场景可依）', () => {
    const query = buildStoryRecallQuery({ userInput: '继续', messages });
    expect(query).toBe('本轮：继续\n上回合玩家：继续走\n上回合正文：天色渐暗。');
  });
});

describe('LLM 召回契约', () => {
  it('failure fallback prefers the query over recency, is capped, and leaves unrelated slots empty', () => {
    const candidates = buildStoryRecallCandidates(base);
    const selected = selectStoryRecallQueryFallback(candidates, '铁匠交剑定金十枚银币', 20);
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(3);
    expect(selected.some((c) => c.ref === 'S1')).toBe(true);
    expect(selected.some((c) => c.ref === 'S2')).toBe(false);
    expect(selectStoryRecallQueryFallback(candidates, 'zzzzzz', 20)).toEqual([]);
    expect(selectStoryRecallQueryFallback(candidates, '铁匠', 1)).toHaveLength(1);
  });
  it('提示词与模板同源：模板读候选清单、近期对话与本轮输入', () => {
    expect(STORY_RECALL_TEMPLATE).toContain('{{STORY_RECALL_CANDIDATES}}');
    expect(STORY_RECALL_TEMPLATE).toContain('{{NARRATIVE:layers=3}}');
    expect(STORY_RECALL_TEMPLATE).toContain('{{USER_INPUT}}');
    expect(STORY_RECALL_SYSTEM_PROMPT).toContain('"memories"');
  });

  it('只收清单里的编号，去重保序，超量截断；清单外编号进诊断', () => {
    const candidates = buildStoryRecallCandidates(base);
    const raw =
      '想了想。<json>{"memories":[{"id":"S3"},{"id":"[a1]"},{"id":"S3"},{"id":"S9"},{"id":"S1"}]}</json>';
    expect(parseStoryRecallSelection(raw, candidates, 2)).toEqual({
      refs: ['S3', 'A1'],
      unknownRefs: ['S9'],
    });
  });

  it('空数组是合法的「本轮不需要」；认不出 → null', () => {
    const candidates = buildStoryRecallCandidates(base);
    expect(parseStoryRecallSelection('{"memories":[]}', candidates, 5)).toEqual({
      refs: [],
      unknownRefs: [],
    });
    expect(parseStoryRecallSelection('没有 JSON', candidates, 5)).toBeNull();
    expect(parseStoryRecallSelection('{"other":1}', candidates, 5)).toBeNull();
  });
});

describe('expandStoryRecall', () => {
  const candidates = buildStoryRecallCandidates(base);
  const byRef = (ref: string) => candidates.find((c) => c.ref === ref)!;

  it.each(['segment', 'archive'] as const)(
    'preserves source time and place for %s even if raw text is omitted',
    (kind) => {
      const dated = {
        ...segments[0],
        locations: ['药剂铺'],
        characters: ['店主'],
        gameTimeRange: {
          start: { era: '复兴纪元', year: 488, month: 1, day: 1, hour: 15, minute: 0, weekday: 1 },
          end: { era: '复兴纪元', year: 488, month: 1, day: 1, hour: 15, minute: 20, weekday: 1 },
        },
      };
      const sources = [dated, ...segments.slice(1)];
      const archiveWithTime = {
        ...archive,
        coveredSegmentFingerprints: {
          ...archive.coveredSegmentFingerprints,
          s1: storySegmentFingerprint(dated),
        },
      };
      const setup = { ...base, segments: sources, archives: [archiveWithTime] };
      const selected = buildStoryRecallCandidates(setup).find((c) =>
        kind === 'segment' ? c.ref === 'S1' : c.ref === 'A1',
      )!;
      const expanded = expandStoryRecall({
        ...setup,
        selected: [selected],
        rawMode: 'snippet',
        rawCharBudget: 0,
        probe: '交易日期',
      });
      expect(expanded.text).toContain('0488年-01月-01日');
      expect(expanded.text).toContain('15:00');
      expect(expanded.text).toContain('15:20');
      expect(expanded.text).toContain('地点：药剂铺');
      expect(expanded.text).toContain('人物：店主');
      expect(expanded.text).toContain('〔第1回合〕来源定位');
      expect(expanded.diagnostics.rawChars).toBe(0);
    },
  );

  it('回合摘要 + 整回合原文（T19：约定照原文）', () => {
    const { text, diagnostics } = expandStoryRecall({
      ...base,
      selected: [byRef('S1')],
      rawMode: 'turn',
      probe: '铁匠',
    });
    expect(text).toContain('【回合摘要】第1回合【订剑】铁匠答应三天后交剑');
    expect(text).toContain(
      '〔第1回合〕原文：\n玩家：找铁匠\n正文：铁匠答应三天后交剑，收了十枚银币定金。',
    );
    expect(text.startsWith('以下是与本轮相关的过往记忆')).toBe(true);
    expect(diagnostics.rawTurnKeys).toEqual(['u1']);
    expect(diagnostics.rawChars).toBeGreaterThan(0);
    expect(diagnostics.chars).toBe(text.length);
  });

  it('事件档案：详细记录 + 全部来源回合原文（T20）；同一回合原文只贴一次', () => {
    const { text, diagnostics } = expandStoryRecall({
      ...base,
      selected: [byRef('A1'), byRef('S1')],
      rawMode: 'turn',
      probe: '',
    });
    expect(text).toContain('【事件档案】订剑（成功完成）');
    expect(text).toContain('约定：三天交剑，定金十枚银币');
    expect(text).not.toContain('影响：');
    expect(text).toContain('〔第3回合〕原文：');
    expect(diagnostics.rawTurnKeys).toEqual(['u1', 'u3']);
    expect(text).toContain('〔第1回合〕原文见前文。');
  });

  it('依据摘要整理的详细记录写明未经原文核对', () => {
    const summaryArchive = { ...archive, detailSource: 'summary' as const };
    const [a] = buildStoryRecallCandidates({ ...base, archives: [summaryArchive] });
    const { text } = expandStoryRecall({ ...base, selected: [a], rawMode: 'turn', probe: '' });
    expect(text).toContain('（详细记录依据摘要整理，未经原文核对）');
  });

  it('来源回合在窗口内：不重复贴原文，只写明在最近对话中', () => {
    const { text, diagnostics } = expandStoryRecall({
      ...base,
      windowTurns: 3,
      selected: [byRef('A1')],
      rawMode: 'turn',
      probe: '',
    });
    expect(text).toContain('〔第3回合〕原文在最近对话中。');
    expect(diagnostics.inWindowTurnKeys).toEqual(['u3']);
    expect(diagnostics.rawTurnKeys).toEqual(['u1']);
  });

  it('片段方案：只贴最相关段落加前后各一段，标「节选」', () => {
    const { text } = expandStoryRecall({
      ...base,
      selected: [byRef('S2')],
      rawMode: 'snippet',
      probe: '狼',
    });
    expect(text).toContain(
      '正文（节选）：酒馆里很吵。\n老板娘提起北边的狼。\n角落有人在赌钱。\n……',
    );
    expect(text).not.toContain('门外下起了雨');
  });

  it('片段方案下段落不多时整段给出、不标节选', () => {
    const { text } = expandStoryRecall({
      ...base,
      selected: [byRef('S1')],
      rawMode: 'snippet',
      probe: '铁匠',
    });
    expect(text).toContain('正文：铁匠答应三天后交剑');
    expect(text).not.toContain('节选');
  });

  it('原文总量超上限：后面的回合只留摘要并标注省略', () => {
    const { text, diagnostics } = expandStoryRecall({
      ...base,
      selected: [byRef('S1'), byRef('S2')],
      rawMode: 'turn',
      probe: '',
      rawCharBudget: 40,
    });
    expect(diagnostics.rawTurnKeys).toEqual(['u1']);
    expect(diagnostics.omittedTurnKeys).toEqual(['u2']);
    expect(text).toContain('【回合摘要】第2回合老板娘说北边有狼');
    expect(text).toContain('〔第2回合〕原文因本轮篇幅上限省略，以上摘要为准。');
  });

  it('没有选中 → 空串（第 5 区整块不出）', () => {
    expect(expandStoryRecall({ ...base, selected: [], rawMode: 'turn', probe: '' }).text).toBe('');
  });
});

describe('向量化输入', () => {
  it('片段：事件名当关键词；归档：概括 + 非空详细记录', () => {
    expect(storySegmentEmbeddingText(segments[0])).toBe('[订剑] 铁匠答应三天后交剑，定金十枚银币');
    expect(storySegmentEmbeddingText(segments[1])).toBe('[] 老板娘说北边有狼');
    expect(storyArchiveEmbeddingText(archive)).toBe(
      '[订剑] 向铁匠订剑并按期取到\n需要武器\n付定金，三天后取剑\n取到剑\n三天交剑，定金十枚银币',
    );
  });
});

// A11：来自临时验收的同回合远距离片段场景，保留为长期回归。
function disjointFixture() {
  const paragraphs = [
    'Opening.',
    'Alpha forge silver sword deposit agreement: exact amount 17 coins.',
    'The fireplace flickers.',
    'Clouds cover the street.',
    'A distant bell rings.',
    'Footsteps fade away.',
    'Rain taps on the window.',
    'The lantern is lit.',
    'A carriage arrives.',
    'Beta herbal medicine delivery deadline promise: exact time Friday 21:30.',
    'Everyone says goodbye.',
  ];
  const messages = [
    msg('u1', 'user', 'Discuss the arrangements.'),
    msg('a1', 'assistant', paragraphs.join('\n')),
    msg('u2', 'user', 'Leave.'),
    msg('a2', 'assistant', 'You leave town.'),
  ];
  const source = storyTurnSource(collectCompleteStoryTurns(messages)[0]);
  const segments = [
    'Alpha forge silver sword deposit agreement',
    'Beta herbal medicine delivery deadline promise',
  ].map((content, order) => ({
    ...source,
    id: 's' + order,
    saveId: 'recall-audit',
    order,
    content,
    createdAt: 1,
  }));
  const base = { messages, segments, archives: [], windowTurns: 1 };
  return {
    base,
    candidates: buildStoryRecallCandidates(base),
    probe: buildStoryRecallQuery({ messages, userInput: 'Check both arrangements.' }),
    paragraphs,
  };
}

describe('A11 同回合不同原文片段合并去重', () => {
  it.each([false, true])('两种候选顺序均保留押金与期限（reverse=%s）', (reverse) => {
    const { base, candidates, probe, paragraphs } = disjointFixture();
    const selected = reverse ? [...candidates].reverse() : candidates;
    const out = expandStoryRecall({ ...base, selected, probe, rawMode: 'snippet' });
    expect(out.text).toContain('17 coins');
    expect(out.text).toContain('Friday 21:30');
    expect(out.text.split(paragraphs[1])).toHaveLength(2);
    expect(out.text.split(paragraphs[9])).toHaveLength(2);
    expect(out.text).not.toContain('原文见前文');
    expect(out.diagnostics.rawTurnKeys).toEqual(['u1']);
    expect(out.diagnostics.omittedTurnKeys).toEqual([]);
    expect(
      out.diagnostics.paragraphRanges?.map((r) => [r.start, r.end]).sort((a, b) => a[0] - b[0]),
    ).toEqual([
      [0, 2],
      [8, 10],
    ]);
  });

  it('重叠范围只输出尚未出现的原文段落，全部已展示才可引用前文', () => {
    const { base, candidates } = disjointFixture();
    const first = candidates[0];
    const second = { ...first, ref: 'S3', text: 'The fireplace flickers.' };
    const out = expandStoryRecall({
      ...base,
      selected: [first, second, second],
      probe: '',
      rawMode: 'snippet',
    });
    expect(out.text.split('The fireplace flickers.')).toHaveLength(2);
    expect(out.text).toContain('Clouds cover the street.');
    expect(out.diagnostics.paragraphRanges?.map((r) => [r.start, r.end])).toEqual([
      [0, 2],
      [3, 3],
    ]);
    expect(out.text.match(/原文见前文/g)).toHaveLength(1);
  });

  it('同回合后选的不同原文超预算须明确省略，不能谎称前文已展示', () => {
    const { base, candidates, probe } = disjointFixture();
    const first = expandStoryRecall({
      ...base,
      selected: [candidates[0]],
      probe,
      rawMode: 'snippet',
    });
    const out = expandStoryRecall({
      ...base,
      selected: candidates,
      probe,
      rawMode: 'snippet',
      rawCharBudget: first.diagnostics.rawChars,
    });
    expect(out.text).toContain('17 coins');
    expect(out.text).not.toContain('Friday 21:30');
    expect(out.text).toContain('原文因本轮篇幅上限省略');
    expect(out.text).not.toContain('原文见前文');
    expect(
      out.diagnostics.paragraphRanges?.[out.diagnostics.paragraphRanges.length - 1],
    ).toMatchObject({
      ref: 'S2',
      turnKey: 'u1',
      start: 8,
      end: 10,
      omitted: true,
    });
    expect(out.diagnostics.rawChars).toBe(first.diagnostics.rawChars);
  });
});

describe('A12 实体与时间定位', () => {
  const time = { era: '纪元', year: 1, month: 2, day: 3, weekday: 1, hour: 21, minute: 30 };
  it('候选与向量输入包含实体和原回合时间，不猜补缺失字段', () => {
    const segment = {
      ...segments[0],
      characters: ['铁匠'],
      locations: ['北城'],
      topics: ['订剑'],
      gameTimeRange: { start: time, end: null },
    };
    const candidates = buildStoryRecallCandidates({ ...base, segments: [segment], archives: [] });
    expect(candidates[0].text).toContain('人物：铁匠；地点：北城；主题：订剑；时间：');
    expect(candidates[0].text).toContain('21:30 — 未知');
    expect(storySegmentEmbeddingText(segment)).toContain('地点：北城');
    expect(storySegmentEmbeddingText(segments[0])).not.toContain('时间：');
  });

  it('查询只使用最近完整回合有效摘要的定位字段；旧无指纹/正文修订不泄入查询', () => {
    const recent = {
      ...seg('s5', 5, '天色渐暗'),
      characters: ['旅伴'],
      locations: ['林间'],
      topics: ['旅行'],
      gameTimeRange: { start: time, end: time },
    };
    const query = buildStoryRecallQuery({
      userInput: '继续',
      messages,
      segments: [recent, { ...segments[0], characters: ['旧城人物'] }],
    });
    expect(query).toContain('上回合定位：人物：旅伴；地点：林间；主题：旅行；时间：');
    expect(query).not.toContain('旧城人物');
    expect(
      buildStoryRecallQuery({
        userInput: '继续',
        messages,
        segments: [{ ...recent, sourceFingerprint: undefined }],
      }),
    ).not.toContain('旅伴');
    expect(
      buildStoryRecallCandidates({
        ...base,
        segments: [{ ...segments[0], sourceFingerprint: undefined }],
        archives: [],
      }),
    ).toEqual([]);
  });
});

describe('共享归档 coverage 读取契约', () => {
  it('同 ID 摘要语义改写或缺覆盖摘要时，旧归档不进入候选且不再承接摘要', () => {
    const rewritten = { ...segments[0], content: '同ID新摘要' };
    const candidates = buildStoryRecallCandidates({
      ...base,
      segments: [rewritten, ...segments.slice(1)],
    });
    expect(candidates.some((c) => c.kind === 'archive')).toBe(false);
    expect(candidates.find((c) => c.kind === 'segment' && c.segment.id === 's1')).toMatchObject({
      archived: false,
    });
    expect(buildStoryRecallCandidates({ ...base, segments: [] })).toEqual([]);
  });
});
