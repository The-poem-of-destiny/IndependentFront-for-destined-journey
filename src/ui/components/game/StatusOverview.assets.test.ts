/**
 * StatusOverview — 玩家画像的素材渲染 + 定点导入接线
 *
 * 覆盖:
 * - 无素材 → 退回 AvatarPanel 原本的首字母占位（v1 的默认形态）
 * - 有素材 → `<img>` 铺满画像框（名字严格 `===`，D2）
 * - 🔴 **按命中的档位分叉呈现**: `立绘` / `立绘bg` → 顶对齐的大画像；
 *   只有 `头像` → 留在 1:1 小方框（把一张脸的特写拉满整栏看起来像 bug）
 * - 🔴 **点画像的去处按"有没有东西可调"分叉**（这次改版的核心）:
 *   · 已是大画像（立绘 / 立绘bg）→ 开 `PortraitSettingsDialog`（取景滑块 + 更换图片）；
 *   · 没素材、或只有一张头像 → **直接**开文件选择框，不弹一个只有一个按钮可点的窗
 * - 画像上**没有任何家具**: 相机徽章与取景旋钮都已删除（它们盖在图上，
 *   而旋钮的浮层还会盖住画像自己）
 * - 点击 / Enter / 空格 都走同一条去处（空格必须 preventDefault，否则页面滚动）
 * - 选中**图片** → 开裁剪台（`AssetCropEditor`），一张源图烘出 `立绘` + `头像`。
 *   🔴 名字传的是**玩家名**，不是文件名 —— 这条路径上文件名只贡献扩展名，
 *   否则库里会长出一个叫 `IMG_1234` 的幽灵角色组
 * - 选中 **mp4** → **不开**裁剪台（画布只取得到某一帧，且 D7 不让视频落在 `立绘` 上），
 *   走直通的 `importForCharacter(file, 玩家名, '头像')`
 * - 取消裁剪台 → 不留半张素材、不卡住、且**同一个文件再选一次照样能开**
 *   （file input 的值不清空就不会再触发 change —— 经典坑）
 * - D16 / D19 名字拒收 → 提示必须说「角色名当不了文件名」，而不是含糊的「导入失败」
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { reactive } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import StatusOverview from './StatusOverview.vue'
import AssetCropEditor from '../shared/AssetCropEditor.vue'
import PortraitSettingsDialog from '../shared/PortraitSettingsDialog.vue'
import type { AssetMetaRecord } from '@engine/types'

// ---- Mocks ----

let mockGame: any
let mockAssets: any
const toast = vi.fn()

vi.mock('../../stores/game-store', () => ({
  useGameStore: () => mockGame,
}))
vi.mock('../../stores/settings-store', () => ({
  useSettingsStore: () => ({ settings: {} }),
}))
vi.mock('../../stores/ui-store', () => ({
  useUIStore: () => ({ toast }),
}))
vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => mockAssets,
}))

function makePlayer(name: string) {
  return {
    name,
    level: 3,
    hp: 10, maxHp: 10, mp: 5, maxMp: 5, sp: 5, maxSp: 5,
    totalExp: 0, expToNext: 100,
    money: 0,
    attributes: { str: 1, dex: 1, con: 1, int: 1, spi: 1 },
    inventory: [],
    skills: [],
    statusEffects: [],
    race: '人族',
    identity: [], occupation: [],
    tierName: '普通',
  }
}

function makeRow(name: string, over: Partial<AssetMetaRecord> = {}): AssetMetaRecord {
  return {
    id: 'asset_1',
    name,
    type: '头像',
    ext: 'png',
    mime: 'image/png',
    bytes: 12,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockGame = {
    player: makePlayer('苏婉'),
    fp: 0,
    isGenerating: false,
    activeSaveId: 'save_1',
    showModal: vi.fn(),
    loadSave: vi.fn(),
  }
  // 🔴 **reactive** 而不是裸对象: `useAssetImage` 的共享索引是 `computed(() =>
  // buildAssetIndex(source.assets))`，裸对象读不出依赖 —— 于是"落库后画像自己换过来"
  // 这条会计恒等式在测试里恒真却在生产里可能是假的。
  mockAssets = reactive({
    assets: [] as AssetMetaRecord[],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
    importForCharacter: vi.fn(async () => ({ outcome: 'ok', id: 'asset_1' })),
    importPortraitPair: vi.fn(async () => ({ outcome: 'ok', portraitId: 'st', avatarId: 'av' })),
    setAssetFraming: vi.fn(async () => ({ outcome: 'ok' })),
  })
})

/** 把一个 File 塞进隐藏的 file input 并触发 change */
async function chooseFile(wrapper: ReturnType<typeof mount>, file: File) {
  const input = wrapper.find('input.portrait-file')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

const png = () => new File(['x'], 'IMG_1234.png', { type: 'image/png' })
const mp4 = () => new File(['x'], 'CLIP_9.mp4', { type: 'video/mp4' })

describe('StatusOverview — 画像素材渲染', () => {
  it('库里没有对应素材 → 保留 AvatarPanel 的首字母占位，不渲染空图', async () => {
    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.portrait-slot img').exists()).toBe(false)
    expect(wrapper.find('.portrait-slot video').exists()).toBe(false)
    expect(wrapper.find('.portrait-slot .avatar-text').text()).toBe('苏婉')
  })

  it('库里有同名头像 → 渲染 <img>，占位首字母让位', async () => {
    mockAssets.assets = [makeRow('苏婉')]
    mockAssets.assetUrl = vi.fn(async () => 'blob:portrait')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    const img = wrapper.find('.portrait-slot img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('blob:portrait')
    expect(wrapper.find('.portrait-slot .avatar-text').exists()).toBe(false)
  })

  it('名字差一个空格就当另一个角色 —— 严格 === 不归一化（D2）', async () => {
    mockAssets.assets = [makeRow('苏婉 ')] // 尾随空格
    mockAssets.assetUrl = vi.fn(async () => 'blob:portrait')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.portrait-slot img').exists()).toBe(false)
    expect(wrapper.find('.portrait-slot .avatar-text').text()).toBe('苏婉')
  })
})

describe('StatusOverview — 大画像 vs 小方框的分叉（按命中的档位）', () => {
  it('只有头像 → 留在 1:1 小方框，不铺成大画像', async () => {
    mockAssets.assets = [makeRow('苏婉', { type: '头像' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:av')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.character-portrait').exists()).toBe(false)
    expect(wrapper.find('.portrait-slot .avatar-shape-square').exists()).toBe(true)
    expect(wrapper.find('.portrait-slot').classes()).not.toContain('large')
  })

  it('有立绘 → 顶对齐的大画像，小方框让位', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'st', type: '立绘' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:st')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.character-portrait').exists()).toBe(true)
    expect(wrapper.find('.portrait-slot').classes()).toContain('large')
    expect(wrapper.find('.portrait-frame img').attributes('src')).toBe('blob:st')
    expect(wrapper.find('.avatar-shape-square').exists()).toBe(false)
  })

  /**
   * 🔴 画像上**一个控件都不许有**。上一版把取景旋钮和相机徽章盖在图上，
   * 旋钮弹出的浮层还盖住画像自己 —— 这条断言是防回潮的闸。
   */
  it('🔴 大画像上没有任何按钮/徽章（旋钮与相机徽章都已删除）', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'st', type: '立绘' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:st')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.portrait-slot button').exists()).toBe(false)
    expect(wrapper.find('.portrait-hint').exists()).toBe(false)
    expect(wrapper.find('.framing-dial').exists()).toBe(false)
    expect(wrapper.find('.framing-pop').exists()).toBe(false)
  })

  it('🔴 小方框形态同样没有相机徽章', async () => {
    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.portrait-slot button').exists()).toBe(false)
    expect(wrapper.find('.portrait-hint').exists()).toBe(false)
  })

  it('立绘bg 也走大画像（同样是整幅构图）', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'bg', type: '立绘bg' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:bg')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.character-portrait').exists()).toBe(true)
  })

  it('立绘与头像都有 → 立牌链先命中立绘，走大画像', async () => {
    mockAssets.assets = [
      makeRow('苏婉', { id: 'av', type: '头像' }),
      makeRow('苏婉', { id: 'st', type: '立绘' }),
    ]
    mockAssets.assetUrl = vi.fn(async (id: string) => `blob:${id}`)

    const wrapper = mount(StatusOverview)
    await flushPromises()

    expect(wrapper.find('.character-portrait').exists()).toBe(true)
    expect(wrapper.find('.portrait-frame img').attributes('src')).toBe('blob:st')
  })

  it('库里存的取景落到大画像的 CSS 上（顶对齐是缺省）', async () => {
    mockAssets.assets = [
      makeRow('苏婉', { id: 'st', type: '立绘', framing: { x: 40, y: 15, scale: 1.4 } }),
    ]
    mockAssets.assetUrl = vi.fn(async () => 'blob:st')

    const wrapper = mount(StatusOverview)
    await flushPromises()

    const img = wrapper.find('.portrait-frame img').element as HTMLElement
    expect(img.style.getPropertyValue('object-position')).toBe('40% 15%')
    expect(img.style.getPropertyValue('transform')).toBe('scale(1.4)')
  })
})

