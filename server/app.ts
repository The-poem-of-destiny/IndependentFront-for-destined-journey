import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { chatRoutes } from './routes/chat'
import { statusRoutes } from './routes/status'
import { embeddingsRoutes } from './routes/embeddings'
import { modelsRoutes } from './routes/models'

/**
 * BFF Hono app —— dev（vite middleware）与未来 prod（独立 server）共享同一份路由代码。
 *
 * 路由契约见 docs/planning/2026-07-30-bff-api-refactor-plan.md §5。
 * 透传模式：前端持 key，BFF 只做"加 CORS 头的 fetch 转发器"，零状态。
 */
export function buildHonoApp(): Hono {
  const app = new Hono()

  // CORS 兜底：同源下不触发预检，跨端口/跨设备访问时放行
  app.use('*', cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-Target-Base-URL', 'api-key'],
    exposeHeaders: ['Content-Type'],
  }))

  app.route('/api/chat', chatRoutes)
  app.route('/api/status', statusRoutes)
  app.route('/api/embeddings', embeddingsRoutes)
  app.route('/api/models', modelsRoutes)

  return app
}
