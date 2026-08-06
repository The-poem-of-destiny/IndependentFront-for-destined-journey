/**
 * workshop-social-store.ts — 创意工坊社交面的**状态与编排**（Phase 3 / P3b）
 *
 * 与 `workshop-store` 的分工是刻意的、也是本文件唯一的存在理由:
 * `workshop-store` 管**落库的那一半**（世界书条目、美化规则、已装项目），本 store
 * 管**永不落库的那一半**（登录态、点赞/订阅计数与旗标）。两者共用一个上游、
 * 共用一个 client，但存储性质相反，所以不合并成一个 store —— 合并之后，
 * 「哪些字段可以写进 Dexie」这个问题就再没有结构上的答案了（D13/D22）。
 *
 * 三块内容:
 *
 * 1. **登录态**（D19/D20）—— token 存 localStorage（键 {@link WORKSHOP_AUTH_STORAGE_KEY}），
 *    用户信息每次从 JWT 本地解码（O1：`/api/auth/me` 返回的就是 payload 抄回来，
 *    调它纯属浪费一个请求）。启动时本地判 `exp`，过期即静默登出。
 *    🔴 token **绝不进 Dexie、绝不进 FullBackup、绝不进 URL**（D20）。
 *
 * 2. **登录编排**（D19）—— 弹窗 + postMessage 快路径 + 2 秒轮询兜底 + 60 秒超时 +
 *    单飞。快路径的验签是**双重**的（`source` 常量 + 本次 `state`），见
 *    {@link acceptCallbackMessage}。
 *
 * 3. **社交覆盖层**（D23/§3.3）—— `overrides[projectId]` 是 toggle 响应写下的权威值，
 *    优先于列表/详情响应里那份可能已经被缓存的旧数据。显示规则见 {@link socialOf}。
 *
 * 注入缝: {@link setWorkshopSocialEnv}（弹窗 / postMessage 订阅 / 时钟）。
 * 测试全程注入，**不开真弹窗、不发真实请求**（网络那侧走 client 的 `setWorkshopFetch`）。
 *
 * 🔴 真实 Discord OAuth（含服务器成员门槛路径）必须人工走一遍，助手不代操作账号登录。
 *
 * 设计: docs/planning/2026-08-01-workshop-social-design.md D19/D20/D22/D23/D24/D25 + O1/O3/O4/O5
 */
import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import type { WorkshopSocialMeta } from '@engine/workshop-types';
import {
  clearWorkshopCache,
  decodeJwtPayload,
  getWorkshopApiBase,
  parseAuthUser,
  pollLogin,
  setWorkshopAuthTokenProvider,
  startLogin,
  toggleLike as clientToggleLike,
  toggleSubscribe as clientToggleSubscribe,
  type WorkshopAuthUser,
  type WorkshopToggleKind,
} from '../lib/workshop-client';

/**
 * ★ 与 client 共用**同一个** JWT 解码实现，不在本文件另写一份。
 *
 * 两处解码一旦漂移（比如一边容忍 base64url 的 padding、一边不容忍），就会出现
 * 「UI 说已登出，缓存却还挂在 `u<id>` 的桶上」这种没人查得出来的错位。
 * 这里 re-export 是为了让 UI 与测试有一个「就在社交 store 旁边」的入口。
 */
export { decodeJwtPayload };

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** localStorage 键。只存 `{ token }` —— user 每次解码，不留会过期的快照（D20） */
export const WORKSHOP_AUTH_STORAGE_KEY = 'workshop-auth';

/**
 * 回调页 postMessage 的 `source` 常量（上游 `endpoints/auth.ts:59-68` 硬编码）。
 *
 * ⚠️ 它**不是安全边界** —— 回调页先发给记录的 origin，随后**广播给 `'*'`**，
 * 任意页面都能读到、也就都能照抄这个串再发一遍给我们。真正防伪造的是 `state`
 * （只有我们和 worker 知道的一次性 UUID），本常量只负责过滤掉「不是给我们的消息」。
 */
