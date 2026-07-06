<script setup lang="ts">
import { computed } from 'vue'
import { useGameStore } from '../../stores/game-store'

const game = useGameStore()

const outline = computed(() => game.plotOutline)
const events = computed(() => game.activePlotEvents)

const activeEvents = computed(() => events.value.filter(e => e.status === 'active'))
const pendingEvents = computed(() => events.value.filter(e => e.status === 'pending'))
</script>

<template>
  <div class="plot-panel">
    <div class="panel-title">剧情规划</div>

    <div class="section" v-if="outline">
      <div class="section-title">📖 大纲</div>
      <div class="outline-card">
        <div v-if="outline.title" class="outline-title">{{ outline.title }}</div>
        <div v-if="outline.summary" class="outline-summary">{{ outline.summary }}</div>
      </div>
    </div>

    <div class="section" v-if="activeEvents.length > 0">
      <div class="section-title">⚡ 活跃事件 ({{ activeEvents.length }})</div>
      <div v-for="ev in activeEvents" :key="ev.id" class="event-card active">
        <div class="event-title">{{ ev.title }}</div>
        <div class="event-desc" v-if="ev.description">{{ ev.description }}</div>
      </div>
    </div>

    <div class="section" v-if="pendingEvents.length > 0">
      <div class="section-title">⏳ 待触发 ({{ pendingEvents.length }})</div>
      <div v-for="ev in pendingEvents" :key="ev.id" class="event-card pending">
        <div class="event-title">{{ ev.title }}</div>
      </div>
    </div>

    <div class="empty" v-if="!outline && events.length === 0">暂无剧情数据</div>
  </div>
</template>

<style scoped>
.plot-panel { display: flex; flex-direction: column; height: 100%; padding: 8px; overflow-y: auto; gap: 10px; }
.panel-title { font-size: 0.8125rem; font-weight: 600; color: var(--theme-text-primary); }
.section-title { font-size: 0.6875rem; color: var(--theme-text-muted); text-transform: uppercase; margin-bottom: 4px; }
.outline-card { background: var(--theme-card-bg); padding: 8px; border-radius: var(--theme-radius-sm, 4px); border: 1px solid var(--theme-card-border); }
.outline-title { font-weight: 600; font-size: 0.875rem; color: var(--theme-text-primary); }
.outline-summary { font-size: 0.75rem; color: var(--theme-text-secondary); margin-top: 4px; }
.event-card { background: var(--theme-card-bg); padding: 6px 8px; border-radius: var(--theme-radius-sm, 4px); margin-bottom: 4px; }
.event-card.active { border-left: 3px solid var(--theme-success); }
.event-card.pending { border-left: 3px solid var(--theme-warning); }
.event-title { font-weight: 600; font-size: 0.8125rem; color: var(--theme-text-primary); }
.event-desc { font-size: 0.6875rem; color: var(--theme-text-secondary); margin-top: 2px; }
.empty { padding: 24px; text-align: center; color: var(--theme-text-muted); font-size: 0.8125rem; }
</style>
