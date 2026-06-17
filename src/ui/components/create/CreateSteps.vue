<script setup lang="ts">
defineProps<{
  current: number
  total?: number
}>()

const STEP_LABELS = [
  '难度选择',
  '基础信息',
  '命定核心',
  '装备选择',
  '背景故事',
  '剧情规划',
  '确认创建',
]
</script>

<template>
  <nav class="create-steps" aria-label="角色创建步骤">
    <button
      v-for="(label, i) in STEP_LABELS"
      :key="i"
      class="step-dot"
      :class="{
        active: i === current,
        done: i < current,
      }"
      :aria-current="i === current ? 'step' : undefined"
      :tabindex="i <= current ? 0 : -1"
    >
      <span class="step-num">{{ i }}</span>
      <span class="step-label">{{ label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.create-steps {
  display: flex;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border-bottom: 1px solid var(--theme-card-border);
  overflow-x: auto;
}
.step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  border: none;
  background: transparent;
  cursor: default;
  padding: 4px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  transition: all var(--theme-transition-fast);
  opacity: 0.35;
  min-width: 56px;
}
.step-dot.active,
.step-dot.done {
  opacity: 1;
  cursor: pointer;
}
.step-num {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
  background: var(--theme-card-border);
  color: var(--theme-text-muted);
  transition: all var(--theme-transition-fast);
}
.active .step-num {
  background: var(--theme-color-primary);
  color: #fff;
}
.done .step-num {
  background: var(--theme-color-primary);
  color: #fff;
  opacity: 0.7;
}
.step-label {
  font-size: 0.6rem;
  white-space: nowrap;
  color: var(--theme-text-secondary);
}
.active .step-label {
  color: var(--theme-text-primary);
  font-weight: 600;
}
</style>
