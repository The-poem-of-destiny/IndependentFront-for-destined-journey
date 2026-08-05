/**
 * image-client.ts — 文生图上游的**唯一网络接触点**（图像生成 v1 / 阶段 E）
 *
 * 设计: `docs/planning/2026-08-04-image-generation-design.md` §12（BFF 与错误分类）
 *       + §6（NovelAI 接口规格）。先例: `workshop-client.ts`（判别联合永不抛穿 +
 *       超时 + 取消 + 注入缝），本文件照它写。
 *
 * 三条职责，仅此而已:
 * 1. 拼 header、发请求、**按二进制读字节**
 * 2. 把原始字节交给 `image-providers/novelai.ts` 的 `parseNaiZip` 解析 ——
 *    **本模块自己不解 zip、不判图**（那是纯函数层的事，一处解析规则）
 * 3. 把失败翻译成 `ImageGenFailure`（§12.2 那张表逐条），带超时与取消
 *
 * 🔴 **成功路径只准 `arrayBuffer()`，永远不许 `json()` / `text()`**（§12.1 第 2 条）。
 * NAI 的成功响应是 `application/x-zip-compressed` 的 zip 二进制：任何一次「按文本读」
 * 都会在非法 UTF-8 字节处产生替换字符（U+FFFD），把 zip 悄悄读坏 —— **不报错，只是
 * 解不开**，而且症状会伪装成「上游返回了坏 zip」，查起来极贵。`text()` 只在
 * **非 2xx** 的错误体上调用，那时上游给的确实是 JSON/纯文本。测试钉住了这一条。
 *
 * 🔴 **必须走 BFF**: NAI 没有 CORS（§6 那张表），浏览器直连必被拦。请求打到同源的
 * `/api/image/generate`，由 `server/routes/image.ts` 复用 `forward()` 管道直通；
 * key 仍前端持有（SillyTavern 模式），经 `Authorization` 透传，BFF 零状态。
 *
 * ⚠️ **永不抛穿**。网络失败、HTTP 非 2xx、响应读不动、用户取消 —— 全部变成
 * `ImageGenFailure`（`ok: false`）返回。一次上游抽风不该冒泡成未捕获的
 * Promise rejection，更不该让整条出图队列停摆。
 *
 * 注入缝: `setImageFetch()`。测试全程 mock，**绝不发真实请求**。
 */

import { parseNaiZip, type NaiRequestBody } from '@engine/image-providers/novelai';
import { IMAGE_BAD_RESPONSE_MESSAGE, IMAGE_FAILURE_RETRYABLE } from '@engine/image-defaults';
import type { ImageGenFailure, ImageGenFailureKind } from '@engine/types-image';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * NovelAI 生图 API 的 base URL（**不带尾斜杠**，路径由 BFF 补 `/ai/generate-image`）。
 *
 * 提成常量是为了将来换后端（自建代理 / 镜像 / 本地 mock）只改一行；设置页的
 * 「端点」输入框会把用户值经 `baseUrl` 传进来，缺省即此值。
 */
export const NAI_IMAGE_API_BASE = 'https://image.novelai.net';

/** 同源 BFF 路由（`server/routes/image.ts` + `vite.config.ts` 的挂载前缀） */
export const IMAGE_BFF_ENDPOINT = '/api/image/generate';

/**
 * NAI 要求的响应类型。**由前端设置**，`forward()` 原样透传（§12.1 第 3 条）。
 *
 * 不写 `application/json`: 那会让上游有理由改用 JSON 回图（base64），
 * 而我们整条路径是为 zip 字节设计的。
 */
export const NAI_ZIP_ACCEPT = 'application/x-zip-compressed';

/**
 * 一次出图请求的超时上限 —— 2 分钟。
 *
 * 为什么必须有: `fetch` **默认不超时**。上游挂起、代理吞连接、移动网络切换，
 * 这些都不会让 Promise 兑现，于是那条记录会永远停在 `generating`，队列后面的
 * 全部堵死（§8.2 串行发）。判别联合把「失败」建模得再干净，也救不了一个永不兑现的 Promise。
 *
 * 为什么是 2 分钟而不是工坊那 15 秒: 出图本身就是几十秒量级的重活（1216×832 / 23 步），
 * 且是用户主动点了之后的等待，容忍度天然更高。宽到「比最坏的一次生成还长」，
 * 窄到「不会让人以为程序死了」。
 */
