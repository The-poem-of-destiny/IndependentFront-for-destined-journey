import { Hono } from 'hono'
import { forward } from './proxy'

const app = new Hono()

/**
 * GET /api/models — 模型列表透传（Bearer / api-key 两种鉴权由前端在 header 里带）。
 * 上游：${X-Target-Base-URL}/models
 */
app.get('/', (c) => forward(c, '/models'))

export { app as modelsRoutes }
