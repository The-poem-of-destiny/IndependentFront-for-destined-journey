<script setup lang="ts">
defineProps<{
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  block?: boolean
}>()
</script>

<template>
  <button
    class="app-btn"
    :class="[
      `btn-${variant || 'secondary'}`,
      `btn-${size || 'md'}`,
      { 'btn-block': block, 'btn-disabled': disabled }
    ]"
    :disabled="disabled"
  >
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
.app-btn:active { transform: translateY(1px); }

.btn-sm { padding: 6px 12px; font-size: 0.85rem; }
.btn-md { padding: 8px 16px; font-size: 0.95rem; }
.btn-lg { padding: 12px 24px; font-size: 1.05rem; }

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

.btn-block { display: flex; width: 100%; }
.btn-disabled { opacity: 0.5; pointer-events: none; }
</style>
