<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  total: number
  used: number
  difficultyLabel?: string
}>()

const percent = computed(() => {
  if (props.total <= 0) return 100
  return Math.min(100, Math.max(0, ((props.total - props.used) / props.total) * 100))
})

const barColor = computed(() => {
  if (percent.value > 50) return 'var(--theme-hp, #4caf50)'
  if (percent.value > 25) return 'var(--theme-quality-传说, #ff9800)'
  return 'var(--theme-quality-唯一, #ff0000)'
})
</script>

<template>
  <div class="points-bar">
    <div class="points-track">
      <div
        class="points-fill"
        :style="{ width: percent + '%', background: barColor }"
      />
      <span class="points-text">
        转生点数: {{ total - used }} / {{ total }}
        <span v-if="difficultyLabel" class="difficulty-tag">({{ difficultyLabel }})</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.points-bar {
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  background: var(--theme-bg-primary);
  border-bottom: 1px solid var(--theme-card-border);
}
.points-track {
  position: relative;
  height: 22px;
  background: var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  overflow: hidden;
}
.points-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  transition: width 0.3s ease;
  opacity: 0.5;
  border-radius: var(--theme-radius-sm);
}
.points-text {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.difficulty-tag {
  margin-left: 4px;
  font-weight: 400;
  opacity: 0.7;
}
</style>
