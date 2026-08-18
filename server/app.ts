import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatRoutes } from './routes/chat';
import { statusRoutes } from './routes/status';
import { embeddingsRoutes } from './routes/embeddings';
import { modelsRoutes } from './routes/models';
import { imageRoutes } from './routes/image';
import { createContentWriteRoutes } from './routes/content';

export const OPAQUE_ORIGIN_ERROR = 'opaque sandbox origins cannot access application APIs';

export function isOpaqueSandboxOrigin(origin: string | undefined): boolean {
  return origin?.trim().toLowerCase() === 'null';
}

export interface BffAppOptions {
  /**
   * 真实内容 overlay 目录（`POEM_CONTENT_DIR` 解析后的绝对路径）。
   * `null` / 缺省 = 未配置：两条写回路由一律回 501（见 `routes/content.ts`）。
   */
  contentDir?: string | null;
}

interface BffRouteEntry {
  readonly prefix: string;
  readonly create: (options: Required<BffAppOptions>) => Hono;
}

/**
 * BFF 路由表 —— **前缀清单的唯一真源**。
 *
 * 🔴 加一条 BFF 路由只改这张表：`app.route()` 的挂载与 `BFF_ROUTE_PREFIXES`
 *    都从它派生，`vite.config.ts` 的 dev / preview 两处中间件直接 import
 *    `isBffRoute` 来判前缀。此前这份五前缀白名单在 vite 里被**逐字抄了两遍**，
 *    与本文件合计三处手工同步 —— 漏改的症状是「代码看着完全正确，请求 404」。
 */
const BFF_ROUTE_TABLE: readonly BffRouteEntry[] = [
  { prefix: '/api/chat', create: () => chatRoutes },
  { prefix: '/api/status', create: () => statusRoutes },
  { prefix: '/api/embeddings', create: () => embeddingsRoutes },
  { prefix: '/api/models', create: () => modelsRoutes },
  { prefix: '/api/image', create: () => imageRoutes },
  {
    prefix: '/api/worldbooks',
    create: ({ contentDir }) => createContentWriteRoutes({ contentDir, subDir: 'worldbooks' }),
  },
  {
    prefix: '/api/defaults',
    create: ({ contentDir }) =>
      createContentWriteRoutes({ contentDir, subDir: 'defaults', fallbackName: 'agent-config' }),
  },
];

/** BFF 管辖的全部路由前缀（派生自 `BFF_ROUTE_TABLE`，勿另抄一份） */
export const BFF_ROUTE_PREFIXES: readonly string[] = BFF_ROUTE_TABLE.map((entry) => entry.prefix);

/**
 * 这条 URL 归不归 BFF 管 —— vite 的 dev / preview 两处中间件共用同一判据。
 *
 * 判据仍是**前缀匹配**（与被替换掉的那两份白名单逐字等价）：`/api/chatxyz`
 * 照旧算命中，交给 hono 自己回 404。
 */
export function isBffRoute(url: string): boolean {
  return BFF_ROUTE_PREFIXES.some((prefix) => url.startsWith(prefix));
}

/**
 * BFF Hono app —— dev（vite middleware）与未来 prod（独立 server）共享同一份路由代码。
 *
 * 路由契约见 docs/planning/2026-07-30-bff-api-refactor-plan.md §5。
 * 透传模式：前端持 key，BFF 只做"加 CORS 头的 fetch 转发器"，零状态 ——
 * 唯一的例外是 `contentDir` 那两条写回路由（内容 overlay，见 `routes/content.ts`）。
 */
export function buildHonoApp(options: BffAppOptions = {}): Hono {
  const resolved: Required<BffAppOptions> = { contentDir: options.contentDir ?? null };
  const app = new Hono();

  // Sandboxed srcdoc frames intentionally send `Origin: null`. They may use
  // the public network, but must not turn the app's credential-forwarding BFF
  // into a local-network proxy.
  app.use('*', async (c, next) => {
    if (isOpaqueSandboxOrigin(c.req.header('Origin'))) {
      return c.json({ error: OPAQUE_ORIGIN_ERROR }, 403);
    }
    await next();
  });

  // CORS 兜底：同源下不触发预检，跨端口/跨设备访问时放行
  app.use(
    '*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Target-Base-URL', 'api-key'],
      exposeHeaders: ['Content-Type'],
    }),
  );

  for (const entry of BFF_ROUTE_TABLE) {
    app.route(entry.prefix, entry.create(resolved));
  }

  return app;
}
