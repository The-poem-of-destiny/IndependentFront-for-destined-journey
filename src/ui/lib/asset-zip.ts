/**
 * asset-zip.ts — 一键导入/导出的 zip 读写 (Asset System v1)
 *
 * 职责边界: **字节进、字节出**，外加 SHA-256、告警，以及取消与进度播报（§7.6，
 * 因为只有这一层看得见解压的推进）。路由（扩展名 → 素材/音频）、
 * 去重、变体编号一概不在这里 —— 那些属于 `asset-import-plan.ts`（纯函数、同步、
 * 可断言为数据）。本模块存在的唯一理由是它必须碰 fflate、`crypto.subtle` 与
 * `Blob`，而计划器不能碰。
 *
 * 反向 import 契约: 引擎层禁止 import `src/ui/`，所以**生产者 import 消费者的
 * 契约**，不是反过来（§6.2）。本模块因此从引擎取三样东西，一样都不本地复制:
 * - `ASSET_MIME_BY_EXTENSION`（asset-types.ts）+ `AUDIO_MIME_BY_EXTENSION`
 *   （audio-names.ts）—— 两张路由表。这里**只用它们判"这条目有没有可能成为
 *   一行数据"**；判 asset 还是 audio 是计划器的事。
 * - `DecodedEntry` / `ImportManifest` / `ImportWarning`（asset-import-plan.ts）
 *   —— 计划器的输入契约。同一份契约声明两遍，就是它悄悄分叉的开始。
 *
 * 噪音在 `onfile` 就被筛掉，一个字节都不解压（§5.1）: 目录条目 / `__MACOSX` /
 * dotfile / 两张表都不认的扩展名。**这是正确性问题，不只是省事** —— 真实素材包
 * 里常年躺着 PSD 源文件、readme.pdf、预览大图，若让它们参与体积上限，一个 50MB
 * 的 `.psd` 就能把一次 200 个文件的导入整体判死，而它本来就该被"静默忽略"。
 * 于是上限只作用在**可能落库的条目**上，这才让上限有意义。被筛掉的文件名走
 * {@link ReadAssetZipResult.skippedNoise} 返回，计划器照样能报
 * `PlannedSkip.reason: 'unknown-extension'`，只是不用为它们的字节付钱。
 *
 * 浏览器全局惰性引用: `crypto` / `Blob` / `setTimeout` 全部写在函数体内，仅
 * import 本模块不触碰任何全局 —— 对齐 audio-folder.ts / audio-singleton.ts 的
 * 做法，vitest `environment:'node'` 下可直接导入。
 *
 * ─────────────────────────────────────────────────────────────
 * 🔴 已知限制（刻意如此，不要"顺手修"）
 *
 * 1. **文件名编码只能告警，不能纠正。** fflate 内部读了 UTF-8 通用标志位
 *    (bit 11 / 0x800) 并据此选 UTF-8 或 latin1 解码，所以**标志位置位的名字
 *    自动正确**；但 `UnzipFile` 只暴露 `name`，**既不暴露标志位也不暴露原始
 *    文件名字节**。于是未置位的 CP936/GBK 名字到手时已经是 latin1 逐字节
 *    mojibake（`苏婉_头像.png` → `ËÕæñ_Í·Ïñ.png`）。latin1 解码是无损的
 *    字节↔码位映射，理论上能从字符串反推字节再按 GBK 重解 —— 但那是**猜码页**，
 *    猜错就多出一个错名字（D14）。因此: 检出可疑 → 告警 →
 *    **照 mojibake 原样导入**，让用户自己改名。
 *
 * 2. **`readAssetZip` 保证一定 settle，但"包坏了"的判定分两档。**
 *    - 截断的包由 fflate 0.8.3 自己兜: 最后一块 push 时它校验"局部头声明的压缩
 *      长度有没有喂满"（`err(13)`），我们转成 `read-failed`。快且准。
 *    - 真正会挂死的是另一档: push 全都成功、字节数也对，而**异步 worker 一声不响**
 *      （blob worker 被 CSP 拦掉、worker 被杀）。此时 fflate 无错可报。为此加了
 *      **停滞看门狗**: 只在最后一块 push 完、仍有条目未收尾时布防，每收到一次
 *      数据就重置 —— 于是"很慢的 2GB 包"不会误判（它一直在出数据），沉默的
 *      worker 会在 {@link ReadAssetZipOptions.stallTimeoutMs}（默认 15s）后以
 *      `read-failed` 收场。代价: 极端卡顿的 worker 理论上仍可能误判，比让调用方
 *      拿一个永不 settle 的 Promise（挂死的 UI，连错误路径都没有）好。传 `0` 关掉。
 *
 *    只丢了中央目录、局部数据完好的包会**正常读出来** —— 流式解压只依赖局部文件头，
 *    能恢复出数据就没有理由报错。
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §5.1 / §5.2 / §5.4 / §6.1
 */

