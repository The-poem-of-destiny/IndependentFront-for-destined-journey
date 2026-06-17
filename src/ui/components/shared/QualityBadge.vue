<script setup lang="ts">
import { computed } from 'vue'
import type { QualityLevel } from '@engine/types'

const props = defineProps<{
  quality: QualityLevel
  size?: 'sm' | 'md'
}>()

const color = computed(() => `var(--theme-quality-${props.quality})`)
</script>

<template>
  <span
    class="quality-badge"
    :class="[`badge-${size || 'sm'}`, `quality-${quality}`]"
    :style="{ color: color, borderColor: color }"
  >
    {{ quality }}
  </span>
</template>

<style scoped>
.quality-badge {
  display: inline-flex;
  align-items: center;
  border: 1px solid;
  border-radius: var(--theme-radius-sm);
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
}
.badge-sm {
  padding: 2px 6px;
  font-size: 0.7rem;
}
.badge-md {
  padding: 3px 8px;
  font-size: 0.8rem;
}
</style>
