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
 *
 * 🔴 **表用 `Object.create(null)` 造，不是 `{}`**：这张表的键是**响应头**
 * （`Content-Type` 由第三方服务器随便写）。带原型的对象上，一个
 * `Content-Type: constructor` 就能查出 `Object.prototype.constructor` —— 一个函数，
 * 随后被当成扩展名喂给 `normalizeExtension`（`.trim()`）**当场抛**，而这一抛是在
 * 工作池的 worker 里，会把**整次同步**（含其余几十条素材）一起打断，直接违背本模块
 * 「永不抛、逐条隔离」的对外承诺。无原型的表对任何没显式写进去的键都只答 undefined。
 * 本文件另一处按外部输入查表的地方是 `ASSET_MIME_BY_EXTENSION[byUrl]`，那里的 key
 * **已经过 `isAssetExtension` 白名单**（Set 判定，不碰原型链），故无需再改造。
 */
const EXTENSION_BY_MIME: Readonly<Record<string, string>> = (() => {
  const out = Object.create(null) as Record<string, string>;
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
  return dedupeRemoteAssetDecls(
    [...collectWorldBookRemoteAssets(books), ...normalizePackRemoteAssets(packRows)]
      // 🔴 地址闸在**去重之前**：一条指向 127.0.0.1 的声明若先占住了槽位，同一个位上
      //    那条合法的 pack 声明会被「先来先得」挡掉，症状是「装了包却少一张图」。
      //    过不了闸的声明**静默丢弃**（与波 1 里认不出的行同一种处置）。
      .filter((decl) => isSyncableRemoteUrl(decl.url)),
  );
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
  /**
   * 位被**用户的决定**占着，让路（不下载、不覆盖）。两种情形合成一个桶：
   * ①位上坐着一行没有 `remote` 戳的素材（他自己导的）；
   * ②这个位有**墓碑**（他把远程下来的那一行改名/改过/删了，见
   * {@link RemoteAssetSyncDeps.tombstones}）。
   *
   * 合桶是刻意的：两者对用户是同一句话「这个位我自己说了算」，回执上也就该是同一个
   * 数字；拆成两个计数只会让 toast 多一个没人分得清的词。
   */
  skippedUserOwned: RemoteAssetDecl[];
  /** 地址没变，原样留着（零网络） */
  kept: AssetMetaRecord[];
}

/**
 * `(name, type, variant)` 的槽位键。`JSON.stringify` 而非拼接：名字是任意用户字符串，
 * 任何分隔符都可能出现在里面（口径同波 1 的 `dedupeRemoteAssetDecls`）。
 *
 * 🔴 **导出是有理由的**：墓碑（用户删掉的远程位）存在设置里，写入方是 asset-store、
 * 读取方是本模块的计划器 —— 两处必须用**同一个**键函数。各拼各的字符串，症状是
 * 墓碑写下了却永远匹配不上，而那正好长得像「删了又自己回来了」这个 bug 本身。
 */
export function remoteAssetSlotKey(name: string, type: string, variant?: string): string {
  return JSON.stringify([name, type, variant ?? '']);
}

/** 模块内简写 */
const slotKey = remoteAssetSlotKey;

/**
 * 收拢墓碑：**只留下仍被声明覆盖到的那些**。
 *
 * 两件事一起做完：
 * 1. **不让它无限长** —— 每一次改名/删除都会加一条，不回收就是一张只增不减的表。
 * 2. **让「作者真的把这条声明撤了、日后又加回来」能重新开始** —— 那是一条**新的**
 *    声明，玩家当初删的是旧的那一张图。墓碑若永久有效，作者此后再也没法把图送到
 *    这个位上，而他完全无从得知。
 *
 * @param tombstones 现存墓碑键
 * @param decls 本次算出的声明清单
 */
export function pruneRemoteAssetTombstones(
  tombstones: readonly string[],
  decls: readonly RemoteAssetDecl[],
): string[] {
  const live = new Set(decls.map((d) => slotKey(d.name, d.type, d.variant)));
  const out: string[] = [];
  for (const key of tombstones) {
    if (live.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
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
 * | 这个位有**墓碑**（用户动过/删过） | `skippedUserOwned`，用户赢 |
 * | 位上没有行 | 下载 + 新建 |
 * | 位上是**用户的**行（无 `remote` 戳） | `skippedUserOwned`，用户赢 |
 * | 位上是远程行且 `remote.url` **相同** | `kept`，零网络 |
 * | 位上是远程行但地址**变了** | 下载 + 原地换字节（同 id） |
 * | 远程行的位**不在**声明清单里 | `toDelete`（镜像） |
 *
 * @param decls 已去重的声明（{@link collectDesiredRemoteAssets} 的产出）
 * @param existing 当前库里的全部素材行
 * @param tombstones 用户已经把这些位「收归己有」了（键由 {@link remoteAssetSlotKey} 造）
 */
export function planRemoteAssetSync(
  decls: readonly RemoteAssetDecl[],
  existing: readonly AssetMetaRecord[],
  tombstones: readonly string[] = [],
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
  const buried = new Set(tombstones);

  for (const decl of decls) {
    const key = slotKey(decl.name, decl.type, decl.variant);
    // 🔴 墓碑位照样算「被声明覆盖到」：万一这个位上还坐着一行远程行（墓碑与行同时
    //    存在只可能来自更早版本留下的状态），不该反过来被镜像收走 —— 让路的语义是
    //    「不管它」，不是「删掉它」。
    desiredKeys.add(key);
    if (buried.has(key)) {
      // 🔴 用户动过这个位（改名 / 改过 / 删了）→ 从此不再替他管，**连地址都不看**。
      //    没有这一条，删掉的图下次启动会自己回来、改过名的图会被再下一份原件。
      plan.skippedUserOwned.push(decl);
      continue;
    }
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

/** 点分四段的 IPv4 字面量 */
const IPV4_LITERAL_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** 回环 / 私网 / 链路本地的 IPv4 **字面量**（不做任何解析，见 {@link isSyncableRemoteUrl}） */
function isPrivateIpv4(host: string): boolean {
  const m = IPV4_LITERAL_RE.exec(host);
  if (m === null) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (a > 255 || b > 255 || Number(m[3]) > 255 || Number(m[4]) > 255) return false;
  if (a === 0) return true; // 0.0.0.0/8 —— `0.0.0.0` 在多数栈上就是「本机」
  if (a === 127) return true; // 回环
  if (a === 10) return true; // 私网 A
  if (a === 172 && b >= 16 && b <= 31) return true; // 私网 B
  if (a === 192 && b === 168) return true; // 私网 C
  if (a === 169 && b === 254) return true; // 链路本地（云元数据 169.254.169.254 就在这里）
  return false;
}

/** 回环 / ULA / 链路本地的 IPv6 字面量（`URL.hostname` 带方括号） */
function isPrivateIpv6(host: string): boolean {
  const inner = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (!inner.includes(':')) return false;
  const lower = inner.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 链路本地
  if (/^f[cd]/.test(lower)) return true; // fc00::/7 唯一本地
  // 🔴 IPv4 映射地址（`::ffff:127.0.0.1`）**会被 URL 解析器归一成十六进制**
  //    （`::ffff:7f00:1`）—— 只按点分四段找是找不到它的，而那正是绕过这道闸最省事的写法
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mapped !== null) {
    const hi = Number.parseInt(mapped[1], 16);
    const lo = Number.parseInt(mapped[2], 16);
    return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  // 没被归一化的写法（宿主 URL 实现不同）：末段仍是点分四段，按 IPv4 再判一次
  return isPrivateIpv4(lower.slice(lower.lastIndexOf(':') + 1));
}

/**
 * 这个地址能不能进同步 —— **http(s) + 非本机/内网字面量**。
 *
 * 为什么要有这一道：URL 来自第三方写的世界书与内容包，而这条链路是在**玩家的浏览器
 * 里**发请求的。写成 `192.168.x.x` 打的是他家路由器，写成本机回环加个端口打的是他自己
 * 跑着的 ComfyUI —— 那些地方从公网够不着，正因如此它们往往**没有鉴权**。
 * 一份角色卡不该能拿玩家的浏览器当内网探针。
 *
 * 🔴 **只认字面量，不做 DNS 解析**（浏览器里也做不到）：一个解析到 127.0.0.1 的域名
 * 照样能通过这一道，DNS rebinding **明确不在 v1 的防护范围内**。这一道挡的是「顺手
 * 写个内网地址」与「拿卡当扫描器」，不是有备而来的攻击者。
 *
 * 🔴 另一条要一并知道的事实：直连失败时会走 **wsrv.nl 代理**（见 {@link proxyUrl}），
 * 也就是**声明里的 URL 会被披露给第三方图床**。这与工坊封面链是同一条既有先例
 * （`workshop-cover.ts`），此处不另做处置；但正因为有这一跳，内网地址更不该放进来
 * —— 那等于把玩家的内网地址报给外面。
 */
export function isSyncableRemoteUrl(url: string): boolean {
  if (typeof url !== 'string' || !HTTP_URL_RE.test(url)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (host === '') return false;
  // `localhost` 与它的子域（`foo.localhost` 按 RFC 6761 同样解析到本机）
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (isPrivateIpv4(host)) return false;
  if (isPrivateIpv6(host)) return false;
  return true;
}

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

/**
 * 把响应体读成字节，**读到超限就当场掐断**。
 *
 * 为什么不能只 `await res.arrayBuffer()` 再判长度：那句话会把整个响应先**收进内存**
 * 才轮到我们判断。`content-length` 这一关只挡得住诚实的服务器 —— 分块传输根本没有
 * 这个头，而一个撒谎的头（写着 1KB 实际发 2GB）同样穿得过去。上限的意义是保护
 * **全库共享的浏览器配额**（下面 {@link REMOTE_ASSET_MAX_BYTES} 那条注释），
 * 而「先把 2GB 收下来再说它超了」把这个意义整个抵消掉。
 *
 * 能流式读就流式读，读不到 `body`（测试替身 / 老宿主）回落 `arrayBuffer` + 事后判 ——
 * 事后判仍然对，只是省不下那份流量。
 *
 * 超限一律抛 {@link UnusableBytesError}：字节到手了、只是不能用，**换代理再下一遍
 * 只会把同样的流量再花一次**（那个类的注释里点名的就是这一条）。
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooBig = (): never => {
    throw new UnusableBytesError(`超过单张上限（${maxBytes} 字节）`);
  };

  const body = (res as { body?: ReadableStream<Uint8Array> | null }).body;
  const reader =
    body !== null && body !== undefined && typeof body.getReader === 'function'
      ? body.getReader()
      : null;

  if (reader === null) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > maxBytes) tooBig();
    return bytes;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      // 掐断上游，别再为一份已经判死的字节占着连接
      try {
        await reader.cancel();
      } catch {
        /* 掐断失败没有可做的补救 */
      }
      tooBig();
    }
    chunks.push(value);
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

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

    // 权威的一道：没有 content-length（分块传输）或那个头在撒谎时，只有**边读边数**
    // 才拦得住 —— 见 readBodyCapped 的注释
    const bytes = await readBodyCapped(res, options.maxBytes);

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
  // 内网/本机地址在收集期就该被滤掉（见 collectDesiredRemoteAssets），这里再判一次是
  // 因为本函数是**唯一**碰网络的出口 —— 直接调它的路径不该绕过这道闸
  if (!isSyncableRemoteUrl(url)) return { ok: false, reason: '不是可下载的公网地址' };

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
  /**
   * 用户已收归己有的位（键由 {@link remoteAssetSlotKey} 造）。
   *
   * 写入方是 asset-store 的改名/改动/删除三条路径，存在设置里；本模块只读。
   * 缺席 = 一个都没有（老档案）。
   */
  tombstones?: readonly string[];
  /** 落库（元数据 + 字节），生产传 `@engine/database` 的 `saveAsset` */
  saveAsset(meta: AssetMetaRecord, blob: Blob): Promise<unknown>;
  /** 删行（元数据 + 字节），生产传 `@engine/database` 的 `deleteAsset` */
  deleteAsset(id: string): Promise<void>;
  /**
   * **写入前**按槽位回读此刻的行（生产传 Dexie 的即时查询）。缺席 = 不复查。
   *
   * 🔴 存在的理由是一条竞态：计划是拿**下载开始前**那份快照算出来的，而下载要几秒。
   * 玩家完全可以在这几秒里给同一个 `(name,type,variant)` 导入自己的图 —— 那一行按
   * 纪律 2 本该赢，但计划里没有它，于是远程这一份照样写下去（同位两行 / 谁后写谁赢）。
   * 加锁能解决，但一次同步的写入本来就稀疏，**写前回读一次**便宜得多也简单得多。
   */
  lookupSlot?(key: {
    name: string;
    type: AssetMetaRecord['type'];
    variant?: string;
  }): Promise<AssetMetaRecord | undefined>;
  /**
   * **删除前**按 id 回读此刻的行。缺席 = 不复查。
   *
   * 同一条竞态的另一半：镜像删除的候选是「带 `remote` 戳」的行，而玩家可能在这几秒里
   * 改了它的名字（改名会摘掉戳，见 asset-store 的 `claimByUser`）—— 那一刻它已经是
   * **他的**行了，删掉就是删用户数据。
   */
  lookupRow?(id: string): Promise<AssetMetaRecord | undefined>;
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
  const plan = planRemoteAssetSync(deps.decls, deps.existing, deps.tombstones ?? []);
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

      // 🔴 写前复查这个位**此刻**归谁（见 deps.lookupSlot）。计划算完到现在隔着一次
      //    下载，玩家在这几秒里导入的行必须赢 —— 它没进过快照，光靠计划看不见。
      if (deps.lookupSlot !== undefined) {
        const current = await deps.lookupSlot({
          name: decl.name,
          type: decl.type,
          ...(decl.variant !== undefined ? { variant: decl.variant } : {}),
        });
        const mine =
          replaces === undefined
            ? current === undefined // 新建：这个位刚才还空着，现在也该空着
            : current !== undefined && current.id === replaces.id && isRemoteOwned(current);
        if (!mine) {
          // 位已经不归镜像管了（用户导了自己的 / 把这一行改了或删了）→ 让路。
          // 与「快照里就看得见的用户行」是同一件事，故进同一个计数。
          result.skippedUserOwned += 1;
          return;
        }
      }

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
    // 🔴 删前复查：这一行**此刻**还带着 `remote` 戳吗（见 deps.lookupRow）。
    //    戳被摘掉 = 玩家在这几秒里改过它，它已经是他的行了；行整个没了 = 他自己删了。
    //    两种情形都只是「不删」，不计任何数（`deleted` 记的是真的删掉了几行）。
    if (deps.lookupRow !== undefined) {
      const current = await deps.lookupRow(row.id);
      if (current === undefined || !isRemoteOwned(current)) continue;
    }
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
