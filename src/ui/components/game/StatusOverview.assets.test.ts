/**
 * StatusOverview — 玩家画像的素材渲染 + 定点导入接线
 *
 * 覆盖:
 * - 无素材 → 退回 AvatarPanel 原本的首字母占位（v1 的默认形态）
 * - 有素材 → `<img>` 铺满画像框（名字严格 `===`，D2）
 * - 点击 / Enter / 空格 → 打开文件选择框（空格必须 preventDefault，否则页面滚动）
 * - 选中文件 → `importForCharacter(file, 玩家名, '头像')`
 *   🔴 传的是**玩家名**，不是文件名 —— 这条路径上文件名只贡献扩展名，
 *   否则库里会长出一个叫 `IMG_1234` 的幽灵角色组
 * - D16 / D19 名字拒收 → 提示必须说「角色名当不了文件名」，而不是含糊的「导入失败」
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import StatusOverview from './StatusOverview.vue'
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
  mockAssets = {
    assets: [] as AssetMetaRecord[],
    assetUrl: vi.fn(async () => null),
    releaseAssetUrl: vi.fn(),
    importForCharacter: vi.fn(async () => ({ outcome: 'ok', id: 'asset_1' })),
  }
})

/** 把一个 File 塞进隐藏的 file input 并触发 change */
async function chooseFile(wrapper: ReturnType<typeof mount>, file: File) {
  const input = wrapper.find('input.portrait-file')
  Object.defineProperty(input.element, 'files', { value: [file], configurable: true })
  await input.trigger('change')
  await flushPromises()
}

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

describe('StatusOverview — 画像槽的导入入口（GOAL C）', () => {
  it('画像槽可聚焦、带说明，点击打开文件选择框', async () => {
    const wrapper = mount(StatusOverview)
    const slot = wrapper.find('.portrait-slot')

    expect(slot.attributes('role')).toBe('button')
    expect(slot.attributes('tabindex')).toBe('0')
    expect(slot.attributes('aria-label')).toContain('苏婉')
    expect(slot.attributes('title')).toContain('画像')

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

  it('选中文件 → importForCharacter(file, 玩家名, 头像)，名字绝不取自文件名', async () => {
    const wrapper = mount(StatusOverview)
    const file = new File(['x'], 'IMG_1234.png', { type: 'image/png' })
    await chooseFile(wrapper, file)

    expect(mockAssets.importForCharacter).toHaveBeenCalledTimes(1)
    const [passedFile, passedName, passedType] = mockAssets.importForCharacter.mock.calls[0]
    expect(passedFile).toBe(file)
    expect(passedName).toBe('苏婉')
    expect(passedName).not.toBe('IMG_1234')
    expect(passedType).toBe('头像')
  })

  it('成功 → 一条 info 提示', async () => {
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], 'a.png', { type: 'image/png' }))

    expect(toast).toHaveBeenCalledTimes(1)
    expect(toast.mock.calls[0][1]).toBe('info')
    expect(toast.mock.calls[0][0]).toContain('苏婉')
  })

  it('naming-invariant → 说清是「角色名当不了文件名」，不含糊报导入失败', async () => {
    mockAssets.importForCharacter = vi.fn(async () => ({ outcome: 'naming-invariant' }))
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], 'a.png', { type: 'image/png' }))

    const [text, type] = toast.mock.calls[0]
    expect(type).toBe('error')
    expect(text).toContain('角色名')
    expect(text).toContain('苏婉')
    expect(text).not.toContain('导入失败')
  })

  it('unrepresentable-name → 同样归因到角色名（D19），并与 D16 的说法可区分', async () => {
    mockAssets.importForCharacter = vi.fn(async () => ({ outcome: 'unrepresentable-name' }))
    const wrapper = mount(StatusOverview)
    await chooseFile(wrapper, new File(['x'], 'a.png', { type: 'image/png' }))

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
    await chooseFile(wrapper, new File(['x'], 'a.png', { type: 'image/png' }))

    expect(toast).not.toHaveBeenCalled()
  })

  it('没选文件（取消对话框）→ 什么都不做', async () => {
    const wrapper = mount(StatusOverview)
    const input = wrapper.find('input.portrait-file')
    Object.defineProperty(input.element, 'files', { value: [], configurable: true })
    await input.trigger('change')
    await flushPromises()

    expect(mockAssets.importForCharacter).not.toHaveBeenCalled()
    expect(toast).not.toHaveBeenCalled()
  })
})
