<script setup lang="ts">
import type { ItemGenSystemEvent } from '@engine/types'
defineProps<{ event: ItemGenSystemEvent }>()

const qualityColors: Record<string, string> = {
  '普通': '#c4cad3', '优良': '#7be495', '稀有': '#62bbff',
  '史诗': '#cf95ff', '传说': '#ffc46b', '神话': '#ff78c5', '唯一': '#00ffff',
}
</script>

<template>
  <div class="item-card">
    <div class="card-top" :style="{ borderColor: qualityColors[event.quality] || '#c4cad3' }">
      <span class="item-type">{{ event.itemType === '装备' ? '🗡️' : event.itemType === '技能' ? '✨' : '🎒' }}</span>
      <span class="item-name">{{ event.itemName }}</span>
      <span class="item-quality" :style="{ color: qualityColors[event.quality] || '#c4cad3' }">{{ event.quality }}</span>
    </div>
    <div v-if="event.details.equipment?.length" class="card-body">
      <div v-for="eq in event.details.equipment" :key="eq.name" class="equip-line">
        <span class="equip-slot">{{ eq.slot }}</span>
        <span>{{ eq.description?.slice(0, 120) }}</span>
      </div>
    </div>
    <div v-if="event.details.skills?.length" class="card-body">
      <div v-for="sk in event.details.skills" :key="sk.name" class="skill-line">
        <span class="skill-name">{{ sk.name }}</span>
        <span>{{ sk.description?.slice(0, 120) }}</span>
      </div>
    </div>
    <div v-if="event.details.inventory?.length" class="card-body">
      <div v-for="inv in event.details.inventory" :key="inv.name" class="inv-line">
        <span>{{ inv.name }} ×{{ inv.quantity }}</span>
        <span class="inv-desc" v-if="inv.description">: {{ inv.description.slice(0, 100) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.item-card { border-radius: 6px; overflow: hidden; }
.card-top { padding: 8px 12px; border-left: 4px solid; background: var(--theme-surface-muted); display: flex; align-items: center; gap: 8px; }
.item-name { font-weight: 700; font-size: 0.875rem; }
.item-quality { font-size: 0.75rem; font-weight: 600; }
.item-type { font-size: 0.75rem; }
.card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; font-size: 0.8125rem; }
.equip-line, .skill-line, .inv-line { display: flex; gap: 8px; align-items: baseline; }
.equip-slot { background: var(--theme-primary); color: #fff; padding: 1px 6px; border-radius: 3px; font-size: 0.625rem; font-weight: 600; }
.skill-name { color: #90cdf4; font-weight: 600; }
.inv-desc { opacity: 0.6; font-size: 0.75rem; }
</style>
