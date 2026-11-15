import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildHonoApp, OPAQUE_ORIGIN_ERROR } from '../server/app';
import { createCanaryStore } from '../server/plugin-canary';
import type { CanaryStore } from '../server/plugin-canary';
import { resolvePluginsDir } from '../server/plugin-dir';
import type { ResolvePluginsDirResult } from '../server/plugin-dir';
import {
  isPluginCanaryPath,
  isPluginsApiPath,
  type PluginListingResponse,
} from '../server/routes/plugins';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** 同源请求头（浏览器对同源 fetch 自动带上） */
const SAME_ORIGIN = { 'Sec-Fetch-Site': 'same-origin' } as const;

const NONCE_A = 'canaryAAAAAAAAAAAAAA';
const NONCE_B = 'canaryBBBBBBBBBBBBBB';

let tmp: string;
let repoRoot: string;
let pluginsDir: string;
let store: CanaryStore;
let resolved: ResolvePluginsDirResult;

function put(rel: string, content: string | Buffer): void {
  const abs = join(pluginsDir, ...rel.split('/'));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function app(overrides: { pluginsDir?: ResolvePluginsDirResult } = {}) {
  return buildHonoApp({ pluginsDir: overrides.pluginsDir ?? resolved, canaryStore: store });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'poem-plugin-routes-'));
  repoRoot = join(tmp, 'repo');
  mkdirSync(repoRoot);
  pluginsDir = join(tmp, 'poem-plugins');
  mkdirSync(pluginsDir);
  resolved = resolvePluginsDir({}, repoRoot);
  store = createCanaryStore();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('GET /api/plugins 列目录', () => {
  it('列出插件、清单原文与文件哈希，且不下发 skipped', async () => {
    const manifest = '{"id":"shop","name":"商店"}';
    put('shop/manifest.json', manifest);
    put('shop/index.html', '<p>hi</p>');

    const res = await app().request('/api/plugins', { headers: SAME_ORIGIN });
    expect(res.status).toBe(200);
    const body = (await res.json()) as PluginListingResponse;
    expect(body.enabled).toBe(true);
    if (!body.enabled) return;
    expect(body.dir).toBe(pluginsDir);
    expect(body.dirExists).toBe(true);
    expect(body.plugins).toHaveLength(1);
    const [shop] = body.plugins;
    expect(shop.id).toBe('shop');
    expect(shop.manifestText).toBe(manifest);
    expect(shop.files).toContainEqual({
      path: 'index.html',
      size: 9,
      sha256: sha('<p>hi</p>'),
    });
    expect(shop.totalBytes).toBe(Buffer.byteLength(manifest) + 9);
    expect(shop).not.toHaveProperty('skipped');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('插件目录不存在 → enabled:true + dirExists:false', async () => {
    rmSync(pluginsDir, { recursive: true });
    const res = await app().request('/api/plugins', { headers: SAME_ORIGIN });
    expect(await res.json()).toEqual({
      enabled: true,
      dir: pluginsDir,
      dirExists: false,
      plugins: [],
    });
  });

  it('插件目录落在仓库根之内 → enabled:false，文件路由 503', async () => {
    const inside = resolvePluginsDir({ POEM_PLUGINS_DIR: 'plugins' }, repoRoot);
    expect(inside.ok).toBe(false);

    const res = await app({ pluginsDir: inside }).request('/api/plugins', { headers: SAME_ORIGIN });
    const body = (await res.json()) as PluginListingResponse;
    expect(body).toMatchObject({ enabled: false, reason: 'inside-root' });
    if (!body.enabled) expect(body.message).toContain('仓库根目录');

    const file = await app({ pluginsDir: inside }).request('/api/plugins/shop/file?path=a.js', {
      headers: SAME_ORIGIN,
    });
    expect(file.status).toBe(503);
  });
});

describe('GET /api/plugins/:id/file 取文件', () => {
  it('返回原字节，响应头固定为 octet-stream + attachment + sandbox CSP', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    put('shop/img/icon.png', bytes);
    put('shop/index.html', '<script>alert(1)</script>');

    const res = await app().request('/api/plugins/shop/file?path=img/icon.png', {
      headers: SAME_ORIGIN,
    });
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer())).toEqual(bytes);

    const html = await app().request('/api/plugins/shop/file?path=index.html', {
      headers: SAME_ORIGIN,
    });
    expect(html.status).toBe(200);
    for (const r of [res, html]) {
      expect(r.headers.get('Content-Type')).toBe('application/octet-stream');
      expect(r.headers.get('Content-Disposition')).toBe('attachment');
      expect(r.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(r.headers.get('Content-Security-Policy')).toBe("sandbox; default-src 'none'");
      expect(r.headers.get('Cross-Origin-Resource-Policy')).toBe('same-origin');
      expect(r.headers.get('Cache-Control')).toBe('no-store');
      expect(r.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('失败码映射成状态码：缺 path 400 / 穿越 400 / 类型 400 / 不存在 404', async () => {
    put('shop/a.js', 'x');
    const get = (q: string) =>
      app().request(`/api/plugins/shop/file${q}`, { headers: SAME_ORIGIN });

    expect((await get('')).status).toBe(400);
    const traversal = await get('?path=../../etc/passwd.txt');
    expect(traversal.status).toBe(400);
    expect(await traversal.json()).toMatchObject({ error: 'INVALID_PATH' });
    expect((await get('?path=a.exe')).status).toBe(400);
    const missing = await get('?path=b.js');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({ error: 'NOT_FOUND' });
    expect(missing.headers.get('X-Content-Type-Options')).toBe('nosniff');
  });
});

describe('同源与方法限制', () => {
  it('缺 Sec-Fetch-Site 或不是 same-origin → 403', async () => {
    put('shop/a.js', 'x');
    for (const headers of <Record<string, string>[]>[
      {},
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'none' },
    ]) {
      for (const path of [
        '/api/plugins',
        '/api/plugins/shop/file?path=a.js',
        `/api/plugins/__selfcheck/register?n=${NONCE_A}`,
        `/api/plugins/__selfcheck/hits?n=${NONCE_A}`,
      ]) {
        const res = await app().request(path, { headers });
        expect(res.status, `${path} ${JSON.stringify(headers)}`).toBe(403);
      }
    }
    // 一次登记都没成功
    expect(store.size()).toBe(0);
  });

  it('Sec-Fetch-Site 是 same-origin 但 Origin 与本站不符 → 403', async () => {
    const res = await app().request('http://localhost:5173/api/plugins', {
      headers: { ...SAME_ORIGIN, Origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
    const ok = await app().request('http://localhost:5173/api/plugins', {
      headers: { ...SAME_ORIGIN, Origin: 'http://localhost:5173' },
    });
    expect(ok.status).toBe(200);
  });

  it('非 GET 方法 → 405，并带 Allow 头', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      for (const path of ['/api/plugins', '/api/plugins/shop/file?path=a.js']) {
        const res = await app().request(path, { method, headers: SAME_ORIGIN });
        expect(res.status, `${method} ${path}`).toBe(405);
        expect(res.headers.get('Allow')).toBe('GET, HEAD');
      }
    }
  });
});

describe('金丝雀与自检登记', () => {
  const register = (n: string) =>
    app().request(`/api/plugins/__selfcheck/register?n=${n}`, { headers: SAME_ORIGIN });
  const hits = async (n: string) => {
    const res = await app().request(`/api/plugins/__selfcheck/hits?n=${n}`, {
      headers: SAME_ORIGIN,
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { hits: Record<string, boolean> }).hits;
  };

  it('登记 → 命中 → 查询往返', async () => {
    const reg = await register(`${NONCE_A},${NONCE_B}`);
    expect(reg.status).toBe(200);
    expect(await reg.json()).toEqual({ ok: true, count: 2 });
    expect(await hits(`${NONCE_A},${NONCE_B}`)).toEqual({ [NONCE_A]: false, [NONCE_B]: false });

    const ping = await app().request(`/api/plugins/__canary/${NONCE_A}`, { method: 'POST' });
    expect(ping.status).toBe(204);
    expect(await hits(`${NONCE_A},${NONCE_B}`)).toEqual({ [NONCE_A]: true, [NONCE_B]: false });
  });

  it('登记参数为空或含非法 nonce → 400，且全有或全无', async () => {
    expect((await register('')).status).toBe(400);
    expect((await register(`${NONCE_A},bad`)).status).toBe(400);
    expect(store.size()).toBe(0);
  });

  it('Origin: null 的金丝雀请求先被记下，同样 Origin: null 打别的路由仍被拒', async () => {
    store.register([NONCE_A]);
    const canary = await app().request(`/api/plugins/__canary/${NONCE_A}`, {
      headers: { Origin: 'null' },
    });
    expect(canary.status).toBe(204);
    expect(store.hits([NONCE_A])).toEqual({ [NONCE_A]: true });

    for (const path of ['/api/plugins', `/api/plugins/__selfcheck/hits?n=${NONCE_A}`]) {
      const refused = await app().request(path, {
        headers: { ...SAME_ORIGIN, Origin: 'null' },
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toEqual({ error: OPAQUE_ORIGIN_ERROR });
    }
  });

  it('未登记的 nonce 不记命中；记录端点接受任意方法', async () => {
    for (const method of ['GET', 'POST', 'PUT', 'DELETE', 'HEAD']) {
      const res = await app().request(`/api/plugins/__canary/${NONCE_B}`, { method });
      expect(res.status, method).toBe(204);
    }
    expect(store.size()).toBe(0);
  });

  it('重定向端点只跳 loopback 主机名、沿用本请求端口，且自身不记命中', async () => {
    store.register([NONCE_A]);
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const res = await app().request(
        `http://localhost:5173/api/plugins/__canary-redirect/${NONCE_A}?host=${encodeURIComponent(host)}`,
        { headers: { Origin: 'null' } },
      );
      expect(res.status, host).toBe(302);
      expect(res.headers.get('Location')).toBe(
        `http://${host}:5173/api/plugins/__canary/${NONCE_A}`,
      );
    }
    expect(store.hits([NONCE_A])).toEqual({ [NONCE_A]: false });

    for (const host of [
      '',
      'evil.example',
      'localhost:8080',
      'localhost.evil.example',
      '127.0.0.2',
      '::1',
      '0.0.0.0',
      '[::ffff:127.0.0.1]',
      'LOCALHOST',
      'localhost/@evil.example',
    ]) {
      const res = await app().request(
        `http://localhost:5173/api/plugins/__canary-redirect/${NONCE_A}?host=${encodeURIComponent(host)}`,
      );
      expect(res.status, host).toBe(400);
      expect(res.headers.get('Location')).toBeNull();
    }

    const badNonce = await app().request('/api/plugins/__canary-redirect/short?host=localhost');
    expect(badNonce.status).toBe(400);
  });
});

describe('路径判据', () => {
  it('isPluginCanaryPath 只认两条金丝雀路由', () => {
    expect(isPluginCanaryPath(`/api/plugins/__canary/${NONCE_A}`)).toBe(true);
    expect(isPluginCanaryPath(`/api/plugins/__canary-redirect/${NONCE_A}?host=x`)).toBe(true);
    expect(isPluginCanaryPath('/api/plugins/__canaryX/a')).toBe(false);
    expect(isPluginCanaryPath('/api/plugins/shop/file')).toBe(false);
    expect(isPluginCanaryPath('/api/status')).toBe(false);
  });

  it('isPluginsApiPath 只认插件前缀本身', () => {
    expect(isPluginsApiPath('/api/plugins')).toBe(true);
    expect(isPluginsApiPath('/api/plugins?x=1')).toBe(true);
    expect(isPluginsApiPath('/api/plugins/shop/file?path=a.js')).toBe(true);
    expect(isPluginsApiPath('/api/pluginsX/a.html')).toBe(false);
    expect(isPluginsApiPath('/@fs/api/plugins')).toBe(false);
  });
});

describe('只读结构约束', () => {
  it('路由源码不含写入、改名、删除、建目录与解析真实路径类的标识符', () => {
    const source = readFileSync(resolve(__dirname, '../server/routes/plugins.ts'), 'utf-8');
    const banned = [
      'real' + 'path',
      'write' + 'File',
      're' + 'name',
      'un' + 'link',
      'mk' + 'dir',
      'r' + 'm(',
      'r' + 'mdir',
      'r' + 'mSync',
      'append' + 'File',
    ];
    for (const word of banned) expect(source).not.toContain(word);
  });
});