import { AsyncUnzipInflate, Unzip, zip, type UnzipFile } from 'fflate'
import { ASSET_MIME_BY_EXTENSION } from '@engine/asset-types'
import { AUDIO_MIME_BY_EXTENSION } from '@engine/audio-names'
import type {
  DecodedEntry,
  ImportManifest,
  ImportManifestMeta,
  ImportWarning,
} from '@engine/asset-import-plan'
import { hashMediaBytes, isMediaHashAvailable } from './media-hash'

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/** 单条目解压后上限 —— 10 MB（§5.1） */
export const ASSET_ZIP_MAX_ENTRY_BYTES = 10 * 1024 * 1024

/** 整包解压后上限 —— 2 GB（§5.1） */
export const ASSET_ZIP_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024

/** 清单文件名，仅认 zip 根目录那一份（§5.2） */
export const ASSET_ZIP_MANIFEST_NAME = 'manifest.json'

/**
 * 每次 push 给 fflate 的压缩字节数。
 *
 * 这个数字**就是炸弹防线的粒度**: 上限是在 `ondata` 里累计校验的，而
 * `AsyncUnzipInflate` 的回调走 worker 消息（宏任务），所以我们必须在每次 push
 * 之间让出事件循环，才能在下一块之前收手。一块 128 KB 的 deflate 最坏能膨胀到
 * ~132 MB —— 这就是"中途终止"实际能兜住的内存峰值。调大更快但兜得更松。
 */
const PUSH_CHUNK_BYTES = 128 * 1024

/** 停滞看门狗默认时长 —— 最后一块 push 完之后，多久没有新数据就认为包坏了 */
const DEFAULT_STALL_TIMEOUT_MS = 15_000

/**
 * 两张路由表的扩展名并集 —— **有可能成为一行数据**的文件。
 * 不在这里面的一律在 `onfile` 就筛掉，不解压、不计上限、不返回字节。
 */
const IMPORTABLE_EXTENSIONS = new Set<string>([
  ...Object.keys(ASSET_MIME_BY_EXTENSION),
  ...Object.keys(AUDIO_MIME_BY_EXTENSION),
])

// ═══════════════════════════════════════════════════════════
// 类型
// ═══════════════════════════════════════════════════════════

/**
 * 解码后的单个条目 —— 计划器的输入契约，**声明在引擎侧**，这里只是转出（§6.1）。
 *
 * `path` 在离开本模块时已经**拍平成 basename**: 目录结构一律忽略，
 * `assets/苏婉_头像.png` 与拖进来的 `苏婉_头像.png` 必须表现一致（§5.1）。没有
 * 文件系统要落地，所以嵌套路径需要的是拍平而不是拒绝，zip-slip 防御无从谈起。
 * 计划器再拍一次是幂等空操作。
 */
export type { DecodedEntry }

/**
 * 本模块能产出的告警 —— 从引擎的 `ImportWarning` 里**取子集而非另写一份**。
 *
 * 为什么用 `Extract`: 引擎那边加一个告警成员时，这里要么继续正确、要么在编译期
 * 炸掉（取值写错了会得到 `never`）；平行声明两份字符串联合则会静默走偏。
 * 缺的那个 `'suspect-missing-type'` 属于解析层，本模块判不出来。
 */
export type AssetZipWarning = Extract<
  ImportWarning,
  'hash-unavailable' | 'suspect-filename-encoding'
>

/** 清单元数据 —— 与引擎同一个类型；清单只能**追加**元数据，永不改名改类型（§5.2） */
export type AssetZipManifestMeta = ImportManifestMeta

/**
 * `manifest.json` 的形状 —— 由引擎的 `ImportManifest` 派生，不另写一份。
 *
 * 差别只在**必填性**: `ImportManifest` 两个分区都可缺省（它要容忍用户手写的半份
 * 清单），而 `parseAssetZipManifest` 与 `writeAssetZip` 处理完之后两个分区一定存在。
 * 所以这里用 `Required<>` 收紧 —— 读侧拿到 `manifest.assets` 不必再判空，写侧的
 * 输入仍按 `ImportManifest` 收，宽进严出。分区增减会自动跟随引擎。
 */
export type AssetZipManifest = Required<ImportManifest>

