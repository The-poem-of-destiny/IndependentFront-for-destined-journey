<script setup lang="ts">
import type { DestinyCore } from '@engine/start-catalog'
import AppCard from '../shared/AppCard.vue'

defineProps<{ core: DestinyCore; selected: boolean }>()
defineEmits<{ select: [id: string] }>()

const MODE_BADGES: Record<string, string> = {
  '官方': 'bg-official',
  '社区': 'bg-community',
  '隐藏': 'bg-hidden',
}
</script>

<template>
  <AppCard clickable :selected="selected" class="core-card" @click="$emit('select', core.id)">
    <div class="core-inner">
      <div class="core-top">
        <span class="core-name">{{ core.name }}</span>
        <span v-if="core.mode" class="core-mode-badge" :class="MODE_BADGES[core.mode] || ''">{{ core.mode }}</span>
      </div>
      <span class="core-author">{{ core.author }}</span>
      <span class="core-theme">{{ core.theme }}</span>
      <p v-if="core.description" class="core-desc">{{ core.description }}</p>
    </div>
  </AppCard>
</template>

<style scoped>
.core-card {
  padding: var(--theme-spacing-md);
  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;
  border: 1px solid var(--theme-card-border);
}
.core-card:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(0,0,0,0.12);
}
.core-card.selected {
  border-color: var(--theme-quality-epic) !important;
  box-shadow: 0 0 0 1px var(--theme-quality-epic),
              0 4px 20px color-mix(in srgb, var(--theme-quality-epic) 20%, transparent);
}
.core-inner {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.core-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.core-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title, serif);
}
.core-author {
  font-size: 0.72rem;
  color: var(--theme-primary);
  font-weight: 500;
}
.core-theme {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.core-desc {
  font-size: 0.72rem;
  color: var(--theme-text-muted);
  margin: 2px 0 0;
  line-height: 1.5;
}
.core-mode-badge {
  font-size: 0.6rem;
  font-weight: 600;
  padding: 1px 7px;
  border-radius: 4px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
}
.core-mode-badge.bg-official {
  background: color-mix(in srgb, var(--theme-primary) 15%, transparent);
  color: var(--theme-primary);
}
.core-mode-badge.bg-community {
  background: color-mix(in srgb, var(--theme-success) 15%, transparent);
  color: var(--theme-success);
}
.core-mode-badge.bg-hidden {
  background: color-mix(in srgb, var(--theme-quality-mythic) 15%, transparent);
  color: var(--theme-quality-mythic);
}
</style>
