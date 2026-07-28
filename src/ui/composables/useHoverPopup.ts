/**
 * 悬停浮层 —— 全站 hover-to-display 的唯一实现
 *
 * 为什么要抽出来：
 * 1. 悬停延迟是**全局设置**（settings.hoverDelayMs），各处自己写 setTimeout 会各调各的；
 * 2. 浮层必须 Teleport + `position: fixed` —— 状态栏/场景栏都是 overflow:auto 容器，
 *    绝对定位的浮层会被裁掉，坐标只能由触发元素的 getBoundingClientRect() 实时算；
 * 3. 键盘可达、滚动收起、离场清定时器这几件事，每个调用点都得做一遍。
 *
 * 用法：
 *   const pop = useHoverPopup({ width: 260, estHeight: 120, placement: 'right' })
 *   <button @mouseenter="pop.onEnter($event, fx.name)" @mouseleave="pop.hide"
 *           @focus="pop.onFocus($event, fx.name)" @blur="pop.hide">
 *   <Teleport to="body"><div v-if="pop.key.value && pop.pos.value" :style="{left:…,top:…}">
 */
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useSettingsStore } from '../stores/settings-store'

export interface HoverPopupOptions {
  /** 浮层宽度，用于横向夹紧防溢出 */
  width?: number
  /** 浮层高度估值 —— 渲染前量不到真实高度，用它做纵向夹紧 */
  estHeight?: number
  /**
   * 'below'        挂触发元素下方，左上角对齐
   * 'right'        挂右侧，纵向居中
   * 'right-bottom' 气泡**左下角**贴在锚点元素的**右上角**
   *                （思绪从锚点冒出来，尾巴朝左下指回去；靠 translateY(-100%)
   *                 让浏览器用真实高度反推顶边 —— 渲染前量不到高度）
   */
  placement?: 'below' | 'right' | 'right-bottom'
  /** 与触发元素的间隙 */
  gap?: number
  /**
   * 触发元素内部的锚点选择器（如 '.npc-portrait'）。
   * 'right-bottom' 下横纵都以锚点为准（贴其右上角）；
   * 'right' / 'below' 只用它定纵向，横向仍按触发元素整体走。
   * 不填则锚点 = 触发元素本身。
   */
  anchorSelector?: string
  /**
   * 浮层自身的 CSS `zoom` 值（默认 1）。
   * zoom 会把 left/top 一并放大，所以写进 style 的坐标要先除回去，
   * 乘回来之后才落在算好的视口位置上。
   * （translateY(-100%) 不用管 —— 它按未缩放高度算，渲染时正好等于缩放后高度。）
   * width / estHeight 请直接传**渲染后**的尺寸，夹紧才准。
   */
  zoom?: number
}

/** 悬停延迟兜底值（设置未初始化时用） */
export const DEFAULT_HOVER_DELAY = 200

export function useHoverPopup(options: HoverPopupOptions = {}) {
  const { width = 240, estHeight = 132, placement = 'below', gap = 6, anchorSelector, zoom = 1 } = options
  const settings = useSettingsStore()

  /** 当前悬停项的标识（名字/id），null = 不显示 */
  const key = ref<string | null>(null)
  const pos = ref<{ x: number; y: number } | null>(null)
  let timer: number | undefined

  /** right-bottom 用 translateY(-100%) 把 top 换算成"底边"，故纵向夹紧的边界也要跟着翻 */
  const anchorsBottom = placement === 'right-bottom'

  function place(el: HTMLElement, value: string) {
    const r = el.getBoundingClientRect()
    // 纵向锚点可以是触发元素内部的某块（如角色头像）；横向始终按触发元素整体走
    const anchorEl = anchorSelector ? el.querySelector(anchorSelector) : null
    const a = anchorEl instanceof HTMLElement ? anchorEl.getBoundingClientRect() : r
    const margin = 8
    let rawX: number
    let rawY: number
    switch (placement) {
      case 'right':
        rawX = r.right + gap
        rawY = a.top + a.height / 2 - estHeight / 2
        break
      case 'right-bottom':
        // 左下角贴锚点右上角：x 取锚点右缘，y（即气泡底边，见 anchorsBottom）取锚点顶缘
        rawX = a.right + gap
        rawY = a.top
        break
      default:
        rawX = r.left
        rawY = r.bottom + gap
    }
    pos.value = {
      x: Math.max(margin, Math.min(rawX, window.innerWidth - width - margin)),
      y: anchorsBottom
        // 底边锚定：上界要留出整个气泡高度，下界就是视口底
        ? Math.max(margin + estHeight, Math.min(rawY, window.innerHeight - margin))
        : Math.max(margin, Math.min(rawY, window.innerHeight - estHeight - margin)),
    }
    key.value = value
  }

  /** 直接绑到浮层的 :style —— 调用点不必各自拼 left/top/transform */
  const style = computed(() =>
    pos.value
      ? {
          left: `${pos.value.x / zoom}px`,
          top: `${pos.value.y / zoom}px`,
          ...(anchorsBottom ? { transform: 'translateY(-100%)' } : {}),
        }
      : undefined
  )

  function onEnter(e: MouseEvent, value: string) {
    window.clearTimeout(timer)
    const el = e.currentTarget as HTMLElement
    const delay = Number(settings.settings.hoverDelayMs ?? DEFAULT_HOVER_DELAY)
    if (!(delay > 0)) {
      place(el, value)
      return
    }
    timer = window.setTimeout(() => place(el, value), delay)
  }

  /** 键盘路径：聚焦即显示，不等延迟 —— 延迟是防鼠标划过误触，聚焦本身就是明确意图 */
  function onFocus(e: FocusEvent, value: string) {
    window.clearTimeout(timer)
    place(e.currentTarget as HTMLElement, value)
  }

  function hide() {
    window.clearTimeout(timer)
    key.value = null
    pos.value = null
  }

  // 浮层是 fixed 定位，容器一滚就与触发元素脱节飘在半空 —— 直接收起
  onMounted(() => window.addEventListener('scroll', hide, true))
  onUnmounted(() => {
    window.clearTimeout(timer)
    window.removeEventListener('scroll', hide, true)
  })

  return { key, pos, style, onEnter, onFocus, hide }
}
