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
import {
  BUILTIN_COMFY_WORKFLOW,
  comfyFail,
  parseComfyHistory,
  parseComfyQueueResponse,
  parseComfyWorkflow,
  substituteWorkflow,
  type ComfyImageRef,
  type ComfySubstitutionValues,
} from '@engine/image-providers/comfyui';
import { IMAGE_BAD_RESPONSE_MESSAGE, IMAGE_FAILURE_RETRYABLE } from '@engine/image-defaults';
import type { ImageGenFailure, ImageGenFailureKind } from '@engine/types-image';

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * NovelAI 生图 API 的 base URL（**不带尾斜杠**，路径由 BFF 补 `/ai/generate-image`）。
 *
 * 提成常量是为了将来换后端（自建代理 / 镜像 / 本地 mock）只改一行。
 *
 * 🔴 **生产就是用它，不再由设置页供值**（2026-08-05）：出图端点那格地址填错两次、
 * 两次都被上游报成指向别处的错（见 {@link resolveImageBaseUrl}），于是裁定地址由代码
 * 持有、用户只填令牌。`generateNaiImage` 仍收 `baseUrl`（镜像 / 测试替身要用），
 * 但 `scene-image-seams` **不传**。
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

/**
 * NovelAI 的**文本 / 账户**域。出图不在这台机器上（出图在 {@link NAI_IMAGE_API_BASE}）。
 *
 * 之所以要专门认它一下，见 {@link resolveImageBaseUrl} 的说明。
 */
const NAI_TEXT_API_HOST = 'api.novelai.net';

/** BFF 自己会补的上游路径（`server/routes/image.ts`）。用户连它一起填进 base 时要剃掉 */
const NAI_IMAGE_PATH = '/ai/generate-image';

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
  /** ComfyUI 的 `/history` 与 `/view` 是 GET（C10），NAI 与 `/prompt` 是 POST */
  method?: 'POST' | 'GET';
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
  // 🔴 排除的三类都**不由本模块产出**：`prompt-agent` 是侧链的，
  //    `workflow` / `execution` 是 ComfyUI 独有的（C12，由那条链自己分类与措辞）。
  //    在类型上排掉，`FAILURE_MESSAGES` 就不必为它们编一句 NovelAI 语气的文案。
  kind: Exclude<ImageGenFailureKind, 'prompt-agent' | 'workflow' | 'execution'>,
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
// 端点地址归一化
// ═══════════════════════════════════════════════════════════

/**
 * 设置页那格「图像端点 Base URL」→ 真正发出去的上游地址。
 *
 * **为什么这件事必须在本地做**（2026-08-05 真机连坑两次的教训）：这一格填错时，
 * 上游回的错**全都指着无辜的地方**，人得从错误信息倒推到一个根本没被提及的输入框 ——
 *
 * - 填成 `https://api.novelai.net`（NAI 的**文本/账户**域）→ 那台机器上 `/ai/generate-image`
 *   还活着（所以是 400 不是 404），但它的模型枚举停在 V3 时代，于是它对一个完全合法的
 *   `nai-diffusion-4-5-full` 回 **「model must be a valid enum value」** —— 看起来像模型名写错了
 * - 漏掉 `https://` → BFF 的 `forward()` 回 **「invalid X-Target-Base-URL」** —— 看起来像 header 坏了
 *
 * 所以：能归一化的就地归一化，归一化不了的**在本地**说清楚是哪一格填错了，一次上游请求都不发。
 *
 * 🔴 `api.novelai.net` **只报错、不改写**。改写等于替用户决定把他的令牌送去哪台机器；
 *    而这一格存在的理由本来就是自建代理/镜像，静默改写会长出「我明明填了 A、日志里却是 B」
 *    这种更难查的问题。补 `https://` 是另一回事 —— 那不改变打给谁。
 *
 * 纯函数，导出只为让测试逐格钉死。
 */
