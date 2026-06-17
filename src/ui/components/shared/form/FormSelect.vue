<script setup lang="ts">
defineProps<{
  modelValue: string
  label?: string
  options: { value: string; label: string; disabled?: boolean }[]
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
}>()
</script>

<template>
  <div class="form-field">
    <label v-if="label || $slots.label" class="form-label">
      {{ label }}<slot name="label" />
    </label>
    <select
      class="form-select"
      :value="modelValue"
      :disabled="disabled"
      @change="emit('update:modelValue', ($event.target as HTMLSelectElement).value)"
    >
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option
        v-for="opt in options"
        :key="opt.value"
        :value="opt.value"
        :disabled="opt.disabled"
      >
        {{ opt.label }}
      </option>
    </select>
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
.form-select {
  padding: 8px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.95rem;
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}
.form-select:focus {
  outline: none;
  border-color: var(--theme-primary);
}
</style>