export const WORKSHOP_CALLBACK_SOURCE = 'creative-workshop-auth-callback';

/**
 * 轮询间隔 —— 2 秒（O3；上游参考实现是 1 秒，我们放宽一半）。
 *
 * 敢放宽是因为 postMessage 快路径才是正常路径：轮询只在「弹窗被浏览器拦掉 message、
 * 或者用户把回调页手动挪到了别的标签」这类边角情况下兜底。60 秒里最多问 30 次，
 * 而快路径命中后一次都不问（poll 是**单次消费**，多问一次会把结果吃掉又扔掉）。
 */
export const WORKSHOP_LOGIN_POLL_INTERVAL_MS = 2_000;

/**
 * 登录总超时 —— 60 秒（D19）。
 *
 * 超时之后只是**我们不等了**（停轮询、停监听），不去关用户的弹窗:
 * 那时他很可能正在 Discord 的登录页上输密码/二次验证，替他关掉窗口是最讨厌的
 * 一种「帮忙」。他授权完之后重新点一次登录即可。
 */
export const WORKSHOP_LOGIN_TIMEOUT_MS = 60_000;

/**
 * 单个（项目 × 动作）的点击节流 —— 800 毫秒（D23）。
 *
 * 服务端**零限流**（源码 grep 无任何 rate limit），所以这一层完全是我们自觉当好
 * 公民；同时它也顺手挡掉了双击带来的「赞了又取消」——翻转语义下那是真的会发生的。
 *
 * 为什么按（项目 × 动作）而不是整个项目一把锁: 点赞与订阅是两个互不相干的端点，
 * 「刚点完赞马上想订阅」被卡 800 毫秒只会让人以为按钮坏了。
 */
export const WORKSHOP_TOGGLE_THROTTLE_MS = 800;

/** 计数全 0、旗标全 false —— 乐观更新在「什么都不知道」时的起点 */
const ZERO_SOCIAL: WorkshopSocialMeta = {
  likesCount: 0,
  subscribesCount: 0,
  downloadsCount: 0,
  userLiked: false,
  userSubscribed: false,
};

// ═══════════════════════════════════════════════════════════
// 注入缝
// ═══════════════════════════════════════════════════════════

/** 弹窗句柄里我们真正会碰的那一点点面（测试可以交个空对象） */
export interface WorkshopPopupLike {
  closed?: boolean;
}

/**
 * 宿主环境的三件事。抽出来是因为它们**在 `environment:'node'` 的测试里全都不存在**，
 * 而登录编排的每一条分支（伪造消息、快路径、超时）都必须能被测到。
 */
export interface WorkshopSocialEnv {
  /** 开弹窗；被浏览器拦下时返回 `null`（这是唯一能察觉「被拦了」的信号） */
  openPopup: (url: string) => WorkshopPopupLike | null;
  /** 订阅 postMessage，返回退订函数。只在登录期间挂着，settle 即摘 */
  onMessage: (handler: (data: unknown) => void) => () => void;
  now: () => number;
}

/**
 * 起飞端点回来的授权地址，开弹窗**之前**必须过这一关。
 *
 * 🔴 这个 URL 是上游 JSON 里的一个字段 —— 也就是说它由服务端（或任何能改写那条响应
 * 的人）说了算，而我们拿它去 `window.open`。两条真实后果：
 *
 * 1. **`javascript:` / `data:` 协议**：弹窗会在一个与本源关联的上下文里执行那段脚本，
 *    而本站的 localStorage 里躺着 API Key、IndexedDB 里躺着存档。
 * 2. **反向标签劫持**：弹窗刻意保留 `opener`（`noopener=no`，因为登录要靠 postMessage
 *    回传），所以被打开的页面可以 `opener.location = 钓鱼页` —— 而这个弹窗的全部意义
 *    就是让用户在上面输账号密码，正是最不该省这一刀的地方。
 *
 * 所以只放行 https，且主机名钉死在 Discord 与工坊 worker 两个域（含子域）。放宽这里
 * 之前先想清楚：任何一个能被上游指定的第三方域，都能拿到本站的 opener。
 */
