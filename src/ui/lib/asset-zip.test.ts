/**
 * asset-zip.test.ts — zip 读写契约测试
 *
 * 覆盖: 写→读往返字节完全一致 / 嵌套路径拍平 / 噪音跳过 / 单条目与总量上限
 * 中途终止 / 已知字节的稳定摘要 / crypto.subtle 缺失降级 / 畸形清单降级 /
 * 清单只能加元数据不能改名。
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { planImport, type ImportManifest, type ImportWarning } from '@engine/asset-import-plan'
import {
  readAssetZip,
  writeAssetZip,
  parseAssetZipManifest,
  AssetZipError,
  ASSET_ZIP_MANIFEST_NAME,
  type AssetZipManifest,
  type AssetZipWarning,
} from './asset-zip'
import { hashMediaBlob } from './media-hash'

// ═══════════════════════════════════════════════════════════
// 辅助
// ═══════════════════════════════════════════════════════════

/** 可预测的伪媒体字节（非零、可压缩性一般） */
function fakeBytes(seed: number, size: number): Uint8Array {
  const out = new Uint8Array(size)
  for (let i = 0; i < size; i += 1) out[i] = (seed * 31 + i * 17) % 251
  return out
}

/** 极易压缩的缓冲区 —— 用来在小 zip 里塞出大解压量（炸弹替身） */
function compressible(size: number): Uint8Array {
  return new Uint8Array(size)
}

const utf8 = (text: string): Uint8Array => strToU8(text)

/**
 * 造一个"UTF-8 标志位未置位、文件名却是 GBK 字节"的 zip。
 *
 * 做法: 先用 ASCII 占位名打包（fflate 对纯 ASCII 名字不置标志位），再把两处
 * 文件名字节（局部头 + 中央目录）原地换成 GBK 字节。长度一致，偏移不受影响。
 */
