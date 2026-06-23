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

const barStyle = computed(() => {
  // 用品质色渐变：剩余多→绿，剩余中→金，剩余少→红
  if (percent.value > 50) return 'linear-gradient(90deg, #22c55e, #16a34a)'
  if (percent.value > 25) return 'linear-gradient(90deg, #f59e0b, #d97706)'
  return 'linear-gradient(90deg, #ef4444, #dc2626)'
})
</script>

<template>
  <div class="points-bar">
    <div class="points-track">
      <div
        class="points-fill"
        :style="{ width: percent + '%', background: barStyle }"
      />
      <span class="points-text">
        <span class="points-label">转生点数</span>
        <span class="points-numbers">
          <strong class="points-remain">{{ total - used }}</strong>
          <span class="points-sep"> / </span>
          <span class="points-total">{{ total }}</span>
        </span>
        <span v-if="difficultyLabel" class="difficulty-tag">{{ difficultyLabel }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.points-bar {
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border-bottom: 1px solid var(--theme-card-border);
}
.points-track {
  position: relative;
  height: 28px;
  background: var(--theme-content-bg);
  border-radius: var(--theme-radius-md, 8px);
  overflow: hidden;
  border: 1px solid var(--theme-card-border);
}
.points-fill {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  transition: width 0.4s ease;
  opacity: 0.4;
  border-radius: var(--theme-radius-md, 8px);
}
.points-text {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  font-size: 0.78rem;
  font-weight: 500;
  color: var(--theme-text-primary);
  gap: 8px;
}
.points-label {
  color: var(--theme-text-muted);
  font-weight: 500;
}
.points-numbers {
  display: flex;
  align-items: baseline;
  gap: 2px;
}
.points-remain {
  font-size: 0.95rem;
  font-weight: 800;
  color: var(--theme-text-primary);
}
.points-sep {
  color: var(--theme-text-muted);
  font-size: 0.7rem;
}
.points-total {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
}
.difficulty-tag {
  font-size: 0.65rem;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--theme-surface-muted);
  color: var(--theme-primary);
  letter-spacing: 0.5px;
}
</style>