export interface ReadAssetZipResult {
  entries: DecodedEntry[]
  /** 缺失、畸形、或解析不出对象时一律 undefined —— 降级成"没有清单"，绝不抛 */
  manifest?: AssetZipManifest
  /**
   * 被当噪音筛掉的**文件** basename，按 zip 内出现顺序（§5.1）。
   *
   * 包含: dotfile、`__MACOSX` 下的东西、两张路由表都不认的扩展名。
   * **不含目录条目** —— 目录不是文件，报给用户只是噪音里的噪音。
   *
   * 这些条目的字节从未被解压，所以它们既不占内存也不参与体积上限；给出名字是为了
   * 让计划器/摘要照样能说清"跳过了什么"，而不是让用户对着一个变少的库自己猜。
   */
  skippedNoise: string[]
  warnings: AssetZipWarning[]
}

export interface ReadAssetZipOptions {
  /** 单条目解压上限，默认 {@link ASSET_ZIP_MAX_ENTRY_BYTES}。只作用于可导入条目 */
  maxEntryBytes?: number
  /** 整包解压上限，默认 {@link ASSET_ZIP_MAX_TOTAL_BYTES}。只作用于可导入条目 */
  maxTotalBytes?: number
  /**
   * 停滞超时（毫秒），默认 {@link DEFAULT_STALL_TIMEOUT_MS}；`0` 或负数关闭。
   * 见文件头限制 #2 —— 这是截断/损坏 zip 的唯一兜底。
   */
  stallTimeoutMs?: number
  /**
   * 取消信号（§7.6）。中止后以 `code: 'aborted'` 的 {@link AssetZipError} 拒绝，
   * **与真失败区分开** —— 调用方该显示「已取消」而不是弹错误。
   *
   * 检查点复用了上限校验那套管道: 开工前、每块 push 之间、每次 `ondata`、以及
   * 逐条目哈希的间隙。传进来时就已经 aborted 的信号会立刻拒绝，一个字节都不解压。
   */
  signal?: AbortSignal
  /**
   * 进度回调，`(已完成条目数, 已发现的可导入条目数)`。
   *
   * ⚠️ **`total` 会往上长，这是诚实的代价**: zip 的条目总数写在**文件末尾**的中央
   * 目录里，流式解压是从头往后读局部文件头，所以在读完整个包之前"总共几个文件"
   * 根本不可知。与其倒着去扒 EOCD 拼一个看似精确、实则把噪音也算进去、进度条永远
   * 到不了 100% 的分母，这里如实报"发现了几个 / 完成了几个"。收尾时两者相等，且
   * 等于 `entries.length`（根 `manifest.json` 不计 —— 它不是用户要导入的文件）。
   *
   * 想要连续百分比的话，用**压缩字节**而不是条目数会更平滑，但那要另一套口径；
   * v1 只报条目。回调自身抛错会被吞掉，不会连累导入。
   */
  onProgress?: (done: number, total: number) => void
  /**
   * 哈希注入缝（测试用）。返回 undefined 表示"这条算不出"。
   * 不注入时走 `media-hash.ts`（全项目唯一实现，上传路径共用同一份）；
   * `crypto.subtle` 缺失则整批不哈希并报 `hash-unavailable`。
   */
  hash?: (bytes: Uint8Array) => Promise<string | undefined>
}

/** 导出侧的单个条目 —— 名字必须是 basename（带路径会被拍平） */
export interface AssetZipWriteEntry {
  name: string
  bytes: Uint8Array
}

export type AssetZipErrorCode =
  | 'entry-too-large'
  | 'total-too-large'
  | 'duplicate-name'
  | 'invalid-name'
  | 'read-failed'
  /** 调用方主动取消（`options.signal`）—— 刻意与真失败分开，UI 该显示「已取消」而不是报错 */
  | 'aborted'

/**
 * 本模块唯一的错误类型，按 `code` 判别 —— 调用方据此出人话提示，不用去 match 文案。
 * 超限时刻意**抛错而不是静默截断**: 截断出来的图片是坏图，比失败更难查。
 */
export class AssetZipError extends Error {
  readonly code: AssetZipErrorCode
  /** 触发错误的条目路径（体积/命名类错误有，读取失败没有） */
  readonly path?: string
  /** 被越过的上限字节数（体积类错误有） */
  readonly limit?: number

  constructor(code: AssetZipErrorCode, message: string, path?: string, limit?: number) {
    super(message)
    this.name = 'AssetZipError'
    this.code = code
    this.path = path
    this.limit = limit
  }
}

// ═══════════════════════════════════════════════════════════
// 路径工具
// ═══════════════════════════════════════════════════════════

