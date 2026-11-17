/**
 * fx-glint.ts — 偶发闪光（FxGlint）的纯逻辑与运行器
 *
 * 每 40–90 秒（`scheduleOccasional`，页面隐藏或闸门关闭时跳过本次）挑一个**可见**面板框，
 * 沿它的一条边划过一道细光：约 900ms、只动 transform / opacity、播一次就藏起来，**从不循环**。
 *
 * - 选框 / 选边 / 轨道几何 / 关键帧全是纯函数，随机源可注入（单测不依赖真实随机）。
 * - 有弹窗开着时只在弹窗框里挑（页面上的框此刻被遮罩盖着，划光是浪费）。
 * - crimson 主题禁止常驻环境动效：运行器直接跳过（组件样式另有 `display: none` 兜底）。
 * - jsdom 没有 `element.animate`：没有就不播，轨道立即藏回去。
 */
import { scheduleOccasional, type OccasionalTimers } from './fx-ticker';
import { SHEEN_FRAME_SELECTOR } from './fx-sheen';

export const GLINT_MIN_MS = 40_000;
export const GLINT_MAX_MS = 90_000;
export const GLINT_DURATION_MS = 900;

/** 候选框与光泽描边环同一份清单 */
const GLINT_FRAME_SELECTOR = SHEEN_FRAME_SELECTOR;

/** 禁止环境动效的主题 */
const GLINT_DISABLED_THEMES = new Set(['crimson']);

/** 轨道两端各让出的长度（px）：避开圆角，光不会在拐角处悬空 */
const EDGE_INSET_PX = 12;
/** 边太短就不值得划 */
const MIN_TRACK_PX = 48;

export type GlintEdge = 'top' | 'right' | 'bottom' | 'left';

export interface GlintRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface GlintViewport {
  width: number;
  height: number;
}

export interface GlintPlan {
  /** 选中的候选下标（在传入的 rects 里） */
  index: number;
  edge: GlintEdge;
  /** 轨道沿哪条轴走 */
  axis: 'x' | 'y';
  /** 轨道左上角（视口坐标） */
  x: number;
  y: number;
  /** 轨道长度（沿轴） */
  length: number;
  /** 光条自身长度 */
  streak: number;
}

/** 矩形是否有面积且与视口相交 */
export function isRectVisible(r: GlintRect, vp: GlintViewport): boolean {
  if (!(r.width > 0 && r.height > 0)) return false;
  return r.left < vp.width && r.top < vp.height && r.left + r.width > 0 && r.top + r.height > 0;
}

function pick<T>(items: readonly T[], rng: () => number): T {
  const i = Math.min(items.length - 1, Math.max(0, Math.floor(rng() * items.length)));
  return items[i];
}

/** 一条边在视口内的轨道（已让出圆角、夹到视口）；太短返回 null */
export function edgeTrack(
  r: GlintRect,
  edge: GlintEdge,
  vp: GlintViewport,
): Omit<GlintPlan, 'index' | 'edge' | 'streak'> | null {
  if (edge === 'top' || edge === 'bottom') {
    const y = edge === 'top' ? r.top : r.top + r.height - 1;
    if (y < 0 || y >= vp.height) return null;
    const x0 = Math.max(0, r.left + EDGE_INSET_PX);
    const x1 = Math.min(vp.width, r.left + r.width - EDGE_INSET_PX);
    if (x1 - x0 < MIN_TRACK_PX) return null;
    return { axis: 'x', x: x0, y, length: x1 - x0 };
  }
  const x = edge === 'left' ? r.left : r.left + r.width - 1;
  if (x < 0 || x >= vp.width) return null;
  const y0 = Math.max(0, r.top + EDGE_INSET_PX);
  const y1 = Math.min(vp.height, r.top + r.height - EDGE_INSET_PX);
  if (y1 - y0 < MIN_TRACK_PX) return null;
  return { axis: 'y', x, y: y0, length: y1 - y0 };
}

/** 光条长度：轨道的约两成，夹在 [40, 180] */
export function streakLength(trackLength: number): number {
  return Math.round(Math.min(180, Math.max(40, trackLength * 0.22)));
}

const EDGES: readonly GlintEdge[] = ['top', 'right', 'bottom', 'left'];

/**
 * 从候选矩形里挑一个可见框与它的一条边。没有可见框、或可见框没有一条够长的边时返回 null。
 */
export function planGlint(
  rects: readonly GlintRect[],
  vp: GlintViewport,
  rng: () => number,
): GlintPlan | null {
  const visible = rects.map((r, index) => ({ r, index })).filter(({ r }) => isRectVisible(r, vp));
  if (visible.length === 0) return null;
  const chosen = pick(visible, rng);
  const options = EDGES.map((edge) => ({ edge, track: edgeTrack(chosen.r, edge, vp) })).filter(
    (o): o is { edge: GlintEdge; track: NonNullable<ReturnType<typeof edgeTrack>> } =>
      o.track !== null,
  );
  if (options.length === 0) return null;
  const { edge, track } = pick(options, rng);
  return { index: chosen.index, edge, ...track, streak: streakLength(track.length) };
}

