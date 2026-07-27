/**
 * AudioSection.vue — 音频设置分区冒烟 + 接线测试
 *
 * 覆盖：
 * 1. jsdom 无 AudioContext / Audio 时能挂载（单例降级到静默桩，不得抛错）
 * 2. 曲库为空时渲染空态（装饰符 + 斜体说明）
 * 3. 音量滑块调用正确的 store 动作（master / music / sfx）
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import AudioSection from './AudioSection.vue'
import { useAudioStore } from '../../stores/audio-store'
import { resetAudioManager } from '../../lib/audio-singleton'

// ---- Mocks: Dexie 在 jsdom 下不可用，整层替掉 ----
vi.mock('@engine/database', () => ({
  getAudioTracks: vi.fn(async () => []),
  saveAudioTrack: vi.fn(async () => {}),
  deleteAudioTrack: vi.fn(async () => {}),
  getAudioPlaylists: vi.fn(async () => []),
  saveAudioPlaylist: vi.fn(async () => {}),
  deleteAudioPlaylist: vi.fn(async () => {}),
  getAudioBlob: vi.fn(async () => undefined),
  // audio-folder 经 audio-store 间接引入，缺这三个导出会在真调用时炸
  getAudioHandle: vi.fn(async () => undefined),
  saveAudioHandle: vi.fn(async () => 'library-root'),
  deleteAudioHandle: vi.fn(async () => {}),
}))

// settings-store: 只给本组件需要的表面，避开启动期 fetch / 世界书加载
const mockSettings: Record<string, any> = {}
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({
    settings: mockSettings,
    getStorageUsage: async () => ({ used: 1024, quota: 2048, pct: 50 }),
  }),
}))

// manifest fetch → 404 静默
const fetchMock = vi.fn(async () => ({ ok: false, json: async () => [] }))

beforeEach(() => {
  vi.clearAllMocks()
  resetAudioManager()
  setActivePinia(createPinia())
  for (const k of Object.keys(mockSettings)) delete mockSettings[k]
  Object.assign(mockSettings, {
    audioMasterVolume: 0.7,
    audioMasterMuted: false,
    audioMusicVolume: 0.6,
    audioMusicMuted: false,
    audioSfxVolume: 0.5,
    audioSfxMuted: false,
    audioRepeat: 'all',
    audioShuffle: false,
    audioLastPlaylistId: '',
    audioHiddenBuiltinIds: [],
  })
  ;(globalThis as any).fetch = fetchMock
})

describe('AudioSection', () => {
  it('无 AudioContext 的环境下能挂载而不抛错', async () => {
    expect((globalThis as any).AudioContext).toBeUndefined()
    const wrapper = mount(AudioSection)
    await flushPromises()
    expect(wrapper.find('.audio-section').exists()).toBe(true)
    expect(wrapper.text()).toContain('混音台')
    expect(wrapper.text()).toContain('播放列表')
    expect(wrapper.text()).toContain('曲库')
  })

  it('曲库与播放列表为空时渲染空态', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const empties = wrapper.findAll('.empty-tab')
    expect(empties.length).toBeGreaterThan(0)
    const text = empties.map((e) => e.text()).join(' ')
    expect(text).toContain('曲库尚空')
    expect(text).toContain('播放列表')
  })

  it('渲染三条混音通道 + 存储用量', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    expect(wrapper.findAll('.mix-row')).toHaveLength(3)
    expect(wrapper.text()).toContain('主音量')
    expect(wrapper.text()).toContain('音效')
    expect(wrapper.find('.usage-text').text()).toContain('50.0%')
  })

  it('拖动主音量滑块调用 setMasterVolume', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    const spy = vi.spyOn(store, 'setMasterVolume')
    const input = wrapper.findAll('.mix-row .slider-input')[0]
    await input.setValue('40')
    expect(spy).toHaveBeenCalledWith(0.4)
  })

  it('拖动音乐/音效滑块调用 setChannelVolume 并带上通道名', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    const spy = vi.spyOn(store, 'setChannelVolume')
    const inputs = wrapper.findAll('.mix-row .slider-input')
    await inputs[1].setValue('20')
    await inputs[2].setValue('100')
    expect(spy).toHaveBeenNthCalledWith(1, 'music', 0.2)
    expect(spy).toHaveBeenNthCalledWith(2, 'sfx', 1)
  })

  it('静音按钮调用对应的 muted 动作', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    const masterSpy = vi.spyOn(store, 'setMasterMuted')
    const chSpy = vi.spyOn(store, 'setChannelMuted')
    const btns = wrapper.findAll('.mix-row .icon-btn')
    await btns[0].trigger('click')
    await btns[1].trigger('click')
    expect(masterSpy).toHaveBeenCalledWith(true)
    expect(chSpy).toHaveBeenCalledWith('music', true)
  })

  // ===== 音乐文件夹（addendum §UI changes） =====

  /** 挂载后强制某个授权态；folderPermission 是 store 的 ref，直接改即可 */
  async function mountWithPermission(perm: string, folderName = '') {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    store.folderPermission = perm as any
    store.folderName = folderName
    await flushPromises()
    return { wrapper, store }
  }

  it('不支持 File System Access 时说明上传落到浏览器存储', async () => {
    const { wrapper } = await mountWithPermission('unsupported')
    const strip = wrapper.find('.folder-strip')
    expect(strip.exists()).toBe(true)
    expect(strip.text()).toContain('浏览器存储')
    // 上传通道在任何状态下都必须还在
    expect(wrapper.find('input[type="file"]').exists()).toBe(true)
  })

  it('未选文件夹时提供「选择音乐文件夹」并调用 pickFolder', async () => {
    const { wrapper, store } = await mountWithPermission('none')
    const spy = vi.spyOn(store, 'pickFolder').mockResolvedValue(true)
    const btn = wrapper.findAll('.folder-strip button').find((b) => b.text().includes('选择音乐文件夹'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    expect(spy).toHaveBeenCalled()
  })

  it('prompt 态渲染授权按钮 + 每会话一次的说明', async () => {
    const { wrapper, store } = await mountWithPermission('prompt', '我的音乐')
    const strip = wrapper.find('.folder-strip')
    expect(strip.text()).toContain('授权访问音乐文件夹')
    expect(strip.text()).toContain('每次启动')
    const spy = vi.spyOn(store, 'grantFolderPermission').mockResolvedValue(true)
    const btn = strip.findAll('button').find((b) => b.text().includes('授权访问音乐文件夹'))
    await btn!.trigger('click')
    expect(spy).toHaveBeenCalled()
  })

  it('granted 态显示文件夹名/曲目数并提供重新扫描与取消关联', async () => {
    const { wrapper, store } = await mountWithPermission('granted', '我的音乐')
    store.tracks = [
      { id: 'f1', name: 'A', kind: 'music', source: 'file', relativePath: 'a.mp3', tags: [], createdAt: 0, updatedAt: 0 },
    ] as any
    await flushPromises()
    const strip = wrapper.find('.folder-strip')
    expect(strip.text()).toContain('我的音乐')
    expect(strip.text()).toContain('1')
    const labels = strip.findAll('button').map((b) => b.text())
    expect(labels.some((t) => t.includes('重新扫描'))).toBe(true)
    expect(labels.some((t) => t.includes('取消关联'))).toBe(true)
  })

  it('denied 态说明被拒并提供重新授权', async () => {
    const { wrapper } = await mountWithPermission('denied', '我的音乐')
    const strip = wrapper.find('.folder-strip')
    expect(strip.text()).toContain('拒绝')
    expect(strip.findAll('button').some((b) => b.text().includes('重新授权'))).toBe(true)
  })

  it('已连接文件夹时上传入口仍然在', async () => {
    const { wrapper } = await mountWithPermission('granted', '我的音乐')
    expect(wrapper.find('input[type="file"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('上传音频')
  })

  it('missing 曲目渲染「文件已移除」徽章且试听被禁用', async () => {
    const { wrapper, store } = await mountWithPermission('granted', '我的音乐')
    store.tracks = [
      {
        id: 'f1', name: '走失的曲子', kind: 'music', source: 'file',
        relativePath: 'a.mp3', missing: true, tags: [], createdAt: 0, updatedAt: 0,
      },
    ] as any
    await flushPromises()
    const row = wrapper.find('.track-row-lib')
    expect(row.exists()).toBe(true)
    expect(row.find('.missing-badge').text()).toBe('文件已移除')
    expect(row.classes()).toContain('track-muted')
    const audition = row.findAll('button').find((b) => b.attributes('aria-label')?.includes('试听'))
    expect(audition!.attributes('disabled')).toBeDefined()
    // 编辑/删除仍可用 —— 标签与播放列表位次是用户的整理成果
    expect(row.findAll('button').some((b) => b.attributes('aria-label') === '编辑曲目')).toBe(true)
  })

  it('卸载时停止进度轮询', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    const spy = vi.spyOn(store, 'stopPositionPolling')
    wrapper.unmount()
    expect(spy).toHaveBeenCalled()
  })
})
