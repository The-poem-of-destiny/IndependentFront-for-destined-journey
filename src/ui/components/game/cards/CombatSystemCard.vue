<script setup lang="ts">
import type { CombatSystemEvent } from '@engine/types'
defineProps<{ event: CombatSystemEvent }>()

const labels: Record<string, string> = { ally_win: '胜利', enemy_win: '败北', draw: '平局', fled: '逃跑' }
const icons: Record<string, string> = { ally_win: '🏆', enemy_win: '💀', draw: '🤝', fled: '🏃' }
</script>

<template>
  <div class="combat-card">
    <div class="card-top">
      <span class="combat-icon">{{ icons[event.outcome] ?? '⚔️' }}</span>
      <span class="combat-label">{{ labels[event.outcome] ?? event.outcome }}</span>
      <span class="combat-rounds">{{ event.details.rounds }} 回合</span>
    </div>
    <div class="card-body">
      <div class="combat-summary">{{ event.details.narrativeSummary }}</div>
      <div v-if="event.details.loot?.length" class="combat-loot">
        <span class="loot-label">战利品:</span>
        <span v-for="l in event.details.loot" :key="l.name" class="loot-item">
          {{ l.name }}<span v-if="l.quantity > 1">×{{ l.quantity }}</span>
        </span>
      </div>
      <div class="combat-footer">
        <span class="stat-badge">EXP +{{ event.details.totalExp }}</span>
        <span class="stat-badge">FP +{{ event.details.totalFp }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.combat-card { border-radius: 6px; overflow: hidden; }
.card-top { padding: 8px 12px; background: var(--theme-surface-muted); display: flex; align-items: center; gap: 8px; }
.combat-icon { font-size: 1.125rem; }
.combat-label { font-weight: 700; font-size: 0.9375rem; color: var(--theme-text-primary); }
.combat-rounds { font-size: 0.75rem; opacity: 0.5; margin-left: auto; }
.card-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; font-size: 0.8125rem; }
.combat-summary { line-height: 1.5; color: var(--theme-text-primary); }
.combat-loot { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.loot-label { font-weight: 600; opacity: 0.6; font-size: 0.75rem; }
.loot-item { background: var(--theme-surface-muted); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; }
.combat-footer { display: flex; gap: 8px; }
.stat-badge { background: var(--theme-surface-muted); padding: 2px 8px; border-radius: 4px; font-size: 0.75rem; font-weight: 600; }
</style>
