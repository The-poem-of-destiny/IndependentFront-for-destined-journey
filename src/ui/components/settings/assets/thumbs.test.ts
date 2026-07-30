/**
 * thumbs.test.ts — 缩略图 object URL 的装载与对账
 * @vitest-environment jsdom
 *
 * 为什么这个模块必须有测试（而 audio/format.ts 那种没有也行）: 它管的是
 * **object URL 生命周期**，失败形态是「泄漏」与「死图」—— 两样在界面上都几乎
 * 看不出来，截图更看不出来。所以这里的主力断言是会计恒等式，不是渲染结果。
 *
 * 手法照 lib/asset-url.test.ts 的先例: 全程**没有真实的 URL.createObjectURL**，
 * create / revoke 是注入的计数假件（options 风格，不是模块级全局钩子）。
 * 需要 jsdom 只为一件事 —— `onUnmounted` 要有真的组件实例才会触发。
 *
 * 组合方式刻意是「thumbs + 真 LRU」而不是给 thumbs 塞一个假 URL 源:
 * 生产里 store 的 assetUrl / peekAssetUrl 就是 `createAssetUrlCache` 的两个薄
 * 转发，把真缓存接上去，测的才是这两层实际的合成行为（在飞去重、逐出即撤销
 * 都住在缓存那一侧，但「会不会被上层用出泄漏」只有合起来才看得见）。
 */

import { describe, it, expect } from 'vitest'
import { defineComponent, h, nextTick, ref, type Ref } from 'vue'
import { mount } from '@vue/test-utils'
import type { AssetMetaRecord } from '@engine/types'
import { createAssetUrlCache, type AssetUrlCache } from '../../../lib/asset-url'
import { useAssetThumbs, type AssetThumbSource, type AssetThumbs } from './thumbs'

// ═══════════════════════════════════════════════════════════
// 假件与脚手架
// ═══════════════════════════════════════════════════════════

function row(id: string): AssetMetaRecord {
  return {
    id,
    name: id,
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 16,
    createdAt: 0,
    updatedAt: 0,
  }
}

interface Harness {
  cache: AssetUrlCache
  source: AssetThumbSource
  created: string[]
  revoked: string[]
  /** loader 被调过的 id 顺序 —— 用来验证「不缓存」的那条路真的会重试 */
  loads: string[]
  /** 让某个 id 的字节从"缺失"变成"存在"（重试可成功那条用例） */
  provide(id: string): void
}

