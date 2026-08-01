/**
 * workshop-client.ts — 创意工坊上游 REST 的**唯一网络接触点**（Phase 1 / P1-2）
 *
 * 为什么只有一处: 上游是第三方持续演进的服务，它的 base URL、路径、查询参数、
 * 错误形状都会变。全应用只留这一个文件碰 `fetch`，等于把「上游改了」这件事的
 * 影响面钉死在一个可以逐行断言的模块里。store / 组件 **一律不许自己发请求**。
 *
 * 三条职责，仅此而已:
 * 1. 拼 URL、发请求、读字节
 * 2. 把原始 JSON 交给 `workshop-manifest` 的纯函数解析 —— **本模块自己不做任何
 *    字段转换**。多一处 `raw.coverImage ?? raw.coverUrl` 就是第二套解析规则，
 *    上游改名时两处只会改一处
 * 3. TTL 内存缓存 + 并发去重
 * 4. **超时与取消** —— `fetch` 默认不超时，没有这一层，上游挂起就等于页面永久转圈。
 *    每次请求都戴上 {@link WORKSHOP_REQUEST_TIMEOUT_MS}（载荷用
 *    {@link WORKSHOP_PAYLOAD_TIMEOUT_MS}）的闸，调用方还可另传 `signal` 主动取消
 *
 * ⚠️ **永不抛穿**（唯一的例外是调用方自己传了会抛的 fetch 实现，那也被 try 兜住）。
 * 网络失败、HTTP 非 2xx、响应不是 JSON、JSON 里没有 id —— 全部变成
 * `{ ok: false, error }` 返回。上层据此把项目置 `installState: 'broken'`（D17）。
 * 一次上游抽风不该让工坊页白屏，更不该冒泡成未捕获的 Promise rejection。
 *
 * ⚠️ **正则条目不在载荷文件里**（P1-1 实测）: 世界书条目来自 `downloadUrl` 下载的
 * 载荷，正则条目来自**详情响应**的 `regexEntriesPreview` 字段。后者名字里虽写着
 * "Preview"，实测带**完整** `replaceString`（最长 340 KB），不是截断预览。所以
 * 喂给 `planInstall()` 的 `WorkshopInstallInput` 必须由**两个响应合成** ——
 * 这正是 `fetchInstallInput()` 存在的理由，别让调用方各自去合。
 *
 * 缓存边界: **只在内存**，不落库。它是「省一次往返」的加速器，不是离线能力 ——
 * 离线走的是本地 `project-{id}.json` 文件导入那条并行来源（D17）。刷新页面即清空，
 * 这正好也是用户「怎么还是旧的」时的自然解法。
 *
 * 注入缝: `setWorkshopFetch()` / `setWorkshopClock()`。测试全程 mock，
 * **绝不发真实请求**。
 *
 * 设计: docs/planning/2026-07-31-creative-workshop-compat-design.md D17 / 附录 C
 */

import { parsePayload, parseProjectMeta } from '@engine/workshop-manifest';
import type {
  WorkshopInstallInput,
  WorkshopPayload,
  WorkshopProjectMeta,
  WorkshopSourceEntry,
  WorkshopSourceRegex,
} from '@engine/workshop-types';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 上游 worker 的 base URL。
 *
 * 提成常量而非散在各处，是为了将来换后端（自建代理 / 镜像 / 本地 mock 服务）
 * 只改一行。**不带尾斜杠** —— 拼接一律 `${BASE}/api/...`。
 */
export const WORKSHOP_API_BASE = 'https://poemofdestinycreativeworkshop.1528779666.workers.dev';

/** 项目详情 TTL —— 5 分钟（沿用上游卡内缓存量级，D17） */
export const WORKSHOP_DETAIL_TTL_MS = 5 * 60 * 1000;

/**
 * 载荷 TTL —— 15 小时（同上）。
 *
 * 比详情长两个数量级是有道理的: 载荷是**版本内不可变**的内容（上游发新版会换
 * `downloadUrl`），而详情里的版本号/计数是随时会动的元数据。缓存键是完整 URL，
 * 所以新版本天然是新键，不会吃到旧字节。
 */
