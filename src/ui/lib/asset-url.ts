/**
 * asset-url.ts — 素材 object URL 的 LRU 缓存（含逐出即撤销）
 *
 * 设计依据: docs/planning/2026-07-29-asset-management-system-design.md §7.5
 *
 * 为什么不照抄音频那套「换曲即撤销」:
 * 浏览器里没有自定义资源协议，blob 只能靠 `URL.createObjectURL` 端出去，而
 * object URL **不撤销就是泄漏**。音频能用「换曲即撤销」是因为它的同时存活数
 * 实际上恒为 1；素材网格一屏就要同时挂几十张缩略图，所以这里必须是 LRU +
 * 逐出即撤销，而不是音频那种单件模式。mp4 预览（`<video muted>`）跟 `<img>`
 * 一样需要 object URL，共用同一份 LRU，不另开一套。
 *
 * ⚠️ 调用方**绝不许持久化 object URL**。
 * 要存就存逻辑键（`name` / `type` / `variant`），渲染时再解析成 URL。
 * object URL 只在**当前会话**内有效：页面一刷新、缓存一逐出、`revokeAll()` 一
 * 调用，旧 URL 立刻变成死链。v1 里没有任何渲染面，所以这条规则暂时是被动成立
 * 的；现在写下来，是为了等渲染面进来时没人把一条 URL 塞进存档数据里。
 *
 * 边界:
 * - 本模块**不认识 Dexie**。字节从注入的 loader 来（对齐 audio-singleton.ts 的
 *   `BlobResolver` 间接层），这样它既能被纯函数式测试，也不绑定任何存储后端。
 * - 所有浏览器全局（`URL.createObjectURL` 等）**惰性写在函数体内**，仅 import
 *   本模块在 `environment:'node'` 下不触碰任何浏览器 API（全项目音频文件头都写
 *   着的那条纪律）。
 */

/** 默认容量 —— §7.5 的 ~64。素材库预期 40~100 条，一屏网格远小于此 */
export const ASSET_URL_DEFAULT_CAPACITY = 64

/** 字节读取 seam：拿不到（素材行存在但 blob 缺失）返回 undefined，不是抛错 */
export type AssetBlobLoader = (id: string) => Promise<Blob | undefined>

export interface AssetUrlCacheOptions {
  /** 必填：按 asset id 取字节。缓存不关心它背后是 Dexie、内存还是磁盘 */
  loadBlob: AssetBlobLoader
  /** LRU 容量上限，默认 {@link ASSET_URL_DEFAULT_CAPACITY}；小于 1 时按 1 处理 */
  capacity?: number
  /** 注入 seam，默认惰性取 `globalThis.URL.createObjectURL`（缺失时返回空串） */
  createObjectURL?: (blob: Blob) => string
  /** 注入 seam，默认惰性取 `globalThis.URL.revokeObjectURL`（缺失时空转） */
  revokeObjectURL?: (url: string) => void
}

export interface AssetUrlCache {
  /**
   * 取 id 对应的 object URL；没有就加载并铸造一个。
   *
   * - 命中已有条目 → 刷新其 LRU 新鲜度并返回同一个 URL（不重复铸造）
   * - 同一 id 的并发调用 → 共享同一个在飞 Promise，只铸造一个 URL
   * - loader 返回 undefined（blob 缺失）→ 返回 null 且**什么都不缓存**，之后重试仍可成功
   * - loader 抛错 → 原样上浮，且不留下中毒的在飞条目，之后重试仍可成功
   */
  get(id: string): Promise<string | null>
  /** 同步窥视已缓存的 URL；不触发加载、不改动新鲜度。未缓存返回 null */
  peek(id: string): string | null
  /** 撤销并移除单条；未知 id 是无害空操作 */
  release(id: string): void
  /** 拆除用（如分区 unmount）：逐条撤销全部存活 URL 并清空缓存 */
  revokeAll(): void
  /** 当前已铸造 URL 的条目数（不含在飞加载） */
  readonly size: number
}

// ═══════════════════════════════════════════════════════════
// 默认 seam 实现（惰性引用全局）
// ═══════════════════════════════════════════════════════════

function defaultCreateObjectURL(blob: Blob): string {
  const u = (globalThis as unknown as { URL?: typeof URL }).URL
  if (!u || typeof u.createObjectURL !== 'function') return ''
  try {
    return u.createObjectURL(blob)
  } catch {
    return ''
  }
}