/** 斜杠归一化: 部分 Windows 工具会写反斜杠分隔符 */
function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/** 取 basename（拍平嵌套目录）；纯路径返回空串 */
function basenameOf(path: string): string {
  const norm = normalizeSlashes(path)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? norm : norm.slice(idx + 1)
}

/** 小写扩展名（不含点）；无扩展名返回空串 */
function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf('.')
  return dot > 0 ? basename.slice(dot + 1).toLowerCase() : ''
}

/**
 * 该条目是否为可静默忽略的噪音（§5.1）:
 * 目录条目（尾斜杠）/ `__MACOSX` 任一路径段 / dotfile（含 AppleDouble `._x`）。
 *
 * 判定用**完整 path**（`__MACOSX` 是目录段）与 **basename**（dotfile 是文件名特征），
 * 两个口径都需要，所以这个函数拿原始 path 而不是拍平后的名字。
 *
 * dotfile 只看 **basename**: `.hidden/苏婉_头像.png` 会被导入。目录名在拍平之后
 * 已经没有意义，拿它当理由丢掉一个正常媒体文件才是真的数据损失 —— `__MACOSX`
 * 是唯一的例外，因为那整棵目录树里没有一个字节是用户想要的。
 */
function isNoiseEntry(path: string): boolean {
  const norm = normalizeSlashes(path)
  if (norm.endsWith('/')) return true
  const segments = norm.split('/')
  if (segments.some((seg) => seg.toLowerCase() === '__macosx')) return true
  const base = segments[segments.length - 1]
  if (!base) return true
  return base.startsWith('.')
}

/** 是否是 zip **根目录**那份 manifest.json（嵌套的同名文件不算） */
function isRootManifest(path: string): boolean {
  const norm = normalizeSlashes(path).replace(/^\.\//, '')
  return norm.toLowerCase() === ASSET_ZIP_MANIFEST_NAME
}

// ═══════════════════════════════════════════════════════════
// 文件名编码可疑性
// ═══════════════════════════════════════════════════════════

/**
 * 连续 ≥2 个 U+0080–U+00FF 字符。
 *
 * 为什么是"连续 2 个": GB2312 常用区把每个汉字编成两个 ≥0x80 的字节，latin1
 * 逐字节解码后就成了成对的高位字符。而真·Latin-1 名字里的重音字母（`café`、
 * `Bär`）是**单个**高位字符，不会误报。
 */
const HIGH_BYTE_RUN = /[\u0080-\u00ff]{2,}/

/**
 * 名字看起来是不是解码错了。
 *
 * 两种迹象: ①U+FFFD 替换字符（标志位置位但字节不是合法 UTF-8） ②latin1 高位字符
 * 连片（标志位未置位的 CP936/GBK）。
 *
 * 启发式，会漏: 单个 GBK 字符且尾字节落在 ASCII 区（如 0x81 0x40）只产生一个
 * 高位字符，检不出来。漏报只是少一条告警，文件照样导入，代价可接受。
 */
function isSuspectFilename(name: string): boolean {
  return name.includes('\ufffd') || HIGH_BYTE_RUN.test(name)
}

// ═══════════════════════════════════════════════════════════
// 输入归一化
// ═══════════════════════════════════════════════════════════

interface BlobLike {
  arrayBuffer: () => Promise<ArrayBuffer>
}

function isBlobLike(input: unknown): input is BlobLike {
  return (
    typeof input === 'object' &&
    input !== null &&
    typeof (input as BlobLike).arrayBuffer === 'function'
  )
}

/**
 * File / Blob / Uint8Array → Uint8Array。
 *
 * 刻意不用 `instanceof Blob` —— node 下 `Blob` 未必存在，鸭子类型判 `arrayBuffer`
 * 才能让本模块在 `environment:'node'` 里照样跑。
 */
async function toBytes(input: File | Blob | Uint8Array): Promise<Uint8Array> {
  if (input instanceof Uint8Array) return input
  if (isBlobLike(input)) return new Uint8Array(await input.arrayBuffer())
  throw new AssetZipError('read-failed', '无法读取输入：既不是 Uint8Array 也不是 Blob')
}

function concatChunks(chunks: readonly Uint8Array[], size: number): Uint8Array {
  const out = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

// ═══════════════════════════════════════════════════════════
// 清单解析
// ═══════════════════════════════════════════════════════════

function decodeUtf8(bytes: Uint8Array): string {
  const Ctor = (globalThis as { TextDecoder?: new (label?: string) => { decode: (b: Uint8Array) => string } })
    .TextDecoder
  if (Ctor) return new Ctor('utf-8').decode(bytes)
  // 无 TextDecoder 的极端环境: 逐字节兜底，只求不抛
  let out = ''
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i])
  return out
}

