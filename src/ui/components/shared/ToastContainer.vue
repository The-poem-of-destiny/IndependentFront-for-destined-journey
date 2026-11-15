<script setup lang="ts">
import { onUnmounted, reactive } from 'vue';
import { useUIStore, type Toast } from '../../stores/ui-store';

const ui = useUIStore();

const iconMap: Record<string, string> = {
  info: 'i',
  success: '✓',
  warning: '⚠',
  error: '✕',
};

/** 复制反馈的停留时长（毫秒） */
const COPY_FEEDBACK_MS = 1500;

/** 每条提示的复制反馈：'copied' = 已复制，'failed' = 复制失败 */
const copyState = reactive(new Map<string, 'copied' | 'failed'>());
const copyTimers = new Map<string, ReturnType<typeof setTimeout>>();

function isCopyable(t: Toast): boolean {
  return t.type === 'error' || t.type === 'warning';
}

function showCopyFeedback(id: string, state: 'copied' | 'failed') {
  copyState.set(id, state);
  const prev = copyTimers.get(id);
  if (prev) clearTimeout(prev);
  copyTimers.set(
    id,
    setTimeout(() => {
      copyState.delete(id);
      copyTimers.delete(id);
    }, COPY_FEEDBACK_MS),
  );
}

/**
 * 点击提示正文：错误 / 警告复制全文并原地显示「已复制」（提示保留，由 × 关闭）；
 * 其余类型沿用旧行为，点一下即关闭。
 */
async function handleActivate(t: Toast) {
  if (!isCopyable(t)) {
    ui.removeToast(t.id);
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('剪贴板不可用');
    await navigator.clipboard.writeText(t.message);
    showCopyFeedback(t.id, 'copied');
  } catch {
    showCopyFeedback(t.id, 'failed');
  }
}

function close(t: Toast) {
  ui.removeToast(t.id);
}

function bodyLabel(t: Toast): string {
  return isCopyable(t) ? `${t.message}，点击复制内容` : `${t.message}，点击关闭提示`;
}

onUnmounted(() => {
  for (const timer of copyTimers.values()) clearTimeout(timer);
  copyTimers.clear();
});
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
          :data-toast-type="t.type"
          @mouseenter="ui.pauseToast(t.id)"
          @mouseleave="ui.resumeToast(t.id)"
          @focusin="ui.pauseToast(t.id)"
          @focusout="ui.resumeToast(t.id)"
        >
          <div
            class="toast-body"
            role="button"
            tabindex="0"
            :aria-label="bodyLabel(t)"
            @keydown.enter.prevent="handleActivate(t)"
            @keydown.space.prevent="handleActivate(t)"
            @click="handleActivate(t)"
          >
            <span class="toast-icon" aria-hidden="true">{{ iconMap[t.type] }}</span>
            <span class="toast-msg">{{ t.message }}</span>
            <span v-if="copyState.has(t.id)" class="toast-copied">
              {{ copyState.get(t.id) === 'copied' ? '已复制' : '复制失败' }}
            </span>
          </div>
          <button type="button" class="toast-close" aria-label="关闭提示" @click="close(t)">
            ×
          </button>
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
  gap: 4px;
  padding: 4px 4px 4px 0;
  border-radius: var(--theme-radius-md);
  font-size: 0.88rem;
  line-height: 1.45;
  box-shadow: var(--theme-shadow-md);
  transition: all var(--theme-transition-fast);
  word-break: break-word;
  overflow-wrap: break-word;
}

.toast-body {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 6px 4px 6px 16px;
  border-radius: var(--theme-radius-md);
  cursor: pointer;
  user-select: text;
}
.toast-body:focus-visible,
.toast-close:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: -2px;
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

.toast-copied {
  flex-shrink: 0;
  align-self: center;
  padding: 0 6px;
  font-size: 0.78rem;
  font-weight: 600;
  border: 1px solid currentColor;
  border-radius: var(--theme-radius-sm);
  opacity: 0.9;
}

.toast-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.15rem;
  line-height: 1;
  color: inherit;
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  opacity: 0.75;
  transition: opacity var(--theme-transition-fast);
}
.toast-close:hover {
  opacity: 1;
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
/* 减少动态效果由 themes/variables.css 的全局规则统一处理（系统偏好 ∪ 应用内开关） */
</style>
