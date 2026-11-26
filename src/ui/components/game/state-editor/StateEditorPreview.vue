<script setup lang="ts">
/**
 * 变量修改器的「将要发生的变更」（试算 → 确认，设计 §11.2；拆自 StateEditorPanel，2026-11-25 审查 R6）。
 *
 * 只画试算清单与拒绝原因，确认 / 返回交给面板（提交、回读、撤销栈都在面板与 state-edit-store）。
 * 🔴 全程文本插值，不用 v-html（前值 / 后值来自模型输出）。
 */
import AppButton from '../../shared/AppButton.vue';
import type { PreviewView } from '../state-editor-view';

defineProps<{
  view: PreviewView;
  commitReasons: readonly string[];
  locked: boolean;
  committing: boolean;
}>();

const emit = defineEmits<{ close: []; confirm: [] }>();

function statusClass(status: string): string {
  if (status === '已丢弃') return 'is-dropped';
  if (status === '已纠正') return 'is-corrected';
  return 'is-applied';
}
</script>

<template>
  <div
    class="se-preview"
    role="region"
    aria-label="将要发生的变更"
    data-testid="state-editor-preview-panel"
  >
    <div class="se-sec-title">将要发生的变更</div>
    <ul class="se-preview-list">
      <li
        v-for="(row, i) in view.rows"
        :key="row.path + i"
        class="se-preview-row"
        :class="statusClass(row.status)"
      >
        <div class="se-preview-top">
          <span class="se-preview-op">{{ row.op }}</span>
          <code class="se-preview-path">{{
            row.from ? `${row.from} → ${row.path}` : row.path
          }}</code>
          <span class="se-preview-status">{{ row.status }}</span>
        </div>
        <div class="se-preview-values">
          <span class="se-before">{{ row.before }}</span>
          <span aria-hidden="true">→</span>
          <span class="se-after">{{ row.after }}</span>
        </div>
        <div v-if="row.note" class="se-preview-note">{{ row.note }}</div>
      </li>
    </ul>
    <ul
      v-if="!view.ok || commitReasons.length > 0"
      class="se-errors"
      role="alert"
      data-testid="state-editor-reasons"
    >
      <li v-for="r in commitReasons.length > 0 ? commitReasons : view.reasons" :key="r">
        {{ r }}
      </li>
    </ul>
    <div class="se-preview-actions">
      <AppButton size="sm" variant="ghost" @click="emit('close')">返回修改</AppButton>
      <AppButton
        size="sm"
        variant="primary"
        :disabled="!view.ok || locked"
        :loading="committing"
        data-testid="state-editor-confirm"
        @click="emit('confirm')"
        >确认提交</AppButton
      >
    </div>
  </div>
</template>

<style scoped src="./state-editor-shared.css"></style>
<style scoped>
.se-preview {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  max-height: 45%;
  min-height: 0;
  padding: var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  border-radius: var(--theme-radius-md);
  animation: se-rise var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}
@keyframes se-rise {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.se-sec-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.03em;
}
.se-sec-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.se-preview-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.se-preview-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  font-size: 0.8125rem;
}
.se-preview-row.is-corrected {
  border-color: color-mix(in srgb, var(--theme-warning) 40%, var(--theme-card-border));
}
.se-preview-row.is-dropped {
  border-color: color-mix(in srgb, var(--theme-error) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-error) 6%, var(--theme-card-bg));
}
.se-preview-top {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
.se-preview-op {
  font-weight: 600;
}
.se-preview-path {
  font-family: 'Cascadia Code', monospace;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  word-break: break-all;
}
.se-preview-status {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.se-preview-row.is-dropped .se-preview-status {
  color: var(--theme-error);
}
.se-preview-row.is-corrected .se-preview-status {
  color: var(--theme-warning);
}
.se-preview-values {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
  word-break: break-word;
}
.se-before {
  color: var(--theme-text-muted);
}
.se-preview-note {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  font-style: italic;
}
.se-preview-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
}
</style>
