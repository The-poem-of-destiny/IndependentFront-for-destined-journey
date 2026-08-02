/**
 * workshop-upstream-error.ts — 上游错误响应体 → 一句人话（Phase 4 / 对齐上游）
 *
 * 移植自上游工坊页 `cloudflare/src/pages/home/api.ts` 的 `resolveApiErrorMessage`，
 * 保留它的**判定顺序**，但把结构化 JSON 那一档换成我们自己更细的读法。
 *
 * 为什么要单独一层: 上游跑在 Cloudflare Worker 上，它挂掉的方式有一大半**不是**
 * 我们的接口在报错，而是平台在报错 —— 这时响应体要么是 Cloudflare 的 HTML 拦截页，
 * 要么是一串只有错误码有意义的纯文本。`readUpstreamError` 那条 JSON 路径对它们
 * 一个字都读不出来，用户只能看到「上游返回 500」，而真相是「今天的额度用完了」。
 *
 * 判定顺序照抄上游（**平台错误优先于业务错误**）:
 *
 * 1. `1027` —— Worker 日额度耗尽。整个服务今天都不会好，重试没有意义
 * 2. `1102` / `Worker exceeded resource limits` —— 单次执行超了 CPU/内存
 * 3. `429` 或限流字样 —— 频率限制，等一会儿有用
 * 4. 结构化 JSON（`error` / `message` / `errors[]`）—— 我们的读法比上游细，故保留
 * 5. HTML 拦截页 —— 认出来就别把标签糊到用户脸上
 * 6. 纯文本 —— 截 300 字
 *
 * ⚠️ 1 和 2 必须排在 4 前面: Cloudflare 的错误体有时**也是** JSON 且带 `message`，
 * 但那句 message 是给运维看的英文栈信息。先认错误码才能给出「这不是你的问题」。
 *
 * 纯度约束: 无 Vue、无 store、无 I/O。
 */

/** Cloudflare 日额度耗尽 —— 今天不会好了，别劝用户重试 */
const CF_QUOTA_EXHAUSTED = /\b1027\b/;
/** 单次执行超限 —— 换个更小的请求可能有用 */
const CF_RESOURCE_LIMIT = /\b1102\b|Worker exceeded resource limits/i;
/** 限流字样 —— 上游没有统一错误码，只能靠串认 */
const RATE_LIMITED = /rate limit|too many requests|quota|limit exceeded/i;

/** 一眼认出 Cloudflare / worker 的 HTML 拦截页 */
function looksLikeHtml(text: string): boolean {
  const head = text.slice(0, 200).toLowerCase();
  return (
    head.startsWith('<!doctype html') ||
    head.startsWith('<html') ||
    head.includes('<body') ||
    text.toLowerCase().includes('</html>')
  );
}

/**
 * 平台级失败的判定 —— 只看**状态码与原始文本**，不碰 JSON 结构。
 *
 * 返回 `undefined` 表示「这不是平台错误」，调用方继续走业务错误的读法。
 * 单独导出是为了让调用点能把它排在结构化读法**之前**（见本文件顶部第 4 条）。
 */
export function describePlatformFailure(status: number, rawText: string): string | undefined {
  const text = (rawText ?? '').trim();

  if (CF_QUOTA_EXHAUSTED.test(text)) return '创意工坊今天的服务额度用尽了，明天再来试试。';
  if (CF_RESOURCE_LIMIT.test(text)) return '创意工坊的服务资源超限了，稍后再试一次。';
  if (status === 429 || RATE_LIMITED.test(text)) return '请求太频繁了，歇一会儿再试。';

  return undefined;
}

/**
 * 兜底读法 —— 结构化读法与平台判定都没结果时才轮到它。
 *
 * HTML 拦截页返回一句固定话（把 `<!DOCTYPE html>` 原样贴给用户毫无意义）；
 * 纯文本截 300 字后原样交出去 —— 上游偶尔会在纯文本里放唯一能自救的那句话。
 */
export function describeRawBody(rawText: string): string | undefined {
  const text = (rawText ?? '').trim();
  if (!text) return undefined;
  if (looksLikeHtml(text)) return '创意工坊暂时不可用，稍后再试。';
  return text.slice(0, 300);
}
