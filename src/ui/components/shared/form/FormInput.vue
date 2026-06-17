<script setup lang="ts">
defineProps<{
  modelValue: string
  label?: string
  placeholder?: string
  disabled?: boolean
  type?: string
  readonly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()

function onInput(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="form-field">
    <label v-if="label || $slots.label" class="form-label">
      {{ label }}<slot name="label" />
    </label>
    <input
      class="form-input"
      :type="type || 'text'"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      :readonly="readonly"
      @input="onInput"
    />
    <span v-if="$slots.hint" class="form-hint"><slot name="hint" /></span>
  </div>
</template>

<style scoped>
.form-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.form-label {
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--theme-text-secondary);
}
.form-input {
  padding: 8px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.95rem;
  transition: border-color var(--theme-transition-fast);
}
.form-input:focus {
  outline: none;
  border-color: var(--theme-primary);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--theme-primary) 24%, transparent);
}
.form-input:disabled {
  opacity: 0.5;
}
.form-hint {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
</style>
