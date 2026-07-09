<script setup lang="ts">
import { ref } from 'vue'
import type { CombatSystemEvent } from '@engine/types'

defineProps<{ event: CombatSystemEvent }>()

const expanded = ref(false)

const outcomeConfig: Record<string, { label: string; icon: string; borderColor: string }> = {
  ally_win:   { label: '胜利', icon: 'fa-solid fa-trophy', borderColor: 'var(--theme-quality-uncommon)' },
  enemy_win:  { label: '败北', icon: 'fa-solid fa-skull', borderColor: 'var(--theme-error)' },
  draw:       { label: '平局', icon: 'fa-solid fa-handshake', borderColor: 'var(--theme-warning)' },
  fled:       { label: '逃跑', icon: 'fa-solid fa-person-running', borderColor: 'var(--theme-text-muted)' },
}
</script>

<template>
  <div
    class="sys-card"
    :style="{ borderLeftColor: outcomeConfig[event.outcome]?.borderColor ?? 'var(--theme-text-muted)' }"
  >
    <div class="sys-card-header" @click="expanded = !expanded">
      <i :class="'sys-card-icon ' + (outcomeConfig[event.outcome]?.icon ?? 'fa-solid fa-hand-fist')" />
      <span class="sys-card-label">{{ outcomeConfig[event.outcome]?.label ?? event.outcome }}</span>
      <span class="sys-card-rounds">{{ event.details.rounds }} 回合</span>
    </div>
    <div v-show="expanded" class="sys-card-body">
      <div class="combat-summary">{{ event.details.narrativeSummary }}</div>
      <div v-if="event.details.loot?.length" class="combat-loot section-divider">
        <span class="section-label">
          <i class="fa-solid fa-coins" /> 战利品:
        </span>
        <span
          v-for="l in event.details.loot"
          :key="l.name"
          class="loot-chip"
        >
          {{ l.name }}<span v-if="l.quantity > 1"> ×{{ l.quantity }}</span>
        </span>
      </div>
      <div class="combat-footer section-divider">
        <span class="stat-badge">
          <i class="fa-solid fa-bolt" /> EXP +{{ event.details.totalExp }}
        </span>
        <span class="stat-badge">
          <i class="fa-solid fa-star" /> FP +{{ event.details.totalFp }}
        </span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sys-card {
  border-left: 4px solid var(--theme-text-muted);
  border-radius: 4px;
  overflow: hidden;
}

.sys-card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--theme-surface-muted);
  cursor: pointer;
  user-select: none;
}
.sys-card-header:hover {
  background: var(--theme-card-bg);
}

.sys-card-icon {
  font-size: 0.875rem;
}

.sys-card-label {
  font-weight: 700;
  font-size: 0.9375rem;
  color: var(--theme-text-primary);
}

.sys-card-rounds {
  font-size: 0.75rem;
  opacity: 0.5;
  margin-left: auto;
}

.sys-card-body {
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
}

.combat-summary {
  line-height: 1.5;
  color: var(--theme-text-primary);
}

.section-divider {
  border-top: 1px dashed var(--theme-border, rgba(255, 255, 255, 0.08));
  padding-top: 8px;
}

.combat-loot {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  align-items: center;
}

.section-label {
  font-weight: 600;
  opacity: 0.6;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  margin-right: 4px;
}

.loot-chip {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}

.combat-footer {
  display: flex;
  gap: 8px;
}

.stat-badge {
  background: var(--theme-surface-muted);
  padding: 2px 8px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  display: flex;
  align-items: center;
  gap: 4px;
}
</style>
