/**
 * remote-asset-sync.ts — 远程素材的镜像同步服务（远程素材 v1 / 波 2）
 *
 * 波 1（`@engine/remote-asset-catalogue`）把两种本地载体（世界书条目正文里的
 * `profile` 字面量 / 内容包的 `remoteAssets` 分节）归一成了 {@link RemoteAssetDecl}。
 * 本模块接着做剩下的两件事：**算清单**（纯函数）与**执行清单**（唯一的 I/O 面）。
 *
 * 三条纪律，每条都对应一个真实的失败形态：
 *
 * 1. 🔴 **清单 100% 由本地算出**（设计裁定 1）。声明来自本地世界书与已装内容包，
 *    网络只用来下字节。于是「镜像删除」在**离线时也是安全的**：断网不会让清单变空，
 *    因为清单根本不问网络。反过来说，一次下载失败**永远不允许**删掉或降级任何已有行
 *    —— 失败只进 `failed`，逐条隔离、不中断其余（见 {@link runRemoteAssetSync}）。
 * 2. 🔴 **用户的行永远赢**。同一个 `(name, type, variant)` 位上若坐着一行**没有
 *    `remote` 戳**的素材（用户自己导入的），远程声明一律让路 —— 不下载、不覆盖、
 *    不改名，只计一次 `skippedUserOwned`。没有这条，一次装包就能把玩家自己配的
 *    立绘悄悄换成作者的版本，而他从没同意过。
 * 3. 🔴 **只镜像自己那一半**。删除的候选**仅限带 `remote` 戳的行**：戳是「这一行的
 *    字节是我下下来的」这个事实的唯一凭据。少了这道过滤，「同步」会变成「把素材库
 *    删到只剩声明里那几张」。
 *
 * 纯度分层（照 `asset-import-plan.ts` 的先例：决策是纯同步函数，执行方只做蠢事）：
 * - {@link collectDesiredRemoteAssets} / {@link planRemoteAssetSync} 无 I/O、无 Vue、
 *   无 Dexie，可穷举测试；
 * - {@link runRemoteAssetSync} 是唯一的效果面，且**所有外部依赖从 deps 交进来**
 *   （fetch / 落库 / 删除 / 哈希 / 时钟 / 发号），所以它同样不必挂 Pinia 就能测。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md（素材行的命名与
 * 落库口径）+ 远程素材 v1 的波 1 模块头。
 */

import {
  collectWorldBookRemoteAssets,
  dedupeRemoteAssetDecls,
  normalizePackRemoteAssets,
  type RemoteAssetDecl,
} from '@engine/remote-asset-catalogue';
import { ASSET_MIME_BY_EXTENSION, isAssetExtension, isMediaAllowed } from '@engine/asset-types';
import type { AssetMetaRecord, WorldBook } from '@engine/types';
import { hashMediaBlob } from './media-hash';

// ═══════════════════════════════════════════════════════════
// 常量
//
// 🔴 三个旋钮**刻意不导出**（死代码棘轮盯着）：它们是 `RemoteAssetSyncDeps` 里同名
// 可选字段的**缺省值**，调用点要改就传 deps，不该有第二条「import 常量再自己拼」的路。
// ═══════════════════════════════════════════════════════════

/**
 * 单张远程素材的体积上限。
 *
 * 素材字节住在**共享的**浏览器配额里（存档 / 音频 / 插画都在同一个池子），而这条
 * 链路的输入是第三方写的 URL —— 没有上限时，一条指向 4K 视频的链接就能把整库撑满，
 * 而症状会出现在**别的**功能上（存档写不进去）。25MB 已经远超任何一张立绘。
 */
const REMOTE_ASSET_MAX_BYTES = 25 * 1024 * 1024;

/**
 * 单次请求的停滞上限。
 *
 * 没有它的失败形态不是报错，是**永远转圈**：同步跑在启动链上，一个不响应的图床
 * 会让 `syncRemoteAssets()` 这个 promise 永不兑现，`running` 永远是 true。
 */
