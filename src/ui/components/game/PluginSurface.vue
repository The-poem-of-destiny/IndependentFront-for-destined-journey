<script setup lang="ts">
/**
 * PluginSurface.vue — 插件界面外壳（插件系统设计 §4.7、§5.7）
 *
 * 一个 surface = 宿主在帧外画的身份边框（插件名 +「联网」标记 + 关闭按钮）+ 一块帧容器。
 * 边框永远在插件可控区域之外：插件文档只能画在帧容器里，改不了这圈边框。
 *
 * 四种形态：
 * - `window`：应用内浮动窗，按宿主标题栏拖动、右下角调大小，尺寸与位置都夹在视口内；
 *   按下即 emit `focus`，由父级（图层）负责置顶。
 * - `overlay`：铺满父级定位容器（游戏区）的覆盖层，同样带边框与关闭。
 * - `panel`：面板具名插槽里的内联块。
 * - `hidden`：后台帧，离屏零尺寸容器，不画边框。
 *
 * 帧本身由父级注入的 `mountFrame` 挂载（它内部调 mountPluginFrame + bridge），
 * 本组件不直接依赖 plugin-frame，便于单测。Esc 分层归父级，这里不绑 Esc。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';

export type PluginSurfaceMode = 'window' | 'overlay' | 'panel' | 'hidden';

interface PluginSurfaceSize {
  width: number;
  height: number;
}

const props = withDefaults(
  defineProps<{
    pluginId: string;
    pluginName: string;
    networked: boolean;
    mode: PluginSurfaceMode;
    title: string;
    /** 帧内容区初始宽度（px），只对 window / panel 生效 */
    width?: number;
    /** 帧内容区初始高度（px），只对 window / panel 生效 */
    height?: number;
    /** window 初始位置（视口坐标）；缺省时居中 */
    x?: number;
    y?: number;
    /** window 的层级，由父级按焦点顺序分配 */
    zIndex?: number;
    /** 插件经 `ui.resize` 请求的内容尺寸；变化时夹取后应用并 emit `resize` */
    requestedSize?: PluginSurfaceSize | null;
    mountFrame: (container: HTMLElement) => { dispose(): void };
  }>(),
  {
    width: undefined,
    height: undefined,
    x: undefined,
    y: undefined,
    zIndex: undefined,
    requestedSize: null,
  },
);

const emit = defineEmits<{
  close: [];
  focus: [];
  resize: [size: PluginSurfaceSize];
}>();

// ── 尺寸约束 ────────────────────────────────────────────────
/** 帧内容区的最小尺寸 */
const MIN_WIDTH = 240;
const MIN_HEIGHT = 160;
/** 帧内容区的绝对上限（视口更小时以视口为准） */
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1200;
const DEFAULT_WIDTH = 420;
const DEFAULT_HEIGHT = 360;
const DEFAULT_PANEL_HEIGHT = 240;
/** 宿主边框占用：左右各 1px 边线；上方标题栏 36px + 上下边线 */
const CHROME_W = 2;
const CHROME_H = 38;
/** 浮窗与视口边缘的最小留白 */
const VIEWPORT_MARGIN = 8;
const KEY_RESIZE_STEP = 16;

function viewport(): { vw: number; vh: number } {
  if (typeof window === 'undefined') return { vw: MAX_WIDTH, vh: MAX_HEIGHT };
  return { vw: window.innerWidth, vh: window.innerHeight };
}

function clampNum(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** 把内容尺寸夹在 [最小, min(上限, 视口可用)] 内；视口比最小值还小时以最小值为准 */
function clampSize(w: number, h: number): PluginSurfaceSize {
  const { vw, vh } = viewport();
  const maxW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, vw - CHROME_W - VIEWPORT_MARGIN * 2));
  const maxH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, vh - CHROME_H - VIEWPORT_MARGIN * 2));
  return {
    width: Math.round(clampNum(w, MIN_WIDTH, maxW)),
    height: Math.round(clampNum(h, MIN_HEIGHT, maxH)),
  };
}

