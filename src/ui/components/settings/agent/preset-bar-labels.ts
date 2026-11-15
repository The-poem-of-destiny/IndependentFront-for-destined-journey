/**
 * 「预设」状态条上「内容从哪来」的措辞（纯函数，2026-11-14）。
 *
 * 三种情况必须说得不一样，否则用户会被误导：
 *   · 已装内容包（含受保护包）           → 「内容包」
 *   · 开发叠加目录（`__POEM_CONTENT_DIR__`），没装包 → 「本地内容」
 *     （这时默认层来自本机的真实内容文件，说成「占位内容」是错的，说成「内容包」也不对）
 *   · 公开仓占位态                         → 「占位内容」
 *
 * 独立成纯函数，是因为 `__POEM_CONTENT_DIR__` 是构建期常量，组件测试里改不了它。
 */
export function contentSourceLabel(input: {
  packActive: boolean;
  localContentDir: boolean;
}): string {
  if (input.packActive) return '内容包';
  return input.localContentDir ? '本地内容' : '占位内容';
}
