/**
 * 粗估 token 数：字符数（UTF-16 码元）/ 1.5 向上取整。
 *
 * 与引擎现有的超限判断、诊断面板同一口径（`story-context-v2` / `direct-context-session` /
 * `agent-orchestrator` 里的内联 `Math.ceil(chars / 1.5)`）。🔴 不是 provider 计数，只用于
 * 估算与展示；改系数要连同那些内联处一起改，否则界面数字和超限判断对不上。
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 1.5);
}