function encodeUtf8(text: string): Uint8Array {
  const Ctor = (globalThis as { TextEncoder?: new () => { encode: (s: string) => Uint8Array } }).TextEncoder
  if (Ctor) return new Ctor().encode(text)
  const out = new Uint8Array(text.length)
  for (let i = 0; i < text.length; i += 1) out[i] = text.charCodeAt(i) & 0xff
  return out
}

/** 只留下清单允许携带的三个字段；其余键（含 name / type）一律丢弃 */
function sanitizeMeta(raw: unknown): ImportManifestMeta | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const src = raw as Record<string, unknown>
  const meta: ImportManifestMeta = {}
  if (Array.isArray(src.tags)) {
    const tags = src.tags.filter((t): t is string => typeof t === 'string')
    if (tags.length) meta.tags = tags
  }
  if (typeof src.credit === 'string') meta.credit = src.credit
  if (typeof src.license === 'string') meta.license = src.license
  return Object.keys(meta).length ? meta : undefined
}

/**
 * 把一个字典分区规整成 `basename → meta`。
 *
 * 键拍平成 basename（与条目口径一致），**先到先得**不覆盖 —— 同 basename 的两个
 * 键谁赢必须与对象枚举顺序无关地稳定。
 */
function sanitizeSection(raw: unknown): Record<string, ImportManifestMeta> {
  const out: Record<string, ImportManifestMeta> = {}
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const name = basenameOf(key)
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue
    const meta = sanitizeMeta(value)
    if (meta) out[name] = meta
  }
  return out
}

/**
 * 防御式解析清单。**任何畸形都降级成 undefined，绝不抛** —— 一份坏 manifest
 * 不该毁掉一整包素材。清单能做的只有"追加元数据"，改名与改类型无从表达:
 * 输出形状里根本没有 name / type 字段。
 */
export function parseAssetZipManifest(bytes: Uint8Array): AssetZipManifest | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(decodeUtf8(bytes))
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const src = parsed as Record<string, unknown>
  return {
    assets: sanitizeSection(src.assets),
    audio: sanitizeSection(src.audio),
  }
}

// ═══════════════════════════════════════════════════════════
// 读: 流式解压 + 中途终止
// ═══════════════════════════════════════════════════════════

interface RawEntry {
  /** 原始 zip 路径（未拍平）—— 供 manifest 判根、噪音判段 */
  path: string
  bytes: Uint8Array
}

interface InflateResult {
  entries: RawEntry[]
  /** 在 onfile 就被筛掉的**文件** basename（不含目录条目），按出现顺序 */
  skippedNoise: string[]
}

interface InflateConfig {
  maxEntryBytes: number
  maxTotalBytes: number
  stallTimeoutMs: number
  signal?: AbortSignal
  onProgress?: (done: number, total: number) => void
}

/**
 * 这条目值得解压吗 —— `onfile` 里的路由闸门，在任何字节流动之前决定（§5.1）。
 *
 * 根 `manifest.json` **必须放行**: 它的扩展名不在任何路由表里，但我们要消费它。
 */
function shouldInflate(path: string): boolean {
  if (isNoiseEntry(path)) return false
  if (isRootManifest(path)) return true
  return IMPORTABLE_EXTENSIONS.has(extensionOf(basenameOf(path)))
}

function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })
}

/** 统一的取消错误 —— 只有一处构造，`code` 不会写歪 */
function abortError(): AssetZipError {
  return new AssetZipError('aborted', '导入已取消')
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortError()
}

/**
 * 流式解压。
 *
 * 为什么不用 `unzip` / `unzipSync`: 一次性 API **先把全部解压完再返回**，事后
 * 校验上限时炸弹早已把内存填满。所以走 `Unzip` + `AsyncUnzipInflate`，在每个文件的
 * `ondata` 里累计字节数，一旦越限立刻 `terminate()` 并停止 push（§5.1）。
 *
 * 三道防线:
 * 0. `onfile` 里的路由闸门 —— 噪音与不认的扩展名连 `start()` 都不调，它们既不
 *    占内存也**不参与体积上限**（见文件头"噪音在 onfile 就被筛掉"）。
 * 1. 再看局部文件头声明的 `originalSize` —— 诚实的炸弹（头里就写着 4GB）在
 *    **解压一个字节之前**就被挡掉，零内存代价。
 * 2. 头撒谎的对抗式炸弹靠 `ondata` 累计兜住，延迟上界是一个 push 块的膨胀量
 *    （见 {@link PUSH_CHUNK_BYTES}）。
 *
 * 另有停滞看门狗兜截断/损坏的包（文件头限制 #2），以及 `signal` 主动取消（§7.6）——
 * 取消**复用越限那条终止路径**，不另开一套控制流: 都是置 `aborted` → terminate →
 * 丢缓冲 → 停止 push → reject，只是错误码不同。
 */