export function isAllowedLoginUrl(raw: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return false; // 相对地址 / 畸形串一律拒 —— 登录地址必须是绝对的
  }
  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  return loginUrlHosts().some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * 允许开弹窗的主机（含子域）。Discord 授权页 + 当前配置的工坊 worker 自己。
 *
 * 🔴 **每次调用现算**，不是模块级常量（D41）：社区源改成运行时配置之后，模块加载那一刻
 * 它还是空串——把名单在 import 期冻住，等于永远只放行 discord.com，而工坊自己的回跳域
 * 会被自己的白名单拒掉。未配置时 `new URL('')` 会抛，所以那一支返回空补位而不是让它炸。
 */
function loginUrlHosts(): string[] {
  const hosts = ['discord.com'];
  const base = getWorkshopApiBase();
  if (base !== '') {
    try {
      hosts.push(new URL(base).hostname.toLowerCase());
    } catch {
      /* 配置值畸形 → 只剩 discord.com（宁可拒登录，不放行未知域） */
    }
  }
  return hosts;
}

function browserWindow(): (Window & typeof globalThis) | undefined {
  const scope = globalThis as { window?: Window & typeof globalThis };
  return typeof scope.window === 'object' && scope.window ? scope.window : undefined;
}

function defaultEnv(): WorkshopSocialEnv {
  return {
    openPopup: (url) => {
      const win = browserWindow();
      if (!win || typeof win.open !== 'function') return null;
      return win.open(url, 'workshop-discord-login', 'width=520,height=760,noopener=no');
    },
    onMessage: (handler) => {
      const win = browserWindow();
      if (!win || typeof win.addEventListener !== 'function') return () => {};
      const listener = (event: MessageEvent): void => handler(event.data);
      win.addEventListener('message', listener);
      return () => win.removeEventListener('message', listener);
    },
    now: () => Date.now(),
  };
}

let env: WorkshopSocialEnv = defaultEnv();

/** 换掉宿主环境（测试用）。传 `undefined` 恢复真实 window */
export function setWorkshopSocialEnv(next?: Partial<WorkshopSocialEnv>): void {
  env = next ? { ...defaultEnv(), ...next } : defaultEnv();
}

