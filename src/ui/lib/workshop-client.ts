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
 *    字段转换**（协议信封除外：`raw.projects` 数组、`{ready, success}` 这类外层
 *    形状是传输层的事，不是实体字段）。多一处 `raw.coverImage ?? raw.coverUrl`
 *    就是第二套解析规则，上游改名时两处只会改一处
 * 3. TTL 内存缓存 + 并发去重
 * 4. **超时与取消** —— `fetch` 默认不超时，没有这一层，上游挂起就等于页面永久转圈。
 *    每次请求都戴上 {@link WORKSHOP_REQUEST_TIMEOUT_MS}（载荷用
 *    {@link WORKSHOP_PAYLOAD_TIMEOUT_MS}）的闸，调用方还可另传 `signal` 主动取消
 * 5. **附着身份**（Phase 3 / D18/D21）—— Bearer JWT 由 {@link setWorkshopAuthTokenProvider}
 *    注入，本模块统一往认证请求上挂 `Authorization`。store/组件仍然不许自己发请求，
 *    也不该自己拼 header
 *
 * 🔴 **永远不要设 `credentials: 'include'`**: 上游 CORS 是通配 `Access-Control-Allow-Origin: *`
 * 且**没有** `Allow-Credentials`，带凭据的请求会被浏览器整个拒掉（设计 §0）。
 * 认证全靠 `Authorization` header，全程零 Cookie。
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

import {
  parseListingMeta,
  parsePayload,
  parseProjectMeta,
  parseSocialMeta,
  parseToggleAck,
} from '@engine/workshop-manifest';
import type {
  WorkshopInstallInput,
  WorkshopListingMeta,
  WorkshopPayload,
  WorkshopProjectMeta,
  WorkshopSocialMeta,
  WorkshopSourceEntry,
  WorkshopSourceRegex,
  WorkshopToggleAck,
} from '@engine/workshop-types';
import { describePlatformFailure, describeRawBody } from './workshop-upstream-error';

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

/**
 * 列表 TTL —— 120 秒（O2；首版是 45 秒，Phase 3 读了上游源码后放宽）。
 *
 * 为什么列表也值得缓存: 浏览模态上的往返有很强的「原地打转」特征 —— 第 1 页翻到
 * 第 2 页再翻回第 1 页、同一个标签点开又点掉、模态关掉几秒后重新打开。这几串动作
 * 发出的是**参数完全相同的同一个 URL**，中间没有任何用户输入变化，重拉只是把同样
 * 一屏内容再传一遍。缓存键含完整列表 URL，所以「按了下一页却看见上一页」这类事故
 * 在结构上不可能发生 —— 页码不同就是不同的键。
 *
 * 为什么正好 120 秒: 上游自己给 `GET /api/projects` 打的是
 * `Cache-Control: public, s-maxage=120`（后端 `index.ts:90-93`）—— 那是**服务提供方
 * 亲口声明的新鲜度下限**，边缘节点本来就会把两分钟内的同一个 URL 当成新鲜的。
 * 我们的应用层 TTL 短于它没有任何收益：请求照发，回来的还是同一份边缘缓存副本，
 * 只是多花了一个往返。首版的 45 秒是在没读到源码时凭手感定的，现在有依据了。
 *
 * ⚠️ 缓存键**带身份前缀**（D24）：登录/登出前后不共用一把钥匙，否则 TTL 窗口内
 * 会把上一个身份的 `userLiked` 喂给下一个人。已登录的读取还会额外带
 * `cache: 'no-store'` 掐掉 HTTP 层缓存 —— 上游那两个 `s-maxage` **没有配
 * `Vary: Authorization`**（§1.3），这是本次接社交面时最大的一个坑。
 *
 * 用户想立刻看到最新的那条路始终畅通: 工具条上的「刷新」传 `force`，直接越过缓存。
 */
export const WORKSHOP_LIST_TTL_MS = 120_000;

/** `GET /api/projects` 的服务端缺省（附录 C），我们显式带上以便请求可复现 */
export const WORKSHOP_DEFAULT_PAGE_SIZE = 20;
export const WORKSHOP_DEFAULT_SORT = 'published';

/**
 * 上游 `sort` 的合法取值（服务端是 `z.enum`，传别的会 400）。
 *
 * 排序在**服务端**做，翻页才是对的 —— 只对当前页重排会得出「第 2 页的热门项目
 * 排在第 1 页的冷门项目之前」这种自相矛盾的结果。所以改排序必须重拉且回到第 0 页。
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
 * - `unauthorized` 401（D25）。⚠️ 它同样**不是红色报错**: 未登录或 token 过期是
 *               完全正常的状态，UI 该做的是「引导去登录」，不是「上游出错了」。
 *               单独分一类正是为了让这两种处置不会混在 `http` 里被同一段红字吞掉
 */
export type WorkshopFailureKind =
  'network' | 'http' | 'malformed' | 'no_source' | 'timeout' | 'cancelled' | 'unauthorized';

export interface WorkshopFailure {
  kind: WorkshopFailureKind;
  /**
   * 面向开发者的原因串；UI 可直接展示，但不该拿它做判定。
   *
   * 非 2xx 时会尽力把**上游的错误正文**接在后面 —— 上游有两种错误体（§1.4）：
   * 手写路由的 `{"error": "..."}` 与 chanfana 校验失败的 `{success:false, errors:[…]}`，
   * 两种都解。解不出来（HTML 拦截页、空体）就只留状态码，不编内容。
   */
  message: string;
  /** 仅 `kind: 'http'` / `'unauthorized'` 有值 */
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
  /**
   * 项目 id → 社交计数（D22）。**零额外请求** —— 计数本来就长在同一份列表响应里，
   * 只是首版把它们连同其余身份字段一起丢掉了。
   *
   * 用 map 而不是把字段塞进 `projects[i]`，是为了让「落库的那一半」与「纯内存的
   * 那一半」在类型上就分得开：`WorkshopProjectMeta` 会被原样写进 Dexie，
   * `WorkshopSocialMeta` 永远不会（D13/D22）。
   *
   * 键只含解析成功的项目；被丢弃的野项目没有 id，也就无从寻址。
   */
  socials: Record<string, WorkshopSocialMeta>;
  /**
   * 项目 id → 目录展示面（作者身份 + 审核状态，Phase 4）。与 `socials` 同一条
   * 纪律、同一份响应、零额外请求，**永不落库**（见 `WorkshopListingMeta`）。
   */
  listings: Record<string, WorkshopListingMeta>;
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
  /** 同一份响应顺带解析出的社交计数（D22），零额外请求 —— 不落库 */
  social: WorkshopSocialMeta;
  /** 同上：作者身份 + 审核状态（Phase 4），零额外请求 —— 不落库 */
  listing: WorkshopListingMeta;
}