function defaultRevokeObjectURL(url: string): void {
  const u = (globalThis as unknown as { URL?: typeof URL }).URL
  if (!u || typeof u.revokeObjectURL !== 'function' || !url) return
  try {
    u.revokeObjectURL(url)
  } catch { /* 静默 —— 撤销失败没有可做的补救 */ }
}

// ═══════════════════════════════════════════════════════════
// 工厂
// ═══════════════════════════════════════════════════════════

/**
 * 造一份独立的 object URL LRU 缓存。
 *
 * 刻意用「工厂返回实例」而不是模块级全局 + 测试钩子（audio-folder.ts 那种）:
 * 每个使用面（素材网格 / 日后的角色立绘层）都能有自己的一份，测试之间也不必
 * 靠 reset 互相清场。
 */
export function createAssetUrlCache(options: AssetUrlCacheOptions): AssetUrlCache {
  const loadBlob = options.loadBlob
  const capacity = Math.max(1, Math.floor(options.capacity ?? ASSET_URL_DEFAULT_CAPACITY))
  const create = options.createObjectURL ?? defaultCreateObjectURL
  const revoke = options.revokeObjectURL ?? defaultRevokeObjectURL

  /** Map 的插入顺序即新鲜度：队首最久未用，队尾最新 */
  const urls = new Map<string, string>()
  /** 在飞去重表：同一 id 的并发 get 共享同一个 Promise */
  const inflight = new Map<string, Promise<string | null>>()

  /**
   * 世代号 —— revokeAll() 递增。
   *
   * 没有它就有个真实的泄漏: 分区 unmount 时 revokeAll()，此时若还有 get 在飞，
   * 它回来后会把一个新 URL 塞进已经拆掉的缓存里，从此无人撤销。对齐
   * MusicChannel 的加载世代号做法：await 回来先校验，过期就当场撤销收手。
   */
  let generation = 0

  /** 插入新条目后按容量逐出最久未用者，逐出即撤销 */
  function evictIfNeeded(): void {
    while (urls.size > capacity) {
      const oldest = urls.keys().next()
      if (oldest.done) return
      const victim = oldest.value
      const url = urls.get(victim)
      urls.delete(victim)
      if (url) revoke(url)
    }
  }

  /** 刷新新鲜度：delete + set 把条目挪到队尾 */
  function touch(id: string, url: string): void {
    urls.delete(id)
    urls.set(id, url)
  }

  async function load(id: string, gen: number): Promise<string | null> {
    const blob = await loadBlob(id)
    // blob 缺失不是错误（素材行还在、字节丢了），但也绝不缓存 —— 之后重试要能成功
    if (!blob) return null

    const url = create(blob)
    // 空串意味着环境里没有 createObjectURL，同样不缓存（否则会缓存一条死链）
    if (!url) return null

    if (gen !== generation) {
      // 加载期间被 revokeAll() 拆过了：这个 URL 不该进缓存，当场撤销
      revoke(url)
      return null
    }

    // 并发窗口内可能已有同 id 条目落地（例如 release 后又被别人装上），
    // 以已在缓存的那个为准，本次多铸的撤掉，保证一个 id 只对应一个存活 URL。
    const existing = urls.get(id)
    if (existing) {
      revoke(url)
      touch(id, existing)
      return existing
    }

    urls.set(id, url)
    evictIfNeeded()
    return url
  }

  return {
    get size(): number {
      return urls.size
    },

    peek(id: string): string | null {
      return urls.get(id) ?? null
    },

    async get(id: string): Promise<string | null> {
      const hit = urls.get(id)
      if (hit) {
        touch(id, hit)
        return hit
      }

      const pending = inflight.get(id)
      if (pending) return pending

      // 两个组件同时要同一张头像时，若不去重就会铸两个 URL、只记住一个，
      // 另一个永久泄漏。这是真 bug，不是优化。
      const p = load(id, generation).finally(() => {
        // 无论成功、缺失还是抛错，都必须把在飞条目撤掉，否则一次失败会把这个
        // id 永久钉死在一个已 reject 的 Promise 上。
        if (inflight.get(id) === p) inflight.delete(id)
      })
      inflight.set(id, p)
      return p
    },

    release(id: string): void {
      const url = urls.get(id)
      if (!url) return // 未知 id：无害空操作
      urls.delete(id)
      revoke(url)
    },

    revokeAll(): void {
      generation += 1
      for (const url of urls.values()) revoke(url)
      urls.clear()
      // 在飞的加载不取消 —— 它们回来时会撞上世代号校验并自行撤销
    },
  }
}
