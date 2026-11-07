import { shallowRef } from 'vue';
import type { DiscordAuthSession, PackKeyLease } from '@engine/types/types-pack-auth';

const SESSION_KEY = 'poem_discord_auth_v1';
const LEASE_KEY = 'poem_discord_pack_lease_v1';
const CLOCK_KEY = 'poem_pack_clock_guard_v1';
function stored(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) || 'null');
  } catch {
    return null;
  }
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('服务端响应格式无效');
  return value as Record<string, unknown>;
}
function serverOrigin(raw: string): string {
  const url = new URL(raw);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  )
    throw new Error('内容中心服地址必须为 HTTPS origin（本机回环可用 HTTP）');
  return url.origin;
}
function parseSession(value: unknown): DiscordAuthSession | null {
  try {
    const s = record(value),
      user = record(s.user),
      access = record(s.access);
    if (
      typeof s.token !== 'string' ||
      !/^dps1\.[\w-]+\.[\w-]+$/.test(s.token) ||
      typeof user.id !== 'string' ||
      !/^\d{1,20}$/.test(user.id) ||
      typeof user.username !== 'string' ||
      typeof user.displayName !== 'string' ||
      !(user.avatarUrl === null || typeof user.avatarUrl === 'string') ||
      typeof access.eligible !== 'boolean' ||
      typeof access.code !== 'string' ||
      typeof access.guildId !== 'string' ||
      typeof access.message !== 'string' ||
      !Number.isSafeInteger(s.expiresAt) ||
      !Number.isSafeInteger(s.verifiedAt) ||
      typeof s.serverUrl !== 'string'
    )
      return null;
    serverOrigin(s.serverUrl);
    return s as unknown as DiscordAuthSession;
  } catch {
    return null;
  }
}
export const discordSession = shallowRef<DiscordAuthSession | null>(
  parseSession(stored(SESSION_KEY)),
);
export const discordKeyLease = shallowRef<PackKeyLease | null>(null);
export const discordAuthRevision = shallowRef(0);
const initialLease = stored(LEASE_KEY);
if (initialLease && typeof initialLease === 'object')
  discordKeyLease.value = initialLease as PackKeyLease;

const initialClock = stored(CLOCK_KEY) as { clockOffset?: number; maxObservedTime?: number } | null;
let clockOffset = Number.isFinite(initialClock?.clockOffset) ? initialClock!.clockOffset! : 0;
let maxObservedTime = Number.isFinite(initialClock?.maxObservedTime)
  ? initialClock!.maxObservedTime!
  : 0;
let monotonicTime = performance.now();
let anchorTime = maxObservedTime;
let clockSavedAt = 0;
function persistClock(): void {
  try {
    localStorage.setItem(CLOCK_KEY, JSON.stringify({ clockOffset, maxObservedTime }));
  } catch {
    /* In-memory watermark still protects this session. */
  }
  clockSavedAt = performance.now();
}
export function effectivePackNow(): number {
  maxObservedTime = Math.max(
    Date.now() + clockOffset,
    maxObservedTime,
    anchorTime + performance.now() - monotonicTime,
  );
  if (performance.now() - clockSavedAt > 60000) persistClock();
  return maxObservedTime;
}
function observePackServerTime(serverTime: number): void {
  if (!Number.isSafeInteger(serverTime) || serverTime <= 0) throw new Error('中心服时间戳无效');
  clockOffset = serverTime - Date.now();
  maxObservedTime = Math.max(maxObservedTime, serverTime);
  anchorTime = maxObservedTime;
  monotonicTime = performance.now();
  persistClock();
}

export class PackApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}
export type PackClientFetch = (
  input: string,
  init?: RequestInit,
) => Promise<Pick<Response, 'ok' | 'status' | 'json'> & { headers?: Pick<Headers, 'get'> }>;
let requestTail: Promise<unknown> = Promise.resolve();
let loginTask: Promise<void> | null = null;
let cancelLogin: (() => void) | undefined;
let storageListening = false;

