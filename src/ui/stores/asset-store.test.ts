/**
 * asset-store.test.ts — 素材库 store 的执行契约测试 (Asset System v1)
 *
 * 覆盖 (设计 §9 的 `asset-store` 行 + round-trip 行):
 * 1. **往返幂等（最重要的一条）**: 导出 → 再导入回同一个库，**两半边都一个字节不加** ——
 *    素材不重复、音频不被 ` (2)` 克隆。这是整份契约最好的一个测试（§5.4）。
 * 2. 导出范围: 排除 `builtin`（占位授权不可再分发）与 `'file'`（字节不属于本应用），
 *    且**摘要把两项排除都说出来**。
 * 3. 改名: 正常 / 不变式拒收（D16）/ 撞位自动编号（§5.3）。
 * 4. 设为主图: **`_2` 已被占用**时也对 —— 证明用的是 max+1 分配器而不是硬编码 `_2`；
 *    先降级后清空，基图位从不被两行同时占据。
 *    并直接断言**两写同事务**: 第二写抛错时第一写回滚，绝不出现双基图。
 * 5. 删基图**不自动提拔**变体，组留成「无主图」。
 * 6. 批量删除部分失败 → 如实的 `{ok, skipped, failed}` + **恰好一条**提示。
 * 7. 署名（D10）走完 清单 → 落库 → 导出清单 一整圈，且不破坏往返幂等。
 * 8. 取消: 写库中途取消 → 已写入的留着、报「已取消」而不是失败、可重新导入补齐。
 * 9. `persist()` 被拒 → 如实记录，不抛。
 *
 * 数据层是**真 Dexie + fake-indexeddb**（src/test-setup.ts 注入），只在 database
 * 模块外面包一层用来注入"单行写/删失败"。zip 也是真 fflate —— 往返测试断的就是
 * 真实字节经过真实压缩包之后仍然被识别成重复。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick, watch } from 'vue'
import { zipSync, strToU8 } from 'fflate'
import type { AssetMetaRecord, AudioTrack } from '@engine/types'

// ── @engine/database: 用真实实现（fake-indexeddb），只包一层失败注入 ──
const failFlags = {
  /** 这些 id 的 deleteAsset 会抛（批量删除的单条失败） */
  deleteFailIds: new Set<string>(),
  /** 这些 name 的 saveAsset 会抛 */
  saveFailNames: new Set<string>(),
  /** 每次 saveAsset 落库成功之后回调 —— 用来在"写库中途"按下取消 */
  afterSaveAsset: null as null | (() => void),
}

vi.mock('@engine/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@engine/database')>()
  return {
    ...actual,
    saveAsset: vi.fn(async (meta: AssetMetaRecord, blob?: Blob) => {
      if (failFlags.saveFailNames.has(meta.name)) throw new Error('写不进去')
      const id = await actual.saveAsset(meta, blob)
      failFlags.afterSaveAsset?.()
      return id
    }),
    deleteAsset: vi.fn(async (id: string) => {
      if (failFlags.deleteFailIds.has(id)) throw new Error('删不掉')
      return actual.deleteAsset(id)
    }),
  }
})

// ── audio-store: 只给素材 store 用到的那两个公开面，避开 AudioManager / 单例 ──
const audioRefreshTracks = vi.fn(async () => {})
const builtinTracks: AudioTrack[] = []
vi.mock('./audio-store', () => ({
  useAudioStore: () => ({ refreshTracks: audioRefreshTracks, builtinTracks }),
}))

import {
  clearAllData,
  initializeDatabase,
  getDatabase,
  getAssets,
  saveAsset,
  getAudioTracks,
  saveAudioTrack,
} from '@engine/database'
import { readAssetZip } from '../lib/asset-zip'
import { isZipFile, useAssetStore } from './asset-store'
import { useUIStore } from './ui-store'

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

/** 可预测的伪媒体字节（每个 seed 一份不同内容 → 不同哈希） */
function fakeBytes(seed: number, size = 96): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) out[i] = (seed * 31 + i * 17) % 251
  return out
}

interface ZipSpec {
  [name: string]: Uint8Array
}

function makeZip(files: ZipSpec, manifest?: unknown): Uint8Array {
  const payload: Record<string, Uint8Array> = { ...files }
  if (manifest !== undefined) payload['manifest.json'] = strToU8(JSON.stringify(manifest))
  return zipSync(payload)
}

/** 一个"典型包": 两条素材（一条带变体）+ 一条音频 + 带署名的清单 */
function typicalZip(): Uint8Array {
  return makeZip(
    {
      '苏婉_头像.png': fakeBytes(1),
      '苏婉_立绘_微笑.png': fakeBytes(2),
      '战斗主题.mp3': fakeBytes(3),
    },
    {
      assets: { '苏婉_头像.png': { credit: '画师甲', license: 'CC-BY' } },
      audio: { '战斗主题.mp3': { tags: ['情境:战斗'], credit: 'Aoo' } },
    },
  )
}

