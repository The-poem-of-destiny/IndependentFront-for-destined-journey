/**
 * asset-store.reload.test.ts — 「导入当时能显示、刷新之后变空图」的复现测试
 *
 * 真机症状（Chromium）: 在游戏页点画像 → 选图 → 裁剪 → 确认，落下 `亚瑟/头像` +
 * `亚瑟/立绘` 两行，右栏大图**当场就渲染出来了**；然后**刷新浏览器**，画像退回
 * 首字母兜底，素材库两行仍在（名字/类型/ext/体积都对）但缩略图**全空**。
 *
 * 这份测试的全部意义在于**真的跨过那条「刷新」的边界** —— 复用同一个 store 实例、
 * 或者复用同一个 Dexie 连接的测试，永远抓不到这类问题（写进去的那个 Blob 对象
 * 还在内存里，读回来的可能根本不是从 IndexedDB 反序列化出来的那一份）。
 * 所以这里:
 * - `getDatabase().close()` 关掉旧连接；
 * - `vi.resetModules()` 让 `@engine/database` 的模块级 `dbInstance` 归零，
 *   下一次 `getDatabase()` 是**新的 Dexie 实例、新的 IDBDatabase 连接**；
 * - Pinia 与 store 一并重建（新的 `urlCache`、空的 `assets`）；
 * - fake-indexeddb 的数据留在 `globalThis.indexedDB` 那个 factory 里不受影响 ——
 *   于是「新连接读旧字节」这条路是真的走了一遍。
 *
 * `URL.createObjectURL` 用 Node 自带的真实现（Node ≥ 16.7 起有），它**只认真正的
 * Blob**：喂 Uint8Array / ArrayBuffer / 普通对象都会抛 —— 正好是浏览器里的行为，
 * 也正是主嫌疑（a）「存进去的不是真 Blob」会被抓现行的地方。最后那条**阴性对照**
 * 把这份判别力钉成了一条断言，免得上面几条哪天变成恒真还没人发现。
 *
 * ⚠️ 复现不到的部分（诚实记下）: vitest 跑在 `environment: 'node'`，没有
 * `createImageBitmap`、没有画布，所以裁剪那一步的 `decode` / `createCanvas` 是注入
 * 的替身，产出的 Blob 由替身构造（`new Blob([...], { type: 'image/webp' })`）。
 * 真机上那个 Blob 来自 `OffscreenCanvas.convertToBlob()`。两者都是 Blob，但
 * 「Chromium 的画布 Blob 在 IndexedDB 里的存法」这一层这里验不了 ——
 * 那一层已由真机探针单独验过（见本次诊断报告）。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { CropBitmapLike, CropCanvasLike, ImageCropSeams } from '../lib/image-crop'

// audio-store 只用到这两个面；避开 AudioManager 单例（node 环境没有 Web Audio）
vi.mock('./audio-store', () => ({
  useAudioStore: () => ({ refreshTracks: async () => {}, builtinTracks: [] }),
}))

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

function fakeBytes(seed: number, size = 512): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) out[i] = (seed * 31 + i * 17) % 251
  return out
}

/**
 * 同样的字节，但交出的是 `ArrayBuffer`。
 *
 * `new Blob([某个 Uint8Array 变量])` 在 vitest 里跑得好好的，`tsc` 却会红:
 * `Uint8Array<ArrayBufferLike>` 的 `buffer` 可能是 `SharedArrayBuffer`，而
 * `BlobPart` 只收 `ArrayBufferView<ArrayBuffer>`。项目里既有的写法是
 * `bytes.slice().buffer as ArrayBuffer`（见 asset-store.ts 的 `makeBlob`），
 * 这里照抄那一条，不另发明。
 */
function bytesPart(seed: number, size = 512): ArrayBuffer {
  return fakeBytes(seed, size).slice().buffer as ArrayBuffer
}

const SOURCE_W = 900
const SOURCE_H = 1600

/**
 * 裁剪注入缝: 解码替身报一个固定尺寸，画布替身把「画了多大一块」编成真 Blob 字节。
 *
 * 字节随输出尺寸变化 → 两次裁剪的哈希不同 → 不会被去重当成同一张（那会让复现
 * 少写一行，而症状恰恰是两行都空）。
 */
function cropSeams(): ImageCropSeams {
  return {
    decode: async (): Promise<CropBitmapLike> => ({ width: SOURCE_W, height: SOURCE_H }),
    createCanvas: (w: number, h: number): CropCanvasLike => {
      const canvas: CropCanvasLike = {
        width: w,
        height: h,
        getContext: () => ({ drawImage: () => {} }),
        convertToBlob: async (options?: { type?: string }) =>
          new Blob([bytesPart(canvas.width * 7 + canvas.height, 256)], {
            type: options?.type ?? 'image/png',
          }),
      }
      return canvas
    },
  }
}