function zipWithUnflaggedGbkName(): { zipped: Uint8Array; gbkLatin1: string } {
  const placeholder = 'AAAAAAAAA.png' // 13 字节，与下面的 GBK 字节数相同
  const zipped = zipSync({ [placeholder]: fakeBytes(3, 64) })
  // 「苏婉_头像.png」的 CP936 编码
  const gbk = new Uint8Array([
    0xcb, 0xd5, 0xe6, 0xf1, 0x5f, 0xcd, 0xb7, 0xcf, 0xf1, 0x2e, 0x70, 0x6e, 0x67,
  ])
  const asciiBytes = new Uint8Array([...placeholder].map((c) => c.charCodeAt(0)))
  const out = zipped.slice()
  outer: for (let i = 0; i + asciiBytes.length <= out.length; i += 1) {
    for (let j = 0; j < asciiBytes.length; j += 1) {
      if (out[i + j] !== asciiBytes[j]) continue outer
    }
    out.set(gbk, i)
  }
  // fflate 会用 latin1 逐字节解码这串字节
  const gbkLatin1 = [...gbk].map((b) => String.fromCharCode(b)).join('')
  return { zipped: out, gbkLatin1 }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

// ═══════════════════════════════════════════════════════════
// 与计划器的契约对接
// ═══════════════════════════════════════════════════════════

describe('契约与 asset-import-plan 对齐', () => {
  it('读出来的东西可以直接喂给 planImport（类型与运行时都通）', async () => {
    const manifest: AssetZipManifest = {
      assets: { '苏婉_头像.png': { credit: '画师甲' } },
      audio: { '战斗主题.mp3': { tags: ['情境:战斗'] } },
    }
    const blob = await writeAssetZip(
      [
        { name: '苏婉_头像.png', bytes: fakeBytes(1, 256) },
        { name: '战斗主题.mp3', bytes: fakeBytes(2, 256) },
      ],
      manifest,
    )
    const read = await readAssetZip(blob)

    // 没有任何转换/适配 —— DecodedEntry 与 ImportManifest 就是同一份契约
    const plan = planImport(read.entries, { assets: [], audio: [] }, read.manifest)
    expect(plan.assets.map((a) => a.name)).toEqual(['苏婉'])
    expect(plan.audio.map((a) => a.name)).toEqual(['战斗主题'])
    expect(plan.assets[0].credit).toBe('画师甲')

    // 告警也能直接并进计划器的数组，不必映射
    const warnings: ImportWarning[] = [...read.warnings]
    expect(warnings).toEqual([])
  })

  /**
   * 回归钉子: 上传进来的音轨必须带 hash，否则往返会克隆。
   *
   * 缺陷原貌 —— 哈希只住在 asset-zip.ts 里，`音频→上传` 那条路径写行时不算 hash。
   * 那些轨是 `source:'blob'`，会被打进导出包；重新导入时计划器无 hash 可比，
   * 回落 `uniqueAudioName`，于是多出一条 `战斗主题 (2)`。素材那半边靠 hash 幂等、
   * 音频这半边却在克隆 = D12/§4.4 点名的"半套幂等"。
   *
   * 这里用 `hashMediaBlob`（上传路径现在调的正是它）产生库里那行的 hash，再走
   * 完整的 导出 → 导入 → planImport，断言**零新增行**。
   */
  it('上传式音轨（hash 由 media-hash 现算）往返导入零新增行', async () => {
    const bytes = fakeBytes(9, 4096)
    // 模拟 uploadFiles: 拿到 File，用 media-hash 现算 hash 写进行里
    const uploaded = new Blob([bytes.slice().buffer as ArrayBuffer])
    const hash = await hashMediaBlob(uploaded)
    expect(hash).toBeTruthy() // 本环境算得出，测试才有意义

    const existingAudioRow = { id: 'audio_1', name: '战斗主题', source: 'blob' as const, hash }

    const blob = await writeAssetZip([{ name: '战斗主题.mp3', bytes }])
    const read = await readAssetZip(blob)
    const plan = planImport(read.entries, { assets: [], audio: [existingAudioRow] })

    expect(plan.audio).toHaveLength(0)
    expect(plan.summary.audioAdded).toBe(0)
    expect(plan.skips.map((s) => s.reason)).toEqual(['duplicate'])
  })

  it('反向对照: 库里那行没有 hash 时才会克隆出 ` (2)` —— 正是修掉的那个缺陷', async () => {
    const bytes = fakeBytes(9, 4096)
    // 修复前的形状: 上传写行时不算 hash
    const hashlessRow = { id: 'audio_1', name: '战斗主题', source: 'blob' as const }

    const blob = await writeAssetZip([{ name: '战斗主题.mp3', bytes }])
    const read = await readAssetZip(blob)
    const plan = planImport(read.entries, { assets: [], audio: [hashlessRow] })

    // 同一份字节却又进来一行 —— 这就是被修掉的半套幂等
    expect(plan.audio).toHaveLength(1)
    expect(plan.audio[0].name).toBe('战斗主题 (2)')
  })

  it('类型层面: 告警是引擎联合的子集，清单是引擎清单的收紧版', () => {
    // 编译期断言 —— 引擎那边改了联合/分区，这里会红
    const asEngineWarning: ImportWarning = 'hash-unavailable' satisfies AssetZipWarning
    const asEngineManifest: ImportManifest = { assets: {}, audio: {} } satisfies AssetZipManifest
    expect(asEngineWarning).toBe('hash-unavailable')
    expect(asEngineManifest).toEqual({ assets: {}, audio: {} })
  })
})

// ═══════════════════════════════════════════════════════════
// 往返
// ═══════════════════════════════════════════════════════════

describe('writeAssetZip → readAssetZip 往返', () => {
  it('字节完全一致，清单原样带回', async () => {
    const avatar = fakeBytes(1, 4096)
    const portrait = fakeBytes(2, 8192)
    const track = fakeBytes(3, 2048)
    const manifest: AssetZipManifest = {
      assets: { '苏婉_头像.png': { credit: '画师甲', license: 'CC-BY' } },
      audio: { '战斗主题.mp3': { tags: ['情境:战斗', '情绪:紧张'], credit: 'Aoo' } },
    }

    const blob = await writeAssetZip(
      [
        { name: '苏婉_头像.png', bytes: avatar },
        { name: '苏婉_立绘.webp', bytes: portrait },
        { name: '战斗主题.mp3', bytes: track },
      ],
      manifest,
    )
    expect(blob.type).toBe('application/zip')

    const result = await readAssetZip(blob)
    const byPath = new Map(result.entries.map((e) => [e.path, e.bytes]))

    expect([...byPath.keys()].sort()).toEqual(
      ['苏婉_头像.png', '苏婉_立绘.webp', '战斗主题.mp3'].sort(),
    )
    expect(byPath.get('苏婉_头像.png')).toEqual(avatar)
    expect(byPath.get('苏婉_立绘.webp')).toEqual(portrait)
    expect(byPath.get('战斗主题.mp3')).toEqual(track)

    expect(result.manifest).toEqual(manifest)
    // manifest.json 自己不是待导入条目
    expect(byPath.has(ASSET_ZIP_MANIFEST_NAME)).toBe(false)
    // 中文名走 fflate 的 UTF-8 标志位，不该触发编码告警
    expect(result.warnings).not.toContain('suspect-filename-encoding')
  })

  it('读侧接受 Uint8Array 与 Blob 两种入参', async () => {
    const bytes = fakeBytes(7, 512)
    const blob = await writeAssetZip([{ name: 'a.png', bytes }])
    const fromBlob = await readAssetZip(blob)
    const fromBytes = await readAssetZip(new Uint8Array(await blob.arrayBuffer()))
    expect(fromBytes.entries.map((e) => e.path)).toEqual(fromBlob.entries.map((e) => e.path))
    expect(fromBytes.entries[0].bytes).toEqual(bytes)
  })

  it('导出不接受重名（zip 目录是字典，静默覆盖等于丢文件）', async () => {
    await expect(
      writeAssetZip([
        { name: 'a.png', bytes: fakeBytes(1, 8) },
        { name: 'sub/a.png', bytes: fakeBytes(2, 8) },
      ]),
    ).rejects.toMatchObject({ code: 'duplicate-name' })
  })

  it('导出拒绝空文件名', async () => {
    await expect(writeAssetZip([{ name: 'dir/', bytes: fakeBytes(1, 8) }])).rejects.toMatchObject({
      code: 'invalid-name',
    })
  })
})

// ═══════════════════════════════════════════════════════════
// 名字保真 (D2) —— 导出端不许执行导入端拒绝的归一化
// ═══════════════════════════════════════════════════════════

describe('导出不改名', () => {
  it('前后空白原样往返，不会变成一个被 trim 过的副本', async () => {
    const bytes = fakeBytes(1, 512)
    const blob = await writeAssetZip([{ name: ' 苏婉_头像.png ', bytes }])
    const result = await readAssetZip(blob)

    // 一进一出必须是同一个名字 —— 曾经这里 trim 过，于是 ` 苏婉` 出门变 `苏婉`，
    // 再导入就成了另一行；两行都在时还会有一行被当碰撞悄悄丢掉
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].path).toBe(' 苏婉_头像.png ')
    expect(result.entries[0].bytes).toEqual(bytes)
  })

  it('只差前后空白的两行都活着且互不相同', async () => {
    const a = fakeBytes(1, 256)
    const b = fakeBytes(2, 256)
    const c = fakeBytes(3, 256)
    const blob = await writeAssetZip([
      { name: '苏婉_头像.png', bytes: a },
      { name: ' 苏婉_头像.png', bytes: b },
      { name: '苏婉_头像.png ', bytes: c },
    ])
    const result = await readAssetZip(blob)

    expect(result.entries).toHaveLength(3)
    const byPath = new Map(result.entries.map((e) => [e.path, e.bytes]))
    expect(byPath.get('苏婉_头像.png')).toEqual(a)
    expect(byPath.get(' 苏婉_头像.png')).toEqual(b)
    expect(byPath.get('苏婉_头像.png ')).toEqual(c)
  })

  it('纯空白名字是合法的 zip 条目名，照样往返（不再被 trim 成空而抛错）', async () => {
    const bytes = fakeBytes(4, 128)
    const blob = await writeAssetZip([{ name: '  .png', bytes }])
    const result = await readAssetZip(blob)
    expect(result.entries[0].path).toBe('  .png')
  })

  it('扩展名带尾随空白照样认得出，且名字原样保留（归一化只用于判路由）', async () => {
    // 字面扩展名是 `png `/`mp3 `，直接查表查不着 —— 曾经因此被整条当噪音丢掉，
    // 而引擎的 isAssetExtension 内部本来就 trim，本模块比它更严就是漂移
    const zipped = zipSync({
      '苏婉_头像.png ': fakeBytes(1, 64),
      '战斗主题.mp3 ': fakeBytes(2, 64),
      '不认识.psd ': fakeBytes(3, 64),
    })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path).sort()).toEqual(
      ['苏婉_头像.png ', '战斗主题.mp3 '].sort(),
    )
    expect(result.skippedNoise).toEqual(['不认识.psd '])
  })

  it('扩展名大小写照样认（PNG/Mp3），名字仍原样', async () => {
    const zipped = zipSync({ '苏婉_头像.PNG': fakeBytes(1, 64), '战斗.Mp3': fakeBytes(2, 64) })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path).sort()).toEqual(['苏婉_头像.PNG', '战斗.Mp3'].sort())
  })

  it('大小写不折叠 —— 导出端同样不做归一化', async () => {
    const blob = await writeAssetZip([
      { name: 'Su_头像.PNG', bytes: fakeBytes(1, 64) },
      { name: 'su_头像.png', bytes: fakeBytes(2, 64) },
    ])
    const result = await readAssetZip(blob)
    expect(result.entries.map((e) => e.path).sort()).toEqual(['Su_头像.PNG', 'su_头像.png'].sort())
  })
})