function makeAssetRow(over: Partial<AssetMetaRecord> = {}): AssetMetaRecord {
  const now = Date.now()
  return {
    id: `a_${Math.random().toString(36).slice(2)}`,
    name: '苏婉',
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 96,
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

function makeTrack(over: Partial<AudioTrack> = {}): AudioTrack {
  const now = Date.now()
  return {
    id: `t_${Math.random().toString(36).slice(2)}`,
    name: '曲子',
    kind: 'music',
    source: 'blob',
    tags: [],
    createdAt: now,
    updatedAt: now,
    ...over,
  }
}

function toasts(): { message: string; type: string }[] {
  return useUIStore().toasts.map((t) => ({ message: t.message, type: t.type }))
}

/** 记下并在收尾时还原被替身掉的 navigator */
let navigatorPatched = false
function stubNavigatorStorage(storage: unknown): void {
  navigatorPatched = true
  Object.defineProperty(globalThis, 'navigator', {
    value: { storage },
    configurable: true,
    writable: true,
  })
}

beforeEach(async () => {
  try {
    await clearAllData()
  } catch {
    /* 首次运行时库还不存在 */
  }
  await initializeDatabase()
  setActivePinia(createPinia())
  failFlags.deleteFailIds.clear()
  failFlags.saveFailNames.clear()
  failFlags.afterSaveAsset = null
  builtinTracks.length = 0
  audioRefreshTracks.mockClear()
})

afterEach(() => {
  if (navigatorPatched) {
    Reflect.deleteProperty(globalThis as object, 'navigator')
    navigatorPatched = false
  }
  vi.useRealTimers()
})

// ═══════════════════════════════════════════════════════════
// 1. 往返幂等 —— 设计 §5.4 的必测项
// ═══════════════════════════════════════════════════════════

describe('往返: 导出 → 再导入 一个字节都不加', () => {
  it('两半边都幂等：素材不重复、音频不被 (2) 克隆', async () => {
    const store = useAssetStore()

    const first = await store.importZip(typicalZip())
    expect(first.read).toBe(true)
    expect(first.assetsAdded).toBe(2)
    expect(first.audioAdded).toBe(1)
    expect(first.failed).toBe(0)
    // 清单只能**追加**元数据
    expect(store.assets.find((a) => a.variant === undefined)?.credit).toBe('画师甲')
    expect((await getAudioTracks())[0].tags).toEqual(['情境:战斗'])

    // ── 导出 ──
    const exported = await store.exportZip()
    expect(exported.blob).not.toBeNull()
    expect(exported.assets).toBe(2)
    expect(exported.audio).toBe(1)
    const bytes = new Uint8Array(await exported.blob!.arrayBuffer())

    // ── 再导入回同一个库 ──
    const second = await store.importZip(bytes)
    expect(second.read).toBe(true)
    expect(second.assetsAdded).toBe(0)
    expect(second.audioAdded).toBe(0)
    expect(second.failed).toBe(0)
    // 三条全部被认成重复（素材按 (name,type) 作用域，音频按规范名）
    expect(second.duplicatesSkipped).toBe(3)
    expect(second.renumbered).toBe(0)

    // ── 库确实没变 ──
    const rows = await getAssets()
    expect(rows).toHaveLength(2)
    expect(rows.filter((r) => r.name === '苏婉')).toHaveLength(2)
    const tracks = await getAudioTracks()
    expect(tracks).toHaveLength(1)
    // ` (2)` 克隆是"半幂等"的典型症状，比两边都不幂等更糟
    expect(tracks[0].name).toBe('战斗主题')
  })

  it('往返保住素材的 name / type / variant（格式化→解析不改行）', async () => {
    const store = useAssetStore()
    await store.importZip(typicalZip())
    const before = (await getAssets())
      .map((r) => `${r.name}|${r.type}|${r.variant ?? ''}`)
      .sort()

    const exported = await store.exportZip()
    await store.importZip(new Uint8Array(await exported.blob!.arrayBuffer()))

    const after = (await getAssets()).map((r) => `${r.name}|${r.type}|${r.variant ?? ''}`).sort()
    expect(after).toEqual(before)
    expect(after).toEqual(['苏婉|头像|', '苏婉|立绘|微笑'])
  })
})

// ═══════════════════════════════════════════════════════════
// 2. 导出范围 (D17)
// ═══════════════════════════════════════════════════════════

describe('导出范围', () => {
  it('排除 builtin 与 file 音频，且摘要把两项排除都说出来', async () => {
    const store = useAssetStore()
    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1), '战斗主题.mp3': fakeBytes(3) }))

    // 内置曲目不落 Dexie，由音频 store 的 builtinTracks 提供
    builtinTracks.push(
      makeTrack({ id: 'b1', name: '内置一', source: 'builtin', builtin: true }),
      makeTrack({ id: 'b2', name: '内置二', source: 'builtin', builtin: true }),
    )
    // 本机文件夹曲目：行在 Dexie 里，字节不在
    await saveAudioTrack(makeTrack({ id: 'f1', name: '本地一', source: 'file', relativePath: 'a.mp3' }))

    const res = await store.exportZip()
    expect(res.assets).toBe(1)
    expect(res.audio).toBe(1)
    expect(res.skippedBuiltin).toBe(2)
    expect(res.skippedFile).toBe(1)
    expect(res.message).toContain('已导出 素材 1 · 音频 1')
    expect(res.message).toContain('内置 2')
    expect(res.message).toContain('本地文件 1')

    // 导出包里确实没有它们
    const store2 = useAssetStore()
    const reimported = await store2.importZip(new Uint8Array(await res.blob!.arrayBuffer()))
    expect(reimported.duplicatesSkipped).toBe(2) // 只有那两条自己的
  })

  it('库为空时不产出包，并说清什么都没有可导的', async () => {
    const store = useAssetStore()
    const res = await store.exportZip()
    expect(res.blob).toBeNull()
    expect(res.message).toContain('没有可导出的内容')
  })
})

// ═══════════════════════════════════════════════════════════
// 3. 改名 (D14 / D16 / §5.3)
// ═══════════════════════════════════════════════════════════

