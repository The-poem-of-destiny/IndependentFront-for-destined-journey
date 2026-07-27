/**
 * MiniPlayer 组件测试 (Phase Audio §6.2)
 *
 * 覆盖: 无 AudioContext 环境降级不抛错 / Esc 关闭 / 传输按钮打到正确的 store 动作。
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import MiniPlayer from './MiniPlayer.vue'
import { useAudioStore } from '../../stores/audio-store'
import type { AudioTrack } from '@engine/types'

function makeTrack(id = 't1', name = '夜行曲'): AudioTrack {
  return {
    id,
    name,
    kind: 'music',
    source: 'blob',
    tags: [],
    createdAt: 0,
    updatedAt: 0,
  }
}

/** teleport 到 body，所以查询走 document 而非 wrapper */
function q(sel: string): HTMLElement | null {
  return document.querySelector(sel)
}
function byLabel(label: string): HTMLElement {
  const el = document.querySelector(`[aria-label="${label}"]`)
  if (!el) throw new Error(`未找到 aria-label="${label}" 的元素`)
  return el as HTMLElement
}
function click(el: HTMLElement) {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('MiniPlayer', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    document.body.innerHTML = ''
  })

  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('在没有 AudioContext 的环境里也能渲染（单例降级为静默桩，不抛错）', async () => {
    expect((globalThis as Record<string, unknown>).AudioContext).toBeUndefined()
    const wrapper = mount(MiniPlayer, { props: { open: true } })
    await flushPromises()
    expect(q('.mini-player')).not.toBeNull()
    wrapper.unmount()
  })

  it('open=false 时不渲染卡片', () => {
    mount(MiniPlayer, { props: { open: false } })
    expect(q('.mini-player')).toBeNull()
  })

  it('未解锁时显示「点击页面任意处」提示而非静默失败', async () => {
    const audio = useAudioStore()
    vi.spyOn(audio, 'init').mockResolvedValue()
    audio.state.unlocked = false
    mount(MiniPlayer, { props: { open: true } })
    await nextTick()
    expect(q('.mp-hint')?.textContent).toContain('点击页面任意处')
  })

  it('按下 Esc 关闭卡片', async () => {
    const audio = useAudioStore()
    vi.spyOn(audio, 'init').mockResolvedValue()
    const wrapper = mount(MiniPlayer, { props: { open: true } })
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('点击卡片外部关闭，点击卡片内部不关闭', async () => {
    const audio = useAudioStore()
    vi.spyOn(audio, 'init').mockResolvedValue()
    const wrapper = mount(MiniPlayer, { props: { open: true } })
    await nextTick()

    q('.mini-player')!.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeFalsy()

    document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    await nextTick()
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('打开时开始位置轮询，关闭时停止', async () => {
    const audio = useAudioStore()
    vi.spyOn(audio, 'init').mockResolvedValue()
    const start = vi.spyOn(audio, 'startPositionPolling')
    const stop = vi.spyOn(audio, 'stopPositionPolling')
    const wrapper = mount(MiniPlayer, { props: { open: true } })
    await nextTick()
    expect(start).toHaveBeenCalledTimes(1)
    expect(stop).not.toHaveBeenCalled()

    await wrapper.setProps({ open: false })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  describe('传输控制', () => {
    let audio: ReturnType<typeof useAudioStore>

    beforeEach(async () => {
      audio = useAudioStore()
      vi.spyOn(audio, 'init').mockResolvedValue()
      audio.tracks = [makeTrack()]
      audio.state.unlocked = true
      audio.state.music.trackId = 't1'
      audio.state.music.durationSec = 120
    })

    it('⏯ / ⏮ / ⏭ 调用对应的 store 动作', async () => {
      const toggle = vi.spyOn(audio, 'toggle').mockResolvedValue()
      const prev = vi.spyOn(audio, 'prev').mockResolvedValue()
      const next = vi.spyOn(audio, 'next').mockResolvedValue()
      mount(MiniPlayer, { props: { open: true } })
      await nextTick()

      click(byLabel('播放'))
      click(byLabel('上一曲'))
      click(byLabel('下一曲'))

      expect(toggle).toHaveBeenCalledTimes(1)
      expect(prev).toHaveBeenCalledTimes(1)
      expect(next).toHaveBeenCalledTimes(1)
    })

    it('循环按钮按 off → all → one 轮换', async () => {
      const setRepeat = vi.spyOn(audio, 'setRepeat').mockImplementation(() => {})
      audio.state.music.repeat = 'off'
      mount(MiniPlayer, { props: { open: true } })
      await nextTick()

      click(byLabel('不循环'))
      expect(setRepeat).toHaveBeenCalledWith('all')
    })

    it('随机按钮取反 shuffle', async () => {
      const setShuffle = vi.spyOn(audio, 'setShuffle').mockImplementation(() => {})
      audio.state.music.shuffle = false
      mount(MiniPlayer, { props: { open: true } })
      await nextTick()

      click(byLabel('随机播放'))
      expect(setShuffle).toHaveBeenCalledWith(true)
    })

    it('静音按钮调用 setMasterMuted', async () => {
      const setMuted = vi.spyOn(audio, 'setMasterMuted').mockImplementation(() => {})
      audio.state.masterMuted = false
      mount(MiniPlayer, { props: { open: true } })
      await nextTick()

      click(byLabel('静音'))
      expect(setMuted).toHaveBeenCalledWith(true)
    })

    it('显示当前曲名', async () => {
      mount(MiniPlayer, { props: { open: true } })
      await nextTick()
      expect(q('.mp-title')?.textContent).toContain('夜行曲')
    })

    it('曲库为空时显示空态', async () => {
      audio.tracks = []
      mount(MiniPlayer, { props: { open: true } })
      await nextTick()
      expect(q('.mp-empty')).not.toBeNull()
    })
  })
})