function inflateStreaming(source: Uint8Array, cfg: InflateConfig): Promise<InflateResult> {
  const { maxEntryBytes, maxTotalBytes, stallTimeoutMs, signal, onProgress } = cfg
  return new Promise<InflateResult>((resolve, reject) => {
    const entries: RawEntry[] = []
    const skippedNoise: string[] = []
    const live: UnzipFile[] = []
    /** 每个在飞条目的分片数组 —— 取消时要把它们清空，别让已解压的字节赖着不走 */
    const liveBuffers: Uint8Array[][] = []
    let totalBytes = 0
    let pending = 0
    let discovered = 0
    let completed = 0
    let pushDone = false
    let aborted = false
    let watchdog: ReturnType<typeof setTimeout> | undefined

    const clearWatchdog = (): void => {
      if (watchdog !== undefined) {
        clearTimeout(watchdog)
        watchdog = undefined
      }
    }

    const onSignalAbort = (): void => abort(abortError())

    const detachSignal = (): void => {
      signal?.removeEventListener('abort', onSignalAbort)
    }

    /** 回调抛错不该连累导入 —— 进度只是播报，不是控制流 */
    const reportProgress = (): void => {
      if (!onProgress) return
      try {
        onProgress(completed, discovered)
      } catch {
        // 故意吞掉
      }
    }

    /**
     * 只在"push 已经全部喂完、仍有条目没收尾"时布防，且每来一次数据就重置 ——
     * 于是慢包（一直在出数据）不会误判，截断包（再也不出数据）会被判死。
     */
    const armWatchdog = (): void => {
      if (aborted || stallTimeoutMs <= 0 || !pushDone || pending === 0) return
      clearWatchdog()
      watchdog = setTimeout(() => {
        if (aborted || pending === 0) return
        abort(
          new AssetZipError(
            'read-failed',
            `压缩包数据不完整：还有 ${pending} 个条目的数据流没有结束，压缩包可能被截断或损坏`,
          ),
        )
      }, stallTimeoutMs)
    }

    /**
     * 唯一的终止路径 —— 越限、解压出错、看门狗、主动取消全走这里。
     * 顺序要紧: 先置旗（后续回调立刻变哑）→ 摘计时器与监听 → 收 worker → 丢缓冲 → reject。
     */
    const abort = (error: Error): void => {
      if (aborted) return
      aborted = true
      clearWatchdog()
      detachSignal()
      for (const file of live) {
        try {
          file.terminate()
        } catch {
          // terminate 只是尽力回收 worker，失败不影响我们已经放弃这批数据
        }
      }
      // 放掉已经解压出来的字节: 取消一个 2GB 的包不该让内存留到下次 GC 才回落
      for (const chunks of liveBuffers) chunks.length = 0
      liveBuffers.length = 0
      entries.length = 0
      reject(error)
    }

    const settle = (): void => {
      if (aborted || !pushDone) return
      if (pending > 0) {
        armWatchdog()
        return
      }
      clearWatchdog()
      detachSignal()
      resolve({ entries, skippedNoise })
    }

    const unzipper = new Unzip((file) => {
      if (aborted) return
      if (!shouldInflate(file.name)) {
        // 不 start()，一个字节都不解压。目录条目不进汇报名单（不是文件）
        if (!normalizeSlashes(file.name).endsWith('/')) {
          const base = basenameOf(file.name)
          if (base) skippedNoise.push(base)
        }
        return
      }

      if (typeof file.originalSize === 'number' && file.originalSize > maxEntryBytes) {
        abort(
          new AssetZipError(
            'entry-too-large',
            `压缩包内 ${file.name} 解压后 ${file.originalSize} 字节，超过单文件上限 ${maxEntryBytes} 字节`,
            file.name,
            maxEntryBytes,
          ),
        )
        return
      }

      pending += 1
      live.push(file)
      const chunks: Uint8Array[] = []
      liveBuffers.push(chunks)
      let size = 0
      // 根清单不算进度: 它不是用户要导入的文件，算进去会让终值比 entries.length 多一
      const countsForProgress = !isRootManifest(file.name)
      if (countsForProgress) {
        discovered += 1
        reportProgress()
      }

      file.ondata = (err, data, final) => {
        if (aborted) return
        if (signal?.aborted) {
          abort(abortError())
          return
        }
        if (err) {
          abort(new AssetZipError('read-failed', `解压 ${file.name} 失败：${err.message}`, file.name))
          return
        }
        if (data && data.length) {
          size += data.length
          totalBytes += data.length
          if (size > maxEntryBytes) {
            abort(
              new AssetZipError(
                'entry-too-large',
                `压缩包内 ${file.name} 解压后超过单文件上限 ${maxEntryBytes} 字节`,
                file.name,
                maxEntryBytes,
              ),
            )
            return
          }
          if (totalBytes > maxTotalBytes) {
            abort(
              new AssetZipError(
                'total-too-large',
                `压缩包解压后超过总上限 ${maxTotalBytes} 字节`,
                file.name,
                maxTotalBytes,
              ),
            )
            return
          }
          chunks.push(data)
          armWatchdog() // 有进展就重置停滞计时，慢包不该被误判成坏包
        }
        if (final) {
          entries.push({ path: file.name, bytes: concatChunks(chunks, size) })
          pending -= 1
          if (countsForProgress) {
            completed += 1
            reportProgress()
          }
          settle()
        }
      }
      file.start()
    })
    // compression 0（stored）由 UnzipPassThrough 默认兜住，只需补 deflate
    unzipper.register(AsyncUnzipInflate)

    // 传进来就已经取消的信号: 一个字节都不解压，直接收场
    if (signal?.aborted) {
      aborted = true
      reject(abortError())
      return
    }
    signal?.addEventListener('abort', onSignalAbort)

    void (async () => {
      try {
        for (let offset = 0; offset < source.length; offset += PUSH_CHUNK_BYTES) {
          if (aborted) return
          if (signal?.aborted) {
            abort(abortError())
            return
          }
          const end = Math.min(offset + PUSH_CHUNK_BYTES, source.length)
          unzipper.push(source.subarray(offset, end), end >= source.length)
          // 让出宏任务: AsyncUnzipInflate 的 ondata 走 worker 消息，
          // 只让微任务的话上限校验永远轮不到，"中途终止"就成了空话
          await yieldToEventLoop()
        }
        if (aborted) return
        pushDone = true
        settle()
      } catch (error) {
        abort(
          error instanceof AssetZipError
            ? error
            : new AssetZipError(
                'read-failed',
                `压缩包解析失败：${error instanceof Error ? error.message : String(error)}`,
              ),
        )
      }
    })()
  })
}

