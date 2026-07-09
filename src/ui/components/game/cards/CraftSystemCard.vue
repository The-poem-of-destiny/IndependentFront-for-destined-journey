<script setup lang="ts">
import type { CraftSystemEvent } from '@engine/types'

defineProps<{ event: CraftSystemEvent }>()

const qualityColors: Record<string, string> = {
  '普通': '#c4cad3', '优良': '#7be495', '稀有': '#62bbff',
  '史诗': '#cf95ff', '传说': '#ffc46b', '神话': '#ff78c5', '唯一': '#00ffff',
}

const ratingIcons: Record<string, string> = {
  '大失败': '❌', '失败': '⚠️', '成功': '✅', '精益求精': '⭐',
}
</script>

<template>
  <div class="craft-card">
    <div class="card-top" :style="{ background: qualityColors[event.quality] || '#c4cad3' }">
      <span class="card-icon">🛠️</span>
      <span class="card-label">{{ event.quality }} · {{ event.productName }}</span>
    </div>
    <div class="card-body">
      <div class="craft-summary">
        {{ ratingIcons[event.rating] }} {{ event.rating }}
        <span v-if="event.details.checkSummary" class="check-detail">
          — {{ event.details.checkSummary }}
        </span>
      </div>
      <div v-if="event.details.craftParams?.materials" class="craft-materials">
        <span class="label">材料:</span> {{ event.details.craftParams.materials }}
      </div>
      <div v-if="event.details.itemRequests?.length" class="craft-effects">
        <div v-for="req in event.details.itemRequests" :key="req.quality + req.type" class="craft-req">
          <span class="req-type">{{ req.type === 'equipment' ? '🗡️' : '🎒' }}</span>
          <span>{{ req.quality }} {{ req.type === 'equipment' ? '装备' : '物品' }}</span>
          <span class="req-desc" v-if="req.description">: {{ req.description.slice(0, 80) }}</span>
        </div>
      </div>
      <div class="craft-footer">
        <span v-if="event.details.craftParams?.expGained" class="stat-badge">EXP +{{ event.details.craftParams.expGained }}</span>
        <span v-if="event.details.craftParams?.fpGained" class="stat-badge">FP +{{ event.details.craftParams.fpGained }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.craft-card { border-radius: 6px; overflow: hidden; }
.card-top { padding: 8px 12px; font-weight: 600; font-size: 0.875rem; color: #1a1a2e; display: flex; align-items: center; gap: 8px; }
.card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 0.8125rem; color: var(--theme-text-primary); }
.craft-summary { font-weight: 600; }
.check-detail { font-weight: 400; opacity: 0.7; }
.craft-materials .label { font-weight: 600; opacity: 0.6; margin-right: 4px; }
.craft-effects { display: flex; flex-direction: column; gap: 4px; }
.craft-req { display: flex; align-items: center; gap: 6px; font-size: 0.8125rem; }
.req-type { font-size: 0.75rem; }
.req-desc { opacity: 0.65; font-size: 0.75rem; }
.craft-footer { display: flex; gap: 8px; margin-top: 4px; }
.stat-badge { background: var(--theme-surface-muted); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
</style>