describe('renameAsset', () => {
  it('正常改名：name / type / variant 三个字段都能改', async () => {
    const row = makeAssetRow({ name: '苏婉', type: '头像' })
    await saveAsset(row)
    const store = useAssetStore()
    await store.init()

    const res = await store.renameAsset(row.id, { name: '林清', type: '立绘', variant: '微笑' })
    expect(res.outcome).toBe('ok')
    expect(res.renumberedFrom).toBeUndefined()
    const after = store.findAsset(row.id)
    expect(after?.name).toBe('林清')
    expect(after?.type).toBe('立绘')
    expect(after?.variant).toBe('微笑')
  })

  it('拒收违反命名不变式的改名（variant 里含类型 token）', async () => {
    const row = makeAssetRow()
    await saveAsset(row)
    const store = useAssetStore()
    await store.init()

    // (苏婉, 头像, 变体=立绘) 正是 §2.3 那个往返会静默改行的反例
    const res = await store.renameAsset(row.id, { variant: '立绘' })
    expect(res.outcome).toBe('naming-invariant')
    expect(store.findAsset(row.id)?.variant).toBeUndefined()

    // name 里含类型 token 同样拒
    expect((await store.renameAsset(row.id, { name: '苏婉_头像' })).outcome).toBe(
      'naming-invariant',
    )
  })

  it('目标位被占 → 自动编号（max+1，且换号不嵌套）', async () => {
    const base = makeAssetRow({ id: 'r-base' })
    const smile = makeAssetRow({ id: 'r-smile', variant: '微笑' })
    const smile2 = makeAssetRow({ id: 'r-smile2', variant: '微笑 2' })
    const other = makeAssetRow({ id: 'r-other', variant: '生气' })
    for (const r of [base, smile, smile2, other]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    // 「生气」→「微笑」: 微笑 与 微笑 2 都占了 → 微笑 3（不是 微笑 2 2）
    const res = await store.renameAsset('r-other', { variant: '微笑' })
    expect(res.outcome).toBe('ok')
    expect(res.renumberedFrom).toBe('微笑')
    expect(store.findAsset('r-other')?.variant).toBe('微笑 3')

    // 撞基图位 → 号进变体位，原变体记作空串（"本来没有变体"）
    const loose = makeAssetRow({ id: 'r-loose', name: '苏婉', type: '头像' })
    await saveAsset(loose)
    await store.refreshAssets()
    const res2 = await store.renameAsset('r-loose', { variant: '' })
    expect(res2.outcome).toBe('ok')
    expect(res2.renumberedFrom).toBe('')
    expect(store.findAsset('r-loose')?.variant).toBe('2')
  })

  it('查无此行 / 空名字 分别给出可判别结论', async () => {
    const store = useAssetStore()
    await store.init()
    expect((await store.renameAsset('nope', { name: 'x' })).outcome).toBe('not-found')

    const row = makeAssetRow()
    await saveAsset(row)
    await store.refreshAssets()
    expect((await store.renameAsset(row.id, { name: '' })).outcome).toBe('naming-invariant')
  })

  it('前后空白**原样保留**，不 trim（D2: 名字保持原始，且空白在 zip 条目名里可表示）', async () => {
    const row = makeAssetRow()
    await saveAsset(row)
    const store = useAssetStore()
    await store.init()

    expect((await store.renameAsset(row.id, { name: ' 苏婉 ' })).outcome).toBe('ok')
    expect(store.findAsset(row.id)?.name).toBe(' 苏婉 ')
    // 它是与「苏婉」不同的另一个组 —— 严格 === 分组的自然结果
    expect(store.groups.map((g) => g.name)).toEqual([' 苏婉 '])
  })

  it('D19: 名字/变体带分隔符、或名字以点开头 → 拒收（进不了 zip 条目名）', async () => {
    const row = makeAssetRow({ id: 'd19' })
    await saveAsset(row)
    const store = useAssetStore()
    await store.init()

    for (const name of ['圣殿/内庭', '圣殿\\内庭', '.隐藏', './x']) {
      expect((await store.renameAsset('d19', { name })).outcome).toBe('unrepresentable-name')
    }
    expect((await store.renameAsset('d19', { variant: 'a/b' })).outcome).toBe(
      'unrepresentable-name',
    )
    // 一次都没落库
    expect(store.findAsset('d19')?.name).toBe('苏婉')
    expect(store.findAsset('d19')?.variant).toBeUndefined()
  })

  it('D11 回归: 两行改成同一个带分隔符的名字，绝不产生两个基图', async () => {
    const a = makeAssetRow({ id: 'sep-1', name: 'A' })
    const b = makeAssetRow({ id: 'sep-2', name: 'B' })
    for (const r of [a, b]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    // 旧实现把名字格式化成文件名再喂计划器，basenameOf 在最后一个 `/` 处拍平，
    // 于是两行都被算到「另一个组」上、都以为 base 位空着 —— 一个组两个基图。
    expect((await store.renameAsset('sep-1', { name: 'a/b' })).outcome).toBe(
      'unrepresentable-name',
    )
    expect((await store.renameAsset('sep-2', { name: 'a/b' })).outcome).toBe(
      'unrepresentable-name',
    )

    const bases = store.assets.filter((r) => r.variant === undefined || r.variant === '')
    expect(bases).toHaveLength(2)
    expect(new Set(bases.map((r) => r.name))).toEqual(new Set(['A', 'B'])) // 谁都没改成 a/b
  })
})

// ═══════════════════════════════════════════════════════════
// 4. 设为主图 (§7.4)
// ═══════════════════════════════════════════════════════════

describe('setPrimary', () => {
  it('_2 已被占用时也对：现任基图按 max+1 降级，不是硬编码 _2', async () => {
    const base = makeAssetRow({ id: 'p-base' })
    const two = makeAssetRow({ id: 'p-2', variant: '2' })
    const three = makeAssetRow({ id: 'p-3', variant: '3' })
    for (const r of [base, two, three]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    const res = await store.setPrimary('p-3')
    expect(res.outcome).toBe('ok')

    // 所选行成了基图；现任基图拿到 4（硬编码 _2 会撞上 p-2）
    expect(store.findAsset('p-3')?.variant).toBeUndefined()
    expect(store.findAsset('p-base')?.variant).toBe('4')
    expect(store.findAsset('p-2')?.variant).toBe('2')

    // 基图位有且只有一行 —— 顺序（先降级后清空）保证的正是这一点
    const bases = store
      .rowsInGroup('苏婉', '头像')
      .filter((r) => r.variant === undefined || r.variant === '')
    expect(bases).toHaveLength(1)
    expect(bases[0].id).toBe('p-3')
  })

  it('降级要占的号已经被占：继续 max+1 往上走，绝不覆盖', async () => {
    // base + _2 + _5 三行，提拔 _2 → 现任基图不能拿 2（它自己就是 2 挪走的位）也不能拿 5
    const base = makeAssetRow({ id: 'm-base' })
    const two = makeAssetRow({ id: 'm-2', variant: '2' })
    const five = makeAssetRow({ id: 'm-5', variant: '5' })
    for (const r of [base, two, five]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    expect((await store.setPrimary('m-2')).outcome).toBe('ok')
    expect(store.findAsset('m-2')?.variant).toBeUndefined()
    expect(store.findAsset('m-base')?.variant).toBe('6') // max(base=1, 2, 5) + 1
    expect(store.findAsset('m-5')?.variant).toBe('5') // 没被动过
  })

  it('组里本来没有基图 → 一次写入即可提拔', async () => {
    const only = makeAssetRow({ id: 'q-1', variant: '微笑' })
    await saveAsset(only)
    const store = useAssetStore()
    await store.init()

    expect((await store.setPrimary('q-1')).outcome).toBe('ok')
    expect(store.findAsset('q-1')?.variant).toBeUndefined()
  })

  it('降级与清空在同一个事务里：第二写失败则第一写回滚（绝不出现双基图）', async () => {
    const base = makeAssetRow({ id: 'tx-base' })
    const two = makeAssetRow({ id: 'tx-2', variant: '2' })
    for (const r of [base, two]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    // 事务里的第二个 put 抛错 → Dexie 应回滚第一个 put（降级）
    const table = getDatabase().assetMeta
    const realPut = table.put.bind(table)
    let calls = 0
    const spy = vi.spyOn(table, 'put').mockImplementation((...args: Parameters<typeof realPut>) => {
      calls += 1
      if (calls === 2) throw new Error('第二写失败')
      return realPut(...args)
    })

    expect((await store.setPrimary('tx-2')).outcome).toBe('failed')
    spy.mockRestore()

    // 两行都没动：基图仍是 tx-base，tx-2 仍带着变体 —— 绝没有两行同占基图位
    await store.refreshAssets()
    const rows = store.rowsInGroup('苏婉', '头像')
    const bases = rows.filter((r) => r.variant === undefined || r.variant === '')
    expect(bases).toHaveLength(1)
    expect(bases[0].id).toBe('tx-base')
    expect(store.findAsset('tx-2')?.variant).toBe('2')
  })

  it('已经是基图 / 查无此行 → 可判别结论，不写库', async () => {
    const base = makeAssetRow({ id: 'z-base' })
    await saveAsset(base)
    const store = useAssetStore()
    await store.init()
    expect((await store.setPrimary('z-base')).outcome).toBe('already-base')
    expect((await store.setPrimary('missing')).outcome).toBe('not-found')
  })
})

// ═══════════════════════════════════════════════════════════
// 5. 删除
// ═══════════════════════════════════════════════════════════

describe('删除', () => {
  it('删基图**不自动提拔**变体：组留成「无主图」', async () => {
    const base = makeAssetRow({ id: 'd-base' })
    const smile = makeAssetRow({ id: 'd-smile', variant: '微笑' })
    for (const r of [base, smile]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    expect(await store.deleteAsset('d-base')).toBe(true)

    const group = store.groups.find((g) => g.name === '苏婉')
    expect(group).toBeDefined()
    expect(group!.total).toBe(1)
    expect(group!.variantCount).toBe(1)
    expect(group!.baseTypes).toEqual([])
    expect(group!.baselessTypes).toEqual(['头像']) // §8 的「无主图」
    expect(store.findAsset('d-smile')?.variant).toBe('微笑') // 文件名一个字没被改写
  })

  it('批量删除部分失败 → 如实的 {ok, skipped, failed} + 恰好一条提示', async () => {
    const a = makeAssetRow({ id: 'b-1' })
    const b = makeAssetRow({ id: 'b-2', variant: '微笑' })
    const c = makeAssetRow({ id: 'b-3', variant: '生气' })
    for (const r of [a, b, c]) await saveAsset(r)
    const store = useAssetStore()
    await store.init()

    failFlags.deleteFailIds.add('b-2')
    const res = await store.deleteAssets(['b-1', 'b-2', 'b-3', 'not-there'])

    expect(res).toEqual({ ok: 2, skipped: 1, failed: 1 })
    // 单条失败不中断：b-3 在 b-2 之后，照样删掉了
    expect(store.findAsset('b-3')).toBeUndefined()
    expect(store.findAsset('b-2')).toBeDefined() // 如实留在库里

    const list = toasts()
    expect(list).toHaveLength(1) // 一条汇总，不是每条一个
    expect(list[0].type).toBe('error')
    expect(list[0].message).toContain('已删除 2')
    expect(list[0].message).toContain('1 条没能删除')
  })

  it('全部成功 → 一条 info 汇总', async () => {
    const a = makeAssetRow({ id: 'g-1' })
    await saveAsset(a)
    const store = useAssetStore()
    await store.init()

    const res = await store.deleteAssets(['g-1'])
    expect(res).toEqual({ ok: 1, skipped: 0, failed: 0 })
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].type).toBe('info')
  })
})

// ═══════════════════════════════════════════════════════════
// 6. 导入的错误与告警面
// ═══════════════════════════════════════════════════════════

describe('importZip 的错误与汇总', () => {
  it('截断的压缩包 → 包成人话，绝不让 AssetZipError 逃出去', async () => {
    const whole = typicalZip()
    // 砍掉后半截：fflate 在最后一块 push 时会发现压缩长度没喂满（err 13）
    const truncated = whole.slice(0, Math.floor(whole.length / 2))
    const store = useAssetStore()
    const res = await store.importZip(truncated)
    expect(res.read).toBe(false)
    expect(res.assetsAdded).toBe(0)
    expect(res.message).toContain('导入失败')
    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('error')
  })

  it('压根不是 zip 的字节 → 读成"零条目"，如实报全部跳过而不是假装失败', async () => {
    // asset-zip 的已知限制: 只丢中央目录/根本没有局部头的输入读不出条目，也报不出错。
    // 这种输入不该被谎称成"导入失败"，也不该抛 —— 库没变，就说库没变。
    const store = useAssetStore()
    const res = await store.importZip(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(res.assetsAdded + res.audioAdded).toBe(0)
    expect(res.failed).toBe(0)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toContain('全部跳过')
  })

  it('单条写入失败不中断其余，且摘要如实说出部分成功', async () => {
    failFlags.saveFailNames.add('林清')
    const store = useAssetStore()
    const res = await store.importZip(
      makeZip({
        '苏婉_头像.png': fakeBytes(1),
        '林清_头像.png': fakeBytes(2),
        '战斗主题.mp3': fakeBytes(3),
      }),
    )
    expect(res.assetsAdded).toBe(1)
    expect(res.audioAdded).toBe(1) // 素材半边失败没连累音频半边
    expect(res.failed).toBe(1)
    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('error')
    expect(list[0].message).toContain('1 个文件没能写入')
  })

  it('噪音与不认的扩展名只计入「忽略无关文件」，不让导入失败', async () => {
    const store = useAssetStore()
    const res = await store.importZip(
      makeZip({
        'assets/苏婉_头像.png': fakeBytes(1), // 目录被拍平
        'readme.txt': strToU8('说明'),
        '__MACOSX/._苏婉_头像.png': fakeBytes(9),
        '.DS_Store': fakeBytes(8),
      }),
    )
    expect(res.assetsAdded).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.ignored).toBeGreaterThanOrEqual(3)
    expect(res.message).toContain('忽略无关文件')
  })

  it('一条都没动时说「全部跳过」，且只有一条提示', async () => {
    const store = useAssetStore()
    await store.importZip(typicalZip())
    useUIStore().toasts.length = 0

    const again = await store.importZip(typicalZip())
    expect(again.assetsAdded + again.audioAdded).toBe(0)
    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].message).toContain('全部跳过')
  })

  it('音频半边写完会调音频 store 的公开刷库动作', async () => {
    const store = useAssetStore()
    await store.importZip(makeZip({ '战斗主题.mp3': fakeBytes(3) }))
    expect(audioRefreshTracks).toHaveBeenCalledTimes(1)
  })
})

// ═══════════════════════════════════════════════════════════
// 6b. 署名（D10）: 清单带进来 → 落库 → 再随导出带出去
// ═══════════════════════════════════════════════════════════

describe('署名的完整链条', () => {
  it('音频的 credit / license 落库，并随导出清单带回去', async () => {
    const store = useAssetStore()
    await store.importZip(typicalZip())

    // 落库（AudioTrack 新增的两列）
    const track = (await getAudioTracks())[0]
    expect(track.credit).toBe('Aoo')
    expect(track.license).toBeUndefined() // 清单里没写 license 就不该凭空补

    // 素材那半边同样
    expect(store.assets.find((a) => a.variant === undefined)?.license).toBe('CC-BY')

    // 导出清单里两边都在
    const res = await store.exportZip()
    const back = await readAssetZip(new Uint8Array(await res.blob!.arrayBuffer()))
    expect(back.manifest?.audio['战斗主题.mp3']).toEqual({ tags: ['情境:战斗'], credit: 'Aoo' })
    expect(back.manifest?.assets['苏婉_头像.png']).toEqual({ credit: '画师甲', license: 'CC-BY' })
  })

  it('署名走完一整圈往返仍然幂等（不因为多了两列而重复导入）', async () => {
    const store = useAssetStore()
    await store.importZip(typicalZip())
    const res = await store.exportZip()
    const again = await store.importZip(new Uint8Array(await res.blob!.arrayBuffer()))
    expect(again.assetsAdded + again.audioAdded).toBe(0)
    expect(again.duplicatesSkipped).toBe(3)
  })
})

// ═══════════════════════════════════════════════════════════
// 6c. 取消 (§7.6)
// ═══════════════════════════════════════════════════════════

describe('cancelImport', () => {
  it('写库中途取消：已写入的留着，报「已取消」而不是失败', async () => {
    const store = useAssetStore()
    // 第一条素材落库之后立刻取消 —— 写库是大包里耗时的那一半，取消必须在这里也生效
    failFlags.afterSaveAsset = () => {
      store.cancelImport()
    }

    const res = await store.importZip(
      makeZip({
        '苏婉_头像.png': fakeBytes(1),
        '林清_头像.png': fakeBytes(2),
        '战斗主题.mp3': fakeBytes(3),
      }),
    )

    expect(res.cancelled).toBe(true)
    expect(res.failed).toBe(0) // 取消不是失败
    expect(res.assetsAdded).toBe(1)
    expect(res.audioAdded).toBe(0) // 音频半边也不再往下写
    // 已写入的**如实留着**，不回滚
    expect(await getAssets()).toHaveLength(1)

    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('info') // 用户自己按的取消不该是红字
    expect(list[0].message).toContain('已取消导入')
    expect(list[0].message).toContain('留在库里')
  })

  it('取消后重新导入同一个包即可补齐（已有的算重复）', async () => {
    const store = useAssetStore()
    failFlags.afterSaveAsset = () => {
      store.cancelImport()
    }
    const zip = makeZip({ '苏婉_头像.png': fakeBytes(1), '林清_头像.png': fakeBytes(2) })
    await store.importZip(zip)
    failFlags.afterSaveAsset = null

    const res = await store.importZip(zip)
    expect(res.cancelled).toBe(false)
    expect(res.assetsAdded).toBe(1)
    expect(res.duplicatesSkipped).toBe(1)
    expect(await getAssets()).toHaveLength(2)
  })

  it('取消发生在解压段：readAssetZip 以 code aborted 拒绝，仍报「已取消」且库没变', async () => {
    const store = useAssetStore()
    // 解压是异步的，下一个宏任务就取消 —— 落在 readAssetZip 的检查点上
    const p = store.importZip(typicalZip())
    store.cancelImport()
    const res = await p

    expect(res.cancelled).toBe(true)
    expect(res.failed).toBe(0)
    expect(res.assetsAdded + res.audioAdded).toBe(0)
    expect(await getAssets()).toHaveLength(0)
    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('info')
    expect(list[0].message).toContain('已取消导入')
  })

  it('cancelImport 在 store 返回对象里（不然调用方看不见它）', () => {
    const store = useAssetStore()
    expect(typeof store.cancelImport).toBe('function')
    expect('cancelImport' in store).toBe(true)
  })

  it('没有在飞导入时 cancelImport() 是无害空操作', () => {
    const store = useAssetStore()
    expect(() => store.cancelImport()).not.toThrow()
    expect(store.importing).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════
// 6e. importFiles —— 单文件导入走同一条管线 (§7.3)
// ═══════════════════════════════════════════════════════════

describe('importFiles', () => {
  const asFile = (name: string, bytes: Uint8Array): File =>
    new File([bytes.slice().buffer as ArrayBuffer], name)

  it('图片 + 音频 + 杂项混选: 各归各位，杂项算「忽略」而不是失败', async () => {
    const store = useAssetStore()
    const res = await store.importFiles([
      asFile('苏婉_头像.png', fakeBytes(1)),
      asFile('苏婉_立绘_微笑.png', fakeBytes(2)),
      asFile('战斗主题.mp3', fakeBytes(3)), // 按扩展名路由 → 落音频库，不是素材
      asFile('设定稿.psd', fakeBytes(4)),
      asFile('readme.txt', strToU8('说明')),
    ])

    expect(res.read).toBe(true)
    expect(res.assetsAdded).toBe(2)
    expect(res.audioAdded).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.ignored).toBe(2) // psd + txt：跳过，不是拒绝
    expect(res.message).toContain('忽略无关文件 2')

    expect(await getAssets()).toHaveLength(2)
    const tracks = await getAudioTracks()
    expect(tracks).toHaveLength(1)
    expect(tracks[0].name).toBe('战斗主题')
    expect(tracks[0].source).toBe('blob')
    expect(audioRefreshTracks).toHaveBeenCalledTimes(1)
    expect(toasts()).toHaveLength(1)
  })

  it('复用同一条管线: 去重 / 编号 / D16 拒收 全都白拿', async () => {
    const store = useAssetStore()
    await store.importFiles([asFile('苏婉_头像.png', fakeBytes(1))])

    const again = await store.importFiles([
      asFile('苏婉_头像.png', fakeBytes(1)), // 同字节 → 哈希去重
      asFile('苏婉_头像.png', fakeBytes(9)), // 不同字节 → 编号进变体位
      asFile('苏婉_头像_立绘.png', fakeBytes(7)), // D16: name 里含类型 token
    ])
    expect(again.duplicatesSkipped).toBe(1)
    expect(again.renumbered).toBe(1)
    expect(again.namingConflicts).toBe(1)
    // Array#sort 永远把 undefined 排到末尾 —— 基图那行没有变体
    expect(store.assets.map((a) => a.variant).sort()).toEqual(['2', undefined])
  })

  it('单文件路径没有清单，所以没有署名（要带署名就打包成 zip）', async () => {
    const store = useAssetStore()
    await store.importFiles([asFile('苏婉_头像.png', fakeBytes(1))])
    expect(store.assets[0].credit).toBeUndefined()
    expect(store.assets[0].license).toBeUndefined()
  })

  it('空选择 → 什么都不做，一条「全部跳过」提示', async () => {
    const store = useAssetStore()
    const res = await store.importFiles([])
    expect(res.assetsAdded + res.audioAdded).toBe(0)
    expect(res.failed).toBe(0)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toContain('全部跳过')
  })
})

// ═══════════════════════════════════════════════════════════
// 6f. importAny —— 混合拖拽只产出**一条**提示 (§7.2)
// ═══════════════════════════════════════════════════════════

describe('importAny', () => {
  const asFile = (name: string, bytes: Uint8Array, type = ''): File =>
    new File([bytes.slice().buffer as ArrayBuffer], name, { type })

  it('一个 zip + 两个散文件 → 恰好一条提示，计数相加', async () => {
    const store = useAssetStore()
    const res = await store.importAny([
      asFile('pack.zip', typicalZip(), 'application/zip'),
      asFile('林清_头像.png', fakeBytes(11)),
      asFile('林清_立绘_微笑.png', fakeBytes(12)),
    ])

    // zip: 2 素材 + 1 音频；散装: 2 素材
    expect(res.assetsAdded).toBe(4)
    expect(res.audioAdded).toBe(1)
    expect(res.failed).toBe(0)
    expect(res.read).toBe(true)
    expect(await getAssets()).toHaveLength(4)
    expect(await getAudioTracks()).toHaveLength(1)

    // §7.2: 一次导入 = 一条摘要，无论它由几个半边组成
    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].type).toBe('info')
    expect(list[0].message).toContain('素材 4 新增')
    expect(list[0].message).toContain('音频 1 新增')
    expect(res.message).toBe(list[0].message)
  })

  it('坏 zip + 好散文件: 散文件照常导入，坏包如实点名，仍然只有一条提示', async () => {
    const whole = typicalZip()
    const store = useAssetStore()
    const res = await store.importAny([
      asFile('broken.zip', whole.slice(0, Math.floor(whole.length / 2)), 'application/zip'),
      asFile('林清_头像.png', fakeBytes(11)),
    ])

    // 读取失败**不掩盖**另一半的成功
    expect(res.assetsAdded).toBe(1)
    expect(res.read).toBe(false)
    expect(res.readErrors).toHaveLength(1)
    expect(await getAssets()).toHaveLength(1)

    const list = toasts()
    expect(list).toHaveLength(1)
    expect(list[0].message).toContain('素材 1 新增') // 成功的那半边照样报出来
    expect(list[0].message).toContain('读取失败') // 坏包也没被藏起来
  })

  it('告警取并集，两个半边都缺哈希只说一次', async () => {
    // 让整个环境算不出哈希 → 两个半边各自都会报 hash-unavailable
    // 只抽掉 subtle（非安全上下文的真实样子），randomUUID 留着 —— 它是 id 与 toast 的来源
    const realCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: { randomUUID: () => realCrypto.randomUUID() },
      configurable: true,
      writable: true,
    })
    try {
      const store = useAssetStore()
      const res = await store.importAny([
        asFile('pack.zip', makeZip({ '苏婉_头像.png': fakeBytes(1) })),
        asFile('林清_头像.png', fakeBytes(11)),
      ])
      expect(res.assetsAdded).toBe(2)
      expect(res.warnings.filter((w) => w === 'hash-unavailable')).toHaveLength(1)
      expect(toasts()).toHaveLength(1)
      // 算不出哈希时不许承诺"再导一次会识别成重复"
      expect(toasts()[0].message).not.toContain('识别成重复而跳过')
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
        writable: true,
      })
    }
  })

  it('isZipFile: 扩展名优先，MIME 兜底（Windows 会报 x-zip-compressed 甚至空 type）', () => {
    expect(isZipFile(asFile('pack.zip', fakeBytes(1), ''))).toBe(true)
    expect(isZipFile(asFile('PACK.ZIP', fakeBytes(1), ''))).toBe(true)
    expect(isZipFile(asFile('pack', fakeBytes(1), 'application/x-zip-compressed'))).toBe(true)
    expect(isZipFile(asFile('pack', fakeBytes(1), 'application/zip'))).toBe(true)
    expect(isZipFile(asFile('苏婉_头像.png', fakeBytes(1), 'image/png'))).toBe(false)
  })

  it('全是散文件 / 全是 zip 时行为与单入口一致', async () => {
    const store = useAssetStore()
    const onlyFiles = await store.importAny([asFile('苏婉_头像.png', fakeBytes(1))])
    expect(onlyFiles.assetsAdded).toBe(1)
    useUIStore().toasts.length = 0

    const onlyZip = await store.importAny([asFile('p.zip', makeZip({ '林清_头像.png': fakeBytes(2) }))])
    expect(onlyZip.assetsAdded).toBe(1)
    expect(toasts()).toHaveLength(1)
  })

  it('空数组 → 一条「全部跳过」，不炸', async () => {
    const store = useAssetStore()
    const res = await store.importAny([])
    expect(res.read).toBe(true)
    expect(res.assetsAdded + res.audioAdded).toBe(0)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toContain('全部跳过')
  })
})

