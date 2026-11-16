<script setup lang="ts">
defineProps<{
  current: number;
  total?: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  select: [step: number];
}>();

const STEP_LABELS = [
  '难度选择',
  '基础信息',
  '命定核心',
  '角色启用',
  '装备选择',
  '背景故事',
  '剧情规划',
  '确认提交',
];

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八'];
</script>

<template>
  <nav class="create-steps" aria-label="角色创建步骤">
    <template v-for="(label, i) in STEP_LABELS" :key="i">
      <!-- 章节间丝线 -->
      <div
        v-if="i > 0"
        class="step-connector"
        :class="{ 'connector-done': i <= current }"
        aria-hidden="true"
      />

      <button
        type="button"
        class="step-dot"
        :class="{
          active: i === current,
          done: i < current,
        }"
        :aria-current="i === current ? 'step' : undefined"
        :aria-label="`第 ${i + 1} 步：${label}`"
        :disabled="disabled"
        @click="emit('select', i)"
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

/* ===== 章节间丝线 =====
   完成的丝线由左向右「描」过去（scaleX，不动 width）；退回上一步时向左收回 */
.step-connector {
  position: relative;
  width: 24px;
  height: 1px;
  background: var(--theme-card-border);
  flex-shrink: 0;
}
.step-connector::after {
  content: '';
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--theme-primary) 55%, var(--theme-card-border));
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform var(--motion-duration-slow) var(--motion-ease-standard);
}
.connector-done::after {
  transform: scaleX(1);
}

/* ===== 章节印记 ===== */
.step-dot {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  border: none;
  background: transparent;
  cursor: pointer;
  padding: 4px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  min-width: 64px;
}
.step-dot:hover:not(:disabled) .step-num,
.step-dot:focus-visible .step-num {
  border-color: color-mix(in srgb, var(--theme-primary) 70%, var(--theme-card-border));
  color: var(--theme-primary);
}
.step-dot:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
}
.step-dot:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}

.step-num {
  position: relative;
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
  transition:
    background var(--motion-duration-base) var(--motion-ease-standard),
    border-color var(--motion-duration-base) var(--motion-ease-standard),
    color var(--motion-duration-base) var(--motion-ease-standard),
    box-shadow var(--motion-duration-base) var(--motion-ease-standard);
}
/* 落到当前步骤时，印记外扩散一圈即止的光环（一次性，不循环） */
.active .step-num::after {
  content: '';
  position: absolute;
  inset: -1px;
  border-radius: 50%;
  border: 1px solid var(--theme-primary);
  opacity: 0;
  pointer-events: none;
  animation: step-halo 720ms var(--motion-ease-enter);
}
@keyframes step-halo {
  from {
    opacity: 0.7;
    transform: scale(1);
  }
  to {
    opacity: 0;
    transform: scale(1.65);
  }
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
  display: inline-block;
  font-size: 0.8rem;
  font-weight: 700;
  /* 步骤完成时勾号「盖」上去：挂载即播一次 */
  animation: step-check-in var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}
@keyframes step-check-in {
  from {
    opacity: 0;
    transform: scale(0.4) rotate(-14deg);
  }
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

/* 减动效：全局规则（themes/variables.css）把过渡与一次性动画压成瞬时 —— 光环停在透明终态、
   勾号与丝线直接到位，这里不必再单独写媒体查询 */
</style>