export const IMAGE_REQUEST_TIMEOUT_MS = 120_000;

/**
 * §12.2 那张表的 UI 文案 —— **中文原文，一字不改**。
 *
 * ⚠️ `bad-response` 那句与 `image-providers/novelai.ts` 用的是**同一个常量**
 * （`image-defaults.IMAGE_BAD_RESPONSE_MESSAGE`）。本模块只在**字节根本读不出来**
 * 时用它，zip 内容的判定一律交给 `parseNaiZip` —— 两处产出同一句文案，但判据不重叠。
 */
const FAILURE_MESSAGES = {
  auth: 'NovelAI 令牌无效或已过期，去设置里重填',
  payment: 'Anlas 不足，或这次的尺寸/步数超出了免费额度',
  'rate-limit': 'NovelAI 限流了，过一会儿再试',
  'bad-request': '请求被拒绝',
  upstream: 'NovelAI 服务端出错了',
  network: '连不上 NovelAI，检查网络或代理',
  aborted: '已取消',
  'bad-response': IMAGE_BAD_RESPONSE_MESSAGE,
} as const satisfies Partial<Record<ImageGenFailureKind, string>>;

/**
 * 哪几类值得再试（§12.2 最后一列）—— 表在 `image-defaults` 里。
 *
 * 为什么不留在本模块: 渲染层要用同一张表决定失败段上画不画「重试」按钮
 * （设计 §10.2 那一行）。两份表会漂成「客户端说可以重试、界面上却没有按钮」。
 */
const RETRYABLE: Partial<Record<ImageGenFailureKind, boolean>> = IMAGE_FAILURE_RETRYABLE;

/** 上游错误正文进 UI 时的长度闸（只有 400 那一格会用摘要，§12.2） */
const DETAIL_SUMMARY_MAX = 160;

// ═══════════════════════════════════════════════════════════
// 注入缝
// ═══════════════════════════════════════════════════════════

/**
 * 传给 fetch 的第二参数。
 *
 * 刻意只有这四项: 本模块是**唯一网络口**，不该在这里长出「让这一发请求特殊一点」
 * 的调用方开关。尤其禁止 `credentials` —— 打的是同源 BFF，Cookie 一律不参与。
 */