/** 把窗口外框位置夹在视口内（整窗可见；放不下时贴左上留白） */
function clampPos(x: number, y: number, s: PluginSurfaceSize): { x: number; y: number } {
  const { vw, vh } = viewport();
  const maxX = Math.max(VIEWPORT_MARGIN, vw - (s.width + CHROME_W) - VIEWPORT_MARGIN);
  const maxY = Math.max(VIEWPORT_MARGIN, vh - (s.height + CHROME_H) - VIEWPORT_MARGIN);
  return {
    x: Math.round(clampNum(x, VIEWPORT_MARGIN, maxX)),
    y: Math.round(clampNum(y, VIEWPORT_MARGIN, maxY)),
  };
}

const size = ref<PluginSurfaceSize>(
  clampSize(
    props.width ?? DEFAULT_WIDTH,
    props.height ?? (props.mode === 'panel' ? DEFAULT_PANEL_HEIGHT : DEFAULT_HEIGHT),
  ),
);
const pos = ref(initialPos());

function initialPos(): { x: number; y: number } {
  const { vw, vh } = viewport();
  const s = size.value;
  const cx = (vw - (s.width + CHROME_W)) / 2;
  const cy = (vh - (s.height + CHROME_H)) / 2;
  return clampPos(props.x ?? cx, props.y ?? cy, s);
}

function applySize(w: number, h: number, notify: boolean): void {
  const next = clampSize(w, h);
  const changed = next.width !== size.value.width || next.height !== size.value.height;
  size.value = next;
  pos.value = clampPos(pos.value.x, pos.value.y, next);
  if (notify && changed) emit('resize', { ...next });
}

watch(
  () => props.requestedSize,
  (req) => {
    if (!req || props.mode === 'hidden' || props.mode === 'overlay') return;
    applySize(req.width, req.height, true);
  },
);

// ── 样式 ────────────────────────────────────────────────────
const rootStyle = computed<Record<string, string>>(() => {
  if (props.mode === 'window') {
    const style: Record<string, string> = {
      left: `${pos.value.x}px`,
      top: `${pos.value.y}px`,
      width: `${size.value.width + CHROME_W}px`,
    };
    if (props.zIndex !== undefined) style.zIndex = String(props.zIndex);
    return style;
  }
  return {};
});

const frameStyle = computed<Record<string, string>>(() => {
  const style: Record<string, string> = {};
  if (props.mode === 'window' || props.mode === 'panel') {
    style.height = `${size.value.height}px`;
    // .ps-frame 的 `flex: 1` 会让 flex-basis 0 盖过 height，外框高度不定时帧缩成 iframe 默认的 150px；
    // 有明确高度的模式改为不伸缩，让 height 生效
    style.flex = '0 0 auto';
  }
  return style;
});

const headingLabel = computed(() =>
  props.title && props.title !== props.pluginName
    ? `${props.pluginName} · ${props.title}`
    : props.pluginName,
);

// ── 帧挂载 ──────────────────────────────────────────────────
const frameHost = ref<HTMLElement | null>(null);
let mounted: { dispose(): void } | null = null;

function mountCurrent(): void {
  const el = frameHost.value;
  if (!el || mounted) return;
  mounted = props.mountFrame(el);
}

function disposeCurrent(): void {
  const handle = mounted;
  mounted = null;
  handle?.dispose();
}

watch(
  () => props.pluginId,
  () => {
    disposeCurrent();
    mountCurrent();
  },
);

// ── 拖动 / 调大小 ───────────────────────────────────────────
type Gesture =
  | { kind: 'drag'; startX: number; startY: number; origin: { x: number; y: number } }
  | { kind: 'resize'; startX: number; startY: number; origin: PluginSurfaceSize };

const gesture = ref<Gesture | null>(null);

