import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { buildHonoApp, isBffRoute, isOpaqueSandboxOrigin, OPAQUE_ORIGIN_ERROR } from './app';

/**
 * 便携版（portable zip）独立服务器的 Hono app —— 纯函数装配，不监听端口、不碰 process。
 * 副作用入口（监听/开浏览器/退出码）在 `standalone.ts`；本文件只负责「一个请求怎么处理」，
 * 以便单测直接 `app.request()`。
 *
 * 🔴 源（origin）永久固定为 `http://127.0.0.1:15173`：IndexedDB 存档按源隔离，
 *    换端口或换主机名 = 玩家「存档全没了」。所以 `localhost:15173` 也要 308 回规范源，
 *    而不是同样放行 —— 两个主机名是两个源，各自一份 IndexedDB。
 */
export const STANDALONE_BIND = '127.0.0.1';
export const STANDALONE_PORT = 15173;
export const STANDALONE_ORIGIN = `http://${STANDALONE_BIND}:${STANDALONE_PORT}`;

const CANONICAL_HOST = `${STANDALONE_BIND}:${STANDALONE_PORT}`;
const LOCALHOST_ALIAS = `localhost:${STANDALONE_PORT}`;

/** 与 `server/routes/status.ts` 的 `service` 字段逐字一致：探测「端口上是不是我们自己」 */
const BFF_SERVICE_ID = 'fated-poem-bff';

/**
 * 便携版在 `/api/status` 响应上额外带的版本头：端口探测据此区分「同一版本已在运行」与
 * 「另一个版本（多半是升级前的旧版）还开着」。只加在 standalone 外壳上，共享 BFF 的
 * `/api/status` 契约（dev / preview 也在用）不变。
 */
export const ENGINE_VERSION_HEADER = 'X-Poem-Engine-Version';

const CROSS_ORIGIN_ERROR = 'cross-origin requests are not allowed';

const IMMUTABLE_CACHE = 'public, max-age=31536000, immutable';
const NO_CACHE = 'no-cache';

export interface StandaloneAppOptions {
  /** 构建产物 SPA 所在目录（便携包里是 `app/web/`） */
  webRoot: string;
  /** 本程序版本（便携包里取自 `app/build-info.json` 的 version），经 {@link ENGINE_VERSION_HEADER} 暴露 */
  engineVersion: string;
}

function isReadMethod(method: string): boolean {
  return method === 'GET' || method === 'HEAD';
}

/** 末段不含 `.` 视为 SPA 路由（`/game/play`），带扩展名的缺失文件一律 404，不回 index.html */
function isExtensionlessPath(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return !lastSegment.includes('.');
}

/**
 * 把 serveStatic 当「找得到就回 Response、找不到就回 undefined」的函数用。
 * 命中时在已生成的 Response 上补 Cache-Control —— 不能先 `c.header()` 再交给它，
 * 否则未命中落到 404 时也会带上 immutable 缓存头。
 */
async function tryServe(
  handler: MiddlewareHandler,
  c: Parameters<MiddlewareHandler>[0],
  cacheControl: string,
): Promise<Response | undefined> {
  const res = await handler(c, async () => {});
  if (!res) return undefined;
  res.headers.set('Cache-Control', cacheControl);
  return res;
}

export function buildStandaloneApp(options: StandaloneAppOptions): Hono {
  const { webRoot, engineVersion } = options;
  const app = new Hono();
  const bff = buildHonoApp({ contentDir: null });
  // serveStatic 自带：按扩展名给 Content-Type（.wasm → application/wasm）、Range → 206、
  // 拒绝 `..` / 反斜杠路径、目录请求落到 index.html
  const staticFiles = serveStatic({ root: webRoot });
  const indexHtml = serveStatic({ root: webRoot, path: 'index.html' });

  // 1) 主机名闸门：防 DNS rebinding，同时把 localhost 别名收敛到唯一的规范源
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (url.host === CANONICAL_HOST) return next();
    if (url.host === LOCALHOST_ALIAS) {
      return c.redirect(`${STANDALONE_ORIGIN}${url.pathname}${url.search}`, 308);
    }
    return c.text('Forbidden', 403);
  });

  // 2) /api/* 的来源闸门：沙盒 iframe（Origin: null）与任何外站都不许借用本机 BFF
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('Origin');
    if (isOpaqueSandboxOrigin(origin)) {
      return c.json({ error: OPAQUE_ORIGIN_ERROR }, 403);
    }
    if (origin !== undefined && origin !== STANDALONE_ORIGIN) {
      return c.json({ error: CROSS_ORIGIN_ERROR }, 403);
    }
    await next();
  });

  // 3) BFF 路由：前缀判据与 vite dev / preview 共用 `isBffRoute`，不另抄清单
  // 4) 其余 /api/* 回 JSON 404，绝不落到 SPA 兜底
  app.all('/api/*', async (c) => {
    if (!isBffRoute(c.req.path)) return c.json({ error: 'not found' }, 404);
    const res = await bff.fetch(c.req.raw, c.env);
    if (c.req.path !== '/api/status') return res;
    // 复制一份再加头：不假设 BFF 回来的 Response 头可写
    const tagged = new Response(res.body, res);
    tagged.headers.set(ENGINE_VERSION_HEADER, engineVersion);
    return tagged;
  });

  // 5) 静态资源：Vite 产物 /assets/* 文件名带内容哈希，可永久缓存；其余（index.html 等）每次协商
  app.use('*', async (c, next) => {
    if (!isReadMethod(c.req.method)) return next();
    const cacheControl = c.req.path.startsWith('/assets/') ? IMMUTABLE_CACHE : NO_CACHE;
    const res = await tryServe(staticFiles, c, cacheControl);
    if (res) return res;
    await next();
  });

  // 6) SPA 兜底：无扩展名的 GET/HEAD 回 index.html，其余一律非 HTML 的 404
  app.all('*', async (c) => {
    if (isReadMethod(c.req.method) && isExtensionlessPath(c.req.path)) {
      const res = await tryServe(indexHtml, c, NO_CACHE);
      if (res) return res;
    }
    return c.text('Not Found', 404);
  });

  return app;
}

/**
 * - `ours`：同一版本的本程序已在运行（只需重新打开浏览器）
 * - `ours-other-version`：是本程序，但版本不同（或旧版没有版本头）—— 多半是升级后旧窗口还开着
 * - `foreign`：别的程序，或探测失败
 */
export type ProbeResult = 'ours' | 'ours-other-version' | 'foreign';

/**
 * 端口被占时判断占用者是谁：`/api/status` 回本 BFF 的 JSON 才算本程序，再按
 * {@link ENGINE_VERSION_HEADER} 与自己的版本逐字比较；其余（连不上、超时、非 JSON、别的服务）
 * 一律「foreign」。只读探测，绝不结束任何进程。
 */
export async function probeExistingInstance(
  origin: string,
  ownVersion: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProbeResult> {
  try {
    const res = await fetchImpl(`${origin}/api/status`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return 'foreign';
    const body: unknown = await res.json();
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { ok?: unknown }).ok === true &&
      (body as { service?: unknown }).service === BFF_SERVICE_ID
    ) {
      return res.headers.get(ENGINE_VERSION_HEADER) === ownVersion ? 'ours' : 'ours-other-version';
    }
    return 'foreign';
  } catch {
    return 'foreign';
  }
}
