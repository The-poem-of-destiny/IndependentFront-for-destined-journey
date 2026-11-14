/**
 * memory-context.test.ts — Story 上下文新模式第 4 区（计划 §3.2，T11–T15/T55）。
 */
import { describe, it, expect } from 'vitest';
import {
  storySegmentFingerprint,
  storyTurnSource,
} from '../../../src/core/memory/story-memory-source';
import type { ChatMessage, StoryArchiveRecord } from '../../../src/core/types/types';
import {
  buildStoryZone4,
  collectCompleteStoryTurns,
  collectOpenStoryEvents,
  findStoryTurnsMissingSummary,
  resolveActiveStoryArchives,
  resolveAppliedStoryArchives,
  storyWindowStart,
  type StoryTurnSummarySegment,
} from '../../../src/core/memory/memory-context';

describe('findStoryTurnsMissingSummary（摘要补建的缺口）', () => {
  it('只列一条有效片段都没有的回合；来源失效的片段不算', () => {
    const history = [
      { id: 'u1', role: 'user' as const, content: '1', timestamp: 1 },
      { id: 'a1', role: 'assistant' as const, content: '一', timestamp: 2 },
      { id: 'u2', role: 'user' as const, content: '2', timestamp: 3 },
      { id: 'a2', role: 'assistant' as const, content: '二', timestamp: 4 },
      { id: 'u3', role: 'user' as const, content: '3', timestamp: 5 },
      { id: 'a3', role: 'assistant' as const, content: '三', timestamp: 6 },
    ];
    const segments: StoryTurnSummarySegment[] = [
      {
        id: 's2',
        ...storyTurnSource(collectCompleteStoryTurns(history)[1]),
        order: 0,
        content: '二',
      },
      // 重生成前的旧片段：来源 id 对不上 → 不算
      { id: 's3', sourceTurnKey: 'u3', order: 0, content: '三', sourceMessageIds: ['u3', 'old'] },
    ];
    expect(findStoryTurnsMissingSummary(history, segments).map((t) => t.key)).toEqual(['u1', 'u3']);
  });
});

let seq = 0;
function msg(role: ChatMessage['role'], content: string, id = `m${++seq}`): ChatMessage {
  return { id, role, content, timestamp: seq };
}

/** n 个完整回合：u1/a1 … un/an，用户消息 id = `u{i}` */
function turns(n: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 1; i <= n; i++) {
    out.push(msg('user', `输入${i}`, `u${i}`), msg('assistant', `正文${i}`, `a${i}`));
  }
  return out;
}

function summariesOf(zone: ReturnType<typeof buildStoryZone4>): StoryTurnSummarySegment[] {
  return zone.history.flatMap((h) => (h.kind === 'summary' ? [h.segment] : []));
}

function seg(turnKey: string, order = 0, id = `s-${turnKey}-${order}`): StoryTurnSummarySegment {
  const turn = collectCompleteStoryTurns(turns(Number(turnKey.slice(1)) || 1)).find(
    (t) => t.key === turnKey,
  );
  return {
    id,
    ...(turn ? storyTurnSource(turn) : { sourceTurnKey: turnKey }),
    order,
    content: `摘要 ${turnKey}#${order}`,
  };
}

describe('collectCompleteStoryTurns', () => {
  it('系统卡片不占回合，缺 Story 正文的回合不算完整回合', () => {
    const messages = [
      msg('user', '输入1', 'u1'),
      msg('system', '制作卡片'),
      msg('assistant', '正文1', 'a1'),
      msg('system', '角色卡片'),
      msg('user', '失败的输入', 'u-failed'),
      msg('user', '输入2', 'u2'),
      msg('assistant', '正文2', 'a2'),
      msg('user', '本轮未完成', 'u-pending'),
    ];
    const result = collectCompleteStoryTurns(messages);
    expect(result.map((t) => t.key)).toEqual(['u1', 'u2']);
    expect(result[0].storyMessages.map((m) => m.id)).toEqual(['a1']);
  });

  it('没有玩家输入的开场回合以第一条 Story 正文为 key', () => {
    const result = collectCompleteStoryTurns([msg('assistant', '开场', 'a0'), ...turns(1)]);
    expect(result.map((t) => t.key)).toEqual(['a0', 'u1']);
    expect(result[0].userMessage).toBeUndefined();
  });
});

