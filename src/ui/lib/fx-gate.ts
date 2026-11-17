/**
 * fx-gate.ts — 界面特效层的**唯一闸门**
 *
 * 特效层整体挂在 `<html data-fx="on">` 上：CSS 一律写 `:root[data-fx='on'] …`，组件一律
 * `v-if` 在 `useFxEnabled()` 上。闸门只有一个判据：
 *
 *   设置 `visualEffects` 为真 **且** `isReducedMotion()` 为假（系统偏好 ∪ 应用内开关）
 *
 * 所以「关掉特效」与「减少动态效果」两条路都等于今天的界面：没有属性、没有监听、没有 DOM。
 *
 * ★ 与 reduced-motion.ts 同一哲学：`isFxEnabled()` 读 DOM 属性而不是 import settings-store，
 * 纯查询不该把 Pinia 拖进来（单测不必摆 activePinia）。属性由 `syncFxGate()` 单点写入，
 * DOM 即闸门的呈现真相；`useFxEnabled()` 给组件一份共享的响应式镜像。
 */
import { readonly, shallowRef, type Ref } from 'vue';
import { isReducedMotion } from './reduced-motion';

/** `<html>` 上的闸门属性名 —— CSS 选择器写的是同一个字面量 */
const FX_ATTR = 'data-fx';

/** 共享的响应式镜像。唯一写入点是 `syncFxGate()`，所以它与 DOM 恒等 */
const enabledRef = shallowRef(false);

/**
 * 按设置与减动效状态写闸门。**唯一写入点**（App.vue 的 watch 与系统偏好监听调它）。
 *
 * 🔴 调用方必须保证 `applyReducedMotion()` 已先于本函数生效 —— 这里读的是 DOM 上的
 * `data-reduced-motion`，顺序反了就会用上一拍的减动效状态开闸。
 *
 * 关闭时移除属性而非写 `"off"`：理由同 reduced-motion.ts（DOM 上留反值只是噪音）。
 * @returns 闸门最终是否打开
 */
export function syncFxGate(settingOn: boolean): boolean {
  const on = Boolean(settingOn) && !isReducedMotion();
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (on) root.setAttribute(FX_ATTR, 'on');
    else root.removeAttribute(FX_ATTR);
  }
  enabledRef.value = on;
  return on;
}

/** 闸门此刻是否打开（读 DOM）。SSR / 无 DOM 环境返回 false */
export function isFxEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  return document.documentElement.getAttribute(FX_ATTR) === 'on';
}

/** 组件用的只读响应式闸门。全应用共享同一个 ref，不按调用方各建监听 */
export function useFxEnabled(): Readonly<Ref<boolean>> {
  // 以 DOM 为准校一次：防止测试或别处在本模块之外改了属性后镜像过期
  const dom = isFxEnabled();
  if (enabledRef.value !== dom) enabledRef.value = dom;
  return readonly(enabledRef);
}