// ═══════════════════════════════════════════════════════════
// 6d. 进度口径: 百分比绝不倒退
// ═══════════════════════════════════════════════════════════

describe('导入进度', () => {
  it('对外的百分比只在写库段存在，且**只增不减**（解压段无分母）', async () => {
    const store = useAssetStore()

    /**
     * UI 会显示的那个值 —— 解压段没有分母（asset-zip 的 total 会随发现新条目往上长，
     * 拿它做分母就会倒退），所以只有写库段给百分比。断言的是**这个派生值**而不是三个
     * ref 的裸快照: 三个 ref 分三次赋值，用 `flush: 'sync'` 去偷看必然能抓到中间态，
     * 而 Vue 的渲染（以及默认 flush 的 watcher）从不在两次赋值之间读值 —— 这里用默认
     * flush，看到的就是界面真正看到的。
     */
    const pctOf = (): number | null =>
      store.progressPhase === 'write' && store.progressTotal > 0
        ? (store.progressDone / store.progressTotal) * 100
        : null

    const seen: (number | null)[] = []
    const stop = watch(
      () => [store.progressPhase, store.progressDone, store.progressTotal] as const,
      () => {
        seen.push(pctOf())
      },
    )

    await store.importZip(
      makeZip({
        '苏婉_头像.png': fakeBytes(1),
        '林清_头像.png': fakeBytes(2),
        '战斗主题.mp3': fakeBytes(3),
      }),
    )
    await nextTick()
    stop()

    // 有分母的那些采样单调不减 —— 这就是"绝不给出会倒退的百分比"的可断言形式
    const pcts = seen.filter((v): v is number => v !== null)
    expect(pcts.length).toBeGreaterThan(0)
    for (let i = 1; i < pcts.length; i += 1) expect(pcts[i]).toBeGreaterThanOrEqual(pcts[i - 1])
    for (const v of pcts) expect(v).toBeLessThanOrEqual(100)

    // 收尾复位: phase 回 idle → 界面不再显示任何百分比
    expect(store.progressPhase).toBe('idle')
    expect(pctOf()).toBeNull()
    expect(store.progressDone).toBe(3)
    expect(store.progressTotal).toBe(3)
  })

  it('解压段确实经历过「无分母」态（读取中不显示百分比）', async () => {
    const store = useAssetStore()
    const phases: string[] = []
    const stop = watch(
      () => store.progressPhase,
      (p) => {
        phases.push(p)
      },
    )
    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }))
    await nextTick()
    stop()
    // read → write → idle，顺序即两段口径的切换点
    expect(phases).toEqual(['read', 'write', 'idle'])
  })
})