/** 两个 toggle 动作 —— 端点/字段名不同，流程完全同构，故共用一条实现 */
export type WorkshopToggleKind = 'like' | 'subscribe';

/**
 * `GET /api/auth/login` 的产物 —— Discord 授权页地址 + 本次登录的 `state`。
 *
 * `state` 是 `crypto.randomUUID()`、KV 里只活 300 秒，且**只有我们和 worker 知道**。
 * 它同时是三件事的钥匙：轮询的 key、postMessage 的验签依据（D19）、以及上游那边
 * 的一次性消费凭据。所以它必须从这里原样带到 store，中途不许重新生成。
 *
 * ⚠️ `url` 的 `redirect_uri` 恒指向 worker 自己的 origin（§1.1）—— 我们的 SPA
 * 根本不出现在 OAuth 链路里，所以本地开发/任意部署域名都不需要在 Discord 那边注册。
 */
export interface WorkshopLoginTicket {
  url: string;
  state: string;
}

/** 登录用户快照。字段与 JWT payload 同源（D20/O1，故不调 `/api/auth/me`） */
export interface WorkshopAuthUser {
  userId: string;
  username: string;
  /** Discord 的显示名；缺失时调用方回退 `username` */
  globalName: string;
  /** 头像哈希（JWT 里就是哈希，不是 URL） */
  avatar: string;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

/**
 * `GET /api/auth/poll` 的三态（§1.1）。
 *
 * ⚠️ **单次消费**：就绪后上游立刻删 KV（后端 `endpoints/auth.ts:164`），
 * 同一个 state 再问一次只会得到 `pending`。所以 postMessage 快路径命中之后
 * **绝不能**再打一发 poll 去「确认一下」—— 那一发会把真正的结果吃掉又扔掉。
 */
export type WorkshopLoginPoll =
  /** 用户还在 Discord 那边点授权，继续等 */
  | { phase: 'pending' }
  | { phase: 'success'; token: string; user: WorkshopAuthUser | null }
  /**
   * 上游明确说失败了。`message` 多半是**服务器成员门槛**没过
   * （不在 `ALLOWED_GUILD_IDS` 内，§1.1）—— UI 要把它当人话展示并补一句
   * 「需要先加入命定之诗 Discord 服务器」，而不是丢一个错误码（D25）。
   */
  | { phase: 'failure'; message: string };

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

/**
 * 传给 fetch 的第二参数。
 *
 * 📌 **D21 契约修订**（Phase 3）。此处原先写着「只用 `signal` 这一项，别在这里长出
 * 第二套请求配置」。那条禁令的用意是防止调用方把各种一次性开关顺着 init 往下塞，
 * 让「本模块唯一网络口」名存实亡 —— 那个用意仍然成立，但下面三项**不属于**
 * 调用方的一次性开关，它们是传输层自己的关切，恰恰应该收在这里：
 *
 * - `method` —— 点赞/订阅是 POST（§1.2）。没有它，toggle 会以 GET 发出去，
 *   打在同一个路径上得到 405，且永远查不出为什么
 * - `headers` —— `Authorization: Bearer <token>`。替代方案是让 store 自己拼 fetch，
 *   那才是真正把唯一网络口拆了；token 由 {@link setWorkshopAuthTokenProvider}
 *   注入，本模块统一附着，调用方全程不接触 header
 * - `cache` —— 已登录读取必须 `'no-store'`（D24）。上游那两个 `s-maxage` 没配
 *   `Vary: Authorization`（§1.3），不掐掉 HTTP 缓存就会把别人的 `userLiked` 喂进来。
 *   这是**正确性**修正，不是性能开关
 *
 * 仍然禁止的：`credentials`（见文件头，通配 CORS 下带凭据会被浏览器整个拒绝）、
 * `mode`、`redirect`、以及任何「让这一发请求特殊一点」的调用方参数。
 *
 * 三项都是可选的：既有测试里的 `async (url) => …` 一字不改仍然合法。
 */
export interface WorkshopFetchInit {
  signal?: AbortSignal;
  /** 缺省 GET；toggle 用 POST，投稿面（B4）用 POST/PUT/DELETE */
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** 仅用 `'no-store'`（D24）；不做其它缓存模式的门面 */
  cache?: 'no-store';
  /** 请求体。JSON 已序列化成串；上传走 Blob / FormData */
  body?: BodyInit;
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
let authTokenProvider: (() => string | null) | undefined;

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

/**
 * 注入「当前 token 从哪儿取」（D21）。传 `undefined` 恢复未登录。
 *
 * 为什么是**函数**而不是一个 `setToken(value)`: token 住在 Pinia store 里、会随
 * 登录/登出/过期变化，而本模块**不许 import Pinia**（它是 UI 之下的一层，
 * 还要能在 `environment:'node'` 的测试里裸跑）。传函数等于让本模块每次现取，
 * 既不持有副本，也不需要有人记得在每次变更后同步过来 —— 少一个会忘的步骤。
 *
 * 返回 `null` 即「当前未登录」，一切认证附着都跳过。
 */
export function setWorkshopAuthTokenProvider(fn?: () => string | null): void {
  authTokenProvider = fn;
}

/** 当前 token（空串按未登录处理） */
function currentToken(): string | null {
  try {
    const token = authTokenProvider?.() ?? null;
    return typeof token === 'string' && token.trim() !== '' ? token : null;
  } catch {
    // provider 是外面注入的，炸了也不该让一次列表请求跟着炸 —— 按未登录处理
    return null;
  }
}

/**
 * 解 JWT 的 payload 段。**纯函数，永不抛**（解不出来回 `null`）。
 *
 * ⚠️ 这是 **decode 不是 verify** —— 我们没有、也不该有 HS256 的密钥。payload 里的
 * 字段只用来做两件本地事：显示用户名/头像（O1，省掉 `/api/auth/me`）与判 `exp`
 * 提前登出（D20）。**任何权限判定都在服务端**，本地解出来的 `isAdmin` 只配用于
 * 决定要不要渲染一个按钮，不配当作授权。
 *
 * 为什么解码住在 client 而不是 store: 缓存键的身份前缀（D24）与 store 的过期判定
 * 必须用**同一个** userId/exp。两份实现一旦漂移，就会出现「UI 显示已登出、
 * 缓存却还挂在 `u<id>` 键上」这种查不出来的错位。store 直接从这里 re-export。
 */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  if (typeof token !== 'string') return null;
  const segments = token.split('.');
  if (segments.length < 2) return null;

