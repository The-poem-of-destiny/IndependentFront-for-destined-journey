/**
 * asset-url.test.ts — object URL LRU 缓存
 *
 * 跑在默认 environment:'node' 下：本模块的浏览器全局全是注入 seam，所以这里
 * 从头到尾**没有真实的 URL.createObjectURL**，计数器假件说什么就是什么。
 *
 * 这层真正要钉住的是「每个 URL 恰好被撤销一次」这条会计恒等式 ——
 * 泄漏在浏览器里没有任何可见症状，只能靠计数断言拦住。
 */

import { describe, it, expect } from 'vitest'
import {
  createAssetUrlCache,
  ASSET_URL_DEFAULT_CAPACITY,
  type AssetUrlCacheOptions,
} from './asset-url'

// ═══════════════════════════════════════════════════════════
// 假件：可计数的 URL 铸造 / 撤销 + 可控 loader
// ═══════════════════════════════════════════════════════════

interface Harness {
  created: string[]
  revoked: string[]
  /** loader 被调用过的 id 顺序（用于验证「不缓存」时会真的重试） */
  loads: string[]
  options: AssetUrlCacheOptions
}

function blobFor(id: string): Blob {
  return new Blob([`bytes:${id}`], { type: 'image/png' })
}

/** loader 立即返回；missing 集合里的 id 返回 undefined，throwing 集合里的抛错 */
function makeHarness(opts: {
  capacity?: number
  missing?: Set<string>
  throwing?: Set<string>
} = {}): Harness {
  const created: string[] = []
  const revoked: string[] = []
  const loads: string[] = []
  let seq = 0

  return {
    created,
    revoked,
    loads,
    options: {
      capacity: opts.capacity,
      loadBlob: async (id) => {
        loads.push(id)
        if (opts.throwing?.has(id)) throw new Error(`boom:${id}`)
        if (opts.missing?.has(id)) return undefined
        return blobFor(id)
      },
      createObjectURL: () => {
        seq += 1
        const url = `blob:fake/${seq}`
        created.push(url)
        return url
      },
      revokeObjectURL: (url) => {
        revoked.push(url)
      },
    },
  }
}

/** 手动可控的 deferred loader —— 专测在飞去重 */
function makeDeferredHarness(): Harness & { resolveOne: (id: string) => void } {
  const created: string[] = []
  const revoked: string[] = []
  const loads: string[] = []
  const waiters = new Map<string, (b: Blob | undefined) => void>()
  let seq = 0

  return {
    created,
    revoked,
    loads,
    resolveOne: (id) => {
      const w = waiters.get(id)
      if (!w) throw new Error(`没有在飞的加载: ${id}`)
      waiters.delete(id)
      w(blobFor(id))
    },
    options: {
      loadBlob: (id) => {
        loads.push(id)
        return new Promise<Blob | undefined>((resolve) => waiters.set(id, resolve))
      },
      createObjectURL: () => {
        seq += 1
        const url = `blob:fake/${seq}`
        created.push(url)
        return url
      },
      revokeObjectURL: (url) => {
        revoked.push(url)
      },
    },
  }
}

// ═══════════════════════════════════════════════════════════
// 1. 缓存命中：同一 id 只铸造一次
// ═══════════════════════════════════════════════════════════

describe('get — 缓存命中', () => {
  it('首次 get 加载并铸造一个 URL，二次 get 返回同一个且不再铸造', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)

    const first = await cache.get('a')
    const second = await cache.get('a')

    expect(first).toBe('blob:fake/1')
    expect(second).toBe(first)
    expect(h.created).toHaveLength(1)
    expect(h.loads).toEqual(['a']) // 命中不再回 loader
    expect(h.revoked).toHaveLength(0)
    expect(cache.size).toBe(1)
  })

  it('peek 只窥视已缓存的，不触发加载', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)

    expect(cache.peek('a')).toBeNull()
    expect(h.loads).toHaveLength(0)

    const url = await cache.get('a')
    expect(cache.peek('a')).toBe(url)
  })

  it('默认容量是 §7.5 的 64', () => {
    expect(ASSET_URL_DEFAULT_CAPACITY).toBe(64)
  })
})

// ═══════════════════════════════════════════════════════════
// 2 & 3. LRU 逐出 + 新鲜度刷新
// ═══════════════════════════════════════════════════════════

