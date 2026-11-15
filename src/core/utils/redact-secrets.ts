/**
 * 凭据脱敏（插件系统设计 §4.5 / §5.2）。纯函数，零依赖。
 *
 * 原先只在 `src/ui/lib/turn-failure.ts` 里给「技术详情」用；插件的 `messages` 读投影也要
 * 过同一道（正文里可能被玩家或模型贴进密钥，插件联网后漏出去就收不回来），所以搬进引擎，
 * 前端那边留转发。两处口径因此只有一份。
 */

/**
 * 抹掉可能出现在文本里的凭据：Authorization / Bearer 头、`sk-` 一类密钥、
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
