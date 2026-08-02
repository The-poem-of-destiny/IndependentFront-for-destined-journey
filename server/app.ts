import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { chatRoutes } from './routes/chat';
import { statusRoutes } from './routes/status';
import { embeddingsRoutes } from './routes/embeddings';
import { modelsRoutes } from './routes/models';

export const OPAQUE_ORIGIN_ERROR = 'opaque sandbox origins cannot access application APIs';

export function isOpaqueSandboxOrigin(origin: string | undefined): boolean {
  return origin?.trim().toLowerCase() === 'null';
}

/**
 * BFF Hono app —— dev（vite middleware）与未来 prod（独立 server）共享同一份路由代码。
 *
 * 路由契约见 docs/planning/2026-07-30-bff-api-refactor-plan.md §5。
 * 透传模式：前端持 key，BFF 只做"加 CORS 头的 fetch 转发器"，零状态。
 */
export function buildHonoApp(): Hono {
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

  app.route('/api/chat', chatRoutes);
  app.route('/api/status', statusRoutes);
  app.route('/api/embeddings', embeddingsRoutes);
  app.route('/api/models', modelsRoutes);

  return app;
}