/** 一个 blob 的「它到底是什么」快照 —— 报告里要的就是这四个字段 */
function describeBlob(v: unknown): Record<string, unknown> {
  return {
    ctor: (v as { constructor?: { name?: string } })?.constructor?.name ?? String(v),
    isBlob: v instanceof Blob,
    size: (v as Blob | undefined)?.size,
    type: (v as Blob | undefined)?.type,
  }
}

type DatabaseModule = typeof import('@engine/database')
type StoreModule = typeof import('./asset-store')
type AssetStore = ReturnType<StoreModule['useAssetStore']>

interface Session {
  db: DatabaseModule
  store: AssetStore
}

/**
 * 开一次「会话」= 一次页面加载。
 *
 * `vi.resetModules()` 之后 `@engine/database` 是全新模块，`dbInstance` 为 null，
 * 于是 `getDatabase()` 会 new 一个 Dexie 并**重新 open** 同一个（fake-）IndexedDB 库。
 */
async function openSession(): Promise<Session> {
  vi.resetModules()
  const db: DatabaseModule = await import('@engine/database')
  const storeModule: StoreModule = await import('./asset-store')
  await db.initializeDatabase()
  setActivePinia(createPinia())
  const store = storeModule.useAssetStore()
  await store.init()
  return { db, store }
}

/** 关掉这次会话的连接 —— 相当于关掉标签页 */
function closeSession(s: Session): void {
  s.db.getDatabase().close()
}

beforeEach(async () => {
  vi.resetModules()
  const db: DatabaseModule = await import('@engine/database')
  try {
    await db.clearAllData()
  } catch {
    /* 首次运行时库还不存在 */
  }
})

// ═══════════════════════════════════════════════════════════
// 复现
// ═══════════════════════════════════════════════════════════

