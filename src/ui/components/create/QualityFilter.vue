<script setup lang="ts">
import type { Rarity } from '@engine/start-catalog'
import { RARITY_TO_QUALITY } from '@engine/start-catalog'
import type { QualityLevel } from '@engine/types'

defineProps<{ modelValue: Rarity | 'all' }>()
defineEmits<{ 'update:modelValue': [val: Rarity | 'all'] }>()

const FILTER_OPTIONS: { key: Rarity | 'all'; label: string; color: string; bg: string }[] = [
  { key: 'all',       label: '全部', color: '#666',       bg: '#eee' },
  { key: 'common',    label: '普通', color: '#fff',       bg: '#9e9e9e' },
  { key: 'uncommon',  label: '优良', color: '#fff',       bg: '#4caf50' },
  { key: 'rare',      label: '稀有', color: '#fff',       bg: '#2196f3' },
  { key: 'epic',      label: '史诗', color: '#fff',       bg: '#9c27b0' },
  { key: 'legendary', label: '传说', color: '#fff',       bg: '#ff9800' },
  { key: 'mythic',    label: '神话', color: '#fff',       bg: '#f44336' },
  { key: 'only',      label: '唯一', color: '#fff',       bg: '#00bcd4' },
]
</script>

<template>
  <div class="quality-filter">
    <button
      v-for="opt in FILTER_OPTIONS" :key="opt.key"
      class="q-btn"
      :class="{ active: modelValue === opt.key }"
      :style="modelValue === opt.key
        ? { background: opt.bg, color: opt.color, borderColor: opt.bg }
        : { color: opt.key === 'all' ? '#666' : opt.bg, borderColor: opt.key === 'all' ? '#ccc' : opt.bg }"
      @click="$emit('update:modelValue', opt.key)"
    >
      {{ opt.label }}
    </button>
  </div>
</template>

<style scoped>
.quality-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3em;
  margin-bottom: var(--theme-spacing-sm);
}
.q-btn {
  border: 1.5px solid;
  border-radius: 1em;
  background: transparent;
  cursor: pointer;
  padding: 0.25em 0.65em;
  font-size: 0.72em;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  transition: all var(--theme-transition-fast);
}
.q-btn:hover {
  opacity: 0.8;
  transform: translateY(-1px);
}
.q-btn.active {
  transform: translateY(-1px);
  box-shadow: 0 1px 4px rgba(0,0,0,0.2);
}
</style>
