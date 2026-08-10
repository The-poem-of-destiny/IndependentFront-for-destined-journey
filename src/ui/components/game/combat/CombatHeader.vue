<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../../../stores/game-store';

const game = useGameStore();

const initiative = computed(() => {
  const combat = game.v3ActiveCombat;
  if (!combat) return [];
  return combat.initiativeOrder.map((id) => ({ id, unit: combat.units[id] }));
});

const activeUnitId = computed(
  () => game.combatCurrentUnitId ?? game.combatAwaitingInput?.unitId ?? null,
);
</script>

<template>
  <header class="combat-header">
    <div class="combat-title">
      <i class="fa-solid fa-hand-fist combat-title-icon" />
      <!-- v3 CombatView 无 combatType / environment 字段（开战 bundle 不投影），
           类型固定显示「战斗」，回合读 v3ActiveCombat.round -->
      <span class="combat-type">战斗</span>
      <span class="combat-round">第 {{ game.v3ActiveCombat?.round ?? 1 }} 回合</span>
    </div>

    <ol v-if="initiative.length" class="combat-initiative" aria-label="本回合行动顺序">
      <li
        v-for="(entry, index) in initiative"
        :key="entry.id"
        class="initiative-entry"
        :class="{
          'is-active': entry.id === activeUnitId,
          'is-enemy': entry.unit?.side === 'enemy',
          'is-player': entry.unit?.side === 'player',
        }"
        :aria-current="entry.id === activeUnitId ? 'step' : undefined"
      >
        <span class="initiative-marker" aria-hidden="true">
          <span>{{ index + 1 }}</span>
        </span>
        <span class="initiative-name">{{ entry.unit?.name ?? entry.id }}</span>
      </li>
    </ol>

    <div class="combat-status">
      <span v-if="game.combatAwaitingInput" class="combat-your-turn">轮到你了</span>
      <span v-else class="combat-thinking">敌方行动中…</span>
    </div>
  </header>
</template>

<style scoped>
.combat-header {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr) max-content;
  align-items: center;
  gap: var(--theme-spacing-xl);
  padding: var(--theme-spacing-md) calc(36px + var(--theme-spacing-xl)) var(--theme-spacing-md)
    var(--theme-spacing-lg);
  border-bottom: 1px solid var(--theme-card-border);
  background:
    linear-gradient(
      90deg,
      color-mix(in srgb, var(--theme-primary) 5%, transparent),
      transparent 28%,
      transparent 72%,
      color-mix(in srgb, var(--theme-primary) 4%, transparent)
    ),
    var(--theme-title-bar-bg);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--theme-primary) 18%, transparent);
}
.combat-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  color: var(--theme-text-primary);
  white-space: nowrap;
}
.combat-title-icon {
  color: var(--theme-primary);
  font-size: 1rem;
}
.combat-round {
  margin-left: var(--theme-spacing-sm);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-body);
  font-weight: 500;
}

.combat-initiative {
  min-width: 0;
  margin: 0;
  padding: 0;
  display: flex;
  align-items: flex-start;
  list-style: none;
  overflow-x: auto;
  scrollbar-width: thin;
}

.initiative-entry {
  position: relative;
  isolation: isolate;
  flex: 1 0 78px;
  min-width: 0;
  display: grid;
  justify-items: center;
  gap: var(--theme-spacing-xs);
  color: var(--theme-text-muted);
  font-family: var(--theme-font-body);
  font-size: 0.6875rem;
}

.initiative-entry::after {
  content: '';
  position: absolute;
  z-index: -1;
  top: 8px;
  left: calc(50% + 13px);
  width: calc(100% - 26px);
  height: 1px;
  background: color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
}

.initiative-entry:last-child::after {
  display: none;
}

.initiative-marker {
  width: 16px;
  height: 16px;
  display: grid;
  place-items: center;
  transform: rotate(45deg);
  border: 1px solid var(--theme-card-border);
  background: var(--theme-card-bg);
  color: var(--theme-text-muted);
  box-shadow: 0 0 0 2px var(--theme-title-bar-bg);
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    box-shadow var(--theme-transition-fast),
    color var(--theme-transition-fast);
}

.initiative-marker > span {
  transform: rotate(-45deg);
  font-size: 0.5625rem;
  line-height: 1;
}

.initiative-entry.is-enemy .initiative-marker {
  border-color: color-mix(in srgb, var(--theme-error) 65%, var(--theme-card-border));
}

.initiative-entry.is-player .initiative-marker {
  border-color: color-mix(in srgb, var(--theme-primary) 65%, var(--theme-card-border));
}

.initiative-entry.is-active {
  color: var(--theme-primary);
  font-weight: 600;
}

.initiative-entry.is-active .initiative-marker {
  color: var(--theme-primary-text);
  border-color: var(--theme-primary);
  background: var(--theme-primary);
  box-shadow:
    0 0 0 2px var(--theme-title-bar-bg),
    0 0 12px color-mix(in srgb, var(--theme-primary) 52%, transparent);
}

.initiative-name {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.combat-status {
  font-size: 0.75rem;
  font-family: var(--theme-font-body);
  text-align: right;
  white-space: nowrap;
}
.combat-your-turn {
  color: var(--theme-primary);
  font-weight: 600;
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 28%, var(--theme-card-border));
}
.combat-thinking {
  color: var(--theme-text-muted);
  font-style: italic;
}

@media (max-width: 960px) {
  .combat-header {
    grid-template-columns: 1fr max-content;
    gap: var(--theme-spacing-sm) var(--theme-spacing-lg);
  }

  .combat-initiative {
    grid-column: 1 / -1;
    grid-row: 2;
  }
}

@media (max-width: 600px) {
  .combat-header {
    padding: var(--theme-spacing-sm) calc(36px + var(--theme-spacing-lg)) var(--theme-spacing-sm)
      var(--theme-spacing-md);
  }

  .combat-title {
    font-size: 1rem;
  }

  .combat-round {
    margin-left: 0;
    font-size: 0.75rem;
  }

  .initiative-entry {
    flex-basis: 68px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .initiative-marker {
    transition: none;
  }
}
</style>
