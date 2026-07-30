import { Hono } from 'hono'
import { forward } from './proxy'

const app = new Hono()

/**
 * POST /api/embeddings — 向量嵌入透传。
 * 上游：${X-Target-Base-URL}/embeddings
 */
app.post('/', (c) => forward(c, '/embeddings'))

export { app as embeddingsRoutes }