const REMOTE_ASSET_TIMEOUT_MS = 30_000;

/**
 * 并发下载上限。
 *
 * 一份卡里三十张立绘全部并发，对小图床是一次小型压测（多半换来一批 429），
 * 对本机是三十条同时在飞的 Dexie 写。4 条足以吃满带宽又不至于失礼。
 */
const REMOTE_ASSET_CONCURRENCY = 4;

/**
 * MIME → 扩展名的反查表。
 *
 * 与 `asset-store` 里那份同一套构造、同一条「先到先得」规则，且**都从
 * `ASSET_MIME_BY_EXTENSION` 这一份正向路由表推出来** —— 手写第二份清单才是漂移的
 * 来路，从同一张表推出来的两个反查表逐字节相同。
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {};
  for (const [ext, mime] of Object.entries(ASSET_MIME_BY_EXTENSION)) {
    if (!Object.prototype.hasOwnProperty.call(out, mime)) out[mime] = ext;
  }
  return out;
})();

// ═══════════════════════════════════════════════════════════
// 清单（纯函数）
// ═══════════════════════════════════════════════════════════

/**
 * 收齐「本地声明要哪些远程素材」。
 *
 * 🔴 **世界书排在内容包前面，而去重是「先来的赢」**（波 1 的
 * `dedupeRemoteAssetDecls`）：同一个位被两处声明时，世界书说了算。理由是世界书条目
 * 与角色是**同一份作者产物**（立绘就写在那张卡里），而 pack 的 `remoteAssets` 分节
 * 是整包级的批量补充 —— 让批量补充覆盖逐角色声明，等于让粗粒度的东西赢过细粒度的。
 * 顺序本身不重要，「有一个稳定且写下来的顺序」才重要：两处都有声明时，结论不该
 * 取决于谁先被扫到。
 *
 * @param books 全部世界书（含工坊装进来的）。波 1 只扫 `enabled !== false` 的条目
 * @param packRows 已装内容包的 `remoteAssets` 分节原值（`unknown`，容错收窄在波 1）
 */
export function collectDesiredRemoteAssets(
  books: readonly WorldBook[],
  packRows: unknown,
): RemoteAssetDecl[] {
  return dedupeRemoteAssetDecls([
    ...collectWorldBookRemoteAssets(books),
    ...normalizePackRemoteAssets(packRows),
  ]);
}

/** 一条待下载项 —— `replaces` 有值就是**原地换字节**（同一个 id），无值就是新建行 */
interface RemoteAssetDownload {
  decl: RemoteAssetDecl;
  /** 被替换的那一行（远程声明的地址变了）。缺席 = 这个位上还没有行 */
  replaces?: AssetMetaRecord;
}

/** 一次同步的计划 —— 全部由本地信息算出，不含任何网络事实 */
export interface RemoteAssetSyncPlan {
  /** 要下的（新建 + 换址） */
  toDownload: RemoteAssetDownload[];
  /** 镜像删除：带 `remote` 戳、但已不在声明清单里的行 */
  toDelete: AssetMetaRecord[];
  /** 位被用户自己的行占着，让路（不下载、不覆盖） */
  skippedUserOwned: RemoteAssetDecl[];
  /** 地址没变，原样留着（零网络） */
  kept: AssetMetaRecord[];
}

/** `(name, type, variant)` 的槽位键。`JSON.stringify` 而非拼接：名字是任意用户字符串 */
function slotKey(name: string, type: string, variant?: string): string {
  return JSON.stringify([name, type, variant ?? '']);
}

/** 这一行是远程同步的产物吗（`remote` 戳是唯一凭据） */
function isRemoteOwned(row: AssetMetaRecord): boolean {
  return typeof row.remote?.url === 'string' && row.remote.url !== '';
}

