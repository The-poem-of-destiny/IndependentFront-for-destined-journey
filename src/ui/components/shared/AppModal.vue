<script setup lang="ts">
import { watch, onMounted, onUnmounted, ref, shallowRef, useId } from 'vue';
import { ownModalFocus } from '../../lib/modal-focus';
import { useFxEnabled } from '../../lib/fx-gate';
import FxFrameTrace from './FxFrameTrace.vue';
import { FX_MODAL_ENTER_MS, type FxFrameRect } from './fx-frame-trace-timing';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl' | 'full';
    closable?: boolean;
    /**
     * 不画页头、body 也不留内边距 —— **内容自己画整个面**。
     *
     * 🔴 与 `closable: false` 刻意分开: 那一档关掉的是"能不能关"（Esc / 点遮罩 / ×
     * 三条一起没），而这一档只是把**外壳**让出去，Esc 与点遮罩照旧生效。查看器这类
     * 通栏版式需要的是后者 —— 把它写成 `closable: false` 就等于顺手废掉 Esc，
     * 而那是 design.md §4.5 要求必须支持的。
     *
     * 用它的组件必须自己提供一个关闭控件（否则触屏用户只剩点遮罩这一条路）。
     */
    bare?: boolean;
  }>(),
  {
    closable: true,
    bare: false,
    // 显式写 undefined：这两项**本来就没有默认值**（无标题 / 由 CSS 决定尺寸），
    // 但 vue/require-default-prop 要求每个可选 prop 都有交代，写出来比关规则好
    title: undefined,
    size: undefined,
  },
);

const emit = defineEmits<{
  'update:open': [value: boolean];
  close: [];
}>();

function doClose() {
  if (props.closable === false) return;
  emit('update:open', false);
  emit('close');
}

const dialog = ref<HTMLElement | null>(null);
const titleId = useId();
let releaseFocus: (() => void) | undefined;
function syncFocus() {
  if (props.open && dialog.value && !releaseFocus)
    releaseFocus = ownModalFocus(dialog.value, doClose);
  if (!props.open) {
    releaseFocus?.();
    releaseFocus = undefined;
  }
}
watch(() => props.open, syncFocus, { flush: 'post' });
onMounted(syncFocus);
onUnmounted(() => releaseFocus?.());

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) doClose();
}

/*
 * 特效闸门打开时的「描框入场」（docs/design.md §6 + fx-core.css 的闸门约定）。
 * 闸门关着时：不传 duration（Vue 照旧读 CSS 时长）、不渲染描线、样式全部不命中 ——
 * 与 v1 逐像素一致。焦点陷阱 / Esc / 滚动锁都不经过这里。
 */
const fxEnabled = useFxEnabled();
/** 显式时长只在闸门打开时给；离场沿用 v1 的 fast（150ms，= --motion-duration-fast） */
const FX_DURATION = { enter: FX_MODAL_ENTER_MS, leave: 150 } as const;
const traceRect = shallowRef<FxFrameRect | null>(null);
// `appear` 也只在闸门打开时给：ConfirmDialogHost 这类「挂载即 open」的调用方在 v1 里没有入场
// 过渡（Transition 首次渲染不跑 enter），闸门打开时借 appear 让它们同样被「画出来」；
// appear 的类名与钩子缺省即 enter 那一套，所以下面的样式与 onEnter 无需另写。

/**
 * 入场钩子：按面板尺寸摆描线。取 offset* 而不是 getBoundingClientRect ——
 * 此刻面板还带着 enter-from 的 transform，offset* 读的是落定后的位置。
 * 只收一个参数：Vue 据此仍按 CSS / duration 判定结束，不接管 done。
 */
function onEnter(el: Element) {
  if (!fxEnabled.value) return;
  const panel = (el as HTMLElement).querySelector<HTMLElement>('.modal-content');
  if (!panel) return;
  traceRect.value = {
    left: panel.offsetLeft,
    top: panel.offsetTop,
    width: panel.offsetWidth,
    height: panel.offsetHeight,
  };
}
function clearTrace() {
  traceRect.value = null;
}
</script>

