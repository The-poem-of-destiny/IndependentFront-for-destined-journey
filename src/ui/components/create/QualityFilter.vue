<script setup lang="ts">
import type { CatalogRarityCode } from '@engine/start-catalog';

defineProps<{ modelValue: CatalogRarityCode | 'all' }>();
defineEmits<{ 'update:modelValue': [val: CatalogRarityCode | 'all'] }>();

const FILTER_OPTIONS: { key: CatalogRarityCode | 'all'; label: string; color: string }[] = [
  { key: 'all', label: '全部', color: 'var(--theme-text-secondary)' },
  { key: 'common', label: '普通', color: 'var(--theme-quality-common)' },
  { key: 'uncommon', label: '优良', color: 'var(--theme-quality-uncommon)' },
  { key: 'rare', label: '稀有', color: 'var(--theme-quality-rare)' },
  { key: 'epic', label: '史诗', color: 'var(--theme-quality-epic)' },
  { key: 'legendary', label: '传说', color: 'var(--theme-quality-legendary)' },
  { key: 'mythic', label: '神话', color: 'var(--theme-quality-mythic)' },
  { key: 'only', label: '唯一', color: 'var(--theme-quality-unique)' },
];
</script>

<template>
  <div class="quality-filter">
    <button
      v-for="opt in FILTER_OPTIONS"
      :key="opt.key"
      class="q-btn"
      :class="{ active: modelValue === opt.key }"
      :style="{ '--q-color': opt.color }"
      @click="$emit('update:modelValue', opt.key)"
    >
      <span v-if="opt.key !== 'all'" class="q-dot" aria-hidden="true" />
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
  display: inline-flex;
  align-items: center;
  gap: 0.35em;
  border: 1px solid var(--theme-card-border);
  border-radius: 1em;
  background: transparent;
  color: var(--theme-text-secondary);
  cursor: pointer;
  padding: 0.25em 0.65em;
  font-size: 0.72em;
  font-weight: 600;
  line-height: 1.3;
  white-space: nowrap;
  transition:
    background var(--theme-transition-fast),
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast);
}
.q-dot {
  width: 0.55em;
  height: 0.55em;
  border-radius: 50%;
  background: var(--q-color);
  flex-shrink: 0;
}
.q-btn:hover {
  color: var(--theme-text-primary);
  border-color: color-mix(
    in srgb,
    var(--q-color, var(--theme-primary)) 45%,
    var(--theme-card-border)
  );
}
.q-btn.active {
  color: var(--q-color, var(--theme-text-primary));
  background: color-mix(in srgb, var(--q-color, var(--theme-primary)) 10%, transparent);
  border-color: color-mix(
    in srgb,
    var(--q-color, var(--theme-primary)) 55%,
    var(--theme-card-border)
  );
}
</style>