export const WORKSHOP_PAYLOAD_TTL_MS = 15 * 60 * 60 * 1000;

/** `GET /api/projects` 的服务端缺省（附录 C），我们显式带上以便请求可复现 */
export const WORKSHOP_DEFAULT_PAGE_SIZE = 20;
export const WORKSHOP_DEFAULT_SORT = 'published';

/**
 * 上游 `sort` 的合法取值（服务端是 `z.enum`，传别的会 400）。
 *
 * 排序在**服务端**做，翻页才是对的 —— 只对当前页重排会得出「第 2 页的热门项目
 * 排在第 1 页的冷门项目之前」这种自相矛盾的结果。所以改排序必须重拉且回到第 0 页。
 *
 * 我们不消费点赞/订阅/下载的**计数**（社交面属 Phase 3+），但按它们**排序**只是
 * 一个查询参数，不需要在本地建任何社交状态。
 */
export const WORKSHOP_SORT_MODES = [
  'published',
  'updated',
  'likes',
  'subscribes',
  'downloads',
] as const;

export type WorkshopSortMode = (typeof WORKSHOP_SORT_MODES)[number];

/**
 * 元数据请求（列表 / 详情）的超时上限。
 *
 * 为什么必须有: `fetch` **默认不超时**。上游 worker 冷启动卡住、代理吞掉连接、
 * 移动网络切换 —— 这些都不会让 Promise 兑现，于是工坊页会一直转圈，用户既看不到
 * 错误也点不动重试。判别联合把「失败」建模得再干净，也救不了一个永远不兑现的
 * Promise。15 秒是「用户还愿意等」与「Cloudflare 冷启动最坏情况」的折中。
 */
export const WORKSHOP_REQUEST_TIMEOUT_MS = 15_000;

/**
 * 载荷下载的超时上限 —— 比元数据宽 4 倍。
 *
 * 载荷实测可达 340 KB 级且走 worker 代理，慢速网络下 15 秒真的不够；而它又是
 * 用户主动点了「安装」之后的等待，容忍度天然更高。
 */
export const WORKSHOP_PAYLOAD_TIMEOUT_MS = 60_000;

// ═══════════════════════════════════════════════════════════
// 结果类型
// ═══════════════════════════════════════════════════════════

/**
 * 失败分类。UI 要据此说人话:
 * - `network` fetch 本身炸了（断网 / DNS / CORS 被浏览器拦下 / 没有 fetch 实现）
 * - `http`    连上了但非 2xx，`status` 有值（404 = 项目已下架）
 * - `malformed` 拿到了字节但不是能用的 JSON，或 JSON 里缺 id 这种致命字段
 * - `no_source` 上游没给 `downloadUrl` 也没给预览条目，无内容可装
 * - `timeout`   超过 {@link WORKSHOP_REQUEST_TIMEOUT_MS} / {@link WORKSHOP_PAYLOAD_TIMEOUT_MS}
 *               仍未兑现 —— 与 `network` 分开，是因为文案与处置都不同（「上游没响应，
 *               稍后重试」而非「检查网络」）
 * - `cancelled` **用户/调用方主动取消**（翻页、改搜索词、关模态）。⚠️ 它不是错误:
 *               UI 收到这一类**不应弹提示、不应置 broken**，静默丢弃即可
 */
export type WorkshopFailureKind =
  'network' | 'http' | 'malformed' | 'no_source' | 'timeout' | 'cancelled';

export interface WorkshopFailure {
  kind: WorkshopFailureKind;
  /** 面向开发者的原因串；UI 可直接展示，但不该拿它做判定 */
  message: string;
  /** 仅 `kind: 'http'` 有值 */
  status?: number;
  /** 出事的 URL，便于用户回报问题时贴出来 */
  url: string;
}

/**
 * 判别联合而非 `throw` —— 见文件头「永不抛穿」。
 *
 * `fromCache` 让 UI 能区分「刚拉的」与「缓存里的」，也让测试能断言 TTL 行为
 * 而不必去数 fetch 调用次数。
 */
export type WorkshopResult<T> =
  { ok: true; data: T; fromCache: boolean } | { ok: false; error: WorkshopFailure };

