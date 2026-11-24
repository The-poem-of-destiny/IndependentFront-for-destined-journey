/**
 * 行动面板入场的交错上限（对决条 / 跳字舞台 / 打出的牌共用）。
 *
 * 目标行、单位格、小牌按下标 `--i` 依次错开；下标封顶在 `STAGGER_INDEX_MAX`，
 * 第 7 个及以后与第 6 个同时出现 —— 这样入场的最长一段有上限，样式目录里的
 * `entranceMs`（`lib/action-panel-styles.ts`）才能盖得住它（算式见 tests/ui/lib/action-panel-styles.test.ts）。
 *
 * 独立成 .ts 是因为测试经 `*.vue` 垫片 import 看不到具名导出。
 */

/** `--i` 的最大值 */
export const STAGGER_INDEX_MAX = 5;

/** 模板用：第 i 个元素的交错下标样式 */
export function staggerStyle(i: number): Record<string, number> {
  return { '--i': Math.min(Math.max(0, i), STAGGER_INDEX_MAX) };
}
