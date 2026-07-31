<script setup lang="ts">
import type { QualityLevel } from '@engine/types';

defineProps<{
  quality?: QualityLevel;
  clickable?: boolean;
  selected?: boolean;
  padding?: 'sm' | 'md' | 'lg';
}>();
</script>

<template>
  <div
    class="app-card"
    :class="{
      [`card-${quality || 'default'}`]: true,
      'card-clickable': clickable,
      'card-selected': selected,
      [`card-padding-${padding || 'md'}`]: true,
    }"
  >
    <slot />
  </div>
</template>

<style scoped>
.app-card {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  transition: all var(--theme-transition-fast);
}
.card-padding-sm {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.card-padding-md {
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
}
.card-padding-lg {
  padding: var(--theme-spacing-lg) var(--theme-spacing-xl);
}

.card-clickable {
  cursor: pointer;
}
.card-clickable:hover {
  border-color: var(--theme-primary);
  transform: translateY(-1px);
  box-shadow: var(--theme-shadow-sm);
}
.card-selected {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  box-shadow:
    0 0 0 1px var(--theme-primary),
    0 0 12px color-mix(in srgb, var(--theme-primary) 25%, transparent);
}

/* 品质表达：整圈边框色调（配合品质色点/名字着色，禁用左侧色条） */
.card-common {
  border-color: var(--theme-card-border);
}
.card-uncommon {
  border-color: color-mix(in srgb, var(--theme-quality-uncommon) 45%, var(--theme-card-border));
}
.card-rare {
  border-color: color-mix(in srgb, var(--theme-quality-rare) 45%, var(--theme-card-border));
}
.card-epic {
  border-color: color-mix(in srgb, var(--theme-quality-epic) 45%, var(--theme-card-border));
}
.card-legendary {
  border-color: color-mix(in srgb, var(--theme-quality-legendary) 45%, var(--theme-card-border));
}
.card-mythic {
  border-color: color-mix(in srgb, var(--theme-quality-mythic) 45%, var(--theme-card-border));
}
.card-unique {
  border-color: color-mix(in srgb, var(--theme-quality-unique) 45%, var(--theme-card-border));
}
</style>
