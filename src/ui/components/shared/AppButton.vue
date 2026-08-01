<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  block?: boolean;
  /**
   * 忙碌态：转圈 + 自动禁用。
   *
   * ★ 与 `disabled` **语义不同**，别拿 disabled 顶替: disabled 是「不能做」（灰掉、
   * 到此为止），loading 是「正在做」（马上有结果）。两者长一个样时，用户按下按钮后
   * 只看到它变灰，分不清是自己点漏了、还是被拒绝了、还是在跑 —— 而工坊这边一次
   * 安装要下几百 KB 载荷，这段沉默可以长达几十秒。
   */
  loading?: boolean;
}>();
</script>

<template>
  <button
    class="app-btn"
    :class="[
      `btn-${variant || 'secondary'}`,
      `btn-${size || 'md'}`,
      // loading 有自己的压暗度：btn-disabled 的 0.5 会把转圈也压得看不清
      { 'btn-block': block, 'btn-disabled': disabled && !loading, 'btn-loading': loading },
    ]"
    :disabled="disabled || loading"
    :aria-busy="loading || undefined"
  >
    <span v-if="loading" class="btn-spinner" aria-hidden="true"></span>
    <slot />
  </button>
</template>

<style scoped>
.app-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  border: 1px solid transparent;
  border-radius: var(--theme-radius-md);
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
  line-height: 1;
  white-space: nowrap;
}
.app-btn:active {
  transform: translateY(1px);
}

.btn-sm {
  padding: 6px 12px;
  font-size: 0.85rem;
}
.btn-md {
  padding: 8px 16px;
  font-size: 0.95rem;
}
.btn-lg {
  padding: 12px 24px;
  font-size: 1.05rem;
}

.btn-primary {
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  border-color: var(--theme-primary);
}
.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-secondary {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  border-color: var(--theme-card-border);
}
.btn-secondary:hover:not(:disabled) {
  background: var(--theme-surface-muted);
}

.btn-danger {
  background: var(--theme-error);
  color: #fff;
  border-color: var(--theme-error);
}
.btn-danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-ghost {
  background: transparent;
  color: var(--theme-text-secondary);
  border-color: transparent;
}
.btn-ghost:hover:not(:disabled) {
  background: var(--theme-title-bar-btn-hover);
  color: var(--theme-text-primary);
}

.btn-block {
  display: flex;
  width: 100%;
}
.btn-disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* ── 忙碌态 ── */
.btn-loading {
  opacity: 0.8;
  pointer-events: none;
  cursor: progress;
}
/*
 * 转圈用 em 而非 px：三档尺寸各自跟着字号缩放，不必写三份。
 * 描边取 currentColor —— 四个 variant × 10 主题都不用单独配色。
 */
.btn-spinner {
  flex-shrink: 0;
  width: 0.9em;
  height: 0.9em;
  border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  border-radius: 50%;
  animation: app-btn-spin 0.7s linear infinite;
}
@keyframes app-btn-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .app-btn {
    transition: none;
  }
  .app-btn:active {
    transform: none;
  }
  /*
   * 转圈**不在这里关**: `themes/variables.css` 的全局减动效规则会让它瞬间跑完一轮
   * 后停住 —— 圈还在（配合按钮文案与 aria-busy 仍说得清"正在做"），只是不转。
   * 写成 `animation: none` 效果一样，但那条路子用在 `both` 填充的动画上会撤销终态，
   * 全站统一走全局那套更不容易踩到。
   */
}
</style>
