/**
 * audio-singleton.test.ts — 应用级 AudioManager 单例测试
 *
 * @vitest-environment jsdom
 *
 * 需要 jsdom 是因为「首次手势解锁」监听挂在 document 上。jsdom 同样**没有**
 * AudioContext，所以静默降级路径在这里是默认状态，正好是生产环境缺失 Web Audio
 * 时要走的那条路。真实全局存在时的分支用注入的假构造器覆盖。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getAudioManager,
  resetAudioManager,
  setBlobResolver,
  installUnlockListener,
} from './audio-singleton'
import { saveAudioTrack, clearAllData } from '@engine/database'
import type { AudioTrack } from '@engine/types'
import type {
  AudioBufferLike,
  AudioBufferSourceLike,
  AudioElementLike,
  AudioGainLike,
  AudioNodeLike,
  AudioParamLike,
} from '@engine/audio-channels'
import type { ManagerAudioContextLike } from '@engine/audio-manager'

// ═══════════════════════════════════════════════════════════
// 假全局构造器
// 刻意在本文件自建而不复用 audio-fakes.ts —— 这里测的是「工厂怎么挑构造器」，
// 假件要能被计数、能被指使抛错，跟引擎测试的诉求不一样。
// ═══════════════════════════════════════════════════════════

function fakeParam(): AudioParamLike {
  return {
    value: 0,
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    cancelScheduledValues() {},
  }
}

function fakeGain(): AudioGainLike {
  return { gain: fakeParam(), connect() {}, disconnect() {} }
}

function fakeBufferSource(): AudioBufferSourceLike {
  return { buffer: null, onended: null, start() {}, stop() {}, connect() {}, disconnect() {} }
}

/** 构造计数与 close 记录都挂在类上，便于断言单例只造一次 */
class FakeAudioContext implements ManagerAudioContextLike {
  static constructed = 0
  static closed = 0
  static throwOnConstruct = false

  readonly currentTime = 0
  readonly destination: AudioNodeLike = { connect() {}, disconnect() {} }

  constructor() {
    if (FakeAudioContext.throwOnConstruct) throw new Error('AudioContext 构造失败')
    FakeAudioContext.constructed += 1
  }

  createGain(): AudioGainLike { return fakeGain() }
  createBufferSource(): AudioBufferSourceLike { return fakeBufferSource() }
  createMediaElementSource(): AudioNodeLike { return { connect() {}, disconnect() {} } }
  async decodeAudioData(): Promise<AudioBufferLike> { return { duration: 1 } }
  async resume(): Promise<void> {}
  async close(): Promise<void> { FakeAudioContext.closed += 1 }
}

class FakeAudioElement implements AudioElementLike {
  static last: FakeAudioElement | null = null
  static throwOnConstruct = false

  src = ''
  currentTime = 0
  readonly duration = 0

  constructor() {
    if (FakeAudioElement.throwOnConstruct) throw new Error('Audio 构造失败')
    FakeAudioElement.last = this
  }

  async play(): Promise<void> {}
  pause(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}

function makeTrack(overrides: Partial<AudioTrack> = {}): AudioTrack {
  return {
    id: 'track_1',
    name: '测试曲目',
    kind: 'music',
    source: 'blob',
    mimeType: 'audio/mpeg',
    tags: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  }
}

/** 让 unlock() 的 resume() 与 playTrack 的淡出定时器都跑完 */
function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/** 换曲淡出 = AUDIO_DEFAULT_FADE_MS(300)，播放路径必须等它 */
const FADE_WAIT = 400

/** 两条字节来源的长度刻意不同，便于只按 size 辨认来源 */
const INDEXEDDB_BYTES = 'from-indexeddb'
const RESOLVER_BYTES = 'resolver'

// URL.createObjectURL 在 jsdom 里不存在；需要时挂上、退出时摘掉
let urlPatched = false
function patchObjectURL(fn: (blob: Blob) => string): void {
  ;(globalThis.URL as unknown as Record<string, unknown>).createObjectURL = fn
  ;(globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL = () => {}
  urlPatched = true
}

beforeEach(async () => {
  resetAudioManager()
  FakeAudioContext.constructed = 0
  FakeAudioContext.closed = 0
  FakeAudioContext.throwOnConstruct = false
  FakeAudioElement.last = null
  FakeAudioElement.throwOnConstruct = false
  try { await clearAllData() } catch { /* 首次运行时库还不存在 */ }
})

afterEach(() => {
  resetAudioManager()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  if (urlPatched) {
    delete (globalThis.URL as unknown as Record<string, unknown>).createObjectURL
    delete (globalThis.URL as unknown as Record<string, unknown>).revokeObjectURL
    urlPatched = false
  }
})

// ═══════════════════════════════════════════════════════════

describe('惰性单例', () => {
  it('多次调用返回同一实例', () => {
    const a = getAudioManager()
    const b = getAudioManager()
    expect(b).toBe(a)
  })

  it('resetAudioManager() 之后返回新实例', () => {
    const a = getAudioManager()
    resetAudioManager()
    expect(getAudioManager()).not.toBe(a)
  })

  it('仅 import 不构造 AudioContext —— 第一次 getAudioManager() 才构造，且只构造一次', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    expect(FakeAudioContext.constructed).toBe(0)
    getAudioManager()
    getAudioManager()
    expect(FakeAudioContext.constructed).toBe(1)
  })

  it('resetAudioManager() 会 dispose 旧实例（关闭 AudioContext）', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    getAudioManager()
    expect(FakeAudioContext.closed).toBe(0)
    resetAudioManager()
    expect(FakeAudioContext.closed).toBe(1)
  })

  it('没有实例时 resetAudioManager() 安全空转，可重复调用', () => {
    expect(() => { resetAudioManager(); resetAudioManager() }).not.toThrow()
  })
})

