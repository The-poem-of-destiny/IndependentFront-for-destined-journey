/**
 * CharacterPortrait — 大画像位 + 取景旋钮
 *
 * 要钉住的三件事，每件都对应一个**在界面上看不出来**的失败形态:
 *
 * 1. 🔴 **落到 CSS 的取景永远是夹逼过的**。一个 NaN 会让整条 `object-position` /
 *    `transform` 被浏览器丢弃，表现成「这张图偶尔没对齐」—— 而存量行没有 framing、
 *    旧版本可能写过越界 scale、拖拽算出 NaN，这些路径全汇到本组件。
 * 2. 🔴 **`transform-origin` 必须等于 `object-position`**。origin 固定在中心而焦点
 *    在别处时，放大会把刚对准的地方推出框外，用户感受是「两个滑块在打架」。
 * 3. 🔴 **落库防抖**。一次拖拽产生几十上百个 `input`，逐个写 Dexie 会在拖拽中途
 *    反复重建索引。断言是「**恰好一次**」，不是「至少一次」。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
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

function mountPortrait(props: Record<string, unknown> = {}) {
  return mount(CharacterPortrait, {
    props: { name: '苏婉', src: 'blob:st', assetId: 'a1', ...props },
  })
}

/** 内联 style 里某个属性的值（jsdom 归一化后按属性名取，不比整串文本） */
function styleOf(el: Element, prop: string): string {
  return (el as HTMLElement).style.getPropertyValue(prop)
}

async function openDial(wrapper: ReturnType<typeof mountPortrait>) {
  await wrapper.find('.framing-dial').trigger('click')
  await nextTick()
}

/** 拖一格滑块 */
async function slide(wrapper: ReturnType<typeof mountPortrait>, index: number, value: number) {
  const input = wrapper.findAll('input[type="range"]')[index]
  ;(input.element as HTMLInputElement).value = String(value)
  await input.trigger('input')
}

// ═══════════════════════════════════════════════════════════
// 渲染 + 取景 → CSS
// ═══════════════════════════════════════════════════════════

describe('CharacterPortrait — 取景落到 CSS', () => {
  it('没图 → 交还插槽兜底，不渲染空框内容', () => {
    const wrapper = mount(CharacterPortrait, {
      props: { name: '苏婉', src: null },
      slots: { default: '苏' },
    })
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('video').exists()).toBe(false)
    expect(wrapper.text()).toContain('苏')
  })

  it('缺省取景 = 顶对齐、水平居中、不放大', () => {
    const img = mountPortrait().find('img').element
    expect(styleOf(img, 'object-position')).toBe('50% 0%')
    expect(styleOf(img, 'transform')).toBe('scale(1)')
    expect(DEFAULT_ASSET_FRAMING).toEqual({ x: 50, y: 0, scale: 1 })
  })

  it('存的取景原样落到 object-position / transform', () => {
    const framing: AssetFraming = { x: 30, y: 70, scale: 1.8 }
    const img = mountPortrait({ framing }).find('img').element
    expect(styleOf(img, 'object-position')).toBe('30% 70%')
    expect(styleOf(img, 'transform')).toBe('scale(1.8)')
  })

  it('🔴 transform-origin === object-position —— 放大绕焦点发生，两个滑块不打架', () => {
    const img = mountPortrait({ framing: { x: 20, y: 90, scale: 2 } }).find('img').element
    expect(styleOf(img, 'transform-origin')).toBe(styleOf(img, 'object-position'))
    expect(styleOf(img, 'transform-origin')).toBe('20% 90%')
  })

  it('🔴 NaN / 越界 / 垃圾对象 → 夹逼后才进 CSS，绝不产出 NaN%', () => {
    const img = mountPortrait({
      framing: { x: NaN, y: 250, scale: 0 } as unknown as AssetFraming,
    }).find('img').element
    expect(styleOf(img, 'object-position')).toBe('50% 100%')
    expect(styleOf(img, 'transform')).toBe('scale(1)')
    expect(styleOf(img, 'object-position')).not.toContain('NaN')
  })

  it('scale 超上限被收到 3（不是原样透传）', () => {
    const img = mountPortrait({ framing: { x: 50, y: 0, scale: 99 } }).find('img').element
    expect(styleOf(img, 'transform')).toBe('scale(3)')
  })

  it('mp4 → <video muted playsinline loop autoplay>，取景同样生效', () => {
    const wrapper = mountPortrait({ video: true, framing: { x: 10, y: 20, scale: 1.5 } })
    const video = wrapper.find('video')
    expect(video.exists()).toBe(true)
    const el = video.element as HTMLVideoElement
    expect(el.muted).toBe(true)
    expect(el.loop).toBe(true)
    expect(el.autoplay).toBe(true)
    expect(styleOf(el, 'object-position')).toBe('10% 20%')
    expect(styleOf(el, 'transform')).toBe('scale(1.5)')
  })
})

// ═══════════════════════════════════════════════════════════
// 旋钮的出现条件与可达性
// ═══════════════════════════════════════════════════════════

