/**
 * CharacterPortrait — 大画像位（**纯呈现**，画面上没有任何家具）
 *
 * 要钉住的三件事，前两件都对应一个**在界面上看不出来**的失败形态:
 *
 * 1. 🔴 **落到 CSS 的取景永远是夹逼过的**。一个 NaN 会让整条 `object-position` /
 *    `transform` 被浏览器丢弃，表现成「这张图偶尔没对齐」—— 而存量行没有 framing、
 *    旧版本可能写过越界 scale、滑块算出 NaN，这些路径全汇到本组件。
 * 2. 🔴 **`transform-origin` 必须等于 `object-position`**。origin 固定在中心而焦点
 *    在别处时，放大会把刚对准的地方推出框外，用户感受是「两个滑块在打架」。
 * 3. 🔴 **一个按钮都不许有**。旋钮 + 相机徽章盖在图上、浮层再盖住画像本身，
 *    正是这次拆掉的东西；调节面搬到了 `PortraitSettingsDialog`。这条断言是
 *    防回潮的闸: 谁再往画像上加控件，这里先红。
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import CharacterPortrait from './CharacterPortrait.vue'
import { DEFAULT_ASSET_FRAMING, type AssetFraming } from '@engine/types'

function mountPortrait(props: Record<string, unknown> = {}) {
  return mount(CharacterPortrait, {
    props: { name: '苏婉', src: 'blob:st', ...props },
  })
}

/** 内联 style 里某个属性的值（jsdom 归一化后按属性名取，不比整串文本） */
function styleOf(el: Element, prop: string): string {
  return (el as HTMLElement).style.getPropertyValue(prop)
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

  it('传进来的取景原样落到 object-position / transform', () => {
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

  /** 换图/换取景直接反映到 CSS —— 弹窗拖滑块时的实时预览就靠这条 */
  it('props.framing 变化当帧反映到 CSS（预览由外部驱动，本组件不存状态）', async () => {
    const wrapper = mountPortrait({ framing: { x: 50, y: 0, scale: 1 } })
    await wrapper.setProps({ framing: { x: 12, y: 88, scale: 2.4 } })
    const img = wrapper.find('img').element
    expect(styleOf(img, 'object-position')).toBe('12% 88%')
    expect(styleOf(img, 'transform')).toBe('scale(2.4)')
  })
})

// ═══════════════════════════════════════════════════════════
// 画面上没有家具
// ═══════════════════════════════════════════════════════════

describe('CharacterPortrait — 画面干净', () => {
  it('🔴 一个按钮/滑块/浮层都没有 —— 取景面搬去了 PortraitSettingsDialog', () => {
    const wrapper = mountPortrait({ framing: { x: 30, y: 40, scale: 2 } })
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.findAll('input')).toHaveLength(0)
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false)
    // 旧版的旋钮与浮层，一个都不许回来
    expect(wrapper.find('.framing-dial').exists()).toBe(false)
    expect(wrapper.find('.framing-pop').exists()).toBe(false)
  })

  it('mp4 形态下同样没有家具', () => {
    const wrapper = mountPortrait({ video: true })
    expect(wrapper.findAll('button')).toHaveLength(0)
    expect(wrapper.findAll('input')).toHaveLength(0)
  })

  /**
   * 本组件常被塞进一个「整块可点」的槽位里（StatusOverview 的画像槽就是）。
   * 它自己不拦任何事件，点击必须一路冒泡到那个槽 —— 旧版为了保护旋钮而
   * `stopPropagation` 的那套已经随旋钮一起删掉了。
   */
  it('点击与键盘照常冒泡给外层可点的槽（本组件不吞事件）', async () => {
    const onClick = vi.fn()
    const onKeydown = vi.fn()
    const Host = defineComponent({
      setup() {
        return () =>
          h('div', { class: 'slot', onClick, onKeydown }, [
            h(CharacterPortrait, { name: '苏婉', src: 'blob:st' }),
          ])
      },
    })
    const wrapper = mount(Host)
    await wrapper.find('.portrait-frame').trigger('click')
    await wrapper.find('.portrait-frame').trigger('keydown', { key: 'Enter' })

    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onKeydown).toHaveBeenCalledTimes(1)
  })
})