/**
 * 算一次同步计划。**纯函数**：同样的输入永远给同样的输出，不问网络也不问时钟。
 *
 * 五条分支（对应本文件头的三条纪律）：
 * | 情形 | 结论 |
 * |---|---|
 * | 位上没有行 | 下载 + 新建 |
 * | 位上是**用户的**行（无 `remote` 戳） | `skippedUserOwned`，用户赢 |
 * | 位上是远程行且 `remote.url` **相同** | `kept`，零网络 |
 * | 位上是远程行但地址**变了** | 下载 + 原地换字节（同 id） |
 * | 远程行的位**不在**声明清单里 | `toDelete`（镜像） |
 *
 * @param decls 已去重的声明（{@link collectDesiredRemoteAssets} 的产出）
 * @param existing 当前库里的全部素材行
 */
export function planRemoteAssetSync(
  decls: readonly RemoteAssetDecl[],
  existing: readonly AssetMetaRecord[],
): RemoteAssetSyncPlan {
  // 同一个位理论上只会有一行（分配器保证永不覆盖），真撞上了以**先出现的**为准 ——
  // 后面那行仍会被当成「位不在清单里」的远程行处理，于是重复行会被镜像收走。
  const byKey = new Map<string, AssetMetaRecord>();
  for (const row of existing) {
    const key = slotKey(row.name, row.type, row.variant);
    if (!byKey.has(key)) byKey.set(key, row);
  }

  const plan: RemoteAssetSyncPlan = {
    toDownload: [],
    toDelete: [],
    skippedUserOwned: [],
    kept: [],
  };
  /** 被声明覆盖到的位 —— 镜像删除的补集就从这里算 */
  const desiredKeys = new Set<string>();

  for (const decl of decls) {
    const key = slotKey(decl.name, decl.type, decl.variant);
    desiredKeys.add(key);
    const row = byKey.get(key);

    if (row === undefined) {
      plan.toDownload.push({ decl });
      continue;
    }
    if (!isRemoteOwned(row)) {
      // 🔴 用户赢。**连「地址一样」都不看** —— 那一行的字节是他自己导的，
      //    与这条声明恰好指向同一个位是巧合，不是所有权。
      plan.skippedUserOwned.push(decl);
      continue;
    }
    if (row.remote?.url === decl.url) {
      plan.kept.push(row);
      continue;
    }
    plan.toDownload.push({ decl, replaces: row });
  }

  for (const row of existing) {
    if (!isRemoteOwned(row)) continue; // 用户的行永不进删除候选
    if (desiredKeys.has(slotKey(row.name, row.type, row.variant))) continue;
    plan.toDelete.push(row);
  }

  return plan;
}

// ═══════════════════════════════════════════════════════════
// 下载（唯一碰网络的一段）
// ═══════════════════════════════════════════════════════════

/** 一次成功下载的产物 —— 字节 + **由字节的来源决定**的类型（不是猜的） */
interface RemoteAssetPayload {
  bytes: Uint8Array;
  mime: string;
  /** 小写、不含点 */
  ext: string;
}

/** 下载结论 —— 判别联合，**永不抛**（照 workshop-client / image-client 的先例） */
export type RemoteAssetDownloadResult =
  { ok: true; payload: RemoteAssetPayload } | { ok: false; reason: string };

/**
 * fetch 的注入缝。刻意收窄成「URL + 可选 signal」而不是整个 `typeof fetch`：
 * 测试替身不必去实现 `Request` 重载与那一大袋 init 字段。
 */
export type RemoteAssetFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<Response>;

/** http(s) 绝对地址（口径同波 1：正则而不是 `new URL`，免得依赖宿主全局） */
const HTTP_URL_RE = /^https?:\/\/\S+$/i;

