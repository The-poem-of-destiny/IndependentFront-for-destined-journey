import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolvePackServerUrl } from '../server/content-pack-release';
import { buildHonoApp } from '../server/app';

const base = 'https://packs.example';
const auth = { Authorization: 'Bearer dps1.payload.signature' };
beforeEach(() => {
  vi.stubEnv('POEM_PACK_SERVER_URL', base);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('protected content pack BFF', () => {
  it('exposes only the configured origin and rejects unsafe configuration', async () => {
    expect(resolvePackServerUrl()).toBe(base);
    const res = await buildHonoApp().request('/api/content-pack/config');
    expect(await res.json()).toEqual({ ok: true, serverUrl: base });
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    for (const url of [
      'http://packs.example',
      'https://user:secret@packs.example',
      'https://packs.example/path',
    ]) {
      vi.stubEnv('POEM_PACK_SERVER_URL', url);
      expect(() => resolvePackServerUrl()).toThrow();
    }
  });
  it('does not contact any public source without a Bearer session', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const path of ['latest', 'blob']) {
      const res = await buildHonoApp().request(`/api/content-pack/${path}`);
      expect(res.status).toBe(401);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['GET', 'latest', 'pack/latest'],
    ['GET', 'blob', 'pack/blob'],
    ['POST', 'renew', 'pack/renew'],
    ['POST', 'verify', 'auth/discord/verify'],
    ['POST', 'logout', 'auth/discord/logout'],
  ])('forwards %s /%s without decrypting or forwarding cookies', async (method, path, upstream) => {
    const body = { ok: true, serverTime: 123, envelope: { ciphertextB64: 'opaque' } };
    const fetch = vi.fn(async () => Response.json(body));
    vi.stubGlobal('fetch', fetch);
    const requestBody =
      method === 'POST' ? JSON.stringify({ packId: 'p', packVersion: '1.0.0' }) : undefined;
    const res = await buildHonoApp().request(`/api/content-pack/${path}`, {
      method,
      headers: { ...auth, Cookie: 'private=secret', 'X-Discord-Secret': 'secret' },
      body: requestBody,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(body);
    expect(fetch).toHaveBeenCalledWith(
      `${base}/api/v1/${upstream}`,
      expect.objectContaining({
        method,
        redirect: 'error',
        headers: { ...auth, 'Content-Type': 'application/json' },
        ...(requestBody ? { body: requestBody } : {}),
      }),
    );
  });
  it.each([401, 403, 429, 503])('preserves upstream %s and retry hints', async (status) => {
    const body = { ok: false, serverTime: 123, code: 'TEST_ERROR', error: 'try later' };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json(body, {
          status,
          headers: { 'Retry-After': '60', 'Set-Cookie': 'must-not-forward' },
        }),
      ),
    );
    const res = await buildHonoApp().request('/api/content-pack/blob', { headers: auth });
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual(body);
    expect(res.headers.get('Retry-After')).toBe('60');
    expect(res.headers.get('Set-Cookie')).toBeNull();
  });
  it('fails closed for missing config, network faults and oversized requests', async () => {
    vi.stubEnv('POEM_PACK_SERVER_URL', '');
    expect((await buildHonoApp().request('/api/content-pack/blob', { headers: auth })).status).toBe(
      503,
    );
    vi.stubEnv('POEM_PACK_SERVER_URL', base);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('upstream secret');
      }),
    );
    const failed = await buildHonoApp().request('/api/content-pack/blob', { headers: auth });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain('upstream secret');
    expect(
      (
        await buildHonoApp().request('/api/content-pack/renew', {
          method: 'POST',
          headers: auth,
          body: 'x'.repeat(4097),
        })
      ).status,
    ).toBe(413);
  });
});
