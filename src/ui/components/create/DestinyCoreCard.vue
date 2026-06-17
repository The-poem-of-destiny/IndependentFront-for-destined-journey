<script setup lang="ts">
import type { DestinyCore } from '@engine/start-catalog'
import AppCard from '../shared/AppCard.vue'

defineProps<{ core: DestinyCore; selected: boolean }>()
defineEmits<{ select: [id: string] }>()
</script>

<template>
  <AppCard clickable :selected="selected" class="core-card" @click="$emit('select', core.id)">
    <div class="core-inner">
      <span class="core-name">{{ core.name }}</span>
      <span class="core-author">{{ core.author }}</span>
      <span class="core-theme">{{ core.theme }}</span>
      <span v-if="core.mode" class="core-mode">{{ core.mode }}</span>
    </div>
  </AppCard>
</template>

<style scoped>
.core-card {
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.core-inner {
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.core-name { font-weight: 700; font-size: 0.9rem; color: var(--theme-text-primary); }
.core-author { font-size: 0.7rem; color: var(--theme-color-primary); }
.core-theme { font-size: 0.72rem; color: var(--theme-text-secondary); }
.core-mode {
  font-size: 0.65rem;
  color: var(--theme-quality-稀有);
  background: var(--theme-card-border);
  border-radius: 3px;
  padding: 0 4px;
  align-self: flex-start;
  margin-top: 2px;
}
</style>
