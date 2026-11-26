/**
 * 入场交错的上限与步长 —— 唯一出处（行动面板五种样式 + 正文墨迹浮现共用）。
 *
 * 目标行、单位格、小牌按下标 `--i` 依次错开；下标封顶在 `STAGGER_INDEX_MAX`，
 * 第 7 个及以后与第 6 个同时出现 —— 这样入场的最长一段有上限，样式目录里的
 * `entranceMs`（`lib/action-panel-styles.ts`）才能盖得住它（算式见 tests/ui/lib/action-panel-styles.test.ts）。
 * 战报行按行交错，另有自己的行数上限 `BATTLELOG_STAGGER_LINES`。
 *
 * 独立成 .ts 是因为测试经 `*.vue` 垫片 import 看不到具名导出。
 */

/** `--i` 的最大值（对决条 / 跳字舞台 / 打出的牌） */
export const STAGGER_INDEX_MAX = 5;

/**
 * 交错每一级的间隔（毫秒），与 `themes/variables.css` 的 `--motion-stagger-step` 同值。
 * CSS 里的动画照旧读 token；TS 侧要算「动画什么时候放完」时读这个常量
 * （两者相等由 tests/ui/lib/action-panel-styles.test.ts 断言）。
 */
export const STAGGER_STEP_MS = 36;

/** 战报行入场只交错排前几行，之后的与最后一行同时出现（`--i` 封顶在它减一） */
export const BATTLELOG_STAGGER_LINES = 8;

/** 模板用：第 i 个元素的交错下标样式 */
export function staggerStyle(i: number): Record<string, number> {
  return { '--i': Math.min(Math.max(0, i), STAGGER_INDEX_MAX) };
}
