/**
 * reduced-motion.ts — 「现在该不该动画」的唯一判定
 *
 * 减动效有**两个**来源，缺一不可:
 * 1. 系统偏好 `prefers-reduced-motion: reduce`（用户在 OS 里设的）
 * 2. 应用内开关 `settings.reducedMotion`（默认关）—— 给「系统没开、但就是不想看动画」
 *    的人，以及在不暴露该偏好的环境里的人
 *
 * CSS 侧两条路各有自己的选择器（见 `themes/variables.css`）；JS 侧走这里。两边必须
 * 同时判定，否则会出现「CSS 不动了但 JS 还在平滑滚动」这种半吊子状态。
 *
 * ★ 读 DOM 上的 `data-reduced-motion` 而不是 import settings-store: 本模块被组件
 * 直接调用，走 store 会把一个纯查询变成对 Pinia 的依赖（单测里就得摆 activePinia）。
 * 属性由 `applyReducedMotion()` 单点写入，DOM 即该开关的呈现真相。
 */

/** `<html>` 上的开关属性名 —— CSS 选择器与本模块共用这一个常量的字面量 */
const REDUCED_MOTION_ATTR = 'data-reduced-motion';

/**
 * 把应用内开关写到 `<html>`。**唯一写入点**。
 *
 * 关闭时移除属性而非写 `"false"`: CSS 用 `[data-reduced-motion='true']` 命中，
 * 留一个 `"false"` 在 DOM 上只是噪音，还会诱使别处写出 `!== 'false'` 这种反向判断。
 */
export function applyReducedMotion(enabled: boolean): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (enabled) root.setAttribute(REDUCED_MOTION_ATTR, 'true');
  else root.removeAttribute(REDUCED_MOTION_ATTR);
}

/**
 * 现在是否处于减动效状态（系统偏好 **或** 应用内开关）。
 *
 * JS 侧用它决定平滑滚动之类**不受 CSS 管辖**的动作。SSR / 无 DOM 环境返回 false。
 */
export function isReducedMotion(): boolean {
  if (typeof document === 'undefined') return false;
  if (document.documentElement.getAttribute(REDUCED_MOTION_ATTR) === 'true') return true;
  // jsdom 里 matchMedia 可能没实现 —— 缺它只意味着"拿不到系统偏好"，不该抛
  if (typeof matchMedia !== 'function') return false;
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 滚动行为糖 —— 减动效时 `auto`（瞬移），否则 `smooth` */
export function scrollBehavior(): ScrollBehavior {
  return isReducedMotion() ? 'auto' : 'smooth';
}