/**
 * 读一个导入包 → `DecodedEntry[]` + 可选清单 + 告警。
 *
 * 行为要点:
 * - 目录结构**拍平**，条目只按 basename 论（§5.1）
 * - `__MACOSX` / dotfile / 目录条目 / 不认的扩展名连解压都不做，只以 basename
 *   出现在 `skippedNoise` 里 —— 它们**不可能让导入失败**
 * - 体积上限只作用于可导入条目，**中途终止**，越限抛 {@link AssetZipError}，绝不静默截断
 * - 逐条目 SHA-256；`crypto.subtle` 缺失 → 不出 hash + 告警
 * - 文件名编码可疑 → 告警，但**照原样导入**，绝不猜码页转码
 * - 截断/损坏的包由停滞看门狗以 `read-failed` 收场，不会挂死
 * - `options.signal` 可随时取消，以 `code: 'aborted'` 拒绝（§7.6）
 * - `options.onProgress` 播报条目进度（`total` 会往上长，见该字段说明）
 */
export async function readAssetZip(
  input: File | Blob | Uint8Array,
  options: ReadAssetZipOptions = {},
): Promise<ReadAssetZipResult> {
  const { signal } = options

  throwIfAborted(signal)

  const source = await toBytes(input)
  // toBytes 对 Blob 是异步的，这中间用户完全可能已经点了取消
  throwIfAborted(signal)
  if (source.length === 0) {
    throw new AssetZipError('read-failed', '压缩包为空，读不出任何条目')
  }

  const raw = await inflateStreaming(source, {
    maxEntryBytes: options.maxEntryBytes ?? ASSET_ZIP_MAX_ENTRY_BYTES,
    maxTotalBytes: options.maxTotalBytes ?? ASSET_ZIP_MAX_TOTAL_BYTES,
    stallTimeoutMs: options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS,
    signal,
    onProgress: options.onProgress,
  })

  // ── 抽出根清单 ──
  let manifest: AssetZipManifest | undefined
  const media: RawEntry[] = []
  for (const entry of raw.entries) {
    if (manifest === undefined && isRootManifest(entry.path)) {
      // 解析失败也照样吃掉这条: 它是一份没读懂的清单，不是待导入的素材
      manifest = parseAssetZipManifest(entry.bytes)
      continue
    }
    media.push(entry)
  }

  // ── 拍平 + 告警 ──
  const warnings = new Set<AssetZipWarning>()
  const entries: DecodedEntry[] = []
  for (const entry of media) {
    const path = basenameOf(entry.path)
    if (!path) continue
    if (isSuspectFilename(path)) warnings.add('suspect-filename-encoding')
    entries.push({ path, bytes: entry.bytes })
  }

  // ── 逐条目哈希（异步，所以只能在这一层做；计划器是纯同步的，D18）──
  // 哈希实现只有 media-hash.ts 一份（上传路径也用它）；这里只决定"要不要算"
  const digest = options.hash ?? (isMediaHashAvailable() ? hashMediaBytes : undefined)
  if (!digest) {
    warnings.add('hash-unavailable')
  } else {
    // 到这里的条目全都通过了 onfile 的路由闸门，不必再筛一遍扩展名
    for (const entry of entries) {
      // 40 个 5MB 文件的 SHA-256 是实打实的耗时，取消必须在这儿也生效
      throwIfAborted(signal)
      try {
        const hash = await digest(entry.bytes)
        if (hash) entry.hash = hash
        else warnings.add('hash-unavailable')
      } catch {
        // 一条算不出就整批放弃: 半套哈希会让去重范围变得不可解释
        warnings.add('hash-unavailable')
        break
      }
    }
  }

  return { entries, manifest, skippedNoise: raw.skippedNoise, warnings: [...warnings] }
}