describe('LRU 逐出', () => {
  it('超出容量时逐出最久未用者，并对**那一个** URL 恰好撤销一次', async () => {
    const h = makeHarness({ capacity: 2 })
    const cache = createAssetUrlCache(h.options)

    const ua = await cache.get('a')
    await cache.get('b')
    expect(h.revoked).toHaveLength(0)

    await cache.get('c') // 挤掉 a

    expect(h.revoked).toEqual([ua])
    expect(cache.size).toBe(2)
    expect(cache.peek('a')).toBeNull()
    expect(cache.peek('b')).not.toBeNull()
    expect(cache.peek('c')).not.toBeNull()
  })

  it('对已有条目 get 会刷新新鲜度 —— 它不再是下一个被逐出的', async () => {
    const h = makeHarness({ capacity: 2 })
    const cache = createAssetUrlCache(h.options)

    await cache.get('a')
    const ub = await cache.get('b')
    await cache.get('a') // a 回到队尾，b 变成最久未用

    await cache.get('c')

    expect(h.revoked).toEqual([ub]) // 被逐出的是 b 不是 a
    expect(cache.peek('a')).not.toBeNull()
    expect(cache.peek('b')).toBeNull()
  })

  it('容量为 1 时每次换 id 都逐出上一条', async () => {
    const h = makeHarness({ capacity: 1 })
    const cache = createAssetUrlCache(h.options)

    const ua = await cache.get('a')
    const ub = await cache.get('b')
    await cache.get('c')

    expect(h.revoked).toEqual([ua, ub])
    expect(cache.size).toBe(1)
  })

  it('容量非法值（0 / 负数）按 1 处理，不会退化成「立刻逐出自己」', async () => {
    const h = makeHarness({ capacity: 0 })
    const cache = createAssetUrlCache(h.options)

    const url = await cache.get('a')
    expect(url).not.toBeNull()
    expect(cache.size).toBe(1)
    expect(h.revoked).toHaveLength(0)
  })

  it('逐出后重新 get 会重新加载并铸造新 URL', async () => {
    const h = makeHarness({ capacity: 1 })
    const cache = createAssetUrlCache(h.options)

    const first = await cache.get('a')
    await cache.get('b')
    const again = await cache.get('a')

    expect(again).not.toBe(first)
    expect(h.loads).toEqual(['a', 'b', 'a'])
  })
})

// ═══════════════════════════════════════════════════════════
// 4. revokeAll
// ═══════════════════════════════════════════════════════════