// ═══════════════════════════════════════════════════════════
// 请求/响应形状
// ═══════════════════════════════════════════════════════════

/** `GET /api/projects` 的查询参数（附录 C）。全部可选，缺省对齐服务端 */
export interface WorkshopListQuery {
  /** 从 0 起（上游语义），非法值归一到 0 */
  page?: number;
  pageSize?: number;
  /** 单标签筛选；空串/空白视为不传 */
  tag?: string;
  /** 搜索词；空串/空白视为不传 */
  search?: string;
  sort?: string;
}

/** 列表页结果 */
export interface WorkshopListPage {
  /** 上游报的总数（拿不到时回退成本页条数，UI 至少不会算出负数页） */
  total: number;
  page: number;
  pageSize: number;
  projects: WorkshopProjectMeta[];
  /** 因缺 id 被 `parseProjectMeta` 拒掉的条数 —— 非 0 时值得在 UI 上说一句 */
  droppedCount: number;
}

/**
 * 项目详情结果。
 *
 * `regexEntries` 是**正则条目的唯一来源**（见文件头）；`previewEntries` 是详情里
 * 顺带给的世界书条目预览，仅在没有 `downloadUrl` 时才被当作内容源使用。
 */
export interface WorkshopProjectDetail {
  project: WorkshopProjectMeta;
  regexEntries: WorkshopSourceRegex[];
  previewEntries: WorkshopSourceEntry[];
}

/** `fetchInstallInput()` 的产物 —— 可直接喂 `planInstall()` */
export interface WorkshopBundle {
  /** 详情 + 载荷合成的安装输入 */
  input: WorkshopInstallInput;
  /** 世界书条目实际取自哪一侧 */
  entriesSource: 'download' | 'detail_preview';
  /**
   * 客户端侧的处置记录，语义同 `InstallPlan.droppedNotes`（丢弃必须 loud）。
   * 调用方应把它并进 plan 的 notes 一起展示，别默默吞掉。
   */
  notes: string[];
}

// ═══════════════════════════════════════════════════════════
// 注入缝
// ═══════════════════════════════════════════════════════════

/** 只用到的那点 Response 面 —— 测试可以交个字面量，不必造真 Response */
export interface WorkshopResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  text: () => Promise<string>;
}

/** 传给 fetch 的第二参数 —— 只用 `signal` 这一项，别在这里长出第二套请求配置 */
export interface WorkshopFetchInit {
  signal?: AbortSignal;
}

/**
 * `init` **可选**是刻意的: 既有测试里的 `async (url) => …` 一字不改仍然合法，
 * 而真实实现（`globalThis.fetch`）会收到 signal。
 */
export type WorkshopFetchLike = (
  url: string,
  init?: WorkshopFetchInit,
) => Promise<WorkshopResponseLike>;

/** 调用方可传的取消信号 —— 四个公开 API 共用这一个形状 */
export interface WorkshopAbortable {
  /**
   * 主动取消。中断后返回 `kind: 'cancelled'`，**不写缓存、不算失败**。
   *
   * ⚠️ 带 signal 的请求**不参与在飞去重**（见 {@link withCache}）: 一个人按了
   * 取消不该把另一个还等着的调用方一起掐掉。
   */
  signal?: AbortSignal;
}

let injectedFetch: WorkshopFetchLike | undefined;
let clock: () => number = () => Date.now();

/**
 * 换掉 fetch 实现（测试 / 将来换传输层）。传 `undefined` 恢复用 `globalThis.fetch`。
 *
 * 默认实现是**惰性取用**的: 仅 import 本模块不碰任何浏览器全局，vitest
 * `environment:'node'` 下可直接导入（对齐 media-hash.ts 的做法）。
 */
export function setWorkshopFetch(impl?: WorkshopFetchLike): void {
  injectedFetch = impl;
}

/** 换掉时钟（TTL 测试用）。传 `undefined` 恢复 `Date.now` */
export function setWorkshopClock(fn?: () => number): void {
  clock = fn ?? (() => Date.now());
}