describe('导出遇到路径分隔符时出声（D19 兜底）', () => {
  it('拍平照做，但逐条上报给调用方，好计进导出摘要', async () => {
    const reports: Array<{ original: string; flattened: string }> = []
    const blob = await writeAssetZip(
      [
        { name: 'sub/苏婉_头像.png', bytes: fakeBytes(1, 64) },
        { name: 'a\\b\\战斗.mp3', bytes: fakeBytes(2, 64) },
        { name: '正常_头像.png', bytes: fakeBytes(3, 64) },
      ],
      undefined,
      { onSeparatorInName: (r) => reports.push(r) },
    )

    expect(reports).toEqual([
      { original: 'sub/苏婉_头像.png', flattened: '苏婉_头像.png' },
      { original: 'a\\b\\战斗.mp3', flattened: '战斗.mp3' },
    ])
    // 名字合规的那条不上报
    expect(reports.map((r) => r.original)).not.toContain('正常_头像.png')

    const result = await readAssetZip(blob)
    expect(result.entries.map((e) => e.path).sort()).toEqual(
      ['苏婉_头像.png', '战斗.mp3', '正常_头像.png'].sort(),
    )
  })

  it('没人接回调时退化为 console.warn 一条汇总 —— 可以没人接，不能没人知道', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await writeAssetZip([{ name: 'sub/苏婉_头像.png', bytes: fakeBytes(1, 64) }])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).toContain('sub/苏婉_头像.png')
    } finally {
      warn.mockRestore()
    }
  })

  it('全都合规时既不回调也不 warn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSeparatorInName = vi.fn()
    try {
      await writeAssetZip([{ name: ' 苏婉_头像.png ', bytes: fakeBytes(1, 64) }], undefined, {
        onSeparatorInName,
      })
      expect(onSeparatorInName).not.toHaveBeenCalled()
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 拍平与噪音
// ═══════════════════════════════════════════════════════════

describe('路径处理', () => {
  it('嵌套路径拍平成 basename —— 有子目录与拖一堆文件表现一致', async () => {
    const nested = zipSync({
      assets: { '苏婉_头像.png': fakeBytes(1, 128) },
      audio: { '战斗主题.mp3': fakeBytes(2, 128) },
    })
    const flat = zipSync({
      '苏婉_头像.png': fakeBytes(1, 128),
      '战斗主题.mp3': fakeBytes(2, 128),
    })

    const a = await readAssetZip(nested)
    const b = await readAssetZip(flat)
    expect(a.entries.map((e) => e.path).sort()).toEqual(b.entries.map((e) => e.path).sort())
    expect(a.entries.map((e) => e.path).sort()).toEqual(['战斗主题.mp3', '苏婉_头像.png'].sort())
  })

  it('__MACOSX / dotfile / 目录条目静默跳过', async () => {
    const zipped = zipSync({
      '苏婉_头像.png': fakeBytes(1, 64),
      __MACOSX: { '._苏婉_头像.png': fakeBytes(9, 64) },
      '.DS_Store': fakeBytes(9, 64),
      空目录: {},
    })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path)).toEqual(['苏婉_头像.png'])
  })

  it('隐藏目录里的正常文件照样导入 —— dotfile 只看文件名本身', async () => {
    const zipped = zipSync({ '.hidden': { '苏婉_头像.png': fakeBytes(1, 64) } })
    const result = await readAssetZip(zipped)
    // 刻意如此: 目录名在拍平后无意义，拿它当理由丢掉一个正常媒体文件才是数据损失
    expect(result.entries.map((e) => e.path)).toEqual(['苏婉_头像.png'])
  })

  it('嵌套的 manifest.json 不当根清单，根清单才算', async () => {
    const zipped = zipSync({
      sub: { 'manifest.json': utf8('{"assets":{"x.png":{"credit":"嵌套"}},"audio":{}}') },
      'manifest.json': utf8('{"assets":{"苏婉_头像.png":{"credit":"根"}},"audio":{}}'),
      '苏婉_头像.png': fakeBytes(1, 32),
    })
    const result = await readAssetZip(zipped)
    expect(result.manifest?.assets['苏婉_头像.png']?.credit).toBe('根')
    // 只有根那份被消费；嵌套那份的扩展名不在路由表里，走 skippedNoise
    expect(result.entries.map((e) => e.path)).toEqual(['苏婉_头像.png'])
    expect(result.skippedNoise).toEqual(['manifest.json'])
  })
})

