import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { OPAQUE_ORIGIN_ERROR } from '../server/app';
import {
  buildStandaloneApp,
  ENGINE_VERSION_HEADER,
  probeExistingInstance,
  STANDALONE_ORIGIN,
  STANDALONE_PORT,
} from '../server/standalone-app';

const INDEX_HTML = '<!doctype html><html><body>spa</body></html>';
const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
const JS_SOURCE = 'export const answer = 42;\n';

const ENGINE_VERSION = '9.8.7';
/** 放在 webRoot 之外（同级）的哨兵文件：任何响应体里都不许出现这串内容 */
const SENTINEL = 'SENTINEL-outside-webroot-7f3a';

let baseDir: string;
let webRoot: string;
let app: Hono;

/** 默认打到规范源；断言主机名闸门的用例自己传完整 URL */
function req(path: string, init?: RequestInit): Promise<Response> {
  const url = path.startsWith('http') ? path : `${STANDALONE_ORIGIN}${path}`;
  return Promise.resolve(app.request(url, init));
}

beforeAll(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'standalone-web-'));
  webRoot = join(baseDir, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(baseDir, 'sentinel.txt'), SENTINEL);
  // 无扩展名的哨兵：穿越若成功会绕过「带扩展名才 404」那条规则
  writeFileSync(join(baseDir, 'sentinel'), SENTINEL);
  writeFileSync(join(webRoot, 'index.html'), INDEX_HTML);
  writeFileSync(join(webRoot, 'assets', 'x.wasm'), WASM_BYTES);
  writeFileSync(join(webRoot, 'assets', 'a.js'), JS_SOURCE);
  app = buildStandaloneApp({ webRoot, engineVersion: ENGINE_VERSION });
});

