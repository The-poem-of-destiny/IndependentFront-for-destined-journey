import type { Context } from 'hono';

/**
 * 透传时剥离的 hop-by-hop / 分块响应头。
 * PR #4 踩过坑：上游的 transfer-encoding/content-length 会与 BFF 自身分块冲突，必须剥掉。
 */
const STRIP_RESP_HEADERS = new Set([
  'transfer-encoding',
  'content-length',
  // Node fetch transparently decompresses gzip/deflate/br but keeps this
  // upstream header. Forwarding it makes the browser decode plain bytes again.
  'content-encoding',
  'connection',
  'keep-alive',
]);

/**
 * 🔒 P1-03 SSRF 黑名单 —— 云厂商元数据端点，可泄露实例凭据（IMDSv1 尤其危险）。
 *
 * 不拒绝 localhost / 私有 IP：本地 LLM（ollama:11434 等）需要它们。这是同源 BFF
 * （key 前端持有，非多租户云服务），且模型 XSS 已修（P1-01），不存在
 * 「同源攻击代码读代理响应」的组合链。若将来上云多租户，需改为 DNS 解析后
 * 逐 IP 校验私有/loopback/link-local 段，并在解析后二次校验防 DNS rebinding。
 */
const SSRF_BLOCKLIST = new Set([
  '169.254.169.254', // AWS / GCP / Azure IMDS（IPv4）
  'fd00:ec2::254', // AWS IMDS（IPv6）
  'metadata.google.internal',
  'metadata.azure.com',
]);

export function stripHopHeaders(src: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  src.forEach((v, k) => {
    if (!STRIP_RESP_HEADERS.has(k.toLowerCase())) out[k] = v;
  });
  return out;
}

/**
 * 透传到上游 OpenAI 兼容端点 —— 无状态转发器（透传模式，见方案 §4.1）。
 *
 * - baseUrl 取自 `X-Target-Base-URL` header（key 仍前端持有，SillyTavern 模式）
 * - `Authorization` / `api-key`(Azure 风格) 透传给上游
 * - body 与 SSE 流管道转发，不缓冲（支持 stream:true）
 */
export async function forward(c: Context, suffix: string): Promise<Response> {
  const baseRaw = c.req.header('X-Target-Base-URL');
  const base = baseRaw?.trim().replace(/\/+$/, '');
  if (!base) {
    return c.json({ error: "missing 'X-Target-Base-URL' header" }, 400);
  }
  if (!/^https?:\/\//i.test(base)) {
    return c.json({ error: 'invalid X-Target-Base-URL (must start with http/https)' }, 400);
  }

  // 🔒 P1-03 SSRF 防护：拒绝云元数据端点（见 SSRF_BLOCKLIST 注释）
  const host = (() => {
    try {
      return new URL(base).hostname;
    } catch {
      return '';
    }
  })();
  if (SSRF_BLOCKLIST.has(host)) {
    return c.json({ error: 'blocked target by SSRF protection' }, 403);
  }

  const headers: Record<string, string> = {
    'Content-Type': c.req.header('Content-Type') || 'application/json',
    Accept: c.req.header('Accept') || 'application/json',
  };
  const auth = c.req.header('Authorization');
  if (auth) headers['Authorization'] = auth;
  const apiKey = c.req.header('api-key'); // Azure 风格
  if (apiKey) headers['api-key'] = apiKey;

  let upstream: Response;
  try {
    const reqBody = c.req.raw.body;
    const streaming = !!reqBody && c.req.method !== 'GET' && c.req.method !== 'HEAD';
    upstream = await fetch(`${base}${suffix}`, {
      method: c.req.method,
      headers,
      ...(streaming ? { body: reqBody, duplex: 'half' as const } : {}),
    });
  } catch (e) {
    return c.json({ error: `upstream unreachable: ${(e as Error).message}` }, 502);
  }

  // 上游 body（ReadableStream）直接管道转发，SSE 不缓冲
  return new Response(upstream.body, {
    status: upstream.status,
    headers: stripHopHeaders(upstream.headers),
  });
}
