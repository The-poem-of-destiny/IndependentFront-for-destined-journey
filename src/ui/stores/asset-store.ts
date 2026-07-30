/**
 * asset-store.ts — 素材库 Pinia 薄壳 (Asset System v1)
 *
 * 设计: docs/planning/2026-07-29-asset-management-system-design.md §4.5 / §5.4 / §7.3 / §7.4 / §7.6
 *
 * 职责: **执行器**。一次导入的全部决策（路由 / 媒体规则 / 命名不变式 / 碰撞编号 /
 * 哈希去重 / 清单合并）都已经由 `planImport` 这个纯同步函数定完了；本模块只做那件
 * 蠢而明显的事 —— 照单写行、刷新、报一次账（§6.1 结尾）。
 *
 * 于是这里**没有任何自己的判断逻辑**，取而代之的是四条纪律:
 *
 * 1. **错误处理照抄音频那套已发货的模式**（§7.6）: 逐条 try/catch、单条失败不中断、
 *    结束后**一条**汇总、如实呈现部分成功。那套模式是音频系统 2026-07-27 审查的
 *    **修复结果**（③⑧⑬），复用它是免费的，重新发明等于把那次审查再走一遍。
 *    批量结果直接复用 {@link AudioBatchResult} 的形状，不另发明第二个批量回执类型（§6.3）。
 * 2. **分配器只有一套**。改名与设为主图撞位时要编号，编号策略必须与导入器**逐位一致**
 *    （max+1 / 换号不嵌套 / 单空格加整数），所以这里**不重写分配器**，而是直接调
 *    引擎导出的 `allocateVariantSlot` —— 一份规则，三个入口（§5.3 "One collision
 *    rule, two entry points"）。⚠️ 早期版本是把目标行格式化成**文件名**再喂给
 *    `planImport` 反推，那条路是错的: 文件名是有损载体，名字里带 `/` 的行会被
 *    `basenameOf` 拍平到另一个组，一个组里能坐出两个基图（详见 allocateSlot）。
 * 3. **导出范围窄于"库里的一切"**（D17）: 素材全导，音频**只导 `source: 'blob'`**。
 *    内置曲目带着 `license: PLACEHOLDER-PENDING-REVIEW`，打进一个可分享的 zip 就是
 *    **再分发占位授权素材** —— 正是仓库 2026-07-28 把那 57 首移出版本库时修掉的错误；
 *    `'file'` 的字节在用户自己的文件夹里，需要活的授权、还可能 `missing`。
 *    **摘要必须把每一项排除都说出来**，否则"导出的包比屏幕上的库小"读起来就是数据丢失。
 * 4. **绝不持久化 object URL**（§7.5）: 调用方存逻辑键，渲染时再解析。
 * 5. **两个导入入口，一条管线**: `importZip` 与 `importFiles` 只在"字节从哪来"上
 *    不同，汇合于 `executeImport`。第二条并行管线就是第二套路由与第二套去重。
 *
 * 边界:
 * - 字节读取走注入缝: 本模块持有**一份** {@link createAssetUrlCache}，它的 `loadBlob`
 *   就是 `getAssetBlob` —— 对齐 audio-singleton.ts 的 `BlobResolver` 单层间接（D6）。
 *   日后加磁盘层，换的是这一行。
 * - 浏览器全局（`navigator` / `Blob` / `URL`）**惰性写在函数体内**，测试可替身。
 * - 音频半边写完之后调**音频 store 的公开动作**刷库，绝不伸手进它的内部状态。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { ASSET_TYPES } from '@engine/types'
import type { AssetMetaRecord, AssetType, AudioTrack } from '@engine/types'
import {
  getAssets,
  saveAsset,
  deleteAsset as dbDeleteAsset,
  getAssetBlob,
  getAudioTracks,
  saveAudioTrack,
  getAudioBlob,
  getDatabase,
} from '@engine/database'
import { allocateVariantSlot, planImport } from '@engine/asset-import-plan'
import type {
  DecodedEntry,
  ExistingRows,
  ImportManifest,
  ImportPlan,
  ImportWarning,
} from '@engine/asset-import-plan'
import { formatAssetFilename, violatesNamingInvariant } from '@engine/asset-filename'
import { isMediaAllowed } from '@engine/asset-types'
import { hashMediaBlob } from '../lib/media-hash'
import { AUDIO_MIME_BY_EXTENSION } from '@engine/audio-names'
import {
  readAssetZip,
  writeAssetZip,
  AssetZipError,
  type AssetZipErrorCode,
  type AssetZipManifest,
  type AssetZipWriteEntry,
  type ReadAssetZipOptions,
} from '../lib/asset-zip'
import { createAssetUrlCache, type AssetUrlCache } from '../lib/asset-url'
import { useAudioStore } from './audio-store'
import type { AudioBatchResult } from './audio-store'
import { useUIStore } from './ui-store'

// ═══════════════════════════════════════════════════════════
// 常量
// ═══════════════════════════════════════════════════════════

/**
 * 传给 `readAssetZip` 的停滞超时。
 *
 * 不传就是默认 15s；显式传是为了让"一个死掉的解码 worker 不该把界面永久挂住"
 * 这件事在**调用点**可见（§7.6：不可取消的转圈是用户中途强刷的原因）。
 * 给得比默认宽一点，因为一个 200 文件的包在慢机器上确实会喘。
 */
export const ASSET_IMPORT_STALL_TIMEOUT_MS = 25_000

/** 导出包的建议文件名前缀；真正的下载动作归 UI */
const EXPORT_FILENAME_PREFIX = '素材包'

// ═══════════════════════════════════════════════════════════
// 对外形状
// ═══════════════════════════════════════════════════════════

/**
 * 按名字分组的视图（§7.3 「按角色」）。
 *
 * 分组键是**原始 `name`，严格 `===`，不做任何归一化**（D2）—— 音频那套
 * `normalizeAudioName` 是音频自己的规矩，素材刻意不采用。
 */
export interface AssetGroup {
  /** 原始名字，即分组键 */
  name: string
  /** 组内全部行，按 类型顺序 → 基图优先 → 变体名 排序 */
  rows: AssetMetaRecord[]
  total: number
  /**
   * 带变体的行数 —— 让**累积的重复可见**而不是藏起来（D11 的成本，§7.3 明写要显示）。
   * 永不覆盖的代价就是同一个角色下会慢慢堆出 `_2`、`_3`，界面得说出来。
   */
  variantCount: number
  /** 有基图（无变体行）的类型 */
  baseTypes: AssetType[]
  /** 组里出现过、但**没有基图**的类型 —— §8 的「无主图」，删基图后的常态 */
  baselessTypes: AssetType[]
}

/** 一次导入的完整回执；`message` 就是那条唯一的汇总提示 */
export interface AssetImportSummary {
  /**
   * 每一个压缩包都读成功了吗。**混合导入时是"与"** —— 一个包读不出来就是 false，
   * 但那**不掩盖**另一半成功导入的内容（计数照样是真的）。
   * 具体的读取失败原因在 {@link readErrors} 里，一条也不丢。
   */
  read: boolean
  /**
   * 读取失败的人话原因（每个读不出来的压缩包一条）。
   *
   * 与 `read` 分开存在是为了让"致命读取失败"与"读得好好的、只是什么都没变"**可区分**:
   * 前者要说出哪个包坏了，后者只该说"全部跳过"。混合导入时两种结局可以同时发生。
   *
   * **可选**是为了让别处手写的回执字面量（测试替身、UI 的桩数据）不因为新增字段而
   * 编译不过 —— 本 store 产出的回执一定带着它；读的时候按 `?? []` 兜。
   */
  readErrors?: string[]
  /** 浏览器配额耗尽而中止（不是个案，后面基本也没戏）。可选同上 */
  quotaHit?: boolean
  /**
   * 用户中途取消了（`cancelImport()`）。
   *
   * **取消不是失败**: 取消前已经写进去的行**如实留着**（与部分成功同一套纪律），
   * 所以这条要与 `failed` 分开报 —— 把用户自己按的取消说成错误，是在制造焦虑。
   */
  cancelled: boolean
  assetsAdded: number
  audioAdded: number
  duplicatesSkipped: number
  /** 自动改号的条数（素材改号 + 音频改名之和，同计划器口径） */
  renumbered: number
  namingConflicts: number
  /** 立绘上的 mp4（D7 媒体规则） */
  mediaRuleSkipped: number
  /** 两张路由表都不认的 + `__MACOSX`/dotfile + 解压前就被筛掉的，合计 */
  ignored: number
  /** 计划里有、但写库没成功的条数 */
  failed: number
  warnings: ImportWarning[]
  message: string
}