export function saveDiscordSession(
  session: DiscordAuthSession | null,
  forceRevision = false,
): void {
  const previous = discordSession.value;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* Logout must still clear memory. */
    }
  }
  discordSession.value = session;
  if (
    forceRevision ||
    previous?.user.id !== session?.user.id ||
    previous?.access.eligible !== session?.access.eligible ||
    previous?.serverUrl !== session?.serverUrl
  )
    discordAuthRevision.value++;
}
export function savePackKeyLease(lease: PackKeyLease | null): void {
  if (lease) localStorage.setItem(LEASE_KEY, JSON.stringify(lease));
  else {
    try {
      localStorage.removeItem(LEASE_KEY);
    } catch {
      /* Clear in-memory keys regardless. */
    }
  }
  discordKeyLease.value = lease;
}
export function clearDiscordSession(): void {
  cancelLogin?.();
  savePackKeyLease(null);
  saveDiscordSession(null, true);
}
export function initializeDiscordAuthClient(): void {
  if (storageListening || typeof window === 'undefined') return;
  storageListening = true;
  window.addEventListener('storage', (event) => {
    if (event.key === SESSION_KEY || event.key === null) {
      const previous = discordSession.value;
      const next = parseSession(stored(SESSION_KEY));
      discordSession.value = next;
      discordKeyLease.value = stored(LEASE_KEY) as PackKeyLease | null;
      if (
        previous?.user.id !== next?.user.id ||
        previous?.access.eligible !== next?.access.eligible ||
        previous?.serverUrl !== next?.serverUrl
      )
        discordAuthRevision.value++;
    } else if (event.key === LEASE_KEY)
      discordKeyLease.value = stored(LEASE_KEY) as PackKeyLease | null;
    else if (event.key === CLOCK_KEY) {
      const clock = stored(CLOCK_KEY) as { maxObservedTime?: number } | null;
      if (Number.isFinite(clock?.maxObservedTime))
        maxObservedTime = Math.max(maxObservedTime, clock!.maxObservedTime!);
    }
  });
  window.addEventListener('pagehide', persistClock);
}

async function resolvePackServerUrl(fetchImpl: PackClientFetch = fetch): Promise<string> {
  const configured = import.meta.env.VITE_PACK_SERVER_URL as string | undefined;
  if (configured?.trim()) return serverOrigin(configured.trim());
  const response = await fetchImpl('/api/content-pack/config', {
    cache: 'no-store',
    signal: AbortSignal.timeout(10000),
  });
  const body = record(await response.json());
  if (!response.ok || typeof body.serverUrl !== 'string' || !body.serverUrl)
    throw new Error(
      '尚未配置内容中心服，请设置 POEM_PACK_SERVER_URL（静态部署使用 VITE_PACK_SERVER_URL）',
    );
  return serverOrigin(body.serverUrl);
}