<template>
  <Teleport to="body">
    <transition
      name="modal"
      :appear="fxEnabled"
      :duration="fxEnabled ? FX_DURATION : undefined"
      @enter="onEnter"
      @after-leave="clearTrace"
    >
      <div v-if="open" class="modal-overlay" tabindex="-1" @click="onOverlayClick">
        <FxFrameTrace v-if="fxEnabled && traceRect" :rect="traceRect" @done="clearTrace" />
        <div
          ref="dialog"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title && !bare ? titleId : undefined"
          :aria-label="bare || !title ? title || '对话框' : undefined"
          tabindex="-1"
          class="modal-content"
          :class="[`modal-${size || 'md'}`, { 'modal-bare': bare }]"
        >
          <div v-if="!bare && (title || $slots.header || closable !== false)" class="modal-header">
            <h3 v-if="title" :id="titleId" class="modal-title">{{ title }}</h3>
            <slot name="header" />
            <button
              v-if="closable !== false"
              class="modal-close"
              aria-label="关闭"
              @click="doClose"
            >
              ×
            </button>
          </div>
          <div class="modal-body">
            <slot />
          </div>
          <div v-if="$slots.footer" class="modal-footer">
            <slot name="footer" />
          </div>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(4px);
}
.modal-content {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-xl);
  box-shadow: var(--theme-shadow-lg);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.modal-sm {
  width: min(90vw, 360px);
}
.modal-md {
  width: min(90vw, 520px);
}
.modal-lg {
  width: min(90vw, 720px);
}
.modal-xl {
  width: min(94vw, 1080px);
}
.modal-xxl {
  width: min(94vw, 1600px);
  max-height: 85vh;
}
/**
 * 通栏档 —— 画像 + 信息两栏并排的版式（角色查看器）。
 *
 * 与其它档不同的是它**定死高度**而不是给 `max-height`: 里面是"左栏铺满、右栏自己滚"
 * 的布局，而那需要一个确定的高度可以百分比化。`overflow: hidden` 同理必须盖掉
 * `.modal-content` 的 `overflow-y: auto` —— 否则内容一长就变成外层整块滚，
 * 左边的画像会跟着滚出视野。
 */
.modal-full {
  width: min(96vw, 1720px);
  height: min(92vh, 60rem);
  max-height: 92vh;
  overflow: hidden;
}
/** 外壳让给内容: 页头已经不渲染，这里把 body 的内边距也撤掉（见 `bare` 的说明） */
.modal-bare > .modal-body {
  padding: 0;
  overflow: hidden;
}

.modal-header {
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
  border-bottom: 1px solid var(--theme-card-border);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.modal-title {
  font-family: var(--theme-font-title);
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  margin: 0;
  flex: 1;
}
.modal-close {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.3rem;
  line-height: 1;
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  flex-shrink: 0;
  transition: all var(--theme-transition-fast);
}
.modal-close:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}
.modal-body {
  padding: var(--theme-spacing-xl);
  flex: 1;
  overflow-y: auto;
}
.modal-footer {
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
  border-top: 1px solid var(--theme-card-border);
  display: flex;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
}

/*
 * ===== 特效闸门：描框入场 =====
 * 时间表的唯一出处在 fx-frame-trace-timing.ts（FX_MODAL_*），这里的毫秒数与之逐一对应：
 *   面板 280ms 起淡入 240ms（不再从下方升起 —— 轮廓已经先画出来了，实体只需「落下」）；
 *   页头 / 正文 / 页脚 360ms 起依次上浮 6px，间隔 36ms，每段 360ms。
 * 只在 `.modal-enter-active` 期间生效：离场与常态完全沿用 transitions.css 的 v1 规则。
 */
:root[data-fx='on'] .modal-enter-active .modal-content {
  transition: opacity 240ms var(--motion-ease-standard) 280ms;
}
:root[data-fx='on'] .modal-enter-from .modal-content {
  opacity: 0;
  transform: none;
}
:root[data-fx='on'] .modal-enter-active .modal-header,
:root[data-fx='on'] .modal-enter-active .modal-body,
:root[data-fx='on'] .modal-enter-active .modal-footer {
  animation: fx-modal-rise 360ms var(--motion-ease-enter) backwards;
}
:root[data-fx='on'] .modal-enter-active .modal-header {
  animation-delay: 360ms;
}
:root[data-fx='on'] .modal-enter-active .modal-body {
  animation-delay: 396ms;
}
:root[data-fx='on'] .modal-enter-active .modal-content > .modal-body:first-child {
  animation-delay: 360ms;
}
:root[data-fx='on'] .modal-enter-active .modal-footer {
  animation-delay: 432ms;
}
@keyframes fx-modal-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
</style>
