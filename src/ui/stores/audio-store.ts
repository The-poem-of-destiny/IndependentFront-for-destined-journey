/**
 * audio-store.ts — 音频系统 Pinia 薄壳 (Phase Audio, 波次 4)
 *
 * 设计: docs/planning/2026-07-26-audio-system-design.md §4.1 / §5 / §6.3 / §7
 *
 * 职责:
 * - 镜像 AudioManager 的**离散**状态 (subscribe)；position 不进响应式状态 (§6.3)
 * - 曲库/播放列表的 Dexie 读写 + 内置 manifest 合并 (§5)
 * - 音量/循环/随机等全局偏好经 settings-store 持久化 (§4.1, 计划 A5)
 *
 * 边界: Store 不碰 AudioContext；单例与浏览器工厂住在 lib/audio-singleton.ts (计划 A1)
 */
import { defineStore } from 'pinia'
import { ref } from 'vue'
import type {
  AudioPlaybackState,
  AudioPlaylist,
  AudioRepeatMode,
  AudioTrack,
  AudioTrackKind,
} from '@engine/types'
import {
  getAudioTracks,
  saveAudioTrack,
  deleteAudioTrack as dbDeleteAudioTrack,
  getAudioPlaylists,
  saveAudioPlaylist,
  deleteAudioPlaylist as dbDeleteAudioPlaylist,
  getAudioBlob,
} from '@engine/database'
import { getAudioManager, installUnlockListener, setBlobResolver } from '../lib/audio-singleton'
import {
  isFolderSupported,
  pickLibraryFolder,
  getStoredFolder,
  forgetFolder as forgetStoredFolder,
  checkPermission,
  requestPermission,
  scanFolder,
  resolveFile,
  type ScannedFile,
} from '../lib/audio-folder'
import { useSettingsStore } from './settings-store'

// ===== 常量 =====

/** 进度轮询频率 ~4Hz (§6.3) */
const POSITION_POLL_MS = 250

/** 内置曲库清单路径 (§5)；不存在时静默跳过 */
const MANIFEST_URL = '/audio/manifest.json'

/** manifest 条目格式: { id, name, kind, file, tags, credit, license } */
interface AudioManifestEntry {
  id: string
  name: string
  kind?: AudioTrackKind
  file: string
  tags?: string[]
  credit?: string
  license?: string
}

/**
 * 音乐文件夹的授权状态 (addendum §权限生命周期)
 * - unsupported: 浏览器没有 File System Access
 * - none: 支持，但用户还没选文件夹
 * - prompt: 有句柄但本次会话尚未授权（浏览器重启后的常态）
 * - granted / denied: 授权结果
 */
export type AudioFolderPermission = 'unsupported' | 'none' | 'prompt' | 'granted' | 'denied'

function idleState(): AudioPlaybackState {
  return {
    music: {
      status: 'idle',
      trackId: null,
      playlistId: null,
      index: -1,
      durationSec: 0,
      volume: 1,
      muted: false,
      repeat: 'all',
      shuffle: false,
    },
    sfx: { volume: 1, muted: false, liveVoices: 0 },
    masterVolume: 1,
    masterMuted: false,
    unlocked: false,
  }
}