/** 一次导出的完整回执 */
export interface AssetExportResult {
  /** 无可导出内容或打包失败时为 null */
  blob: Blob | null
  /** 建议下载名；真正的下载归 UI */
  filename: string
  assets: number
  audio: number
  /** 内置曲目（占位授权，不可再分发 —— D17） */
  skippedBuiltin: number
  /** 本机音乐文件夹曲目（字节不是本应用的） */
  skippedFile: number
  /** 导出名撞车而让路的条数（存量重名行的兜底，不抛错） */
  skippedCollision: number
  /** 元数据还在、字节读不到的条数 */
  failed: number
  message: string
}

/**
 * 改名 / 设为主图的结论 —— **可判别**，因为 UI 要就地区分"被不变式拒了"
 * 和"写库失败了"（§7.4：拒绝要 inline 提示）。
 */
export type AssetMutationOutcome =
  | 'ok'
  | 'not-found'
  /** name / variant 里含类型 token（D16）—— 拒收，不修补 */
  | 'naming-invariant'
  /** 立绘 + mp4（D7） */
  | 'media-rule'
  /**
   * 名字/变体进不了 zip 条目名（D19）: 含 `/` `\` 会在导出包里变成路径、
   * 再导入时被拍平；以 `.` 开头会被当 dotfile 噪音丢掉。两者都过不了往返。
   */
  | 'unrepresentable-name'
  /** 已经是基图，无事可做 */
  | 'already-base'
  | 'failed'

export interface AssetMutationResult {
  outcome: AssetMutationOutcome
  /** 落库后的行（`outcome === 'ok'` 时有） */
  row?: AssetMetaRecord
  /**
   * 目标位被占，自动编号到了别处时的**原变体**（§5.3）。
   * 本来无变体（从 base 位被挤走）时是空串 `''`，与"没改号"的 undefined 区分。
   */
  renumberedFrom?: string
}

/** 浏览器配额（§4.5 的配额条） */
export interface AssetStorageEstimate {
  used: number
  quota: number
  pct: number
}

// ═══════════════════════════════════════════════════════════
// 无状态小工具
// ═══════════════════════════════════════════════════════════

function newId(prefix: string): string {
  const c = (globalThis as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

interface BlobCtorLike {
  new (parts: BlobPart[], options?: { type?: string }): Blob
}

/**
 * 字节 → Blob，**惰性取全局**。拿不到 `Blob` 返回 null（调用方计入 failed），
 * 不抛 —— 一个没有 Blob 的环境不该让导入路径炸在半途。
 *
 * `slice()` 复制一份独立缓冲区: 直接持解压视图会连带整块底层 buffer 常驻。
 */
function makeBlob(bytes: Uint8Array, mime: string): Blob | null {
  const Ctor = (globalThis as { Blob?: BlobCtorLike }).Blob
  if (!Ctor) return null
  return new Ctor([bytes.slice().buffer as ArrayBuffer], { type: mime })
}

/**
 * 是否是「浏览器存储配额耗尽」。与 audio-store 同判据（标准浏览器抛
 * `QuotaExceededError`，老 Firefox 用 `NS_ERROR_DOM_QUOTA_REACHED`）。
 *
 * 这四行刻意在本地重写而不是从 audio-store 导出: 那边没导出它，而本任务的范围
 * 栅栏禁止改 audio-store。两处判据必须一致，改一处记得改另一处。
 */
function isQuotaError(e: unknown): boolean {
  const name = (e as { name?: unknown } | null)?.name
  return name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED'
}

/** 提示的唯一出口；无 Pinia 上下文（测试 / 早期启动）时不该因为一条提示炸掉调用方 */
function notify(message: string, type: 'info' | 'error'): void {
  try {
    useUIStore().toast(message, type)
  } catch {
    // 静默：提示失败不能影响主流程的结果
  }
}

/** MIME → 扩展名的反查表（导出音频要给文件名一个扩展名，路由表是唯一来源） */
const AUDIO_EXTENSION_BY_MIME: Readonly<Record<string, string>> = (() => {
  const out: Record<string, string> = {}
  for (const [ext, mime] of Object.entries(AUDIO_MIME_BY_EXTENSION)) {
    // 先到先得: `audio/ogg` 反查稳定得到 `ogg` 而不是 `oga`
    if (!Object.prototype.hasOwnProperty.call(out, mime)) out[mime] = ext
  }
  return out
})()

/**
 * 给一条待导出的音轨挑扩展名。
 *
 * 音轨名**不带扩展名**（上传路径 `stripExt` 过），而导入器只按扩展名路由，
 * 所以导出时必须补回一个。顺序: `mimeType` 反查 → Blob 自带的 type 反查 →
 * `mp3` 兜底。兜错也不影响往返身份（去重看 名字 + 哈希，不看 mime），
 * 只是重新导入后 `mimeType` 会变成路由表里的那个值。
 */
function audioExportExtension(track: AudioTrack, blob: Blob): string {
  const fromTrack = track.mimeType ? AUDIO_EXTENSION_BY_MIME[track.mimeType] : undefined
  if (fromTrack) return fromTrack
  const fromBlob = blob.type ? AUDIO_EXTENSION_BY_MIME[blob.type] : undefined
  if (fromBlob) return fromBlob
  return 'mp3'
}

/**
 * 这些 MIME 都表示 zip —— 但**扩展名优先**，MIME 只是兜底（见 {@link isZipFile}）。
 */
const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
  'multipart/x-zip',
])

/**
 * 这个文件是压缩包吗 —— 混合拖拽时的路由依据。
 *
 * ⚠️ **先看扩展名，MIME 只兜底**，这不是随手写的顺序: Windows 上 `.zip` 常被报成
 * `application/x-zip-compressed`，某些情况下 `file.type` 干脆是**空字符串**。
 * 只信 MIME 会让 Windows 用户拖进来的包被当成"未知扩展名"静默忽略。
 *
 * （这份平台知识原本住在 UI 的 `isZipFile` 里；"什么算压缩包"是路由决策，
 * 跟着导入管线走才不会两边各有一份。）
 */
export function isZipFile(file: File): boolean {
  if (/\.zip$/i.test(file.name)) return true
  return ZIP_MIME_TYPES.has(file.type)
}

/**
 * 名字/变体能不能原样活在一个 zip 条目名里（D19，§5.4 往返的前提）。
 *
 * 两类致命字符:
 * - `/` 与 `\` —— 在包里就是**目录分隔符**，导入侧 `basenameOf` 会拍平，
 *   `圣殿/内庭_头像.png` 回来就成了 `内庭_头像.png`，行被静默改名。
 * - 名字**开头**的 `.` —— 导入侧按 dotfile 当噪音丢掉，整条素材消失。
 *   变体开头的 `.` 无害（basename 以名字开头），所以不拦。
 *
 * 空白**不在此列**: 前后空格在 zip 条目名里可表示，D2 要求名字保持原始。
 */
function violatesZipEntryName(name: string, variant?: string): boolean {
  const hasSeparator = (v: string): boolean => v.includes('/') || v.includes('\\')
  if (hasSeparator(name)) return true
  if (variant !== undefined && variant !== '' && hasSeparator(variant)) return true
  return name.startsWith('.')
}

/** 行排序: 类型顺序 → 基图优先 → 变体名 */
function compareRows(a: AssetMetaRecord, b: AssetMetaRecord): number {
  const ta = ASSET_TYPES.indexOf(a.type)
  const tb = ASSET_TYPES.indexOf(b.type)
  if (ta !== tb) return ta - tb
  const va = a.variant ?? ''
  const vb = b.variant ?? ''
  if (va === '' && vb !== '') return -1
  if (vb === '' && va !== '') return 1
  if (va !== vb) return va.localeCompare(vb, 'zh-Hans-CN')
  return a.createdAt - b.createdAt
}

/** 造一行的副本并覆盖变体位；**无变体时把键整个去掉**，不留 `variant: undefined` */
function withVariant(row: AssetMetaRecord, variant?: string): AssetMetaRecord {
  const next: AssetMetaRecord = { ...row, updatedAt: Date.now() }
  if (variant === undefined || variant === '') delete next.variant
  else next.variant = variant
  return next
}

// ═══════════════════════════════════════════════════════════
// Store
// ═══════════════════════════════════════════════════════════

