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
          <!-- 剩余时间细线：时长与 store 的计时同源；悬停 / 聚焦时与计时一起停住。常驻提示没有 -->
          <span
            v-if="t.duration > 0"
            class="toast-timer"
            :style="{ animationDuration: `${t.duration}ms` }"
            aria-hidden="true"
          />
        </div>
      </transition-group>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 动效 v1（2026-11-16）：提示从整块饱和色改为主题卡片底 + 语义色染底与整圈描边
 * （design.md §1「激活态/强调徽章通用配方」），语义色只落在图标、描边与计时细线上。
 *
 * 容器刻意是**块级**布局而不是 flex：离场的提示要 `position: absolute` 脱离文档流，
 * 好让其余提示用 FLIP（.toast-move）平滑补位；flex 容器里绝对定位子元素的静态位置
 * 是容器起点，离场那条会先跳到最上面再淡出。
 */
.toast-container {
  position: fixed;
  top: 16px;
  right: 16px;
  z-index: 2000;
  width: min(440px, calc(100vw - 32px));
  pointer-events: none;
}

.toast-item {
  --toast-accent: var(--theme-primary);
  position: relative;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin-bottom: var(--theme-spacing-sm);
  padding: 4px 4px 4px 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--toast-accent) 40%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--toast-accent) 9%, var(--theme-card-bg));
  color: var(--theme-text-primary);
  font-size: 0.88rem;
  line-height: 1.45;
  box-shadow: var(--theme-shadow-lg);
  word-break: break-word;
  overflow-wrap: break-word;
  pointer-events: auto;
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
  width: 1.375rem;
  height: 1.375rem;
  margin-top: 0.03rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid color-mix(in srgb, var(--toast-accent) 45%, transparent);
  border-radius: 50%;
  background: color-mix(in srgb, var(--toast-accent) 16%, transparent);
  color: var(--toast-accent);
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1;
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
  color: var(--toast-accent);
  border: 1px solid currentColor;
  border-radius: var(--theme-radius-sm);
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
  color: var(--theme-text-muted);
  background: none;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    color var(--theme-transition-fast),
    background var(--theme-transition-fast);
}
.toast-close:hover {
  color: var(--theme-text-primary);
  background: color-mix(in srgb, var(--toast-accent) 12%, transparent);
}

.toast-success {
  --toast-accent: var(--theme-success);
}
.toast-warning {
  --toast-accent: var(--theme-warning);
}
.toast-error {
  --toast-accent: var(--theme-error);
}

/* 剩余时间细线：只缩 transform，悬停 / 聚焦时停住（与 store 的 pauseToast 同一时机） */
.toast-timer {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: var(--toast-accent);
  opacity: 0.55;
  transform-origin: left center;
  animation-name: toast-timer;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}
.toast-item:hover .toast-timer,
.toast-item:focus-within .toast-timer {
  animation-play-state: paused;
}
@keyframes toast-timer {
  to {
    transform: scaleX(0);
  }
}

/* 入场从右侧滑入并轻微放大落定；离场更短；其余提示用 FLIP 平滑补位 */
.toast-enter-active {
  transition:
    opacity var(--motion-duration-base) var(--motion-ease-standard),
    transform var(--motion-duration-slow) var(--motion-ease-enter);
}
.toast-leave-active {
  position: absolute;
  width: 100%;
  transition:
    opacity var(--motion-duration-fast) var(--motion-ease-exit),
    transform var(--motion-duration-fast) var(--motion-ease-exit);
}
.toast-move {
  transition: transform var(--motion-duration-base) var(--motion-ease-standard);
}
.toast-enter-from {
  opacity: 0;
  transform: translateX(24px) scale(0.98);
}
.toast-leave-to {
  opacity: 0;
  transform: translateX(16px);
}
/* 减少动态效果由 themes/variables.css 的全局规则统一处理（系统偏好 ∪ 应用内开关） */
</style>
