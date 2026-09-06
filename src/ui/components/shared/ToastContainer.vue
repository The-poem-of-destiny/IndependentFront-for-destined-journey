<script setup lang="ts">
import { useUIStore } from '../../stores/ui-store';

const ui = useUIStore();

const iconMap: Record<string, string> = {
  info: 'i',
  success: '✓',
  warning: '⚠',
  error: '✕',
};

function handleClick(t: { id: string; message: string; type: string }) {
  if (t.type === 'error' || t.type === 'warning') {
    navigator.clipboard.writeText(t.message).catch(() => {});
  }
  ui.removeToast(t.id);
}
</script>

<template>
  <Teleport to="body">
    <div class="toast-container" role="status" aria-live="polite" aria-relevant="additions">
      <transition-group name="toast">
        <div
          v-for="t in ui.toasts"
          :key="t.id"
          class="toast-item"
          :class="[`toast-${t.type}`]"
          role="button"
          tabindex="0"
          :aria-label="`${t.message}，关闭通知${t.type === 'error' || t.type === 'warning' ? '并复制内容' : ''}`"
          @keydown.enter.prevent="handleClick(t)"
          @keydown.space.prevent="handleClick(t)"
          @click="handleClick(t)"
        >
          <span class="toast-icon">{{ iconMap[t.type] }}</span>
          <span class="toast-msg">{{ t.message }}</span>
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: min(560px, 92vw);
}

.toast-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 16px;
  border-radius: var(--theme-radius-md);
  font-size: 0.88rem;
  line-height: 1.45;
  cursor: pointer;
  box-shadow: var(--theme-shadow-md);
  transition: all var(--theme-transition-fast);
  user-select: text;
  word-break: break-word;
  overflow-wrap: break-word;
}

.toast-icon {
  flex-shrink: 0;
  font-size: 1rem;
  line-height: 1.45;
}

.toast-msg {
  flex: 1;
  min-width: 0;
}

.toast-info {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
}
.toast-success {
  background: var(--theme-success);
  color: #fff;
}
.toast-warning {
  background: var(--theme-warning);
  color: #1a1510;
}
.toast-error {
  background: var(--theme-error);
  color: #fff;
}

.toast-enter-active {
  transition: all 0.3s ease;
}
.toast-leave-active {
  transition: all 0.2s ease;
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(50px);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(50px);
}
</style>
