import { Hono } from 'hono';
import { forward } from './proxy';

const app = new Hono();

app.post('/', (c) => forward(c, '/rerank'));

export { app as rerankRoutes };