function makeHarness(opts: { capacity?: number; missing?: Iterable<string> } = {}): Harness {
  const created: string[] = []
  const revoked: string[] = []
  const loads: string[] = []
  const missing = new Set(opts.missing ?? [])
  let seq = 0

  const cache = createAssetUrlCache({
    capacity: opts.capacity,
    loadBlob: async (id) => {
      loads.push(id)
      if (missing.has(id)) return undefined
      return new Blob([`bytes:${id}`], { type: 'image/png' })
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
  })

  return {
    cache,
    // 生产里这两个就是 asset-store 对同一份缓存的转发
    source: { assetUrl: (id) => cache.get(id), peekAssetUrl: (id) => cache.peek(id) },
    created,
    revoked,
    loads,
    provide: (id) => missing.delete(id),
  }
}

/** 挂一个只为了跑 composable 的空壳组件（`onUnmounted` 需要真实例） */
function mountThumbs(visible: Ref<AssetMetaRecord[]>, source: AssetThumbSource) {
  const Host = defineComponent({
    setup() {
      const thumbs = useAssetThumbs(() => visible.value, { source })
      return { thumbs }
    },
    render: () => h('div'),
  })
  return mount(Host)
}

/**
 * 排空 watcher（'pre' 档，改完要等一个 tick）与 reconcile 里那串 await。
 * loader 立即兑现，所以链起来的微任务都会在下一个宏任务之前跑完 —— 一个
 * `setTimeout(0)` 足够，200 条也一样。
 */
async function flush(): Promise<void> {
  await nextTick()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

function thumbsOf(wrapper: ReturnType<typeof mountThumbs>): AssetThumbs {
  return (wrapper.vm as unknown as { thumbs: AssetThumbs }).thumbs
}

// ═══════════════════════════════════════════════════════════
// 铸造与复用
// ═══════════════════════════════════════════════════════════

describe('useAssetThumbs — 铸造与复用', () => {
  it('每个 id 只铸一次 URL，可见集合再变也不重铸', async () => {
    const h1 = makeHarness()
    const visible = ref([row('a'), row('b')])
    const wrapper = mountThumbs(visible, h1.source)
    await flush()

    const urlA = thumbsOf(wrapper).thumbFor('a')
    expect(urlA).toBeTruthy()
    expect(h1.created).toHaveLength(2)

    // 同一批再对账一次（把 b 换个位置，集合不变）
    visible.value = [row('b'), row('a')]
    await flush()

    expect(thumbsOf(wrapper).thumbFor('a')).toBe(urlA)
    expect(h1.created).toHaveLength(2) // 没有第三个
    expect(h1.loads).toEqual(['a', 'b']) // 字节也没有重读
    expect(h1.revoked).toHaveLength(0)
  })

  it('同一 id 在首次加载在飞期间被再次要求，也只铸一个 URL', async () => {
    // 两个使用面（网格 + 抽屉）同时要同一张图 —— 不去重就会铸两个、只记住一个，
    // 另一个永久泄漏。去重住在 LRU 里，这里钉的是「上层这么用不会破功」。
    const h1 = makeHarness()
    const gridVisible = ref([row('a')])
    const drawerVisible = ref([row('a')])

    const grid = mountThumbs(gridVisible, h1.source)
    const drawer = mountThumbs(drawerVisible, h1.source) // 同一个 tick，第一次加载还没兑现
    await flush()

    const fromGrid = thumbsOf(grid).thumbFor('a')
    expect(fromGrid).toBeTruthy()
    expect(thumbsOf(drawer).thumbFor('a')).toBe(fromGrid)
    expect(h1.created).toHaveLength(1)
    expect(h1.loads).toEqual(['a'])
    expect(h1.revoked).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 对账：剪引用，但不撤销别人还在用的 URL
// ═══════════════════════════════════════════════════════════

describe('useAssetThumbs — 可见集合变化', () => {
  it('掉出可见集合的行只剪本地引用，且留下的那些一个都没被撤销', async () => {
    const h1 = makeHarness()
    const visible = ref([row('a'), row('b')])
    const wrapper = mountThumbs(visible, h1.source)
    await flush()
    const urlB = thumbsOf(wrapper).thumbFor('b')

    visible.value = [row('b'), row('c')] // a 掉出，b 留下，c 新进
    await flush()

    const t = thumbsOf(wrapper)
    expect(t.thumbFor('a')).toBeNull() // 不留死引用
    expect(t.thumbFor('b')).toBe(urlB) // 还在用的那个原封不动
    expect(t.thumbFor('c')).toBeTruthy()
    // 在容量之内，掉出可见集合**不等于**该撤销：生命周期归容量逐出与分区卸载
    expect(h1.revoked).toHaveLength(0)
  })

  it('另一个使用面还在显示时，本使用面把它移出可见集合不会打死它的图', async () => {
    // 这条是「按 drop-out 撤销」为什么被刻意否掉的可执行论据: 抽屉列的行正是
    // 平铺列表里那些行，抽屉一关 rows() 变空，若那时撤销就会撤掉网格正在显示的 URL。
    const h1 = makeHarness()
    const gridVisible = ref([row('a'), row('b')])
    const drawerVisible = ref([row('a')])
    const grid = mountThumbs(gridVisible, h1.source)
    const drawer = mountThumbs(drawerVisible, h1.source)
    await flush()
    const urlA = thumbsOf(grid).thumbFor('a')

    drawerVisible.value = [] // 抽屉关上
    await flush()

    expect(thumbsOf(drawer).thumbFor('a')).toBeNull() // 抽屉自己不再持有
    expect(thumbsOf(grid).thumbFor('a')).toBe(urlA) // 网格那张仍然活着
    expect(h1.revoked).toHaveLength(0)
    expect(h1.cache.peek('a')).toBe(urlA)
  })

  it('本使用面持有的条目不被容量逐出 —— 宁可超容，收尾归 revokeAll', async () => {
    // 🔴 引用计数落地前，这条用例断言的是**反过来**的行为（容量 2 会把 a 与 b
    // 挤出去撤销）。那才是隐患: 本模块刻意从不 release，所以被挤掉的 URL 完全
    // 可能还挂在另一个使用面上 —— 滚过 64 张缩略图就会撤掉正在显示的图。
    // 现在 LRU 逐出绝不碰被持有的条目，代价是缓存会涨到本使用面见过的条目数，
    // 上界由分区卸载时的 revokeAllUrls() 兜。
    const h1 = makeHarness({ capacity: 2 })
    const visible = ref([row('a')])
    const wrapper = mountThumbs(visible, h1.source)
    await flush()
    const urlA = thumbsOf(wrapper).thumbFor('a')!

    visible.value = [row('b'), row('c'), row('d')]
    await flush()

    expect(h1.revoked).toHaveLength(0)
    expect(h1.cache.size).toBe(4) // 超容，但一条都没丢失追踪
    expect(h1.cache.peek('a')).toBe(urlA) // 掉出可见集合 ≠ 被撤销

    wrapper.unmount()
    h1.cache.revokeAll() // 生命周期的上界在这里
    expect(h1.revoked).toHaveLength(h1.created.length)
    expect(new Set(h1.revoked).size).toBe(h1.revoked.length)
    expect(h1.cache.size).toBe(0)
  })

  it('可见集合变得比装载快时，过期的那一轮不会把已剪掉的 id 写回来', async () => {
    // 连着敲搜索框: 上一轮 reconcile 还在 await，它手上的 list 已经过期。
    // 没有世代号的话它回来会把新一轮刚剪掉的 id 装回去，urls 从此不等于可见集合。
    const h1 = makeHarness()
    const visible = ref([row('a'), row('b')])
    const wrapper = mountThumbs(visible, h1.source)
    await nextTick() // 故意只等 watcher，不排空 reconcile 的 await

    visible.value = [row('z')]
    await flush()

    const t = thumbsOf(wrapper)
    expect(t.thumbFor('z')).toBeTruthy()
    expect(t.thumbFor('a')).toBeNull()
    expect(t.thumbFor('b')).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════
// 字节缺失
// ═══════════════════════════════════════════════════════════

describe('useAssetThumbs — 字节缺失', () => {
  it('blob 缺失时不铸 URL、不缓存，之后重试仍可成功', async () => {
    const h1 = makeHarness({ missing: ['gone'] })
    const visible = ref([row('gone')])
    const wrapper = mountThumbs(visible, h1.source)
    await flush()

    expect(thumbsOf(wrapper).thumbFor('gone')).toBeNull()
    expect(h1.created).toHaveLength(0)
    expect(h1.cache.peek('gone')).toBeNull() // 什么都没缓存
    expect(h1.cache.size).toBe(0)
    expect(h1.loads).toEqual(['gone'])

    // 字节回来了（比如用户重新导了一次包）→ 下一轮对账应当装上
    h1.provide('gone')
    visible.value = [row('gone'), row('a')]
    await flush()

    expect(thumbsOf(wrapper).thumbFor('gone')).toBeTruthy()
    expect(h1.created).toHaveLength(2)
    expect(h1.revoked).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════════════════════
// 拆除
// ═══════════════════════════════════════════════════════════

describe('useAssetThumbs — 拆除', () => {
  it('卸载后迟到的加载不再写进已拆掉的表', async () => {
    const h1 = makeHarness()
    const visible = ref([row('a'), row('b')])
    const wrapper = mountThumbs(visible, h1.source)
    await nextTick() // 加载在飞

    wrapper.unmount()
    await flush()

    const t = thumbsOf(wrapper)
    expect(t.thumbFor('a')).toBeNull()
    expect(t.thumbFor('b')).toBeNull()
  })

  it('分区级 revokeAll 把存活 URL 恰好各撤一次，之后一个不剩', async () => {
    // 真实分工: 撤全部是**素材库**在 onUnmounted 里调一次（抽屉不调）。
    // 这里模拟那一下，钉住「没有任何 URL 逃过撤销」。
    const h1 = makeHarness()
    const visible = ref([row('a'), row('b'), row('c')])
    const wrapper = mountThumbs(visible, h1.source)
    await flush()
    expect(h1.created).toHaveLength(3)

    wrapper.unmount()
    h1.cache.revokeAll()

    expect(h1.revoked).toHaveLength(3)
    expect(new Set(h1.revoked).size).toBe(3) // 各一次，没有重复撤销
    expect([...h1.revoked].sort()).toEqual([...h1.created].sort())
    expect(h1.cache.size).toBe(0)
  })

  it('会计恒等式：一串集合变化下来 revoked === created − live，收尾后全部归零', async () => {
    // 泄漏在浏览器里没有可见症状，只有这条计数断言拦得住。
    const h1 = makeHarness({ capacity: 16 })
    const all = Array.from({ length: 200 }, (_, i) => row(`asset-${i}`))
    const visible = ref<AssetMetaRecord[]>([])
    const wrapper = mountThumbs(visible, h1.source)

    // 每次露出一个 20 条的窗口往前滚，制造大量逐出
    for (let start = 0; start < 200; start += 20) {
      visible.value = all.slice(start, start + 20)
      await flush()
      expect(h1.revoked).toHaveLength(h1.created.length - h1.cache.size)
      expect(new Set(h1.revoked).size).toBe(h1.revoked.length)
    }

    expect(h1.created.length).toBeGreaterThan(16) // 确实发生过逐出

    wrapper.unmount()
    h1.cache.revokeAll()

    expect(h1.revoked).toHaveLength(h1.created.length)
    expect(new Set(h1.revoked).size).toBe(h1.created.length)
    expect(h1.cache.size).toBe(0)
  })
})