export interface ImageFetchInit {
  method?: 'POST';
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * 只声明本模块**真正会用**的响应面。
 *
 * 🔴 `arrayBuffer` 是必需项而 `json` 根本不在这个接口里 —— 类型层面就堵死了
 * 「顺手 `await res.json()`」那条会读坏二进制的路（§12.1 第 2 条）。
 * 真实的 `Response` 结构上满足本接口，测试里的假对象也只需实现这几项。
 */
export interface ImageResponseLike {
  ok: boolean;
  status: number;
  statusText?: string;
  headers?: { get: (name: string) => string | null };
  /** 成功路径唯一的读法 */
  arrayBuffer: () => Promise<ArrayBuffer>;
  /** **只在非 2xx 的错误体上调用** */
  text: () => Promise<string>;
}

export type ImageFetchLike = (url: string, init?: ImageFetchInit) => Promise<ImageResponseLike>;

let injectedFetch: ImageFetchLike | undefined;

/**
 * 换掉 fetch 实现（测试 / 将来换传输层）。传 `undefined` 恢复用 `globalThis.fetch`。
 *
 * 默认实现是**惰性取用**的: 仅 import 本模块不碰任何浏览器全局，vitest
 * `environment:'node'` 下可直接导入（对齐 `workshop-client.ts` / `media-hash.ts`）。
 */
export function setImageFetch(impl?: ImageFetchLike): void {
  injectedFetch = impl;
}

/** 测试收尾用: 清掉注入的实现 */
export function resetImageClient(): void {
  injectedFetch = undefined;
}

function resolveFetch(): ImageFetchLike | undefined {
  if (injectedFetch) return injectedFetch;
  const g = globalThis as { fetch?: typeof fetch };
  if (typeof g.fetch !== 'function') return undefined;
  return (url, init) => g.fetch!(url, init as RequestInit) as unknown as Promise<ImageResponseLike>;
}

// ═══════════════════════════════════════════════════════════
// 失败构造
// ═══════════════════════════════════════════════════════════

function fail(
  kind: Exclude<ImageGenFailureKind, 'prompt-agent'>,
  detail?: string,
  messageOverride?: string,
): ImageGenFailure {
  return {
    ok: false,
    kind,
    message: messageOverride ?? FAILURE_MESSAGES[kind],
    ...(detail ? { detail } : {}),
    retryable: RETRYABLE[kind] ?? true,
  };
}

/**
 * 上游错误正文 → 一句人能读的摘要。
 *
 * 两种形状都解: 我们自己 BFF 的 `{error: "..."}`（`forward()` 的四个早退分支）
 * 与 NAI 的 `{message: "..."}` / `{statusCode, message}`。解不出来就退回原文，
 * 再解不出来就返回 undefined —— **一个失败的响应体读不动，不该把失败本身变成另一种失败**。
 */
export function summarizeUpstreamDetail(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const compact = raw.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;

  let picked = compact;
  try {
    const parsed: unknown = JSON.parse(compact);
    if (parsed && typeof parsed === 'object') {
      const rec = parsed as Record<string, unknown>;
      const candidate = rec.message ?? rec.error ?? rec.detail;
      if (typeof candidate === 'string' && candidate.trim()) picked = candidate.trim();
    }
  } catch {
    // 不是 JSON（HTML 拦截页 / 纯文本）—— 用原文，不编内容
  }

  return picked.length > DETAIL_SUMMARY_MAX ? `${picked.slice(0, DETAIL_SUMMARY_MAX)}…` : picked;
}

/**
 * HTTP 状态码 → 失败分类（§12.2 那张表）。
 *
 * 导出是为了让测试逐格钉死，也让将来接第二家 provider 时能看见这张表在哪。
 *
 * 表里没有列出的状态码（403 / 404 / 其它 4xx）落到 `bad-request`: 它们都是
 * 「这一发请求本身不被接受」，重试同一份请求体不会变好。**不乐观归类** ——
 * 把说不清的失败标成可重试，会让自动档在同一堵墙上反复撞并反复花钱。
 */
export function classifyImageHttpStatus(status: number, detail?: string): ImageGenFailure {
  const withStatus = detail ? `HTTP ${status}: ${detail}` : `HTTP ${status}`;

  if (status === 401) return fail('auth', withStatus);
  if (status === 402) return fail('payment', withStatus);
  if (status === 429) return fail('rate-limit', withStatus);
  if (status >= 500) return fail('upstream', withStatus);

  // 400 及其余 4xx —— 唯一一格把「摘要」放进 UI 文案的（表里写死了 `请求被拒绝：{摘要}`）
  const summary = summarizeUpstreamDetail(detail);
  return fail(
    'bad-request',
    withStatus,
    summary ? `${FAILURE_MESSAGES['bad-request']}：${summary}` : FAILURE_MESSAGES['bad-request'],
  );
}

// ═══════════════════════════════════════════════════════════
// 超时闸
// ═══════════════════════════════════════════════════════════

/**
 * 内部超时 + 调用方外部信号，合成一个交给 fetch 的 signal。
 *
 * 不用 `AbortSignal.timeout()` / `AbortSignal.any()`: 前者在旧 Safari 缺席，
 * 后者是 2024 才铺开的 API —— 不值得为省八行代码押上一个「某些浏览器上永不超时」
 * 的静默退化（同 `workshop-client.armTimeout`，那里有完整说明）。
 *
 * `timedOut()` 让调用点能把「超时」与「用户取消」分开报 —— 两者在 fetch 眼里
 * 都只是同一个 AbortError，但一个是 `network`、一个是 `aborted`，处置完全不同。
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
// 公开 API
// ═══════════════════════════════════════════════════════════

export interface NaiGenerateOptions {
  /** NAI persistent token。**不带 `Bearer ` 前缀**，本模块自己加 */
  token: string;
  /** `buildNaiRequest()` 的产出。本模块**一个字段都不改**（三重冗余已在那儿保证） */
  body: NaiRequestBody;
  /** 上游 base，缺省 {@link NAI_IMAGE_API_BASE}。设置页「端点」输入框会传进来 */
  baseUrl?: string;
  /** 调用方主动取消（切存档 / 离开页面 / 用户点了取消，§8.2） */
  signal?: AbortSignal;
  /** 覆盖 {@link IMAGE_REQUEST_TIMEOUT_MS}，仅测试与特殊网络环境用 */
  timeoutMs?: number;
}

