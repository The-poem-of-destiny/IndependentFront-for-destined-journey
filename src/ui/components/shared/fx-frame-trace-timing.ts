/**
 * fx-frame-trace-timing.ts — 弹窗「描框入场」的时间表（AppModal / FxFrameTrace / 测试共用）
 *
 * 独立成 .ts 而不是从 .vue 具名导出：测试经 `*.vue` 类型垫片 import 时看不到具名导出。
 */
/**
 * 编排（特效闸门打开时）的**唯一出处**；AppModal 的 scoped 样式里的毫秒数与之逐一对应。
 *
 *   0ms        四角描线从角点沿边长出（GROW）
 *   CONTENT_DELAY  面板淡入
 *   CHILD_DELAY + i × CHILD_STAGGER  页头 / 正文 / 页脚依次上浮 6px 淡入
 *   FADE_DELAY 描线淡去，最后整个移除（选更克制的那一档：不留常驻框线）
 *
 * 🔴 `FX_MODAL_ENTER_MS` 是 AppModal 根 `<Transition>` 的显式 enter 时长：必须不短于上面
 *    任何一段的终点，否则 `*-enter-active` 被半路摘掉、子元素当场跳到终态（design.md §6.0 第 4 条）。
 */
export const FX_TRACE_GROW_MS = 360;
const FX_MODAL_CONTENT_DELAY_MS = 280;
const FX_MODAL_CONTENT_FADE_MS = 240;
export const FX_MODAL_CHILD_DELAY_MS = 360;
export const FX_MODAL_CHILD_STAGGER_MS = 36;
export const FX_MODAL_CHILD_RISE_MS = 360;
/** AppModal 内最多三个上浮子块：页头 / 正文 / 页脚 */
export const FX_MODAL_CHILD_COUNT = 3;
export const FX_TRACE_FADE_DELAY_MS = 480;
export const FX_TRACE_FADE_MS = 360;
/** 描线整段（长出 + 停留 + 淡去）的终点 */
export const FX_TRACE_TOTAL_MS = FX_TRACE_FADE_DELAY_MS + FX_TRACE_FADE_MS;
/** 根 Transition 的 enter 时长：覆盖整段编排，再留 20ms 余量 */
export const FX_MODAL_ENTER_MS =
  Math.max(
    FX_TRACE_TOTAL_MS,
    FX_MODAL_CONTENT_DELAY_MS + FX_MODAL_CONTENT_FADE_MS,
    FX_MODAL_CHILD_DELAY_MS +
      (FX_MODAL_CHILD_COUNT - 1) * FX_MODAL_CHILD_STAGGER_MS +
      FX_MODAL_CHILD_RISE_MS,
  ) + 20;

/** 面板矩形（相对于遮罩层，取 offset* —— 不含入场 transform） */
export interface FxFrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}
