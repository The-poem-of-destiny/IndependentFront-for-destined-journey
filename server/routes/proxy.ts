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
  '::ffff:169.254.169.254', // IMDS 的 IPv4-mapped IPv6 形态（点分）
  '::ffff:a9fe:a9fe', // IMDS 的 IPv4-mapped IPv6 形态（hex，Node URL 规范化的样子）
  'metadata.google.internal',
  'metadata.azure.com',
]);

/**
 * 🔒 F11：把 URL.hostname 归一化成黑名单可比的权威形式。
 *
 * Node 的 URL.hostname 对 IPv6 字面量**带方括号**返回（`[fd00:ec2::254]`），而
 * SSRF_BLOCKLIST 存的是无括号地址 —— 直接 `.has(hostname)` 永远比不中，等于
 * IPv6 项整行失效（P1-03 的漏网）。这里剥括号 + 小写归一，使带不带括号、
 * 大小写都落到同一个面。
 *
 * IPv4-mapped IPv6（`::ffff:169.254.169.254`）不在这里折叠 —— Node 的 URL
 * 会把它保留成 IPv6 字面量形态；若要防映射地址也需要显式覆盖（见测试）。
 */
function normalizeHostname(hostname: string): string {
  let h = hostname.trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  return h;
}

/** 黑名单判定（F11 归一化版本） */
function isBlocked(llmTargetHost: string): boolean {
  return SSRF_BLOCKLIST.has(normalizeHostname(llmTargetHost));
}

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
  const trimmed = baseRaw?.trim();
  if (!trimmed) {
    return c.json({ error: "missing 'X-Target-Base-URL' header" }, 400);
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    return c.json({ error: 'invalid X-Target-Base-URL (must start with http/https)' }, 400);
  }

  // 🔒 SEC-09（2026-08-09 审查实测）：base 必须先规范化掉 query 与 fragment，再拼 suffix。
  //
  // 上游 URL 是 `${base}${suffix}` 的**字符串直接相加**，而各路由（尤其 image.ts 的 comfy
  // 三条）依赖「suffix 由服务端决定」来限定上游路径。这个依赖此前不成立：base 末尾放一个
  // `#`，整段 suffix 就落进 fragment、永远不会发给服务端 ——
  //   base   = http://127.0.0.1:5173/data/C:/Users/x/.ssh/id_rsa#
  //   suffix = /view?filename=x
  //   → pathname = /data/C:/Users/x/.ssh/id_rsa，hostname 仍是 127.0.0.1（黑名单只查这个）
  // 于是 BFF 从「只能打上游 API 的固定几条路径」变成任意主机 + 任意路径的取回器。
  //
  // 这里**规范化而不是拒绝**：能走到这一步的 base 本来就带不了合法的 query/fragment
  // （拼上 suffix 之后必然是垃圾 URL），剃掉它们不会弄坏任何一次真实调用。
  // 用 `parsed.href` 而不是 `origin + pathname` —— 后者会丢掉 userinfo。
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return c.json({ error: 'invalid X-Target-Base-URL (unparsable)' }, 400);
  }
  parsed.search = '';
  parsed.hash = '';
  const base = parsed.href.replace(/\/+$/, '');

  // 🔒 P1-03 SSRF 防护：拒绝云元数据端点（见 SSRF_BLOCKLIST 注释）；F11 归一化，
  //   IPv6 字面量带/不带括号、大小写都命中同一黑名单项。
  if (isBlocked(parsed.hostname)) {
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
    // F11：默认拒绝上游 3xx。fetch 的 redirect:'follow' 会在无策略复核的情况下跟去
    // 任意 Location —— 黑名单只在初始目的地验过一次，跟随后的目标可绕过 SSRF 防护。
    // 明确要求 final provider base URL 本身，而不是透传一个会引走请求的 3xx。
    upstream = await fetch(`${base}${suffix}`, {
      method: c.req.method,
      headers,
      redirect: 'manual',
      ...(streaming ? { body: reqBody, duplex: 'half' as const } : {}),
    });
  } catch (e) {
    // undici 的 fetch 失败时抛 TypeError("fetch failed")，真因（ECONNRESET /
    // ENOTFOUND / ETIMEDOUT / 证书错 等）在 e.cause 里。只读 .message 会丢掉
    // 这层关键信息，把 cause.code / cause.message 拼进去回给前端 + 打 server 日志。
    const err = e as { message?: string; cause?: { code?: string; message?: string } };
    const cause = err?.cause;
    const detail = cause ? (cause.code ?? cause.message ?? String(cause)) : '';
    const reason = detail
      ? `${err?.message ?? 'fetch error'}: ${detail}`
      : (err?.message ?? String(e));
    console.error('[proxy] upstream fetch failed:', {
      target: `${base}${suffix}`,
      method: c.req.method,
      message: err?.message,
      cause: cause ? { code: cause.code, message: cause.message } : undefined,
    });
    return c.json({ error: `upstream unreachable: ${reason}` }, 502);
  }

  // F11：manual 模式下 3xx 不外发。透传给客户端一个会自带的 302/307，客户端 fetch
  // 仍会跟随 —— 等于绕过本端策略。改为显式策略错误，提示用户直接在
  // X-Target-Base-URL 配置最终地址。
  if (upstream.status >= 300 && upstream.status < 400) {
    return c.json(
      {
        error: `upstream redirect (${upstream.status}) rejected by proxy redirect policy; configure the final base URL directly`,
      },
      502,
    );
  }

  // 上游 body（ReadableStream）直接管道转发，SSE 不缓冲
  return new Response(upstream.body, {
    status: upstream.status,
    headers: stripHopHeaders(upstream.headers),
  });
}
