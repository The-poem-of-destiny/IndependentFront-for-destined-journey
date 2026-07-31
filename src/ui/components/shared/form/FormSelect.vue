<script setup lang="ts" generic="T extends string | number | boolean">
const props = defineProps<{
  modelValue: T
  label?: string
  options: { value: T; label: string; disabled?: boolean }[]
  placeholder?: string
  disabled?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: T]
}>()

// select.value 永远是 string，所以渲染时统一 String() 匹配；
// 反向按 string 找回 option 的原值（可能是 boolean/number），保证 v-model 类型不漂移
function onChange(e: Event) {
  const sel = e.target as HTMLSelectElement
  const matched = props.options.find(o => String(o.value) === sel.value)
  emit('update:modelValue', (matched ? matched.value : sel.value) as T)
}
</script>

<template>
  <div class="form-field">
    <label v-if="label || $slots.label" class="form-label">
      {{ label }}<slot name="label" />
    </label>
    <select
      class="form-select"
      :value="String(modelValue)"
      :disabled="disabled"
      @change="onChange"
    >
      <option v-if="placeholder" value="" disabled>{{ placeholder }}</option>
      <option
        v-for="opt in options"
        :key="String(opt.value)"
        :value="String(opt.value)"
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