export const useAssetStore = defineStore('asset', () => {
  // ── 库 ────────────────────────────────────────────────
  const assets = ref<AssetMetaRecord[]>([])
  const loading = ref(false)
  const importing = ref(false)
  const exporting = ref(false)

  /**
   * 导入进度，仅在 `importing` 期间有意义（§7.6）。
   *
   * 两段口径不同，靠 {@link progressPhase} 区分:
   * - `'read'` 解压段 —— `progressTotal` 恒为 **0**，即"没有分母"，只能显示已完成条目数。
   *   asset-zip 的 `total` 会随发现新条目往上长，拿它当分母会让百分比**倒退**。
   * - `'write'` 写库段 —— 计划已定，`progressTotal` 是固定的行数，可以显示真百分比。
   *
   * 所以 UI 的规矩是: **`progressTotal <= 0` 就别算百分比**（也别除它）。
   */
  const progressDone = ref(0)
  const progressTotal = ref(0)
  const progressPhase = ref<'idle' | 'read' | 'write'>('idle')

  /**
   * `navigator.storage.persist()` 的结果: null = 还没问过。
   *
   * 它**可以被拒**，而拒绝不是错误 —— 记下来给配额条如实显示，绝不阻塞导入（§4.5）。
   */
  const storagePersisted = ref<boolean | null>(null)

  let initialized = false
  /** 只在**首次导入成功**后请求一次持久化，不在启动期（§4.5） */
  let persistRequested = false
  /**
   * 在飞导入的取消闸。不进响应式状态 —— 它是宿主对象，只被动作读写
   * （同 audio-store 对目录句柄的处理）。
   */
  let abortController: AbortController | null = null

  /**
   * 取消在飞的导入（UI 的取消按钮绑的就是这个名字）。
   *
   * 一个不可取消的转圈是用户中途强刷页面的原因，而强刷发生在写库中途才是真的糟糕
   * （§7.6）。取消**不回滚**已写入的行: 部分成功如实留着，与逐条 try/catch 那套纪律
   * 是同一条 —— 回滚反而会把用户已经拿到的东西再拿走。
   */
  function cancelImport(): void {
    abortController?.abort()
  }

  // ── 视图 ──────────────────────────────────────────────

  /** 全部素材（§7.3 「全部素材」），含名字匹配不到任何角色的行 */
  const flat = computed<AssetMetaRecord[]>(() => [...assets.value].sort(
    (a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || compareRows(a, b),
  ))

  /** 按名字分组（§7.3 「按角色」）—— 严格 `===` 分组，不归一化（D2） */
  const groups = computed<AssetGroup[]>(() => {
    const byName = new Map<string, AssetMetaRecord[]>()
    for (const row of assets.value) {
      const list = byName.get(row.name)
      if (list) list.push(row)
      else byName.set(row.name, [row])
    }
    const out: AssetGroup[] = []
    for (const [name, rows] of byName) {
      const sorted = [...rows].sort(compareRows)
      const baseTypes: AssetType[] = []
      const baselessTypes: AssetType[] = []
      for (const type of ASSET_TYPES) {
        const inType = sorted.filter((r) => r.type === type)
        if (inType.length === 0) continue
        if (inType.some((r) => r.variant === undefined || r.variant === '')) baseTypes.push(type)
        else baselessTypes.push(type)
      }
      let variantCount = 0
      for (const r of sorted) if (r.variant !== undefined && r.variant !== '') variantCount += 1
      out.push({ name, rows: sorted, total: sorted.length, variantCount, baseTypes, baselessTypes })
    }
    out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    return out
  })

  function findAsset(id: string): AssetMetaRecord | undefined {
    return assets.value.find((a) => a.id === id)
  }

  /** 同 `(name, type)` 下的全部行 —— 分配与设为主图都按这个作用域算 */
  function rowsInGroup(name: string, type: AssetType): AssetMetaRecord[] {
    return assets.value.filter((a) => a.name === name && a.type === type)
  }

  // ═══ 库加载 ═══════════════════════════════════════════

  async function refreshAssets(): Promise<void> {
    try {
      assets.value = await getAssets()
    } catch {
      // IndexedDB 不可用 → 空库，界面照样能开（对齐 audio-store 的降级）
      assets.value = []
    }
  }

  /** 幂等；分区 onMounted 里调 */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true
    loading.value = true
    try {
      await refreshAssets()
    } finally {
      loading.value = false
    }
  }

  // ═══ object URL（LRU + 逐出即撤销，§7.5）═══════════════

  /**
   * 本 store 持有的**唯一**一份缓存。`loadBlob` 就是 `getAssetBlob` —— 单层间接，
   * 对齐 audio-singleton.ts 的 `BlobResolver`（D6）: 日后字节搬去磁盘层，改的是这一行。
   */
  let urlCache: AssetUrlCache | null = null
  function cache(): AssetUrlCache {
    if (!urlCache) urlCache = createAssetUrlCache({ loadBlob: getAssetBlob })
    return urlCache
  }

  /**
   * 取素材的 object URL；字节缺失返回 null。
   *
   * ⚠️ **绝不持久化返回值**（§7.5）: 存逻辑键（name/type/variant），渲染时再来取。
   * object URL 只在当前会话有效，刷新/逐出/`revokeAllUrls()` 之后立刻是死链。
   */
  async function assetUrl(id: string): Promise<string | null> {
    return cache().get(id)
  }

  /** 同步窥视已铸造的 URL，不触发加载 */
  function peekAssetUrl(id: string): string | null {
    return cache().peek(id)
  }

  function releaseAssetUrl(id: string): void {
    cache().release(id)
  }

  /** 分区 unmount 时调：撤销全部存活 URL */
  function revokeAllUrls(): void {
    urlCache?.revokeAll()
  }

  // ═══ 配额与持久化（§4.5）═══════════════════════════════

  /**
   * 浏览器存储用量。与 settings-store 的 `getStorageUsage()` 同一套
   * `navigator.storage.estimate()` 口径（那边是设置页的通用配额条，这边要和
   * `storagePersisted` 一起喂素材分区的配额条），全局惰性引用，不支持就返回 null。
   */
  async function getStorageEstimate(): Promise<AssetStorageEstimate | null> {
    try {
      const nav = (globalThis as { navigator?: Navigator }).navigator
      if (!nav?.storage || typeof nav.storage.estimate !== 'function') return null
      const est = await nav.storage.estimate()
      const used = est.usage ?? 0
      const quota = est.quota ?? 0
      return { used, quota, pct: quota > 0 ? (used / quota) * 100 : 0 }
    } catch {
      return null
    }
  }

  /**
   * 请求持久化存储 —— **首次导入成功之后**才问，不在启动期（§4.5）。
   *
   * Chromium 默认是 best-effort 存储，磁盘吃紧时**整库**可被驱逐，而本项目今天
   * 没有任何地方请求过持久化 —— 一次驱逐会连存档和音频一起带走。
   * **可以被拒**，拒绝只是记录下来给配额条，绝不阻塞导入。
   */
  async function requestPersistence(): Promise<boolean | null> {
    try {
      const nav = (globalThis as { navigator?: Navigator }).navigator
      if (!nav?.storage || typeof nav.storage.persist !== 'function') return null
      if (typeof nav.storage.persisted === 'function' && (await nav.storage.persisted())) {
        storagePersisted.value = true
        return true
      }
      const granted = await nav.storage.persist()
      storagePersisted.value = granted
      return granted
    } catch {
      // 浏览器不支持 / 抛了 —— 记成"不知道"，不写 false（那是"被拒"的意思）
      return null
    }
  }

  // ═══ 分配器复用（§5.3）═══════════════════════════════

  interface SlotAllocation {
    ok: boolean
    variant?: string
    renumberedFrom?: string
    reason?: AssetMutationOutcome
  }

  /**
   * 给一个目标位算终态变体 —— 借导入器**同一个**分配器
   * （{@link allocateVariantSlot}），不另写一份 max+1。
   *
   * 🔴 曾经的做法是把目标行 `formatAssetFilename` 成文件名再喂给 `planImport`
   * 反推。**那是错的**: 文件名是有损载体，计划器的 `basenameOf` 会在最后一个
   * 分隔符处拍平，于是名字里带 `/`（`圣殿/内庭`）的行被算到另一个 `(name, type)`
   * 组上 —— 两行都以为 base 位空着，一个组里坐出**两个基图**，D11 当场破功；
   * 名字以 `.` 开头还会被判成 dotfile 噪音，表现成莫名其妙的 `'failed'`。
   * 复用分配器是对的，用文件名当载体是错的 —— 现在只复用后者的槽位计算。
   *
   * 合法性三关由这里自己把: D16 命名不变式 / D19 zip 条目名可承载性 / D7 媒体规则。
   * 之前它们是从 `planImport` 的拒收理由里白拿的，现在换成显式判断 —— 反而更清楚
   * 谁在管什么。
   */
  function allocateSlot(
    target: { name: string; type: AssetType; variant?: string; ext: string },
    excludeIds: readonly string[] = [],
  ): SlotAllocation {
    const gate = checkNameGates(target)
    if (gate !== null) return { ok: false, reason: gate }

    const skip = new Set(excludeIds)
    const rows = assets.value.filter((a) => !skip.has(a.id))
    const allocated = allocateVariantSlot(target.name, target.type, target.variant, rows)

    const out: SlotAllocation = { ok: true }
    if (allocated.variant !== undefined) out.variant = allocated.variant
    if (allocated.renumberedFrom !== undefined) out.renumberedFrom = allocated.renumberedFrom
    return out
  }

  /**
   * 这一行**能不能存在** —— 与"它该占哪个槽位"分开的三道闸门；过不了就拒，不修补。
   *
   * - **D16 命名不变式**: name 的任何下划线段、variant 的任何段等于类型 token。
   *   没有它，`(苏婉, 头像, 变体=立绘)` 一次导出再导入就静默变成
   *   `(苏婉_头像, 立绘, 无变体)`。
   * - **D19 zip 条目名可承载性**（新）: 名字/变体带 `/` `\` 会在导出包里变成**路径**，
   *   再导入时被拍平成别的名字；名字以 `.` 开头在导入侧算 dotfile 噪音、整条被丢掉。
   *   两者都过不了 §5.4 的往返，所以在**唯一能产生它们的入口**（改名）拦住 ——
   *   导入侧拍平 basename 在先，本来就造不出这两种名字。
   *   ⚠️ **空白照原样留着**: 前后空格在 zip 条目名里是可表示的，D2 要求名字保持原始，
   *   trim 掉等于替用户改名。
   * - **D7 媒体规则**: mp4 只能落在不需要 alpha 的类型上。
   *
   * 归属说明: 这三条里前两条本该与 `violatesNamingInvariant` 并排住在
   * asset-filename.ts（引擎层，两个入口共用）。D19 暂居此处是因为本次任务的范围
   * 栅栏不含那个文件；等有人拥有它时，整块搬过去即可，调用点不变。
   */
  function checkNameGates(target: {
    name: string
    type: AssetType
    variant?: string
    ext: string
  }): AssetMutationOutcome | null {
    const { name, type, variant, ext } = target
    if (name === '') return 'naming-invariant'
    if (violatesNamingInvariant(name, variant)) return 'naming-invariant'
    if (violatesZipEntryName(name, variant)) return 'unrepresentable-name'
    if (!isMediaAllowed(type, ext)) return 'media-rule'
    return null
  }

  // ═══ 导入（一键，两个入口共用一份实现 —— D9）═══════════

  /** `ExistingRows` 的音频半边: 只取计划器真正会看的字段 */
  function toExistingAudio(tracks: readonly AudioTrack[]): ExistingRows['audio'] {
    return tracks.map((t) => ({ id: t.id, name: t.name, source: t.source, hash: t.hash }))
  }

  function emptySummary(): AssetImportSummary {
    return {
      read: false,
      readErrors: [],
      quotaHit: false,
      cancelled: false,
      assetsAdded: 0,
      audioAdded: 0,
      duplicatesSkipped: 0,
      renumbered: 0,
      namingConflicts: 0,
      mediaRuleSkipped: 0,
      ignored: 0,
      failed: 0,
      warnings: [],
      message: '',
    }
  }

  /** 计划的定量部分 → 摘要（写库结果由调用侧补） */
  function summarizePlan(plan: ImportPlan, preFilteredNoise: number): AssetImportSummary {
    let mediaRuleSkipped = 0
    let unknownExtension = 0
    for (const skip of plan.skips) {
      if (skip.reason === 'mp4-on-立绘') mediaRuleSkipped += 1
      else if (skip.reason === 'unknown-extension') unknownExtension += 1
    }
    return {
      read: true,
      readErrors: [],
      quotaHit: false,
      cancelled: false,
      assetsAdded: 0,
      audioAdded: 0,
      duplicatesSkipped: plan.summary.duplicatesSkipped,
      renumbered: plan.summary.renumbered,
      namingConflicts: plan.summary.namingConflicts,
      mediaRuleSkipped,
      // 解压前就被筛掉的条目（PSD / readme / __MACOSX）计划器根本没见过，
      // 得把 asset-zip 报回来的那份并进来，否则摘要会漏说"忽略了什么"
      ignored: plan.summary.noise + unknownExtension + preFilteredNoise,
      failed: 0,
      warnings: [...plan.warnings],
      message: '',
    }
  }

  const WARNING_TEXT: Readonly<Record<ImportWarning, string>> = {
    'hash-unavailable': '哈希不可用，已跳过去重',
    'suspect-filename-encoding': '文件名编码可疑，建议用支持 UTF-8 的压缩工具重新打包',
    'suspect-missing-type': '部分文件名疑似漏写类型（如 `_头像`），请检查它们是否落到了预期的角色下',
  }

  /**
   * 解压阶段的进度 —— **刻意不设分母**（`progressTotal` 留 0，phase 报 `'read'`）。
   *
   * 为什么: `onProgress` 的 `total` 是"**到目前为止发现的**可导入条目数"，它会往上长
   * （zip 的条目总数写在文件末尾的中央目录里，流式解压从头读局部头，读完之前根本不可知；
   * asset-zip 刻意不去倒扒 EOCD 拼一个把噪音也算进去的假分母）。于是 `done/total`
   * 这个百分比**会往回跳** —— 一个会倒退的进度条读起来就是坏了。
   *
   * 所以解压段按"不确定态"处理（UI 显示「正在读取… n」，没有百分比），真百分比留给
   * 写库段 —— 那时计划已经定了，`progressTotal` 是个诚实的固定值。
   * 另一条路（按压缩字节算连续百分比）也成立，但那要求两段用两套口径，
   * 而两段共用同一对计数器时，"读取段没有分母"是更小、更诚实的改动。
   */
  function onReadProgress(done: number, _total: number): void {
    // _total 刻意丢弃 —— 见上：它会长，拿它做分母就是让进度条倒退
    progressTotal.value = 0
    progressDone.value = done
    progressPhase.value = 'read'
  }

  /**
   * 取消的错误码。用 `AssetZipErrorCode` 标注**不是装饰**: asset-zip 那边若把这个
   * 成员改名或删掉，本行会在编译期炸掉，而不是让取消静默退化成一个红色错误提示。
   */
  const ABORTED_CODE: AssetZipErrorCode = 'aborted'

  /** 这个错误是"用户取消"而不是"包坏了"吗 */
  function isAbortError(e: unknown, signal?: AbortSignal): boolean {
    if (signal?.aborted) return true
    if (e instanceof AssetZipError && e.code === ABORTED_CODE) return true
    // 非 asset-zip 抛的中止（DOMException）也认，取消永远不该被报成失败
    return (e as { name?: unknown } | null)?.name === 'AbortError'
  }

  /** 唯一那条汇总文案（§7.2）—— 两个入口、两个半边，都只播报这一行 */
  function buildImportMessage(s: AssetImportSummary): string {
    const parts = [`素材 ${s.assetsAdded} 新增`, `音频 ${s.audioAdded} 新增`]
    if (s.duplicatesSkipped > 0) parts.push(`跳过 ${s.duplicatesSkipped} 重复`)
    if (s.renumbered > 0) parts.push(`编号 ${s.renumbered}`)
    if (s.namingConflicts > 0) parts.push(`命名冲突 ${s.namingConflicts}`)
    if (s.mediaRuleSkipped > 0) parts.push(`立绘不支持 mp4 ${s.mediaRuleSkipped}`)
    if (s.ignored > 0) parts.push(`忽略无关文件 ${s.ignored}`)
    if (s.failed > 0) parts.push(`失败 ${s.failed}`)
    let msg = parts.join(' · ')
    for (const w of s.warnings) msg += `；${WARNING_TEXT[w]}`
    return msg
  }

  /**
   * "重新导入一遍"这句话在**算不出哈希**的机器上是假的 —— 去重靠哈希，
   * `hash-unavailable` 时再导一遍会把已有的全部当成新文件、自动编号成 `_2`、`_3`。
   * 这个代码库对"如实呈现部分成功"是认真的，话术就得跟着真相走。
   */
  function reimportHint(s: AssetImportSummary): string {
    return s.warnings.includes('hash-unavailable')
      ? '注意：这台机器上算不出文件哈希（多半是用明文 http 访问的），' +
          '再导一次**不会**识别出重复，已有的会被再导入一份并自动编号。'
      : '重新导入同一个包即可补齐 —— 已有的会被识别成重复而跳过。'
  }

  /**
   * **一次导入 = 一条提示**（§7.2）。所有入口都在这里收口，包括混合导入合并之后的那份。
   *
   * 分支顺序即优先级: 取消 → 配额满 → 有写入失败 → 有新增 → 什么都没变。
   * 读取失败（坏压缩包）**不是一个独立分支**，而是附在上面任意一条后面 ——
   * "一个包读不出来 + 十张图导进来了"必须同时说出来: 只说前者是在谎报数据丢失，
   * 只说后者是在藏起一个真实的失败。
   */
  function notifyImportSummary(s: AssetImportSummary): AssetImportSummary {
    const counts = buildImportMessage(s)
    const changed = s.assetsAdded + s.audioAdded > 0
    const readErrors = s.readErrors ?? []
    // 读取失败的尾巴，附在任何分支后面
    const readTail =
      readErrors.length > 0
        ? `另有 ${readErrors.length} 个文件读取失败：${readErrors.join('；')}`
        : ''

    let text: string
    let type: 'info' | 'error'

    if (s.cancelled) {
      text =
        `已取消导入：${counts}。取消前写入的内容都留在库里（不是坏数据）。` +
        reimportHint(s) +
        (readTail ? ` ${readTail}` : '')
      type = 'info'
    } else if (s.quotaHit === true) {
      text =
        `${counts}。浏览器存储空间已满，剩下的文件没有继续导入。` +
        '已导入的内容都已落库并保留；素材字节存在浏览器配额里，几百 MB 的素材包很容易撑满。' +
        (readTail ? ` ${readTail}` : '')
      type = 'error'
    } else if (s.failed > 0) {
      text =
        `${counts}。有 ${s.failed} 个文件没能写入（已写入 ${s.assetsAdded + s.audioAdded} 个）。` +
        `已写入的都完整保留，没写入的库里一个字节都没留下。${reimportHint(s)}` +
        (readTail ? ` ${readTail}` : '')
      type = 'error'
    } else if (changed) {
      // 有东西进来了就不是"导入失败" —— 但坏包照样说清楚，不藏
      text = readTail ? `${counts}。${readTail}` : counts
      type = readTail ? 'error' : 'info'
    } else if (readErrors.length > 0) {
      // 纯失败: 什么都没进来，只有坏包
      text = `导入失败：${readErrors.join('；')}`
      type = 'error'
    } else {
      text = `${counts}（全部跳过，库没有变化）`
      type = 'info'
    }

    // `message` **就是**用户看到的那句话 —— 回执与提示不该是两套说法
    s.message = text
    notify(text, type)
    return s
  }

  /**
   * 把若干半边的回执并成一份 —— 混合导入（若干 zip + 一堆散文件）只该产出一份回执。
   *
   * 诚实规则:
   * - `read` 取**与**，但读取失败的原因逐条留在 `readErrors` 里，绝不让它盖住
   *   另一半真的导进来的东西；
   * - 计数逐项相加，`cancelled` / `quotaHit` 取或；
   * - 告警**取并集**（按首次出现顺序去重）—— 一台算不出哈希的机器，
   *   两个半边都会报 `hash-unavailable`，用户只需要看到一次。
   */
  function mergeSummaries(parts: readonly AssetImportSummary[]): AssetImportSummary {
    const out = emptySummary()
    if (parts.length === 0) {
      out.read = true
      return out
    }
    out.read = parts.every((p) => p.read)
    const warnings: ImportWarning[] = []
    const readErrors: string[] = []
    for (const p of parts) {
      readErrors.push(...(p.readErrors ?? []))
      out.cancelled = out.cancelled || p.cancelled
      out.quotaHit = out.quotaHit === true || p.quotaHit === true
      out.assetsAdded += p.assetsAdded
      out.audioAdded += p.audioAdded
      out.duplicatesSkipped += p.duplicatesSkipped
      out.renumbered += p.renumbered
      out.namingConflicts += p.namingConflicts
      out.mediaRuleSkipped += p.mediaRuleSkipped
      out.ignored += p.ignored
      out.failed += p.failed
      for (const w of p.warnings) if (!warnings.includes(w)) warnings.push(w)
    }
    out.warnings = warnings
    out.readErrors = readErrors
    out.message = buildImportMessage(out)
    return out
  }

  /** 在飞导入的互斥闸 —— 两个入口共用一份，返回非空就表示"别开第二个" */
  function rejectIfBusy(): AssetImportSummary | null {
    if (!importing.value) return null
    const busy = emptySummary()
    busy.message = '已有一个导入正在进行，请等它结束。'
    notify(busy.message, 'error')
    return busy
  }

  /**
   * 导入的**公共下半程**: 攒基准行 → `planImport` → 照单写行 → 刷新 → 一条摘要。
   *
   * zip 与单文件两个入口在这里汇合（§7.3 承诺的单文件导入不该长出第二条管线）。
   * 于是路由（`.mp3` 落音频）、D16 拒收、哈希去重、变体编号、署名合并、部分成功回执
   * 全部**白拿** —— 上半程的差别只有"字节从哪来、清单从哪来"。
   */
  async function executeImport(
    entries: readonly DecodedEntry[],
    manifest: ImportManifest | undefined,
    preFilteredNoise: number,
    signal?: AbortSignal,
    progress: { base?: number; indeterminate?: boolean } = {},
  ): Promise<AssetImportSummary> {
    // ── 攒基准行 ──
    await refreshAssets()
    let audioRows: AudioTrack[] = []
    try {
      audioRows = await getAudioTracks()
    } catch {
      // 音频表读不到 → 当作没有音频行。去重会失效、撞名会编号，但不该整包失败
      audioRows = []
    }
    const existing: ExistingRows = {
      assets: assets.value.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        variant: a.variant,
        hash: a.hash,
      })),
      audio: toExistingAudio(audioRows),
    }

    // ── 定计划（全部决策都在这一行里发生）──
    const plan = planImport(entries, existing, manifest)
    const summary = summarizePlan(plan, preFilteredNoise)
    // 进度进入第二段（写库）: 单批时这里有诚实的固定分母，可以显示真百分比。
    // **混合导入是不确定态**（`indeterminate`）: 后面还有几批、每批几行要等各自规划完
    // 才知道，分母会往上长 —— 那正是会让百分比倒退的情形，所以干脆不给分母。
    // 同样先写计数、最后翻 phase（见 importZip 开头那段注释）
    const progressBase = progress.base ?? 0
    progressDone.value = progressBase
    progressTotal.value = progress.indeterminate
      ? 0
      : progressBase + plan.assets.length + plan.audio.length
    progressPhase.value = 'write'

    let quotaHit = false
    const now = Date.now()

    // ── 素材半边 ──
    for (const planned of plan.assets) {
      // 取消: 已经写进去的行**如实留着**，只是不再往下写（写库是大包里耗时的那一半）
      if (signal?.aborted) {
        summary.cancelled = true
        break
      }
      try {
        const blob = makeBlob(planned.entry.bytes, planned.mime)
        if (!blob) {
          summary.failed += 1
          continue
        }
        const meta: AssetMetaRecord = {
          id: newId('asset'),
          name: planned.name,
          type: planned.type,
          ext: planned.ext,
          mime: planned.mime,
          bytes: planned.entry.bytes.length,
          createdAt: now,
          updatedAt: now,
        }
        if (planned.variant !== undefined) meta.variant = planned.variant
        if (planned.entry.hash !== undefined) meta.hash = planned.entry.hash
        if (planned.credit !== undefined) meta.credit = planned.credit
        if (planned.license !== undefined) meta.license = planned.license
        await saveAsset(meta, blob)
        summary.assetsAdded += 1
      } catch (e) {
        summary.failed += 1
        if (isQuotaError(e)) {
          quotaHit = true
          break
        }
      } finally {
        progressDone.value += 1
      }
    }

    // ── 音频半边（同一个包、同一次导入 —— §7.2）──
    if (!quotaHit && !summary.cancelled) {
      for (const planned of plan.audio) {
        if (signal?.aborted) {
          summary.cancelled = true
          break
        }
        try {
          const blob = makeBlob(planned.entry.bytes, planned.mime)
          if (!blob) {
            summary.failed += 1
            continue
          }
          const track: AudioTrack = {
            id: newId('audio'),
            name: planned.name,
            kind: 'music',
            // 从 zip 进来的字节只能落 IndexedDB：'file' 要目录句柄，'builtin' 是内置清单
            source: 'blob',
            mimeType: planned.mime,
            size: planned.entry.bytes.length,
            tags: [...planned.tags],
            createdAt: now,
            updatedAt: now,
          }
          if (planned.entry.hash !== undefined) track.hash = planned.entry.hash
          // 署名照原样落库（AudioTrack 新增的 credit / license 两列，非索引属性，
          // 无需升版）。清单存在的全部理由就是让文件名承载不了的署名活下来（D10）——
          // 导入时丢掉它，等于让这条链条断在最后一步。
          if (planned.credit !== undefined) track.credit = planned.credit
          if (planned.license !== undefined) track.license = planned.license
          await saveAudioTrack(track, blob)
          summary.audioAdded += 1
        } catch (e) {
          summary.failed += 1
          if (isQuotaError(e)) {
            quotaHit = true
            break
          }
        } finally {
          progressDone.value += 1
        }
      }
    }

    // ── 刷新两边的库 ──
    await refreshAssets()
    if (summary.audioAdded > 0) {
      try {
        // 音频半边写完必须让音频分区看见 —— 调它的**公开动作**，不碰它的内部状态
        await useAudioStore().refreshTracks()
      } catch {
        // 无 Pinia 上下文 / 音频 store 起不来: 素材半边已经落库，不该因此报失败
      }
    }

    // ── 首次导入成功才请求持久化（§4.5），永不阻塞 ──
    if (!persistRequested && summary.assetsAdded + summary.audioAdded > 0) {
      persistRequested = true
      await requestPersistence()
    }

    summary.quotaHit = quotaHit
    summary.message = buildImportMessage(summary)
    // ⚠️ **不在这里 notify**: 一次导入只该有一条提示（§7.2），而"一次导入"可能由
    // 多个半边组成（混合拖拽 = 若干 zip + 一堆散文件）。提示统一由
    // {@link notifyImportSummary} 在最外层发一次。
    return summary
  }

  /**
   * 读一个压缩包并执行 —— **半边**，不发提示。
   *
   * 独立成函数是为了让 `importZip` 与 `importAny` 用同一段逻辑: 一个包读坏了，
   * 它只是这次导入里失败的**一半**，不该由它决定整次导入怎么播报。
   */
  async function runZipHalf(
    file: File | Blob | Uint8Array,
    signal: AbortSignal | undefined,
    progress: { base?: number; indeterminate?: boolean } = {},
  ): Promise<AssetImportSummary> {
    let zipResult: Awaited<ReturnType<typeof readAssetZip>>
    try {
      const options: ReadAssetZipOptions = {
        stallTimeoutMs: ASSET_IMPORT_STALL_TIMEOUT_MS,
        onProgress: onReadProgress,
      }
      if (signal) options.signal = signal
      zipResult = await readAssetZip(file, options)
    } catch (e) {
      const summary = emptySummary()
      // 取消是用户自己按的，不是失败 —— 此时这一半还一个字节都没写
      if (isAbortError(e, signal)) {
        summary.read = true
        summary.cancelled = true
        return summary
      }
      summary.readErrors = [describeZipError(e)]
      return summary
    }

    if (signal?.aborted) {
      const summary = emptySummary()
      summary.read = true
      summary.cancelled = true
      return summary
    }

    return executeImport(
      zipResult.entries,
      zipResult.manifest,
      zipResult.skippedNoise.length,
      signal,
      progress,
    )
  }

  /**
   * 把一批 `File` 解码成计划器的输入并执行 —— **半边**，不发提示。
   *
   * 读不出字节的文件既不进计划、也不算失败，差额并进"忽略"（它们没有产生任何后果）。
   */
  async function runFilesHalf(
    files: readonly File[],
    signal: AbortSignal | undefined,
    progress: { base?: number; indeterminate?: boolean } = {},
  ): Promise<AssetImportSummary> {
    const entries: DecodedEntry[] = []
    for (const file of files) {
      if (signal?.aborted) break
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const entry: DecodedEntry = { path: file.name, bytes }
        // 哈希算不出就不带 —— 计划器据此报 hash-unavailable 并回落到编号路径，
        // 与 zip 那条路同一条降级规则（绝不换第二种哈希）
        const hash = await hashMediaBlob(file)
        if (hash !== undefined) entry.hash = hash
        entries.push(entry)
      } catch {
        // 单个文件读不出字节（权限/被移走）不该连累其余
      }
    }

    if (signal?.aborted) {
      const summary = emptySummary()
      summary.read = true
      summary.cancelled = true
      return summary
    }

    return executeImport(entries, undefined, files.length - entries.length, signal, progress)
  }

  /** 起一次导入: 上闸、建取消控制器、复位进度。返回本次的 signal 与收尾函数 */
  function beginImport(): { signal: AbortSignal | undefined; end: () => void } {
    importing.value = true
    // 先把计数写成一致状态，**最后**才翻 phase —— phase 是"这一对计数可以读了"的提交点。
    // 反过来写会露出一个瞬时的错配三元组（新 phase + 旧分母），同步 watcher 与 computed
    // 都看得见，表现就是进度条闪一下。
    progressDone.value = 0
    progressTotal.value = 0
    progressPhase.value = 'read'

    const Ctor = (globalThis as { AbortController?: new () => AbortController }).AbortController
    const controller = Ctor ? new Ctor() : null
    abortController = controller
    return {
      signal: controller?.signal,
      end: () => {
        importing.value = false
        progressPhase.value = 'idle'
        // 只清自己那一份: 别把后来者的控制器抹掉
        if (abortController === controller) abortController = null
      },
    }
  }

  /**
   * 一键导入一个压缩包（§5 / D9）。
   *
   * 错误处理照抄音频那套（§7.6）: 逐条 try/catch，失败就 `failed += 1` 然后 `continue`,
   * **绝不 rethrow、绝不 break**（配额耗尽是唯一的例外 —— 它不是个案，后面基本也没戏），
   * 结束后**一条**汇总（分支见 {@link notifyImportSummary}）。**如实呈现部分成功。**
   */
  async function importZip(file: File | Blob | Uint8Array): Promise<AssetImportSummary> {
    const busy = rejectIfBusy()
    if (busy) return busy
    const { signal, end } = beginImport()
    try {
      // ⚠️ 必须 `return await`: 裸 `return promise` 会让 finally 在**执行还没开始**时
      // 就跑掉 —— 互斥闸提前放开、进度提前复位成 idle，界面看着像导入瞬间结束了
      return notifyImportSummary(await runZipHalf(file, signal))
    } finally {
      end()
    }
  }

  /**
   * 逐个文件导入（§1 / §7.3 承诺的单文件路径）—— 拖进来几张图、选中一批文件都走这里。
   *
   * **不长第二条管线**: 每个 `File` 变成一条 `DecodedEntry`（`path` = 文件名、字节、
   * 哈希），然后交给与 zip 完全相同的 {@link executeImport}。于是按扩展名路由
   * （拖进来的 `.mp3` 照样落到音频库）、D16 拒收、`(name,type)` 去重、变体编号、
   * 部分成功回执**全都白拿**，且行为与解包导入逐位一致。
   *
   * 非媒体文件（`.psd` / `.txt`）**算跳过，不算拒绝**: 计划器把它们记成
   * `unknown-extension`，摘要里并进"忽略无关文件"。
   *
   * 没有清单可言（清单只存在于 zip 根），所以这条路径进来的素材没有署名（D10）。
   * 压缩包混在里面时用 {@link importAny}，别自己分流。
   */
  async function importFiles(files: File[]): Promise<AssetImportSummary> {
    const busy = rejectIfBusy()
    if (busy) return busy
    const { signal, end } = beginImport()
    try {
      return notifyImportSummary(await runFilesHalf(files, signal))
    } finally {
      end()
    }
  }

  /**
   * **混合导入**: 一堆文件里既有压缩包又有散装素材/音频（拖拽的常态）。
   *
   * 这是给 UI 的**唯一入口** —— 分流是导入管线自己的事（"什么算压缩包"见
   * {@link isZipFile}，它带着 Windows 的 MIME 怪癖）。让 UI 自己分流再合并回执，
   * 就会出现两次 `notify`，而 §7.2 明写**一次导入只产出一条摘要**；
   * 提示是本层的职责，UI 拿不到它，所以这个洞只能在这里补。
   *
   * 压缩包**逐个顺序处理**（不并发）: 写库要按顺序才能让整批的变体编号连续
   * （`_2`、`_3` 而不是两个 `_2`），并发会让基准行相互看不见。
   *
   * 多半边时进度**不给分母**: 后面还有几批、每批几行要等各自规划完才知道，
   * 分母只会往上长 —— 那正是会让百分比倒退的情形（同解压段的取舍）。
   */
  async function importAny(files: File[]): Promise<AssetImportSummary> {
    const busy = rejectIfBusy()
    if (busy) return busy
    const { signal, end } = beginImport()
    try {
      const zips = files.filter((f) => isZipFile(f))
      const loose = files.filter((f) => !isZipFile(f))
      const multi = zips.length + (loose.length > 0 ? 1 : 0) > 1
      const parts: AssetImportSummary[] = []
      let base = 0

      for (const zip of zips) {
        if (signal?.aborted) break
        const part = await runZipHalf(zip, signal, { base, indeterminate: multi })
        parts.push(part)
        base += part.assetsAdded + part.audioAdded + part.failed
      }
      if (loose.length > 0 && !signal?.aborted) {
        parts.push(await runFilesHalf(loose, signal, { base, indeterminate: multi }))
      }
      // 中途取消时后面的半边根本没跑 —— 合并出来的回执也得说出取消这件事
      if (signal?.aborted && !parts.some((p) => p.cancelled)) {
        const stub = emptySummary()
        stub.read = true
        stub.cancelled = true
        parts.push(stub)
      }
      return notifyImportSummary(mergeSummaries(parts))
    } finally {
      end()
    }
  }

  /** `AssetZipError` → 人话。按 `code` 判别，不去 match 文案 */
  function describeZipError(e: unknown): string {
    if (e instanceof AssetZipError) {
      switch (e.code) {
        case 'entry-too-large':
          return `导入失败：压缩包里 ${e.path ?? '某个文件'} 解压后超过单文件上限（${e.limit ?? 0} 字节）。库没有任何改动。`
        case 'total-too-large':
          return '导入失败：压缩包解压后体积超过上限，已中止解压。库没有任何改动。'
        case 'read-failed':
          return '导入失败：这个压缩包读不出来（可能被截断、损坏，或不是 zip）。库没有任何改动。'
        default:
          return `导入失败：${e.message}。库没有任何改动。`
      }
    }
    return `导入失败：${e instanceof Error ? e.message : String(e)}。库没有任何改动。`
  }

  // ═══ 导出（D17：范围窄于"库里的一切"）════════════════

  /**
   * 打一个**导入侧原样接受**的包（§5.4）。
   *
   * 范围: 素材全部 + 音频**仅** `source: 'blob'`。
   * 排除 `'builtin'`（占位授权，打进可分享的 zip 就是再分发）与 `'file'`
   * （字节在用户自己的文件夹里，要活的授权、还可能 missing）。
   * **摘要把每一项排除都说出来** —— 静默产出一个比屏幕上的库小的包，读起来就是数据丢失。
   */
  async function exportZip(): Promise<AssetExportResult> {
    const stamp = new Date()
    const pad = (n: number): string => String(n).padStart(2, '0')
    const result: AssetExportResult = {
      blob: null,
      filename: `${EXPORT_FILENAME_PREFIX}_${stamp.getFullYear()}${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}.zip`,
      assets: 0,
      audio: 0,
      skippedBuiltin: 0,
      skippedFile: 0,
      skippedCollision: 0,
      failed: 0,
      message: '',
    }
    if (exporting.value) {
      result.message = '已有一个导出正在进行，请等它结束。'
      notify(result.message, 'error')
      return result
    }
    exporting.value = true
    try {
      const entries: AssetZipWriteEntry[] = []
      const manifest: AssetZipManifest = { assets: {}, audio: {} }
      /** zip 的目录是个字典 —— 重名会让 writeAssetZip 抛错，所以这里先让路并如实计数 */
      const used = new Set<string>()

      await refreshAssets()
      for (const row of assets.value) {
        try {
          const blob = await getAssetBlob(row.id)
          if (!blob) {
            // 元数据在、字节没了。导出不该整体失败，如实计一条
            result.failed += 1
            continue
          }
          const name = formatAssetFilename(row)
          if (used.has(name)) {
            result.skippedCollision += 1
            continue
          }
          used.add(name)
          entries.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) })
          result.assets += 1
          if (row.credit !== undefined || row.license !== undefined) {
            manifest.assets[name] = {
              ...(row.credit !== undefined ? { credit: row.credit } : {}),
              ...(row.license !== undefined ? { license: row.license } : {}),
            }
          }
        } catch {
          result.failed += 1
        }
      }

      let tracks: AudioTrack[] = []
      try {
        tracks = await getAudioTracks()
      } catch {
        tracks = []
      }

      /**
       * 内置曲目**不落 Dexie**（每次启动从 `/audio/manifest.json` 重建），所以
       * `getAudioTracks()` 里根本没有它们 —— 要数得到那 57 首，只能问音频 store
       * 的 `builtinTracks`（它的公开状态，不是内部实现）。数不到就报 0，其余照常导出：
       * 少说一句排除，好过为了一句话让整个导出失败。
       */
      const builtinIds = new Set<string>()
      for (const t of tracks) if (t.source === 'builtin') builtinIds.add(t.id)
      try {
        for (const t of useAudioStore().builtinTracks) builtinIds.add(t.id)
      } catch {
        // 无 Pinia 上下文 / 音频 store 起不来
      }
      result.skippedBuiltin = builtinIds.size

      for (const track of tracks) {
        // 'builtin' 已在上面数过；'file' 的字节在用户自己的文件夹里，不是本应用的
        if (track.source === 'builtin') continue
        if (track.source === 'file') {
          result.skippedFile += 1
          continue
        }
        try {
          const blob = await getAudioBlob(track.id)
          if (!blob) {
            result.failed += 1
            continue
          }
          const name = `${track.name}.${audioExportExtension(track, blob)}`
          if (used.has(name)) {
            result.skippedCollision += 1
            continue
          }
          used.add(name)
          entries.push({ name, bytes: new Uint8Array(await blob.arrayBuffer()) })
          result.audio += 1
          // 署名与 tags 一样，都是文件名承载不了、只能靠清单带走的东西（D10）
          const meta: AssetZipManifest['audio'][string] = {}
          if (track.tags.length > 0) meta.tags = [...track.tags]
          if (track.credit !== undefined) meta.credit = track.credit
          if (track.license !== undefined) meta.license = track.license
          if (Object.keys(meta).length > 0) manifest.audio[name] = meta
        } catch {
          result.failed += 1
        }
      }

      // 内置曲目是全局共享的，任何一个存档都能看到，所以它必须被说出来 ——
      // 哪怕素材与用户音频都是 0，用户屏幕上仍有 57 首。
      const skipParts: string[] = []
      if (result.skippedBuiltin > 0) skipParts.push(`内置 ${result.skippedBuiltin}`)
      if (result.skippedFile > 0) skipParts.push(`本地文件 ${result.skippedFile}`)
      if (result.skippedCollision > 0) skipParts.push(`同名让路 ${result.skippedCollision}`)
      if (result.failed > 0) skipParts.push(`字节缺失 ${result.failed}`)
      const skipText = skipParts.length > 0 ? ` · 已跳过 ${skipParts.join(' · ')}` : ''

      if (entries.length === 0) {
        result.message = `没有可导出的内容${skipText}。`
        notify(
          result.message +
            (result.skippedBuiltin > 0
              ? '内置曲目带的是占位授权，不随导出包再分发；本地文件夹里的曲目字节也不属于本应用。'
              : ''),
          'info',
        )
        return result
      }

      try {
        result.blob = await writeAssetZip(entries, manifest)
      } catch (e) {
        result.message =
          e instanceof AssetZipError
            ? `导出失败：${e.message}`
            : `导出失败：${e instanceof Error ? e.message : String(e)}`
        notify(result.message, 'error')
        result.blob = null
        return result
      }

      result.message = `已导出 素材 ${result.assets} · 音频 ${result.audio}${skipText}`
      notify(
        result.skippedBuiltin > 0 || result.skippedFile > 0
          ? `${result.message}。内置曲目带的是占位授权、本地文件夹曲目的字节不属于本应用，两者都刻意不打进包里。`
          : result.message,
        result.failed > 0 ? 'error' : 'info',
      )
      return result
    } finally {
      exporting.value = false
    }
  }

  // ═══ 改名（D14：name / type / variant 全可改）══════════

  /**
   * 改名 —— **三个字段都能改**（D14），但两条闸门:
   *
   * 1. **命名不变式（D16）**: name 的任何下划线段、variant 的任何段等于类型 token
   *    一律**拒收**（`'naming-invariant'`），不修补。没有它，`(苏婉, 头像, 变体=立绘)`
   *    导出成 `苏婉_头像_立绘.png`、再导入就变成 `(苏婉_头像, 立绘, 无变体)` —— 一次
   *    往返静默改行。
   * 2. **目标位被占 → 自动编号**（§5.3），且用的是**导入器那一个分配器**（见
   *    {@link allocateSlot}），不是一份"看起来一样"的实现。
   *
   * 为什么"锁死 name+type"这条 RPT 的做法这里不采纳: §3.2 下打错的名字既查不出来
   * 也改不回来（只能删掉重导，而源 zip 可能早没了），逃生口比护栏值钱。
   */
  async function renameAsset(
    id: string,
    patch: { name?: string; type?: AssetType; variant?: string },
  ): Promise<AssetMutationResult> {
    const row = findAsset(id)
    if (!row) return { outcome: 'not-found' }

    // **不 trim**: 前后空白是名字的一部分（D2 原样保留），而且它在 zip 条目名里
    // 完全可表示 —— 替用户悄悄改名比留着一个带空格的名字糟得多。
    const name = patch.name ?? row.name
    const type = patch.type ?? row.type
    const rawVariant = patch.variant ?? row.variant
    // 空串变体 = 清空变体（与"无变体"是同一行，见 asset-filename 的空尾巴处理）
    const variant = rawVariant === '' ? undefined : rawVariant

    // 三关（D16 / D19 / D7）在 allocateSlot 里统一判 —— 一份规则，导入与改名共用
    const alloc = allocateSlot({ name, type, variant, ext: row.ext }, [id])
    if (!alloc.ok) return { outcome: alloc.reason ?? 'failed' }

    const next: AssetMetaRecord = { ...row, name, type, updatedAt: Date.now() }
    if (alloc.variant === undefined) delete next.variant
    else next.variant = alloc.variant

    try {
      await saveAsset(next)
    } catch {
      return { outcome: 'failed' }
    }
    await refreshAssets()
    const out: AssetMutationResult = { outcome: 'ok', row: findAsset(id) ?? next }
    if (alloc.renumberedFrom !== undefined) out.renumberedFrom = alloc.renumberedFrom
    return out
  }

  // ═══ 设为主图（§7.4：先降级、再清空，一个事务）═════════

  /**
   * 把某一行提成基图（无变体的那个位）。
   *
   * **两步，顺序不能反**:
   * 1. 现任基图**降级**成变体，号由分配器给 —— `max+1`，**不是硬编码 `_2`**（`_2`
   *    完全可能已经被占）；
   * 2. 然后才清空所选行的变体。
   *
   * 这个顺序意味着基图位**从来不会（哪怕瞬间）被两行同时占据**，于是两步之间失败
   * 只会留下一个**无主图**的组 —— §8 已经在渲染这个状态 —— 而不是重复。
   * 两写包在**同一个 Dexie 事务**里（这也是本模块唯一直接摸 Dexie 的地方: database.ts
   * 没有导出"两行原子更新"的写口，而这里的原子性是设计明写的要求）。
   */
  async function setPrimary(id: string): Promise<AssetMutationResult> {
    const row = findAsset(id)
    if (!row) return { outcome: 'not-found' }
    if (row.variant === undefined || row.variant === '') return { outcome: 'already-base' }

    const base = rowsInGroup(row.name, row.type).find(
      (r) => r.id !== id && (r.variant === undefined || r.variant === ''),
    )

    // 组里本来就没有基图（删过基图的常态）→ 只需一次写入
    if (!base) {
      try {
        await saveAsset(withVariant(row, undefined))
      } catch {
        return { outcome: 'failed' }
      }
      await refreshAssets()
      return { outcome: 'ok', row: findAsset(id) }
    }

    // 现任基图去哪: 它是"撞在基图位上的一行"，所以拿**当前全部行**去算 max+1
    // （基图位算 1 号，已有数字变体照数），得到的号绝不会撞上所选行现在的号。
    const alloc = allocateSlot({ name: base.name, type: base.type, ext: base.ext })
    if (!alloc.ok) return { outcome: alloc.reason ?? 'failed' }

    const demoted = withVariant(base, alloc.variant)
    const promoted = withVariant(row, undefined)

    try {
      const db = getDatabase()
      await db.transaction('rw', db.assetMeta, async () => {
        await db.assetMeta.put(demoted)
        await db.assetMeta.put(promoted)
      })
    } catch {
      // 事务回滚 = 两行都没动；就算引擎层出了怪事，最坏也只是组里暂时没有基图
      await refreshAssets()
      return { outcome: 'failed' }
    }
    await refreshAssets()
    const out: AssetMutationResult = { outcome: 'ok', row: findAsset(id) }
    if (alloc.variant !== undefined) out.renumberedFrom = ''
    return out
  }

  // ═══ 删除 ═════════════════════════════════════════════

  /**
   * 删一行。
   *
   * **删掉基图不会自动提拔变体**（§7.4）: 组留成「无主图」，由 设为主图 显式修。
   * 自动提拔等于悄悄改写一个用户没碰过的文件名，还在猜他的意图。
   */
  async function deleteAssetById(id: string): Promise<boolean> {
    try {
      await dbDeleteAsset(id)
    } catch {
      notify('删除失败，这条素材仍在库里，可以再试一次。', 'error')
      return false
    }
    releaseAssetUrl(id)
    await refreshAssets()
    return true
  }

  /**
   * 批量删除（多选）。**尽力做完**: 单条删不掉不连累其余，否则表现成
   * "选了 12 条，删了 3 条就不动了"而且毫无解释。查无此行算 skipped（不适用，不是错）。
   * 结束后**一条**汇总。回执沿用 {@link AudioBatchResult} 的形状（§6.3）。
   *
   * 刻意逐条走 `deleteAsset` 而不是 database.ts 的原子 `deleteAssets`: 原子版只有
   * "全删/全不删"两种结局，报不出部分成功，而这条路径上如实呈现部分成功比原子性值钱
   * （每条自己的元数据+字节仍然是原子的）。
   */
  async function deleteAssetsByIds(ids: readonly string[]): Promise<AudioBatchResult> {
    const res: AudioBatchResult = { ok: 0, skipped: 0, failed: 0 }
    for (const id of ids) {
      if (!findAsset(id)) {
        res.skipped += 1
        continue
      }
      try {
        await dbDeleteAsset(id)
        releaseAssetUrl(id)
        res.ok += 1
      } catch {
        res.failed += 1
      }
    }
    await refreshAssets()

    if (res.failed > 0) {
      notify(
        `已删除 ${res.ok} 条素材，但有 ${res.failed} 条没能删除，它们仍留在库里。` +
          '可以再删一次重试；已删除的字节不会回来。',
        'error',
      )
    } else if (res.ok > 0) {
      notify(
        res.skipped > 0
          ? `已删除 ${res.ok} 条素材，另有 ${res.skipped} 条已不在库里，已跳过。`
          : `已删除 ${res.ok} 条素材。`,
        'info',
      )
    } else if (res.skipped > 0) {
      notify(`选中的 ${res.skipped} 条素材都已不在库里，没有任何改动。`, 'info')
    }
    return res
  }

  return {
    // state
    assets,
    loading,
    importing,
    exporting,
    progressDone,
    progressTotal,
    progressPhase,
    storagePersisted,
    // views
    flat,
    groups,
    findAsset,
    rowsInGroup,
    // lifecycle
    init,
    refreshAssets,
    // zip
    importZip,
    importFiles,
    importAny,
    cancelImport,
    exportZip,
    // mutations
    renameAsset,
    setPrimary,
    deleteAsset: deleteAssetById,
    deleteAssets: deleteAssetsByIds,
    // urls
    assetUrl,
    peekAssetUrl,
    releaseAssetUrl,
    revokeAllUrls,
    // quota
    getStorageEstimate,
    requestPersistence,
  }
})
