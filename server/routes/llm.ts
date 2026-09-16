import { Hono } from 'hono';
import type { Context } from 'hono';
import { forward } from './proxy';

const app = new Hono();

const PROTOCOLS = new Set(['openai-chat', 'gemini', 'anthropic-messages']);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;
const PAGE_TOKEN = /^[^\u0000-\u001F\u007F]{1,500}$/u;

function readProtocol(raw: string): string | null {
  return PROTOCOLS.has(raw) ? raw : null;
}

function geminiModel(c: Context): string | Response {
  const raw = (c.req.header('X-Model-ID') ?? '').trim().replace(/^models\//u, '');
  if (!MODEL_ID.test(raw)) return c.json({ error: 'invalid or missing X-Model-ID' }, 400);
  return raw;
}

app.post('/:protocol/generate', (c) => {
  const protocol = readProtocol(c.req.param('protocol'));
  if (!protocol) return c.json({ error: 'unsupported LLM protocol' }, 404);
  if (protocol === 'openai-chat') return forward(c, '/chat/completions');
  if (protocol === 'anthropic-messages') return forward(c, '/messages');
  const model = geminiModel(c);
  if (model instanceof Response) return model;
  const operation =
    c.req.header('X-LLM-Stream') === 'true' ? 'streamGenerateContent?alt=sse' : 'generateContent';
  return forward(c, `/models/${encodeURIComponent(model)}:${operation}`);
});

app.get('/:protocol/models', (c) => {
  const protocol = readProtocol(c.req.param('protocol'));
  if (!protocol) return c.json({ error: 'unsupported LLM protocol' }, 404);
  const pageToken = c.req.query('pageToken')?.trim();
  if (pageToken && !PAGE_TOKEN.test(pageToken)) {
    return c.json({ error: 'invalid pageToken' }, 400);
  }
  if (!pageToken) return forward(c, '/models');
  const key =
    protocol === 'gemini' ? 'pageToken' : protocol === 'anthropic-messages' ? 'after_id' : 'after';
  return forward(c, `/models?${key}=${encodeURIComponent(pageToken)}`);
});

export { app as llmRoutes };
