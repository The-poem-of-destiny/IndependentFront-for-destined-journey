import { describe, it, expect } from 'vitest';
import type { PlotEvent } from '@engine/types';
import { toEpochMinutes } from '@engine/time-system';
import { buildPlotTimeline } from './plot-timeline';
import type { ThreadDisplayNode, ThreadDisplayView } from './plot-thread-view';

/** 默认 depth=1（关键事件 → 落轴节点） */
function ev(over: Partial<PlotEvent> & { id: string; title: string }): PlotEvent {
  return {
    saveId: 's1',
    description: '',
    status: 'pending',
    childrenIds: [],
    order: 0,
    relatedCharacterIds: [],
    worldLineChanged: false,
    visibility: 'revealed',
    depth: 1,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  };
}

/** depth=0 章节容器（定义章节条） */
function chapter(title: string, order: number): PlotEvent {
  return ev({ id: 'ch-' + title, title, chapterTitle: title, depth: 0, order });
}

function node(over: Partial<ThreadDisplayNode> & { name: string }): ThreadDisplayNode {
  return {
    gist: '',
    thread: '主线',
    motive: '',
    involvedNpcs: [],
    status: 'active',
    visibility: 'revealed',
    seededAt: 0,
    foreshadows: [],
    payoffs: [],
    masked: false,
    ...over,
  };
}

function viewOf(
  nodes: ThreadDisplayNode[],
  edges: ThreadDisplayView['edges'] = [],
): ThreadDisplayView {
  return {
    groups: [{ thread: '主线', showLabel: true, nodes }],
    edges,
    totalCount: nodes.length,
    visibleCount: nodes.filter((n) => !n.masked).length,
    hiddenCount: nodes.filter((n) => n.masked).length,
  };
}

/** 游戏日的 epoch minutes（取该日 00:00） */
function day(year: number, month: number, d: number): number {
  return toEpochMinutes({ era: '', year, month, day: d, weekday: 1, hour: 0, minute: 0 });
}