  try {
    // base64url → base64（`-_` 换回 `+/`，补齐 `=`）
    const b64 = segments[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);

    const decodeBase64 = (globalThis as { atob?: (s: string) => string }).atob;
    if (typeof decodeBase64 !== 'function') return null;
    const binary = decodeBase64(padded);

    // ★ 必须过一遍 UTF-8 解码: `atob` 出来的是 latin1 字节串，Discord 的中文
    //   `globalName` 直接当字符串用会变成一堆乱码顶在用户头像旁边。
    let json = binary;
    const Decoder = (globalThis as { TextDecoder?: typeof TextDecoder }).TextDecoder;
    if (typeof Decoder === 'function') {
      const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
      json = new Decoder('utf-8').decode(bytes);
    }

    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) ? parsed : null;
  } catch {
    // 手改过的 localStorage、被截断的 token、根本不是 JWT 的串 —— 一律当没登录
    return null;
  }
}

/**
 * 缓存键的身份前缀（D24）。
 *
 * 上游的列表/详情响应里混着**按调用者 JWT 填充**的 `userLiked` / `userSubscribed`
 * （§1.3），所以同一个 URL 在不同身份下根本不是同一份内容。不分身份的话，
 * 登出之后 TTL 窗口内还会看见自己赞过的红心，换个账号登录看到的是上一个人的旗标。
 *
 * token 在但解不出 userId 时用 `auth` 而不是 `anon`: 那一发请求**确实带了**
 * `Authorization`，把它的响应存进匿名桶就是把个性化内容喂给未登录视图。
 */
