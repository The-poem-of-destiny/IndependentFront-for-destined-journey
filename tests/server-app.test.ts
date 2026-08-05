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

describe('BFF image passthrough', () => {
  // 🔴 图像生成 v1 §12.1: /api/image/generate 必须复用 forward() 的管道直通。
  // 任何一条会 `await res.json()` / `res.text()` 的实现都会在非法 UTF-8 字节处
  // 塞进 U+FFFD 把 zip 悄悄读坏 —— 不报错，只是解不开。本用例喂的正是一段
  // 全非法 UTF-8 的字节，读坏了这里立刻现形。
  it('forwards zip bytes verbatim and keeps the upstream content-type', async () => {
    // 'PK\x03\x04' 开头（zip 魔数），其余是刻意挑的非法 UTF-8 字节
    const zipBytes = Buffer.from('504b030489fffe8081c0c1f5eda08000010203efbf', 'hex');
    const upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, {
          'Content-Type': 'application/x-zip-compressed',
          'X-Seen-Accept': String(request.headers.accept ?? ''),
          'X-Seen-Auth': String(request.headers.authorization ?? ''),
          'X-Seen-Url': String(request.url ?? ''),
        });
        response.end(zipBytes);
      });
    });

    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });

    try {
      const address = upstream.address() as AddressInfo;
      const response = await buildHonoApp().request('/api/image/generate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-zip-compressed',
          Authorization: 'Bearer nai-token',
          'X-Target-Base-URL': `http://127.0.0.1:${address.port}`,
        },
        body: JSON.stringify({ model: 'nai-diffusion-4-5-full', action: 'generate', input: 'a' }),
      });

      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('application/x-zip-compressed');
      // 路径后缀由本路由补，Accept 与 Authorization 由 forward() 透传（§12.1 第 3/4 条）
      expect(response.headers.get('x-seen-url')).toBe('/ai/generate-image');
      expect(response.headers.get('x-seen-accept')).toBe('application/x-zip-compressed');
      expect(response.headers.get('x-seen-auth')).toBe('Bearer nai-token');

      const received = Buffer.from(await response.arrayBuffer());
      expect(received.equals(zipBytes)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        upstream.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
