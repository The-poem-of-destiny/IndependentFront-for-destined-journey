<script setup lang="ts">
import { nextTick } from 'vue';

const props = defineProps<{
  attrKey: string;
  modelValue: number;
  max: number;
  remaining: number;
  label: string;
  /** 数值位换成可直接输入的文本框（只给基础列用） */
  editable?: boolean;
}>();

const emit = defineEmits<{
  inc: [attr: string];
  dec: [attr: string];
  set: [attr: string, value: number];
}>();

function onFocus(e: FocusEvent) {
  (e.target as HTMLInputElement).select();
}

/**
 * 提交输入：空串 / 非数字恢复原值；否则发 set，由 store 钳制。
 * 被钳回原值时 modelValue 不变、Vue 不会重渲染，所以等父组件重渲染那一拍之后
 * 手动把 input.value 写回实际值。
 */
function commit(e: Event) {
  const input = e.target as HTMLInputElement;
  const raw = input.value.trim();
  const n = raw === '' ? NaN : Number(raw);
  if (Number.isFinite(n)) emit('set', props.attrKey, n);
  void nextTick(() => {
    input.value = String(props.modelValue);
  });
}
</script>

<template>
  <div class="attr-editor">
    <span class="attr-label">{{ label }}</span>
    <div class="attr-controls">
      <button
        class="attr-btn"
        data-test="dec-btn"
        :disabled="modelValue <= 0"
        aria-label="减少"
        @click="$emit('dec', attrKey)"
      >
        −
      </button>
      <input
        v-if="editable"
        class="attr-value attr-input"
        :class="{ boosted: modelValue > 0 }"
        data-test="value-input"
        type="text"
        inputmode="numeric"
        :value="modelValue"
        :aria-label="`${attrKey}基础点数`"
        @focus="onFocus"
        @change="commit"
        @keydown.enter.prevent="($event.target as HTMLInputElement).blur()"
      />
      <span v-else class="attr-value" :class="{ boosted: modelValue > 0 }">{{ modelValue }}</span>
      <button
        class="attr-btn"
        data-test="inc-btn"
        :disabled="modelValue >= max || remaining <= 0"
        aria-label="增加"
        @click="$emit('inc', attrKey)"
      >
        +
      </button>
    </div>
    <span class="attr-cap">/ {{ max }}</span>
  </div>
</template>

<style scoped>
.attr-editor {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-xs) 0;
}
.attr-label {
  width: 36px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
}
.attr-controls {
  display: flex;
  align-items: center;
  gap: 2px;
}
.attr-btn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all var(--theme-transition-fast);
}
.attr-btn:hover:not(:disabled) {
  border-color: var(--theme-color-primary);
  color: var(--theme-color-primary);
}
.attr-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.attr-value {
  width: 32px;
  text-align: center;
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.attr-input {
  height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  font-family: inherit;
  transition: border-color var(--theme-transition-fast);
}
.attr-input:hover,
.attr-input:focus {
  border-color: var(--theme-card-border);
  outline: none;
}
.attr-input:focus-visible {
  border-color: var(--theme-color-primary);
}
.attr-value.boosted {
  color: var(--theme-color-primary);
}
.attr-cap {
  font-size: 0.7rem;
  color: var(--theme-text-muted);
}
</style>
