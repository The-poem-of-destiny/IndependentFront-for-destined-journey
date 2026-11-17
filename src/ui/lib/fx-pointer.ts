/**
 * fx-pointer.ts — 特效层的指针源与视差
 *
 * - 全应用**至多一个** `pointermove` 监听（window、passive），第一个订阅者到来时才挂，
 *   最后一个走了就摘；只在 `(hover: hover)` 设备上挂（触屏没有悬停指针，视差无意义）。
 * - `registerParallax(el, depthPx)`：元素按指针相对视口中心的偏移反向平移至多 `depthPx`，
 *   经 fx-ticker 合帧平滑逼近；**收敛后不再排帧**（指针不动 = 零 rAF 开销）。
 *   只写该元素自己的内联 `transform: translate3d()` —— 🔴 永远不要每帧往 html/body 写 CSS 变量，
 *   那会让整棵树的样式失效重算。
 */
import { requestFrame as defaultRequestFrame, type FrameCallback } from './fx-ticker';

/** 指针位置：视口像素坐标 + 相对视口中心归一化到 [-1, 1] */
interface FxPointer {
  x: number;
  y: number;
  nx: number;
  ny: number;
}

type PointerCallback = (p: FxPointer) => void;

export interface PointerHubOptions {
  /** 监听目标，缺省 window */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener' | 'innerWidth' | 'innerHeight'>;
  /** 是否为可悬停设备；缺省读 `matchMedia('(hover: hover)')` */
  canHover?: () => boolean;
  requestFrame?: (cb: FrameCallback) => () => void;
}

export interface PointerHub {
  subscribePointer(cb: PointerCallback): () => void;
  registerParallax(el: HTMLElement, depthPx: number): () => void;
  /** 当前是否挂着 pointermove 监听（测试与诊断用） */
  isListening(): boolean;
}

/** 平滑系数：每帧向目标逼近的比例 */
const SMOOTHING = 0.12;
/** 收敛阈值（px）：差距小于它即落到目标并停帧 */
const SETTLE_EPSILON = 0.05;

function defaultCanHover(): boolean {
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(hover: hover)').matches;
  } catch {
    return false;
  }
}

function clampUnit(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}

export function createPointerHub(options: PointerHubOptions = {}): PointerHub {
  const canHover = options.canHover ?? defaultCanHover;
  const raf = options.requestFrame ?? defaultRequestFrame;
  const getTarget = () => options.target ?? (typeof window !== 'undefined' ? window : undefined);
  const subscribers = new Set<PointerCallback>();
  let listening = false;
  let listenTarget: ReturnType<typeof getTarget>;

  function onMove(ev: Event): void {
    const e = ev as PointerEvent;
    const t = listenTarget;
    if (!t) return;
    const w = t.innerWidth || 1;
    const h = t.innerHeight || 1;
    const p: FxPointer = {
      x: e.clientX,
      y: e.clientY,
      nx: clampUnit((e.clientX / w) * 2 - 1),
      ny: clampUnit((e.clientY / h) * 2 - 1),
    };
    for (const cb of Array.from(subscribers)) cb(p);
  }

  function attach(): void {
    if (listening) return;
    listenTarget = getTarget();
    if (!listenTarget) return;
    listenTarget.addEventListener('pointermove', onMove, { passive: true });
    listening = true;
  }

  function detach(): void {
    if (!listening) return;
    listenTarget?.removeEventListener('pointermove', onMove);
    listening = false;
    listenTarget = undefined;
  }

  function subscribePointer(cb: PointerCallback): () => void {
    // 触屏 / 无悬停设备：不挂监听，返回空退订
    if (!canHover()) return () => {};
    subscribers.add(cb);
    attach();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      subscribers.delete(cb);
      if (subscribers.size === 0) detach();
    };
  }

  function registerParallax(el: HTMLElement, depthPx: number): () => void {
    let curX = 0;
    let curY = 0;
    let tgtX = 0;
    let tgtY = 0;
    let cancelFrame: (() => void) | null = null;

    function write(): void {
      el.style.transform = `translate3d(${curX.toFixed(2)}px, ${curY.toFixed(2)}px, 0)`;
    }

    function step(): void {
      cancelFrame = null;
      const dx = tgtX - curX;
      const dy = tgtY - curY;
      if (Math.abs(dx) < SETTLE_EPSILON && Math.abs(dy) < SETTLE_EPSILON) {
        // 收敛：落到目标、写最后一帧、停止排帧
        curX = tgtX;
        curY = tgtY;
        write();
        return;
      }
      curX += dx * SMOOTHING;
      curY += dy * SMOOTHING;
      write();
      cancelFrame = raf(step);
    }

    const unsubscribe = subscribePointer((p) => {
      // 反向平移：指针往右，景深层往左，营造纵深
      tgtX = -p.nx * depthPx;
      tgtY = -p.ny * depthPx;
      if (cancelFrame === null) cancelFrame = raf(step);
    });

    return () => {
      unsubscribe();
      cancelFrame?.();
      cancelFrame = null;
      el.style.transform = '';
    };
  }

  return {
    subscribePointer,
    registerParallax,
    isListening: () => listening,
  };
}

const defaultHub = createPointerHub();

/** 订阅全局指针位置；返回退订函数。无悬停设备上为空操作 */
export function subscribePointer(cb: PointerCallback): () => void {
  return defaultHub.subscribePointer(cb);
}

/** 给元素挂指针视差（至多平移 `depthPx`）；返回注销函数（会清掉内联 transform） */
export function registerParallax(el: HTMLElement, depthPx: number): () => void {
  return defaultHub.registerParallax(el, depthPx);
}