/**
 * 图片代理候选 —— 移植自 `workshop-cover.ts` 的 wsrv.nl 回落链。
 *
 * 为什么需要它：素材地址是第三方图床，**相当一部分对 CORS 不友好**（不发
 * `Access-Control-Allow-Origin`），浏览器直连会在 `fetch` 这一步被拦下，
 * 而那与「图不存在」长得一模一样。工坊封面早就靠这一跳活着，这里复用同一层。
 *
 * 🔴 与封面链的一处不同：**不传 `w` / `output`**。封面只要能看，缩到 640px 转 webp
 * 是净赚；素材要**存下来**，重采样一遍就是把作者的原图换成一张更小更糊的。
 */
function proxyUrl(url: string): string {
  return `https://wsrv.nl/?url=${encodeURIComponent(url)}`;
}

/** 惰性取全局 `fetch`；环境里没有就给一个永远失败的替身（不抛在 import 期） */
function defaultFetch(): RemoteAssetFetch {
  const f = (globalThis as { fetch?: typeof fetch }).fetch;
  if (typeof f !== 'function') {
    return async () => {
      throw new Error('这个环境没有 fetch');
    };
  }
  return (url, init) => f(url, init);
}

/**
 * 从 URL 的**路径**里取扩展名（查询串里的点不算）。取不到 / 不认识 → undefined。
 *
 * 只在响应没有可信 Content-Type 时才会用到（见 {@link resolveMediaType}）。
 */
function extFromUrl(url: string): string | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const base = pathname.slice(pathname.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const ext = base.slice(dot + 1).toLowerCase();
  return isAssetExtension(ext) ? ext : undefined;
}

/**
 * 定这份字节到底是什么类型。
 *
 * 🔴 **Content-Type 优先，URL 后缀兜底**，顺序是有理由的：`ext` 是导出文件名与
 * 再导入路由的依据，记错了要到用户把包带去另一台机器才炸（asset-store 的
 * `producedAssetType` 为同一件事写过一遍）。而响应头是**服务器对它刚发出的那串
 * 字节**的自述，URL 后缀只是地址里的一段文本 —— 走代理时后者尤其会说谎（代理完全
 * 可能转码，此时地址还写着 `.png`）。
 *
 * 两者都问不出来 → `undefined`，调用方按「不是媒体」拒收。**绝不猜一个**：
 * 猜出来的类型会原样落进行里，而那一行此后一直在撒谎。
 */
function resolveMediaType(
  contentType: string | null,
  url: string,
): { mime: string; ext: string } | undefined {
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase();
  const byHeader = declared === '' ? undefined : EXTENSION_BY_MIME[declared];
  if (byHeader !== undefined) return { mime: declared, ext: byHeader };

  const byUrl = extFromUrl(url);
  if (byUrl !== undefined) {
    const mime = ASSET_MIME_BY_EXTENSION[byUrl];
    if (mime !== undefined) return { mime, ext: byUrl };
  }
  return undefined;
}

/**
 * 「字节到手了，但这份字节不能用」—— **不该再试代理**的那一类失败。
 *
 * 为什么要分这一类：代理这一跳是为了绕开 CORS 与传输错（那些在浏览器里表现为一个
 * 不带状态码的 TypeError，分不出「站挂了」还是「不让我读」）。而体积超限与
 * 「不是认得出来的格式」是**已经拿到响应之后**得出的结论，换条路再下一遍
 * ①白白再花一次流量（超限那条尤其贵）②代理的失败原因会**盖掉真正的原因** ——
 * 用户看到的是「HTTP 404」而不是「这张图太大了」，然后去查一个不存在的问题。
 */
class UnusableBytesError extends Error {}

interface DownloadOptions {
  fetchImpl?: RemoteAssetFetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** 外层取消（整次同步被中止） */
  signal?: AbortSignal;
}