function onHeadPointerDown(e: PointerEvent): void {
  if (props.mode !== 'window' || e.button !== 0) return;
  // 标题栏上的按钮（关闭）不触发拖动
  if (e.target instanceof Element && e.target.closest('button')) return;
  e.preventDefault();
  gesture.value = {
    kind: 'drag',
    startX: e.clientX,
    startY: e.clientY,
    origin: { ...pos.value },
  };
  bindGesture();
}

function onResizePointerDown(e: PointerEvent): void {
  if (props.mode !== 'window' || e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();
  emit('focus');
  gesture.value = {
    kind: 'resize',
    startX: e.clientX,
    startY: e.clientY,
    origin: { ...size.value },
  };
  bindGesture();
}

function onGestureMove(e: PointerEvent): void {
  const g = gesture.value;
  if (!g) return;
  const dx = e.clientX - g.startX;
  const dy = e.clientY - g.startY;
  if (g.kind === 'drag') {
    pos.value = clampPos(g.origin.x + dx, g.origin.y + dy, size.value);
  } else {
    applySize(g.origin.width + dx, g.origin.height + dy, false);
  }
}

function onGestureEnd(): void {
  const g = gesture.value;
  gesture.value = null;
  unbindGesture();
  if (g?.kind === 'resize') {
    if (g.origin.width !== size.value.width || g.origin.height !== size.value.height) {
      emit('resize', { ...size.value });
    }
  }
}

let gestureBound = false;
function bindGesture(): void {
  if (gestureBound || typeof window === 'undefined') return;
  gestureBound = true;
  window.addEventListener('pointermove', onGestureMove);
  window.addEventListener('pointerup', onGestureEnd);
  window.addEventListener('pointercancel', onGestureEnd);
}
function unbindGesture(): void {
  if (!gestureBound) return;
  gestureBound = false;
  window.removeEventListener('pointermove', onGestureMove);
  window.removeEventListener('pointerup', onGestureEnd);
  window.removeEventListener('pointercancel', onGestureEnd);
}

/** 调大小手柄的键盘操作：方向键每次 16px */
function onResizeKey(e: KeyboardEvent): void {
  const dw =
    e.key === 'ArrowLeft' ? -KEY_RESIZE_STEP : e.key === 'ArrowRight' ? KEY_RESIZE_STEP : 0;
  const dh = e.key === 'ArrowUp' ? -KEY_RESIZE_STEP : e.key === 'ArrowDown' ? KEY_RESIZE_STEP : 0;
  if (!dw && !dh) return;
  e.preventDefault();
  applySize(size.value.width + dw, size.value.height + dh, true);
}

// ── 焦点 ────────────────────────────────────────────────────
function onRootPointerDown(): void {
  if (props.mode === 'window') emit('focus');
}
function onRootFocusIn(): void {
  if (props.mode === 'window') emit('focus');
}

/**
 * 点进跨源 iframe 不会在宿主文档派发 pointerdown，只会让宿主窗口失焦。
 * 失焦后检查焦点是否落进了本 surface（帧挂在 shadow tree 里，activeElement 是它的宿主节点）。
 */
let blurTimer: ReturnType<typeof setTimeout> | null = null;
function onWindowBlur(): void {
  if (props.mode !== 'window') return;
  if (blurTimer) clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    blurTimer = null;
    const active = document.activeElement;
    if (active && frameHost.value?.contains(active)) emit('focus');
  }, 0);
}

function onViewportResize(): void {
  if (props.mode !== 'window') return;
  applySize(size.value.width, size.value.height, true);
}

function close(): void {
  emit('close');
}

onMounted(() => {
  mountCurrent();
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('resize', onViewportResize);
  }
});

onBeforeUnmount(() => {
  unbindGesture();
  if (blurTimer) clearTimeout(blurTimer);
  if (typeof window !== 'undefined') {
    window.removeEventListener('blur', onWindowBlur);
    window.removeEventListener('resize', onViewportResize);
  }
  disposeCurrent();
});
</script>