describe('CharacterPortrait — 取景旋钮', () => {
  it('有图有 id → 旋钮在；没 id（无处写回）或 framable=false → 不出现', () => {
    expect(mountPortrait().find('.framing-dial').exists()).toBe(true)
    expect(mountPortrait({ assetId: null }).find('.framing-dial').exists()).toBe(false)
    expect(mountPortrait({ framable: false }).find('.framing-dial').exists()).toBe(false)
    expect(mountPortrait({ src: null }).find('.framing-dial').exists()).toBe(false)
  })

  it('点旋钮开合浮层，三个滑块都是真 range（方向键可操作）且有标签', async () => {
    const wrapper = mountPortrait()
    expect(wrapper.find('.framing-pop').exists()).toBe(false)
    expect(wrapper.find('.framing-dial').attributes('aria-expanded')).toBe('false')

    await openDial(wrapper)
    expect(wrapper.find('.framing-pop').exists()).toBe(true)
    expect(wrapper.find('.framing-dial').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('.framing-pop').attributes('role')).toBe('dialog')

    const ranges = wrapper.findAll('input[type="range"]')
    expect(ranges).toHaveLength(3)
    for (const r of ranges) expect(r.attributes('aria-label')).toBeTruthy()
    // 缩放滑块的区间来自引擎常量，不在组件里手抄
    expect(ranges[2].attributes('min')).toBe('1')
    expect(ranges[2].attributes('max')).toBe('3')

    await wrapper.find('.framing-dial').trigger('click')
    await nextTick()
    expect(wrapper.find('.framing-pop').exists()).toBe(false)
  })

  it('Esc 收起浮层', async () => {
    const wrapper = mountPortrait()
    await openDial(wrapper)
    await wrapper.find('.framing-pop').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(wrapper.find('.framing-pop').exists()).toBe(false)
  })

  it('🔴 旋钮的点击与键盘事件不外泄 —— 外层「点一下=导入」的槽不会被误触', async () => {
    const onClick = vi.fn()
    const onKeydown = vi.fn()
    const Host = defineComponent({
      setup() {
        return () =>
          h('div', { class: 'slot', onClick, onKeydown }, [
            h(CharacterPortrait, { name: '苏婉', src: 'blob:st', assetId: 'a1' }),
          ])
      },
    })
    const wrapper = mount(Host)
    await wrapper.find('.framing-dial').trigger('click')
    await wrapper.find('.framing-dial').trigger('keydown', { key: 'Enter' })
    await nextTick()

    expect(onClick).not.toHaveBeenCalled()
    expect(onKeydown).not.toHaveBeenCalled()
    expect(wrapper.find('.framing-pop').exists()).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════
// 实时预览 + 防抖落库
// ═══════════════════════════════════════════════════════════

describe('CharacterPortrait — 调取景', () => {
  it('拖滑块 → 画面当帧就变（不等落库）', async () => {
    const wrapper = mountPortrait()
    await openDial(wrapper)

    await slide(wrapper, 1, 65) // 垂直
    expect(styleOf(wrapper.find('img').element, 'object-position')).toBe('50% 65%')
    // 还没到防抖点 —— 预览已生效，库一个字没写
    expect(setAssetFraming).not.toHaveBeenCalled()
  })

  it('🔴 一次拖拽几十个 input → setAssetFraming **恰好一次**，且是最后那个值', async () => {
    const wrapper = mountPortrait()
    await openDial(wrapper)

    for (let v = 0; v <= 40; v += 2) await slide(wrapper, 0, v)
    expect(setAssetFraming).not.toHaveBeenCalled()

    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0]).toEqual(['a1', { x: 40, y: 0, scale: 1 }])
  })

  it('缩放滑块写 scale，落库值同样夹逼过', async () => {
    const wrapper = mountPortrait()
    await openDial(wrapper)

    await slide(wrapper, 2, 2.5)
    vi.advanceTimersByTime(300)
    expect(setAssetFraming.mock.calls[0][1]).toEqual({ x: 50, y: 0, scale: 2.5 })
  })

  it('复位 → 回到 DEFAULT_ASSET_FRAMING，画面与落库都跟上', async () => {
    const wrapper = mountPortrait({ framing: { x: 12, y: 88, scale: 2.4 } })
    await openDial(wrapper)
    expect(styleOf(wrapper.find('img').element, 'object-position')).toBe('12% 88%')

    await wrapper.find('.fp-reset').trigger('click')
    await nextTick()
    expect(styleOf(wrapper.find('img').element, 'object-position')).toBe('50% 0%')
    expect(styleOf(wrapper.find('img').element, 'transform')).toBe('scale(1)')

    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0][1]).toEqual({ ...DEFAULT_ASSET_FRAMING })
  })

  it('拖完立刻卸载 → 欠的那一笔补写（最后 300ms 的调整不许凭空丢）', async () => {
    const wrapper = mountPortrait()
    await openDial(wrapper)
    await slide(wrapper, 0, 22)

    wrapper.unmount()
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0][1]).toEqual({ x: 22, y: 0, scale: 1 })

    // 补写之后定时器已作废，不会再写第二遍
    vi.advanceTimersByTime(300)
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
  })

  it('🔴 换了一张图 → 欠账写回**上一条** id，草稿不跟着挂到新图上', async () => {
    const wrapper = mountPortrait()
    await openDial(wrapper)
    await slide(wrapper, 0, 18)

    await wrapper.setProps({ assetId: 'a2', src: 'blob:st2' })
    expect(setAssetFraming).toHaveBeenCalledTimes(1)
    expect(setAssetFraming.mock.calls[0][0]).toBe('a1')

    await nextTick()
    // 新图用它自己的（缺省）取景，不继承上一张的草稿
    expect(styleOf(wrapper.find('img').element, 'object-position')).toBe('50% 0%')
  })

  it('没动过就卸载 → 一次都不写', () => {
    mountPortrait().unmount()
    expect(setAssetFraming).not.toHaveBeenCalled()
  })
})