// ═══════════════════════════════════════════════════════════
// 写: 导出包
// ═══════════════════════════════════════════════════════════

interface BlobCtorLike {
  new (parts: BlobPart[], options?: { type?: string }): Blob
}

/**
 * 打一个**导入侧原样接受**的导出包（§5.4）。
 *
 * 压缩策略: 媒体一律 `level: 0`（stored）—— PNG/JPEG/MP4 早就压过了，再 deflate
 * 白烧 CPU 换不到体积；清单是文本，给它 level 6。stored 走
 * `UnzipPassThrough`，读侧同样认。
 *
 * 名字一律拍平成 basename；重名**抛错而不是后者覆盖前者** —— zip 的目录是个字典，
 * 静默覆盖就是静默丢文件。
 *
 * 清单按引擎的 `ImportManifest` 收（分区可缺省），落盘时补成两个分区都在的形状 ——
 * 宽进严出，读侧于是不必判空。
 */
export async function writeAssetZip(
  entries: readonly AssetZipWriteEntry[],
  manifest?: ImportManifest,
): Promise<Blob> {
  const payload: Record<string, [Uint8Array, { level: 0 | 6 }]> = {}

  for (const entry of entries) {
    const name = basenameOf(entry.name).trim()
    if (!name) {
      throw new AssetZipError('invalid-name', `导出条目缺少有效文件名：${entry.name}`, entry.name)
    }
    if (Object.prototype.hasOwnProperty.call(payload, name)) {
      throw new AssetZipError('duplicate-name', `导出条目文件名重复：${name}`, name)
    }
    payload[name] = [entry.bytes, { level: 0 }]
  }

  if (manifest) {
    if (Object.prototype.hasOwnProperty.call(payload, ASSET_ZIP_MANIFEST_NAME)) {
      throw new AssetZipError(
        'duplicate-name',
        `导出条目占用了保留名 ${ASSET_ZIP_MANIFEST_NAME}`,
        ASSET_ZIP_MANIFEST_NAME,
      )
    }
    const normalized: AssetZipManifest = {
      assets: manifest.assets ?? {},
      audio: manifest.audio ?? {},
    }
    payload[ASSET_ZIP_MANIFEST_NAME] = [
      encodeUtf8(JSON.stringify(normalized, null, 2)),
      { level: 6 },
    ]
  }

  const zipped = await new Promise<Uint8Array>((resolve, reject) => {
    zip(payload, {}, (err, data) => {
      if (err) reject(new AssetZipError('read-failed', `打包失败：${err.message}`))
      else resolve(data)
    })
  })

  const BlobCtor = (globalThis as { Blob?: BlobCtorLike }).Blob
  if (!BlobCtor) {
    throw new AssetZipError('read-failed', '当前环境没有 Blob，无法产出导出包')
  }
  // 复制进独立缓冲区: Blob 直接持 fflate 的视图会连带整块底层 buffer
  return new BlobCtor([zipped.slice().buffer as ArrayBuffer], { type: 'application/zip' })
}