describe('浏览器工厂：真实全局可用时使用之', () => {
  it('存在 AudioContext 时用它构造', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    getAudioManager()
    expect(FakeAudioContext.constructed).toBe(1)
  })

  it('只有 webkitAudioContext 时回落到它', () => {
    vi.stubGlobal('webkitAudioContext', FakeAudioContext)
    getAudioManager()
    expect(FakeAudioContext.constructed).toBe(1)
  })

  it('存在 Audio 时构造元素并置 crossOrigin=anonymous', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('Audio', FakeAudioElement)
    getAudioManager()
    expect(FakeAudioElement.last).not.toBeNull()
    expect((FakeAudioElement.last as unknown as Record<string, unknown>).crossOrigin)
      .toBe('anonymous')
  })
})

describe('静默降级：无 Web Audio 时返回 no-op 桩而不抛错', () => {
  it('jsdom（无 AudioContext）下构造不抛错', () => {
    expect(() => getAudioManager()).not.toThrow()
  })

  it('AudioContext 构造抛错时降级到静默桩，不向外抛', () => {
    FakeAudioContext.throwOnConstruct = true
    vi.stubGlobal('AudioContext', FakeAudioContext)
    expect(() => getAudioManager()).not.toThrow()
  })

  it('Audio 构造抛错时降级到静默元素，不向外抛', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    FakeAudioElement.throwOnConstruct = true
    vi.stubGlobal('Audio', FakeAudioElement)
    expect(() => getAudioManager()).not.toThrow()
  })

  it('降级后的 manager 各项调用都不炸（只是没有声音）', async () => {
    const m = getAudioManager()
    m.setTracks([makeTrack()])
    m.setPlaylists([])
    m.setMasterVolume(0.5)
    m.setMasterMuted(true)
    m.setChannelVolume('music', 0.3)
    m.setChannelMuted('sfx', true)
    m.setRepeat('all')
    m.setShuffle(true)
    await expect(m.unlock()).resolves.toBeUndefined()
    await expect(m.playTrack('track_1')).resolves.toBeUndefined()
    m.pause()
    m.stop()
    m.seek(3)
    m.stopAllSfx()
    expect(m.masterVolume).toBe(0.5)
    expect(m.masterMuted).toBe(true)
    expect(() => m.dispose()).not.toThrow()
  }, 10_000)

  it('静默桩的 resume() 可解锁 —— 无 Web Audio 也不会卡在锁定态', async () => {
    const m = getAudioManager()
    expect(m.state.unlocked).toBe(false)
    await m.unlock()
    expect(m.state.unlocked).toBe(true)
  })

  it('无 URL.createObjectURL 时取 URL 得空串，播放路径静默失败而不抛', async () => {
    const m = getAudioManager()
    m.setTracks([makeTrack()])
    await m.unlock()
    setBlobResolver(async () => new Blob(['bytes']))
    await expect(m.playTrack('track_1')).resolves.toBeUndefined()
  }, 10_000)
})

