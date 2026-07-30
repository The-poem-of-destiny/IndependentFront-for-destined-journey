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
 *    （max+1 / 换号不嵌套 / 单空格加整数）。所以这里**不重写分配器**，而是拿一个
 *    合成条目去调 `planImport`，把它的结论读回来 —— 一份规则，三个入口（§5.3
 *    "One collision rule, two entry points"）。重写一份"看起来一样"的分配器，正是这份
 *    设计一直在防的漂移。
 * 3. **导出范围窄于"库里的一切"**（D17）: 素材全导，音频**只导 `source: 'blob'`**。
 *    内置曲目带着 `license: PLACEHOLDER-PENDING-REVIEW`，打进一个可分享的 zip 就是
 *    **再分发占位授权素材** —— 正是仓库 2026-07-28 把那 57 首移出版本库时修掉的错误；
 *    `'file'` 的字节在用户自己的文件夹里，需要活的授权、还可能 `missing`。
 *    **摘要必须把每一项排除都说出来**，否则"导出的包比屏幕上的库小"读起来就是数据丢失。
 * 4. **绝不持久化 object URL**（§7.5）: 调用方存逻辑键，渲染时再解析。
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
import { planImport } from '@engine/asset-import-plan'
import type {
  ExistingRows,
  ImportPlan,
  ImportWarning,
  PlannedSkip,
} from '@engine/asset-import-plan'
import { formatAssetFilename, violatesNamingInvariant } from '@engine/asset-filename'
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
  /** 压缩包是否读成功；false 时其余计数全为 0，`message` 是人话错误 */
  read: boolean
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
    reason?: PlannedSkip['reason']
  }

  /**
   * 给一个目标位算终态变体 —— **借导入器的分配器**，不另写一份。
   *
   * 做法: 把目标行格式化成文件名，当作一个**合成条目**喂给 `planImport`，读回它
   * 分配的 `variant` / `renumberedFrom`。于是 max+1、换号不嵌套、单空格加整数
   * 这三条政策**逐位与导入一致**，且顺带白拿命名不变式（D16）与媒体规则（D7）
   * 的判定 —— 计划器拒了就是拒了，理由名直接透传给 UI。
   *
   * 刻意**不传 hash**: 传了会与自己的库内行撞成 `duplicate`（同 `(name,type)`
   * 作用域内哈希命中），那是去重语义，不是分配语义。
   */
  function allocateSlot(
    target: { name: string; type: AssetType; variant?: string; ext: string },
    excludeIds: readonly string[] = [],
  ): SlotAllocation {
    const skip = new Set(excludeIds)
    const existing: ExistingRows = {
      assets: assets.value
        .filter((a) => !skip.has(a.id))
        .map((a) => ({ id: a.id, name: a.name, type: a.type, variant: a.variant, hash: a.hash })),
      audio: [],
    }
    const plan = planImport(
      [{ path: formatAssetFilename(target), bytes: new Uint8Array(0) }],
      existing,
    )
    const planned = plan.assets[0]
    if (!planned) {
      return { ok: false, reason: plan.skips[0]?.reason ?? 'naming-invariant' }
    }
    const out: SlotAllocation = { ok: true }
    if (planned.variant !== undefined) out.variant = planned.variant
    if (planned.renumberedFrom !== undefined) out.renumberedFrom = planned.renumberedFrom
    return out
  }

  /** 计划器的拒收理由 → 可判别结论 */
  function outcomeForReason(reason: PlannedSkip['reason'] | undefined): AssetMutationOutcome {
    if (reason === 'mp4-on-立绘') return 'media-rule'
    if (reason === 'naming-invariant') return 'naming-invariant'
    return 'failed'
  }

  // ═══ 导入（一键，两个入口共用一份实现 —— D9）═══════════

  /** `ExistingRows` 的音频半边: 只取计划器真正会看的字段 */
  function toExistingAudio(tracks: readonly AudioTrack[]): ExistingRows['audio'] {
    return tracks.map((t) => ({ id: t.id, name: t.name, source: t.source, hash: t.hash }))
  }

  function emptySummary(): AssetImportSummary {
    return {
      read: false,
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
   * 一键导入一个包（§5 / D9）。**编排而已**:
   * `readAssetZip` → 攒 `ExistingRows` → `planImport` → 照单写行 → 刷新 → **一条**摘要。
   *
   * 错误处理照抄音频那套（§7.6）: 逐条 try/catch，失败就 `failed += 1` 然后 `continue`,
   * **绝不 rethrow、绝不 break**（配额耗尽是唯一的例外 —— 它不是个案，后面基本也没戏），
   * 结束后按分支报一次: 有失败 → error 且说清两个计数与数据现状；否则有新增 → info；
   * 一条都没动 → 说"全部跳过"。**如实呈现部分成功。**
   */
  async function importZip(file: File | Blob | Uint8Array): Promise<AssetImportSummary> {
    if (importing.value) {
      const busy = emptySummary()
      busy.message = '已有一个导入正在进行，请等它结束。'
      notify(busy.message, 'error')
      return busy
    }
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
    const signal = controller?.signal

    try {
      // ── 读包。AssetZipError 一律包成人话，绝不让它逃到调用方 ──
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
        // 取消是用户自己按的，不是失败 —— 此时库还一个字节都没写
        if (isAbortError(e, signal)) {
          summary.cancelled = true
          summary.message = '已取消导入，库没有任何改动。'
          notify(summary.message, 'info')
          return summary
        }
        summary.message = describeZipError(e)
        notify(summary.message, 'error')
        return summary
      }

      if (signal?.aborted) {
        const summary = emptySummary()
        summary.read = true
        summary.cancelled = true
        summary.message = '已取消导入，库没有任何改动。'
        notify(summary.message, 'info')
        return summary
      }

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
      const plan = planImport(zipResult.entries, existing, zipResult.manifest)
      const summary = summarizePlan(plan, zipResult.skippedNoise.length)
      // 进度进入第二段（写库）: 这里才有诚实的固定分母，可以显示真百分比。
      // 同样先写计数、最后翻 phase（见 importZip 开头那段注释）
      progressDone.value = 0
      progressTotal.value = plan.assets.length + plan.audio.length
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

      summary.message = buildImportMessage(summary)

      if (summary.cancelled) {
        // 取消**不是失败**: 用 info，并把"写进去的留着"这件事说清楚，
        // 否则用户会以为库处在某种半损坏状态而去手动清理。
        notify(
          `已取消导入：${summary.message}。取消前写入的内容都留在库里（不是坏数据），` +
            '重新导入同一个包即可继续 —— 已有的会被识别成重复而跳过。',
          'info',
        )
      } else if (quotaHit) {
        notify(
          `${summary.message}。浏览器存储空间已满，剩下的文件没有继续导入。` +
            '已导入的内容都已落库并保留；素材字节存在浏览器配额里，几百 MB 的素材包很容易撑满。',
          'error',
        )
      } else if (summary.failed > 0) {
        notify(
          `${summary.message}。有 ${summary.failed} 个文件没能写入（已写入 ` +
            `${summary.assetsAdded + summary.audioAdded} 个）。已写入的都完整保留，` +
            '没写入的库里一个字节都没留下，重新导入同一个包即可补齐（已有的会被识别成重复而跳过）。',
          'error',
        )
      } else if (summary.assetsAdded + summary.audioAdded > 0) {
        notify(summary.message, 'info')
      } else {
        notify(`${summary.message}（全部跳过，库没有变化）`, 'info')
      }
      return summary
    } finally {
      importing.value = false
      progressPhase.value = 'idle'
      // 只清自己那一份: 万一有人在 finally 之前又开了一次（importing 闸拦着，理论上不会），
      // 也不该把别人的控制器抹掉
      if (abortController === controller) abortController = null
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

    const name = patch.name !== undefined ? patch.name.trim() : row.name
    const type = patch.type ?? row.type
    const rawVariant = patch.variant !== undefined ? patch.variant.trim() : row.variant
    const variant = rawVariant === '' ? undefined : rawVariant

    if (name === '') return { outcome: 'naming-invariant' }
    // 显式先判一次: 这条闸门要在 UI 上就地提示，不该等到分配器那边间接得出
    if (violatesNamingInvariant(name, variant)) return { outcome: 'naming-invariant' }

    const alloc = allocateSlot({ name, type, variant, ext: row.ext }, [id])
    if (!alloc.ok) return { outcome: outcomeForReason(alloc.reason) }

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
    if (!alloc.ok) return { outcome: outcomeForReason(alloc.reason) }

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
