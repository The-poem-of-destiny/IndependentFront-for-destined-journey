<script setup lang="ts">
/**
 * CharacterPortrait — 顶对齐的**大画像**位，带一个取景旋钮。
 *
 * 与 `AvatarPanel`（1:1 小方框 / 圆形脸位）的分工是**呈现形态**，不是数据来源:
 * 只有当命中的素材真是 `立绘` / `立绘bg` 时才用本组件。把一张 `头像`
 * 拉满整栏宽看起来像 bug 而不像功能，所以分叉判据在调用方（见 StatusOverview）。
 *
 * 🔴 **取景（{@link AssetFraming}）必须先过 `clampAssetFraming` 再落到 CSS。**
 * 这不是防御性洁癖: 一个 NaN 会让整条 `object-position` / `transform` 声明被
 * 浏览器丢弃，表现成「这张图偶尔没对齐」—— 是最难查的那类样式 bug。存量行没有
 * framing 字段、旧版本可能写过越界的 scale、拖拽 UI 除以一个还没测出来的 0 宽度
 * 就够产出 NaN，这些路径全都汇到这里。
 *
 * 🔴 **缩放必须绕焦点发生**（`transform-origin` 与 `object-position` 用同一对
 * 百分比）。若 origin 固定在中心而焦点在别处，放大会把刚对准的地方推出框外 ——
 * 用户的感受是「这两个滑块在互相打架」。
 *
 * 📌 旋钮浮层**没有**复用 `useHoverPopup`: 那个原语是「悬停 + 全局延迟 + 滚动即隐 +
 * 浮层 `pointer-events: none`」的只读提示气泡，而这里要的是点击开合、必须能接住
 * 拖拽与方向键的**交互面板**。硬套会同时破坏它的语义与本浮层的可用性。
 * 浮层是本组件的兄弟节点（不在 `overflow: hidden` 的画框内），因此不必 Teleport。
 */
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'
import {
  ASSET_FRAMING_MAX_SCALE,
  ASSET_FRAMING_MIN_SCALE,
  clampAssetFraming,
} from '@engine/asset-types'
import { DEFAULT_ASSET_FRAMING, type AssetFraming } from '@engine/types'
import { useAssetStore } from '../../stores/asset-store'

const props = withDefaults(
  defineProps<{
    /** 角色名 —— 只用于 alt / aria，**不参与解析**（解析在调用方） */
    name: string
    /** object URL；null = 没图（本组件不做兜底，调用方该换成 AvatarPanel） */
    src?: string | null
    /** `src` 是 mp4 吗（D7: `头像` / `立绘bg` 允许视频）。由**行**判定，别嗅 URL */
    video?: boolean
    /** 命中行的 id —— 取景要写回哪一条。缺省则旋钮不出现（没有落点） */
    assetId?: string | null
    /** 库里存的取景，**可以是任意来路的垃圾**，本组件负责收敛 */
    framing?: AssetFraming | null
    /** 允许调取景吗；关掉就只是个大画像 */
    framable?: boolean
  }>(),
  { src: null, video: false, assetId: null, framing: null, framable: true },
)

const assets = useAssetStore()

/** 滑块拖动期间的本地覆盖 —— 落库是防抖的，但画面必须**当帧**跟手 */
const draft = ref<AssetFraming | null>(null)

/** 真正交给 CSS 的那一份，**永远夹逼过** */
const framing = computed<AssetFraming>(() => clampAssetFraming(draft.value ?? props.framing))

/**
 * 换了一张图就丢掉草稿 —— 否则上一张的取景会挂在下一张脸上，
 * 而下一次拖动会把它当作「用户对这张图的选择」落库。
 */
watch(
  () => props.assetId,
  () => {
    // 先把欠**上一条**的那一笔补掉（`pending` 记的是当时的 id，写不到新的那条上）
    flushPersist()
    draft.value = null
    open.value = false
  },
)

const mediaStyle = computed(() => {
  const f = framing.value
  const focus = `${f.x}% ${f.y}%`
  return {
    objectPosition: focus,
    transform: `scale(${f.scale})`,
    // 与焦点同一对百分比 —— 放大绕着看的那一点发生，两个滑块才不打架
    transformOrigin: focus,
  }
})

// ═══ 取景旋钮 ═══════════════════════════════════════════════