// ═══════════════════════════════════════════════════════════
// 噪音不得让导入失败
// ═══════════════════════════════════════════════════════════

describe('未识别扩展名（噪音）', () => {
  it('超大 .psd 与正常 png 同包 → png 照常导入，psd 记为跳过，绝不抛', async () => {
    const avatar = fakeBytes(1, 4096)
    const zipped = zipSync(
      {
        '苏婉_头像.png': avatar,
        // 远超单条目上限；旧行为会让整包以 entry-too-large 失败
        'notes.psd': compressible(50 * 1024 * 1024),
      },
      { level: 9 },
    )

    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path)).toEqual(['苏婉_头像.png'])
    expect(result.entries[0].bytes).toEqual(avatar)
    expect(result.skippedNoise).toEqual(['notes.psd'])
  })

  it('噪音不计入总量上限 —— 一堆巨型 psd 也压不垮一个小 png', async () => {
    const zipped = zipSync(
      {
        'a.png': fakeBytes(1, 1024),
        'x.psd': compressible(8 * 1024 * 1024),
        'y.pdf': compressible(8 * 1024 * 1024),
        'README': compressible(8 * 1024 * 1024),
      },
      { level: 9 },
    )
    const result = await readAssetZip(zipped, { maxTotalBytes: 64 * 1024 })
    expect(result.entries.map((e) => e.path)).toEqual(['a.png'])
    expect(result.skippedNoise.sort()).toEqual(['README', 'x.psd', 'y.pdf'])
  })

  it('噪音名单收文件不收目录，按 zip 内出现顺序', async () => {
    const zipped = zipSync({
      '苏婉_头像.png': fakeBytes(1, 32),
      readme: { 'guide.txt': utf8('hi') },
      '.DS_Store': fakeBytes(9, 16),
      __MACOSX: { '._苏婉_头像.png': fakeBytes(9, 16) },
    })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path)).toEqual(['苏婉_头像.png'])
    // `readme/` 这个目录条目本身不进名单
    expect(result.skippedNoise.sort()).toEqual(['._苏婉_头像.png', '.DS_Store', 'guide.txt'].sort())
    expect(result.skippedNoise).not.toContain('readme')
    expect(result.skippedNoise).not.toContain('readme/')
  })

  it('两张路由表的扩展名都放行（含 .webm 归音频、.mp4 归素材）', async () => {
    const zipped = zipSync({
      'a.png': fakeBytes(1, 16),
      'b.avif': fakeBytes(2, 16),
      'c.mp4': fakeBytes(3, 16),
      'd.flac': fakeBytes(4, 16),
      'e.webm': fakeBytes(5, 16),
      'f.svg': fakeBytes(6, 16), // 刻意不在素材表里
    })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path).sort()).toEqual(
      ['a.png', 'b.avif', 'c.mp4', 'd.flac', 'e.webm'].sort(),
    )
    expect(result.skippedNoise).toEqual(['f.svg'])
  })
})

