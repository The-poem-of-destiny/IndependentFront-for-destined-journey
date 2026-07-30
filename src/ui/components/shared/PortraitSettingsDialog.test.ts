/**
 * PortraitSettingsDialog — 画像的唯一调节面
 *
 * 钉住的四件事:
 * 1. **预览当帧跟手**。拖滑块时画面立刻变，不等落库 —— 预览与真身共用
 *    `CharacterPortrait`，所以断言直接看它拿到的 `framing` prop。
 * 2. 🔴 **落库防抖，且是「恰好一次」**。一次拖拽几十个 `input`，逐个写 Dexie 会
 *    在拖拽中途反复重建索引。
 * 3. 🔴 **欠账连 id 一起记，且关窗/卸载都要补写**。只记「脏了」、落库时现读
 *    `props.assetId`，换角色那一刻的补写会把上一张图的取景写到新那条上；
 *    而不补写的话，最后 300ms 的调整凭空丢掉。
 * 4. 「更换图片」**只发事件**，字节分流归调用方（那边本来就有同一条路径）。
 *
 * Teleport 就地渲染（`stubs: { teleport: true }`），AppModal 的内容才 find 得到。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import PortraitSettingsDialog from './PortraitSettingsDialog.vue'
import CharacterPortrait from './CharacterPortrait.vue'
import { DEFAULT_ASSET_FRAMING, type AssetFraming } from '@engine/types'

// 形参写全 —— 否则 mock 的 args 是空元组，`mock.calls[0][1]` 过不了 tsc
const setAssetFraming = vi.fn(async (_id: string, _framing: AssetFraming) => ({
  outcome: 'ok' as const,
}))

vi.mock('../../stores/asset-store', () => ({
  useAssetStore: () => ({ setAssetFraming }),
}))

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function mountDialog(props: Record<string, unknown> = {}) {
  return mount(PortraitSettingsDialog, {
    props: { open: true, name: '苏婉', src: 'blob:st', assetId: 'a1', ...props },
    global: { stubs: { teleport: true } },
  })
}

/** 预览真身拿到的取景（预览就是 CharacterPortrait 本体，不是另画一份） */
function previewFraming(wrapper: ReturnType<typeof mountDialog>): AssetFraming {
  return wrapper.findComponent(CharacterPortrait).props('framing') as AssetFraming
}

/** 拖一格滑块（0=水平 1=垂直 2=缩放） */
async function slide(wrapper: ReturnType<typeof mountDialog>, index: number, value: number) {
  const input = wrapper.findAll('input[type="range"]')[index]
  ;(input.element as HTMLInputElement).value = String(value)
  await input.trigger('input')
}

// ═══════════════════════════════════════════════════════════
// 结构
// ═══════════════════════════════════════════════════════════