<template>
  <section
    class="plugin-surface"
    :class="[`ps-${mode}`, { 'ps-busy': gesture !== null }]"
    :style="rootStyle"
    :data-plugin-id="pluginId"
    :role="mode === 'window' || mode === 'overlay' ? 'dialog' : undefined"
    :aria-label="mode === 'hidden' ? undefined : headingLabel"
    :aria-hidden="mode === 'hidden' ? 'true' : undefined"
    @pointerdown.capture="onRootPointerDown"
    @focusin="onRootFocusIn"
  >
    <header
      v-if="mode !== 'hidden'"
      class="ps-head"
      data-testid="plugin-surface-head"
      @pointerdown="onHeadPointerDown"
    >
      <span class="ps-name" :title="pluginName">{{ pluginName }}</span>
      <span v-if="title && title !== pluginName" class="ps-title" :title="title">{{ title }}</span>
      <span v-if="networked" class="ps-badge" title="此插件声明了联网域名">联网</span>
      <span class="ps-gap" />
      <button
        class="ps-close"
        type="button"
        :aria-label="`关闭 ${pluginName}`"
        data-testid="plugin-surface-close"
        @click="close"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true" />
      </button>
    </header>
    <div ref="frameHost" class="ps-frame" :style="frameStyle" data-testid="plugin-surface-frame" />
    <div
      v-if="mode === 'window'"
      class="ps-resize"
      role="separator"
      tabindex="0"
      aria-label="调整窗口大小"
      aria-orientation="horizontal"
      data-testid="plugin-surface-resize"
      @pointerdown="onResizePointerDown"
      @keydown="onResizeKey"
    />
  </section>
</template>

<style scoped>
.plugin-surface {
  display: flex;
  flex-direction: column;
  color: var(--theme-text-primary);
}

/* ── 身份边框（window / overlay / panel 共用） ── */
.ps-window,
.ps-overlay,
.ps-panel {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  overflow: hidden;
}

.ps-window {
  position: fixed;
  z-index: var(--z-dropdown);
  box-shadow: var(--theme-shadow-lg);
}

.ps-overlay {
  position: absolute;
  inset: 0;
  z-index: var(--z-sticky);
}

.ps-panel {
  position: relative;
  width: 100%;
}

/* 后台帧：离屏零尺寸，不参与布局与无障碍树 */
.ps-hidden {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 0;
  height: 0;
  overflow: hidden;
  pointer-events: none;
}

/* ── 标题栏 ── */
.ps-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  height: 36px;
  flex-shrink: 0;
  padding: 0 0 0 var(--theme-spacing-md);
  border-bottom: 1px solid var(--theme-card-border);
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  user-select: none;
}
.ps-window .ps-head {
  cursor: grab;
  touch-action: none;
}
.ps-window.ps-busy .ps-head {
  cursor: grabbing;
}

.ps-name {
  min-width: 0;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ps-title {
  min-width: 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ps-badge {
  flex-shrink: 0;
  padding: 1px var(--theme-spacing-xs);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
  border-radius: var(--theme-radius-sm);
}
.ps-gap {
  flex: 1;
}

.ps-close {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: none;
  background: none;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  font-family: inherit;
  cursor: pointer;
  border-radius: var(--theme-radius-sm);
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.ps-close:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.ps-close:focus-visible,
.ps-resize:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -2px;
}

/* ── 帧容器 ── */
.ps-frame {
  position: relative;
  flex: 1;
  min-height: 0;
  background: var(--theme-content-bg);
}
/* 拖动 / 调大小期间让帧不吞指针事件，否则移进 iframe 后宿主收不到 pointermove */
.ps-busy .ps-frame {
  pointer-events: none;
}

/* ── 调大小手柄 ── */
.ps-resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  background: linear-gradient(
    135deg,
    transparent 50%,
    color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border)) 50%
  );
  opacity: 0.7;
  transition: opacity var(--theme-transition-fast);
}
.ps-resize:hover {
  opacity: 1;
}

@media (prefers-reduced-motion: reduce) {
  .ps-close,
  .ps-resize {
    transition: none;
  }
}
</style>