function resolveFetch(): WorkshopFetchLike | undefined {
  if (injectedFetch) return injectedFetch;
  const scope = globalThis as { fetch?: unknown };
  if (typeof scope.fetch === 'function') {
    const native = scope.fetch as (
      input: string,
      init?: WorkshopFetchInit,
    ) => Promise<WorkshopResponseLike>;
    // 绑回 globalThis：某些实现（含 undici）对 this 敏感
    return (url: string, init?: WorkshopFetchInit) => native.call(globalThis, url, init);
  }
  return undefined;
}

/**
 * 一次请求的中断闸: 内部超时 + 调用方外部信号，合成一个交给 fetch 的 signal。
 *
 * 不用 `AbortSignal.timeout()` / `AbortSignal.any()`: 前者在旧 Safari 缺席，后者
 * 是 2024 才铺开的 API，而本模块是全应用唯一的网络口，不值得为省八行代码押上
 * 一个「某些浏览器上永不超时」的静默退化。
 *
 * `timedOut()` 让调用点能把「超时」与「用户取消」分开报 —— 两者在 fetch 眼里
 * 都只是同一个 AbortError。
 */
interface TimeoutGuard {
  signal?: AbortSignal;
  timedOut: () => boolean;
  dispose: () => void;
}

function armTimeout(timeoutMs: number, external?: AbortSignal): TimeoutGuard {
  const Ctor = (globalThis as { AbortController?: typeof AbortController }).AbortController;
  // 没有 AbortController（极老环境 / 精简 runtime）: 原样透传外部信号，
  // 超时能力降级为无 —— 降级也好过在这里抛出去
  if (typeof Ctor !== 'function') {
    return { signal: external, timedOut: () => false, dispose: () => {} };
  }

  const ctrl = new Ctor();
  let fired = false;
  const timer = setTimeout(
    () => {
      fired = true;
      ctrl.abort();
    },
    Math.max(1, timeoutMs),
  );

  const relay = (): void => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', relay);
  }

  return {
    signal: ctrl.signal,
    timedOut: () => fired,
    dispose: () => {
      clearTimeout(timer);
      external?.removeEventListener('abort', relay);
    },
  };
}

// ═══════════════════════════════════════════════════════════
// TTL 内存缓存 + 并发去重
// ═══════════════════════════════════════════════════════════

interface CacheRow {
  value: unknown;
  expiresAt: number;
}

const cache = new Map<string, CacheRow>();
/**
 * 在飞的请求，按缓存键去重。
 *
 * 为什么必要: 载荷可以到 340 KB 级，而 UI 上「双击安装」「详情页与列表同时刷」
 * 这类并发是常态。没有去重就是两份 340 KB 同时在路上，且两边各自解析一遍。
 * 只挂**成功也失败**的同一个 Promise —— 失败不写缓存，所以下一次调用会真的重试。
 */
const inflight = new Map<string, Promise<WorkshopResult<unknown>>>();

/** 清空缓存与在飞记录。测试的 `beforeEach`、以及 UI 上的「强制刷新」都用它 */
export function clearWorkshopCache(): void {
  cache.clear();
  inflight.clear();
}

/** 测试拆除口: 清缓存 + 复位两个注入缝 */
export function resetWorkshopClient(): void {
  clearWorkshopCache();
  setWorkshopFetch(undefined);
  setWorkshopClock(undefined);
}

function readCache<T>(key: string): T | undefined {
  const row = cache.get(key);
  if (!row) return undefined;
  if (row.expiresAt <= clock()) {
    cache.delete(key);
    return undefined;
  }
  return row.value as T;
}

function writeCache(key: string, value: unknown, ttlMs: number): void {
  cache.set(key, { value, expiresAt: clock() + ttlMs });
}

/**
 * 缓存 + 去重的统一包装。
 *
 * 只有 `ok: true` 才进缓存 —— **失败绝不缓存**。缓存一次网络抖动等于让用户在
 * TTL 到期前都修不好，而重试一次请求的代价远小于此。
 */