// ═══════════════════════════════════════════════════════════
// 身份条的落位：盖在大画像上 vs 留在画像上方自己一行
// ═══════════════════════════════════════════════════════════

describe('StatusOverview — 身份条落位（有大画像才 overlay）', () => {
  /** 库里给一张立绘 —— 大画像形态 */
  async function mountLarge() {
    mockAssets.assets = [makeRow('苏婉', { id: 'st', type: '立绘' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:st')
    const wrapper = mount(StatusOverview)
    await flushPromises()
    return wrapper
  }

  it('🔴 有立绘 → 身份条盖在画像里（画像槽的后代），不再是画像上方那一行', async () => {
    const wrapper = await mountLarge()

    // 就在槽里 —— 这既是"盖在画上"的落位，也是点击能冒泡到槽的前提
    expect(wrapper.find('.portrait-slot .identity-strip .identity-line').exists()).toBe(true)
    // 上方那一行没了（section-header 里不该再有身份文字）
    expect(wrapper.find('.section-header .identity-line').exists()).toBe(false)
    // 只有一份，不是两处同时渲染
    expect(wrapper.findAll('.identity-line')).toHaveLength(1)
  })

  it('🔴 没有素材 → 身份条留在画像**上方**自己一行（通栏字条会吞掉 11.25rem 小方框）', async () => {
    const wrapper = mount(StatusOverview)
    await flushPromises()
    expect(wrapper.find('.character-portrait').exists()).toBe(false)

    expect(wrapper.find('.section-header .identity-line').exists()).toBe(true)
    expect(wrapper.find('.portrait-slot .identity-line').exists()).toBe(false)
    expect(wrapper.find('.identity-strip').exists()).toBe(false)
    expect(wrapper.findAll('.identity-line')).toHaveLength(1)
  })

  it('🔴 只有头像 → 同样留在上方一行（小方框形态不 overlay）', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'av', type: '头像' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:av')

    const wrapper = mount(StatusOverview)
    await flushPromises()
    expect(wrapper.find('.character-portrait').exists()).toBe(false)

    expect(wrapper.find('.section-header .identity-line').exists()).toBe(true)
    expect(wrapper.find('.identity-strip').exists()).toBe(false)
  })

  it('立绘bg 也 overlay（同样是整幅构图）', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'bg', type: '立绘bg' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:bg')

    const wrapper = mount(StatusOverview)
    await flushPromises()
    expect(wrapper.find('.portrait-slot .identity-strip').exists()).toBe(true)
  })

  /**
   * 一行放不下就是省略号 —— 完整的**带标签**版本必须还在 title 上，
   * 两种落位都不能丢（丢了就等于用户永远看不到被截掉的那几项）。
   */
  it('两种落位都保留单行截断 + 完整带标签的 title', async () => {
    const expected = '种族：人族　身份：—　职业：—　生命层级：普通　冒险者等级：—'

    const plain = mount(StatusOverview)
    await flushPromises()
    const plainLine = plain.find('.identity-line')
    expect(plainLine.attributes('title')).toBe(expected)
    // 截断靠 white-space:nowrap + ellipsis，文本本身不做任何裁剪
    expect(plainLine.text()).toContain('人族')

    const large = await mountLarge()
    const largeLine = large.find('.portrait-slot .identity-line')
    expect(largeLine.attributes('title')).toBe(expected)
    expect(largeLine.text()).toContain('人族')
  })

  it('生命层级仍带 tier-text 类（overlay 里靠它提亮，不是另换一色）', async () => {
    const wrapper = await mountLarge()
    expect(wrapper.find('.identity-strip .tier-text').text()).toBe('普通')
  })

  /**
   * 🔴 身份条不许挡住"点画像开设置窗"这条唯一的入口。
   * 它是槽的后代且没有 @click.stop，所以点在字上照样冒泡到槽 ——
   * 反过来，若把它做成槽的兄弟再靠 `pointer-events: none` 让开，
   * 这条断言就会红（事件根本不会经过槽）。
   */
  it('🔴 点身份条 = 点画像：照样开设置弹窗，且不会顺手弹文件框', async () => {
    const wrapper = await mountLarge()
    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')

    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(false)
    await wrapper.find('.identity-strip').trigger('click')

    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(true)
    expect(click).not.toHaveBeenCalled()
  })

  it('🔴 身份条上没有任何控件（内容不是家具，防 ad612d5 之后回潮）', async () => {
    const wrapper = await mountLarge()
    expect(wrapper.find('.identity-strip button').exists()).toBe(false)
    expect(wrapper.find('.identity-strip input').exists()).toBe(false)
    expect(wrapper.find('.identity-strip [role="button"]').exists()).toBe(false)
  })
})

describe('StatusOverview — 画像槽的导入入口（GOAL C）', () => {
  it('画像槽可聚焦、说明照实说结果是「立绘与头像」，点击打开文件选择框', async () => {
    const wrapper = mount(StatusOverview)
    const slot = wrapper.find('.portrait-slot')

    expect(slot.attributes('role')).toBe('button')
    expect(slot.attributes('tabindex')).toBe('0')
    expect(slot.attributes('aria-label')).toContain('苏婉')
    // 文案要说清这一下会同时定下立牌位与头像位，不是含糊的"导入"
    expect(slot.attributes('aria-label')).toContain('立绘')
    expect(slot.attributes('aria-label')).toContain('头像')
    expect(slot.attributes('title')).toContain('立绘')
    expect(slot.attributes('title')).toContain('头像')

    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')
    await slot.trigger('click')
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('Enter 与空格都能触发；空格必须 preventDefault（否则页面滚动）', async () => {
    const wrapper = mount(StatusOverview)
    const slot = wrapper.find('.portrait-slot')
    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    slot.element.dispatchEvent(enter)
    expect(click).toHaveBeenCalledTimes(1)

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    slot.element.dispatchEvent(space)
    expect(click).toHaveBeenCalledTimes(2)
    expect(space.defaultPrevented).toBe(true)
  })

  it('没选文件（取消对话框）→ 什么都不做，裁剪台也不开', async () => {
    const wrapper = mount(StatusOverview)
    const input = wrapper.find('input.portrait-file')
    Object.defineProperty(input.element, 'files', { value: [], configurable: true })
    await input.trigger('change')
    await flushPromises()

    expect(mockAssets.importForCharacter).not.toHaveBeenCalled()
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════════
// 点画像的去处：有东西可调才弹窗
// ═══════════════════════════════════════════════════════════

describe('StatusOverview — 点画像分叉（有大画像 → 弹窗；否则直接开文件框）', () => {
  async function mountWithLargePortrait() {
    mockAssets.assets = [makeRow('苏婉', { id: 'st', type: '立绘', framing: { x: 40, y: 15, scale: 1.4 } })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:st')
    const wrapper = mount(StatusOverview)
    await flushPromises()
    return wrapper
  }

  it('🔴 大画像 → 点击开设置弹窗，**不**直接开文件框', async () => {
    const wrapper = await mountWithLargePortrait()
    expect(wrapper.find('.character-portrait').exists()).toBe(true)

    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')

    const dialog = wrapper.findComponent(PortraitSettingsDialog)
    expect(dialog.props('open')).toBe(false)

    await wrapper.find('.portrait-slot').trigger('click')
    expect(dialog.props('open')).toBe(true)
    expect(click).not.toHaveBeenCalled()

    // 弹窗拿到的就是命中那条素材的 id 与取景 —— 否则滑块会写到别的行上
    expect(dialog.props('assetId')).toBe('st')
    expect(dialog.props('framing')).toEqual({ x: 40, y: 15, scale: 1.4 })
    expect(dialog.props('src')).toBe('blob:st')
    expect(dialog.props('name')).toBe('苏婉')
  })

  it('大画像下 Enter / 空格同样开弹窗，空格 preventDefault（否则页面滚动）', async () => {
    const wrapper = await mountWithLargePortrait()
    const slot = wrapper.find('.portrait-slot')

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    slot.element.dispatchEvent(enter)
    await flushPromises()
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(true)

    wrapper.findComponent(PortraitSettingsDialog).vm.$emit('close')
    await flushPromises()
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(false)

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    slot.element.dispatchEvent(space)
    await flushPromises()
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(true)
    expect(space.defaultPrevented).toBe(true)
  })

  it('🔴 没有素材 → 直接开文件框，弹窗一眼都不露（没东西可调，弹窗只是多一次点击）', async () => {
    const wrapper = mount(StatusOverview)
    await flushPromises()

    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')

    await wrapper.find('.portrait-slot').trigger('click')
    expect(click).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(false)
  })

  it('🔴 只有头像 → 同样直接开文件框（头像是圆形脸位，没有取景可言）', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'av', type: '头像' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:av')

    const wrapper = mount(StatusOverview)
    await flushPromises()
    expect(wrapper.find('.character-portrait').exists()).toBe(false)

    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')

    await wrapper.find('.portrait-slot').trigger('click')
    expect(click).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(false)
  })

  it('两种去处的说明文案不同（点之前就该知道会发生什么）', async () => {
    const plain = mount(StatusOverview)
    await flushPromises()
    expect(plain.find('.portrait-slot').attributes('aria-label')).toContain('立绘')
    expect(plain.find('.portrait-slot').attributes('aria-label')).toContain('头像')

    const large = await mountWithLargePortrait()
    expect(large.find('.portrait-slot').attributes('aria-label')).toContain('取景')
    expect(large.find('.portrait-slot').attributes('title')).toContain('取景')
  })

  it('🔴 弹窗里的「更换图片」走同一条文件路径：图片进裁剪台，名字仍是玩家名', async () => {
    const wrapper = await mountWithLargePortrait()
    await wrapper.find('.portrait-slot').trigger('click')

    const input = wrapper.find('input.portrait-file')
    const click = vi.spyOn(input.element as HTMLInputElement, 'click')
    wrapper.findComponent(PortraitSettingsDialog).vm.$emit('replace')
    await flushPromises()
    expect(click).toHaveBeenCalledTimes(1)

    await chooseFile(wrapper, png())
    const editor = wrapper.findComponent(AssetCropEditor)
    expect(editor.props('open')).toBe(true)
    expect(editor.props('name')).toBe('苏婉')
    expect(editor.props('name')).not.toBe('IMG_1234')
  })

  it('「更换图片」选中 mp4 → 绕开裁剪台，直通 importForCharacter(…, 头像)', async () => {
    const wrapper = await mountWithLargePortrait()
    await wrapper.find('.portrait-slot').trigger('click')
    wrapper.findComponent(PortraitSettingsDialog).vm.$emit('replace')
    await flushPromises()

    await chooseFile(wrapper, mp4())
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(false)
    expect(mockAssets.importForCharacter).toHaveBeenCalledTimes(1)
    expect(mockAssets.importForCharacter.mock.calls[0][2]).toBe('头像')
  })

  /**
   * 🔴 两个 AppModal 各自在 document 上听 Escape —— 同时开着按一下 Esc 会把两层
   * 一起关掉。与 AssetCharacterDrawer 同一个解法: 裁剪台开着时本窗先收起来。
   */
  it('🔴 裁剪台开着时设置弹窗先收起（一次 Esc 只关一层），裁剪台一关它原样回来', async () => {
    const wrapper = await mountWithLargePortrait()
    await wrapper.find('.portrait-slot').trigger('click')
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(true)

    wrapper.findComponent(PortraitSettingsDialog).vm.$emit('replace')
    await flushPromises()
    await chooseFile(wrapper, png())

    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(false)

    // 裁剪台取消 → 设置弹窗回来（状态没丢）
    wrapper.findComponent(AssetCropEditor).vm.$emit('close')
    await flushPromises()
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(false)
    expect(wrapper.findComponent(PortraitSettingsDialog).props('open')).toBe(true)
  })

  it('🔴 「更换图片」后再选**同一个文件**照样能开台（input.value 一进门就清）', async () => {
    const wrapper = await mountWithLargePortrait()
    const input = wrapper.find('input.portrait-file')

    const writes: string[] = []
    Object.defineProperty(input.element, 'value', {
      get: () => '',
      set: (v: string) => void writes.push(v),
      configurable: true,
    })

    const file = png()
    await chooseFile(wrapper, file)
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
    expect(writes).toContain('')

    wrapper.findComponent(AssetCropEditor).vm.$emit('close')
    await flushPromises()

    writes.length = 0
    await chooseFile(wrapper, file)
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
    expect(wrapper.findComponent(AssetCropEditor).props('source')).toBe(file)
    expect(writes).toContain('')
  })
})

// ═══════════════════════════════════════════════════════════
// 图片 → 裁剪台
// ═══════════════════════════════════════════════════════════

describe('StatusOverview — 选中图片则开裁剪台（一源两图）', () => {
  it('png → 裁剪台开着，源图就是选中的那份字节，名字是**玩家名**而非文件名', async () => {
    const wrapper = mount(StatusOverview)
    const file = png()
    await chooseFile(wrapper, file)

    const editor = wrapper.findComponent(AssetCropEditor)
    expect(editor.props('open')).toBe(true)
    // 🔴 同一份字节，不是拷贝 —— 拷一份就意味着中间过了一趟解码/编码
    expect(editor.props('source')).toBe(file)
    expect(editor.props('name')).toBe('苏婉')
    expect(editor.props('name')).not.toBe('IMG_1234')

    // 落库归编辑器（它自己调 importPortraitPair）—— 本组件绝不再直通导入一次
    expect(mockAssets.importForCharacter).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })

  it.each([
    ['jpeg', 'a.jpg', 'image/jpeg'],
    ['webp', 'a.webp', 'image/webp'],
  ])('%s 同样进裁剪台', async (_label, filename, mime) => {
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], filename, { type: mime }))

    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
    expect(mockAssets.importForCharacter).not.toHaveBeenCalled()
  })

  /** `File.type` 在某些系统上是空串 —— 那时扩展名说了算（与 store 同一条优先级） */
  it('blob.type 缺席时按扩展名判定，照样进裁剪台', async () => {
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], 'a.png', { type: '' }))

    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
  })

  /** 连 MIME 都问不出来 → 不开台、也不把一个必然失败的请求发给 store */
  it('不认识的格式 → 裁剪台不开，直接一条 error 提示', async () => {
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], 'notes.txt', { type: 'text/plain' }))

    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(false)
    expect(mockAssets.importForCharacter).not.toHaveBeenCalled()
    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][1]).toBe('error')
  })

  it('小方框形态下同样进裁剪台（两种呈现共用一个槽）', async () => {
    mockAssets.assets = [makeRow('苏婉', { id: 'av', type: '头像' })]
    mockAssets.assetUrl = vi.fn(async () => 'blob:av')

    const wrapper = mount(StatusOverview)
    await flushPromises()
    expect(wrapper.find('.portrait-slot .avatar-shape-square').exists()).toBe(true)

    await chooseFile(wrapper, png())
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
  })

  /**
   * 🔴 落库后画像**自己**换过来 —— 靠的是 store 行的响应式一路传到 `useAssetImage`。
   * 这里照 store 的样子把行推进库里（真实路径是 `writeIntoSlot` 末尾的
   * `refreshAssets()`），只有这条链真的连着，断言才会绿。
   */
  it('裁剪保存后画像自己更新，无需重挂载；并给一条成功提示', async () => {
    const wrapper = mount(StatusOverview)
    await flushPromises()
    expect(wrapper.find('.character-portrait').exists()).toBe(false)

    await chooseFile(wrapper, png())
    const editor = wrapper.findComponent(AssetCropEditor)
    expect(editor.props('open')).toBe(true)

    mockAssets.assetUrl = vi.fn(async (id: string) => `blob:${id}`)
    mockAssets.assets.push(
      makeRow('苏婉', { id: 'st', type: '立绘' }),
      makeRow('苏婉', { id: 'av', type: '头像' }),
    )
    editor.vm.$emit('saved', { portraitId: 'st', avatarId: 'av' })
    await flushPromises()

    expect(editor.props('open')).toBe(false)
    expect(wrapper.find('.character-portrait').exists()).toBe(true)
    expect(wrapper.find('.portrait-frame img').attributes('src')).toBe('blob:st')

    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][1]).toBe('info')
    expect(toast.mock.calls[0][0]).toContain('苏婉')
    expect(toast.mock.calls[0][0]).toContain('立绘')
    expect(toast.mock.calls[0][0]).toContain('头像')
  })

  /**
   * 取消必须**什么都不留下**。最容易漏的是最后一条: file input 的值不清空，
   * 浏览器认为"值没变"就不再发 change —— 表现是「取消之后再选同一张图，毫无反应」。
   */
  it('取消 → 不留半张素材、源字节放掉；同一个文件再选一次照样开（input.value 被清空）', async () => {
    const wrapper = mount(StatusOverview)
    const input = wrapper.find('input.portrait-file')

    // 记录对 value 的每一次写入 —— 只断言"最后是空串"会恒真（本来就是空的）
    const writes: string[] = []
    Object.defineProperty(input.element, 'value', {
      get: () => '',
      set: (v: string) => void writes.push(v),
      configurable: true,
    })

    const file = png()
    await chooseFile(wrapper, file)
    const editor = wrapper.findComponent(AssetCropEditor)
    expect(editor.props('open')).toBe(true)
    expect(writes).toContain('')

    editor.vm.$emit('close')
    await flushPromises()

    expect(editor.props('open')).toBe(false)
    expect(editor.props('source')).toBeNull()
    expect(mockAssets.importPortraitPair).not.toHaveBeenCalled()
    expect(mockAssets.importForCharacter).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()

    // 同一个 File 再来一次 —— 值清过了，change 照样到，台照样开
    writes.length = 0
    await chooseFile(wrapper, file)
    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(true)
    expect(wrapper.findComponent(AssetCropEditor).props('source')).toBe(file)
    expect(writes).toContain('')
  })
})

