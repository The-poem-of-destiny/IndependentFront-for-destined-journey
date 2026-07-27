/**
 * audio-store.test.ts — 曲库文件夹后端接线测试 (Phase Audio, addendum)
 *
 * 覆盖:
 * 1. loadBlob 按 source 分派 ('file' 走磁盘 / 'blob'+'builtin' 走 IndexedDB)
 * 2. 文件消失 → 标 missing + 返回 undefined（不抛）
 * 3. 扫描对账: 新增建行 / 回来的清 missing / 没了的标 missing / **绝不删行**
 * 4. 扫描保住用户整理成果 (tags / kind)
 * 5. init() 绝不调用 requestPermission（无用户手势）
 * 6. forgetFolder 保留曲目行，只把它们标成 missing
 * 7. 名字唯一性: 导入自动编号 / 手工命名拒绝 / 按名寻址
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AudioPlaylist, AudioTrack } from '@engine/types'

// ── @engine/database: Dexie 在 import 期就构造，整层替掉 ──
const trackRows = new Map<string, AudioTrack>()
const blobRows = new Map<string, Blob>()
const playlistRows = new Map<string, AudioPlaylist>()

vi.mock('@engine/database', () => ({
  getAudioTracks: vi.fn(async () => [...trackRows.values()]),
  saveAudioTrack: vi.fn(async (t: AudioTrack) => {
    trackRows.set(t.id, { ...t })
    return t.id
  }),
  deleteAudioTrack: vi.fn(async (id: string) => { trackRows.delete(id) }),
  getAudioPlaylists: vi.fn(async () => [...playlistRows.values()]),
  saveAudioPlaylist: vi.fn(async (p: AudioPlaylist) => {
    playlistRows.set(p.id, { ...p })
    return p.id
  }),
  deleteAudioPlaylist: vi.fn(async (id: string) => { playlistRows.delete(id) }),
  getAudioBlob: vi.fn(async (id: string) => blobRows.get(id)),
  getAudioHandle: vi.fn(async () => undefined),
  saveAudioHandle: vi.fn(async () => 'library-root'),
  deleteAudioHandle: vi.fn(async () => {}),
}))

// settings-store: 只给音频需要的表面，避开启动期 fetch / 世界书加载
const mockSettings: Record<string, unknown> = {}
vi.mock('./settings-store', () => ({
  useSettingsStore: () => ({ settings: mockSettings }),
}))

import { useAudioStore } from './audio-store'
import { resetAudioManager } from '../lib/audio-singleton'
import { __setFolderTestHooks, __resetFolderTestHooks } from '../lib/audio-folder'
import type { AudioHandleRecord } from '@engine/types'

// ═══════════════════════════════════════════════════════════
// 假目录句柄
// ═══════════════════════════════════════════════════════════

interface FakeFile { name: string; size: number; type: string }

function fakeDirHandle(files: FakeFile[], opts: { permission?: string; name?: string } = {}) {
  const byName = new Map(files.map((f) => [f.name, f]))
  return {
    kind: 'directory',
    name: opts.name ?? 'music',
    async *values() {
      for (const f of byName.values()) {
        yield {
          kind: 'file',
          name: f.name,
          async getFile() { return { name: f.name, size: f.size, type: f.type } },
        }
      }
    },
    async getFileHandle(name: string) {
      const f = byName.get(name)
      if (!f) {
        const err = new Error('not found')
        err.name = 'NotFoundError'
        throw err
      }
      return { async getFile() { return { name: f.name, size: f.size, type: f.type, __blob: true } } }
    },
    async queryPermission() { return opts.permission ?? 'granted' },
    async requestPermission() { return 'granted' },
  } as unknown as FileSystemDirectoryHandle
}

const MP3 = (name: string, size = 100): FakeFile => ({ name, size, type: 'audio/mpeg' })

function fileTrack(over: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: 'tf1',
    name: '夜行曲',
    kind: 'music',
    source: 'file',
    relativePath: 'night.mp3',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

/** 注入一个已持久化的句柄 */
function storedHandle(handle: FileSystemDirectoryHandle) {
  const requestSpy = vi.fn(async () => 'granted')
  ;(handle as unknown as Record<string, unknown>).requestPermission = requestSpy
  __setFolderTestHooks({
    // picker 存在即让 isFolderSupported() 为 true（jsdom 没有 showDirectoryPicker）
    picker: async () => handle,
    getHandle: async (id: string): Promise<AudioHandleRecord> => ({ id, handle, addedAt: 1 }),
    saveHandle: async () => 'library-root',
    deleteHandle: async () => {},
  })
  return requestSpy
}