describe('revokeAll', () => {
  it('撤销每一个存活 URL 恰好一次并清空缓存', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)

    const ua = await cache.get('a')
    const ub = await cache.get('b')
    const uc = await cache.get('c')

    cache.revokeAll()

    expect(h.revoked).toHaveLength(3)
    expect(new Set(h.revoked)).toEqual(new Set([ua, ub, uc]))
    expect(cache.size).toBe(0)
    expect(cache.peek('a')).toBeNull()
  })

  it('重复 revokeAll 不会二次撤销（空缓存上是空操作）', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)
    await cache.get('a')

    cache.revokeAll()
    cache.revokeAll()

    expect(h.revoked).toHaveLength(1)
  })

  it('revokeAll 之后仍可继续使用（重新加载）', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)
    await cache.get('a')
    cache.revokeAll()

    const again = await cache.get('a')
    expect(again).toBe('blob:fake/2')
    expect(cache.size).toBe(1)
  })

  it('拆除时还在飞的加载回来后不进缓存、当场自撤 —— 否则那条 URL 永久无人撤销', async () => {
    const h = makeDeferredHarness()
    const cache = createAssetUrlCache(h.options)

    const pending = cache.get('a')
    cache.revokeAll() // 分区 unmount，此时 a 还在飞

    h.resolveOne('a')
    await expect(pending).resolves.toBeNull()

    expect(h.created).toHaveLength(1)
    expect(h.revoked).toEqual(h.created) // 铸了就撤了
    expect(cache.size).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 在飞去重（真实泄漏 bug）
// ═══════════════════════════════════════════════════════════

describe('并发 get 去重', () => {
  it('同一 id 的并发 get 只 loader 一次、只铸造一个 URL', async () => {
    const h = makeDeferredHarness()
    const cache = createAssetUrlCache(h.options)

    const p1 = cache.get('a')
    const p2 = cache.get('a')
    const p3 = cache.get('a')

    h.resolveOne('a')
    const [u1, u2, u3] = await Promise.all([p1, p2, p3])

    expect(h.loads).toEqual(['a'])
    expect(h.created).toHaveLength(1) // 两个组件要同一张头像 → 不许铸两个
    expect(u1).toBe(u2)
    expect(u2).toBe(u3)
    expect(h.revoked).toHaveLength(0)
    expect(cache.size).toBe(1)
  })

  it('不同 id 的并发 get 各自独立铸造', async () => {
    const h = makeDeferredHarness()
    const cache = createAssetUrlCache(h.options)

    const pa = cache.get('a')
    const pb = cache.get('b')
    h.resolveOne('a')
    h.resolveOne('b')

    const [ua, ub] = await Promise.all([pa, pb])
    expect(ua).not.toBe(ub)
    expect(h.created).toHaveLength(2)
    expect(cache.size).toBe(2)
  })

  it('在飞条目在解决后被清理 —— 下一轮 get 走缓存而不是复用旧 Promise', async () => {
    const h = makeDeferredHarness()
    const cache = createAssetUrlCache(h.options)

    const p = cache.get('a')
    h.resolveOne('a')
    const url = await p

    expect(await cache.get('a')).toBe(url)
    expect(h.loads).toEqual(['a'])
  })
})

// ═══════════════════════════════════════════════════════════
// 6 & 7. 缺失 blob 与 loader 抛错
// ═══════════════════════════════════════════════════════════

describe('失败路径', () => {
  it('loader 返回 undefined：不铸 URL、不缓存，之后重试仍能成功', async () => {
    const missing = new Set(['a'])
    const h = makeHarness({ missing })
    const cache = createAssetUrlCache(h.options)

    expect(await cache.get('a')).toBeNull()
    expect(h.created).toHaveLength(0)
    expect(cache.size).toBe(0)
    expect(cache.peek('a')).toBeNull()

    // 字节后来补上了（比如重新导入）→ 重试必须能成
    missing.delete('a')
    const url = await cache.get('a')
    expect(url).toBe('blob:fake/1')
    expect(h.loads).toEqual(['a', 'a'])
  })

  it('loader 抛错：错误上浮，且不留下中毒的在飞条目，重试仍能成功', async () => {
    const throwing = new Set(['a'])
    const h = makeHarness({ throwing })
    const cache = createAssetUrlCache(h.options)

    await expect(cache.get('a')).rejects.toThrow('boom:a')
    expect(cache.size).toBe(0)
    expect(h.created).toHaveLength(0)

    throwing.delete('a')
    await expect(cache.get('a')).resolves.toBe('blob:fake/1')
    expect(h.loads).toEqual(['a', 'a'])
  })

  it('createObjectURL 不可用（返回空串）时不缓存死链', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache({ ...h.options, createObjectURL: () => '' })

    expect(await cache.get('a')).toBeNull()
    expect(cache.size).toBe(0)
    expect(h.revoked).toHaveLength(0)
  })

  it('缺省 seam 在 node 环境下安全降级 —— 仅 import 与调用都不炸', async () => {
    // 不注入 createObjectURL / revokeObjectURL，走惰性全局引用路径。
    // node 有 URL 但（历史上）不保证 createObjectURL，两种结果都算通过，
    // 唯一不可接受的是抛错。
    const cache = createAssetUrlCache({ loadBlob: async (id) => blobFor(id) })
    const url = await cache.get('a')
    expect(url === null || typeof url === 'string').toBe(true)
    expect(() => cache.revokeAll()).not.toThrow()
  })
})

// ═══════════════════════════════════════════════════════════
// 8. release
// ═══════════════════════════════════════════════════════════

describe('release', () => {
  it('撤销并移除单条', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)
    const ua = await cache.get('a')
    await cache.get('b')

    cache.release('a')

    expect(h.revoked).toEqual([ua])
    expect(cache.size).toBe(1)
    expect(cache.peek('a')).toBeNull()
  })

  it('未知 id 是无害空操作（重复 release 也不会二次撤销）', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)
    await cache.get('a')

    cache.release('不存在的 id')
    expect(h.revoked).toHaveLength(0)

    cache.release('a')
    cache.release('a')
    expect(h.revoked).toHaveLength(1)
  })

  it('release 后重新 get 会重新加载', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)
    const first = await cache.get('a')
    cache.release('a')

    const again = await cache.get('a')
    expect(again).not.toBe(first)
    expect(h.loads).toEqual(['a', 'a'])
  })
})

// ═══════════════════════════════════════════════════════════
// 会计恒等式：网格用量下每个 URL 恰好撤销一次
// ═══════════════════════════════════════════════════════════

describe('URL 会计', () => {
  it('默认容量下滚过 200 条素材：撤销数 = 铸造数 - 存活数，且无重复撤销', async () => {
    const h = makeHarness()
    const cache = createAssetUrlCache(h.options)

    for (let i = 0; i < 200; i++) await cache.get(`asset-${i}`)

    expect(cache.size).toBe(ASSET_URL_DEFAULT_CAPACITY)
    expect(h.created).toHaveLength(200)
    expect(h.revoked).toHaveLength(200 - ASSET_URL_DEFAULT_CAPACITY)
    expect(new Set(h.revoked).size).toBe(h.revoked.length)

    cache.revokeAll()
    expect(h.revoked).toHaveLength(200)
    expect(new Set(h.revoked)).toEqual(new Set(h.created))
  })
})
