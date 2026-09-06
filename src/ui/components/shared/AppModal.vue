<script setup lang="ts">
import { watch, onMounted, onUnmounted, ref, useId } from 'vue';
import { ownModalFocus } from '../../lib/modal-focus';

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
</script>

<template>
  <Teleport to="body">
    <transition name="modal">
      <div v-if="open" class="modal-overlay" tabindex="-1" @click="onOverlayClick">
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
</style>
