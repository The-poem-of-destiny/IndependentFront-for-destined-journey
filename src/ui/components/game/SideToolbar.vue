<script setup lang="ts">
import { useGameStore } from '../../stores/game-store'

const game = useGameStore()

const emit = defineEmits<{
  toolClick: [id: string]
}>()

const tools = [
  { id: 'items', label: '背包', icon: 'fa-solid fa-box' },
  { id: 'characters', label: '角色', icon: 'fa-solid fa-users' },
  { id: 'quests', label: '任务', icon: 'fa-solid fa-scroll' },
  { id: 'plot', label: '剧情', icon: 'fa-solid fa-book' },
  { id: 'map', label: '地图', icon: 'fa-solid fa-map' },
  { id: 'memory', label: '记忆', icon: 'fa-solid fa-brain' },
  { id: 'snapshots', label: '快照', icon: 'fa-solid fa-camera' },
  { id: 'settings', label: '设置', icon: 'fa-solid fa-gear' },
]

function handleClick(id: string) {
  emit('toolClick', id)
}
</script>

<template>
  <nav class="side-toolbar" :class="{ collapsed: game.sidebarCollapsed }">
    <button
      v-for="tool in tools"
      :key="tool.id"
      class="tool-btn"
      :title="tool.label"
      @click="handleClick(tool.id)"
    >
      <i :class="tool.icon" />
      <span class="tool-label" v-show="!game.sidebarCollapsed">{{ tool.label }}</span>
    </button>
    <button class="collapse-toggle" @click="game.toggleSidebar()" title="折叠">
      {{ game.sidebarCollapsed ? '▶' : '◀' }}
    </button>
  </nav>
</template>

<style scoped>
.side-toolbar {
  display: flex;
  flex-direction: column;
  width: 8.75rem;
  flex-shrink: 0;
  background: var(--theme-tab-bar-bg);
  border-right: 1px solid var(--theme-card-border);
  padding: 24px 0 8px;
  gap: 4px;
  overflow-y: auto;
  transition: width 150ms;
}
.side-toolbar.collapsed {
  width: 2.75rem;
}
.tool-btn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border: none;
  background: none;
  color: var(--theme-tab-text);
  font-size: 0.875rem;
  cursor: pointer;
  font-family: inherit;
  text-align: left;
  border-radius: 6px;
  margin: 0 6px;
  transition: background 100ms, color 100ms;
}
.tool-btn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-tab-active-text);
}
.tool-btn i {
  width: 1.25rem;
  text-align: center;
  font-size: 1rem;
  flex-shrink: 0;
}
.tool-label {
  white-space: nowrap;
  overflow: hidden;
}
.collapse-toggle {
  margin: auto 6px 0;
  padding: 10px;
  border: none;
  border-top: 1px solid var(--theme-card-border);
  background: none;
  color: var(--theme-text-muted);
  cursor: pointer;
  font-size: 0.75rem;
  font-family: inherit;
}
.collapse-toggle:hover {
  color: var(--theme-text-secondary);
}
</style>