afterAll(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

describe('便携版独立服务器：静态资源', () => {
  it('根路径回 index.html 且不缓存', async () => {
    const res = await req('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('.wasm 以 application/wasm 返回，/assets/* 带永久缓存头', async () => {
    const res = await req('/assets/x.wasm');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/wasm');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(WASM_BYTES);
  });

  it('JS 资源同样永久缓存', async () => {
    const res = await req('/assets/a.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('缺失的带扩展名资源回 404，不回 HTML、不带永久缓存头', async () => {
    const res = await req('/assets/nope.wasm');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type') ?? '').not.toContain('text/html');
    expect(res.headers.get('Cache-Control')).not.toBe('public, max-age=31536000, immutable');
    expect(await res.text()).not.toContain('<html');
  });

  it('Range 请求回 206 与正确的字节片段', async () => {
    const res = await req('/assets/a.js', { headers: { Range: 'bytes=0-5' } });
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe(`bytes 0-5/${Buffer.byteLength(JS_SOURCE)}`);
    expect(await res.text()).toBe(JS_SOURCE.slice(0, 6));
  });

  it('HEAD 请求同样命中静态文件', async () => {
    const res = await req('/assets/a.js', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Length')).toBe(String(Buffer.byteLength(JS_SOURCE)));
  });

  it('无扩展名深路径走 SPA 兜底回 index.html（no-cache）', async () => {
    const res = await req('/game/play/deep?x=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(await res.text()).toBe(INDEX_HTML);
  });

  it('非 GET/HEAD 的非 API 请求回 404', async () => {
    const res = await req('/game/play', { method: 'POST' });
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type') ?? '').not.toContain('text/html');
  });

  it('哨兵文件确实在 webRoot 之外、能被 ../ 指到（保证下面的穿越用例不是空测）', () => {
    expect(readFileSync(join(webRoot, '..', 'sentinel.txt'), 'utf8')).toBe(SENTINEL);
    expect(readFileSync(join(webRoot, 'assets', '..', '..', 'sentinel.txt'), 'utf8')).toBe(
      SENTINEL,
    );
  });

  // 这些写法能躲过 URL 规范化（WHATWG 只把 `..` / `%2e%2e` 段折叠，`%5c` / `%2f` 原样保留），
  // 真正抵达静态文件中间件
  const TRAVERSALS = [
    '/..%5csentinel.txt',
    '/assets/..%5c..%5csentinel.txt',
    '/%2e%2e%5csentinel.txt',
    '/..%2fsentinel.txt',
    '/%2e%2e%2fsentinel.txt',
    '/assets/%2e%2e%2f%2e%2e%2fsentinel.txt',
    '/assets/..%2f..%2fsentinel.txt',
    '/%5c..%5csentinel.txt',
    '/assets/%2e%2e/%2e%2e/sentinel.txt',
  ];

  it.each(TRAVERSALS)('路径穿越 %s 回 404，不泄露 webRoot 之外的文件', async (path) => {
    const res = await req(path);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SENTINEL);
  });

  it.each(TRAVERSALS.map((p) => p.replace('.txt', '')))(
    '无扩展名的穿越 %s 最多落到 SPA 兜底，不泄露哨兵',
    async (path) => {
      const res = await req(path);
      const body = await res.text();
      expect(body).not.toContain(SENTINEL);
      if (res.status === 200) expect(body).toBe(INDEX_HTML);
    },
  );
});

describe('便携版独立服务器：API', () => {
  it('/api/status 由 BFF 正常回应，并带便携版版本头', async () => {
    const res = await req('/api/status');
    expect(res.status).toBe(200);
    expect(res.headers.get(ENGINE_VERSION_HEADER)).toBe(ENGINE_VERSION);
    expect(await res.json()).toMatchObject({ ok: true, service: 'fated-poem-bff' });
  });

  it('版本头只加在 /api/status 上', async () => {
    const res = await req('/api/nope');
    expect(res.headers.get(ENGINE_VERSION_HEADER)).toBeNull();
  });

  it('同源 Origin 放行', async () => {
    const res = await req('/api/status', { headers: { Origin: STANDALONE_ORIGIN } });
    expect(res.status).toBe(200);
  });

  it('未知 /api/* 回 JSON 404，不落 SPA 兜底', async () => {
    const res = await req('/api/nope');
    expect(res.status).toBe(404);
    expect(res.headers.get('Content-Type')).toContain('application/json');
    await res.json();
  });

  it('未配置内容目录时写回路由回 501', async () => {
    const res = await req('/api/defaults/x', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(501);
  });

  it('Origin: null（沙盒 iframe）回 403 与既有错误体', async () => {
    const res = await req('/api/status', { headers: { Origin: 'null' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: OPAQUE_ORIGIN_ERROR });
  });

  it('外站 Origin 回 403', async () => {
    const res = await req('/api/status', { headers: { Origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });

  it('localhost 别名的 Origin 也算外源', async () => {
    const res = await req('/api/status', {
      headers: { Origin: `http://localhost:${STANDALONE_PORT}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('便携版独立服务器：主机名闸门', () => {
  it('localhost:15173 308 重定向到规范源，保留路径与查询串', async () => {
    const res = await req(`http://localhost:${STANDALONE_PORT}/game/play?a=1`);
    expect(res.status).toBe(308);
    expect(res.headers.get('Location')).toBe(`${STANDALONE_ORIGIN}/game/play?a=1`);
  });

  it('其他主机名一律 403（防 DNS rebinding）', async () => {
    for (const host of [
      'http://evil.example:15173/',
      'http://127.0.0.1:5173/',
      'http://localhost/',
    ]) {
      const res = await req(`${host}api/status`);
      expect(res.status, host).toBe(403);
    }
  });
});

describe('probeExistingInstance', () => {
  const jsonResponse = (body: unknown, status = 200, version: string | null = ENGINE_VERSION) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'Content-Type': 'application/json',
        ...(version === null ? {} : { [ENGINE_VERSION_HEADER]: version }),
      },
    });
  const OK_BODY = { ok: true, service: 'fated-poem-bff', ts: 1 };

  it('/api/status 回本 BFF 的 JSON 且版本相同 → ours', async () => {
    let calledUrl = '';
    const fakeFetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      return jsonResponse(OK_BODY);
    }) as typeof fetch;
    expect(await probeExistingInstance(STANDALONE_ORIGIN, ENGINE_VERSION, fakeFetch)).toBe('ours');
    expect(calledUrl).toBe(`${STANDALONE_ORIGIN}/api/status`);
  });

  it('是本 BFF 但版本不同或没有版本头 → ours-other-version', async () => {
    for (const version of ['1.0.0', '', null]) {
      const fakeFetch = (async () => jsonResponse(OK_BODY, 200, version)) as typeof fetch;
      expect(
        await probeExistingInstance(STANDALONE_ORIGIN, ENGINE_VERSION, fakeFetch),
        String(version),
      ).toBe('ours-other-version');
    }
  });

  it('真实 standalone app 的 /api/status：同版本 ours，别的版本 ours-other-version', async () => {
    const fakeFetch = ((input: RequestInfo | URL) => req(String(input))) as typeof fetch;
    expect(await probeExistingInstance(STANDALONE_ORIGIN, ENGINE_VERSION, fakeFetch)).toBe('ours');
    expect(await probeExistingInstance(STANDALONE_ORIGIN, '9.9.9', fakeFetch)).toBe(
      'ours-other-version',
    );
  });

  it('别的服务、非 2xx、非 JSON、网络错误 → foreign', async () => {
    const cases: Array<typeof fetch> = [
      (async () => jsonResponse({ ok: true, service: 'something-else' })) as typeof fetch,
      (async () => jsonResponse({ ok: true, service: 'fated-poem-bff' }, 500)) as typeof fetch,
      (async () => new Response('<html></html>', { status: 200 })) as typeof fetch,
      (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
    ];
    for (const fakeFetch of cases) {
      expect(await probeExistingInstance(STANDALONE_ORIGIN, ENGINE_VERSION, fakeFetch)).toBe(
        'foreign',
      );
    }
  });
});
