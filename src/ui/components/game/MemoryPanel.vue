<script setup lang="ts">
import { computed } from 'vue'
import { useGameStore } from '../../stores/game-store'

const game = useGameStore()

const memories = computed(() => {
  return [...(game.recentMemories || [])].sort((a, b) => b.createdAt - a.createdAt)
})
</script>

<template>
  <div class="memory-panel">
    <div class="panel-title">记忆列表 ({{ memories.length }})</div>
    <div class="memory-list" v-if="memories.length > 0">
      <div v-for="mem in memories" :key="mem.id" class="memory-card">
        <div class="memory-header">
          <span class="memory-id">{{ mem.id }}</span>
          <span class="memory-importance">★{{ mem.importance || 0 }}</span>
        </div>
        <div class="memory-content">{{ mem.content?.slice(0, 200) }}{{ (mem.content?.length || 0) > 200 ? '...' : '' }}</div>
        <div class="memory-keywords" v-if="mem.keywords?.length">
          <span v-for="kw in mem.keywords.slice(0, 5)" :key="kw" class="keyword">{{ kw }}</span>
        </div>
      </div>
    </div>
    <div class="empty" v-else>暂无记忆</div>
  </div>
</template>

<style scoped>
.memory-panel { display: flex; flex-direction: column; height: 100%; padding: 8px; }
.panel-title { font-size: 0.8125rem; font-weight: 600; color: var(--theme-text-primary); margin-bottom: 8px; }
.memory-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.memory-card { background: var(--theme-card-bg); padding: 8px; border-radius: var(--theme-radius-sm, 4px); border: 1px solid var(--theme-card-border); }
.memory-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; }
.memory-id { font-size: 0.625rem; color: var(--theme-text-muted); font-family: monospace; }
.memory-importance { font-size: 0.6875rem; color: #f59e0b; }
.memory-content { font-size: 0.75rem; color: var(--theme-text-secondary); line-height: 1.5; }
.memory-keywords { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
.keyword { font-size: 0.625rem; padding: 1px 6px; background: var(--theme-surface-muted); color: var(--theme-text-muted); border-radius: 3px; }
.empty { padding: 24px; text-align: center; color: var(--theme-text-muted); font-size: 0.8125rem; }
</style>
