<script setup lang="ts">
import type { QualityLevel } from '@engine/types'

defineProps<{
  quality?: QualityLevel
  clickable?: boolean
  selected?: boolean
  padding?: 'sm' | 'md' | 'lg'
}>()
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
.card-padding-sm { padding: var(--theme-spacing-sm) var(--theme-spacing-md); }
.card-padding-md { padding: var(--theme-spacing-md) var(--theme-spacing-lg); }
.card-padding-lg { padding: var(--theme-spacing-lg) var(--theme-spacing-xl); }

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
}

/* Quality borders */
.card-common { border-color: var(--theme-card-border); }
.card-uncommon { border-left: 3px solid var(--theme-quality-uncommon); }
.card-rare { border-left: 3px solid var(--theme-quality-rare); }
.card-epic { border-left: 3px solid var(--theme-quality-epic); }
.card-legendary { border-left: 3px solid var(--theme-quality-legendary); }
.card-mythic { border-left: 3px solid var(--theme-quality-mythic); }
.card-unique { border-left: 3px solid var(--theme-quality-unique); }
</style>
