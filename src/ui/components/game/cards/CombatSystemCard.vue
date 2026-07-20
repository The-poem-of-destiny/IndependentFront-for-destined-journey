<script setup lang="ts">
import type { CombatSystemEvent } from '@engine/types'

defineProps<{ event: CombatSystemEvent }>()
const emit = defineEmits<{ collapse: [] }>()

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
    :style="{ '--sys-accent': outcomeConfig[event.outcome]?.borderColor ?? 'var(--theme-text-muted)' }"
  >
    <div class="sys-card-header" @click="emit('collapse')">
      <span class="sys-card-dot" />
      <i :class="'sys-card-icon ' + (outcomeConfig[event.outcome]?.icon ?? 'fa-solid fa-hand-fist')" />
      <span class="sys-card-label">{{ outcomeConfig[event.outcome]?.label ?? event.outcome }}</span>
      <span class="sys-card-rounds">{{ event.details.rounds }} 回合</span>
      <i class="fa-solid fa-chevron-up sys-card-collapse" title="收起" />
    </div>
    <div class="sys-card-body">
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

<style>
@import '../../../styles/cards-shared.css';
</style>

<style scoped>
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

/* Override collapse chevron with extra margin */
.sys-card-collapse {
  margin-left: 4px;
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

/* Combat has its own section-label override with margin-right */
.section-label {
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
</style>
