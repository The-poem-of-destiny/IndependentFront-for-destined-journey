import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { brotliCompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildHonoApp, OPAQUE_ORIGIN_ERROR } from '../server/app';

describe('BFF origin boundary', () => {
  it('rejects requests from opaque sandbox origins before routing', async () => {
    const response = await buildHonoApp().request('/api/status', {
      headers: { Origin: 'null' },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: OPAQUE_ORIGIN_ERROR });
  });

  it('keeps ordinary app origins working', async () => {
    const response = await buildHonoApp().request('/api/status', {
      headers: { Origin: 'http://localhost:5173' },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, service: 'fated-poem-bff' });
  });
});

describe('BFF response encoding boundary', () => {
  it('does not advertise Brotli after Node fetch has decoded the upstream body', async () => {
    const payload = JSON.stringify({ choices: [{ message: { content: 'ok' } }] });
    const compressed = brotliCompressSync(Buffer.from(payload));
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'application/json',
          'Content-Encoding': 'br',
        });
        response.end(compressed);
      });
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = upstream.address() as AddressInfo;
      const response = await buildHonoApp().request('/api/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Target-Base-URL': `http://127.0.0.1:${address.port}`,
        },
        body: JSON.stringify({ messages: [], stream: false }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ choices: [{ message: { content: 'ok' } }] });
      expect(response.headers.get('content-encoding')).toBeNull();
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
