<script setup lang="ts">
defineProps<{
  current: number
  total?: number
}>()

const STEP_LABELS = [
  '难度选择',
  '基础信息',
  '命定核心',
  '角色启用',
  '装备选择',
  '背景故事',
  '剧情规划',
  '确认提交',
]

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八']
</script>

<template>
  <nav class="create-steps" aria-label="角色创建步骤">
    <template v-for="(label, i) in STEP_LABELS" :key="i">
      <!-- 章节间丝线 -->
      <div v-if="i > 0" class="step-connector" :class="{ 'connector-done': i <= current }" aria-hidden="true" />

      <button
        class="step-dot"
        :class="{
          active: i === current,
          done: i < current,
        }"
        :aria-current="i === current ? 'step' : undefined"
        :tabindex="i <= current ? 0 : -1"
      >
        <span class="step-num">
          <span v-if="i < current" class="step-check">✓</span>
          <span v-else class="step-cn">{{ CN_NUM[i] }}</span>
        </span>
        <span class="step-label">{{ label }}</span>
      </button>
    </template>
  </nav>
</template>

<style scoped>
.create-steps {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border-bottom: 1px solid var(--theme-card-border);
  overflow-x: auto;
}

/* ===== 章节间丝线 ===== */
.step-connector {
  width: 24px;
  height: 1px;
  background: var(--theme-card-border);
  flex-shrink: 0;
  transition: background 0.3s ease;
}
.connector-done {
  background: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
}

/* ===== 章节印记 ===== */
.step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  cursor: default;
  padding: 4px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  min-width: 64px;
}
.step-dot.active,
.step-dot.done {
  cursor: pointer;
}

.step-num {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.8rem;
  background: transparent;
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
  transition: background 0.2s ease, border-color 0.2s ease, color 0.2s ease, box-shadow 0.2s ease;
}
.step-cn {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  font-weight: 700;
}
.active .step-num {
  background: color-mix(in srgb, var(--theme-primary) 14%, var(--theme-card-bg));
  border-color: var(--theme-primary);
  color: var(--theme-primary);
  box-shadow: 0 0 10px color-mix(in srgb, var(--theme-primary) 25%, transparent);
}
.done .step-num {
  border-color: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
  color: color-mix(in srgb, var(--theme-primary) 75%, var(--theme-text-muted));
}
.step-check {
  font-size: 0.8rem;
  font-weight: 700;
}

.step-label {
  font-size: 0.62rem;
  white-space: nowrap;
  color: var(--theme-text-muted);
  font-weight: 500;
}
.active .step-label {
  color: var(--theme-text-primary);
  font-weight: 700;
}
.done .step-label {
  color: var(--theme-text-secondary);
}

@media (prefers-reduced-motion: reduce) {
  .step-connector,
  .step-num {
    transition: none;
  }
}
</style>