// ═══════════════════════════════════════════════════════════
// 取消 (§7.6)
// ═══════════════════════════════════════════════════════════

describe('取消', () => {
  /** 4 个 200KB 的 stored 条目 → 约 800KB，跨多个 push 块，取消点才有意义 */
  function multiEntryZip(): Uint8Array {
    return zipSync(
      {
        'a_头像.png': fakeBytes(1, 200 * 1024),
        'b_头像.png': fakeBytes(2, 200 * 1024),
        'c_头像.png': fakeBytes(3, 200 * 1024),
        'd_头像.png': fakeBytes(4, 200 * 1024),
      },
      { level: 0 },
    )
  }

  it('传进来就已取消的信号 → 立即拒绝，一个字节都不解压', async () => {
    const controller = new AbortController()
    controller.abort()
    const onProgress = vi.fn()

    const error = await readAssetZip(multiEntryZip(), { signal: controller.signal, onProgress }).catch(
      (e: unknown) => e,
    )
    expect(error).toBeInstanceOf(AssetZipError)
    expect(error).toMatchObject({ code: 'aborted' })
    // 连"发现条目"都没发生过 —— 证明没进解压流程
    expect(onProgress).not.toHaveBeenCalled()
  })

  it('中途取消 → 以 aborted 拒绝，且与真失败区分得开', async () => {
    const controller = new AbortController()
    const seen: number[] = []

    const error = await readAssetZip(multiEntryZip(), {
      signal: controller.signal,
      onProgress: (done) => {
        seen.push(done)
        if (done >= 1) controller.abort() // 第一条解压完就点取消
      },
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AssetZipError)
    expect(error).toMatchObject({ code: 'aborted' })
    expect((error as AssetZipError).code).not.toBe('read-failed')
    // 确实是"干到一半被叫停"，不是压根没开始
    expect(Math.max(...seen)).toBeGreaterThanOrEqual(1)
    // 没有把 4 条全干完 —— 否则这测的就不是中途取消了
    expect(Math.max(...seen)).toBeLessThan(4)
  })

  it('取消之后模块状态干净，同一份数据仍能正常读第二遍', async () => {
    const zipped = multiEntryZip()
    const controller = new AbortController()
    await expect(
      readAssetZip(zipped, {
        signal: controller.signal,
        onProgress: (done) => {
          if (done >= 1) controller.abort()
        },
      }),
    ).rejects.toMatchObject({ code: 'aborted' })

    const result = await readAssetZip(zipped)
    expect(result.entries).toHaveLength(4)
  })

  it('取消会摘掉停滞看门狗，不留下一个还在武装的定时器', async () => {
    vi.resetModules()
    const actual = await vi.importActual<typeof import('fflate')>('fflate')

    // 永不回调的解码器: push 全部成功、条目挂着不收尾 → 看门狗一定已布防
    class SilentInflate {
      static compression = 8
      ondata: unknown = undefined
      push(): void {}
      terminate(): void {}
    }

    vi.doMock('fflate', () => ({ ...actual, AsyncUnzipInflate: SilentInflate }))
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout')
    try {
      const mod = await import('./asset-zip')
      const zipped = actual.zipSync({ 'a.png': compressible(4096) }, { level: 9 })
      const controller = new AbortController()
      const promise = mod.readAssetZip(zipped, {
        signal: controller.signal,
        stallTimeoutMs: 10_000,
      })

      // 等 push 走完 → settle() 里 armWatchdog() 已经布防
      await new Promise<void>((r) => setTimeout(r, 50))
      clearSpy.mockClear()
      controller.abort()

      await expect(promise).rejects.toMatchObject({ code: 'aborted' })
      // 本模块只在 clearWatchdog 里调 clearTimeout（让出事件循环用的是裸 setTimeout）
      expect(clearSpy).toHaveBeenCalled()
    } finally {
      clearSpy.mockRestore()
      vi.doUnmock('fflate')
      vi.resetModules()
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 进度
// ═══════════════════════════════════════════════════════════

describe('进度回调', () => {
  it('单调不减，终值等于 entries.length（根清单不计）', async () => {
    const blob = await writeAssetZip(
      [
        { name: 'a_头像.png', bytes: fakeBytes(1, 2048) },
        { name: 'b_头像.png', bytes: fakeBytes(2, 2048) },
        { name: 'c_战斗.mp3', bytes: fakeBytes(3, 2048) },
      ],
      { assets: { 'a_头像.png': { credit: 'x' } } },
    )

    const calls: Array<[number, number]> = []
    const result = await readAssetZip(blob, {
      onProgress: (done, total) => calls.push([done, total]),
    })

    expect(calls.length).toBeGreaterThan(0)
    for (let i = 1; i < calls.length; i += 1) {
      expect(calls[i][0]).toBeGreaterThanOrEqual(calls[i - 1][0]) // done 单调
      expect(calls[i][1]).toBeGreaterThanOrEqual(calls[i - 1][1]) // total 单调（会往上长）
      expect(calls[i][0]).toBeLessThanOrEqual(calls[i][1]) // done 永不超过 total
    }
    const [finalDone, finalTotal] = calls[calls.length - 1]
    expect(finalDone).toBe(result.entries.length)
    expect(finalTotal).toBe(result.entries.length)
    expect(finalDone).toBe(3) // manifest.json 没被算进去
  })

  it('噪音不进进度分母', async () => {
    const zipped = zipSync({
      'a_头像.png': fakeBytes(1, 1024),
      'readme.pdf': fakeBytes(2, 1024),
      '.DS_Store': fakeBytes(3, 16),
    })
    const calls: Array<[number, number]> = []
    await readAssetZip(zipped, { onProgress: (d, t) => calls.push([d, t]) })
    expect(calls[calls.length - 1]).toEqual([1, 1])
  })

  it('进度回调自己抛错也不连累导入', async () => {
    const zipped = zipSync({ 'a_头像.png': fakeBytes(1, 1024) })
    const result = await readAssetZip(zipped, {
      onProgress: () => {
        throw new Error('UI 崩了')
      },
    })
    expect(result.entries).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════
// 截断 / 损坏
// ═══════════════════════════════════════════════════════════

describe('截断或损坏的压缩包', () => {
  it('数据被砍断 → read-failed，绝不留一个永不 settle 的 Promise', async () => {
    const full = zipSync({ 'a.png': fakeBytes(1, 8192) }, { level: 0 })
    // 保住完整的局部文件头（30 字节）+ 文件名（'a.png'，5 字节），砍掉大部分数据
    const truncated = full.slice(0, 30 + 5 + 512)

    const error = await readAssetZip(truncated, { stallTimeoutMs: 30 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetZipError)
    expect(error).toMatchObject({ code: 'read-failed' })
    // 这一档由 fflate 自己的"声明长度没喂满"校验命中，比看门狗更快更准
    expect((error as AssetZipError).message).toContain('压缩包解析失败')
  })

  it('只丢了中央目录、局部数据完好 → 照常读出来，不挂死也不报错', async () => {
    const bytes = fakeBytes(1, 2048)
    const full = zipSync({ 'a.png': bytes }, { level: 0 })
    const noCentralDir = full.slice(0, 30 + 5 + 2048)
    // 流式解压只依赖局部文件头，中央目录缺失并不妨碍取回完整字节 —— 这里断言的是
    // "不挂死"，而恢复出数据比报错更好，所以刻意不要求它失败
    const result = await readAssetZip(noCentralDir, { stallTimeoutMs: 200 })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].bytes).toEqual(bytes)
  })

  it('看门狗不误伤正常包（完整包在超时前就 resolve）', async () => {
    const zipped = zipSync({ 'a.png': fakeBytes(1, 64 * 1024) }, { level: 9 })
    const result = await readAssetZip(zipped, { stallTimeoutMs: 5000 })
    expect(result.entries).toHaveLength(1)
  })

  it('stallTimeoutMs: 0 关掉看门狗后完整包照样能读', async () => {
    const zipped = zipSync({ 'a.png': fakeBytes(1, 1024) })
    const result = await readAssetZip(zipped, { stallTimeoutMs: 0 })
    expect(result.entries).toHaveLength(1)
  })

  /**
   * 看门狗自己的直测。
   *
   * 为什么要替换解码器: fflate 0.8.3 自己会校验"局部头声明的压缩长度有没有喂满"
   * （`err(13)`），所以**任何拼得出来的坏 zip 都会先撞它的错误路径**，轮不到
   * 看门狗。看门狗真正要兜的是另一档: push 全部成功、`this.c` 归零、而
   * **异步 worker 一声不响**（CSP 拦掉 blob worker、worker 被杀）—— 那时 fflate
   * 没有任何错误可报，Promise 就悬在那里。这里用一个永不回调的解码器复现它。
   */
  it('异步解码器一声不响时，看门狗以 read-failed 收场', async () => {
    vi.resetModules()
    const actual = await vi.importActual<typeof import('fflate')>('fflate')

    class SilentInflate {
      static compression = 8
      ondata: unknown = undefined
      push(): void {
        /* 刻意什么都不做 —— 模拟 worker 不回话 */
      }
      terminate(): void {}
    }

    vi.doMock('fflate', () => ({ ...actual, AsyncUnzipInflate: SilentInflate }))
    try {
      const mod = await import('./asset-zip')
      // level 9 → compression 8 → 走被替换掉的解码器（level 0 会走 PassThrough）
      const zipped = actual.zipSync({ 'a.png': compressible(4096) }, { level: 9 })
      const error = await mod
        .readAssetZip(zipped, { stallTimeoutMs: 30 })
        .catch((e: unknown) => e)
      expect(error).toMatchObject({ code: 'read-failed' })
      expect((error as Error).message).toContain('不完整')
    } finally {
      vi.doUnmock('fflate')
      vi.resetModules()
    }
  })
})

// ═══════════════════════════════════════════════════════════
// 体积上限：中途终止
// ═══════════════════════════════════════════════════════════

describe('解压体积上限', () => {
  it('单条目超限 → 抛 entry-too-large 并带上 path 与 limit', async () => {
    const zipped = zipSync({ 'big.png': compressible(3 * 1024 * 1024) }, { level: 9 })
    expect(zipped.length).toBeLessThan(64 * 1024) // 确认这是一枚"炸弹"样本

    const error = await readAssetZip(zipped, { maxEntryBytes: 1024 * 1024 }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetZipError)
    expect(error).toMatchObject({
      code: 'entry-too-large',
      path: 'big.png',
      limit: 1024 * 1024,
    })
  })

  it('总量超限 → 抛 total-too-large（单条目都在限内）', async () => {
    const zipped = zipSync(
      {
        'a.png': compressible(900 * 1024),
        'b.png': compressible(900 * 1024),
        'c.png': compressible(900 * 1024),
      },
      { level: 9 },
    )
    const error = await readAssetZip(zipped, {
      maxEntryBytes: 1024 * 1024,
      maxTotalBytes: 2 * 1024 * 1024,
    }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AssetZipError)
    expect(error).toMatchObject({ code: 'total-too-large', limit: 2 * 1024 * 1024 })
  })

  it('恰好等于上限不算超限（边界闭区间）', async () => {
    const size = 4096
    const zipped = zipSync({ 'a.png': fakeBytes(5, size) })
    const result = await readAssetZip(zipped, { maxEntryBytes: size, maxTotalBytes: size })
    expect(result.entries[0].bytes.length).toBe(size)
  })

  it('空输入抛 read-failed 而不是静默返回空列表', async () => {
    await expect(readAssetZip(new Uint8Array(0))).rejects.toMatchObject({ code: 'read-failed' })
  })
})

// ═══════════════════════════════════════════════════════════
// 哈希
// ═══════════════════════════════════════════════════════════

describe('逐条目 SHA-256', () => {
  it('已知字节给出已知摘要', async () => {
    const zipped = zipSync({ 'a.png': utf8('hello') })
    const result = await readAssetZip(zipped)
    expect(result.entries[0].hash).toBe(
      '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    )
    expect(result.warnings).not.toContain('hash-unavailable')
  })

  it('crypto.subtle 缺失 → hash 缺省 + hash-unavailable 告警（不换第二种算法）', async () => {
    vi.stubGlobal('crypto', {})
    const zipped = zipSync({ 'a.png': utf8('hello') })
    const result = await readAssetZip(zipped)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].hash).toBeUndefined()
    expect(result.warnings).toContain('hash-unavailable')
  })

  it('注入的哈希函数被采用', async () => {
    const zipped = zipSync({ 'a.png': utf8('hello') })
    const result = await readAssetZip(zipped, { hash: async (b) => `len-${b.length}` })
    expect(result.entries[0].hash).toBe('len-5')
  })

  it('不认的扩展名连解压都没做，自然也不出现在待哈希条目里', async () => {
    const zipped = zipSync({ 'notes.txt': utf8('hello'), 'a.png': utf8('hello') })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path)).toEqual(['a.png'])
    expect(result.entries[0].hash).toBeTruthy()
    expect(result.skippedNoise).toEqual(['notes.txt'])
    expect(result.warnings).not.toContain('hash-unavailable')
  })
})

// ═══════════════════════════════════════════════════════════
// 文件名编码
// ═══════════════════════════════════════════════════════════

describe('文件名编码', () => {
  it('UTF-8 标志位置位的中文名原样通过，不告警', async () => {
    const zipped = zipSync({ '苏婉_头像.png': fakeBytes(1, 32) })
    const result = await readAssetZip(zipped)
    expect(result.entries[0].path).toBe('苏婉_头像.png')
    expect(result.warnings).toEqual([])
  })

  it('未置标志位的 GBK 名 → 告警，且照 mojibake 原样导入（绝不猜码页转码）', async () => {
    const { zipped, gbkLatin1 } = zipWithUnflaggedGbkName()
    const result = await readAssetZip(zipped)
    expect(result.warnings).toContain('suspect-filename-encoding')
    expect(result.entries).toHaveLength(1)
    // 名字保持 fflate 解出来的样子 —— 没有被"修"成 苏婉_头像.png
    expect(result.entries[0].path).toBe(gbkLatin1)
    expect(result.entries[0].path).not.toBe('苏婉_头像.png')
  })

  it('单个高位字符的合法 Latin-1 名不误报', async () => {
    const zipped = zipSync({ 'café_头像.png': fakeBytes(1, 32) })
    const result = await readAssetZip(zipped)
    expect(result.warnings).not.toContain('suspect-filename-encoding')
  })
})

// ═══════════════════════════════════════════════════════════
// 清单
// ═══════════════════════════════════════════════════════════

describe('manifest.json', () => {
  it('缺失清单 → manifest undefined，条目照常', async () => {
    const zipped = zipSync({ 'a.png': fakeBytes(1, 32) })
    const result = await readAssetZip(zipped)
    expect(result.manifest).toBeUndefined()
    expect(result.entries).toHaveLength(1)
  })

  it('畸形清单降级成"没有清单"而不抛', async () => {
    const zipped = zipSync({
      'manifest.json': utf8('{ 这不是 json'),
      'a.png': fakeBytes(1, 32),
    })
    const result = await readAssetZip(zipped)
    expect(result.manifest).toBeUndefined()
    expect(result.entries.map((e) => e.path)).toEqual(['a.png'])
  })

  it('清单是数组 / 是数字 / 分区形状不对，一律降级不抛', () => {
    expect(parseAssetZipManifest(utf8('[1,2,3]'))).toBeUndefined()
    expect(parseAssetZipManifest(utf8('42'))).toBeUndefined()
    expect(parseAssetZipManifest(utf8('null'))).toBeUndefined()
    expect(parseAssetZipManifest(utf8('{"assets":"nope","audio":[1]}'))).toEqual({
      assets: {},
      audio: {},
    })
  })

  it('清单只能加元数据 —— name / type 之类的键被丢弃，文件名不受影响', async () => {
    const zipped = zipSync({
      'manifest.json': utf8(
        JSON.stringify({
          assets: {
            '苏婉_头像.png': {
              credit: '画师甲',
              license: 'CC-BY',
              name: '林月',
              type: '立绘',
              path: 'evil/../../x.png',
            },
          },
          audio: {},
        }),
      ),
      '苏婉_头像.png': fakeBytes(1, 32),
    })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path)).toEqual(['苏婉_头像.png'])
    expect(result.manifest?.assets['苏婉_头像.png']).toEqual({
      credit: '画师甲',
      license: 'CC-BY',
    })
  })

  it('取景经解析层进来，并在**第一道门**就被夹逼（外来 JSON 不可信）', () => {
    const parsed = parseAssetZipManifest(
      utf8(
        JSON.stringify({
          assets: {
            'ok.png': { framing: { x: 20, y: 80, scale: 1.75 } },
            'wild.png': { framing: { x: 1e9, y: -50, scale: 999 } },
            'text.png': { framing: '居中' },
            'arr.png': { framing: [1, 2, 3] },
            'nan.png': { framing: { x: Number.NaN, y: 0, scale: 1 } },
          },
          audio: {},
        }),
      ),
    )
    expect(parsed?.assets['ok.png']?.framing).toEqual({ x: 20, y: 80, scale: 1.75 })
    expect(parsed?.assets['wild.png']?.framing).toEqual({ x: 100, y: 0, scale: 3 })
    // 非对象 → 当"没写取景"，整条 meta 于是也空了 → 该键不出现
    expect(parsed?.assets['text.png']).toBeUndefined()
    expect(parsed?.assets['arr.png']).toBeUndefined()
    // NaN 经 JSON 变成 null → 非数 → 退回默认，绝不带着 NaN 往下走
    expect(parsed?.assets['nan.png']?.framing).toEqual({ x: 50, y: 0, scale: 1 })
  })

  it('取景走 write → read 往返一字不差', async () => {
    const blob = await writeAssetZip([{ name: 'a.png', bytes: fakeBytes(1, 32) }], {
      assets: { 'a.png': { framing: { x: 12, y: 34, scale: 2.5 } } },
      audio: {},
    })
    const result = await readAssetZip(new Uint8Array(await blob.arrayBuffer()))
    expect(result.manifest?.assets['a.png']).toEqual({ framing: { x: 12, y: 34, scale: 2.5 } })
  })

  it('清单引用不存在的文件、文件不在清单里，都静默容忍', async () => {
    const zipped = zipSync({
      'manifest.json': utf8('{"assets":{"不存在.png":{"credit":"x"}},"audio":{}}'),
      'a.png': fakeBytes(1, 32),
    })
    const result = await readAssetZip(zipped)
    expect(result.entries.map((e) => e.path)).toEqual(['a.png'])
    expect(result.manifest?.assets['不存在.png']?.credit).toBe('x')
  })

  it('清单键带路径时按 basename 归一，先到先得', () => {
    const parsed = parseAssetZipManifest(
      utf8('{"assets":{"assets/a.png":{"credit":"先"},"other/a.png":{"credit":"后"}},"audio":{}}'),
    )
    expect(parsed?.assets['a.png']?.credit).toBe('先')
  })

  it('tags 里的非字符串被过滤，空 meta 不落键', () => {
    const parsed = parseAssetZipManifest(
      utf8('{"assets":{},"audio":{"t.mp3":{"tags":["情境:战斗",7,null]},"u.mp3":{}}}'),
    )
    expect(parsed?.audio['t.mp3']?.tags).toEqual(['情境:战斗'])
    expect(parsed?.audio['u.mp3']).toBeUndefined()
  })

  it('导出条目占用 manifest.json 这个保留名时抛错', async () => {
    await expect(
      writeAssetZip([{ name: ASSET_ZIP_MANIFEST_NAME, bytes: utf8('{}') }], {
        assets: {},
        audio: {},
      }),
    ).rejects.toMatchObject({ code: 'duplicate-name' })
  })
})