export function resolveImageBaseUrl(
  raw: string | undefined,
): { ok: true; base: string } | { ok: false; message: string; detail: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: true, base: NAI_IMAGE_API_BASE };

  // 漏协议 → 补 https。这一步**不改变打给谁**，只补上唯一合理的那个值
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return {
      ok: false,
      message: `出图端点地址填错了，去「API 配置」里改成 ${NAI_IMAGE_API_BASE}`,
      detail: `无法解析的端点地址: ${trimmed}`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      message: `出图端点地址只能是 http/https，去「API 配置」里改成 ${NAI_IMAGE_API_BASE}`,
      detail: `端点地址的协议是 ${url.protocol}`,
    };
  }

  if (url.hostname.toLowerCase() === NAI_TEXT_API_HOST) {
    return {
      ok: false,
      message: `出图要用 ${NAI_IMAGE_API_BASE}；${NAI_TEXT_API_HOST} 是 NovelAI 的文本/账户域，不出图`,
      detail: `端点地址是 ${url.origin}，那台机器不认 V4/V4.5 的模型名`,
    };
  }

  // 用户把完整 URL 整条粘进来时剃掉尾部路径 —— 否则 BFF 会再拼一次，
  // 打到 `.../ai/generate-image/ai/generate-image`
  const noSlash = withScheme.replace(/\/+$/, '');
  const stripped = noSlash.toLowerCase().endsWith(NAI_IMAGE_PATH)
    ? noSlash.slice(0, -NAI_IMAGE_PATH.length)
    : noSlash;

  return { ok: true, base: stripped.replace(/\/+$/, '') };
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

  // 端点地址填错就在这里收口，一次上游请求都不发 —— 上游对这一格的报错全都指着无辜的地方
  const resolved = resolveImageBaseUrl(opts.baseUrl);
  if (!resolved.ok) return fail('bad-request', resolved.detail, resolved.message);
  const base = resolved.base;

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

// ═══════════════════════════════════════════════════════════
// ComfyUI（图像 v2 / C10-C13）
// ═══════════════════════════════════════════════════════════
//
// 与 NAI 那半边的三处**结构性**不同，别按 NAI 的直觉改这一段:
//
// 1. **三次请求不是一次**: 排队（POST /prompt）→ 轮询（GET /history/{id}）→ 取字节
//    （GET /view）。对外仍是**单个 Promise**（C13）——「排到第几了」这种进度
//    在 UI 上已经由 queued/generating + 「已用 N 秒」表达了，多一层回调只会多一处状态。
// 2. **`/prompt` 与 `/history` 回的是 JSON，只有 `/view` 回字节**。所以那两条上
//    `text()` 是**正当**的读法（本模块自己 `JSON.parse`），而 `/view` 上**只准
//    `arrayBuffer()`** —— 与 NAI 那条同一条纪律，理由也一样（按文本读会在非法 UTF-8
//    字节处塞进 U+FFFD，把 PNG 悄悄读坏、不报错）。
// 3. **超时是 600 秒不是 120 秒**（C13）: 本地出图慢得多，2 分钟硬闸会把一张仍在渲染的图
//    记成失败，然后它又悄悄落在用户的输出目录里 —— 最难解释的那种「失败」。

/** 同源 BFF 路由（`server/routes/image.ts` 的三条 `forward()`） */
export const COMFY_BFF_PROMPT = '/api/image/comfy/prompt';
export const COMFY_BFF_HISTORY = '/api/image/comfy/history';
export const COMFY_BFF_VIEW = '/api/image/comfy/view';

/** ComfyUI 默认地址（本机默认端口）。地址住 provider 袋，不进 API 池（C16） */
export const COMFY_DEFAULT_BASE_URL = 'http://127.0.0.1:8188';

/**
 * 整条链（排队 + 轮询 + 取字节）的总时限 —— 10 分钟（C13）。
 *
 * 🔴 **不是** NAI 那个 120 秒。本地卡、大图、上采样链随便就跑过 2 分钟；用 NAI 的闸门
 * 会把一张仍在渲染的图记成失败，而它随后照样落进输出目录 —— 用户看到的是「失败了，
 * 但文件夹里有」。宽到「比最坏的一次本地生成还长」，窄到「不会永远转下去」。
 */
export const COMFY_REQUEST_TIMEOUT_MS = 600_000;

/** 轮询间隔（C13）。ComfyUI 是本机服务，1.5 秒既不吵也不迟钝 */
export const COMFY_POLL_INTERVAL_MS = 1_500;

/**
 * ComfyUI 地址归一化。
 *
 * 刻意**比 {@link resolveImageBaseUrl} 简单**: NAI 那格有「填成文本域会收到一句指向
 * 模型名的错」这种陷阱，所以那边要认域名、要剃路径。ComfyUI 没有这类陷阱 ——
 * 地址填错的败法是**诚实的** connection-refused（C16）。这里只做三件不改变「打给谁」
 * 的事: 去空白、补 scheme、剃尾斜杠。
 *
 * 🔴 补的是 **http** 不是 https: 默认目标是 `127.0.0.1:8188`，ComfyUI 默认不开 TLS。
 *    补 https 会让「填了 localhost:8188」变成一次必然失败的握手。
 */
export function resolveComfyBaseUrl(
  raw: string | undefined,
): { ok: true; base: string } | { ok: false; message: string; detail: string } {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: true, base: COMFY_DEFAULT_BASE_URL };

  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return {
      ok: false,
      message: `ComfyUI 地址填错了，去「图像生成 → 出图」里改成 ${COMFY_DEFAULT_BASE_URL} 这样的形式`,
      detail: `无法解析的 ComfyUI 地址: ${trimmed}`,
    };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      message: 'ComfyUI 地址只能是 http/https',
      detail: `ComfyUI 地址的协议是 ${url.protocol}`,
    };
  }

  return { ok: true, base: withScheme.replace(/\/+$/, '') };
}