describe('buildStoryZone4', () => {
  it('计划 §3.2 例：N=4、第 1–18 回合已归档 → 第 19–26 回合摘要 + 第 27–30 回合原文', () => {
    const segments = Array.from({ length: 30 }, (_, i) => seg(`u${i + 1}`));
    const archived = new Set(segments.slice(0, 18).map((s) => s.id));
    const zone = buildStoryZone4({
      messages: turns(30),
      windowTurns: 4,
      segments,
      archivedSegmentIds: archived,
    });
    expect(summariesOf(zone).map((s) => s.sourceTurnKey)).toEqual(
      Array.from({ length: 8 }, (_, i) => `u${i + 19}`),
    );
    expect(zone.windowTurns.map((t) => t.key)).toEqual(['u27', 'u28', 'u29', 'u30']);
    expect(zone.missingSummaryTurns.map((t) => t.key)).toEqual([]);
  });

  it('更早的未归档片段同样常驻（第 12 回合残留片段必须显示）', () => {
    const segments = [
      ...Array.from({ length: 18 }, (_, i) => seg(`u${i + 1}`)),
      seg('u12', 1),
      ...Array.from({ length: 12 }, (_, i) => seg(`u${i + 19}`)),
    ];
    const archived = new Set(
      segments
        .filter((s) => Number(s.sourceTurnKey.slice(1)) <= 18 && s.order === 0)
        .map((s) => s.id),
    );
    const zone = buildStoryZone4({
      messages: turns(30),
      windowTurns: 4,
      segments,
      archivedSegmentIds: archived,
    });
    expect(summariesOf(zone)[0]).toMatchObject({ sourceTurnKey: 'u12', order: 1 });
    expect(summariesOf(zone)).toHaveLength(9);
  });

  it('窗口内只给原文，不重复注入已生成的摘要（T12/T55）', () => {
    const zone = buildStoryZone4({
      messages: turns(3),
      windowTurns: 3,
      segments: [seg('u1'), seg('u2'), seg('u3')],
      archivedSegmentIds: new Set(),
    });
    expect(summariesOf(zone)).toEqual([]);
    expect(zone.windowTurns).toHaveLength(3);
  });

  it('窗口外未归档摘要全部保留，没有数量上限（T13）', () => {
    const segments = Array.from({ length: 200 }, (_, i) => seg(`u${i + 1}`));
    const zone = buildStoryZone4({
      messages: turns(201),
      windowTurns: 1,
      segments,
      archivedSegmentIds: new Set(),
    });
    expect(summariesOf(zone)).toHaveLength(200);
  });

  it('同回合两个事件只归档一个时，未结束片段继续显示（T15）', () => {
    const zone = buildStoryZone4({
      messages: turns(2),
      windowTurns: 1,
      segments: [seg('u1', 1, 'relation'), seg('u1', 0, 'quest')],
      archivedSegmentIds: new Set(['quest']),
    });
    expect(summariesOf(zone).map((s) => s.id)).toEqual(['relation']);
  });

  it('窗口外回合一条摘要都没有时列为缺口，被归档完整覆盖的不算缺口', () => {
    const zone = buildStoryZone4({
      messages: turns(4),
      windowTurns: 1,
      segments: [seg('u1'), seg('u3')],
      archivedSegmentIds: new Set(['s-u1-0']),
    });
    expect(zone.missingSummaryTurns.map((t) => t.key)).toEqual(['u2']);
    expect(summariesOf(zone).map((s) => s.sourceTurnKey)).toEqual(['u3']);
  });

  it('来源不在当前消息集合里的片段（被回退/重生成替换的分支）不参与上下文', () => {
    const zone = buildStoryZone4({
      messages: turns(3),
      windowTurns: 1,
      segments: [seg('u1'), seg('u2'), seg('u-gone')],
      archivedSegmentIds: new Set(),
    });
    expect(summariesOf(zone).map((s) => s.sourceTurnKey)).toEqual(['u1', 'u2']);
  });

  it('缺摘要的回合按时间顺序以原文形式出现在历史里', () => {
    const zone = buildStoryZone4({
      messages: turns(3),
      windowTurns: 1,
      segments: [seg('u2')],
      archivedSegmentIds: new Set(),
    });
    expect(zone.history.map((h) => (h.kind === 'summary' ? h.segment.id : h.turn.key))).toEqual([
      'u1',
      's-u2-0',
    ]);
  });

  it('来源消息 id 对不上（同回合被重生成换了正文）的片段失效（§7.3）', () => {
    const zone = buildStoryZone4({
      messages: turns(2),
      windowTurns: 1,
      segments: [{ ...seg('u1'), sourceMessageIds: ['u1', 'a1-old'] }],
      archivedSegmentIds: new Set(),
    });
    expect(summariesOf(zone)).toEqual([]);
    expect(zone.missingSummaryTurns.map((t) => t.key)).toEqual(['u1']);
  });

  it('来源消息 id 一致的片段有效', () => {
    const zone = buildStoryZone4({
      messages: turns(2),
      windowTurns: 1,
      segments: [{ ...seg('u1'), sourceMessageIds: ['u1', 'a1'] }],
      archivedSegmentIds: new Set(),
    });
    expect(summariesOf(zone).map((s) => s.id)).toEqual(['s-u1-0']);
  });

  it('N 非正整数（含 N=0）直接抛错（T44）', () => {
    for (const n of [0, -1, 2.5]) {
      expect(() =>
        buildStoryZone4({
          messages: turns(2),
          windowTurns: n,
          segments: [],
          archivedSegmentIds: new Set(),
        }),
      ).toThrow(RangeError);
    }
  });
});