/** localStorage 可能整个不可用（隐私模式 / node 测试），一律容错 */
interface StorageLike {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function storage(): StorageLike | undefined {
  try {
    const scope = globalThis as { localStorage?: StorageLike };
    return scope.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

// ═══════════════════════════════════════════════════════════
// 对外形状
// ═══════════════════════════════════════════════════════════

/** 登录阶段。`failed` 时 `loginError` 有人话，UI 直接展示（D25） */
export type WorkshopLoginPhase = 'idle' | 'pending' | 'success' | 'failed';

/**
 * 一次 toggle 的收场。四种给 UI 的处置完全不同，所以不塞进一个 boolean:
 * - `ok` 更新计数
 * - `skipped` 什么都不做（节流/在飞，用户自己连点的）
 * - `unauthorized` 引导登录（**不是**错误提示）
 * - `failed` 提示失败，且本地值已回滚到操作前
 */
export type WorkshopToggleOutcome =
  | { status: 'ok'; social: WorkshopSocialMeta }
  | { status: 'skipped'; reason: 'throttled' | 'busy' }
  | { status: 'unauthorized' }
  | { status: 'failed'; message: string };

/** `login()` 的收场（同样是判别联合，UI 不必去猜 phase） */
export type WorkshopLoginOutcome =
  { status: 'success'; user: WorkshopAuthUser | null } | { status: 'failed'; message: string };

// ═══════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════

export const useWorkshopSocialStore = defineStore('workshop-social', () => {
  /** 当前 Bearer JWT；`null` = 未登录。**唯一真源**，localStorage 只是它的持久化投影 */
  const token = ref<string | null>(null);
  /** 从 token 解出来的用户快照（O1，不调 `/api/auth/me`） */
  const user = ref<WorkshopAuthUser | null>(null);
  const loginPhase = ref<WorkshopLoginPhase>('idle');
  const loginError = ref<string | null>(null);

  /**
   * 项目 id → 最权威的社交值（D23）。只有两个写入者：toggle 的响应、以及登录/登出
   * 时的整体清空。**绝不落库**（D22）。
   */
  const overrides = ref<Record<string, WorkshopSocialMeta>>({});

  /** `${kind}:${projectId}` → 是否有一发 toggle 在路上（按钮据此禁用） */
  const inflight = ref<Record<string, boolean>>({});

  const isLoggedIn = computed(() => token.value !== null);

  /** 上一次真的发出去的时刻，按 `${kind}:${projectId}` 记 —— 节流用 */
  const lastFiredAt = new Map<string, number>();
  /** 单飞：登录期间重复点「登录」共用同一个 Promise（D19） */
  let loginTask: Promise<WorkshopLoginOutcome> | null = null;
  let initialized = false;

  // ───────────────────────────────────────────
  // 启动
  // ───────────────────────────────────────────

  /**
   * 挂载时调一次（幂等）。做两件事:
   *
   * 1. 把 token provider 注册给 client（D21）—— **无论有没有登录都要注册**，
   *    因为 provider 是「现取」的，注册的是取值的方式而不是当时的值。
   * 2. 从 localStorage 恢复 token，并**本地判 `exp`**（D20/O1）：过期就静默清掉。
   *    不静默清的话，用户会看到自己的头像、点赞却每次 401 —— 一个「登录了但什么
   *    都干不了」的状态，比干脆显示未登录难懂得多。上游没有刷新端点，7 天到期
   *    就是要重新登录。
   */
  function init(): void {
    if (initialized) return;
    initialized = true;
    setWorkshopAuthTokenProvider(() => token.value);
    restoreFromStorage();
  }

  function restoreFromStorage(): void {
    const raw = readStoredToken();
    if (!raw) return;
    const payload = decodeJwtPayload(raw);
    if (!payload || isExpired(payload)) {
      // 静默登出：没有弹窗、没有 toast —— 用户什么都没做，不该被一个提示打扰
      clearStoredToken();
      return;
    }
    token.value = raw;
    user.value = parseAuthUser(payload);
  }

  function readStoredToken(): string | null {
    const store = storage();
    if (!store) return null;
    try {
      const text = store.getItem(WORKSHOP_AUTH_STORAGE_KEY);
      if (!text) return null;
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        const value = (parsed as { token?: unknown }).token;
        if (typeof value === 'string' && value.trim()) return value;
      }
    } catch {
      // 手改坏的、上个版本写的别的形状 —— 当作没登录，绝不抛
    }
    return null;
  }

  function persistToken(): void {
    const store = storage();
    if (!store) return;
    try {
      store.setItem(WORKSHOP_AUTH_STORAGE_KEY, JSON.stringify({ token: token.value }));
    } catch {
      // 配额满 / 隐私模式：登录在本次会话内仍然有效，只是刷新后要重登
    }
  }

  function clearStoredToken(): void {
    const store = storage();
    if (!store) return;
    try {
      store.removeItem(WORKSHOP_AUTH_STORAGE_KEY);
    } catch {
      /* 同上，清不掉也不该抛 */
    }
  }

  /** `exp` 是**秒**（JWT 规范），不是毫秒 —— 混了会让所有 token 立刻算过期 */
  function isExpired(payload: Record<string, unknown>): boolean {
    const exp = payload.exp;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) return false;
    return exp * 1000 <= env.now();
  }

  // ───────────────────────────────────────────
  // 登录 / 登出
  // ───────────────────────────────────────────

  /**
   * 收下一个 token（快路径与轮询共用）。
   *
   * ★ 顺手清掉 client 的内存缓存与 override 层: 身份变了，之前那些
   * `userLiked: false` 全是以「未登录的我」为准算出来的（§1.3），留着只会让用户
   * 登录后看见一屏没赞过的项目，直到 TTL 过期才纠正。
   */
  function adopt(nextToken: string, snapshot: WorkshopAuthUser | null): void {
    token.value = nextToken;
    user.value = snapshot ?? parseAuthUser(decodeJwtPayload(nextToken));
    persistToken();
    overrides.value = {};
    clearWorkshopCache();
  }

  /**
   * 登出 —— **不发任何请求**（O4）。
   *
   * 上游 `POST /api/auth/logout` 是纯 no-op（后端 `endpoints/auth.ts:383-399`）：
   * 无 Cookie 可清、无黑名单可写。发过去只是让用户多等一个往返，还多一条会失败的
   * 路径（断网时难道要拒绝登出？）。丢掉本地 token 就是登出的全部含义。
   */
  function logout(): void {
    token.value = null;
    user.value = null;
    overrides.value = {};
    inflight.value = {};
    lastFiredAt.clear();
    loginPhase.value = 'idle';
    loginError.value = null;
    clearStoredToken();
    // 已登录桶里的响应含个性化旗标，登出后一条都不该再被读到（§3.3）
    clearWorkshopCache();
  }

  /**
   * 一次消息是否是**给我们的、本次登录的**回调（D19 双重验证）。
   *
   * 1. `source` 必须是约定常量 —— 过滤掉页面上其它库的 postMessage 噪音
   * 2. `state` 必须等于**本次**起飞时拿到的那个 UUID —— 这一条才是防伪造的关键:
   *    回调页会把消息广播给 `'*'`，任何页面都能照抄 `source` 再发一遍；但 `state`
   *    是只有我们和 worker 知道的一次性值，攻击者无从伪造
   *
   * 为什么不额外校 `event.origin`: 回调页正是**广播给 `'*'`** 的，而 worker 将来
   * 换自定义域名时 origin 就变了 —— 把它当硬门槛会在某次上游部署后静默地让所有人
   * 登不上，而它换来的安全增量已经被 `state` 覆盖了。
   */
  function acceptCallbackMessage(data: unknown, expectedState: string): string | null {
    if (typeof data !== 'object' || data === null) return null;
    const msg = data as { source?: unknown; state?: unknown; token?: unknown };
    if (msg.source !== WORKSHOP_CALLBACK_SOURCE) return null;
    if (typeof msg.state !== 'string' || msg.state !== expectedState) return null;
    if (typeof msg.token !== 'string' || !msg.token.trim()) return null;
    return msg.token;
  }

  /**
   * 走完整个登录流程（D19）。**单飞** —— 登录期间重复调用共用同一个 Promise，
   * 否则连点两下「登录」会开出两个弹窗、两把 state，第二把把第一把顶掉。
   */
  async function login(): Promise<WorkshopLoginOutcome> {
    if (loginTask) return loginTask;
    loginTask = runLogin().finally(() => {
      loginTask = null;
    });
    return loginTask;
  }

  async function runLogin(): Promise<WorkshopLoginOutcome> {
    loginPhase.value = 'pending';
    loginError.value = null;

    const ticket = await startLogin();
    if (!ticket.ok) return finishLogin({ status: 'failed', message: ticket.error.message });

    // 开弹窗前先验地址（见 isAllowedLoginUrl）—— 这个 URL 由上游响应说了算，
    // 而弹窗刻意保留 opener，放行一个陌生域等于把本站的 opener 递出去
    if (!isAllowedLoginUrl(ticket.data.url)) {
      return finishLogin({
        status: 'failed',
        message: '登录地址不在允许的域名内，已中止（请确认工坊服务是否正常）',
      });
    }

    const popup = env.openPopup(ticket.data.url);
    if (!popup) {
      // 唯一能察觉「被拦」的信号就是 window.open 返回 null。说清楚怎么办，
      // 别让用户对着一个「登录失败」干瞪眼 —— 这是最常见的一种登录不上。
      return finishLogin({
        status: 'failed',
        message: '登录窗口被浏览器拦截了，请允许本站弹出窗口后重试',
      });
    }

    return new Promise<WorkshopLoginOutcome>((resolve) => {
      let settled = false;
      let unsubscribe: () => void = () => {};
      /*
       * eslint prefer-const 会说这两个「从未重新赋值」——它们确实各只赋值一次，但
       * 赋值点（下方 setInterval/setTimeout）在 `settle` 的**定义之后**，而 `settle`
       * 闭包里要清掉它们。改成 const 就得把声明挪到 settle 下面，那样一旦 settle 在
       * 赋值前被调到（快路径先到），读到的就是 TDZ 而不是 undefined —— 一句
       * ReferenceError 换来的是登录卡死。保持 let。
       */
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setInterval> | undefined;
      // eslint-disable-next-line prefer-const
      let deadline: ReturnType<typeof setTimeout> | undefined;
      /** 一发 poll 在路上时不叠第二发 —— poll 是单次消费，叠了会互相吃结果 */
      let polling = false;

      const settle = (outcome: WorkshopLoginOutcome): void => {
        if (settled) return;
        settled = true;
        unsubscribe();
        if (timer !== undefined) clearInterval(timer);
        if (deadline !== undefined) clearTimeout(deadline);
        resolve(finishLogin(outcome));
      };

      const succeed = (nextToken: string, snapshot: WorkshopAuthUser | null): void => {
        adopt(nextToken, snapshot);
        settle({ status: 'success', user: user.value });
      };

      // ── 快路径: 回调页的 postMessage（O3）──
      unsubscribe = env.onMessage((data) => {
        const accepted = acceptCallbackMessage(data, ticket.data.state);
        if (!accepted) return; // 伪造/无关消息：静默丢弃，继续等真的那一条
        const raw = (data as { user?: unknown }).user;
        succeed(accepted, parseAuthUser(raw));
      });

      // ── 兜底: 2 秒轮询（弹窗环境拿不到 message 时的唯一出路）──
      timer = setInterval(() => {
        if (settled || polling) return;
        polling = true;
        void pollLogin(ticket.data.state)
          .then((res) => {
            if (settled) return; // 快路径已经赢了，这一发的结果直接丢
            if (!res.ok) return; // 传输层抖动（断网/超时）→ 继续轮，别把登录判死
            if (res.data.phase === 'success') {
              succeed(res.data.token, res.data.user);
            } else if (res.data.phase === 'failure') {
              // 上游的终局判决，多半是 Discord 服务器成员门槛没过（D25）
              settle({ status: 'failed', message: res.data.message });
            }
            // pending：继续等
          })
          .finally(() => {
            polling = false;
          });
      }, WORKSHOP_LOGIN_POLL_INTERVAL_MS);

      deadline = setTimeout(() => {
        settle({ status: 'failed', message: '登录超时，请重试' });
      }, WORKSHOP_LOGIN_TIMEOUT_MS);
    });
  }

  function finishLogin(outcome: WorkshopLoginOutcome): WorkshopLoginOutcome {
    if (outcome.status === 'success') {
      loginPhase.value = 'success';
      loginError.value = null;
    } else {
      loginPhase.value = 'failed';
      loginError.value = outcome.message;
    }
    return outcome;
  }

  // ───────────────────────────────────────────
  // 社交覆盖层（§3.3）
  // ───────────────────────────────────────────

  /**
   * 显示值的**唯一读取规则**（§3.3）:
   *
   * ```
   * override（toggle 响应写入，最权威）
   *   ?? 本次列表/详情响应顺带解析的那份
   *   ?? undefined —— UI 不显示计数（**不编数字**）
   * ```
   *
   * 为什么 override 必须排在前面: 列表 TTL 有 120 秒，用户刚点完赞再翻回这一页，
   * 拿到的很可能是点赞之前的缓存副本。让缓存覆盖刚刚的操作结果，是最像 bug 的
   * 一种正确行为。
   */
  function socialOf(
    projectId: string,
    fromResponse?: WorkshopSocialMeta,
  ): WorkshopSocialMeta | undefined {
    return overrides.value[projectId] ?? fromResponse;
  }

  function toggleKeyOf(projectId: string, kind: WorkshopToggleKind): string {
    return `${kind}:${projectId}`;
  }

  /** 某个按钮是否该显示忙碌/禁用 */
  function isBusy(projectId: string, kind: WorkshopToggleKind): boolean {
    return inflight.value[toggleKeyOf(projectId, kind)] === true;
  }

  /** 点赞 / 取消点赞（翻转）。语义见 {@link runToggle} */
  async function toggleLike(
    projectId: string,
    displayed?: WorkshopSocialMeta,
  ): Promise<WorkshopToggleOutcome> {
    return runToggle(projectId, 'like', displayed);
  }

  /** 订阅 / 取消订阅（翻转）。语义见 {@link runToggle} */
  async function toggleSubscribe(
    projectId: string,
    displayed?: WorkshopSocialMeta,
  ): Promise<WorkshopToggleOutcome> {
    return runToggle(projectId, 'subscribe', displayed);
  }

  /**
   * 乐观 → 校正 → 回滚，三段（D23）。
   *
   * - **乐观**: 立刻按翻转后的状态写 override，按钮当场有反馈
   * - **校正**: 响应一到就**无条件**用服务端的 `count`/旗标覆盖（O5，零回读）。
   *   不是「取较大值」也不是「只在不同时更新」—— 翻转语义下本地推算随时会与真相
   *   差一，服务端重数出来的那个数字才算数
   * - **回滚**: 失败（含超时）恢复到操作前的那一份，绝不留一个假的 +1 在屏幕上。
   *   ⚠️ 更**绝不自动重试**：翻转语义下重试可能把刚点上的赞又取消掉（§1.2）
   *
   * 未登录时**一发请求都不出去**，直接回 `unauthorized` 让 UI 引导登录。
   */
  async function runToggle(
    projectId: string,
    kind: WorkshopToggleKind,
    displayed?: WorkshopSocialMeta,
  ): Promise<WorkshopToggleOutcome> {
    const id = (projectId ?? '').trim();
    if (!id) return { status: 'failed', message: '缺少项目 id' };
    if (!token.value) return { status: 'unauthorized' };

    const key = toggleKeyOf(id, kind);
    if (inflight.value[key]) return { status: 'skipped', reason: 'busy' };

    const at = env.now();
    const last = lastFiredAt.get(key);
    if (last !== undefined && at - last < WORKSHOP_TOGGLE_THROTTLE_MS) {
      return { status: 'skipped', reason: 'throttled' };
    }
    lastFiredAt.set(key, at);

    const previous = overrides.value[id];
    const base = previous ?? displayed ?? ZERO_SOCIAL;
    const active = kind === 'like' ? !base.userLiked : !base.userSubscribed;
    writeOverride(id, applyToggle(base, kind, active, optimisticCount(base, kind, active)));
    inflight.value = { ...inflight.value, [key]: true };

    try {
      const res = kind === 'like' ? await clientToggleLike(id) : await clientToggleSubscribe(id);

      if (!res.ok) {
        rollback(id, kind, base, previous);

        if (res.error.kind === 'unauthorized') {
          // token 被上游拒了（7 天到期 / 服务端换密钥）。留着它只会让接下来每一次
          // 操作都以同样方式失败，且用户还看着自己的头像 —— 直接退到未登录态。
          logout();
          return { status: 'unauthorized' };
        }
        return { status: 'failed', message: res.error.message };
      }

      // ⚠️ 基线取**落地这一刻**的覆盖层，不是起飞时抓的 `base` —— 节流键按
      //    （项目 × 动作）分开，点赞与订阅可以同时在飞，拿陈旧快照整个盖回去会把
      //    对方期间落地的成果一起重置（applyToggle 只换自己那一对，剩下的是原样 spread）
      const corrected = applyToggle(
        overrides.value[id] ?? base,
        kind,
        res.data.active,
        res.data.count,
      );
      writeOverride(id, corrected);
      return { status: 'ok', social: corrected };
    } finally {
      const next = { ...inflight.value };
      delete next[key];
      inflight.value = next;
    }
  }

  /** 乐观计数：翻转方向决定 ±1，且不许算出负数（本地基线本来就可能是 0） */
  function optimisticCount(
    base: WorkshopSocialMeta,
    kind: WorkshopToggleKind,
    active: boolean,
  ): number {
    return Math.max(0, countOf(base, kind) + (active ? 1 : -1));
  }

  /**
   * 失败回滚：只把**本动作那一对字段**放回起飞前的值，另一对原样留着 ——
   * 并发的另一个动作可能已经在这期间落地，整份盖回去/整份删掉都会误伤它。
   *
   * 删除覆盖层的条件也随之收紧：只有「起飞前本来就没有覆盖层」**且**「放回去之后
   * 恰好等于起飞时那份基线」才删 —— 后者不成立就说明期间有别的动作写过，得留着。
   */
  function rollback(
    projectId: string,
    kind: WorkshopToggleKind,
    base: WorkshopSocialMeta,
    previous: WorkshopSocialMeta | undefined,
  ): void {
    const current = overrides.value[projectId];
    if (!current) return; // 已经被别处清干净了，没什么可放回的

    const restored = applyToggle(current, kind, flagOf(base, kind), countOf(base, kind));
    if (previous === undefined && sameSocial(restored, base)) removeOverride(projectId);
    else writeOverride(projectId, restored);
  }

  function flagOf(social: WorkshopSocialMeta, kind: WorkshopToggleKind): boolean {
    return kind === 'like' ? social.userLiked : social.userSubscribed;
  }

  function countOf(social: WorkshopSocialMeta, kind: WorkshopToggleKind): number {
    return kind === 'like' ? social.likesCount : social.subscribesCount;
  }

  function sameSocial(a: WorkshopSocialMeta, b: WorkshopSocialMeta): boolean {
    return (
      a.userLiked === b.userLiked &&
      a.likesCount === b.likesCount &&
      a.userSubscribed === b.userSubscribed &&
      a.subscribesCount === b.subscribesCount &&
      a.downloadsCount === b.downloadsCount
    );
  }

  /** 只动本动作那一对字段，另一对（以及 downloadsCount）原样保留 */
  function applyToggle(
    base: WorkshopSocialMeta,
    kind: WorkshopToggleKind,
    active: boolean,
    count: number,
  ): WorkshopSocialMeta {
    return kind === 'like'
      ? { ...base, userLiked: active, likesCount: count }
      : { ...base, userSubscribed: active, subscribesCount: count };
  }

  function writeOverride(projectId: string, social: WorkshopSocialMeta): void {
    overrides.value = { ...overrides.value, [projectId]: social };
  }

  function removeOverride(projectId: string): void {
    const next = { ...overrides.value };
    delete next[projectId];
    overrides.value = next;
  }

  return {
    // 状态
    token,
    user,
    loginPhase,
    loginError,
    overrides,
    inflight,
    isLoggedIn,
    // 生命周期
    init,
    login,
    logout,
    // 社交
    socialOf,
    isBusy,
    toggleLike,
    toggleSubscribe,
  };
});