const open = ref(false)
const dialId = useId()
const popoverId = `${dialId}-pop`
const rootEl = ref<HTMLElement | null>(null)

/** 旋钮只在「有落点 且 允许调」时出现 —— 没有 assetId 就无处写回 */
const showDial = computed(() => props.framable && props.assetId !== null && props.src !== null)

function toggle(): void {
  open.value = !open.value
}

function close(): void {
  open.value = false
}

/**
 * 落库防抖 —— 一次拖拽会产生几十上百个 `input`，每个都写 Dexie 既拖慢拖拽本身，
 * 也会让 `refreshAssets()` 在拖拽中途反复重建索引。
 */
const PERSIST_DEBOUNCE_MS = 300
let timer: number | undefined
/**
 * 欠着的那一笔，**连 id 一起记**。只记「脏了」而落库时现读 `props.assetId`
 * 是个真陷阱: 换角色的那一刻补写，会把上一张图的取景写到新那条上。
 */
let pending: { id: string; framing: AssetFraming } | null = null

/** 立刻落库（防抖到点、换图、或卸载时补写）。没有欠账就什么都不做 */
function flushPersist(): void {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  const owed = pending
  pending = null
  if (owed === null) return
  // store 自己会再夹逼一次（写入侧收敛），这里给的已经是夹过的
  void assets.setAssetFraming(owed.id, owed.framing)
}

function schedulePersist(): void {
  const id = props.assetId
  if (id === null) return
  pending = { id, framing: framing.value }
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(flushPersist, PERSIST_DEBOUNCE_MS)
}

/** 滑块 → 草稿。`valueAsNumber` 在空值时是 NaN，照样交给 clamp 兜（见文件头） */
function onSlide(key: keyof AssetFraming, e: Event): void {
  const raw = (e.target as HTMLInputElement).valueAsNumber
  draft.value = { ...framing.value, [key]: raw }
  schedulePersist()
}

function reset(): void {
  draft.value = { ...DEFAULT_ASSET_FRAMING }
  schedulePersist()
}

/**
 * 旋钮与浮层的键盘事件**一律不外泄**。
 *
 * 不是洁癖: 本组件常被塞进一个「整块可点 = 导入一张图」的槽位里（StatusOverview
 * 的画像槽就是），那个槽位在 Enter / 空格上绑了打开文件选择框。不拦住的话，
 * 用键盘打开取景面板会**同时弹出文件对话框**。
 */
function onKeydown(e: KeyboardEvent): void {
  e.stopPropagation()
  if (e.key === 'Escape') close()
}

/** 面板外按下即收 —— 面板本身没有遮罩，不拦其它交互 */
function onDocPointerDown(e: MouseEvent): void {
  const root = rootEl.value
  if (root && e.target instanceof Node && !root.contains(e.target)) close()
}

watch(open, (isOpen) => {
  if (isOpen) document.addEventListener('mousedown', onDocPointerDown)
  else document.removeEventListener('mousedown', onDocPointerDown)
})

onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocPointerDown)
  // 拖完就关面板/切页面是很常见的操作 —— 不补这一笔，最后 300ms 的调整会凭空丢掉
  flushPersist()
})
</script>

