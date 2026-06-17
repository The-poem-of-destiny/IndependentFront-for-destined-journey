<script setup lang="ts">
defineProps<{
  attrKey: string
  modelValue: number
  max: number
  remaining: number
  label: string
}>()

defineEmits<{
  inc: [attr: string]
  dec: [attr: string]
}>()
</script>

<template>
  <div class="attr-editor">
    <span class="attr-label">{{ label }}</span>
    <div class="attr-controls">
      <button
        class="attr-btn"
        :disabled="modelValue <= 0"
        @click="$emit('dec', attrKey)"
        aria-label="减少"
      >−</button>
      <span class="attr-value" :class="{ boosted: modelValue > 0 }">{{ modelValue }}</span>
      <button
        class="attr-btn"
        :disabled="modelValue >= max || remaining <= 0"
        @click="$emit('inc', attrKey)"
        aria-label="增加"
      >+</button>
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
.attr-value.boosted {
  color: var(--theme-color-primary);
}
.attr-cap {
  font-size: 0.7rem;
  color: var(--theme-text-muted);
}
</style>
