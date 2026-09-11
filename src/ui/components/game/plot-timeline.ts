/**
 * plot-timeline.ts — 剧情时间线的布局模型（纯函数，不 mount 可测）
 *
 * 一块**横向可按天缩放**的长画布：
 *   - **x = 游戏时间**（天为粒度，`pxPerDay` 由缩放控件给）：`x = startX + (day - minDay) * pxPerDay`。
 *   - **顶部章节条**：depth 0 章节按其关键事件的时间跨度横跨一段，章节名居中；重叠的章节分多行。
 *   - **节点**：大纲关键事件 + 事件线节点落在各自那一天；横向会撞的按贪心分道纵向堆叠。
 *   - **连线（ComfyUI 式曲线）**：章节条 → 它的关键事件；父事件 → 子事件；事件线伏笔/回收。
 *   - **时间标尺**：刻度密度随缩放自动选（日 / 月 / 年）。
 *   - 无 `timeWindow` 的节点进最左「未定时间」竖条（不丢、也不假装有日期）。
 *
 * 🔴 防剧透：蒙版节点的名字不进任何输出字段（title/subtitle 置空）；边只要一端蒙版就整条丢弃 ——
 *    与 `plot-thread-view.ts` 的四重遮蔽同口径。
 */
import type { PlotEvent } from '@engine/types';
import { fromEpochMinutes, parseMonthTime, toGameDay } from '@engine/time-system';
import type { ThreadDisplayView } from './plot-thread-view';
import { threadStatusLabel } from './plot-thread-view';

// ── 布局常量（px；画布几何，非主题间距）──
const RULER_H = 34;
const CHAPTER_H = 26;
const CHAPTER_ROW_GAP = 8;
const CHAPTER_MIN_W = 76;
const NODE_W = 220;
const NODE_H = 76;
const LANE_GAP = 12;
const BAND_GAP = 48;
const PAD_X = 28;
const PAD_BOTTOM = 28;
const MIN_PER_DAY = 1440; // 与 time-system 的 toGameDay 同一常量（那边未导出）
const OTHER_LANE = '其他';
const UNKNOWN_STRIP_W = NODE_W + 28;

/** 大纲事件状态中文标签（时间线内唯一映射；列表视图 PlotPanel 复用本表） */
export const OUTLINE_STATUS_LABELS: Record<string, string> = {
  active: '活跃',
  pending: '待触发',
  completed: '已完成',
  failed: '失败',
  skipped: '已跳过',
};