describe('PortraitSettingsDialog — 结构', () => {
  it('open=false 时什么都不渲染', () => {
    const wrapper = mountDialog({ open: false })
    expect(wrapper.findAll('input[type="range"]')).toHaveLength(0)
    expect(wrapper.findComponent(CharacterPortrait).exists()).toBe(false)
  })

  it('三个滑块都是真 range（方向键可操作）且有标签；区间来自引擎常量', () => {
    const wrapper = mountDialog()
    const ranges = wrapper.findAll('input[type="range"]')
    expect(ranges).toHaveLength(3)
    for (const r of ranges) expect(r.attributes('aria-label')).toBeTruthy()
    expect(ranges[2].attributes('min')).toBe('1')
    expect(ranges[2].attributes('max')).toBe('3')
  })

  it('弹窗里有预览，且预览拿的是当前取景（含 mp4 形态）', () => {
    const wrapper = mountDialog({
      video: true,
      framing: { x: 30, y: 70, scale: 1.8 },
    })
    const preview = wrapper.findComponent(CharacterPortrait)
    expect(preview.exists()).toBe(true)
    expect(preview.props('src')).toBe('blob:st')
    expect(preview.props('video')).toBe(true)
    expect(preview.props('framing')).toEqual({ x: 30, y: 70, scale: 1.8 })
  })

  it('没有落点（assetId=null）→ 滑块与复位禁用，但窗口照开（还能换图）', () => {
    const wrapper = mountDialog({ assetId: null })
    for (const r of wrapper.findAll('input[type="range"]')) {
      expect((r.element as HTMLInputElement).disabled).toBe(true)
    }
    expect(wrapper.find('.ps-replace').attributes('disabled')).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════════════════
// 实时预览 + 防抖落库
// ═══════════════════════════════════════════════════════════

describe('PortraitSettingsDialog — 调取景', () => {
  it('拖滑块 → 预览当帧就变（不等落库）', async () => {
    const wrapper = mountDialog()
    await slide(wrapper, 1, 65)

    expect(previewFraming(wrapper)).toEqual({ x: 50, y: 65, scale: 1 })
    // 还没到防抖点 —— 预览已生效，库一个字没写
    expect(setAssetFraming).not.toHaveBeenCalled()
  })

  it('🔴 一次拖拽几十个 input → setAssetFraming **恰好一次**，且是最后那个值', async () => {
    const wrapper = mountDialog()
    for (let v = 0; v <= 40; v += 2) await slide(wrapper, 0, v)
    expect(setAssetFraming).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0]).toEqual(['a1', { x: 40, y: 0, scale: 1 }])
  })

  it('缩放滑块写 scale，落库值同样夹逼过', async () => {
    const wrapper = mountDialog()
    await slide(wrapper, 2, 2.5)
    vi.advanceTimersByTime(300)
    expect(setAssetFraming.mock.calls[0][1]).toEqual({ x: 50, y: 0, scale: 2.5 })
  })

  it('越界/垃圾取景先夹逼再进预览，绝不把 NaN 交出去', () => {
    const wrapper = mountDialog({
      framing: { x: NaN, y: 250, scale: 0 } as unknown as AssetFraming,
    })
    expect(previewFraming(wrapper)).toEqual({ x: 50, y: 100, scale: 1 })
  })

  it('复位 → 回到 DEFAULT_ASSET_FRAMING，预览与落库都跟上', async () => {
    const wrapper = mountDialog({ framing: { x: 12, y: 88, scale: 2.4 } })
    expect(previewFraming(wrapper)).toEqual({ x: 12, y: 88, scale: 2.4 })

    await wrapper.find('.ps-reset').trigger('click')
    await nextTick()
    expect(previewFraming(wrapper)).toEqual({ ...DEFAULT_ASSET_FRAMING })

    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0][1]).toEqual({ ...DEFAULT_ASSET_FRAMING })
  })

  it('拖完立刻卸载 → 欠的那一笔补写（最后 300ms 的调整不许凭空丢）', async () => {
    const wrapper = mountDialog()
    await slide(wrapper, 0, 22)

    wrapper.unmount()
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0][1]).toEqual({ x: 22, y: 0, scale: 1 })

    // 补写之后定时器已作废，不会再写第二遍
    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
  })

  it('🔴 拖完直接关窗 → 同样补写（关窗比防抖快是常态）', async () => {
    const wrapper = mountDialog()
    await slide(wrapper, 1, 33)
    expect(setAssetFraming).not.toHaveBeenCalled()

    await wrapper.setProps({ open: false })
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0]).toEqual(['a1', { x: 50, y: 33, scale: 1 }])

    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
  })

  it('🔴 换了一条素材 → 欠账写回**上一条** id，草稿不跟着挂到新图上', async () => {
    const wrapper = mountDialog()
    await slide(wrapper, 0, 18)

    await wrapper.setProps({ assetId: 'a2', src: 'blob:st2' })
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0][0]).toBe('a1')

    await nextTick()
    // 新的那条用它自己的（缺省）取景，不继承上一张的草稿
    expect(previewFraming(wrapper)).toEqual({ ...DEFAULT_ASSET_FRAMING })
  })

  it('没动过就卸载 → 一次都不写', () => {
    mountDialog().unmount()
    expect(setAssetFraming).not.toHaveBeenCalled()
  })

  it('没有落点时拖不动，也绝不落库（滑块 disabled 只是表象，逻辑也得挡住）', () => {
    const wrapper = mountDialog({ assetId: null })
    vi.advanceTimersByTime(300)
    expect(setAssetFraming).not.toHaveBeenCalled()
    expect(wrapper.findComponent(CharacterPortrait).exists()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 出口
// ═══════════════════════════════════════════════════════════

describe('PortraitSettingsDialog — 出口', () => {
  it('「更换图片」只发 replace 事件，本组件不碰字节', async () => {
    const wrapper = mountDialog()
    await wrapper.find('.ps-replace').trigger('click')

    expect(wrapper.emitted('replace')).toHaveLength(1)
    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('「完成」发 close', async () => {
    const wrapper = mountDialog()
    const done = wrapper.findAll('button').find(b => b.text() === '完成')
    await done?.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