export interface ComfyGenerateOptions {
  /** ComfyUI 地址（`imageComfy.baseUrl`，C16）。缺省 {@link COMFY_DEFAULT_BASE_URL} */
  baseUrl?: string;
  /** 用户粘贴的 API-format 工作流；缺省用 `BUILTIN_COMFY_WORKFLOW`（C11） */
  workflowJson?: string;
  /** 替换进图里的值（`%positive%` `%seed%` …） */
  values: ComfySubstitutionValues;
  /**
   * `values.seed` 缺省时用它。
   *
   * 🔴 引擎那层（`comfyui.ts`）**不许**产随机（快照复现），所以这个数只能从外面进来。
   * 本层缺省用时钟——网络层本来就读时钟（超时闸）、也本来就不可复现，是唯一合适的兜底位。
   * 正经调用方（T6 的 seams）应当**显式**给一个与记录一起落库的 seed。
   */
  seedFallback?: number;
  /** ComfyUI 用它把执行进度关联到某个客户端；不给就不发 */
  clientId?: string;
  /** 调用方主动取消（切存档 / 离开页面 / 用户点了取消） */
  signal?: AbortSignal;
  /** 覆盖 {@link COMFY_REQUEST_TIMEOUT_MS} */
  timeoutMs?: number;
  /** 覆盖 {@link COMFY_POLL_INTERVAL_MS}。测试传 0 让轮询不真的等 */
  pollIntervalMs?: number;
}

/** 与 NAI 同形状的成功产物 —— 上层（seams / store）对两家 provider 一视同仁 */
export type ImageGenerateResult = NaiGenerateResult;

/**
 * 可被 signal 提前唤醒的 sleep（取消时不必干等满一个轮询间隔）。
 *
 * 🔴 `ms <= 0` 时**照样走 setTimeout**，不许图省事 `return Promise.resolve()`:
 * 那样轮询循环就只在**微任务**里打转，而 `setTimeout` 是宏任务 —— 超时闸的定时器
 * 永远排不上队，于是「轮询间隔设成 0」等于把总超时一起关掉，循环无限跑下去。
 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms));
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    if (signal) {
      if (signal.aborted) done();
      else signal.addEventListener('abort', done);
    }
  });
}

/** 读一条 JSON 响应（`/prompt` 与 `/history` 专用；**绝不用在 `/view` 上**） */
async function readJsonBody(res: ImageResponseLike): Promise<unknown> {
  if (typeof res.text !== 'function') return undefined;
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    // 不是 JSON（HTML 拦截页 / 纯文本）—— 交给上层按状态码分类，这里不编内容
    return undefined;
  }
}

/**
 * 经同源 BFF 让本地 ComfyUI 出一张图。**判别联合，永不抛穿**（同 {@link generateNaiImage}）。
 *
 * 流程（C13）: 归一化地址 → 解析/取内置工作流 → 值级替换 → `POST /prompt` →
 * {@link parseComfyQueueResponse} → 每 ~1.5s 轮询 `/history/{id}` → `GET /view` 逐张取字节。
 *
 * 🔴 整条链共用**一个**总时限与**一个** signal: 三段各自计时的话，一张卡在 `/history` 上的图
 *    会永远续命下去（每一段都没超时，合起来无限长）。
 * 🔴 `/view` 只读 `arrayBuffer()`；content-type 只是线索、进不了判据
 *    （v1 那次「content-type 撒谎、把已付费的图扔掉」的教训，见 `parseNaiZip` 的注释）。
 */
