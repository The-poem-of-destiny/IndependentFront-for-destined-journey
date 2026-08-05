<script setup lang="ts">
import { watch, onMounted, onUnmounted } from 'vue';

const props = withDefaults(
  defineProps<{
    open: boolean;
    title?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl' | 'xxl';
    closable?: boolean;
  }>(),
  {
    closable: true,
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

watch(
  () => props.open,
  (val) => {
    document.body.style.overflow = val ? 'hidden' : '';
  },
);

/**
 * 🔴 卸载时必须把滚动锁还回去。
 *
 * 上面那个 watch 只在 `open` **变化**时跑；组件带着 `open === true` 被销毁时它不会
 * 触发，`body` 就永远停在 `overflow: hidden` —— 整页从此滚不动，直到刷新。
 *
 * 此前碰不到：所有弹窗都挂在页面根上，不会被分区切换销毁。Q-25 把预设的两个弹窗
 * 搬进了 `agent/PresetManager.vue`（只在 story 分区存在），这条路径就通了。
 * 一行守卫，顺带给另外十来个调用点都上了保险。
 */
onUnmounted(() => {
  if (props.open) document.body.style.overflow = '';
});

// Escape key — document level, always works
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) doClose();
}
onMounted(() => document.addEventListener('keydown', onKeydown));
onUnmounted(() => document.removeEventListener('keydown', onKeydown));

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) doClose();
}
</script>

<template>
  <Teleport to="body">
    <transition name="modal">
      <div
        v-if="open"
        class="modal-overlay"
        tabindex="-1"
        @click="onOverlayClick"
        @keydown="onKeydown"
      >
        <div class="modal-content" :class="`modal-${size || 'md'}`">
          <div v-if="title || $slots.header || closable !== false" class="modal-header">
            <h3 v-if="title" class="modal-title">{{ title }}</h3>
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
