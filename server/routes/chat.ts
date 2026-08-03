import { Hono } from 'hono';
import { forward } from './proxy';

const app = new Hono();

/**
 * POST /api/chat/completions — chat 透传（支持 stream:true SSE）。
 * 上游：${X-Target-Base-URL}/chat/completions
 */
app.post('/completions', (c) => forward(c, '/chat/completions'));

/**
 * POST /api/chat/test — 连通性 ping（前端塞小 body：{messages:[hi], max_tokens:1}）。
 * 独立路由，语义清晰（见方案 §5.1）。
 */
app.post('/test', (c) => forward(c, '/chat/completions'));

export { app as chatRoutes };