/** 一次请求（含超时与体积闸）。抛出的错误由 {@link downloadRemoteAsset} 收成 reason */
async function fetchOnce(
  requestUrl: string,
  declaredUrl: string,
  options: Required<Pick<DownloadOptions, 'timeoutMs' | 'maxBytes'>> & DownloadOptions,
): Promise<RemoteAssetPayload> {
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  const Ctor = (globalThis as { AbortController?: new () => AbortController }).AbortController;
  const controller = Ctor ? new Ctor() : null;
  let timedOut = false;
  const timer = controller
    ? setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, options.timeoutMs)
    : null;
  // 外层取消也要能打断在飞的请求（整次同步被中止时）
  const onOuterAbort = (): void => controller?.abort();
  options.signal?.addEventListener('abort', onOuterAbort);

  try {
    const res = await fetchImpl(requestUrl, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // 声明的长度先看一眼：超限时**不必把 25MB 读进内存**才发现它超限
    const declaredLength = Number(res.headers?.get?.('content-length') ?? '');
    if (Number.isFinite(declaredLength) && declaredLength > options.maxBytes) {
      throw new UnusableBytesError(`超过单张上限（${options.maxBytes} 字节）`);
    }

    const bytes = new Uint8Array(await res.arrayBuffer());
    // 没有 content-length 的响应（分块传输）只能读完再判 —— 这一道才是权威的
    if (bytes.length > options.maxBytes) {
      throw new UnusableBytesError(`超过单张上限（${options.maxBytes} 字节）`);
    }

    const media = resolveMediaType(res.headers?.get?.('content-type') ?? null, declaredUrl);
    if (media === undefined) throw new UnusableBytesError('不是认得出来的图片/视频格式');

    return { bytes, mime: media.mime, ext: media.ext };
  } catch (err) {
    if (timedOut) throw new Error(`超过 ${options.timeoutMs}ms 没有响应`);
    throw err;
  } finally {
    if (timer !== null) clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/**
 * 下一张远程素材。**永不抛**，失败以 `{ ok:false, reason }` 收场。
 *
 * 两跳：直连 → wsrv.nl 代理（见 {@link proxyUrl}）。直连失败的最常见原因是 CORS，
 * 而那在浏览器里表现为一个**不带状态码的 TypeError** —— 分不出「网站挂了」和
 * 「网站不让我读」，所以不去分，直接再试一次代理。两跳都挂才算失败，reason 取
 * **最后一跳**的（代理这一跳的错更能说明「连备用路都不通」）。
 *
 * 🔴 例外是 {@link UnusableBytesError}：字节已经到手、只是不能用 —— 当场收手，
 * 报**真正的**原因（见那个类的注释）。
 */
export async function downloadRemoteAsset(
  url: string,
  options: DownloadOptions = {},
): Promise<RemoteAssetDownloadResult> {
  if (!HTTP_URL_RE.test(url)) return { ok: false, reason: '不是 http(s) 地址' };

  const opts = {
    ...options,
    timeoutMs: options.timeoutMs ?? REMOTE_ASSET_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? REMOTE_ASSET_MAX_BYTES,
  };

  let lastReason = '下载失败';
  for (const candidate of [url, proxyUrl(url)]) {
    if (options.signal?.aborted) return { ok: false, reason: '已取消' };
    try {
      return { ok: true, payload: await fetchOnce(candidate, url, opts) };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
      if (err instanceof UnusableBytesError) return { ok: false, reason: lastReason };
    }
  }
  return { ok: false, reason: lastReason };
}

// ═══════════════════════════════════════════════════════════
// 执行
// ═══════════════════════════════════════════════════════════

/** 一次同步的回执 —— 五个计数 + 逐条失败原因（部分成功如实呈现） */
export interface RemoteAssetSyncResult {
  /** 新建的行 */
  downloaded: number;
  /** 原地换了字节的行（地址变了） */
  replaced: number;
  /** 镜像删掉的行 */
  deleted: number;
  /** 地址没变、原样留着的行 */
  kept: number;
  /** 位被用户自己的行占着而让路的声明 */
  skippedUserOwned: number;
  /** 逐条失败（下载 / 落库 / 媒体规则），**绝不影响其余条目** */
  failed: { url: string; reason: string }[];
}

/** {@link runRemoteAssetSync} 的全部外部依赖 —— 一个都不从模块作用域偷偷取 */
export interface RemoteAssetSyncDeps {
  /** 已去重的声明清单 */
  decls: readonly RemoteAssetDecl[];
  /** 当前库里的全部素材行 */
  existing: readonly AssetMetaRecord[];
  /** 落库（元数据 + 字节），生产传 `@engine/database` 的 `saveAsset` */
  saveAsset(meta: AssetMetaRecord, blob: Blob): Promise<unknown>;
  /** 删行（元数据 + 字节），生产传 `@engine/database` 的 `deleteAsset` */
  deleteAsset(id: string): Promise<void>;
  /**
   * **同一个 id 的字节被换掉之后**叫一次。
   *
   * 🔴 这不是可选的清理动作：object URL 是按 id 缓存的，字节换了而 URL 没换，
   * 界面会一直显示旧图且**永远不会自己好**（渲染缝看 id 没变就不重取）。
   */
  onBytesReplaced?(id: string): void;
  fetchImpl?: RemoteAssetFetch;
  /** 字节 → Blob 的注入缝（默认惰性取全局 `Blob`） */
  makeBlob?(bytes: Uint8Array, mime: string): Blob | null;
  /** 默认 `hashMediaBlob`；算不出返回 undefined，**绝不换第二种算法** */
  hashBlob?(blob: Blob): Promise<string | undefined>;
  newId?(): string;
  now?(): number;
  concurrency?: number;
  timeoutMs?: number;
  maxBytes?: number;
  signal?: AbortSignal;
}

/** 字节 → Blob，惰性取全局。拿不到返回 null（调用方计一次失败，不抛） */
function defaultMakeBlob(bytes: Uint8Array, mime: string): Blob | null {
  const Ctor = (globalThis as { Blob?: typeof Blob }).Blob;
  if (!Ctor) return null;
  // `slice()` 复制一份独立缓冲区：直接持视图会把整块底层 buffer 一起常驻
  return new Ctor([bytes.slice().buffer as ArrayBuffer], { type: mime });
}

function defaultNewId(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c && typeof c.randomUUID === 'function') return `asset_${c.randomUUID()}`;
  return `asset_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** 定长工作池 —— worker 自己吞掉全部异常，所以这里不需要 `allSettled` */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const lanes = Math.max(1, Math.min(Math.floor(limit), items.length));
  let cursor = 0;
  await Promise.all(
    Array.from({ length: lanes }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        await worker(items[index]);
      }
    }),
  );
}

/**
 * 执行一次镜像同步。**永不抛**：每一条的失败都被隔离进 `failed`。
 *
 * 顺序是「先下载后删除」，但两段其实**互不影响** —— 删除清单在
 * {@link planRemoteAssetSync} 里就算完了，与网络成败无关（本文件头纪律 1）。
 * 这么排只是让「新图先到位」在观感上更连贯。
 */
export async function runRemoteAssetSync(
  deps: RemoteAssetSyncDeps,
): Promise<RemoteAssetSyncResult> {
  const plan = planRemoteAssetSync(deps.decls, deps.existing);
  const makeBlob = deps.makeBlob ?? defaultMakeBlob;
  const hashBlob = deps.hashBlob ?? hashMediaBlob;
  const newId = deps.newId ?? defaultNewId;
  const now = deps.now ?? Date.now;

  const result: RemoteAssetSyncResult = {
    downloaded: 0,
    replaced: 0,
    deleted: 0,
    kept: plan.kept.length,
    skippedUserOwned: plan.skippedUserOwned.length,
    failed: [],
  };

  const fail = (url: string, reason: string): void => {
    result.failed.push({ url, reason });
  };

  await runWithConcurrency(
    plan.toDownload,
    deps.concurrency ?? REMOTE_ASSET_CONCURRENCY,
    async (item) => {
      if (deps.signal?.aborted) return;
      const { decl, replaces } = item;

      // D7 媒体规则的**省流量的一道**：地址后缀就已经说明它是 mp4 而目标类型是
      // `立绘` 时，没必要先把它下下来再拒。权威的一道在下面（真实 ext）。
      const guessed = extFromUrl(decl.url);
      if (guessed !== undefined && !isMediaAllowed(decl.type, guessed)) {
        fail(decl.url, `${decl.type} 不支持 ${guessed}`);
        return;
      }

      const downloaded = await downloadRemoteAsset(decl.url, {
        ...(deps.fetchImpl !== undefined ? { fetchImpl: deps.fetchImpl } : {}),
        ...(deps.timeoutMs !== undefined ? { timeoutMs: deps.timeoutMs } : {}),
        ...(deps.maxBytes !== undefined ? { maxBytes: deps.maxBytes } : {}),
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      if (!downloaded.ok) {
        // 🔴 失败**只是失败**：既有的那一行原样留着，别的条目照跑（纪律 1）
        fail(decl.url, downloaded.reason);
        return;
      }

      const { bytes, mime, ext } = downloaded.payload;
      // 权威的一道媒体规则闸：真实类型可能与地址后缀不同（代理转码 / 服务器改名）
      if (!isMediaAllowed(decl.type, ext)) {
        fail(decl.url, `${decl.type} 不支持 ${ext}`);
        return;
      }

      const blob = makeBlob(bytes, mime);
      if (!blob) {
        fail(decl.url, '这个环境造不出 Blob');
        return;
      }
      const hash = await hashBlob(blob);
      const stamp = now();

      const meta: AssetMetaRecord =
        replaces !== undefined
          ? { ...replaces, ext, mime, bytes: bytes.length, updatedAt: stamp }
          : {
              id: newId(),
              name: decl.name,
              type: decl.type,
              ext,
              mime,
              bytes: bytes.length,
              createdAt: stamp,
              updatedAt: stamp,
            };
      if (replaces === undefined && decl.variant !== undefined) meta.variant = decl.variant;
      // 🔴 哈希**算不出就把键整个去掉**，不能留着被替换行的旧哈希 —— 那是另一份
      //    字节的指纹，留下来会让去重把新图认成老图。
      if (hash !== undefined) meta.hash = hash;
      else delete meta.hash;
      meta.remote = { url: decl.url, syncedAt: stamp };

      try {
        await deps.saveAsset(meta, blob);
      } catch (err) {
        fail(decl.url, err instanceof Error ? err.message : String(err));
        return;
      }

      if (replaces !== undefined) {
        result.replaced += 1;
        // 换的是**同一个 id** 的字节，缓存里那条 object URL 现在指着旧图
        deps.onBytesReplaced?.(replaces.id);
      } else {
        result.downloaded += 1;
      }
    },
  );

  for (const row of plan.toDelete) {
    if (deps.signal?.aborted) break;
    try {
      await deps.deleteAsset(row.id);
      result.deleted += 1;
      deps.onBytesReplaced?.(row.id);
    } catch (err) {
      fail(row.remote?.url ?? row.id, err instanceof Error ? err.message : String(err));
    }
  }

  return result;
}

/**
 * 五个计数的**唯一**一份措辞 —— toast 与设置页的「上次同步」行共用。
 *
 * 各写一份的下场是两处慢慢说出不同的话（一处改了口径另一处没改），
 * 而用户看到的是「提示说新增 3，面板说新增 0」。
 */
export function formatRemoteSyncCounts(result: RemoteAssetSyncResult): string {
  return [
    `新增 ${result.downloaded}`,
    `更新 ${result.replaced}`,
    `删除 ${result.deleted}`,
    `跳过 ${result.skippedUserOwned}`,
    `失败 ${result.failed.length}`,
  ].join(' · ');
}