// ═══════════════════════════════════════════════════════════
// mp4 → 绕开裁剪台，直通导入且只写 头像
// ═══════════════════════════════════════════════════════════

describe('StatusOverview — mp4 绕开裁剪台（视频裁不了，且 D7 不让它当立绘）', () => {
  it('mp4 → 裁剪台不开，直接 importForCharacter(file, 玩家名, 头像)', async () => {
    const wrapper = mount(StatusOverview)
    const file = mp4()
    await chooseFile(wrapper, file)

    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(false)
    expect(mockAssets.importPortraitPair).not.toHaveBeenCalled()

    expect(mockAssets.importForCharacter).toHaveBeenCalledTimes(1)
    const [passedFile, passedName, passedType] = mockAssets.importForCharacter.mock.calls[0]
    expect(passedFile).toBe(file)
    expect(passedName).toBe('苏婉')
    expect(passedName).not.toBe('CLIP_9')
    // 🔴 绝不是 立绘 —— 那是要抠图合成的，视频没有 alpha 可言
    expect(passedType).toBe('头像')
  })

  it('mp4 且 blob.type 缺席时按扩展名判定，同样绕开裁剪台', async () => {
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], 'clip.mp4', { type: '' }))

    expect(wrapper.findComponent(AssetCropEditor).props('open')).toBe(false)
    expect(mockAssets.importForCharacter).toHaveBeenCalledTimes(1)
    expect(mockAssets.importForCharacter.mock.calls[0][2]).toBe('头像')
  })

  it('成功 → 一条 info 提示', async () => {
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, mp4())

    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][1]).toBe('info')
    expect(toast.mock.calls[0][0]).toContain('苏婉')
  })

  it('naming-invariant → 说清是「角色名当不了文件名」，不含糊报导入失败', async () => {
    mockAssets.importForCharacter = vi.fn(async () => ({ outcome: 'naming-invariant' }))
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, mp4())

    const [text, type] = toast.mock.calls[0]
    expect(type).toBe('error')
    expect(text).toContain('角色名')
    expect(text).toContain('苏婉')
    expect(text).not.toContain('导入失败')
  })

  it('unrepresentable-name → 同样归因到角色名（D19），并与 D16 的说法可区分', async () => {
    mockAssets.importForCharacter = vi.fn(async () => ({ outcome: 'unrepresentable-name' }))
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, mp4())

    const [text, type] = toast.mock.calls[0]
    expect(type).toBe('error')
    expect(text).toContain('角色名')
    expect(text).not.toContain('类型词')
  })

  /**
   * 互斥闸 `rejectIfBusy()` 自己就播报「已有一个导入正在进行」，这里再补一句
   * 就是同一件事弹两条 toast。共用那句对本路径完全成立，所以删的是本地这句。
   */
  it('busy → 本地不再补一条 toast（互斥闸自己已经播报过）', async () => {
    mockAssets.importForCharacter = vi.fn(async () => ({ outcome: 'busy' }))
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, mp4())

    expect(toast).not.toHaveBeenCalled()
  })
})