async function withCache<T>(
  key: string,
  ttlMs: number,
  force: boolean,
  run: () => Promise<WorkshopResult<T>>,
  /**
   * 本次调用自带取消信号 → **退出去重池**：既不复用别人的在飞 Promise，也不把自己
   * 挂上去。否则「A 取消」会顺手掐死同键的 B，或者 B 的取消让 A 收到 `cancelled`
   * —— 一个调用方按了取消，另一个调用方的请求就此消失，是最难查的一类幽灵。
   * 代价只是同一份内容偶尔多下一次。
   */
  standalone = false,
): Promise<WorkshopResult<T>> {
  if (force) {
    cache.delete(key);
  } else {
    const hit = readCache<T>(key);
    if (hit !== undefined) return { ok: true, data: hit, fromCache: true };
    if (!standalone) {
      const pending = inflight.get(key);
      if (pending) return (await pending) as WorkshopResult<T>;
    }
  }

  const task = (async (): Promise<WorkshopResult<T>> => {
    const result = await run();
    if (result.ok) writeCache(key, result.data, ttlMs);
    return result;
  })();

  if (standalone) return task;

  inflight.set(key, task as Promise<WorkshopResult<unknown>>);
  try {
    return await task;
  } finally {
    inflight.delete(key);
  }
}

// ═══════════════════════════════════════════════════════════
// 传输原语
// ═══════════════════════════════════════════════════════════

/**
 * 发一次 GET 并把响应体解析成 JSON。**永不抛**。
 *
 * 用 `text()` 再 `JSON.parse` 而不是 `res.json()`: 上游出错时（worker 502、
 * Cloudflare 拦截页）返回的是 HTML，`res.json()` 抛出的错误信息毫无信息量；
 * 自己 parse 才能在 message 里带上响应开头那几十个字符，用户一贴就知道是什么。
 *
 * ⚠️ 不做任何长度截断 —— 340 KB 的 `replaceString` 必须原样拿到。
 */