export async function generateComfyImage(opts: ComfyGenerateOptions): Promise<ImageGenerateResult> {
  const impl = resolveFetch();
  if (!impl) return comfyFail('network', '当前环境没有可用的 fetch');
  if (opts.signal?.aborted) return comfyFail('aborted');

  const resolved = resolveComfyBaseUrl(opts.baseUrl);
  if (!resolved.ok) return comfyFail('bad-request', resolved.detail, resolved.message);
  const base = resolved.base;

  // 工作流: 用户粘贴的优先，没有就用内置最小图（C11）
  let graph = BUILTIN_COMFY_WORKFLOW;
  if (opts.workflowJson && opts.workflowJson.trim()) {
    const parsed = parseComfyWorkflow(opts.workflowJson);
    if (!parsed.ok) return parsed;
    graph = parsed.graph;
  }

  // 🔴 `substituteWorkflow` 不产随机（那层要可复现），兜底的那个数在这里给
  const seedFallback = opts.seedFallback ?? Date.now() % 0x7fffffff;
  const prompt = substituteWorkflow(graph, opts.values, seedFallback);

  const timeoutMs = opts.timeoutMs ?? COMFY_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? COMFY_POLL_INTERVAL_MS;
  const guard = armTimeout(timeoutMs, opts.signal);

  const abortFailure = (): ImageGenFailure | undefined => {
    if (guard.timedOut())
      return comfyFail('network', `等待 ComfyUI 超过 ${Math.round(timeoutMs / 1000)} 秒`);
    if (opts.signal?.aborted) return comfyFail('aborted');
    return undefined;
  };

  const jsonHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // `forward()` 从这个 header 取上游 base（SSRF 名单在那边，本层不重复判）
    'X-Target-Base-URL': base,
  };

  try {
    // ── 1. 排队 ──
    let queueRes: ImageResponseLike;
    try {
      queueRes = await impl(COMFY_BFF_PROMPT, {
        method: 'POST',
        headers: jsonHeaders,
        body: JSON.stringify({
          prompt,
          ...(opts.clientId ? { client_id: opts.clientId } : {}),
        }),
        ...(guard.signal ? { signal: guard.signal } : {}),
      });
    } catch (err) {
      return abortFailure() ?? comfyFail('network', describeError(err));
    }

    // 🔴 200 也要读体: `node_errors` 就藏在那里（C12）
    const queued = parseComfyQueueResponse(
      typeof queueRes?.status === 'number' ? queueRes.status : 0,
      await readJsonBody(queueRes),
    );
    if (!queued.ok) return queued;

    // ── 2. 轮询 ──
    const historyUrl = `${COMFY_BFF_HISTORY}/${encodeURIComponent(queued.promptId)}`;
    let images: ComfyImageRef[] | undefined;

    for (;;) {
      const interrupted = abortFailure();
      if (interrupted) return interrupted;

      let res: ImageResponseLike;
      try {
        res = await impl(historyUrl, {
          method: 'GET',
          headers: jsonHeaders,
          ...(guard.signal ? { signal: guard.signal } : {}),
        });
      } catch (err) {
        return abortFailure() ?? comfyFail('network', describeError(err));
      }

      if (!res?.ok) {
        const status = typeof res?.status === 'number' ? res.status : 0;
        const detail = `轮询 /history 得到 HTTP ${status}`;
        if (status >= 500) return comfyFail('upstream', detail);
        return comfyFail('bad-request', detail);
      }

      const state = parseComfyHistory(await readJsonBody(res), queued.promptId);
      if (state.state === 'failed') return state.failure;
      if (state.state === 'done') {
        images = state.images;
        break;
      }

      await sleep(pollIntervalMs, guard.signal);
    }

    // ── 3. 取字节 ──
    const bytes: Uint8Array[] = [];
    let contentType = '';

    for (const ref of images) {
      const interrupted = abortFailure();
      if (interrupted) return interrupted;

      const query = new URLSearchParams({
        filename: ref.filename,
        subfolder: ref.subfolder,
        type: ref.type,
      });

      let res: ImageResponseLike;
      try {
        res = await impl(`${COMFY_BFF_VIEW}?${query.toString()}`, {
          method: 'GET',
          headers: { Accept: 'image/*', 'X-Target-Base-URL': base },
          ...(guard.signal ? { signal: guard.signal } : {}),
        });
      } catch (err) {
        return abortFailure() ?? comfyFail('network', describeError(err));
      }

      if (!res || typeof res.arrayBuffer !== 'function') {
        return comfyFail('bad-response', `/view 的响应对象不可读（${ref.filename}）`);
      }
      if (!res.ok) {
        const status = typeof res.status === 'number' ? res.status : 0;
        return comfyFail('bad-response', `/view 得到 HTTP ${status}（${ref.filename}）`);
      }

      let buf: ArrayBuffer;
      try {
        // 🔴 全流程唯一读**字节**的地方，且必须是 arrayBuffer（见本节头注释第 2 条）
        buf = await res.arrayBuffer();
      } catch (err) {
        return (
          abortFailure() ??
          comfyFail('bad-response', `/view 字节读取失败（${ref.filename}）: ${describeError(err)}`)
        );
      }

      const data = new Uint8Array(buf);
      if (data.length === 0) {
        return comfyFail('bad-response', `/view 返回了 0 字节（${ref.filename}）`);
      }

      if (!contentType) contentType = res.headers?.get('content-type') ?? '';
      bytes.push(data);
    }

    if (bytes.length === 0) {
      return comfyFail('bad-response', '执行完成但一张图都没取到');
    }

    return { ok: true, images: bytes, contentType };
  } finally {
    guard.dispose();
  }
}