describe('buildPlotTimeline — x ∝ 游戏天', () => {
  it('不同日期的事件按 (day-minDay)*pxPerDay 铺开；章节条按时长横跨', () => {
    const model = buildPlotTimeline({
      events: [
        chapter('第一章', 0),
        ev({
          id: 'e1',
          title: '一月事件',
          chapterTitle: '第一章',
          timeWindow: { start: '488-01', end: '488-01' },
        }),
        ev({
          id: 'e2',
          title: '三月事件',
          chapterTitle: '第一章',
          timeWindow: { start: '488-03', end: '488-03' },
        }),
      ],
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    expect(model.counts.outline).toBe(2);
    const e1 = model.nodes.find((n) => n.id === 'e1')!;
    const e2 = model.nodes.find((n) => n.id === 'e2')!;
    // 相隔 2 个月 = 60 天 → x 差 = 60 * 10
    expect(e2.x - e1.x).toBe(60 * 10);
    // 章节条从 e1 起、覆盖到 e2 的右缘
    expect(model.chapters).toHaveLength(1);
    expect(model.chapters[0].x).toBe(e1.x);
    expect(model.chapters[0].w).toBeGreaterThan(e2.x - e1.x);
  });

  it('放大 pxPerDay → 同一天的节点 x 间距按比例变大', () => {
    const events = [
      ev({ id: 'e1', title: 'A', timeWindow: { start: '488-01', end: '488-01' } }),
      ev({ id: 'e2', title: 'B', timeWindow: { start: '488-02', end: '488-02' } }),
    ];
    const small = buildPlotTimeline({
      events,
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 5,
    });
    const big = buildPlotTimeline({
      events,
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 20,
    });
    const d = (m: typeof small) =>
      m.nodes.find((n) => n.id === 'e2')!.x - m.nodes.find((n) => n.id === 'e1')!.x;
    expect(d(big)).toBe(d(small) * 4);
  });

  it('无 timeWindow 的关键事件进最左「未定时间」竖条', () => {
    const model = buildPlotTimeline({
      events: [ev({ id: 'e1', title: '没时间' })],
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    expect(model.unknownStripW).toBeGreaterThan(0);
    const n = model.nodes.find((x) => x.id === 'e1')!;
    expect(n.day).toBeNull();
    expect(n.x).toBeLessThan(model.unknownStripW + model.anchor.startX);
  });
});

describe('buildPlotTimeline — 时间标尺', () => {
  it('有日期时产出刻度；缩放越大刻度越密（步长变小）', () => {
    const events = [
      ev({ id: 'e1', title: 'A', timeWindow: { start: '488-01', end: '488-01' } }),
      ev({ id: 'e2', title: 'B', timeWindow: { start: '488-06', end: '488-06' } }),
    ];
    const small = buildPlotTimeline({
      events,
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 4,
    });
    const big = buildPlotTimeline({
      events,
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 60,
    });
    expect(small.rulerTicks.length).toBeGreaterThan(0);
    expect(big.rulerTicks.length).toBeGreaterThan(small.rulerTicks.length);
  });
});

describe('buildPlotTimeline — 同时间纵向分道', () => {
  it('同一游戏日的两个节点落在同列、不同 y（不重叠）', () => {
    const model = buildPlotTimeline({
      events: [],
      threadView: viewOf([
        node({ name: 'A', seededAt: day(488, 2, 1) }),
        node({ name: 'B', seededAt: day(488, 2, 1) }),
      ]),
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    const a = model.nodes.find((n) => n.id === 'A')!;
    const b = model.nodes.find((n) => n.id === 'B')!;
    expect(a.x).toBe(b.x);
    expect(a.y).not.toBe(b.y);
  });
});

describe('buildPlotTimeline — 防剧透', () => {
  it('蒙版节点名字不进输出；不可见端点的边整条不画', () => {
    const model = buildPlotTimeline({
      events: [],
      threadView: viewOf(
        [node({ name: '明线节点', masked: false }), node({ name: '暗线节点', masked: true })],
        [{ from: '明线节点', to: '暗线节点', masked: true }],
      ),
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    const hidden = model.nodes.find((n) => n.id === '暗线节点')!;
    expect(hidden.masked).toBe(true);
    expect(hidden.title).toBe('');
    expect(hidden.summary).toBe('');
    expect(model.edges).toHaveLength(0);
    expect(model.counts.masked).toBe(1);
  });

  it('大纲事件 visibility=hidden 也蒙版，peek 后揭示', () => {
    const hiddenEv = ev({ id: 'e1', title: '隐藏事件', visibility: 'hidden' });
    const masked = buildPlotTimeline({
      events: [hiddenEv],
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    expect(masked.nodes[0].masked).toBe(true);
    expect(masked.nodes[0].title).toBe('');

    const peeked = buildPlotTimeline({
      events: [hiddenEv],
      threadView: null,
      nowEpochMinutes: null,
      peekedEventIds: new Set(['e1']),
      pxPerDay: 10,
    });
    expect(peeked.nodes[0].masked).toBe(false);
    expect(peeked.nodes[0].title).toBe('隐藏事件');
  });
});

describe('buildPlotTimeline — 连线（ComfyUI 式）', () => {
  it('章节条 → 关键事件画一条曲线；事件蒙版则整条不画', () => {
    const base = [
      chapter('第一章', 0),
      ev({
        id: 'e1',
        title: '关键事件',
        chapterTitle: '第一章',
        parentId: 'ch-第一章',
        timeWindow: { start: '488-01', end: '488-02' },
      }),
    ];
    const model = buildPlotTimeline({
      events: base,
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0].kind).toBe('outline');
    expect(model.edges[0].d.length).toBeGreaterThan(0);

    const masked = buildPlotTimeline({
      events: [base[0], { ...base[1], visibility: 'hidden' }],
      threadView: null,
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    expect(masked.edges).toHaveLength(0);
  });

  it('事件线伏笔边两端可见时画曲线', () => {
    const model = buildPlotTimeline({
      events: [],
      threadView: viewOf(
        [node({ name: 'A' }), node({ name: 'B', seededAt: day(488, 2, 1) })],
        [{ from: 'A', to: 'B', masked: false }],
      ),
      nowEpochMinutes: null,
      pxPerDay: 10,
    });
    expect(model.edges).toHaveLength(1);
    expect(model.edges[0].kind).toBe('thread');
  });
});

describe('buildPlotTimeline — 现在游标', () => {
  it('当前时间落在两列之间时游标 x 也按比例落在两者之间', () => {
    const model = buildPlotTimeline({
      events: [
        ev({ id: 'e1', title: '一月', timeWindow: { start: '488-01', end: '488-01' } }),
        ev({ id: 'e2', title: '三月', timeWindow: { start: '488-03', end: '488-03' } }),
      ],
      threadView: null,
      nowEpochMinutes: day(488, 2, 1),
      pxPerDay: 10,
    });
    const e1 = model.nodes.find((n) => n.id === 'e1')!;
    const e2 = model.nodes.find((n) => n.id === 'e2')!;
    expect(model.nowX).not.toBeNull();
    expect(model.nowX!).toBeGreaterThan(e1.x);
    expect(model.nowX!).toBeLessThan(e2.x);
  });
});
