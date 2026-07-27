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

  // ===== 弹窗接线（AudioDialogs 经 provide/inject 下发给各 band 子组件） =====
  // 模板里的 props/emit 拼写没有任何工具能拦，这两条守住拆分后的跨组件接缝。

  it('新建播放列表弹出输入弹窗（曲目段 → 弹窗助手）', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const btn = wrapper.findAll('.picker-actions button').find((b) => b.text().includes('新建'))
    expect(btn).toBeTruthy()
    await btn!.trigger('click')
    await flushPromises()
    // AppModal 走 Teleport to body，所以在 document 上取
    const input = document.body.querySelector('.dialog-input') as HTMLInputElement | null
    expect(document.body.textContent).toContain('新建播放列表')
    expect(input?.value).toBe('新播放列表')
    wrapper.unmount()
  })

  it('删除曲目先弹确认，取消则不落库（曲库段 → 弹窗助手）', async () => {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    const spy = vi.spyOn(store, 'deleteTrack')
    store.tracks = [
      { id: 'b1', name: '夜曲', kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0 },
    ] as any
    await flushPromises()
    const del = wrapper.find('.track-row-lib').findAll('button')
      .find((b) => b.attributes('aria-label') === '删除曲目')
    await del!.trigger('click')
    await flushPromises()
    expect(document.body.textContent).toContain('此操作不可撤销')
    const cancel = [...document.body.querySelectorAll('.modal-footer button')]
      .find((b) => b.textContent?.includes('取消')) as HTMLButtonElement
    cancel.click()
    await flushPromises()
    expect(spy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('「显示已隐藏的内置曲目」开关跨壳层与曲库双向生效', async () => {
    // 隐藏名单住在 settings，可见曲目由壳层派生后传给曲库；开关本身在曲库工具条上。
    // 这条守住 v-model:show-hidden 这道父子接缝。
    mockSettings.audioHiddenBuiltinIds = ['bt1']
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    store.tracks = [
      { id: 'bt1', name: '内置晨光', kind: 'music', source: 'builtin', builtin: true, tags: [], createdAt: 0, updatedAt: 0 },
    ] as any
    await flushPromises()
    expect(wrapper.findAll('.track-row-lib')).toHaveLength(0)

    await wrapper.find('.reveal-label input').setValue(true)
    await flushPromises()
    const rows = wrapper.findAll('.track-row-lib')
    expect(rows).toHaveLength(1)
    expect(rows[0].classes()).toContain('track-muted')
    wrapper.unmount()
  })

  // ═══ 播放列表拖拽排序 ═══
  // 原生 HTML5 拖放：整行 draggable，落点语义是「放到目标行所在的位次」。
  // ▲▼ 是键盘可达的兜底路径，两者共用同一条写路径（reorderPlaylist）。

  const musicTrack = (id: string, name: string) => ({
    id, name, kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0,
  })

  /** 挂载 + 灌入三首曲子的播放列表并选中它 */
  async function mountWithPlaylist() {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    store.tracks = [musicTrack('a', '甲'), musicTrack('b', '乙'), musicTrack('c', '丙')] as any
    store.playlists = [
      { id: 'p1', name: '夜行', trackIds: ['a', 'b', 'c'], createdAt: 0, updatedAt: 0 },
    ] as any
    await flushPromises()
    await wrapper.find('.picker-item').trigger('click')
    await flushPromises()
    return { wrapper, store }
  }

  const playlistRows = (wrapper: any) => wrapper.findAll('.playlist-tracks .track-row')

  it('拖到首位 → reorderPlaylist 收到正确的目标顺序', async () => {
    const { wrapper, store } = await mountWithPlaylist()
    const spy = vi.spyOn(store, 'reorderPlaylist').mockResolvedValue()
    const rows = playlistRows(wrapper)
    expect(rows).toHaveLength(3)
    await rows[2].trigger('dragstart')
    await rows[0].trigger('dragover')
    await rows[0].trigger('drop')
    expect(spy).toHaveBeenCalledWith('p1', ['c', 'a', 'b'])
    wrapper.unmount()
  })

  it('拖到末位 → reorderPlaylist 收到正确的目标顺序', async () => {
    const { wrapper, store } = await mountWithPlaylist()
    const spy = vi.spyOn(store, 'reorderPlaylist').mockResolvedValue()
    const rows = playlistRows(wrapper)
    await rows[0].trigger('dragstart')
    await rows[2].trigger('dragover')
    await rows[2].trigger('drop')
    expect(spy).toHaveBeenCalledWith('p1', ['b', 'c', 'a'])
    wrapper.unmount()
  })

  it('原地放下不触发任何写入', async () => {
    const { wrapper, store } = await mountWithPlaylist()
    const spy = vi.spyOn(store, 'reorderPlaylist').mockResolvedValue()
    const rows = playlistRows(wrapper)
    await rows[1].trigger('dragstart')
    await rows[1].trigger('dragover')
    await rows[1].trigger('drop')
    expect(spy).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('拖拽中给出被拖行与落点的视觉反馈，结束后复位', async () => {
    const { wrapper, store } = await mountWithPlaylist()
    vi.spyOn(store, 'reorderPlaylist').mockResolvedValue()
    const rows = playlistRows(wrapper)
    await rows[0].trigger('dragstart')
    await rows[2].trigger('dragover')
    expect(playlistRows(wrapper)[0].classes()).toContain('row-dragging')
    expect(playlistRows(wrapper)[2].classes()).toContain('row-drop-target')
    await rows[0].trigger('dragend')
    expect(playlistRows(wrapper)[0].classes()).not.toContain('row-dragging')
    expect(playlistRows(wrapper)[2].classes()).not.toContain('row-drop-target')
    wrapper.unmount()
  })

  it('▲▼ 按钮仍然可用，并与拖拽共用同一条写路径', async () => {
    const { wrapper, store } = await mountWithPlaylist()
    const spy = vi.spyOn(store, 'reorderPlaylist').mockResolvedValue()
    const down = playlistRows(wrapper)[0].findAll('button')
      .find((b: any) => b.attributes('aria-label') === '下移')
    await down!.trigger('click')
    expect(spy).toHaveBeenCalledWith('p1', ['b', 'a', 'c'])
    // 首行的「上移」仍然 disabled（既有可达性不得退化）
    const up = playlistRows(wrapper)[0].findAll('button')
      .find((b: any) => b.attributes('aria-label') === '上移')
    expect(up!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('排序完成后走壳层唯一的 aria-live 区播报一次', async () => {
    const { wrapper, store } = await mountWithPlaylist()
    vi.spyOn(store, 'reorderPlaylist').mockResolvedValue()
    const rows = playlistRows(wrapper)
    await rows[2].trigger('dragstart')
    await rows[0].trigger('dragover')
    await rows[0].trigger('drop')
    await flushPromises()
    const live = wrapper.findAll('[aria-live="polite"]')
    expect(live).toHaveLength(1) // 全分区只有这一处
    expect(live[0].text()).toContain('丙')
    expect(live[0].text()).toContain('第 1 位')
    wrapper.unmount()
  })

  // ═══ 曲库多选 + 批量操作 ═══

  const libTrack = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, name, kind: 'music', source: 'blob', tags: [], createdAt: 0, updatedAt: 0, ...over,
  })

  async function mountWithLibrary(tracks: any[], playlists: any[] = []) {
    const wrapper = mount(AudioSection)
    await flushPromises()
    const store = useAudioStore()
    store.tracks = tracks
    store.playlists = playlists
    await flushPromises()
    return { wrapper, store }
  }

  const libRows = (wrapper: any) => wrapper.findAll('.track-row-lib')

  it('shift 点击选择连续区间', async () => {
    const { wrapper } = await mountWithLibrary([
      libTrack('a', '甲'), libTrack('b', '乙'), libTrack('c', '丙'), libTrack('d', '丁'),
    ])
    const boxes = wrapper.findAll('.row-check')
    await boxes[0].trigger('click')
    await boxes[2].trigger('click', { shiftKey: true })
    expect(wrapper.find('.batch-count').text()).toBe('已选 3 首')
    // 区间外的那行没被牵连
    expect(libRows(wrapper)[3].classes()).not.toContain('row-selected')
    expect(libRows(wrapper)[1].classes()).toContain('row-selected')
    wrapper.unmount()
  })

  it('普通点击是切换，再点一次取消', async () => {
    const { wrapper } = await mountWithLibrary([libTrack('a', '甲'), libTrack('b', '乙')])
    const boxes = wrapper.findAll('.row-check')
    await boxes[0].trigger('click')
    expect(wrapper.find('.batch-count').text()).toBe('已选 1 首')
    await boxes[0].trigger('click')
    expect(wrapper.find('.batch-count').text()).toBe('已选 0 首')
    wrapper.unmount()
  })

  it('全选只作用于当前筛选结果，且标签写明条数', async () => {
    const { wrapper } = await mountWithLibrary([
      libTrack('a', '夜行曲'), libTrack('b', '夜之歌'), libTrack('c', '晨光'),
    ])
    await wrapper.find('input[type="search"]').setValue('夜')
    await flushPromises()
    expect(libRows(wrapper)).toHaveLength(2)
    expect(wrapper.find('.batch-all').text()).toContain('全选当前筛选结果（2 首）')

    await wrapper.find('.batch-all-box').trigger('click')
    expect(wrapper.find('.batch-count').text()).toBe('已选 2 首')

    // 清掉搜索后第三首仍未被选中 —— 全选没有偷偷作用于整个曲库
    await wrapper.find('input[type="search"]').setValue('')
    await flushPromises()
    expect(libRows(wrapper)[2].classes()).not.toContain('row-selected')
    wrapper.unmount()
  })

  it('无选中时批量按钮 disabled', async () => {
    const { wrapper } = await mountWithLibrary([libTrack('a', '甲')])
    const del = wrapper.findAll('.batch-bar button').find((b: any) => b.text().includes('删除选中'))
    expect(del!.attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })

  it('批量删除的确认文案写清爆炸半径（播放列表统计 + 按音源措辞）', async () => {
    const { wrapper } = await mountWithLibrary(
      [libTrack('a', '甲'), libTrack('b', '乙', { source: 'file', relativePath: 'b.mp3' })],
      [
        { id: 'p1', name: '夜行', trackIds: ['a'], createdAt: 0, updatedAt: 0 },
        { id: 'p2', name: '清晨', trackIds: ['a', 'b'], createdAt: 0, updatedAt: 0 },
      ],
    )
    const boxes = wrapper.findAll('.row-check')
    await boxes[0].trigger('click')
    await boxes[1].trigger('click', { shiftKey: true })
    const del = wrapper.findAll('.batch-bar button').find((b: any) => b.text().includes('删除选中'))
    await del!.trigger('click')
    await flushPromises()

    const text = document.body.textContent ?? ''
    expect(text).toContain('删除选中的 2 首曲目？')
    expect(text).toContain('其中 2 首共出现在 2 个播放列表中，删除后将一并移出。')
    expect(text).toContain('其中 1 首来自音乐文件夹，只移除曲库记录，磁盘上的文件不会被删除。')
    expect(text).toContain('1 首存放在浏览器存储中，删除后不可撤销。')
    wrapper.unmount()
  })

  it('批量删除确认后调用 deleteTracks 并清空选择', async () => {
    const { wrapper, store } = await mountWithLibrary([libTrack('a', '甲'), libTrack('b', '乙')])
    const spy = vi.spyOn(store, 'deleteTracks').mockResolvedValue({ ok: 2, skipped: 0, failed: 0 })
    const boxes = wrapper.findAll('.row-check')
    await boxes[0].trigger('click')
    await boxes[1].trigger('click')
    const del = wrapper.findAll('.batch-bar button').find((b: any) => b.text().includes('删除选中'))
    await del!.trigger('click')
    await flushPromises()
    const confirm = [...document.body.querySelectorAll('.modal-footer button')]
      .find((b) => b.textContent?.includes('删除 2 首')) as HTMLButtonElement
    confirm.click()
    await flushPromises()

    expect(spy).toHaveBeenCalledWith(['a', 'b'])
    expect(wrapper.find('.batch-count').text()).toBe('已选 0 首')
    wrapper.unmount()
  })

  it('批量加入播放列表走 addTracksToPlaylist，跳过数如实播报', async () => {
    const { wrapper, store } = await mountWithLibrary(
      [libTrack('a', '甲'), libTrack('b', '乙')],
      [{ id: 'p1', name: '夜行', trackIds: ['a'], createdAt: 0, updatedAt: 0 }],
    )
    const spy = vi.spyOn(store, 'addTracksToPlaylist').mockResolvedValue({ ok: 1, skipped: 1, failed: 0 })
    const boxes = wrapper.findAll('.row-check')
    await boxes[0].trigger('click')
    await boxes[1].trigger('click', { shiftKey: true })
    await wrapper.find('.batch-bar select').setValue('p1')
    const add = wrapper.findAll('.batch-bar button').find((b: any) => b.text().includes('加入'))
    await add!.trigger('click')
    await flushPromises()

    expect(spy).toHaveBeenCalledWith('p1', ['a', 'b'])
    expect(wrapper.find('.batch-count').text()).toBe('已选 0 首')
    const live = wrapper.findAll('[aria-live="polite"]')
    expect(live).toHaveLength(1)
    expect(live[0].text()).toContain('1 首已在列表中，已跳过')
    wrapper.unmount()
  })

  it('曲目消失后不留下悬空的选中 id', async () => {
    const { wrapper, store } = await mountWithLibrary([libTrack('a', '甲'), libTrack('b', '乙')])
    const boxes = wrapper.findAll('.row-check')
    await boxes[0].trigger('click')
    await boxes[1].trigger('click')
    expect(wrapper.find('.batch-count').text()).toBe('已选 2 首')
    store.tracks = [libTrack('a', '甲')] as any
    await flushPromises()
    expect(wrapper.find('.batch-count').text()).toBe('已选 1 首')
    wrapper.unmount()
  })

  it('多选控件有可访问名称，且选中态不只靠颜色', async () => {
    const { wrapper } = await mountWithLibrary([libTrack('a', '甲')])
    const box = wrapper.find('.row-check')
    expect(box.attributes('aria-label')).toBe('选择「甲」')
    expect(wrapper.find('.batch-bar').attributes('aria-label')).toBe('批量操作')
    await box.trigger('click')
    // 勾选框自身的 checked 就是非颜色指示
    expect((box.element as HTMLInputElement).checked).toBe(true)
    wrapper.unmount()
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
