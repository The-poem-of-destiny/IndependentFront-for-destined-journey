/**
 * redact-secrets.ts — 错误原文里的凭据启发式脱敏（2026-11-16 自 `src/ui/lib/turn-failure.ts` 下沉）。
 *
 * 行为与搬迁前逐字相同；下沉到引擎是为了让引擎侧（如日志器的错误摘要）也能复用同一份规则，
 * 前端 `turn-failure.ts` 改为从这里 import。
 *
 * 🔴 这是**启发式**（含「32 位以上长串一律抹掉」），只适合给人看的短错误文本。
 *    不要拿它处理提示词 / 响应全文 —— 会把正文里的 UUID、哈希一并抹掉。
 *    引擎日志的 payload 只做登记密钥的精确替换（见 `runtime/engine-logger.ts`）。
 */

/**
 * 抹掉可能出现在错误原文里的凭据：Authorization / Bearer 头、`sk-` 一类密钥、
 * `api_key=` / `key=` 查询参数、以及 32 位以上的长令牌串。宁可多抹，不可漏抹。
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [已隐藏]')
    .replace(
      /(authorization|x-api-key|api-key)\s*[:=]\s*"?(?!Bearer \[已隐藏\])[^\s",}]+"?/gi,
      '$1: [已隐藏]',
    )
    .replace(/([?&](?:api[_-]?key|key|token|access_token)=)[^&\s"']+/gi, '$1[已隐藏]')
    .replace(/("?(?:api[_-]?key|token|secret)"?\s*[:=]\s*"?)[^\s",}]+/gi, '$1[已隐藏]')
    .replace(/\b(?:sk|pk|rk|ak)-[A-Za-z0-9_*.-]{6,}/g, '[已隐藏的密钥]')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[已隐藏]');
}
