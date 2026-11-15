<script setup lang="ts">
import type { SystemEvent } from '@engine/types/types';
const props = defineProps<{ event: SystemEvent }>();

function notifIcon(): string {
  if (props.event.type === 'character_update') return 'fa-solid fa-arrow-trend-up';
  if (props.event.type === 'item_update') return 'fa-solid fa-boxes-stacked';
  if (props.event.type === 'quest_update') return 'fa-solid fa-list-check';
  if (props.event.type === 'plugin_note') return 'fa-solid fa-puzzle-piece';
  return 'fa-solid fa-circle-info';
}
</script>

<template>
  <!-- 插件通知：名字与正文都是第三方文本，只走插值（纯文本），不拼进 narrative 渲染 -->
  <div v-if="event.type === 'plugin_note'" class="notif-bar notif-plugin">
    <i :class="'notif-icon ' + notifIcon()" />
    <span class="notif-plugin-name">{{ event.pluginName }}</span>
    <span class="notif-plugin-text">{{ event.text }}</span>
  </div>
  <div v-else class="notif-bar">
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
.notif-icon {
  font-size: 0.75rem;
  opacity: 0.6;
  width: 1rem;
  text-align: center;
}
.notif-plugin-name {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.notif-plugin-text {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
</style>
