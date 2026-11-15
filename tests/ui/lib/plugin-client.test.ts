/**
 * plugin-client.test.ts — 本地插件文件夹 BFF 的浏览器侧客户端
 *
 * fetch 全程注入替身，绝不发真实请求；哈希用 Node 自带的 crypto.subtle 真算。
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import {
  fetchLocalPluginFile,
  fetchLocalPlugins,
  type LocalPluginListing,
} from '../../../src/ui/lib/plugin-client';

const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const LISTING: LocalPluginListing = {
  enabled: true,
  dir: '/x/poem-plugins',
  dirExists: true,
  plugins: [
    {
      id: 'shop',
      manifestText: '{"id":"shop"}',
      files: [{ path: 'index.html', size: 3, sha256: 'ab' }],
      totalBytes: 3,
    },
    { id: 'broken', manifestText: null, files: [], totalBytes: 0, error: '缺少 manifest' },
  ],
};

describe('fetchLocalPlugins', () => {
  it('请求同源相对地址并解析清单', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(LISTING));
    const res = await fetchLocalPlugins({ fetch: fetchImpl as unknown as typeof fetch });
    expect(res).toEqual({ ok: true, value: LISTING });
    expect(fetchImpl).toHaveBeenCalledWith('/api/plugins', expect.anything());
  });

  it('功能关闭的响应原样返回', async () => {
    const body = { enabled: false, reason: 'inside-root', message: '目录在仓库内' };
    const res = await fetchLocalPlugins({
      fetch: (async () => jsonResponse(body)) as unknown as typeof fetch,
    });
    expect(res).toEqual({ ok: true, value: body });
  });

  it('网络失败、HTTP 错误、非 JSON、形状不对都变成失败结果，不抛', async () => {
    const net = await fetchLocalPlugins({
      fetch: (async () => {
        throw new TypeError('断网');
      }) as unknown as typeof fetch,
    });
    expect(net).toMatchObject({ ok: false, code: 'NETWORK' });

    const http = await fetchLocalPlugins({
      fetch: (async () =>
        jsonResponse({ code: 'FORBIDDEN', message: '跨站请求' }, 403)) as unknown as typeof fetch,
    });
    expect(http).toMatchObject({ ok: false, code: 'HTTP', status: 403 });
    if (!http.ok) expect(http.message).toContain('跨站请求');

    const text = await fetchLocalPlugins({
      fetch: (async () => new Response('<html>')) as unknown as typeof fetch,
    });
    expect(text).toMatchObject({ ok: false, code: 'PARSE' });

    const shape = await fetchLocalPlugins({
      fetch: (async () =>
        jsonResponse({
          enabled: true,
          dir: 'x',
          dirExists: true,
          plugins: [{ id: 1 }],
        })) as unknown as typeof fetch,
    });
    expect(shape).toMatchObject({ ok: false, code: 'PARSE' });
  });
});

describe('fetchLocalPluginFile', () => {
  const content = new TextEncoder().encode('<h1>商店</h1>');

  it('编码 id 与路径，哈希一致时返回字节', async () => {
    const fetchImpl = vi.fn(async () => new Response(content));
    const res = await fetchLocalPluginFile('shop', 'ui/首页.html', sha(content), {
      fetch: fetchImpl as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.value)).toEqual(Array.from(content));
    expect(fetchImpl).toHaveBeenCalledWith(
      `/api/plugins/shop/file?path=${encodeURIComponent('ui/首页.html')}`,
      expect.anything(),
    );
  });

  it('期望哈希大小写不敏感', async () => {
    const res = await fetchLocalPluginFile('shop', 'a.js', sha(content).toUpperCase(), {
      fetch: (async () => new Response(content)) as unknown as typeof fetch,
    });
    expect(res.ok).toBe(true);
  });

  it('哈希不一致返回 HASH_MISMATCH', async () => {
    const res = await fetchLocalPluginFile('shop', 'a.js', sha(new Uint8Array([1])), {
      fetch: (async () => new Response(content)) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, code: 'HASH_MISMATCH' });
  });

  it('HTTP 404 返回失败结果', async () => {
    const res = await fetchLocalPluginFile('shop', 'a.js', 'x', {
      fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    });
    expect(res).toMatchObject({ ok: false, code: 'HTTP', status: 404 });
  });
});