describe('刷新之后素材还读得出字节吗（真机症状复现）', () => {
  it('裁剪落库的一对（立绘+头像）：关连接 → 重开 → 两行都还能取到真 Blob 与 object URL', async () => {
    // ── 会话 1: 导入 ──────────────────────────────────────
    const s1 = await openSession()
    const source = new File([bytesPart(1, 4096)], '来源.webp', { type: 'image/webp' })

    const res = await s1.store.importPortraitPair(
      source,
      '亚瑟',
      { portrait: { x: 0, y: 0, w: 900, h: 1600 }, avatar: { x: 300, y: 100, w: 400, h: 400 } },
      cropSeams(),
    )
    expect(res.outcome).toBe('ok')
    expect(res.portraitId).toBeDefined()
    expect(res.avatarId).toBeDefined()
    const ids = [res.portraitId!, res.avatarId!]

    // 落库当时: 字节读得出、URL 铸得出（真机上这一步也是好的）
    for (const id of ids) {
      const blob = await s1.db.getAssetBlob(id)
      expect(describeBlob(blob)).toMatchObject({ isBlob: true })
      expect(await s1.store.assetUrl(id)).not.toBeNull()
    }
    const rowsBefore = await s1.db.getAssets()
    expect(rowsBefore).toHaveLength(2)
    expect(rowsBefore.every((r) => r.ext === 'webp' && r.mime === 'image/webp')).toBe(true)

    // ── 刷新 ──────────────────────────────────────────────
    closeSession(s1)
    const s2 = await openSession()

    // 元数据照旧（真机上这一半是对的 —— 名字/类型/体积都在）
    expect(s2.store.assets).toHaveLength(2)
    for (const id of ids) {
      expect(s2.store.assets.find((r) => r.id === id)).toBeDefined()
    }

    // 🔴 症状所在: 刷新之后字节还在不在、URL 还铸不铸得出来
    for (const id of ids) {
      const blob = await s2.db.getAssetBlob(id)
      expect(describeBlob(blob)).toMatchObject({ isBlob: true })
      expect((blob as Blob).size).toBeGreaterThan(0)
      expect(await s2.store.assetUrl(id)).not.toBeNull()
    }
  })

  /**
   * 真机症状说的是 `assetBlobs` **一条记录都没有**（不是字节读不出来，是表空的）。
   * 那与「读得出 URL」是两个层次的断言 —— 一条 blob 行完全可能存在却读不动，也可能
   * 压根没落库。所以这里直接数**行数**，并且是在**重开之后**数: `saveAsset` 的事务
   * 若没有真正提交，写它的那条连接自己仍读得到，只有换一条连接才露馅。
   *
   * 三种取材各验一遍，因为它们喂给 `saveAsset` 的字节来路不同:
   * 裁剪 = 画布产物；整图 = `sameBytesAs` 交回来的**源对象本体**；skip = 不写行。
   */
  it('assetBlobs 行数：重开之后必须与 assetMeta 一一对应（裁剪 / 整图 / 跳过）', async () => {
    const s1 = await openSession()

    await s1.store.importPortraitPair(
      new File([bytesPart(5, 4096)], '甲.webp', { type: 'image/webp' }),
      '测甲',
      { portrait: { x: 0, y: 0, w: 900, h: 1600 }, avatar: { x: 200, y: 50, w: 400, h: 400 } },
      cropSeams(),
    )
    // 整图: 两半都不过画布，存的是源对象本身
    await s1.store.importPortraitPair(
      new File([bytesPart(6, 2048)], '乙.webp', { type: 'image/webp' }),
      '测乙',
      { portrait: 'whole', avatar: 'whole' },
      cropSeams(),
    )
    // 一半跳过: 只该长出一行
    await s1.store.importPortraitPair(
      new File([bytesPart(7, 2048)], '丙.webp', { type: 'image/webp' }),
      '测丙',
      { portrait: { x: 0, y: 0, w: 900, h: 1600 }, avatar: 'skip' },
      cropSeams(),
    )

    closeSession(s1)
    const s2 = await openSession()

    const db = s2.db.getDatabase()
    const metaRows = await db.assetMeta.toArray()
    const blobRows = await db.assetBlobs.toArray()
    expect(metaRows).toHaveLength(5) // 2 + 2 + 1
    // 🔴 真机上这一行是 0 —— 元数据在、字节表空
    expect(blobRows).toHaveLength(metaRows.length)
    expect(new Set(blobRows.map((r) => r.id))).toEqual(new Set(metaRows.map((r) => r.id)))
    for (const r of blobRows) {
      expect(describeBlob(r.blob)).toMatchObject({ isBlob: true })
      expect((r.blob as Blob).size).toBeGreaterThan(0)
    }
  })

  it('普通文件导入的一行：同样跨刷新可读（作为裁剪路径的对照组）', async () => {
    const s1 = await openSession()
    const file = new File([bytesPart(2, 1024)], 'IMG_0001.png', { type: 'image/png' })
    const r = await s1.store.importForCharacter(file, '兰斯', '头像')
    expect(r.outcome).toBe('ok')
    const id = r.id!

    expect(describeBlob(await s1.db.getAssetBlob(id))).toMatchObject({ isBlob: true })

    closeSession(s1)
    const s2 = await openSession()

    const blob = await s2.db.getAssetBlob(id)
    expect(describeBlob(blob)).toMatchObject({ isBlob: true })
    expect((blob as Blob).size).toBe(1024)
    expect(await s2.store.assetUrl(id)).not.toBeNull()
  })

  it('诊断: 裁剪路径与普通导入路径存进 assetBlobs 的是同一种东西', async () => {
    const s1 = await openSession()

    const pair = await s1.store.importPortraitPair(
      new File([bytesPart(3, 4096)], '来源.webp', { type: 'image/webp' }),
      '亚瑟',
      { portrait: { x: 0, y: 0, w: 900, h: 1600 }, avatar: 'skip' },
      cropSeams(),
    )
    const plain = await s1.store.importForCharacter(
      new File([bytesPart(4, 1024)], 'IMG_0002.png', { type: 'image/png' }),
      '兰斯',
      '头像',
    )

    closeSession(s1)
    const s2 = await openSession()

    const raw = await s2.db.getDatabase().assetBlobs.toArray()
    const byId = new Map(raw.map((r) => [r.id, r.blob]))
    const cropped = describeBlob(byId.get(pair.portraitId!))
    const imported = describeBlob(byId.get(plain.id!))

    // 两条路径存进去的东西必须是同一类 —— 不同就是最强的嫌疑
    expect(cropped.ctor).toBe(imported.ctor)
    expect(cropped.isBlob).toBe(true)
    expect(imported.isBlob).toBe(true)
  })

  /**
   * **阴性对照** —— 证明上面那几条断言真的有判别力，不是恒真。
   *
   * 上面三条全绿的时候，唯一该问的问题是「它们是不是根本抓不到东西」。所以这里
   * 故意把一个 **`Uint8Array`** 塞进 `assetBlobs`（主嫌疑「存进去的不是真 Blob」
   * 的最直白形态），走同一条「关连接 → 重开 → 取 URL」的路，断言它**必然变红**:
   * `URL.createObjectURL` 只认 Blob，喂别的会抛 → `assetUrl` 交出 null → 空图。
   *
   * 这条一旦哪天自己绿了（`assetUrl` 对非 Blob 也给得出 URL），说明判别力没了，
   * 上面三条也就不再能证明任何事。
   */
  it('阴性对照: 存进去的若不是真 Blob，刷新后 assetUrl 必然是 null（本测试确实抓得到）', async () => {
    const s1 = await openSession()
    const now = Date.now()
    const id = 'asset_not-a-blob'
    await s1.db.getDatabase().assetMeta.put({
      id,
      name: '假货',
      type: '头像',
      ext: 'png',
      mime: 'image/png',
      bytes: 64,
      createdAt: now,
      updatedAt: now,
    })
    await s1.db.getDatabase().assetBlobs.put({ id, blob: fakeBytes(9, 64) as unknown as Blob })

    closeSession(s1)
    const s2 = await openSession()

    const stored = await s2.db.getAssetBlob(id)
    expect(stored).toBeDefined()
    expect(stored instanceof Blob).toBe(false) // 不是 Blob —— 这正是被模拟的缺陷
    expect(await s2.store.assetUrl(id)).toBeNull() // …于是界面上就是一张空图
  })
})