/**
 * 成功产物。
 *
 * `images` 按 zip 内条目顺序（`parseNaiZip` 的契约）；v1 只发 `n_samples: 1`，
 * 所以实际恒为 1 张，但形状留着 —— 将来一次出多张不必改签名。
 */
export interface NaiGenerateSuccess {
  ok: true;
  images: Uint8Array[];
  /** 上游报的 content-type，原样带上（排查「返回了看不懂的内容」时唯一的线索） */
  contentType: string;
}

export type NaiGenerateResult = NaiGenerateSuccess | ImageGenFailure;

/**
 * 经同源 BFF 向 NovelAI 要一张图。**判别联合，永不抛穿。**
 *
 * 流程: 早退校验 → 发 POST → 非 2xx 走 {@link classifyImageHttpStatus} →
 * 2xx 按 `arrayBuffer()` 读字节 → 交给 `parseNaiZip` 解 zip。
 *
 * 🔴 成功路径**不碰** `text()` / `json()`（见文件头）。
 */
export async function generateNaiImage(opts: NaiGenerateOptions): Promise<NaiGenerateResult> {
  const impl = resolveFetch();
  if (!impl) return fail('network', '当前环境没有可用的 fetch');

  // 没令牌就别白发一次请求 —— 上游一定 401，而这里能立刻给出同一句话
  const token = opts.token?.trim();
  if (!token) return fail('auth', '未配置 NovelAI 令牌');

  // 调用方已经取消了才轮到我们
  if (opts.signal?.aborted) return fail('aborted');

  const base = (opts.baseUrl?.trim() || NAI_IMAGE_API_BASE).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? IMAGE_REQUEST_TIMEOUT_MS;
  const guard = armTimeout(timeoutMs, opts.signal);

  /** 中断类错误的统一归类: 超时优先于取消（超时也会让外部看到 aborted） */
  const abortFailure = (): ImageGenFailure | undefined => {
    if (guard.timedOut()) return fail('network', `等待上游超过 ${Math.round(timeoutMs / 1000)} 秒`);
    if (opts.signal?.aborted) return fail('aborted');
    return undefined;
  };

  try {
    const init: ImageFetchInit = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // §12.1 第 3 条: 由前端设置，`forward()` 已透传
        Accept: NAI_ZIP_ACCEPT,
        Authorization: `Bearer ${token}`,
        // `forward()` 从这个 header 取上游 base（SSRF 黑名单在那边，本层不重复判）
        'X-Target-Base-URL': base,
      },
      body: JSON.stringify(opts.body),
      ...(guard.signal ? { signal: guard.signal } : {}),
    };

    let res: ImageResponseLike;
    try {
      res = await impl(IMAGE_BFF_ENDPOINT, init);
    } catch (err) {
      return abortFailure() ?? fail('network', describeError(err));
    }

    if (!res || typeof res.arrayBuffer !== 'function') {
      return fail('bad-response', '响应对象不可读');
    }

    if (!res.ok) {
      // 错误正文里往往有唯一能自救的那句话。读不出来也无所谓 ——
      // 一个失败的响应体读不动，不该把失败本身变成另一种失败。
      let raw: string | undefined;
      try {
        raw = typeof res.text === 'function' ? await res.text() : undefined;
      } catch {
        raw = undefined;
      }
      const status = typeof res.status === 'number' ? res.status : 0;
      return classifyImageHttpStatus(status, summarizeUpstreamDetail(raw));
    }

    const contentType = res.headers?.get('content-type') ?? '';

    let buf: ArrayBuffer;
    try {
      // 🔴 这里是全模块唯一的读体调用，且**必须**是 arrayBuffer（见文件头）
      buf = await res.arrayBuffer();
    } catch (err) {
      return abortFailure() ?? fail('bad-response', `响应字节读取失败: ${describeError(err)}`);
    }

    const bytes = new Uint8Array(buf);
    if (bytes.length === 0) return fail('bad-response', '响应体是空的');

    // zip 的判定与解包一律交给纯函数层，本模块不长第二套解析规则
    const parsed = parseNaiZip(bytes, contentType);
    if (!parsed.ok) return parsed;

    return { ok: true, images: parsed.images, contentType };
  } finally {
    guard.dispose();
  }
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return String(err);
}