function identityPrefix(): string {
  const token = currentToken();
  if (!token) return 'anon';
  const payload = decodeJwtPayload(token);
  const userId = payload && typeof payload.userId === 'string' ? payload.userId : '';
  return userId ? `u${userId}` : 'auth';
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

/**
 * 丢掉一个项目的全部缓存 —— **写操作之后必须调**（投稿/编辑/删除/改可见性）。
 *
 * 为什么非有不可: 详情的 TTL 是 5 分钟。作者改完标题点进自己的项目，看到的是
 * 我们**自己**几分钟前存下的旧副本 —— 他会以为编辑没生效，然后再改一遍。
 * 这不是上游的延迟，是我们的缓存在骗人。上游的边缘缓存另说（那个我们管不着），
 * 但至少本地这一层不该成为「改了没反应」的来源。
 *
 * 两件事都要做:
 * 1. **该 id 的详情**，所有身份桶（`detail:<任意前缀>:<id>`）—— 登录前后是不同的
 *    键，只清当前身份那把，登出再登入还会拿到旧的
 * 2. **所有列表页**。改一个名字会影响哪几页？搜索词、标签、排序、页码的组合是
 *    开放的，算不出来。列表 TTL 只有 120 秒且重拉很便宜，全清是正确的取舍 ——
 *    留一页说着旧名字的列表，比多发几个请求糟得多。
 *
 * 载荷（`payload:`）**刻意不清**: 它按 `downloadUrl` 存键，而上游发新版本会换 URL，
 * 天然就是另一把钥匙。清它只会让同一份不变的字节重下一遍。
 */
export function invalidateWorkshopProject(projectId: string): void {
  const id = (projectId ?? '').trim();
  for (const key of [...cache.keys()]) {
    if (key.startsWith('list:') || (id !== '' && key.endsWith(`:${id}`))) {
      cache.delete(key);
      inflight.delete(key);
    }
  }
}

/**
 * 测试拆除口: 清缓存 + 复位全部注入缝。
 *
 * ★ token provider 也必须复位 —— 它是**模块级**的，上一个用例登录过、下一个用例
 * 就会莫名其妙地带着 `Authorization` 发请求并命中 `u<id>` 前缀的缓存键。
 * 这类跨用例污染只在测试顺序变化时才现形，是最难查的一种红。
 */
export function resetWorkshopClient(): void {
  clearWorkshopCache();
  setWorkshopFetch(undefined);
  setWorkshopClock(undefined);
  setWorkshopAuthTokenProvider(undefined);
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
 * 从上游的错误正文里挖出一句人话。挖不出来返回 `undefined`（**绝不编内容**）。
 *
 * 上游有两种错误体（§1.4），而且是两套不同的框架各自产的，短期内不会统一:
 * - 手写路由: `{"error": "Unauthorized"}` / `{"error": "Project not found"}`
 * - chanfana 校验失败（传了非法 `sort` 之类）: `{success:false, errors:[{message,…}]}`
 *
 * 两种都解，是因为「上游到底在抱怨什么」是用户能自己修好的那类信息（换个排序、
 * 去登录），而光一个 400 只能让人干瞪眼。
 */
function readUpstreamError(text: string): string | undefined {
  if (!text) return undefined;
  try {
    const body: unknown = JSON.parse(text);
    if (!isRecord(body)) return undefined;

    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
    if (typeof body.message === 'string' && body.message.trim()) return body.message.trim();

    if (Array.isArray(body.errors)) {
      const lines = body.errors
        .map((item) => {
          if (typeof item === 'string') return item;
          if (!isRecord(item)) return '';
          const msg = typeof item.message === 'string' ? item.message : '';
          const path = Array.isArray(item.path) ? item.path.join('.') : '';
          return path && msg ? `${path}: ${msg}` : msg;
        })
        .filter((line) => line.length > 0);
      if (lines.length > 0) return lines.join('；');
    }
  } catch {
    // 不是 JSON（HTML 拦截页 / 空体）—— 交回调用点只报状态码
  }
  return undefined;
}

/**
 * 发一次请求并把响应体解析成 JSON。**永不抛**。
 *
 * 用 `text()` 再 `JSON.parse` 而不是 `res.json()`: 上游出错时（worker 502、
 * Cloudflare 拦截页）返回的是 HTML，`res.json()` 抛出的错误信息毫无信息量；
 * 自己 parse 才能在 message 里带上响应开头那几十个字符，用户一贴就知道是什么。
 *
 * ⚠️ 不做任何长度截断 —— 340 KB 的 `replaceString` 必须原样拿到。
 *
 * `withAuth` 打开时（列表/详情/toggle）做两件事，两件都只在**真的有 token** 时发生:
 * 挂 `Authorization: Bearer <token>`，以及 `cache: 'no-store'`（D24 —— 上游的
 * `s-maxage` 没配 `Vary: Authorization`，个性化字段绝不能落进 HTTP 缓存）。
 * 未登录时请求形状与 Phase 1 一字不差，照常吃边缘缓存。
 */
async function fetchJson(
  url: string,
  opts: {
    signal?: AbortSignal;
    timeoutMs?: number;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    /** 是否附着身份。登录/轮询端点本身不带（此时还没有 token） */
    withAuth?: boolean;
    /**
     * 请求体（投稿面，B4）。
     * - 普通对象 → 序列化成 JSON 并带 `Content-Type: application/json`
     * - `Blob` / `FormData` → **原样交给 fetch**，不动 Content-Type
     *   （FormData 的 multipart boundary 只有浏览器自己知道，手写一定错）
     */
    body?: unknown;
  } = {},
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

  const init: WorkshopFetchInit = { signal: guard.signal };
  if (opts.method && opts.method !== 'GET') init.method = opts.method;

  const headers: Record<string, string> = {};
  if (opts.body !== undefined) {
    if (isBinaryBody(opts.body)) {
      // Blob / FormData 原样走 —— 尤其 FormData 的 multipart boundary 由浏览器生成，
      // 我们一旦自己写 Content-Type，boundary 就对不上，服务端只会看到一坨乱码
      init.body = opts.body as BodyInit;
    } else {
      init.body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  if (opts.withAuth) {
    const token = currentToken();
    if (token) {
      // 上游读取端同时接受 `Bearer <token>` 与裸 token；带前缀是标准写法
      headers.Authorization = `Bearer ${token}`;
      // 🔴 D24: 个性化字段不可进 HTTP 缓存（§1.3 上游缺 `Vary: Authorization`）
      init.cache = 'no-store';
    }
  }
  if (Object.keys(headers).length > 0) init.headers = headers;

  try {
    let res: WorkshopResponseLike;
    try {
      res = await impl(url, init);
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
      // 错误正文里往往有唯一能自救的那句话（§1.4）。读不出来也无所谓 ——
      // 一个失败的响应体读不动，不该把失败本身变成另一种失败。
      //
      // 三档，**平台错误优先**（见 workshop-upstream-error.ts 顶部）: Cloudflare 的
      // 额度/资源/限流失败要抢在结构化读法之前，因为那种响应体有时也是带 message 的
      // JSON，而那句 message 是给运维看的英文栈信息。
      let detail: string | undefined;
      try {
        const raw = await res.text();
        detail =
          describePlatformFailure(status, raw) ?? readUpstreamError(raw) ?? describeRawBody(raw);
      } catch {
        detail = undefined;
      }
      const base = `上游返回 ${status} ${res.statusText ?? ''}`.trim();
      return {
        ok: false,
        error: {
          // 401 单独成类（D25）：未登录/过期是正常状态，UI 该引导登录而不是报红
          kind: status === 401 ? 'unauthorized' : 'http',
          status,
          message: detail ? `${base}：${detail}` : base,
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

/** Blob / FormData 这类「浏览器自己会设 Content-Type」的体 */
function isBinaryBody(body: unknown): boolean {
  const g = globalThis as { Blob?: unknown; FormData?: unknown };
  if (typeof g.Blob === 'function' && body instanceof (g.Blob as typeof Blob)) return true;
  if (typeof g.FormData === 'function' && body instanceof (g.FormData as typeof FormData)) {
    return true;
  }
  return false;
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

/**
 * 拼 toggle URL（点赞 / 订阅）。
 *
 * ⚠️ 这里**不加**任何缓存破坏参数（O6）。上游自家前端的 `home.js` 实测在 URL 上挂
 * `_=<timestamp>`，那会让每一发请求都是一把新钥匙、边缘缓存全部落空 —— 对 POST
 * 毫无意义，对 GET 是负优化。我们靠 `cache: 'no-store'` 精确掐掉该掐的那一部分。
 */
export function buildToggleUrl(projectId: string, kind: WorkshopToggleKind): string {
  const action = kind === 'like' ? 'like' : 'subscribe';
  return `${WORKSHOP_API_BASE}/api/projects/${encodeURIComponent(projectId)}/${action}`;
}

/** 登录三段式的前两段（§1.1）；第三段「回调」落在 worker 自己身上，与我们无关 */
export function buildLoginUrl(): string {
  return `${WORKSHOP_API_BASE}/api/auth/login`;
}

export function buildLoginPollUrl(state: string): string {
  return `${WORKSHOP_API_BASE}/api/auth/poll?key=${encodeURIComponent(state)}`;
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
 * 已登录时会带上 `Authorization`（这样 `userLiked` / `userSubscribed` 才是「我」的）
 * 并加 `cache: 'no-store'`（D24）。
 *
 * TTL 120 秒（{@link WORKSHOP_LIST_TTL_MS}），缓存键 = **身份前缀 + 完整列表 URL**。
 *
 * ⚠️ 「缓存列表」听起来像是拿新鲜度换往返，实际上并不是: 页码、标签、搜索词、
 * 排序任何一项不同都是不同的键，所以「按了下一页却看见上一页」在结构上不可能发生。
 * 被吃掉的只有**参数一模一样**的那些重复往返 —— 翻回上一页、把标签点掉、关掉模态
 * 几秒后再打开。用户的输入变了就一定是新请求。
 *
 * 想强制拿最新的一屏走 `force`（浏览模态工具条上的「刷新」就是这么按的）。
 */
export async function listProjects(
  query: WorkshopListQuery = {},
  opts: { force?: boolean } & WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopListPage>> {
  const url = buildListUrl(query);

  return withCache<WorkshopListPage>(
    `list:${identityPrefix()}:${url}`,
    WORKSHOP_LIST_TTL_MS,
    opts.force === true,
    async () => {
      const res = await fetchJson(url, { signal: opts.signal, withAuth: true });
      if (!res.ok) return res;

      const raw = res.data;
      const rawProjects = isRecord(raw) && Array.isArray(raw.projects) ? raw.projects : [];
      // 上游偶尔把数组直接返回（未来形状变动的最常见方向），一并吃下
      const list = rawProjects.length === 0 && Array.isArray(raw) ? raw : rawProjects;

      const projects: WorkshopProjectMeta[] = [];
      const socials: Record<string, WorkshopSocialMeta> = {};
      const listings: Record<string, WorkshopListingMeta> = {};
      for (const item of list) {
        const meta = parseProjectMeta(item);
        if (!meta) continue;
        projects.push(meta);
        // ★ 同一条 raw 再解两次（D22 / Phase 4）—— 零额外请求，三半边的类型分得开
        socials[meta.id] = parseSocialMeta(item);
        listings[meta.id] = parseListingMeta(item);
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
          socials,
          listings,
        },
      };
    },
    opts.signal !== undefined,
  );
}

/**
 * 「我的项目」（Phase 4，对齐上游 `/api/my/projects`）。
 *
 * 与 {@link listProjects} 的三处不同，都是上游给定的，不是我们的选择:
 *
 * 1. **必须登录** —— 未登录上游直接 401（→ `kind: 'unauthorized'`，UI 引导登录）。
 * 2. **不分页、不吃 `sort`/`tag`/`search`** —— 上游一次把作者名下所有项目全给。
 *    所以调用方的搜索/筛选只能在本地做（上游页面也是这么干的）。
 * 3. **含未过审的项目** —— `status: pending|rejected`、草稿、以及作者自己隐藏了的。
 *    这正是这个视图存在的理由：公开列表里看不到它们。
 *
 * 不进缓存: 这一屏是作者自己刚改完东西要看结果的地方，任何 TTL 都会让他以为
 * 「我刚提交的没生效」。上游列表 120 秒缓存的省流量理由在这里不成立 —— 这个请求
 * 只在用户主动切到该视图时发一次。
 */
export async function listMyProjects(
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopListPage>> {
  const url = `${WORKSHOP_API_BASE}/api/my/projects`;
  const res = await fetchJson(url, { signal: opts.signal, withAuth: true });
  if (!res.ok) return res;

  const raw = res.data;
  const rawProjects = isRecord(raw) && Array.isArray(raw.projects) ? raw.projects : [];
  const list = rawProjects.length === 0 && Array.isArray(raw) ? raw : rawProjects;

  const projects: WorkshopProjectMeta[] = [];
  const socials: Record<string, WorkshopSocialMeta> = {};
  const listings: Record<string, WorkshopListingMeta> = {};
  for (const item of list) {
    const meta = parseProjectMeta(item);
    if (!meta) continue;
    projects.push(meta);
    socials[meta.id] = parseSocialMeta(item);
    listings[meta.id] = parseListingMeta(item);
  }

  return {
    ok: true,
    fromCache: false,
    data: {
      // 上游不报 total/page/pageSize —— 全量返回，本页就是全部
      total: projects.length,
      page: 0,
      pageSize: projects.length,
      projects,
      droppedCount: list.length - projects.length,
      socials,
      listings,
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
    // 详情同样按身份分桶（D24）—— 它带的 `userLiked` 与列表里那个是同一种毒
    `detail:${identityPrefix()}:${id}`,
    WORKSHOP_DETAIL_TTL_MS,
    opts.force === true,
    async () => {
      const res = await fetchJson(url, { signal: opts.signal, withAuth: true });
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
          // 同一份响应顺带解出（D22 / Phase 4），零额外请求
          social: parseSocialMeta(res.data),
          listing: parseListingMeta(res.data),
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
 *
 * ★ 缓存键**刻意不带身份前缀**（与列表/详情相反，D24 只管那两个）。载荷是
 * 版本内不可变、且**对所有人完全相同**的内容文件，里面没有一个字段是按调用者
 * 填充的。给它分身份只会让同一份 340 KB 的字节在登录前后各下一遍 —— 纯粹的浪费，
 * 换不来任何正确性。同理它也不附着 `Authorization`（`/api/files/*` 是公开的）。
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
 *
 * ⚠️ `force` **只往详情那一侧传，不往载荷传**（见下方调用点）。载荷是版本内不可变的
 * 内容，而它的缓存键是完整 `downloadUrl` —— 上游发新版必换 URL，天然就是新键、
 * 天然 miss。所以强制重下**不可能**拿到更新的字节，只会在每次重装/更新时白白重传
 * 一份最大 340 KB 的同样内容。
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
    // ★ 只透传 signal，**不透传 force**: 新版本 = 新 downloadUrl = 新缓存键，
    //   强制重下换不来任何更新的字节（理由详见本函数文档注释）
    const payload = await downloadPayload(project.downloadUrl, { signal: opts.signal });
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

// ═══════════════════════════════════════════════════════════
// 社交动作（D23）—— 写操作，与上面所有读操作的纪律相反
// ═══════════════════════════════════════════════════════════

/**
 * 点赞 / 取消点赞（翻转，非幂等）。
 *
 * 🔴 **三条纪律，每一条都与本文件其余部分相反，都不许「顺手优化」掉**:
 *
 * 1. **绝不重试**。上游是「有行删、无行插、再重数」的翻转语义（§1.2 / 后端
 *    `utils/db.ts:802-851`）。超时后重试一次，很可能把用户刚点上的赞又取消掉 ——
 *    而 UI 上还显示着「已赞」。一次失败让用户自己再点，永远好过我们替他猜。
 * 2. **绝不进缓存、绝不进去重池**。缓存一个写操作的返回值毫无意义；把两次点击
 *    去重成一次，则会让「点赞→取消」变成只发出一半。
 * 3. **响应值是权威**。返回的 `count` 是服务端重数出来的，本地那个乐观的 +1
 *    到此作废（D23）。调用方必须无条件覆盖，不许「取较大值」这类自作聪明。
 *
 * 未登录时上游回 401 → `kind: 'unauthorized'`（D25），UI 引导登录而非报错。
 * 请求**无体**（上游不读 body），所以连 `Content-Type` 都不需要。
 */
export async function toggleLike(
  projectId: string,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopToggleAck>> {
  return toggleSocial(projectId, 'like', opts);
}

/** 订阅 / 取消订阅。纪律与 {@link toggleLike} 完全一致（同构的两个端点） */
export async function toggleSubscribe(
  projectId: string,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopToggleAck>> {
  return toggleSocial(projectId, 'subscribe', opts);
}

async function toggleSocial(
  projectId: string,
  kind: WorkshopToggleKind,
  opts: WorkshopAbortable,
): Promise<WorkshopResult<WorkshopToggleAck>> {
  const id = (projectId ?? '').trim();
  const url = buildToggleUrl(id, kind);
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }

  // ★ 直接打 fetchJson，**不经过 withCache** —— 见上方纪律 2
  const res = await fetchJson(url, { signal: opts.signal, method: 'POST', withAuth: true });
  if (!res.ok) return res;

  return { ok: true, fromCache: false, data: parseToggleAck(res.data) };
}

// ═══════════════════════════════════════════════════════════
// 投稿面（B4）—— 创建 / 编辑 / 上传 / 可见性 / 删除
// ═══════════════════════════════════════════════════════════

/**
 * 投稿的元数据部分（对齐上游 `ProjectCreate` / `ProjectUpdate` 的请求体）。
 *
 * `coverImage` 不在这里: 封面是**单独一个上传端点**（multipart），不是这个 JSON
 * 体里的字段。上游的 `coverImage` 参数是给「已经有 URL 的封面」用的，我们的
 * 投稿流程一律走上传，就不暴露它了 —— 少一个能填错的口。
 */
export interface WorkshopProjectDraft {
  name: string;
  description: string;
  version: string;
  tags: string[];
}

/** 创建/编辑的回执 */
export interface WorkshopWriteAck {
  /**
   * 后续上传要打的**那个** id。
   *
   * 🔴 编辑一个**已发布且已过审**的项目时，上游不会原地改，而是开一份**新的草稿**
   * 并返回**草稿的 id**（`createDraftFromPublished`）。此后的载荷/正则/封面上传
   * 必须打这个新 id —— 打回原 id 就是在改线上那一版，而线上那版是审核过的。
   * 这是整个投稿面最容易错的一处，所以回执里把它单独摆出来。
   */
  projectId: string;
  /** 上游是否为这次编辑开了草稿（即上面那种情况） */
  isDraft: boolean;
  /** 上游的提示原话（「修改后的新版本已进入审核区…」），照登给用户 */
  message: string;
}

function readAckId(raw: unknown, fallback: string): string {
  if (!isRecord(raw)) return fallback;
  // draftProjectId 优先 —— 它在的时候，projectId 也是同一个值，但语义更明确
  for (const key of ['draftProjectId', 'projectId', 'id']) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return fallback;
}

/**
 * 新建项目。**只创建元数据**，内容要接着调 {@link uploadProjectPayload}。
 *
 * 上游把这两步分开是有道理的（载荷可达数百 KB，先拿到 id 才知道往哪传），
 * 但对调用方来说这是个陷阱: 只创建不上传会在工坊里留下一个空项目。
 * 编排两步的责任在 store，不在这里 —— 本层只负责一次请求对一个端点。
 */
export async function createProject(
  draft: WorkshopProjectDraft,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopWriteAck>> {
  const url = `${WORKSHOP_API_BASE}/api/projects`;
  const name = draft.name.trim();
  if (!name) {
    return { ok: false, error: { kind: 'malformed', message: '项目名不能为空', url } };
  }

  const res = await fetchJson(url, {
    method: 'POST',
    withAuth: true,
    signal: opts.signal,
    body: {
      name,
      description: draft.description,
      version: draft.version.trim() || '1.0.0',
      tags: draft.tags,
    },
  });
  if (!res.ok) return res;

  const projectId = readAckId(res.data, '');
  if (!projectId) {
    return { ok: false, error: { kind: 'malformed', message: '创建响应没有返回项目 id', url } };
  }
  return {
    ok: true,
    fromCache: false,
    data: { projectId, isDraft: false, message: readMessage(res.data) },
  };
}

/** 编辑项目元数据。⚠️ 已发布项目会开草稿并换 id —— 见 {@link WorkshopWriteAck} */
export async function updateProject(
  projectId: string,
  patch: Partial<WorkshopProjectDraft>,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopWriteAck>> {
  const id = (projectId ?? '').trim();
  const url = buildProjectUrl(id);
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }

  const res = await fetchJson(url, {
    method: 'PUT',
    withAuth: true,
    signal: opts.signal,
    body: patch,
  });
  if (!res.ok) return res;

  const nextId = readAckId(res.data, id);
  return {
    ok: true,
    fromCache: false,
    data: {
      projectId: nextId,
      // 换了 id 就说明上游开了草稿（`createDraftFromPublished`）
      isDraft: nextId !== id,
      message: readMessage(res.data),
    },
  };
}

/** 公开 / 隐藏 */
export async function setProjectVisibility(
  projectId: string,
  visible: boolean,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<null>> {
  const id = (projectId ?? '').trim();
  const url = `${buildProjectUrl(id)}/visibility`;
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }
  const res = await fetchJson(url, {
    method: 'PUT',
    withAuth: true,
    signal: opts.signal,
    body: { visibility: visible },
  });
  return res.ok ? { ok: true, fromCache: false, data: null } : res;
}

/** 删除项目。⚠️ 上游是硬删，没有回收站 */
export async function deleteProject(
  projectId: string,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<null>> {
  const id = (projectId ?? '').trim();
  const url = buildProjectUrl(id);
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }
  const res = await fetchJson(url, { method: 'DELETE', withAuth: true, signal: opts.signal });
  return res.ok ? { ok: true, fromCache: false, data: null } : res;
}

/**
 * 上传世界书载荷 / 正则文件。
 *
 * 两个端点的请求形状一模一样（裸 body + Content-Type 取文件自身），只有路径不同，
 * 所以共用一条实现 —— 上游哪天给其中一个加了参数，改的也只有这一处。
 *
 * ⚠️ 用**载荷超时**（60 秒）而不是元数据超时: 上传的正是那种数百 KB 的文件，
 * 15 秒在慢速网络下真的不够。
 */
export async function uploadProjectFile(
  projectId: string,
  kind: 'payload' | 'regex',
  file: Blob,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<null>> {
  const id = (projectId ?? '').trim();
  const path = kind === 'payload' ? 'upload' : 'upload-regex';
  const url = `${buildProjectUrl(id)}/${path}`;
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }
  const res = await fetchJson(url, {
    method: 'POST',
    withAuth: true,
    signal: opts.signal,
    timeoutMs: WORKSHOP_PAYLOAD_TIMEOUT_MS,
    body: file,
  });
  return res.ok ? { ok: true, fromCache: false, data: null } : res;
}

/** 上传封面。**multipart**，字段名 `cover`（上游写死） */
export async function uploadProjectCover(
  projectId: string,
  file: Blob,
  fileName = 'cover.png',
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<null>> {
  const id = (projectId ?? '').trim();
  const url = `${buildProjectUrl(id)}/upload-cover`;
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }
  const Ctor = (globalThis as { FormData?: typeof FormData }).FormData;
  if (typeof Ctor !== 'function') {
    return { ok: false, error: { kind: 'network', message: '当前环境没有 FormData', url } };
  }
  const form = new Ctor();
  form.append('cover', file, fileName);

  const res = await fetchJson(url, {
    method: 'POST',
    withAuth: true,
    signal: opts.signal,
    timeoutMs: WORKSHOP_PAYLOAD_TIMEOUT_MS,
    body: form,
  });
  return res.ok ? { ok: true, fromCache: false, data: null } : res;
}

/** 上游回执里的提示原话；没有就空串（调用方据此不弹这一条） */
function readMessage(raw: unknown): string {
  if (!isRecord(raw)) return '';
  const value = raw.message;
  return typeof value === 'string' ? value.trim() : '';
}

// ═══════════════════════════════════════════════════════════
// 审核面（B5）—— 仅管理员可用
// ═══════════════════════════════════════════════════════════

/**
 * ⚠️ 本节所有端点在**非管理员**身上一律回 403（超管专属的两个更严）。
 *
 * 我们不在客户端「先判断再决定发不发」: 权限的唯一真相在服务端的 JWT 校验里，
 * 客户端那份 `isAdmin` 只是同一枚 token 里抄来的显示用旗标。拿它当门禁，
 * 等于把「谁能审核」的判定交给一个用户能自己改的 localStorage 值。
 *
 * 客户端的 `isAdmin` 只决定**要不要把入口画出来**（省得普通用户看到一个必然
 * 403 的按钮），不决定请求发不发得出去 —— 那是服务端的事。
 */

/** 一条管理操作日志（上游 `admin_action_logs` 的投影） */
export interface WorkshopAdminLog {
  id: string;
  action: string;
  targetType: string;
  targetId: string;
  actorId: string;
  actorName: string;
  detail: string;
  createdAt: string;
}

/** 一个管理员 */
export interface WorkshopAdminUser {
  id: string;
  username: string;
  globalName: string;
}

function readStr(source: unknown, key: string): string {
  if (!isRecord(source)) return '';
  const value = source[key];
  return typeof value === 'string' ? value : '';
}

/** 待审核队列。上游返回的是与列表同形的项目行，所以复用同一套解析 */
export async function listPendingProjects(
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopListPage>> {
  const url = `${WORKSHOP_API_BASE}/api/admin/pending?page=0&pageSize=50`;
  const res = await fetchJson(url, { signal: opts.signal, withAuth: true });
  if (!res.ok) return res;

  const raw = res.data;
  const list = isRecord(raw) && Array.isArray(raw.projects) ? raw.projects : [];
  const projects: WorkshopProjectMeta[] = [];
  const socials: Record<string, WorkshopSocialMeta> = {};
  const listings: Record<string, WorkshopListingMeta> = {};
  for (const item of list) {
    const meta = parseProjectMeta(item);
    if (!meta) continue;
    projects.push(meta);
    socials[meta.id] = parseSocialMeta(item);
    listings[meta.id] = parseListingMeta(item);
  }

  return {
    ok: true,
    fromCache: false,
    data: {
      total: projects.length,
      page: 0,
      pageSize: projects.length,
      projects,
      droppedCount: list.length - projects.length,
      socials,
      listings,
    },
  };
}

/**
 * 通过 / 驳回一个项目。
 *
 * `rejectReason` 在驳回时**该给**: 它会落到项目行上，作者在「我的项目」里看得到
 * （见 `describeReviewState` 旁边渲染的那一行）。不给理由的驳回等于让作者去猜。
 */
export async function reviewProject(
  projectId: string,
  action: 'approve' | 'reject',
  rejectReason = '',
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<null>> {
  const id = (projectId ?? '').trim();
  const url = `${WORKSHOP_API_BASE}/api/admin/review/${encodeURIComponent(id)}`;
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少项目 id', url } };
  }
  const res = await fetchJson(url, {
    method: 'POST',
    withAuth: true,
    signal: opts.signal,
    body: action === 'reject' ? { action, rejectReason } : { action },
  });
  return res.ok ? { ok: true, fromCache: false, data: null } : res;
}

/** 管理员名册（超管专属） */
export async function listAdmins(
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopAdminUser[]>> {
  const url = `${WORKSHOP_API_BASE}/api/admin/list`;
  const res = await fetchJson(url, { signal: opts.signal, withAuth: true });
  if (!res.ok) return res;

  const raw = res.data;
  const list = isRecord(raw) && Array.isArray(raw.admins) ? raw.admins : [];
  return {
    ok: true,
    fromCache: false,
    data: list
      .map((item) => ({
        id: readStr(item, 'id'),
        username: readStr(item, 'username'),
        globalName: readStr(item, 'globalName') || readStr(item, 'global_name'),
      }))
      .filter((u) => u.id !== ''),
  };
}

/** 管理操作日志（超管专属，上游给最近 200 条） */
export async function listAdminLogs(
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopAdminLog[]>> {
  const url = `${WORKSHOP_API_BASE}/api/admin/logs`;
  const res = await fetchJson(url, { signal: opts.signal, withAuth: true });
  if (!res.ok) return res;

  const raw = res.data;
  const list = isRecord(raw) && Array.isArray(raw.logs) ? raw.logs : [];
  return {
    ok: true,
    fromCache: false,
    data: list.map((item) => ({
      id: readStr(item, 'id'),
      action: readStr(item, 'action'),
      targetType: readStr(item, 'targetType'),
      targetId: readStr(item, 'targetId'),
      actorId: readStr(item, 'actorId'),
      actorName: readStr(item, 'actorName'),
      detail: readStr(item, 'detail'),
      createdAt: readStr(item, 'createdAt'),
    })),
  };
}

/** 授予 / 撤销管理员（超管专属） */
export async function setAdmin(
  userId: string,
  isAdmin: boolean,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<null>> {
  const url = `${WORKSHOP_API_BASE}/api/admin/set-admin`;
  const id = (userId ?? '').trim();
  if (!id) {
    return { ok: false, error: { kind: 'malformed', message: '缺少用户 id', url } };
  }
  const res = await fetchJson(url, {
    method: 'POST',
    withAuth: true,
    signal: opts.signal,
    body: { userId: id, isAdmin },
  });
  return res.ok ? { ok: true, fromCache: false, data: null } : res;
}

// ═══════════════════════════════════════════════════════════
// 登录三段式（D19/D25）—— 登录也是网络，一并收口在本文件
// ═══════════════════════════════════════════════════════════

/**
 * 起飞：拿 Discord 授权页地址与本次的 `state`。
 *
 * **不缓存、不去重**: `state` 每次都是新的 UUID 且上游 KV 只留 300 秒，缓存一个
 * 用过的 state 等于让第二次登录去轮询一把已经被消费掉的钥匙 —— 永远等不到结果。
 *
 * 也**不带 `Authorization`**: 这一步的前提就是还没有 token。
 */
export async function startLogin(
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopLoginTicket>> {
  const url = buildLoginUrl();
  const res = await fetchJson(url, { signal: opts.signal });
  if (!res.ok) return res;

  const raw = res.data;
  const loginUrl = isRecord(raw) && typeof raw.url === 'string' ? raw.url : '';
  const state = isRecord(raw) && typeof raw.state === 'string' ? raw.state : '';
  if (!loginUrl || !state) {
    return {
      ok: false,
      error: { kind: 'malformed', message: '登录响应缺少 url 或 state', url },
    };
  }
  return { ok: true, fromCache: false, data: { url: loginUrl, state } };
}

/**
 * 收割：问一次「授权好了没」。三态见 {@link WorkshopLoginPoll}。
 *
 * 🔴 **单次消费** —— 上游一旦返回 ready 就立刻删 KV。所以:
 * - 绝不缓存（缓存住 `pending` 会让整个登录卡死在 TTL 里）
 * - 绝不去重（两个调用方各问一次，只有一个能拿到结果，另一个永远 pending）
 * - postMessage 快路径命中后**不要**再补一发「确认」（O3）
 *
 * 传输层失败（断网/超时）与业务失败（`success:false`）是两回事: 前者返回
 * `ok:false`，调用方可以继续轮询；后者返回 `ok:true` + `phase:'failure'`，
 * 那是上游的终局判决（多半是 Discord 服务器成员门槛没过），不该再等。
 */
export async function pollLogin(
  state: string,
  opts: WorkshopAbortable = {},
): Promise<WorkshopResult<WorkshopLoginPoll>> {
  const key = (state ?? '').trim();
  const url = buildLoginPollUrl(key);
  if (!key) {
    return { ok: false, error: { kind: 'malformed', message: '缺少登录 state', url } };
  }

  const res = await fetchJson(url, { signal: opts.signal });
  if (!res.ok) return res;

  const raw = res.data;
  const ready = isRecord(raw) && raw.ready === true;
  if (!ready) return { ok: true, fromCache: false, data: { phase: 'pending' } };

  const token = isRecord(raw) && typeof raw.token === 'string' ? raw.token : '';
  // `success !== true` 或者压根没给 token —— 两种都当失败，别让 UI 收下一个空 token
  if (!isRecord(raw) || raw.success !== true || !token) {
    const message =
      isRecord(raw) && typeof raw.message === 'string' && raw.message.trim()
        ? raw.message.trim()
        : '登录未成功';
    return { ok: true, fromCache: false, data: { phase: 'failure', message } };
  }

  return {
    ok: true,
    fromCache: false,
    data: { phase: 'success', token, user: parseAuthUser(raw.user) },
  };
}

/**
 * 上游 `user` 对象 / JWT payload → {@link WorkshopAuthUser}。
 *
 * 两个来源同形（`/api/auth/me` 就是把 JWT payload 抄回来，§1.1），所以一个读法
 * 通吃：poll 响应给的是它，刷新页面后本地解 token 得到的也是它。缺 `userId`
 * 视为不可用回 `null` —— 没有 id 的用户既拼不出头像也分不了缓存桶。
 */
export function parseAuthUser(raw: unknown): WorkshopAuthUser | null {
  if (!isRecord(raw)) return null;
  const userId = typeof raw.userId === 'string' ? raw.userId : '';
  if (!userId) return null;

  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  return {
    userId,
    username: str(raw.username),
    globalName: str(raw.globalName),
    avatar: str(raw.avatar),
    isAdmin: raw.isAdmin === true,
    isSuperAdmin: raw.isSuperAdmin === true,
  };
}