// ═══════════════════════════════════════════════════════════
// 7. 配额与持久化 (§4.5)
// ═══════════════════════════════════════════════════════════

describe('storage persist / estimate', () => {
  it('persist() 被拒 → 如实记录 false，不抛', async () => {
    const persist = vi.fn(async () => false)
    stubNavigatorStorage({ persist, persisted: async () => false, estimate: async () => ({}) })

    const store = useAssetStore()
    expect(store.storagePersisted).toBeNull()

    const res = await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }))
    expect(res.assetsAdded).toBe(1) // 被拒绝不阻塞导入
    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.storagePersisted).toBe(false)
  })

  it('只在首次导入成功后请求一次持久化，不在启动期', async () => {
    const persist = vi.fn(async () => true)
    stubNavigatorStorage({ persist, persisted: async () => false })

    const store = useAssetStore()
    await store.init()
    expect(persist).not.toHaveBeenCalled() // 启动期不问

    await store.importZip(makeZip({ '苏婉_头像.png': fakeBytes(1) }))
    expect(persist).toHaveBeenCalledTimes(1)
    expect(store.storagePersisted).toBe(true)

    await store.importZip(makeZip({ '林清_头像.png': fakeBytes(2) }))
    expect(persist).toHaveBeenCalledTimes(1) // 第二次不再问
  })

  it('浏览器不支持 → estimate 返回 null，persist 记成"不知道"', async () => {
    stubNavigatorStorage(undefined)
    const store = useAssetStore()
    expect(await store.getStorageEstimate()).toBeNull()
    expect(await store.requestPersistence()).toBeNull()
    expect(store.storagePersisted).toBeNull()
  })

  it('estimate 换算百分比', async () => {
    stubNavigatorStorage({ estimate: async () => ({ usage: 25, quota: 100 }) })
    const store = useAssetStore()
    expect(await store.getStorageEstimate()).toEqual({ used: 25, quota: 100, pct: 25 })
  })
})