export interface TimelineNodeBox {
  kind: 'outline' | 'thread';
  /** 大纲事件 id / 事件线节点名 —— 仅作 :key 与连线路由，不渲染为文字 */
  id: string;
  /** 蒙版节点为空串 */
  title: string;
  /** 一行摘要（大纲 = description；事件线 = gist）；蒙版为空串 */
  summary: string;
  status: string;
  statusLabel: string;
  masked: boolean;
  /** 所属游戏日；null = 未定时间 */
  day: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TimelineChapterBar {
  name: string;
  x: number;
  w: number;
  y: number;
}

interface TimelineRulerTick {
  x: number;
  label: string;
  major: boolean;
}

interface TimelineEdgeBox {
  kind: 'outline' | 'thread';
  d: string;
}

interface TimelineBand {
  top: number;
  height: number;
}

export interface PlotTimelineModel {
  width: number;
  height: number;
  rulerTicks: TimelineRulerTick[];
  rulerHeight: number;
  chapters: TimelineChapterBar[];
  nodes: TimelineNodeBox[];
  edges: TimelineEdgeBox[];
  bands: { outline: TimelineBand; thread: TimelineBand };
  /** 「现在」游标的 x；null = 无当前时间 */
  nowX: number | null;
  /** 最左「未定时间」竖条右缘（>0 表示有未定节点）；供组件画分隔与标签 */
  unknownStripW: number;
  /** x↔day 映射锚点（缩放时保持视口中心用） */
  anchor: { startX: number; minDay: number; pxPerDay: number };
  isEmpty: boolean;
  counts: { outline: number; thread: number; masked: number };
}

export interface PlotTimelineInput {
  events: readonly PlotEvent[];
  threadView: ThreadDisplayView | null;
  nowEpochMinutes: number | null;
  peekedEventIds?: ReadonlySet<string>;
  /** 每天占多少像素（缩放控件给的，>0） */
  pxPerDay: number;
}

interface RawNode {
  kind: 'outline' | 'thread';
  id: string;
  title: string;
  summary: string;
  status: string;
  statusLabel: string;
  masked: boolean;
  day: number | null;
  /** 大纲 = 章节名；事件线 = thread 锚 */
  lane: string;
  x: number;
}

/** 大纲事件时间窗起点（年-月）→ 该月首日的游戏日；无/坏格式 → null */
function outlineEventDay(ev: PlotEvent): number | null {
  const start = ev.timeWindow?.start;
  if (!start) return null;
  const mt = parseMonthTime(start);
  if (!mt) return null;
  return toGameDay({
    era: '',
    year: mt.year,
    month: mt.month,
    day: 1,
    weekday: 1,
    hour: 0,
    minute: 0,
  });
}

function shortDate(day: number): { y: number; m: number; d: number } {
  const t = fromEpochMinutes(day * MIN_PER_DAY);
  return { y: t.year, m: t.month, d: t.day };
}

/** 时间标尺：按缩放选刻度步长，对齐到步长倍数 */
function buildRuler(
  minDay: number,
  maxDay: number,
  startX: number,
  pxPerDay: number,
): TimelineRulerTick[] {
  const steps: Array<{ d: number; mode: 'day' | 'month' | 'year' }> = [
    { d: 1, mode: 'day' },
    { d: 2, mode: 'day' },
    { d: 3, mode: 'day' },
    { d: 5, mode: 'day' },
    { d: 10, mode: 'day' },
    { d: 15, mode: 'day' },
    { d: 30, mode: 'month' },
    { d: 90, mode: 'month' },
    { d: 180, mode: 'month' },
    { d: 360, mode: 'year' },
    { d: 720, mode: 'year' },
  ];
  const chosen = steps.find((s) => s.d * pxPerDay >= 72) ?? steps[steps.length - 1];
  const pad2 = (n: number) => String(n).padStart(2, '0');
  const ticks: TimelineRulerTick[] = [];
  const first = Math.ceil(minDay / chosen.d) * chosen.d;
  for (let day = first; day <= maxDay; day += chosen.d) {
    const { y, m, d } = shortDate(day);
    const label =
      chosen.mode === 'year'
        ? `${y}`
        : chosen.mode === 'month'
          ? `${y}-${pad2(m)}`
          : `${y}-${pad2(m)}-${pad2(d)}`;
    ticks.push({ x: startX + (day - minDay) * pxPerDay, label, major: chosen.mode !== 'day' });
  }
  return ticks;
}

/** 贪心分道：按 x 升序，放进第一条不重叠的道；返回每个节点的 y 偏移道号 */
function packLanesByX(nodes: { x: number }[]): { lane: number; lanes: number }[] {
  const laneEnds: number[] = [];
  const out: { lane: number; lanes: number }[] = [];
  for (const n of nodes) {
    let lane = laneEnds.findIndex((end) => end + LANE_GAP <= n.x);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(n.x + NODE_W);
    } else {
      laneEnds[lane] = n.x + NODE_W;
    }
    out.push({ lane, lanes: laneEnds.length });
  }
  return out;
}

/** 章节条分多行：重叠的章节错开 */
function packChapterRows(bars: TimelineChapterBar[]): number {
  const rowEnds: number[] = [];
  for (const b of bars) {
    let row = rowEnds.findIndex((end) => end + CHAPTER_ROW_GAP <= b.x);
    if (row === -1) {
      row = rowEnds.length;
      rowEnds.push(b.x + b.w);
    } else {
      rowEnds[row] = b.x + b.w;
    }
    b.y = row;
  }
  return rowEnds.length;
}

function edgeCurve(sx: number, sy: number, tx: number, ty: number, horizontal: boolean): string {
  if (horizontal) {
    if (Math.abs(tx - sx) < 1) {
      return `M ${sx} ${sy} C ${sx} ${sy + 16}, ${tx} ${ty - 16}, ${tx} ${ty}`;
    }
    const dy = Math.sign(ty - sy) * Math.max(18, Math.abs(ty - sy) * 0.5);
    return `M ${sx} ${sy} C ${sx} ${sy + dy}, ${tx} ${ty - dy}, ${tx} ${ty}`;
  }
  if (Math.abs(tx - sx) < 1) {
    return `M ${sx} ${sy} C ${sx} ${sy + 16}, ${tx} ${ty - 16}, ${tx} ${ty}`;
  }
  const mx = (sx + tx) / 2;
  return `M ${sx} ${sy} C ${mx} ${sy}, ${mx} ${ty}, ${tx} ${ty}`;
}

