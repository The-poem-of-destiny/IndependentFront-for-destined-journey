import { Hono } from 'hono'

const app = new Hono()

/** GET /api/status — BFF 自身存活检测（chatbox 类项目通用）。 */
app.get('/', (c) => c.json({
  ok: true,
  service: 'fated-poem-bff',
  ts: Date.now(),
}))

export { app as statusRoutes }