describe('installUnlockListener', () => {
  it('pointerdown 触发解锁', async () => {
    installUnlockListener()
    expect(getAudioManager().state.unlocked).toBe(false)
    document.dispatchEvent(new Event('pointerdown'))
    await flush()
    expect(getAudioManager().state.unlocked).toBe(true)
  })

  it('keydown 同样触发解锁', async () => {
    installUnlockListener()
    document.dispatchEvent(new Event('keydown'))
    await flush()
    expect(getAudioManager().state.unlocked).toBe(true)
  })

  it('首次手势后两个监听都自摘，重复事件不再解锁', async () => {
    const remove = vi.spyOn(document, 'removeEventListener')
    installUnlockListener()
    document.dispatchEvent(new Event('pointerdown'))
    await flush()

    const removed = remove.mock.calls.map((c) => c[0])
    expect(removed).toContain('pointerdown')
    expect(removed).toContain('keydown')

    // 自摘后再来一发：manager 换新实例也不会被解锁
    resetAudioManager()
    document.dispatchEvent(new Event('pointerdown'))
    document.dispatchEvent(new Event('keydown'))
    await flush()
    expect(getAudioManager().state.unlocked).toBe(false)
  })

  it('幂等：重复调用只注册一对监听', () => {
    const add = vi.spyOn(document, 'addEventListener')
    installUnlockListener()
    installUnlockListener()
    installUnlockListener()
    const types = add.mock.calls.map((c) => c[0]).filter((t) => t === 'pointerdown' || t === 'keydown')
    expect(types).toEqual(['pointerdown', 'keydown'])
  })

  it('安装本身不构造 manager —— 只有手势到来时才惰性构造', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext)
    installUnlockListener()
    expect(FakeAudioContext.constructed).toBe(0)
    document.dispatchEvent(new Event('pointerdown'))
    expect(FakeAudioContext.constructed).toBe(1)
  })

  it('resetAudioManager() 之后可重新安装', () => {
    const add = vi.spyOn(document, 'addEventListener')
    installUnlockListener()
    resetAudioManager()
    installUnlockListener()
    const types = add.mock.calls.map((c) => c[0]).filter((t) => t === 'pointerdown')
    expect(types).toHaveLength(2)
  })

  it('无 document（node 环境）时安全空转', () => {
    vi.stubGlobal('document', undefined)
    expect(() => installUnlockListener()).not.toThrow()
  })
})

describe('setBlobResolver', () => {
  it('装入后 manager 走新的解析器', async () => {
    const resolver = vi.fn(async () => new Blob([RESOLVER_BYTES]))
    patchObjectURL(() => 'blob:fake')

    const m = getAudioManager()
    m.setTracks([makeTrack()])
    await m.unlock()
    setBlobResolver(resolver)
    await m.playTrack('track_1')
    await flush(FADE_WAIT)

    expect(resolver).toHaveBeenCalledWith('track_1')
  }, 10_000)

  it('未装解析器时走默认的 IndexedDB 直读', async () => {
    const seen: Blob[] = []
    patchObjectURL((blob) => { seen.push(blob); return 'blob:fake' })

    const track = makeTrack()
    await saveAudioTrack(track, new Blob([INDEXEDDB_BYTES]))

    const m = getAudioManager()
    m.setTracks([track])
    await m.unlock()
    await m.playTrack('track_1')
    await flush(FADE_WAIT)

    // fake-indexeddb 往返回来的对象不是可读的 Blob（结构化克隆的产物），
    // 只断言"字节被取到并交给了 createObjectURL"，不去读内容。
    expect(seen).toHaveLength(1)
  }, 10_000)

  it('默认解析器确实在查 IndexedDB —— 库中无字节时取不到，播放静默中止', async () => {
    const seen: Blob[] = []
    patchObjectURL((blob) => { seen.push(blob); return 'blob:fake' })

    const m = getAudioManager()
    m.setTracks([makeTrack()])   // 只灌元数据，不写 audioBlobs
    await m.unlock()
    await m.playTrack('track_1')
    await flush(FADE_WAIT)

    expect(seen).toHaveLength(0)
    expect(m.state.music.trackId).toBeNull()
  }, 10_000)

  it('传 null 恢复默认解析器', async () => {
    const resolver = vi.fn(async () => new Blob([RESOLVER_BYTES]))
    const seen: Blob[] = []
    patchObjectURL((blob) => { seen.push(blob); return 'blob:fake' })

    const track = makeTrack()
    await saveAudioTrack(track, new Blob([INDEXEDDB_BYTES]))

    const m = getAudioManager()
    m.setTracks([track])
    await m.unlock()
    setBlobResolver(resolver)
    setBlobResolver(null)
    await m.playTrack('track_1')
    await flush(FADE_WAIT)

    expect(resolver).not.toHaveBeenCalled()
    expect(seen).toHaveLength(1)   // 字节来自 IndexedDB，不是被卸下的解析器
  }, 10_000)

  it('resetAudioManager() 会卸下解析器', async () => {
    const resolver = vi.fn(async () => new Blob([RESOLVER_BYTES]))
    setBlobResolver(resolver)
    resetAudioManager()
    patchObjectURL(() => 'blob:fake')

    const m = getAudioManager()
    m.setTracks([makeTrack()])
    await m.unlock()
    await m.playTrack('track_1')
    await flush(FADE_WAIT)

    expect(resolver).not.toHaveBeenCalled()
  }, 10_000)
})