/** 构建时间线布局模型 */
export function buildPlotTimeline(input: PlotTimelineInput): PlotTimelineModel {
  const pxPerDay = Math.max(1, input.pxPerDay);
  const peeked = input.peekedEventIds ?? new Set<string>();

  // ── 收集要点：章节定义 + 原始节点 ──
  const chapters: Array<{ name: string; order: number }> = [];
  const seenChapter = new Set<string>();
  for (const ev of [...input.events]
    .filter((e) => e.depth === 0)
    .sort((a, b) => a.order - b.order)) {
    const name = ev.chapterTitle || ev.title || OTHER_LANE;
    if (!seenChapter.has(name)) {
      seenChapter.add(name);
      chapters.push({ name, order: ev.order });
    }
  }

  const raw: RawNode[] = [];
  for (const ev of input.events) {
    if (ev.depth === 0) continue;
    const masked = ev.visibility !== 'revealed' && !peeked.has(ev.id);
    raw.push({
      kind: 'outline',
      id: ev.id,
      title: masked ? '' : ev.title,
      summary: masked ? '' : ev.description,
      status: ev.status,
      statusLabel: OUTLINE_STATUS_LABELS[ev.status] ?? ev.status,
      masked,
      day: outlineEventDay(ev),
      lane: ev.chapterTitle || OTHER_LANE,
      x: 0,
    });
  }
  if (input.threadView) {
    for (const group of input.threadView.groups) {
      for (const node of group.nodes) {
        raw.push({
          kind: 'thread',
          id: node.name,
          title: node.masked ? '' : node.name,
          summary: node.masked ? '' : node.gist,
          status: node.status,
          statusLabel: threadStatusLabel(node.status),
          masked: node.masked,
          day: toGameDay(fromEpochMinutes(node.seededAt)),
          lane: group.showLabel ? group.thread : '',
          x: 0,
        });
      }
    }
  }

  // ── 时间域 + x 映射（左侧预留「未定时间」竖条）──
  const allDays = raw.filter((n) => n.day !== null).map((n) => n.day as number);
  const hasUnknown = raw.some((n) => n.day === null);
  const minDay = allDays.length > 0 ? Math.min(...allDays) : 0;
  const maxDay = allDays.length > 0 ? Math.max(...allDays) : 0;
  const unknownStripW = hasUnknown ? UNKNOWN_STRIP_W : 0;
  const startX = PAD_X + unknownStripW;
  const xOf = (day: number) => startX + (day - minDay) * pxPerDay;
  for (const n of raw) n.x = n.day === null ? PAD_X : xOf(n.day);

  const rulerTicks = allDays.length > 0 ? buildRuler(minDay, maxDay, startX, pxPerDay) : [];

  // ── 章节条（只覆盖有日期的关键事件）+ 分多行 ──
  const bars: TimelineChapterBar[] = chapters
    .map((c) => {
      const days = raw
        .filter((n) => n.kind === 'outline' && n.lane === c.name && n.day !== null)
        .map((n) => n.day as number);
      if (days.length === 0) {
        // 该章没有带日期的事件 → 条落在「未定时间」竖条上
        return { name: c.name, x: PAD_X, w: CHAPTER_MIN_W, y: 0 };
      }
      const lo = Math.min(...days);
      const hi = Math.max(...days);
      const x = xOf(lo);
      return { name: c.name, x, w: Math.max(CHAPTER_MIN_W, xOf(hi) + NODE_W - x), y: 0 };
    })
    .filter((b) => raw.some((n) => n.kind === 'outline' && n.lane === b.name));
  const chapterRows = packChapterRows(bars);
  const chapterTop = RULER_H + 8;
  for (const b of bars) b.y = chapterTop + b.y * (CHAPTER_H + CHAPTER_ROW_GAP);
  const chapterBottom =
    chapterRows > 0 ? chapterTop + chapterRows * (CHAPTER_H + CHAPTER_ROW_GAP) : RULER_H;

  // ── 节点分区落位：大纲带 / 事件线带 ──
  const outlineRaw = raw
    .filter((n) => n.kind === 'outline')
    .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  const outlineTop = chapterBottom + (raw.some((n) => n.kind === 'outline') ? BAND_GAP : 0);
  const outlinePacked = packLanesByX(outlineRaw);
  const outlineNodes: TimelineNodeBox[] = outlineRaw.map((n, i) => ({
    kind: n.kind,
    id: n.id,
    title: n.title,
    summary: n.summary,
    status: n.status,
    statusLabel: n.statusLabel,
    masked: n.masked,
    day: n.day,
    x: n.x,
    y: outlineTop + outlinePacked[i].lane * (NODE_H + LANE_GAP),
    w: NODE_W,
    h: NODE_H,
  }));
  const outlineLanes = outlinePacked.length > 0 ? outlinePacked[outlinePacked.length - 1].lanes : 0;
  const outlineH = outlineLanes > 0 ? outlineLanes * NODE_H + (outlineLanes - 1) * LANE_GAP : 0;

  const threadRaw = raw
    .filter((n) => n.kind === 'thread')
    .sort((a, b) => a.x - b.x || a.id.localeCompare(b.id));
  const threadTop = outlineTop + outlineH + (raw.some((n) => n.kind === 'thread') ? BAND_GAP : 0);
  const threadPacked = packLanesByX(threadRaw);
  const threadNodes: TimelineNodeBox[] = threadRaw.map((n, i) => ({
    kind: n.kind,
    id: n.id,
    title: n.title,
    summary: n.summary,
    status: n.status,
    statusLabel: n.statusLabel,
    masked: n.masked,
    day: n.day,
    x: n.x,
    y: threadTop + threadPacked[i].lane * (NODE_H + LANE_GAP),
    w: NODE_W,
    h: NODE_H,
  }));
  const threadLanes = threadPacked.length > 0 ? threadPacked[threadPacked.length - 1].lanes : 0;
  const threadH = threadLanes > 0 ? threadLanes * NODE_H + (threadLanes - 1) * LANE_GAP : 0;

  const nodes = [...outlineNodes, ...threadNodes];
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  const barByName = new Map(bars.map((b) => [b.name, b]));

  // ── 连线（ComfyUI 式）──
  const eventsById = new Map(input.events.map((e) => [e.id, e]));
  const edges: TimelineEdgeBox[] = [];

  for (const ev of input.events) {
    if (ev.depth === 0) continue;
    const child = nodeById.get(ev.id);
    if (!child || child.masked) continue;
    const parent = ev.parentId ? eventsById.get(ev.parentId) : undefined;
    if (parent && parent.depth === 0) {
      // 章节条 → 事件（从条底扇出到事件顶）
      const bar = barByName.get(parent.chapterTitle || parent.title || OTHER_LANE);
      if (!bar) continue;
      const sx = Math.min(Math.max(child.x + NODE_W / 2, bar.x + 8), bar.x + bar.w - 8);
      const sy = bar.y + CHAPTER_H;
      const d = edgeCurve(sx, sy, child.x + NODE_W / 2, child.y, false);
      edges.push({ kind: 'outline', d });
    } else {
      // 父事件 → 子事件
      const from = parent ? nodeById.get(parent.id) : undefined;
      if (!from || from.masked) continue;
      const d = edgeCurve(
        from.x + NODE_W / 2,
        from.y + NODE_H,
        child.x + NODE_W / 2,
        child.y,
        false,
      );
      edges.push({ kind: 'outline', d });
    }
  }

  // 事件线伏笔/回收（threadView.edges 已含遮蔽判定）
  for (const e of input.threadView?.edges ?? []) {
    if (e.masked) continue;
    const from = nodeById.get(e.from);
    const to = nodeById.get(e.to);
    if (!from || !to) continue;
    const forward = to.x >= from.x;
    const d = forward
      ? edgeCurve(from.x + NODE_W, from.y + NODE_H / 2, to.x, to.y + NODE_H / 2, false)
      : edgeCurve(from.x + NODE_W / 2, from.y + NODE_H, to.x + NODE_W / 2, to.y + NODE_H, false);
    edges.push({ kind: 'thread', d });
  }

  // ── 「现在」游标 + 画布尺寸 ──
  let nowX: number | null = null;
  if (input.nowEpochMinutes !== null) {
    const nowDay = Math.floor(input.nowEpochMinutes / MIN_PER_DAY);
    nowX = xOf(nowDay);
    const rightEdge = allDays.length > 0 ? xOf(maxDay) + NODE_W + PAD_X : nowX + NODE_W;
    if (nowX > rightEdge) nowX = rightEdge;
  }

  const contentRight =
    allDays.length > 0 ? xOf(maxDay) + NODE_W + PAD_X : Math.max(PAD_X + unknownStripW, startX);
  const width = Math.max(contentRight, nowX !== null ? nowX + 8 : 0);
  const bottom =
    threadH > 0 ? threadTop + threadH : outlineH > 0 ? outlineTop + outlineH : chapterBottom;
  const masked = nodes.filter((n) => n.masked).length;

  return {
    width,
    height: bottom + PAD_BOTTOM,
    rulerTicks,
    rulerHeight: RULER_H,
    chapters: bars,
    nodes,
    edges,
    bands: {
      outline: { top: outlineTop, height: outlineH },
      thread: { top: threadTop, height: threadH },
    },
    nowX,
    unknownStripW,
    anchor: { startX, minDay, pxPerDay },
    isEmpty: nodes.length === 0 && chapters.length === 0,
    counts: { outline: outlineNodes.length, thread: threadNodes.length, masked },
  };
}