<template>
  <div class="character-portrait" ref="rootEl">
    <!-- 画框: overflow 归它，尺寸/比例归它；里面的媒体只管铺满 -->
    <div class="portrait-frame">
      <video
        v-if="src && video"
        class="portrait-media"
        :src="src"
        :style="mediaStyle"
        :aria-label="name"
        muted
        playsinline
        loop
        autoplay
      />
      <img v-else-if="src" class="portrait-media" :src="src" :alt="name" :style="mediaStyle" />
      <slot v-else />
    </div>

    <!-- ═══ 取景旋钮 ═══ -->
    <button
      v-if="showDial"
      class="framing-dial"
      type="button"
      :id="dialId"
      :aria-expanded="open"
      :aria-controls="open ? popoverId : undefined"
      aria-haspopup="dialog"
      aria-label="调整画像取景"
      title="调整画像取景"
      @click.stop="toggle"
      @keydown="onKeydown"
    >
      <i class="fa-solid fa-crop-simple" aria-hidden="true" />
    </button>

    <Transition name="dial-pop">
      <div
        v-if="showDial && open"
        class="framing-pop"
        :id="popoverId"
        role="dialog"
        aria-label="画像取景"
        @click.stop
        @keydown="onKeydown"
      >
        <label class="fp-row">
          <span class="fp-label">水平</span>
          <input
            class="fp-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="framing.x"
            aria-label="水平位置"
            @input="onSlide('x', $event)"
          />
          <span class="fp-value">{{ Math.round(framing.x) }}%</span>
        </label>

        <label class="fp-row">
          <span class="fp-label">垂直</span>
          <input
            class="fp-range"
            type="range"
            min="0"
            max="100"
            step="1"
            :value="framing.y"
            aria-label="垂直位置"
            @input="onSlide('y', $event)"
          />
          <span class="fp-value">{{ Math.round(framing.y) }}%</span>
        </label>

        <label class="fp-row">
          <span class="fp-label">缩放</span>
          <input
            class="fp-range"
            type="range"
            :min="ASSET_FRAMING_MIN_SCALE"
            :max="ASSET_FRAMING_MAX_SCALE"
            step="0.05"
            :value="framing.scale"
            aria-label="缩放倍数"
            @input="onSlide('scale', $event)"
          />
          <span class="fp-value">{{ framing.scale.toFixed(2) }}×</span>
        </label>

        <div class="fp-foot">
          <button class="fp-reset" type="button" @click="reset">复位</button>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
/* 旋钮与浮层是画框的**兄弟**，故本层绝不能 overflow: hidden */
.character-portrait {
  position: relative;
  width: 100%;
}

/**
 * 4:5 竖幅 —— 与 ScenePanel 在场角色位（46×58）同一个立牌形状，
 * 全站「一张角色立牌该长什么样」只有一种答案。
 * 上限 24rem: 状态栏宽约 25% 屏宽，常见桌面下画框约 19rem 宽，4:5 正好落在
 * 上限附近；超宽屏才由上限接管，避免一张画像把下面的属性/持有物顶出视口。
 */
.portrait-frame {
  position: relative;
  width: 100%;
  aspect-ratio: 4 / 5;
  max-height: 24rem;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  /* design.md §4.2 统一卡片外壳，与 AvatarPanel 的 square 形态一致 */
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--paper-stack);
  color: var(--theme-text-secondary);
  font-weight: 600;
  font-size: 2.25rem;
}
.portrait-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* ═══ 旋钮 ═══ */
.framing-dial {
  position: absolute;
  right: var(--theme-spacing-sm, 8px);
  bottom: var(--theme-spacing-sm, 8px);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-card-bg) 88%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  cursor: pointer;
  opacity: 0.45;
  transition: opacity var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}
.character-portrait:hover .framing-dial,
.framing-dial:focus-visible,
.framing-dial[aria-expanded='true'] {
  opacity: 1;
  color: var(--theme-primary);
}
.framing-dial:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}

/* ═══ 浮层 ═══ */
.framing-pop {
  position: absolute;
  right: var(--theme-spacing-sm, 8px);
  bottom: calc(24px + var(--theme-spacing-md, 12px));
  z-index: 2;
  width: 13rem;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm, 8px);
  padding: var(--theme-spacing-md, 12px);
  background: var(--theme-card-bg);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md, 6px);
  box-shadow: var(--theme-shadow-lg);
}
.fp-row {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm, 8px);
  cursor: pointer;
}
.fp-label {
  flex-shrink: 0;
  width: 2rem;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.fp-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--theme-primary);
  cursor: pointer;
}
.fp-value {
  flex-shrink: 0;
  width: 2.75rem;
  text-align: right;
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
  font-variant-numeric: tabular-nums;
}
.fp-foot {
  display: flex;
  justify-content: flex-end;
  border-top: 1px dashed var(--theme-card-border);
  padding-top: var(--theme-spacing-sm, 8px);
}
.fp-reset {
  padding: 3px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  font-family: inherit;
  font-size: 0.6875rem;
  cursor: pointer;
  transition: background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}
.fp-reset:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}

.dial-pop-enter-active,
.dial-pop-leave-active {
  transition: opacity 0.15s ease;
}
.dial-pop-enter-from,
.dial-pop-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .framing-dial,
  .fp-reset,
  .dial-pop-enter-active,
  .dial-pop-leave-active {
    transition: none;
  }
}
</style>
