import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { buildHonoApp } from '../server/app';

const servers: Array<ReturnType<typeof createServer>> = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

async function echoServer(): Promise<string> {
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      response.setHeader('Content-Type', 'application/json');
      response.end(
        JSON.stringify({
          url: request.url,
          authorization: request.headers.authorization,
          googleKey: request.headers['x-goog-api-key'],
          anthropicKey: request.headers['x-api-key'],
          anthropicVersion: request.headers['anthropic-version'],
          anthropicBeta: request.headers['anthropic-beta'],
        }),
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('protocol-aware LLM BFF', () => {
  it.each([
    ['openai-chat', '/chat/completions', { Authorization: 'Bearer openai-key' }],
    [
      'anthropic-messages',
      '/messages',
      {
        'x-api-key': 'claude-key',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'tools-2024-04-04',
      },
    ],
  ])('maps %s generation to its fixed path and headers', async (protocol, path, authHeaders) => {
    const base = await echoServer();
    const response = await buildHonoApp().request(`/api/llm/${protocol}/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Target-Base-URL': base,
        ...authHeaders,
      },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ url: path });
  });

  it('maps Gemini generation and streaming to a validated model resource', async () => {
    const base = await echoServer();
    for (const [stream, expected] of [
      ['false', '/models/gemini-2.5-flash:generateContent'],
      ['true', '/models/gemini-2.5-flash:streamGenerateContent?alt=sse'],
    ] as const) {
      const response = await buildHonoApp().request('/api/llm/gemini/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Base-URL': base,
          'X-Model-ID': 'models/gemini-2.5-flash',
          'X-LLM-Stream': stream,
          'x-goog-api-key': 'gemini-key',
        },
        body: '{}',
      });
      expect(await response.json()).toMatchObject({ url: expected, googleKey: 'gemini-key' });
    }
  });

  it('rejects arbitrary Gemini model paths and maps controlled pagination tokens', async () => {
    const base = await echoServer();
    const invalid = await buildHonoApp().request('/api/llm/gemini/generate', {
      method: 'POST',
      headers: { 'X-Target-Base-URL': base, 'X-Model-ID': '../secrets' },
      body: '{}',
    });
    expect(invalid.status).toBe(400);

    const page = await buildHonoApp().request(
      '/api/llm/anthropic-messages/models?pageToken=model_2',
      {
        headers: { 'X-Target-Base-URL': base, 'x-api-key': 'claude-key' },
      },
    );
    expect(await page.json()).toMatchObject({ url: '/models?after_id=model_2' });

    const opaquePage = await buildHonoApp().request(
      '/api/llm/gemini/models?pageToken=opaque%2Btoken%2F%3D',
      { headers: { 'X-Target-Base-URL': base, 'x-goog-api-key': 'gemini-key' } },
    );
    expect(await opaquePage.json()).toMatchObject({
      url: '/models?pageToken=opaque%2Btoken%2F%3D',
    });
  });
});
