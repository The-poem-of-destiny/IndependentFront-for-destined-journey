<script setup lang="ts">
import { watch, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  open: boolean
  title?: string
  size?: 'sm' | 'md' | 'lg'
  closable?: boolean
}>()

const emit = defineEmits<{
  'update:open': [value: boolean]
  close: []
}>()

function doClose() {
  if (props.closable === false) return
  emit('update:open', false)
  emit('close')
}

watch(() => props.open, (val) => {
  document.body.style.overflow = val ? 'hidden' : ''
})

// Escape key — document level, always works
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && props.open) doClose()
}
onMounted(() => document.addEventListener('keydown', onKeydown))
onUnmounted(() => document.removeEventListener('keydown', onKeydown))

function onOverlayClick(e: MouseEvent) {
  if (e.target === e.currentTarget) doClose()
}
</script>

<template>
  <Teleport to="body">
    <transition name="modal">
      <div v-if="open" class="modal-overlay" @click="onOverlayClick" @keydown="onKeydown" tabindex="-1">
        <div class="modal-content" :class="`modal-${size || 'md'}`">
          <div v-if="title || $slots.header || closable !== false" class="modal-header">
            <h3 v-if="title" class="modal-title">{{ title }}</h3>
            <slot name="header" />
            <button v-if="closable !== false" class="modal-close" @click="doClose" aria-label="关闭">×</button>
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
  max-height: 80vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.modal-sm { width: min(90vw, 360px); }
.modal-md { width: min(90vw, 520px); }
.modal-lg { width: min(90vw, 720px); }

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
  width: 28px; height: 28px;
  display: flex; align-items: center; justify-content: center;
  font-size: 1.3rem; line-height: 1;
  color: var(--theme-text-muted);
  background: none; border: none; border-radius: var(--theme-radius-sm);
  cursor: pointer; flex-shrink: 0;
  transition: all var(--theme-transition-fast);
}
.modal-close:hover { color: var(--theme-text-primary); background: var(--theme-tab-hover-bg); }
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
