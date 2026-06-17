<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  label: string
  current: number
  max: number
  color?: string  // CSS variable or hex
  showValues?: boolean
  height?: number
}>()

const percent = computed(() => {
  if (props.max <= 0) return 0
  return Math.min(100, Math.max(0, (props.current / props.max) * 100))
})

const barColor = computed(() => props.color || 'var(--theme-hp)')
</script>

<template>
  <div class="resource-bar" :style="{ height: (height || 14) + 'px' }">
    <span class="res-label">{{ label }}</span>
    <div class="res-track">
      <div
        class="res-fill"
        :style="{ width: percent + '%', background: barColor }"
      />
      <span v-if="showValues !== false" class="res-values">
        {{ current }} / {{ max }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.resource-bar {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: var(--theme-spacing-sm);
  align-items: center;
}
.res-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-muted);
  text-align: right;
  text-transform: uppercase;
}
.res-track {
  position: relative;
  height: 100%;
  min-height: 10px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-full);
  overflow: hidden;
}
.res-fill {
  position: absolute;
  left: 0;
  top: 0;
  height: 100%;
  border-radius: var(--theme-radius-full);
  transition: width 250ms ease;
}
.res-values {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  text-shadow: 0 1px 2px rgba(0,0,0,0.5);
}
</style>
