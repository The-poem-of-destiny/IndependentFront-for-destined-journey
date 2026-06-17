<script setup lang="ts">
const props = defineProps<{
  modelValue: number
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  label?: string
}>()

const emit = defineEmits<{
  'update:modelValue': [value: number]
}>()

function clamp(v: number): number {
  if (props.min !== undefined && v < props.min) return props.min
  if (props.max !== undefined && v > props.max) return props.max
  return v
}

function increase() {
  emit('update:modelValue', clamp(props.modelValue + (props.step || 1)))
}
function decrease() {
  emit('update:modelValue', clamp(props.modelValue - (props.step || 1)))
}
function onInput(e: Event) {
  const v = parseInt((e.target as HTMLInputElement).value, 10)
  if (!isNaN(v)) emit('update:modelValue', clamp(v))
}
</script>

<template>
  <div class="stepper">
    <span v-if="label" class="stepper-label">{{ label }}</span>
    <div class="stepper-controls">
      <button class="stepper-btn" :disabled="disabled || (min !== undefined && modelValue <= min)" @click="decrease">−</button>
      <input
        class="stepper-input"
        type="number"
        :value="modelValue"
        :min="min"
        :max="max"
        :step="step || 1"
        :disabled="disabled"
        @input="onInput"
      />
      <button class="stepper-btn" :disabled="disabled || (max !== undefined && modelValue >= max)" @click="increase">+</button>
    </div>
  </div>
</template>

<style scoped>
.stepper { display: flex; flex-direction: column; gap: 4px; }
.stepper-label { font-size: 0.85rem; font-weight: 500; color: var(--theme-text-secondary); }
.stepper-controls { display: flex; align-items: stretch; }
.stepper-btn {
  width: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-primary);
  font-size: 1.1rem;
  cursor: pointer;
  transition: all var(--theme-transition-fast);
}
.stepper-btn:first-child { border-radius: var(--theme-radius-md) 0 0 var(--theme-radius-md); }
.stepper-btn:last-child { border-radius: 0 var(--theme-radius-md) var(--theme-radius-md) 0; }
.stepper-btn:hover:not(:disabled) { background: var(--theme-surface-muted); }
.stepper-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.stepper-input {
  width: 60px;
  text-align: center;
  border: 1px solid var(--theme-card-border);
  border-left: none;
  border-right: none;
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.95rem;
  -moz-appearance: textfield;
}
.stepper-input::-webkit-outer-spin-button,
.stepper-input::-webkit-inner-spin-button { -webkit-appearance: none; }
.stepper-input:focus { outline: none; }
</style>
