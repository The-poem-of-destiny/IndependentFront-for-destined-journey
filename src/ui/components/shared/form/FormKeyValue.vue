<script setup lang="ts">
import { ref } from 'vue'

const props = defineProps<{
  modelValue: Record<string, string>
  disabled?: boolean
  keyPlaceholder?: string
  valuePlaceholder?: string
  maxRows?: number
}>()

const emit = defineEmits<{
  'update:modelValue': [value: Record<string, string>]
}>()

const newKey = ref('')
const newValue = ref('')

function add() {
  if (!newKey.value.trim() || !newValue.value.trim()) return
  if (props.maxRows && Object.keys(props.modelValue).length >= props.maxRows) return
  emit('update:modelValue', { ...props.modelValue, [newKey.value.trim()]: newValue.value.trim() })
  newKey.value = ''
  newValue.value = ''
}

function remove(key: string) {
  const next = { ...props.modelValue }
  delete next[key]
  emit('update:modelValue', next)
}

const entries = () => Object.entries(props.modelValue)
</script>

<template>
  <div class="kv-editor">
    <div class="kv-list">
      <div v-for="[k, v] in entries()" :key="k" class="kv-row">
        <span class="kv-key">{{ k }}</span>
        <span class="kv-colon">:</span>
        <span class="kv-value">{{ v }}</span>
        <button v-if="!disabled" class="kv-remove" @click="remove(k)">×</button>
      </div>
    </div>
    <div v-if="!disabled" class="kv-add">
      <input v-model="newKey" :placeholder="keyPlaceholder || '键'" class="kv-input" />
      <input v-model="newValue" :placeholder="valuePlaceholder || '值'" class="kv-input" />
      <button class="kv-add-btn" @click="add">+</button>
    </div>
  </div>
</template>

<style scoped>
.kv-editor { display: flex; flex-direction: column; gap: var(--theme-spacing-sm); }
.kv-list { display: flex; flex-direction: column; gap: 4px; }
.kv-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm);
  font-size: 0.85rem;
}
.kv-key { color: var(--theme-primary); font-weight: 500; }
.kv-colon { color: var(--theme-text-muted); }
.kv-value { color: var(--theme-text-primary); flex: 1; }
.kv-remove {
  background: none;
  border: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 1.1rem;
  padding: 0 4px;
  line-height: 1;
}
.kv-remove:hover { color: var(--theme-error); }

.kv-add { display: flex; gap: 6px; }
.kv-input {
  flex: 1;
  padding: 6px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-content-bg);
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.85rem;
}
.kv-input:focus { border-color: var(--theme-primary); outline: none; }
.kv-input::placeholder { color: var(--theme-text-muted); }
.kv-add-btn {
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-primary);
  color: var(--theme-primary-text);
  border: none;
  border-radius: var(--theme-radius-sm);
  font-size: 1rem;
  cursor: pointer;
}
</style>