function newId(prefix: string): string {
  const c = (globalThis as unknown as { crypto?: Crypto }).crypto
  if (c && typeof c.randomUUID === 'function') return `${prefix}_${c.randomUUID()}`
  return `${prefix}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
}

/** 去掉文件扩展名 */
function stripExt(filename: string): string {
  const i = filename.lastIndexOf('.')
  return i > 0 ? filename.slice(0, i) : filename
}

// ===== Store =====

export const useAudioStore = defineStore('audio', () => {
  const manager = getAudioManager()

  // ── 状态镜像 (离散，不含 position) ─────────────────────
  const state = ref<AudioPlaybackState>(idleState())

  // ── 曲库 ────────────────────────────────────────────────
  /** 用户上传曲目 (Dexie) + 内置曲目 (manifest) 的并集 */
  const tracks = ref<AudioTrack[]>([])
  const playlists = ref<AudioPlaylist[]>([])
  /** manifest 曲目 —— 不落 Dexie，每次启动重新 fetch */
  const builtinTracks = ref<AudioTrack[]>([])
  const loading = ref(false)

  /** 按需采样的播放位置(秒)，仅在有人轮询时更新 (§6.3) */
  const positionSec = ref(0)

  // ── 音乐文件夹 (addendum) ───────────────────────────────
  const folderPermission = ref<AudioFolderPermission>('unsupported')
  const folderName = ref('')
  const scanning = ref(false)

  /** 目录句柄不进响应式状态：它是不可克隆语义的宿主对象，只被动作读写 */
  let folderHandle: FileSystemDirectoryHandle | null = null

  let initialized = false
  let unsubscribe: (() => void) | null = null

  // ═══ 库加载 ═══════════════════════════════════════════

  /** 拉取内置 manifest；缺文件/解析失败一律静默（对齐 loadBuiltInWorldBooks） */
  async function loadManifest(): Promise<void> {
    try {
      const res = await fetch(MANIFEST_URL)
      if (!res.ok) return
      const raw = (await res.json()) as AudioManifestEntry[]
      if (!Array.isArray(raw)) return
      const now = Date.now()
      builtinTracks.value = raw
        .filter((e) => e && typeof e.id === 'string' && typeof e.file === 'string')
        .map<AudioTrack>((e) => ({
          id: e.id,
          name: e.name || stripExt(e.file),
          kind: e.kind === 'sfx' ? 'sfx' : 'music',
          source: 'builtin',
          url: e.file.startsWith('/') ? e.file : `/audio/${e.file}`,
          tags: Array.isArray(e.tags) ? e.tags : [],
          builtin: true,
          createdAt: now,
          updatedAt: now,
        }))
    } catch {
      // manifest 尚未存在（波次 5c 交付）或 fetch 不可用 → 静默
    }
  }

  /** 从 Dexie 读曲目与播放列表，并与内置曲目合并后灌给 Manager */
  async function loadLibrary(): Promise<void> {
    loading.value = true
    try {
      const [dbTracks, dbLists] = await Promise.all([getAudioTracks(), getAudioPlaylists()])
      tracks.value = [...builtinTracks.value, ...dbTracks]
      playlists.value = dbLists
    } catch {
      // IndexedDB 不可用 → 只留内置曲目
      tracks.value = [...builtinTracks.value]
      playlists.value = []
    } finally {
      loading.value = false
    }
    manager.setTracks(tracks.value)
    manager.setPlaylists(playlists.value)
  }

  /** 仅刷新曲目（写操作后调用） */
  async function refreshTracks(): Promise<void> {
    try {
      const dbTracks = await getAudioTracks()
      tracks.value = [...builtinTracks.value, ...dbTracks]
    } catch {
      tracks.value = [...builtinTracks.value]
    }
    manager.setTracks(tracks.value)
  }

  /** 仅刷新播放列表（写操作后调用） */
  async function refreshPlaylists(): Promise<void> {
    try {
      playlists.value = await getAudioPlaylists()
    } catch {
      playlists.value = []
    }
    manager.setPlaylists(playlists.value)
  }

  // ═══ 字节读取 seam (addendum §Store changes) ═══════════

  /** 把某条曲目标记为「文件已移除」并落库；已是 missing 则空转 */
  async function markMissing(track: AudioTrack): Promise<void> {
    if (track.missing) return
    try {
      await saveAudioTrack({ ...track, missing: true })
      await refreshTracks()
    } catch {
      // IndexedDB 不可用时不该连播放路径一起炸
    }
  }

  /**
   * AudioManager 的唯一字节来源，按 source 分派:
   * - 'file'   → 从用户音乐文件夹取；文件没了就标 missing 并返回 undefined（不抛）
   * - 'blob'   → IndexedDB（原路径不变）
   * - 'builtin'→ 同上返回 undefined；音乐声道直接用 track.url，不会走到这里
   */
  async function loadBlob(trackId: string): Promise<Blob | undefined> {
    const track = findTrack(trackId)
    if (!track || track.source !== 'file') return getAudioBlob(trackId)

    if (!folderHandle || !track.relativePath) {
      await markMissing(track)
      return undefined
    }
    let file: File | null = null
    try {
      file = await resolveFile(folderHandle, track.relativePath)
    } catch {
      file = null
    }
    if (!file) {
      await markMissing(track)
      return undefined
    }
    return file
  }

  // ═══ 音乐文件夹 (addendum) ═════════════════════════════

  /**
   * 启动期恢复文件夹状态。**绝不调用 requestPermission** —— 它需要用户手势，
   * 无手势调用会静默失败，看起来就像 bug。授权按钮由 UI 提供。
   */
  async function initFolder(): Promise<void> {
    if (!isFolderSupported()) {
      folderPermission.value = 'unsupported'
      return
    }
    let handle: FileSystemDirectoryHandle | null = null
    try {
      handle = await getStoredFolder()
    } catch {
      handle = null
    }
    if (!handle) {
      folderHandle = null
      folderName.value = ''
      folderPermission.value = 'none'
      return
    }
    folderHandle = handle
    folderName.value = handle.name ?? ''
    folderPermission.value = await checkPermission(handle)
    if (folderPermission.value === 'granted') await rescanFolder()
  }

  /** 用户手势：弹目录选择器。成功即视为已授权并立即扫描。 */
  async function pickFolder(): Promise<boolean> {
    if (!isFolderSupported()) return false
    const handle = await pickLibraryFolder()
    if (!handle) return false
    folderHandle = handle
    folderName.value = handle.name ?? ''
    folderPermission.value = 'granted'
    await rescanFolder()
    return true
  }

  /** 用户手势：对已存句柄重新申请读权限（浏览器重启后每会话一次） */
  async function grantFolderPermission(): Promise<boolean> {
    if (!folderHandle) return false
    const ok = await requestPermission(folderHandle)
    folderPermission.value = ok ? 'granted' : 'denied'
    if (ok) await rescanFolder()
    return ok
  }

  /**
   * 目录 ↔ 曲目目录的对账（按 relativePath 匹配）:
   * - 磁盘新增 → 建曲目
   * - 两边都有 → 清 missing，刷新 size/mimeType
   * - 目录里有但磁盘没了 → 标 missing
   *
   * **扫描期间绝不删行** —— 标签、kind、播放列表位次是用户的整理成果，
   * 文件被挪走或硬盘没插不该把它们毁掉。
   */
  async function rescanFolder(): Promise<void> {
    if (!folderHandle || scanning.value) return
    scanning.value = true
    try {
      let scanned: ScannedFile[] = []
      try {
        scanned = await scanFolder(folderHandle)
      } catch {
        return
      }
      const onDisk = new Map(scanned.map((f) => [f.name, f]))
      const seen = new Set<string>()

      for (const track of tracks.value.filter((t) => t.source === 'file')) {
        const path = track.relativePath ?? ''
        const hit = path ? onDisk.get(path) : undefined
        if (hit) {
          seen.add(path)
          if (track.missing || track.size !== hit.size || track.mimeType !== hit.mimeType) {
            await saveAudioTrack({ ...track, missing: false, size: hit.size, mimeType: hit.mimeType })
          }
        } else if (!track.missing) {
          await saveAudioTrack({ ...track, missing: true })
        }
      }

      const now = Date.now()
      for (const f of scanned) {
        if (seen.has(f.name)) continue
        await saveAudioTrack({
          id: newId('audio'),
          name: stripExt(f.name),
          kind: 'music',
          source: 'file',
          mimeType: f.mimeType,
          size: f.size,
          relativePath: f.name,
          tags: [],
          missing: false,
          createdAt: now,
          updatedAt: now,
        })
      }

      await refreshTracks()
    } finally {
      scanning.value = false
    }
  }

  /**
   * 取消关联：只删句柄，**不删任何曲目行**。曲目全部变成 missing（字节暂时够不着），
   * 重新选回同一个文件夹时按文件名原样恢复，标签与播放列表位次都还在。
   */
  async function forgetFolder(): Promise<void> {
    try {
      await forgetStoredFolder()
    } catch {
      // 句柄删不掉也要把内存态清干净
    }
    folderHandle = null
    folderName.value = ''
    folderPermission.value = isFolderSupported() ? 'none' : 'unsupported'

    for (const track of tracks.value.filter((t) => t.source === 'file' && !t.missing)) {
      try {
        await saveAudioTrack({ ...track, missing: true })
      } catch {
        break
      }
    }
    await refreshTracks()
  }

  // ═══ 初始化 ═══════════════════════════════════════════

  /** 幂等；组件在 onMounted 里调用 */
  async function init(): Promise<void> {
    if (initialized) return
    initialized = true

    unsubscribe = manager.subscribe((s) => { state.value = s })
    setBlobResolver(loadBlob)
    installUnlockListener()

    restoreSettings()
    await loadManifest()
    await loadLibrary()
    await initFolder()

    state.value = manager.state as AudioPlaybackState
  }

  /** 从 settings-store 恢复混音/循环偏好到 Manager (A5) */
  function restoreSettings(): void {
    const s = useSettingsStore().settings
    manager.setMasterVolume(Number(s.audioMasterVolume ?? 0.7))
    manager.setMasterMuted(Boolean(s.audioMasterMuted))
    manager.setChannelVolume('music', Number(s.audioMusicVolume ?? 0.7))
    manager.setChannelMuted('music', Boolean(s.audioMusicMuted))
    manager.setChannelVolume('sfx', Number(s.audioSfxVolume ?? 0.7))
    manager.setChannelMuted('sfx', Boolean(s.audioSfxMuted))
    manager.setRepeat((s.audioRepeat ?? 'all') as AudioRepeatMode)
    manager.setShuffle(Boolean(s.audioShuffle))
    state.value = manager.state as AudioPlaybackState
  }

  function dispose(): void {
    stopPositionPolling(true)
    setBlobResolver(null)
    unsubscribe?.()
    unsubscribe = null
    initialized = false
  }

  // ═══ 上传 ═════════════════════════════════════════════

  /** 每个文件建一条曲目 + 一条 blob 记录；名字取文件名去扩展名 */
  async function uploadFiles(files: File[], kind: AudioTrackKind = 'music'): Promise<AudioTrack[]> {
    const created: AudioTrack[] = []
    for (const file of files) {
      const now = Date.now()
      const track: AudioTrack = {
        id: newId('audio'),
        name: stripExt(file.name),
        kind,
        source: 'blob',
        mimeType: file.type || undefined,
        size: file.size,
        tags: [],
        createdAt: now,
        updatedAt: now,
      }
      await saveAudioTrack(track, file)
      created.push(track)
    }
    await refreshTracks()
    return created
  }

  // ═══ 曲目 CRUD ════════════════════════════════════════

  function findTrack(id: string): AudioTrack | undefined {
    return tracks.value.find((t) => t.id === id)
  }

  async function renameTrack(id: string, name: string): Promise<void> {
    const t = findTrack(id)
    if (!t || t.builtin) return
    await saveAudioTrack({ ...t, name })
    await refreshTracks()
  }

  async function setTrackTags(id: string, tags: string[]): Promise<void> {
    const t = findTrack(id)
    if (!t || t.builtin) return
    await saveAudioTrack({ ...t, tags: [...tags] })
    await refreshTracks()
  }

  async function setTrackKind(id: string, kind: AudioTrackKind): Promise<void> {
    const t = findTrack(id)
    if (!t || t.builtin) return
    await saveAudioTrack({ ...t, kind })
    await refreshTracks()
  }

  /** 内置曲目不可删（§2: builtin 只能隐藏） */
  async function deleteTrack(id: string): Promise<void> {
    const t = findTrack(id)
    if (t?.builtin) return
    await dbDeleteAudioTrack(id)
    // 删除会顺带剪掉播放列表里的悬挂引用 → 两边都刷
    await refreshTracks()
    await refreshPlaylists()
  }

  // ═══ 播放列表 CRUD ════════════════════════════════════

  function findPlaylist(id: string): AudioPlaylist | undefined {
    return playlists.value.find((p) => p.id === id)
  }

  async function createPlaylist(name: string): Promise<AudioPlaylist> {
    const now = Date.now()
    const list: AudioPlaylist = { id: newId('plist'), name, trackIds: [], createdAt: now, updatedAt: now }
    await saveAudioPlaylist(list)
    await refreshPlaylists()
    return list
  }

  async function renamePlaylist(id: string, name: string): Promise<void> {
    const p = findPlaylist(id)
    if (!p) return
    await saveAudioPlaylist({ ...p, name })
    await refreshPlaylists()
  }

  async function deletePlaylist(id: string): Promise<void> {
    await dbDeleteAudioPlaylist(id)
    if (useSettingsStore().settings.audioLastPlaylistId === id) {
      useSettingsStore().settings.audioLastPlaylistId = ''
    }
    await refreshPlaylists()
  }

  async function addTrackToPlaylist(playlistId: string, trackId: string): Promise<void> {
    const p = findPlaylist(playlistId)
    if (!p || p.trackIds.includes(trackId)) return
    await saveAudioPlaylist({ ...p, trackIds: [...p.trackIds, trackId] })
    await refreshPlaylists()
  }

  async function removeTrackFromPlaylist(playlistId: string, trackId: string): Promise<void> {
    const p = findPlaylist(playlistId)
    if (!p) return
    await saveAudioPlaylist({ ...p, trackIds: p.trackIds.filter((t) => t !== trackId) })
    await refreshPlaylists()
  }

  /** 整序覆盖（拖拽排序后调用） */
  async function reorderPlaylist(playlistId: string, trackIds: string[]): Promise<void> {
    const p = findPlaylist(playlistId)
    if (!p) return
    await saveAudioPlaylist({ ...p, trackIds: [...trackIds] })
    await refreshPlaylists()
  }

  // ═══ 传输 (透传 Manager) ══════════════════════════════

  async function playTrack(trackId: string): Promise<void> { await manager.playTrack(trackId) }

  async function playPlaylist(playlistId: string, startIndex = 0): Promise<void> {
    useSettingsStore().settings.audioLastPlaylistId = playlistId
    await manager.playPlaylist(playlistId, startIndex)
  }

  async function play(): Promise<void> { await manager.play() }
  function pause(): void { manager.pause() }
  async function toggle(): Promise<void> { await manager.toggle() }
  function stop(): void { manager.stop() }
  async function next(): Promise<void> { await manager.next() }
  async function prev(): Promise<void> { await manager.prev() }
  function seek(sec: number): void {
    manager.seek(sec)
    positionSec.value = manager.positionSec
  }

  async function playSfx(trackId: string): Promise<boolean> { return manager.playSfx(trackId) }
  function stopAllSfx(): void { manager.stopAllSfx() }

  /** 🔮 AI 钩子透传 (§8)；v1 无调用方 */
  async function playByTag(tag: string, fallback: 'keep' | 'stop' = 'keep'): Promise<boolean> {
    return manager.playByTag(tag, { fallback })
  }

  function setRepeat(mode: AudioRepeatMode): void {
    manager.setRepeat(mode)
    useSettingsStore().settings.audioRepeat = mode
  }

  function setShuffle(on: boolean): void {
    manager.setShuffle(on)
    useSettingsStore().settings.audioShuffle = on
  }

  async function unlock(): Promise<void> { await manager.unlock() }

  // ═══ 混音 (持久化到 settings, A5) ═════════════════════

  function setMasterVolume(v: number): void {
    manager.setMasterVolume(v)
    useSettingsStore().settings.audioMasterVolume = manager.masterVolume
  }

  function setMasterMuted(m: boolean): void {
    manager.setMasterMuted(m)
    useSettingsStore().settings.audioMasterMuted = m
  }

  function setChannelVolume(ch: 'music' | 'sfx', v: number): void {
    manager.setChannelVolume(ch, v)
    const s = useSettingsStore().settings
    if (ch === 'music') s.audioMusicVolume = manager.state.music.volume
    else s.audioSfxVolume = manager.state.sfx.volume
  }

  function setChannelMuted(ch: 'music' | 'sfx', m: boolean): void {
    manager.setChannelMuted(ch, m)
    const s = useSettingsStore().settings
    if (ch === 'music') s.audioMusicMuted = m
    else s.audioSfxMuted = m
  }

  // ═══ 位置轮询 (§6.3) ══════════════════════════════════
  // 引用计数：两个进度条同时挂载时不互相掐；没人看时不跑定时器。

  let pollTimer: ReturnType<typeof setInterval> | null = null
  let pollRefs = 0

  function startPositionPolling(): void {
    pollRefs += 1
    if (pollTimer) return
    positionSec.value = manager.positionSec
    pollTimer = setInterval(() => {
      positionSec.value = manager.positionSec
    }, POSITION_POLL_MS)
  }

  function stopPositionPolling(force = false): void {
    pollRefs = force ? 0 : Math.max(0, pollRefs - 1)
    if (pollRefs === 0 && pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  return {
    // state
    state,
    tracks,
    playlists,
    builtinTracks,
    loading,
    positionSec,
    folderPermission,
    folderName,
    scanning,
    // lifecycle
    init,
    dispose,
    loadLibrary,
    loadManifest,
    refreshTracks,
    refreshPlaylists,
    restoreSettings,
    // library
    uploadFiles,
    findTrack,
    renameTrack,
    setTrackTags,
    setTrackKind,
    deleteTrack,
    findPlaylist,
    createPlaylist,
    renamePlaylist,
    deletePlaylist,
    addTrackToPlaylist,
    removeTrackFromPlaylist,
    reorderPlaylist,
    // folder
    loadBlob,
    pickFolder,
    grantFolderPermission,
    rescanFolder,
    forgetFolder,
    // transport
    playTrack,
    playPlaylist,
    play,
    pause,
    toggle,
    stop,
    next,
    prev,
    seek,
    playSfx,
    stopAllSfx,
    playByTag,
    setRepeat,
    setShuffle,
    unlock,
    // mixing
    setMasterVolume,
    setMasterMuted,
    setChannelVolume,
    setChannelMuted,
    // position
    startPositionPolling,
    stopPositionPolling,
  }
})