describe('storyWindowStart（分批换窗起点）', () => {
  it('K = 1 时对所有 T 都等于 max(0, T - N)', () => {
    for (const n of [1, 3, 6]) {
      for (let t = 0; t <= 20; t++) {
        expect(storyWindowStart(t, n, 1)).toBe(Math.max(0, t - n));
        expect(storyWindowStart(t, n)).toBe(Math.max(0, t - n));
      }
    }
  });

  it('N = 6、K = 6 时窗口在 6–11 回合之间循环（计划 §3.1 表）', () => {
    const expected: Array<[number, number]> = [
      [1, 0],
      [6, 0],
      [7, 0],
      [11, 0],
      [12, 6],
      [13, 6],
      [17, 6],
      [18, 12],
    ];
    for (const [t, start] of expected) expect(storyWindowStart(t, 6, 6)).toBe(start);
  });

  it('T ≤ N 时为 0', () => {
    for (let t = 0; t <= 4; t++) expect(storyWindowStart(t, 4, 3)).toBe(0);
  });

  it('buildStoryZone4 按 K 成批换窗，并返回窗口起点', () => {
    const zone = buildStoryZone4({
      messages: turns(9),
      windowTurns: 2,
      windowBatchTurns: 3,
      segments: [],
      archivedSegmentIds: new Set(),
    });
    expect(zone.windowStart).toBe(6);
    expect(zone.windowTurns.map((t) => t.key)).toEqual(['u7', 'u8', 'u9']);
  });

  it('K 非正整数直接抛错', () => {
    for (const k of [0, -1, 1.5]) {
      expect(() =>
        buildStoryZone4({
          messages: turns(2),
          windowTurns: 1,
          windowBatchTurns: k,
          segments: [],
          archivedSegmentIds: new Set(),
        }),
      ).toThrow(RangeError);
    }
  });
});

describe('resolveAppliedStoryArchives（归档与换窗对齐）', () => {
  /** 5 个回合；第 1 回合片段带事件名，第 3 回合作出归档判断并覆盖它 */
  const history = turns(5);
  const historyTurns = collectCompleteStoryTurns(history);
  const eventSeg: StoryTurnSummarySegment = { ...seg('u1'), eventName: '订剑' };
  const archive: StoryArchiveRecord = {
    id: 'ar1',
    saveId: 's',
    eventName: '订剑',
    outcome: 'completed',
    evidence: '正文3',
    overview: '订剑并取到',
    detail: { cause: '', process: '', ending: '', promises: '', impact: '' },
    detailSource: 'summary',
    coveredSegmentIds: [eventSeg.id],
    ...storyTurnSource(historyTurns[2]),
    coveredSources: [storyTurnSource(historyTurns[0])],
    coveredSegmentFingerprints: { [eventSeg.id]: storySegmentFingerprint(eventSeg) },
    sequence: 0,
    createdAt: 3,
  };
  const active = resolveActiveStoryArchives(history, [archive], [eventSeg]);

  it('K = 1 时原样返回全部有效归档', () => {
    expect(active).toHaveLength(1);
    expect(resolveAppliedStoryArchives(historyTurns, active, 0, 1)).toEqual(active);
  });

  it('K > 1 时判断回合仍在窗口内的归档不生效，换出窗口后生效', () => {
    // 判断回合下标 2：窗口起点 2 时仍在窗口内，起点 3 时已换出
    expect(resolveAppliedStoryArchives(historyTurns, active, 2, 2)).toEqual([]);
    expect(resolveAppliedStoryArchives(historyTurns, active, 3, 3)).toEqual(active);
  });

  it('collectOpenStoryEvents 不受 K 影响：已归档、尚未生效的事件不出现在未结事件里', () => {
    expect(collectOpenStoryEvents(history, [eventSeg], [archive])).toEqual([]);
  });
});