// ═══════════════════════════════════════════════════════════
// 8. 分组视图 (§7.3)
// ═══════════════════════════════════════════════════════════

describe('分组视图', () => {
  it('按原始 name 严格分组，并给出每组变体数', async () => {
    for (const r of [
      makeAssetRow({ id: 'v1', name: '苏婉' }),
      makeAssetRow({ id: 'v2', name: '苏婉', variant: '微笑' }),
      makeAssetRow({ id: 'v3', name: '苏婉', type: '立绘', variant: '2' }),
      makeAssetRow({ id: 'v4', name: '苏婉 ' }), // 尾空格 —— 不归一化，就是另一个组
    ]) {
      await saveAsset(r)
    }
    const store = useAssetStore()
    await store.init()

    const names = store.groups.map((g) => g.name)
    expect(names).toContain('苏婉')
    expect(names).toContain('苏婉 ')
    const su = store.groups.find((g) => g.name === '苏婉')!
    expect(su.total).toBe(3)
    expect(su.variantCount).toBe(2)
    expect(su.baseTypes).toEqual(['头像'])
    expect(su.baselessTypes).toEqual(['立绘'])
    expect(store.flat).toHaveLength(4)
  })
})

// ═══════════════════════════════════════════════════════════
// 9. object URL 缓存接线 (§7.5)
// ═══════════════════════════════════════════════════════════

describe('object URL', () => {
  it('assetUrl 走注入的 loadBlob；字节缺失返回 null 且不缓存', async () => {
    const row = makeAssetRow({ id: 'u-1' })
    await saveAsset(row) // 只有元数据，没有字节
    const store = useAssetStore()
    await store.init()

    expect(await store.assetUrl('u-1')).toBeNull()
    expect(store.peekAssetUrl('u-1')).toBeNull()
    store.revokeAllUrls() // 拆除是无害的
  })
})
