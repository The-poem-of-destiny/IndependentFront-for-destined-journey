/**
 * asset-url.ts — 素材 object URL 的引用计数缓存（LRU 逐出为兜底）
 *
 * 设计依据: docs/planning/2026-07-29-asset-management-system-design.md §7.5
 *
 * 🔴 **引用计数（本轮加）**: 同一张素材会被**多个组件同时挂着**（一个 NPC 可以
 * 同时出现在 ScenePanel 与 CharacterListPanel）。没有计数时，第一个卸载的组件
 * 就把 URL 撤了，其余还在显示它的组件当场变成死图。所以:
 * - `get()` **每一次成功取用都 +1**（含命中缓存与搭在飞的车）
 * - `release()` -1，**归零才撤销**。它保证的是**不炸**: 未知 id / 已归零不抛错、
 *   计数永不为负、重复 release 不会二次撤销。⚠️ **但"不炸"不等于"无害"** ——
 *   计数只按 id 记、**不记是谁欠的**，所以一次没有对应 `get()` 的 release 花的是
 *   **别人**的那一份。最尖锐的窗口是「URL 已铸好、发起者还没拿到手」那一小段
 *   （此刻计数恰好是 1）: 这时插进来一次误 release 会当场撤销这条 URL，发起者的
 *   `get()` 只能拿到 `null`（活性闸拦住了死链，但那次取用确实失败了）。
 *   规矩因此是**只 release 自己 get 到的那一份**，别拿 id 当"清一下缓存"的开关
 * - 容量逐出**绝不撤销被持有的条目**：宁可超容，也不能撤掉正在显示的 URL
 * - `revokeAll()` 是拆除口，**无视计数**全撤（分区 unmount 时那一下）
 *
 * ⚠️ 由此产生的一个**刻意的语义位移**，读代码时别被文件名骗了: 现在每条落地的
 * 条目在创建时就至少有 1 份计数，而归零即撤销 —— 于是「零引用条目」在公开 API 下
 * 根本不会存续，容量逐出实际上退化成一条**安全网**（只有当调用方不还引用时，
 * 缓存才会超容）。`touch()` 与逐出扫描一并保留: 它们是正确的 LRU 语义，若日后
 * 把「归零即撤销」改成「归零转为可逐出」，这两处不用重写。
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
   * 取 id 对应的 object URL；没有就加载并铸造一个。**成功取到即 +1 份引用**，
   * 调用方欠一次对应的 {@link AssetUrlCache.release}（拿到 null 则不欠）。
   *
   * - 命中已有条目 → 刷新其 LRU 新鲜度并返回同一个 URL（不重复铸造），计数 +1
   * - 同一 id 的并发调用 → 共享同一个在飞 Promise、只铸造一个 URL，但**每个调用方
   *   各得一份计数**（两个组件并发要同一张头像 → 计数是 2 不是 1）
   * - loader 返回 undefined（blob 缺失）→ 返回 null 且**什么都不缓存**，之后重试仍可成功
   * - loader 抛错 → 原样上浮，且不留下中毒的在飞条目，之后重试仍可成功
   * - 铸好之后、兑现之前被 {@link AssetUrlCache.revokeAll} 拆掉（或被别人 release
   *   归零）→ 返回 null。**绝不端出一条已撤销的 URL**: 那既是死链，又会让调用方
   *   欠下一次记到「日后同 id 新铸的那条」头上的 release
   */
  get(id: string): Promise<string | null>
  /**
   * 同步窥视已缓存的 URL；不触发加载、不改动新鲜度、**不增加引用计数**。
   * 未缓存返回 null。
   *
   * ⚠️ 窥视到的 URL **不归窥视者所有** —— 它随时可能被持有者释放掉。要保证它
   * 在自己手上活着，得走 {@link AssetUrlCache.get}。
   */
  peek(id: string): string | null
  /**
   * 归还一份引用。**计数归零才撤销并移除**。
   *
   * 保证的是**不炸**: 未知 id、已归零的 id 都不抛错，计数永不为负，重复 release
   * 也不会二次撤销。
   *
   * ⚠️ **不是"无害"**: 计数按 id 记、不记是谁欠的，所以一次没有对应 `get()` 的
   * release 花掉的是**别人**的那一份；当那一份恰好是唯一一份时（典型是一次
   * 还在飞的 `get()`——它的计数已在内部落地、URL 却还没交到调用方手上），
   * 这条 URL 会被当场撤销，那次 `get()` 于是返回 `null`。**只 release 自己
   * get 到的那一份。**
   */
  release(id: string): void
  /** 拆除用（如分区 unmount）：**无视引用计数**逐条撤销全部存活 URL 并清空缓存 */
  revokeAll(): void
  /** 当前已铸造 URL 的条目数（不含在飞加载）。持有者不还引用时**可能超过容量** */
  readonly size: number
  /** 当前引用计数；未持有为 0。诊断与测试用，生产渲染面不需要 */
  refCount(id: string): number
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
  /**
   * id → 当前持有者数量。**不变式**: 只要 `urls` 里有这条，`refs` 里就 ≥ 1；
   * 归零的那一刻两张表同时删。所以「entry 存在但没人要」这个状态不会存续。
   */
  const refs = new Map<string, number>()
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

  /** 当前引用数（未持有为 0） */
  function countOf(id: string): number {
    return refs.get(id) ?? 0
  }

  /** +1 份引用 */
  function retain(id: string): void {
    refs.set(id, countOf(id) + 1)
  }

  /**
   * 插入新条目后按容量逐出，逐出即撤销。
   *
   * 🔴 **被持有的条目一律跳过** —— 逐出一条还有人挂着的 URL，就是把别人正在显示
   * 的图打成死链，而这在界面上只表现为「有时候图裂了」，极难查。所以这里从队首
   * （最久未用）起找**第一个零引用**的受害者；一个都没有就宁可超容返回。
   * 超容的条目仍留在 `urls` 里（没有"丢失追踪"这回事），等它们被 release 归零、
   * 或被 `revokeAll()` 一并收走。
   */
  function evictIfNeeded(): void {
    while (urls.size > capacity) {
      let victim: string | null = null
      for (const key of urls.keys()) {
        if (countOf(key) === 0) {
          victim = key
          break
        }
      }
      if (victim === null) return // 全员在用：超容 > 撤掉在用的 URL
      const url = urls.get(victim)
      urls.delete(victim)
      refs.delete(victim)
      if (url) revoke(url)
    }
  }

  /**
   * 出门前的**活性闸** —— `get` 的两条返回路径共用这一道。
   *
   * 🔴 为什么不能「验不过就只是不计数、URL 照样端出去」: 铸造完成与调用方拿到它
   * 之间隔着若干个微任务，这中间 `revokeAll()`（分区拆除）完全可能插进来把这条
   * URL 撤掉。此时端出去的是一条**死链**（`<img>` 当场裂），而且按契约调用方
   * 仍欠一次 release —— 那一次会记到日后为同一个 id 重新铸出来的**新** URL 头上，
   * 把别人正在显示的图撤掉。两害都由「拿不到就给 null」一并堵掉（契约里
   * 「拿到 null 则不欠」正好接得住）。
   *
   * @param claim 调用方手上**还没有**计数（搭车路径）→ 验过当场 +1；
   *   发起者的那一份已在 {@link load} 里落地，传 `false` 只验不加。
   */
  function liveOnly(id: string, url: string | null, claim: boolean): string | null {
    if (url === null) return null
    if (urls.get(id) !== url) return null
    if (claim) retain(id)
    return url
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
      retain(id) // 发起者自己那一份
      return existing
    }

    urls.set(id, url)
    // 🔴 必须**先** retain 再 evict: 新条目此刻是全场唯一的零引用条目，
    // 逐出扫描会当场把它自己挑走（容量 1 时 100% 复现，表现为「刚拿到就是死链」）
    retain(id)
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

    refCount(id: string): number {
      return countOf(id)
    },

    async get(id: string): Promise<string | null> {
      const hit = urls.get(id)
      if (hit) {
        touch(id, hit)
        retain(id)
        return hit
      }

      const pending = inflight.get(id)
      if (pending) {
        // 🔴 搭车者必须**自己**领一份计数，不能直接 `return pending`。
        // 直接返回的话，两个组件并发要同一张头像只会记 1 份，先卸载的那个
        // 一 release 就归零撤销 —— 另一个组件当场死图。这正是引用计数要修的
        // 那个 bug 的并发变体，而且比串行版更难查（要两个组件卡在同一个 tick）。
        return liveOnly(id, await pending, true)
      }

      // 两个组件同时要同一张头像时，若不去重就会铸两个 URL、只记住一个，
      // 另一个永久泄漏。这是真 bug，不是优化。
      const p = load(id, generation).finally(() => {
        // 无论成功、缺失还是抛错，都必须把在飞条目撤掉，否则一次失败会把这个
        // id 永久钉死在一个已 reject 的 Promise 上。
        if (inflight.get(id) === p) inflight.delete(id)
      })
      inflight.set(id, p)
      // 发起者那一份计数在 load() 里落地（必须早于 evictIfNeeded，见那里的注释）；
      // 但**落地之后、兑现之前**这条 URL 仍可能被 revokeAll() 拆掉，所以出门前
      // 同样要验一次活性 —— 发起者与搭车者走的是同一道闸。
      return liveOnly(id, await p, false)
    },

    release(id: string): void {
      const n = countOf(id)
      // 未知 id / 已归零：不抛错、计数绝不为负。
      // （"无害"只到这一步为止 —— n === 1 那条分支撤的可能是别人的那一份，见契约）
      if (n <= 0) {
        refs.delete(id)
        return
      }
      if (n > 1) {
        refs.set(id, n - 1)
        return // 还有别人挂着，撤了就是打死他的图
      }
      refs.delete(id)
      const url = urls.get(id)
      if (!url) return
      urls.delete(id)
      revoke(url)
    },

    revokeAll(): void {
      generation += 1
      for (const url of urls.values()) revoke(url)
      urls.clear()
      // 拆除口**无视计数**: 分区都没了，谁持有已经不重要，留着才是泄漏
      refs.clear()
      // 在飞的加载不取消 —— 它们回来时会撞上世代号校验并自行撤销
    },
  }
}