/** Serialize token-carrying calls so concurrent endpoints cannot rotate the same OAuth refresh token. */
export function authenticatedPackRequest(
  path: 'latest' | 'blob' | 'renew' | 'verify' | 'logout',
  body?: unknown,
  fetchImpl: PackClientFetch = fetch,
): Promise<Record<string, unknown>> {
  const requestedRevision = discordAuthRevision.value;
  const run = async () => {
    // Storage events can lag behind a Web Lock grant; adopt the newest rotated token first.
    if (
      typeof navigator !== 'undefined' &&
      navigator.locks &&
      requestedRevision === discordAuthRevision.value
    ) {
      const latest = parseSession(stored(SESSION_KEY));
      if (
        latest?.user.id === discordSession.value?.user.id &&
        latest?.serverUrl === discordSession.value?.serverUrl
      )
        discordSession.value = latest;
    }
    const session = discordSession.value;
    if (requestedRevision !== discordAuthRevision.value)
      throw new PackApiError(401, 'SESSION_CHANGED', '登录账号已变化');
    if (!session || session.expiresAt <= effectivePackNow()) {
      clearDiscordSession();
      throw new PackApiError(401, 'AUTH_REQUIRED', '请先登录 Discord');
    }
    // Static deployments use the configured remote origin; local BFF deployments stay same-origin.
    const direct = !!import.meta.env.VITE_PACK_SERVER_URL;
    if (direct && serverOrigin(String(import.meta.env.VITE_PACK_SERVER_URL)) !== session.serverUrl)
      throw new PackApiError(401, 'SERVER_CHANGED', '中心服地址已变化，请重新登录');
    const remotePath = ['verify', 'logout'].includes(path)
      ? `auth/discord/${path}`
      : `pack/${path}`;
    const url = direct ? `${session.serverUrl}/api/v1/${remotePath}` : `/api/content-pack/${path}`;
    const response = await fetchImpl(url, {
      method: body === undefined && ['latest', 'blob'].includes(path) ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${session.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      cache: 'no-store',
      signal: AbortSignal.timeout(30000),
    });
    let result: Record<string, unknown>;
    try {
      result = record(await response.json());
    } catch {
      if (requestedRevision === discordAuthRevision.value && response.status === 401) {
        clearDiscordSession();
        throw new PackApiError(401, 'AUTH_REQUIRED', 'Discord 登录已失效，请重新登录');
      }
      throw new PackApiError(502, 'INVALID_RESPONSE', '内容中心服返回无效响应');
    }
    if (requestedRevision !== discordAuthRevision.value)
      throw new PackApiError(401, 'SESSION_CHANGED', '登录账号已变化');
    // Error responses may omit clock metadata; they must still revoke confirmed access.
    if (Number.isSafeInteger(result.serverTime) && Number(result.serverTime) > 0)
      observePackServerTime(Number(result.serverTime));
    if (!response.ok || result.ok !== true) {
      const code = typeof result.code === 'string' ? result.code : 'REQUEST_FAILED';
      if (response.status === 401) clearDiscordSession();
      else if (
        response.status === 403 &&
        ['NOT_IN_GUILD', 'MISSING_REQUIRED_ROLE', 'USER_BLOCKED'].includes(code)
      ) {
        savePackKeyLease(null);
        saveDiscordSession({
          ...session,
          access: {
            ...session.access,
            eligible: false,
            code,
            message: String(result.error || 'Discord 资格已撤销'),
          },
        });
      }
      const retryAfter = response.headers?.get('Retry-After');
      const retryAfterMs = retryAfter
        ? Math.max(
            0,
            /^\d+$/.test(retryAfter)
              ? Number(retryAfter) * 1000
              : Date.parse(retryAfter) - Date.now(),
          )
        : 0;
      throw new PackApiError(
        response.status,
        code,
        typeof result.error === 'string'
          ? result.error
          : `内容中心服请求失败（HTTP ${response.status}）`,
        Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, 2147483647) : 0,
      );
    }
    if (!Number.isSafeInteger(result.serverTime) || Number(result.serverTime) <= 0)
      throw new PackApiError(502, 'INVALID_RESPONSE', '内容中心服时间戳缺失');
    if (typeof result.token === 'string') {
      const next = parseSession({
        ...session,
        token: result.token,
        ...(result.user ? { user: result.user } : {}),
        ...(result.access ? { access: result.access } : {}),
        expiresAt:
          typeof result.expiresAt === 'number' ? result.expiresAt : sessionExpiry(result.token),
        verifiedAt:
          typeof result.serverTime === 'number' && (path === 'renew' || path === 'verify')
            ? result.serverTime
            : session.verifiedAt,
      });
      if (!next) throw new PackApiError(502, 'INVALID_RESPONSE', '内容中心服会话格式无效');
      saveDiscordSession(next);
    }
    return result;
  };
  const withCrossTabLock = async (): Promise<Record<string, unknown>> =>
    await (typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('poem-discord-auth-request', run)
      : run());
  const pending = requestTail.then(withCrossTabLock, withCrossTabLock);
  requestTail = pending.catch(() => {});
  return pending;
}
function sessionExpiry(token: string): number {
  try {
    const body = token.split('.')[1]!;
    const padded = body.replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(
      new TextDecoder().decode(Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))),
    ) as { exp: number };
    return value.exp * 1000;
  } catch {
    return 0;
  }
}

