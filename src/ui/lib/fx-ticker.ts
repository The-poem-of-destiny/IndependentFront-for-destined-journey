/**
 * fx-ticker.ts — 特效层的帧调度与「偶发」调度
 *
 * 两件事：
 * 1. `requestFrame(cb)`：所有订阅者**合并成每帧一次** rAF。页面隐藏时不排帧，
 *    积压的回调等页面重新可见再在下一帧统一执行（不在后台空转）。
 * 2. `scheduleOccasional(...)`：在 [minMs, maxMs] 内随机延时跑一次，跑完再随机重排；
 *    页面隐藏或闸门关闭时**跳过本次**但照常重排（「偶发」效果不补发）。
 *
 * 帧源 / 定时器 / 随机数 / 可见性 / 闸门全部可注入，单测不依赖真实时钟。
 * 默认实现在**调用时**才读 `globalThis.requestAnimationFrame`，以便测试 `vi.stubGlobal`。
 */
import { isFxEnabled } from './fx-gate';

export type FrameCallback = (time: number) => void;

interface FrameSource {
  raf(cb: FrameCallback): number;
  caf(id: number): void;
}

export interface FrameTickerOptions {
  frames?: FrameSource;
  /** 页面是否隐藏；缺省读 `document.hidden` */
  isHidden?: () => boolean;
}

export interface FrameTicker {
  /** 下一帧执行一次 `cb`；返回取消函数 */
  requestFrame(cb: FrameCallback): () => void;
  /** 当前排着的回调数（测试与诊断用） */
  pendingCount(): number;
}

function defaultIsHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

const defaultFrames: FrameSource = {
  raf(cb) {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf === 'function') return raf.call(globalThis, cb);
    // 无 rAF 环境（jsdom 某些版本 / SSR）退 16ms 定时器，与 useTweenedNumber 同口径
    return setTimeout(() => cb(Date.now()), 16) as unknown as number;
  },
  caf(id) {
    const caf = globalThis.cancelAnimationFrame;
    if (typeof caf === 'function') caf.call(globalThis, id);
    else clearTimeout(id);
  },
};

/** 建一个合帧调度器。生产只用模块级默认实例；单测各建一个注入帧源 */
export function createFrameTicker(options: FrameTickerOptions = {}): FrameTicker {
  const frames = options.frames ?? defaultFrames;
  const isHidden = options.isHidden ?? defaultIsHidden;
  const queue = new Set<FrameCallback>();
  let frameId: number | null = null;
  let waitingVisible = false;

  function onVisibility(): void {
    if (isHidden()) return;
    detachVisibility();
    schedule();
  }

  function detachVisibility(): void {
    if (!waitingVisible) return;
    waitingVisible = false;
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibility);
    }
  }

  function schedule(): void {
    if (frameId !== null || queue.size === 0) return;
    if (isHidden()) {
      // 隐藏期间不排帧；等可见再续。监听只在有积压时挂
      if (!waitingVisible && typeof document !== 'undefined') {
        waitingVisible = true;
        document.addEventListener('visibilitychange', onVisibility);
      }
      return;
    }
    frameId = frames.raf(flush);
  }

  function flush(time: number): void {
    frameId = null;
    // 先摘下本帧的批次：回调里再 requestFrame 的进下一帧，不在本帧递归
    const batch = Array.from(queue);
    queue.clear();
    for (const cb of batch) {
      try {
        cb(time);
      } catch (err) {
        // 一个特效出错不能拖垮同帧的其它特效
        console.warn('[fx-ticker] 帧回调出错', err);
      }
    }
    schedule();
  }

  return {
    requestFrame(cb) {
      queue.add(cb);
      schedule();
      return () => {
        queue.delete(cb);
        if (queue.size === 0) {
          if (frameId !== null) {
            frames.caf(frameId);
            frameId = null;
          }
          detachVisibility();
        }
      };
    },
    pendingCount() {
      return queue.size;
    },
  };
}

const defaultTicker = createFrameTicker();

/** 全应用共享的合帧入口：下一帧执行一次 `cb`，返回取消函数 */
export function requestFrame(cb: FrameCallback): () => void {
  return defaultTicker.requestFrame(cb);
}

export interface OccasionalTimers {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ScheduleOccasionalOptions {
  minMs: number;
  maxMs: number;
  run: () => void;
  /** [0, 1) 随机源，缺省 Math.random */
  rng?: () => number;
  timers?: OccasionalTimers;
  /** 页面是否隐藏；缺省读 `document.hidden` */
  isHidden?: () => boolean;
  /** 闸门是否打开；缺省 `isFxEnabled()` */
  isEnabled?: () => boolean;
}

const defaultTimers: OccasionalTimers = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * 在 [minMs, maxMs] 随机延时后跑 `run`，跑完（或跳过）再随机重排，直到取消。
 * @returns 取消函数（幂等）
 */
export function scheduleOccasional(options: ScheduleOccasionalOptions): () => void {
  const rng = options.rng ?? Math.random;
  const timers = options.timers ?? defaultTimers;
  const isHidden = options.isHidden ?? defaultIsHidden;
  const isEnabled = options.isEnabled ?? isFxEnabled;
  const lo = Math.max(0, Math.min(options.minMs, options.maxMs));
  const hi = Math.max(lo, options.maxMs, options.minMs);
  let handle: unknown = null;
  let cancelled = false;

  function arm(): void {
    if (cancelled) return;
    const delay = lo + (hi - lo) * rng();
    handle = timers.setTimeout(fire, delay);
  }

  function fire(): void {
    handle = null;
    if (cancelled) return;
    if (!isHidden() && isEnabled()) {
      try {
        options.run();
      } catch (err) {
        console.warn('[fx-ticker] 偶发效果出错', err);
      }
    }
    arm();
  }

  arm();
  return () => {
    if (cancelled) return;
    cancelled = true;
    if (handle !== null) timers.clearTimeout(handle);
    handle = null;
  };
}
