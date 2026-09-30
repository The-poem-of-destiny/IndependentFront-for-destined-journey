import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildHonoApp } from '../server/app';

/**
 * BFF 自定义请求头透传（「参数跟随模型」的头那一半）。
 *
 * 前端把源级 `headerOverrides` 打成 `X-Custom-Headers`（percent-encoded JSON）；
 * BFF 解析后并入上游请求。这一组钉四件事：
 *   ① 合法自定义头真的到达上游；
 *   ② 受保护头名（鉴权 / 代理控制头）被丢弃，不能借载荷注入；
 *   ③ 含 CR/LF 的值被丢弃（header injection），请求照常完成；
 *   ④ 坏载荷整体丢弃、不阻断请求。
 */
describe('BFF 自定义请求头透传', () => {
  let upstream: Server;
  let base: string;

  beforeAll(async () => {
    upstream = createServer((request, response) => {
      request.resume();
      request.on('end', () => {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ seen: request.headers }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once('error', reject);
      upstream.listen(0, '127.0.0.1', resolve);
    });
    base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function call(payload: string) {
    return buildHonoApp().request('/api/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Target-Base-URL': base,
        'X-Custom-Headers': payload,
      },
      body: JSON.stringify({ messages: [], stream: false }),
    });
  }

  async function seenHeaders(
    payload: string,
  ): Promise<Record<string, string | string[] | undefined>> {
    const response = await call(payload);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { seen: Record<string, string | string[] | undefined> };
    return body.seen;
  }

  it('合法自定义头到达上游', async () => {
    const seen = await seenHeaders(
      encodeURIComponent(JSON.stringify({ 'x-opencode-session': '790766510', 'X-Tenant': 'acme' })),
    );
    expect(seen['x-opencode-session']).toBe('790766510');
    expect(seen['x-tenant']).toBe('acme');
  });

  it('🔴 受保护头名（Authorization / X-Target-Base-URL）不被载荷注入', async () => {
    const seen = await seenHeaders(
      encodeURIComponent(
        JSON.stringify({
          Authorization: 'Bearer evil',
          'x-api-key': 'evil',
          'X-Model-ID': 'evil-model',
          'x-safe': 'ok',
        }),
      ),
    );
    // 请求本身没带 Authorization → 上游不该看到载荷塞进来的那一个
    expect(seen.authorization).toBeUndefined();
    expect(seen['x-api-key']).toBeUndefined();
    expect(seen['x-model-id']).toBeUndefined();
    // 同一载荷里的合法头照常到达（不是一刀切全丢）
    expect(seen['x-safe']).toBe('ok');
  });

  it('含 CR/LF 的头值被丢弃（header injection），请求照常完成', async () => {
    const seen = await seenHeaders(
      encodeURIComponent(JSON.stringify({ 'x-evil': 'v\r\nX-Injected: 1', 'x-safe': 'ok' })),
    );
    expect(seen['x-evil']).toBeUndefined();
    expect(seen['x-injected']).toBeUndefined();
    expect(seen['x-safe']).toBe('ok');
  });

  it('坏载荷整体丢弃、不阻断请求', async () => {
    for (const payload of ['%%%not-json', 'not-json', encodeURIComponent('[1,2,3]')]) {
      const seen = await seenHeaders(payload);
      expect(seen['x-safe']).toBeUndefined();
      // 请求本身照常到达上游
      expect(seen['content-type']).toBe('application/json');
    }
  });
});
