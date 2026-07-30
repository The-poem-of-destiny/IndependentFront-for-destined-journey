import type { Context } from 'hono'

/**
 * 透传时剥离的 hop-by-hop / 分块响应头。
 * PR #4 踩过坑：上游的 transfer-encoding/content-length 会与 BFF 自身分块冲突，必须剥掉。
 */
const STRIP_RESP_HEADERS = new Set([
  'transfer-encoding',
  'content-length',
  'connection',
  'keep-alive',
])

export function stripHopHeaders(src: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  src.forEach((v, k) => {
    if (!STRIP_RESP_HEADERS.has(k.toLowerCase())) out[k] = v
  })
  return out
}

/**
 * 透传到上游 OpenAI 兼容端点 —— 无状态转发器（透传模式，见方案 §4.1）。
 *
 * - baseUrl 取自 `X-Target-Base-URL` header（key 仍前端持有，SillyTavern 模式）
 * - `Authorization` / `api-key`(Azure 风格) 透传给上游
 * - body 与 SSE 流管道转发，不缓冲（支持 stream:true）
 */
export async function forward(c: Context, suffix: string): Promise<Response> {
  const baseRaw = c.req.header('X-Target-Base-URL')
  const base = baseRaw?.trim().replace(/\/+$/, '')
  if (!base) {
    return c.json({ error: "missing 'X-Target-Base-URL' header" }, 400)
  }
  if (!/^https?:\/\//i.test(base)) {
    return c.json({ error: 'invalid X-Target-Base-URL (must start with http/https)' }, 400)
  }

  const headers: Record<string, string> = {
    'Content-Type': c.req.header('Content-Type') || 'application/json',
    Accept: c.req.header('Accept') || 'application/json',
  }
  const auth = c.req.header('Authorization')
  if (auth) headers['Authorization'] = auth
  const apiKey = c.req.header('api-key') // Azure 风格
  if (apiKey) headers['api-key'] = apiKey

  let upstream: Response
  try {
    const reqBody = c.req.raw.body
    const streaming = !!reqBody && c.req.method !== 'GET' && c.req.method !== 'HEAD'
    upstream = await fetch(`${base}${suffix}`, {
      method: c.req.method,
      headers,
      ...(streaming ? { body: reqBody, duplex: 'half' as const } : {}),
    })
  } catch (e) {
    return c.json({ error: `upstream unreachable: ${(e as Error).message}` }, 502)
  }

  // 上游 body（ReadableStream）直接管道转发，SSE 不缓冲
  return new Response(upstream.body, {
    status: upstream.status,
    headers: stripHopHeaders(upstream.headers),
  })
}
