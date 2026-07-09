<script setup lang="ts">
import type { CharacterUpdateEvent, ItemUpdateEvent, QuestUpdateEvent } from '@engine/types'
const props = defineProps<{ event: CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent }>()

function notifIcon(): string {
  if (props.event.type === 'character_update') return 'fa-solid fa-arrow-trend-up'
  if (props.event.type === 'item_update') return 'fa-solid fa-boxes-stacked'
  if (props.event.type === 'quest_update') return 'fa-solid fa-list-check'
  return 'fa-solid fa-circle-info'
}
</script>

<template>
  <div class="notif-bar">
    <i :class="'notif-icon ' + notifIcon()" />
    <span>{{ event.narrative }}</span>
  </div>
</template>

<style scoped>
.notif-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.notif-icon { font-size: 0.75rem; opacity: 0.6; width: 1rem; text-align: center; }
</style>
