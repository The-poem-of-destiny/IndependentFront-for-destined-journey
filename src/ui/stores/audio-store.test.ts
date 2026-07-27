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
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AudioTrack } from '@engine/types'

// ── @engine/database: Dexie 在 import 期就构造，整层替掉 ──
const trackRows = new Map<string, AudioTrack>()
const blobRows = new Map<string, Blob>()

vi.mock('@engine/database', () => ({
  getAudioTracks: vi.fn(async () => [...trackRows.values()]),
  saveAudioTrack: vi.fn(async (t: AudioTrack) => {
    trackRows.set(t.id, { ...t })
    return t.id
  }),
  deleteAudioTrack: vi.fn(async (id: string) => { trackRows.delete(id) }),
  getAudioPlaylists: vi.fn(async () => []),
  saveAudioPlaylist: vi.fn(async () => {}),
  deleteAudioPlaylist: vi.fn(async () => {}),
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