async function fetchJson(
  url: string,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<WorkshopResult<unknown>> {
  const impl = resolveFetch();
  if (!impl) {
    return { ok: false, error: { kind: 'network', message: '当前环境没有可用的 fetch', url } };
  }
  // 调用方已经取消了才轮到我们 —— 别白发一次请求
  if (opts.signal?.aborted) {
    return { ok: false, error: { kind: 'cancelled', message: '请求已取消', url } };
  }

  const guard = armTimeout(opts.timeoutMs ?? WORKSHOP_REQUEST_TIMEOUT_MS, opts.signal);

  /** 中断类错误的统一归类: 超时优先于取消（超时也会让外部看到 aborted） */
  const abortFailure = (err: unknown): WorkshopResult<unknown> | undefined => {
    if (guard.timedOut()) {
      return {
        ok: false,
        error: {
          kind: 'timeout',
          message: `上游 ${Math.round((opts.timeoutMs ?? WORKSHOP_REQUEST_TIMEOUT_MS) / 1000)} 秒未响应`,
          url,
        },
      };
    }
    if (opts.signal?.aborted) {
      return { ok: false, error: { kind: 'cancelled', message: '请求已取消', url } };
    }
    // 不是我们发起的中断 —— 交回普通网络错误分支
    void err;
    return undefined;
  };

  try {
    let res: WorkshopResponseLike;
    try {
      res = await impl(url, { signal: guard.signal });
    } catch (err) {
      return (
        abortFailure(err) ?? {
          ok: false,
          error: { kind: 'network', message: describeError(err), url },
        }
      );
    }

    if (!res || typeof res.text !== 'function') {
      return { ok: false, error: { kind: 'malformed', message: '响应对象不可读', url } };
    }

    if (!res.ok) {
      const status = typeof res.status === 'number' ? res.status : 0;
      return {
        ok: false,
        error: {
          kind: 'http',
          status,
          message: `上游返回 ${status} ${res.statusText ?? ''}`.trim(),
          url,
        },
      };
    }

    let text: string;
    try {
      // 读体也在超时之内 —— 340 KB 的载荷卡在中途同样是「一直转圈」
      text = await res.text();
    } catch (err) {
      return (
        abortFailure(err) ?? {
          ok: false,
          error: { kind: 'network', message: describeError(err), url },
        }
      );
    }

    try {
      return { ok: true, data: JSON.parse(text) as unknown, fromCache: false };
    } catch {
      return {
        ok: false,
        error: { kind: 'malformed', message: `响应不是合法 JSON：${preview(text)}`, url },
      };
    }
  } finally {
    guard.dispose();
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return '请求失败';
}

/** 只为错误信息取个开头，不是内容截断 */
function preview(text: string): string {
  const head = text.slice(0, 80).replace(/\s+/g, ' ').trim();
  return head.length > 0 ? head : '(空响应)';
}

// ═══════════════════════════════════════════════════════════
// URL 拼装
// ═══════════════════════════════════════════════════════════

function normalizePage(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function normalizePageSize(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return WORKSHOP_DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.trunc(value));
}

/**
 * 拼列表 URL。**导出**是为了让测试直接断言参数拼装，而不必从 fetch mock 里挖。
 *
 * `page` / `pageSize` / `sort` 恒带（请求可复现、缓存键稳定）；`tag` / `search`
 * 只在有内容时带 —— 带上空串会让上游按「筛选空标签」理解，实测返回空列表。
 */
export function buildListUrl(query: WorkshopListQuery = {}): string {
  const params = new URLSearchParams();
  params.set('page', String(normalizePage(query.page)));
  params.set('pageSize', String(normalizePageSize(query.pageSize)));
  params.set('sort', (query.sort ?? '').trim() || WORKSHOP_DEFAULT_SORT);

  const tag = (query.tag ?? '').trim();
  if (tag) params.set('tag', tag);
  const search = (query.search ?? '').trim();
  if (search) params.set('search', search);

  return `${WORKSHOP_API_BASE}/api/projects?${params.toString()}`;
}

/** 拼详情 URL。id 一律 encode —— 上游 id 是 uuid，但别赌它永远是 */
export function buildProjectUrl(projectId: string): string {
  return `${WORKSHOP_API_BASE}/api/projects/${encodeURIComponent(projectId)}`;
}

// ═══════════════════════════════════════════════════════════
// 公开 API
// ═══════════════════════════════════════════════════════════

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 项目列表（公开，无需认证 —— 未登录不会 401，只是 `userLiked` 恒 false）。
 *
 * **不缓存**: 搜索/翻页要即时反映用户输入，而列表本身是上游变动最频繁的一面。
 * 缓存它换来的那点往返，代价是用户按了下一页却看见上一页。
 */
export async function listProjects(
  query: WorkshopListQuery = {},
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopListPage>> {
  const url = buildListUrl(query);
  const res = await fetchJson(url, { signal: opts.signal });
  if (!res.ok) return res;

  const raw = res.data;
  const rawProjects = isRecord(raw) && Array.isArray(raw.projects) ? raw.projects : [];
  // 上游偶尔把数组直接返回（未来形状变动的最常见方向），一并吃下
  const list = rawProjects.length === 0 && Array.isArray(raw) ? raw : rawProjects;

  const projects: WorkshopProjectMeta[] = [];
  for (const item of list) {
    const meta = parseProjectMeta(item);
    if (meta) projects.push(meta);
  }

  const readNum = (key: string, fallback: number): number => {
    const value = isRecord(raw) ? raw[key] : undefined;
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  };

  return {
    ok: true,
    fromCache: false,
    data: {
      total: readNum('total', projects.length),
      page: readNum('page', normalizePage(query.page)),
      pageSize: readNum('pageSize', normalizePageSize(query.pageSize)),
      projects,
      droppedCount: list.length - projects.length,
    },
  };
}

/**
 * 项目详情（含 `regexEntriesPreview` —— 正则条目的唯一来源）。TTL 5 分钟。
 *
 * `parseProjectMeta` 返回 null（缺 id）即 `malformed`: 没有 id 的项目在本引擎里
 * 无法寻址，装了也只是一行找不回来的垃圾。
 */
export async function fetchProject(
  projectId: string,
  opts: { force?: boolean } & WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopProjectDetail>> {
  const id = (projectId ?? '').trim();
  const url = buildProjectUrl(id);
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }

  return withCache<WorkshopProjectDetail>(
    `detail:${id}`,
    WORKSHOP_DETAIL_TTL_MS,
    opts.force === true,
    async () => {
      const res = await fetchJson(url, { signal: opts.signal });
      if (!res.ok) return res;

      const project = parseProjectMeta(res.data);
      if (!project) {
        return { ok: false, error: { kind: 'malformed', message: '详情响应缺少项目 id', url } };
      }

      // 一次 parsePayload 同时吃到 worldbookEntriesPreview 与 regexEntriesPreview
      const parsed = parsePayload(res.data);
      return {
        ok: true,
        fromCache: false,
        data: {
          project,
          regexEntries: parsed.regexEntries,
          previewEntries: parsed.worldbookEntries,
        },
      };
    },
    opts.signal !== undefined,
  );
}

/**
 * 下载载荷文件（世界书条目）。TTL 15 小时，键是完整 URL。
 *
 * 载荷走 worker 的 `/api/files/*` 代理，CORS 已开。返回的是
 * `parsePayload()` 的产物 —— 本模块自己不认识上游那三种外层形状。
 */
export async function downloadPayload(
  downloadUrl: string,
  opts: { force?: boolean } & WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopPayload>> {
  const url = (downloadUrl ?? '').trim();
  if (!url) {
    return { ok: false, error: { kind: 'no_source', message: '项目没有提供下载地址', url: '' } };
  }

  return withCache<WorkshopPayload>(
    `payload:${url}`,
    WORKSHOP_PAYLOAD_TTL_MS,
    opts.force === true,
    async () => {
      // 载荷用更宽的超时 —— 340 KB 级内容 + worker 代理，15 秒会误杀慢网
      const res = await fetchJson(url, {
        signal: opts.signal,
        timeoutMs: WORKSHOP_PAYLOAD_TIMEOUT_MS,
      });
      if (!res.ok) return res;
      return { ok: true, fromCache: false, data: parsePayload(res.data) };
    },
    opts.signal !== undefined,
  );
}

/**
 * ★ 组合入口 —— 详情 + 载荷合成 `planInstall()` 要的输入。
 *
 * 合成规则（见文件头，这是 P1-1 实测出来的、最容易搞错的一处）:
 * - **世界书条目** ← `downloadUrl` 下载的载荷
 * - **正则条目**   ← 详情响应的 `regexEntriesPreview`
 *
 * 唯一的回退: 项目**没给** `downloadUrl` 时用详情里的 `worldbookEntriesPreview`，
 * 并记一条 note。这是显式回退不是静默兜底 —— 预览是否完整只在正则那侧被实测过，
 * 世界书那侧没有，所以用了就必须告诉用户。
 *
 * 若下载**失败**则整体失败（而不是偷偷降级到预览）: 用半份内容装出来的项目，
 * 之后每次「更新」都会与上游 diff 不上，比装不上更难查。
 */
export async function fetchInstallInput(
  projectId: string,
  opts: { force?: boolean } & WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopBundle>> {
  const detail = await fetchProject(projectId, opts);
  if (!detail.ok) return detail;

  const { project, regexEntries, previewEntries } = detail.data;
  const notes: string[] = [];

  let worldbookEntries: WorkshopSourceEntry[];
  let entriesSource: WorkshopBundle['entriesSource'];

  if (project.downloadUrl) {
    const payload = await downloadPayload(project.downloadUrl, opts);
    if (!payload.ok) return payload;
    worldbookEntries = payload.data.worldbookEntries;
    entriesSource = 'download';
    // 载荷文件里理论上没有正则；真有了也以详情为准，但要说一声
    if (payload.data.regexEntries.length > 0) {
      notes.push(`载荷文件内含 ${payload.data.regexEntries.length} 条正则，已以详情响应为准`);
    }
  } else if (previewEntries.length > 0) {
    worldbookEntries = previewEntries;
    entriesSource = 'detail_preview';
    notes.push('项目未提供下载地址，世界书条目取自详情预览，内容可能不完整');
  } else {
    return {
      ok: false,
      error: {
        kind: 'no_source',
        message: '项目既无下载地址也无预览条目',
        url: buildProjectUrl(project.id),
      },
    };
  }

  return {
    ok: true,
    fromCache: detail.fromCache,
    data: {
      input: { project, worldbookEntries, regexEntries },
      entriesSource,
      notes,
    },
  };
}