/** 一次划光的关键帧：从轨道起点外滑到终点外，首尾淡入淡出（只动 transform / opacity） */
export function glintKeyframes(axis: 'x' | 'y', length: number, streak: number): Keyframe[] {
  const fn = axis === 'x' ? 'translateX' : 'translateY';
  return [
    { transform: `${fn}(${-streak}px)`, opacity: 0, offset: 0 },
    { opacity: 1, offset: 0.25 },
    { opacity: 1, offset: 0.7 },
    { transform: `${fn}(${length}px)`, opacity: 0, offset: 1 },
  ];
}

export interface GlintElements {
  /** 轨道：绝对定位、裁掉溢出，平时 hidden */
  track: HTMLElement;
  /** 光条：轨道里唯一会动的元素 */
  streak: HTMLElement;
}

export interface GlintRunnerOptions {
  doc?: Document;
  rng?: () => number;
  timers?: OccasionalTimers;
  isHidden?: () => boolean;
  isEnabled?: () => boolean;
  viewport?: () => GlintViewport;
}

export interface GlintRunner {
  /** 立刻试一次划光；返回是否真的开始了（测试与诊断用） */
  runOnce(): boolean;
  /** 停止排期、取消在播的动画、藏起轨道（幂等） */
  dispose(): void;
}

function defaultViewport(): GlintViewport {
  if (typeof window === 'undefined') return { width: 0, height: 0 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function hideTrack(track: HTMLElement): void {
  track.hidden = true;
}

/** 选候选框：有可见弹窗时只在弹窗框里挑 */
function collectFrames(doc: Document, vp: GlintViewport): Element[] {
  const all = Array.from(doc.querySelectorAll(GLINT_FRAME_SELECTOR));
  const modals = all.filter(
    (el) => el.matches('.modal-content') && isRectVisible(el.getBoundingClientRect(), vp),
  );
  return modals.length > 0 ? modals : all;
}

/**
 * 建闪光运行器并开始排期。组件 onMounted 建、onBeforeUnmount 调 `dispose()`。
 */
export function createGlintRunner(
  els: GlintElements,
  options: GlintRunnerOptions = {},
): GlintRunner {
  const doc = options.doc ?? document;
  const rng = options.rng ?? Math.random;
  const getViewport = options.viewport ?? defaultViewport;
  let current: Animation | null = null;
  let disposed = false;

  hideTrack(els.track);

  function runOnce(): boolean {
    if (disposed || current) return false;
    const theme = doc.documentElement.getAttribute('data-theme') ?? '';
    if (GLINT_DISABLED_THEMES.has(theme)) return false;
    const vp = getViewport();
    const frames = collectFrames(doc, vp);
    const plan = planGlint(
      frames.map((el) => el.getBoundingClientRect()),
      vp,
      rng,
    );
    if (!plan) return false;

    const { track, streak } = els;
    track.style.transform = `translate3d(${plan.x.toFixed(1)}px, ${plan.y.toFixed(1)}px, 0)`;
    track.style.width = plan.axis === 'x' ? `${plan.length.toFixed(1)}px` : '1px';
    track.style.height = plan.axis === 'x' ? '1px' : `${plan.length.toFixed(1)}px`;
    track.dataset.axis = plan.axis;
    streak.style.width = plan.axis === 'x' ? `${plan.streak}px` : '100%';
    streak.style.height = plan.axis === 'x' ? '100%' : `${plan.streak}px`;

    if (typeof streak.animate !== 'function') {
      // 无 Web Animations（jsdom / 极旧内核）：不播，保持藏着
      hideTrack(track);
      return true;
    }
    track.hidden = false;
    const anim = streak.animate(glintKeyframes(plan.axis, plan.length, plan.streak), {
      duration: GLINT_DURATION_MS,
      easing: 'cubic-bezier(0.4, 0, 0.2, 1)',
      fill: 'none',
    });
    current = anim;
    const done = () => {
      if (current !== anim) return;
      current = null;
      hideTrack(track);
    };
    anim.onfinish = done;
    anim.oncancel = done;
    return true;
  }

  const stop = scheduleOccasional({
    minMs: GLINT_MIN_MS,
    maxMs: GLINT_MAX_MS,
    run: () => {
      runOnce();
    },
    rng,
    timers: options.timers,
    isHidden: options.isHidden,
    isEnabled: options.isEnabled,
  });

  return {
    runOnce,
    dispose() {
      if (disposed) return;
      disposed = true;
      stop();
      const anim = current;
      current = null;
      anim?.cancel();
      hideTrack(els.track);
    },
  };
}
