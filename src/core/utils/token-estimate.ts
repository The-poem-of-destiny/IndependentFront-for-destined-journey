/**
 * 粗估 token 数：字符数（UTF-16 码元）/ 1.5 向上取整。
 *
 * 与引擎现有的超限判断、诊断面板同一口径（直出窗口检查与缓存直出会话已改用本模块；
 * `story-context-v2` / `agent-orchestrator` 里仍有内联 `Math.ceil(chars / 1.5)`）。🔴 不是 provider
 * 计数，只用于估算与展示；改系数要连同那些内联处一起改，否则界面数字和超限判断对不上。
 */
export function estimateTokens(text: string): number {
  return estimateTokensFromChars(text.length);
}

/** 同上，入参是已算好的字符数（如整份请求按消息累加的长度） */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 1.5);
}
