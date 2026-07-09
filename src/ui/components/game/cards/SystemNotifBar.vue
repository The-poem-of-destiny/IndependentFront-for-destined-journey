<script setup lang="ts">
import type { CharacterUpdateEvent, ItemUpdateEvent, QuestUpdateEvent } from '@engine/types'
defineProps<{ event: CharacterUpdateEvent | ItemUpdateEvent | QuestUpdateEvent }>()
</script>

<template>
  <div class="notif-bar">
    <span class="notif-icon">ℹ️</span>
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
.notif-icon { font-size: 0.875rem; opacity: 0.6; }
</style>
