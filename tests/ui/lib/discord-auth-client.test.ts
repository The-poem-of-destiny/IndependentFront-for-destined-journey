// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authenticatedPackRequest,
  clearDiscordSession,
  discordAuthRevision,
  discordKeyLease,
  discordSession,
  effectivePackNow,
  initializeDiscordAuthClient,
  loginDiscord,
  logoutDiscord,
  saveDiscordSession,
  savePackKeyLease,
} from '../../../src/ui/lib/discord-auth-client';
import { encryptPrivatePack, makeDiscordSession } from '../../helpers/pack-auth-fixture';

beforeEach(() => {
  clearDiscordSession();
  saveDiscordSession(makeDiscordSession());
});
afterEach(() => {
  clearDiscordSession();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function reply(body: object, status = 200) {
  return Response.json({ serverTime: Date.now(), ...body }, { status });
}

describe('Discord opaque session client', () => {
  it('serializes calls and uses the latest rotated token', async () => {
    let finish!: (response: Response) => void;
    const next = makeDiscordSession();
    next.token = `${next.token}x`;
    const fetch = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(reply({ ok: true }));
    const first = authenticatedPackRequest('verify', {}, fetch);
    const second = authenticatedPackRequest('latest', undefined, fetch);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    finish(reply({ ok: true, token: next.token, expiresAt: next.expiresAt }));
    await first;
    await second;
    expect(fetch.mock.calls[1][1].headers.Authorization).toBe(`Bearer ${next.token}`);
  });
  it.each([401, 403])('clears unusable authorization on confirmed %s', async (status) => {
    savePackKeyLease(encryptPrivatePack().keyLease);
    const response = reply(
      { ok: false, code: status === 401 ? 'SESSION_EXPIRED' : 'NOT_IN_GUILD', error: 'denied' },
      status,
    );
    await expect(authenticatedPackRequest('verify', {}, async () => response)).rejects.toThrow(
      'denied',
    );
    expect(discordKeyLease.value).toBeNull();
    if (status === 401) expect(discordSession.value).toBeNull();
    else expect(discordSession.value?.access.eligible).toBe(false);
  });
  it.each([401, 403])('revokes on %s even with invalid error clock metadata', async (status) => {
    savePackKeyLease(encryptPrivatePack().keyLease);
    await expect(
      authenticatedPackRequest('verify', {}, async () =>
        reply(
          {
            ok: false,
            serverTime: -1,
            code: status === 401 ? 'SESSION_EXPIRED' : 'NOT_IN_GUILD',
            error: 'denied',
          },
          status,
        ),
      ),
    ).rejects.toThrow('denied');
    expect(discordKeyLease.value).toBeNull();
    if (status === 401) expect(discordSession.value).toBeNull();
    else expect(discordSession.value?.access.eligible).toBe(false);
  });
  it('clears a 401 session even when the response body is not JSON', async () => {
    savePackKeyLease(encryptPrivatePack().keyLease);
    await expect(
      authenticatedPackRequest(
        'verify',
        {},
        async () => new Response('Unauthorized', { status: 401 }),
      ),
    ).rejects.toThrow('登录已失效');
    expect(discordKeyLease.value).toBeNull();
    expect(discordSession.value).toBeNull();
  });
  it.each([503, 429, 403])(
    'does not treat transient/configuration failure %s as revocation',
    async (status) => {
      const token = discordSession.value!.token;
      await expect(
        authenticatedPackRequest('verify', {}, async () =>
          reply(
            {
              ok: false,
              code: status === 403 ? 'ORIGIN_NOT_ALLOWED' : 'DISCORD_UNAVAILABLE',
              error: 'retry',
            },
            status,
          ),
        ),
      ).rejects.toThrow();
      expect(discordSession.value?.access.eligible).toBe(true);
      expect(discordSession.value?.token).toBe(token);
    },
  );
  it('rejects a late response after logout instead of restoring a copied token', async () => {
    let finish!: (response: Response) => void;
    const session = makeDiscordSession();
    const pending = authenticatedPackRequest(
      'verify',
      {},
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    );
    const rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    clearDiscordSession();
    finish(reply({ ok: true, token: session.token, expiresAt: session.expiresAt }));
    await rejected;
    expect(discordSession.value).toBeNull();
  });
  it('logs out locally before its best-effort network call finishes', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const pending = logoutDiscord();
    expect(discordSession.value).toBeNull();
    finish(reply({ ok: true }));
    await pending;
  });
  it('accepts cross-tab logout but not token-only rotation as an identity change', () => {
    initializeDiscordAuthClient();
    const revision = discordAuthRevision.value;
    localStorage.setItem(
      'poem_discord_auth_v1',
      JSON.stringify({ ...discordSession.value, token: `${discordSession.value!.token}x` }),
    );
    window.dispatchEvent(new StorageEvent('storage', { key: 'poem_discord_auth_v1' }));
    expect(discordAuthRevision.value).toBe(revision);
    localStorage.removeItem('poem_discord_auth_v1');
    localStorage.removeItem('poem_discord_pack_lease_v1');
    window.dispatchEvent(new StorageEvent('storage', { key: 'poem_discord_auth_v1' }));
    expect(discordSession.value).toBeNull();
    expect(discordAuthRevision.value).toBeGreaterThan(revision);
  });
  it('does not extend an offline lease when the system clock moves backwards', () => {
    const before = effectivePackNow();
    vi.spyOn(Date, 'now').mockReturnValue(before - 86400000);
    expect(effectivePackNow()).toBeGreaterThanOrEqual(before);
  });
  it('fails a static deployment closed when the configured server has changed', async () => {
    vi.stubEnv('VITE_PACK_SERVER_URL', 'https://different.example');
    const fetch = vi.fn();
    await expect(authenticatedPackRequest('latest', undefined, fetch)).rejects.toThrow(
      '中心服地址已变化',
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('popup login handoff', () => {
  it('opens synchronously and requires expected origin, source and attempt id', async () => {
    const popup = { location: { href: '' }, close: vi.fn(), closed: false } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(popup);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ ok: true, serverUrl: 'https://packs.example' })),
    );
    const pending = loginDiscord();
    expect(window.open).toHaveBeenCalled();
    await vi.waitFor(() => expect(popup.location.href).toContain('/auth/discord/login'));
    const attemptId = new URL(popup.location.href).searchParams.get('attemptId');
    const data = {
      ...makeDiscordSession(),
      type: 'poem-discord-auth',
      status: 'completed',
      ok: true,
      attemptId,
      serverTime: Date.now(),
    };
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://evil.example', source: popup, data }),
    );
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://packs.example', source: window, data }),
    );
    window.dispatchEvent(
      new MessageEvent('message', {
        origin: 'https://packs.example',
        source: popup,
        data: { ...data, attemptId: 'wrong' },
      }),
    );
    expect(discordSession.value).toBeNull();
    window.dispatchEvent(
      new MessageEvent('message', { origin: 'https://packs.example', source: popup, data }),
    );
    await pending;
    expect(discordSession.value?.user.id).toBe('123');
    expect(popup.close).toHaveBeenCalled();
  });
  it('reports blocked popups without sending a login request', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(loginDiscord()).rejects.toThrow('弹窗被拦截');
    expect(fetch).not.toHaveBeenCalled();
  });
});