beforeEach(() => {
  vi.clearAllMocks()
  __resetFolderTestHooks()
  resetAudioManager()
  setActivePinia(createPinia())
  trackRows.clear()
  blobRows.clear()
  playlistRows.clear()
  for (const k of Object.keys(mockSettings)) delete mockSettings[k]
  Object.assign(mockSettings, {
    audioMasterVolume: 0.7, audioMusicVolume: 0.7, audioSfxVolume: 0.7,
    audioRepeat: 'all', audioShuffle: false, audioLastPlaylistId: '',
  })
  ;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ ok: false, json: async () => [] }))
})

afterEach(() => {
  __resetFolderTestHooks()
})

// ═══════════════════════════════════════════════════════════
// loadBlob 分派
// ═══════════════════════════════════════════════════════════

describe('audio-store · loadBlob 分派', () => {
  it("source='blob' 走 IndexedDB", async () => {
    const blob = new Blob(['x'])
    blobRows.set('tb1', blob)
    trackRows.set('tb1', { id: 'tb1', name: 'B', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 })

    const store = useAudioStore()
    await store.init()
    expect(await store.loadBlob('tb1')).toBe(blob)
  })

  it("source='builtin' 不碰文件夹，仍走原路径（返回 undefined）", async () => {
    trackRows.set('bi1', {
      id: 'bi1', name: 'Built', kind: 'music', source: 'builtin',
      url: '/audio/x.mp3', tags: [], builtin: true, createdAt: 0, updatedAt: 0,
    })
    const handle = fakeDirHandle([MP3('night.mp3')])
    storedHandle(handle)
    const getFileHandle = vi.spyOn(handle as unknown as { getFileHandle: (n: string) => unknown }, 'getFileHandle')

    const store = useAudioStore()
    await store.init()
    expect(await store.loadBlob('bi1')).toBeUndefined()
    expect(getFileHandle).not.toHaveBeenCalled()
  })

  it("source='file' 从磁盘取回文件", async () => {
    trackRows.set('tf1', fileTrack())
    storedHandle(fakeDirHandle([MP3('night.mp3')]))

    const store = useAudioStore()
    await store.init()
    const out = await store.loadBlob('tf1')
    expect(out).toBeTruthy()
    expect((out as unknown as { name: string }).name).toBe('night.mp3')
  })

  it('文件已消失 → 标 missing 并返回 undefined（不抛）', async () => {
    trackRows.set('tf1', fileTrack({ relativePath: 'gone.mp3' }))
    storedHandle(fakeDirHandle([]))

    const store = useAudioStore()
    await store.init()
    // 启动扫描已经标过一次；再验证 loadBlob 自身也不抛且返回 undefined
    expect(await store.loadBlob('tf1')).toBeUndefined()
    expect(trackRows.get('tf1')?.missing).toBe(true)
    expect(trackRows.has('tf1')).toBe(true)
  })

  it('没有文件夹句柄时 file 曲目标 missing 而不是抛错', async () => {
    trackRows.set('tf1', fileTrack())
    const store = useAudioStore()
    await store.init() // 无句柄 → folderPermission 'none'
    expect(await store.loadBlob('tf1')).toBeUndefined()
    expect(trackRows.get('tf1')?.missing).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 扫描对账
// ═══════════════════════════════════════════════════════════

describe('audio-store · 扫描对账', () => {
  it('磁盘新增 → 建曲目 (source=file / kind=music / 名字去扩展名)', async () => {
    storedHandle(fakeDirHandle([MP3('night.mp3', 321)]))
    const store = useAudioStore()
    await store.init()

    const created = [...trackRows.values()].find((t) => t.relativePath === 'night.mp3')
    expect(created).toBeTruthy()
    expect(created?.source).toBe('file')
    expect(created?.kind).toBe('music')
    expect(created?.name).toBe('night')
    expect(created?.size).toBe(321)
    expect(created?.mimeType).toBe('audio/mpeg')
    expect(created?.tags).toEqual([])
  })

  it('文件回来了 → 清 missing 并刷新 size/mimeType', async () => {
    trackRows.set('tf1', fileTrack({ missing: true, size: 1, mimeType: 'audio/x' }))
    storedHandle(fakeDirHandle([MP3('night.mp3', 999)]))

    const store = useAudioStore()
    await store.init()
    const row = trackRows.get('tf1')
    expect(row?.missing).toBe(false)
    expect(row?.size).toBe(999)
    expect(row?.mimeType).toBe('audio/mpeg')
  })

  it('文件没了 → 标 missing，**行仍在**', async () => {
    trackRows.set('tf1', fileTrack())
    storedHandle(fakeDirHandle([MP3('other.mp3')]))

    const store = useAudioStore()
    await store.init()
    expect(trackRows.get('tf1')?.missing).toBe(true)
    expect(trackRows.has('tf1')).toBe(true)
    expect(store.tracks.find((t) => t.id === 'tf1')).toBeTruthy()
  })

  it('扫描保住用户整理成果 (tags / kind 不被覆盖)', async () => {
    trackRows.set('tf1', fileTrack({ kind: 'sfx', tags: ['战斗', '夜'], name: '我改过的名字' }))
    storedHandle(fakeDirHandle([MP3('night.mp3', 555)]))

    const store = useAudioStore()
    await store.init()
    await store.rescanFolder()

    const row = trackRows.get('tf1')
    expect(row?.kind).toBe('sfx')
    expect(row?.tags).toEqual(['战斗', '夜'])
    expect(row?.name).toBe('我改过的名字')
    expect(row?.size).toBe(555)
    // 没有重复建行
    expect([...trackRows.values()].filter((t) => t.relativePath === 'night.mp3')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════
// 权限生命周期 & 取消关联
// ═══════════════════════════════════════════════════════════

describe('audio-store · 文件夹生命周期', () => {
  it('不支持 File System Access → folderPermission = unsupported', async () => {
    const store = useAudioStore()
    await store.init()
    expect(store.folderPermission).toBe('unsupported')
  })

  it('支持但无已存句柄 → none', async () => {
    __setFolderTestHooks({
      picker: async () => fakeDirHandle([]),
      getHandle: async () => undefined,
      saveHandle: async () => 'library-root',
      deleteHandle: async () => {},
    })
    const store = useAudioStore()
    await store.init()
    expect(store.folderPermission).toBe('none')
  })

  it('init() 绝不调用 requestPermission（无用户手势）', async () => {
    const handle = fakeDirHandle([MP3('night.mp3')], { permission: 'prompt' })
    const requestSpy = storedHandle(handle)

    const store = useAudioStore()
    await store.init()
    expect(store.folderPermission).toBe('prompt')
    expect(requestSpy).not.toHaveBeenCalled()
    // 未授权 → 不扫描，不建行
    expect(trackRows.size).toBe(0)
  })

  it('grantFolderPermission() 授权成功后扫描', async () => {
    const handle = fakeDirHandle([MP3('night.mp3')], { permission: 'prompt' })
    const requestSpy = storedHandle(handle)

    const store = useAudioStore()
    await store.init()
    expect(await store.grantFolderPermission()).toBe(true)
    expect(requestSpy).toHaveBeenCalled()
    expect(store.folderPermission).toBe('granted')
    expect(trackRows.size).toBe(1)
  })

  it('pickFolder() 记住文件夹名并立即扫描', async () => {
    __setFolderTestHooks({
      picker: async () => fakeDirHandle([MP3('a.mp3'), MP3('b.mp3')], { name: '我的音乐' }),
      getHandle: async () => undefined,
      saveHandle: async () => 'library-root',
      deleteHandle: async () => {},
    })
    const store = useAudioStore()
    await store.init()
    expect(await store.pickFolder()).toBe(true)
    expect(store.folderName).toBe('我的音乐')
    expect(store.folderPermission).toBe('granted')
    expect(trackRows.size).toBe(2)
  })

  it('forgetFolder() 保留曲目行，只标 missing', async () => {
    trackRows.set('tf1', fileTrack({ tags: ['夜'] }))
    storedHandle(fakeDirHandle([MP3('night.mp3')]))

    const store = useAudioStore()
    await store.init()
    expect(trackRows.get('tf1')?.missing).toBe(false)

    await store.forgetFolder()
    expect(trackRows.has('tf1')).toBe(true)
    expect(trackRows.get('tf1')?.missing).toBe(true)
    expect(trackRows.get('tf1')?.tags).toEqual(['夜'])
    expect(store.folderName).toBe('')
    expect(store.folderPermission).toBe('none')
  })
})

// ═══════════════════════════════════════════════════════════
// 名字唯一性 & 按名寻址
// ═══════════════════════════════════════════════════════════

const audioFile = (name: string) => new File(['x'], name, { type: 'audio/mpeg' })

describe('audio-store · 名字唯一性（仅新写入）', () => {
  it('上传撞名自动编号，绝不失败', async () => {
    trackRows.set('t0', { id: 't0', name: '夜行曲', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 })
    const store = useAudioStore()
    await store.init()

    // 同一批里两个同名文件也要各自拿到号（池子随建随长）
    const created = await store.uploadFiles([audioFile('夜行曲.mp3'), audioFile('夜行曲.mp3')])
    expect(created).toHaveLength(2)
    expect(created.map((t) => t.name)).toEqual(['夜行曲 (2)', '夜行曲 (3)'])
    expect(trackRows.size).toBe(3)
  })

  it('文件夹扫描撞名自动编号，两行都在', async () => {
    // 磁盘上 night.mp3 与 night.wav 去扩展名后同名
    storedHandle(fakeDirHandle([MP3('night.mp3'), { name: 'night.wav', size: 20, type: 'audio/wav' }]))
    const store = useAudioStore()
    await store.init()

    const names = [...trackRows.values()].map((t) => t.name).sort()
    expect(names).toEqual(['night', 'night (2)'])
    // 扫描永不跳过文件
    expect([...trackRows.values()].map((t) => t.relativePath).sort()).toEqual(['night.mp3', 'night.wav'])
  })

  it('renameTrack 撞名拒绝；改成自己现在的名字仍然成功', async () => {
    trackRows.set('a', { id: 'a', name: '晨曦', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 })
    trackRows.set('b', { id: 'b', name: '暮色', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 })
    const store = useAudioStore()
    await store.init()

    expect(await store.renameTrack('b', '晨曦')).toBe(false)
    expect(trackRows.get('b')?.name).toBe('暮色')
    // 归一化比较：大小写/尾部扩展名/多余空白都算同一个名字
    expect(await store.renameTrack('b', ' 晨曦.mp3 ')).toBe(false)
    // 改成自己现在的名字不算冲突
    expect(await store.renameTrack('b', '暮色')).toBe(true)
    expect(await store.renameTrack('b', '黄昏')).toBe(true)
    expect(trackRows.get('b')?.name).toBe('黄昏')
  })

  it('播放列表与曲目是两个命名空间', async () => {
    trackRows.set('a', { id: 'a', name: '战斗', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 })
    const store = useAudioStore()
    await store.init()

    const list = await store.createPlaylist('战斗')
    expect(list).toBeTruthy()
    // 同名的第二个播放列表才算冲突
    expect(await store.createPlaylist('战斗')).toBeNull()
    expect(await store.renamePlaylist(list!.id, '战斗')).toBe(true)
  })

  it('renamePlaylist 撞名拒绝', async () => {
    const store = useAudioStore()
    await store.init()
    const a = await store.createPlaylist('清晨')
    const b = await store.createPlaylist('深夜')
    expect(await store.renamePlaylist(b!.id, '清晨')).toBe(false)
    expect(store.findPlaylist(b!.id)?.name).toBe('深夜')
    expect(a).toBeTruthy()
  })
})

describe('audio-store · 按名寻址', () => {
  it('findTrackByName 归一化匹配；历史重名取最早的一条', async () => {
    trackRows.set('new', { id: 'new', name: '夜行曲', kind: 'music', source: 'blob', tags: [], createdAt: 500, updatedAt: 0 })
    trackRows.set('old', { id: 'old', name: '夜行曲', kind: 'music', source: 'blob', tags: [], createdAt: 100, updatedAt: 0 })
    const store = useAudioStore()
    await store.init()

    expect(store.findTrackByName('夜行曲.mp3')?.id).toBe('old')
    expect(store.findTrackByName('不存在')).toBeUndefined()
  })

  it('playTrackByName 找不到时返回 false 且不改变当前播放', async () => {
    trackRows.set('a', { id: 'a', name: '晨曦', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 })
    const store = useAudioStore()
    await store.init()
    const before = store.state.music.trackId
    expect(await store.playTrackByName('查无此曲')).toBe(false)
    expect(store.state.music.trackId).toBe(before)
  })

  it('playPlaylistByName 找不到时返回 false', async () => {
    const store = useAudioStore()
    await store.init()
    expect(await store.playPlaylistByName('查无此单')).toBe(false)
  })
})