export function loginDiscord(): Promise<void> {
  if (loginTask) return loginTask;
  // Open synchronously in the click handler, before any asynchronous configuration lookup.
  const popup = window.open('about:blank', '_blank', 'popup,width=520,height=760');
  if (!popup) return Promise.reject(new Error('登录弹窗被拦截，请允许此站点打开弹窗'));
  clearDiscordSession();
  const attemptId = crypto.randomUUID();
  const revision = discordAuthRevision.value;
  loginTask = (async () => {
    const serverUrl = await resolvePackServerUrl();
    if (revision !== discordAuthRevision.value) throw new Error('登录已取消');
    await new Promise<void>((resolve, reject) => {
      let settled = false,
        polling = false;
      const timeout = window.setTimeout(
        () => finish(new Error('Discord 登录超时，请重试')),
        600000,
      );
      const timer = window.setInterval(() => {
        void poll();
      }, 1500);
      function finish(error?: Error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearInterval(timer);
        window.removeEventListener('message', onMessage);
        cancelLogin = undefined;
        popup?.close();
        if (error) reject(error);
        else resolve();
      }
      function accept(value: unknown) {
        if (settled) return;
        try {
          const result = record(value);
          if (result.status !== 'completed') return;
          if (result.ok !== true) {
            finish(new Error(String(result.error || 'Discord 登录失败')));
            return;
          }
          if (revision !== discordAuthRevision.value) {
            finish(new Error('登录已取消'));
            return;
          }
          const session = parseSession({ ...result, serverUrl, verifiedAt: result.serverTime });
          if (!session) throw new Error('Discord 登录响应格式无效');
          observePackServerTime(Number(result.serverTime));
          saveDiscordSession(session, true);
          finish();
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Discord 登录失败'));
        }
      }
      function onMessage(event: MessageEvent) {
        if (
          event.origin !== serverUrl ||
          event.source !== popup ||
          event.data?.type !== 'poem-discord-auth' ||
          event.data?.attemptId !== attemptId
        )
          return;
        accept(event.data);
      }
      async function poll() {
        if (popup?.closed) {
          finish(new Error('登录窗口已关闭，请重试'));
          return;
        }
        if (polling || settled) return;
        polling = true;
        try {
          const response = await fetch(
            `${serverUrl}/api/v1/auth/discord/result?attemptId=${attemptId}`,
            { cache: 'no-store', signal: AbortSignal.timeout(10000) },
          );
          if (response.ok) accept(await response.json());
        } catch {
          /* Polling tolerates temporary disconnects; the 10-minute deadline remains active. */
        } finally {
          polling = false;
        }
      }
      cancelLogin = () => finish(new Error('登录已取消'));
      window.addEventListener('message', onMessage);
      popup.location.href = `${serverUrl}/api/v1/auth/discord/login?origin=${encodeURIComponent(window.location.origin)}&attemptId=${attemptId}`;
    });
  })().finally(() => {
    popup.close();
    loginTask = null;
  });
  return loginTask;
}

export async function verifyDiscordAccess(): Promise<void> {
  await authenticatedPackRequest('verify', { forceRefresh: true });
}

export async function logoutDiscord(): Promise<void> {
  // Snapshot only for the best-effort request; clear keys/content immediately, not after network I/O.
  const session = discordSession.value;
  clearDiscordSession();
  if (!session) return;
  const direct = !!import.meta.env.VITE_PACK_SERVER_URL;
  try {
    await fetch(
      direct ? `${session.serverUrl}/api/v1/auth/discord/logout` : '/api/content-pack/logout',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${session.token}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
      },
    );
  } catch {
    /* Local logout is authoritative for this client. */
  }
}
