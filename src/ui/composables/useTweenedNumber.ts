/**
 * useTweenedNumber — 数值滚动（动效 v1 第 5 项，2026-11-16 主人拍板）
 *
 * 金币 / 经验 / 命运点 / 资源条读数变化时，显示值在约半秒内从旧数滚到新数，
 * 期间用 `trend` 告诉模板是涨还是跌（模板据此短暂着色）。
 *
 * 🔴 PRODUCT.md「一个真相来源」：这里只改**显示**，从不改数据 ——
 *    - 滚动终点恒等于源值；源值一变，立刻以当前显示值为起点改道去新的终点。
 *    - 非整数（或非有限数）不滚，直接显示源值：插值出来的小数是一个谁也没写过的数。
 *    - 减动效（系统偏好 ∪ 应用内开关，见 lib/reduced-motion.ts）下直接跳到终点。
 *    - 挂载时不滚：首屏显示的就是真值，不从 0 数上来。
 */
import { onScopeDispose, readonly, ref, watch, type Ref } from 'vue';
import { isReducedMotion } from '../lib/reduced-motion';

export type NumberTrend = 'up' | 'down' | null;

/** 帧调度注入缝：生产用 rAF + performance.now，测试传手动驱动 */
export interface FrameDriver {
  now(): number;
  request(cb: () => void): number;
  cancel(handle: number): void;
}

/** 没有 rAF 的环境（jsdom 缺省配置、个别嵌入式 webview）退回 16ms 定时器 */
const hasRaf = typeof requestAnimationFrame === 'function';
const browserFrames: FrameDriver = {
  now: () => performance.now(),
  request: (cb) =>
    hasRaf ? requestAnimationFrame(() => cb()) : (setTimeout(cb, 16) as unknown as number),
  cancel: (handle) => (hasRaf ? cancelAnimationFrame(handle) : clearTimeout(handle)),
};

/** 源值可能缺席（例如还没有玩家角色）：缺席照原样显示，不当 0 */
type MaybeNumber = number | null | undefined;

interface TweenOptions {
  /** 一次滚动的时长（毫秒）；与 `--motion-duration-slow` 同量级，略长一点让数字读得出来 */
  duration?: number;
  frames?: FrameDriver;
  /** 是否减动效；缺省读 lib/reduced-motion.ts（测试可注入） */
  reducedMotion?: () => boolean;
}

/** ease-out cubic：迅速接近终点、最后几位慢慢落定 —— 与 --motion-ease-enter 同一种手感 */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

function bothIntegers(from: MaybeNumber, to: MaybeNumber): to is number {
  return Number.isInteger(from) && Number.isInteger(to);
}

export function useTweenedNumber(
  source: () => MaybeNumber,
  options: TweenOptions = {},
): { display: Readonly<Ref<MaybeNumber>>; trend: Readonly<Ref<NumberTrend>> } {
  const duration = options.duration ?? 480;
  const frames = options.frames ?? browserFrames;
  const reduced = options.reducedMotion ?? isReducedMotion;

  const display = ref<MaybeNumber>(source());
  const trend = ref<NumberTrend>(null);
  let handle: number | null = null;

  function stop() {
    if (handle !== null) frames.cancel(handle);
    handle = null;
  }

  watch(source, (target) => {
    stop();
    const from = display.value;
    if (!bothIntegers(from, target) || from === target || reduced()) {
      display.value = target;
      trend.value = null;
      return;
    }

    // bothIntegers 已保证两端都是整数；这里显式收窄起点，插值里不再出现可空类型
    const origin = from as number;
    trend.value = target > origin ? 'up' : 'down';
    const start = frames.now();
    const step = () => {
      const t = Math.min(1, (frames.now() - start) / duration);
      display.value = Math.round(origin + (target - origin) * easeOutCubic(t));
      if (t < 1) {
        handle = frames.request(step);
        return;
      }
      handle = null;
      display.value = target;
      trend.value = null;
    };
    handle = frames.request(step);
  });

  onScopeDispose(stop);

  return { display: readonly(display), trend: readonly(trend) };
}
