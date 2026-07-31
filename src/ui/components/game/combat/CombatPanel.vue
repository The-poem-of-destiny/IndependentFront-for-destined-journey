<script setup lang="ts">
import { computed } from 'vue';
import { useGameStore } from '../../../stores/game-store';
import type { CombatParticipant } from '@engine/types';
import CombatHeader from './CombatHeader.vue';
import CombatUnitCard from './CombatUnitCard.vue';
import CombatMessageFlow from './CombatMessageFlow.vue';
import CombatActionBar from './CombatActionBar.vue';

const game = useGameStore();

const enemies = computed<CombatParticipant[]>(
  () => game.activeCombat?.participants.filter((p) => p.side === 'enemy') ?? [],
);
const allies = computed<CombatParticipant[]>(
  () => game.activeCombat?.participants.filter((p) => p.side === 'ally') ?? [],
);
</script>

<template>
  <Teleport to="body">
    <Transition name="combat-overlay">
      <div v-if="game.isInCombat" class="combat-overlay">
        <div class="combat-panel">
          <CombatHeader />

          <div v-if="enemies.length" class="combat-units combat-enemies">
            <span class="combat-side-label">【敌方】</span>
            <div class="combat-unit-row">
              <CombatUnitCard
                v-for="p in enemies"
                :key="p.characterId"
                :participant="p"
                :is-current-turn="game.combatCurrentUnitId === p.characterId"
              />
            </div>
          </div>

          <CombatMessageFlow :entries="game.combatLog" class="combat-flow" />

          <div v-if="allies.length" class="combat-units combat-allies">
            <span class="combat-side-label">【我方】</span>
            <div class="combat-unit-row">
              <CombatUnitCard
                v-for="p in allies"
                :key="p.characterId"
                :participant="p"
                :is-current-turn="game.combatCurrentUnitId === p.characterId"
              />
            </div>
          </div>

          <CombatActionBar />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.combat-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--theme-overlay-bg, rgba(0, 0, 0, 0.7));
  backdrop-filter: blur(4px);
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: var(--theme-spacing-lg);
}
.combat-panel {
  width: 100%;
  max-width: 1100px;
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-xl);
  box-shadow: var(--theme-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.combat-units {
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  border-bottom: 1px solid var(--theme-card-border);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
}
.combat-side-label {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-weight: 600;
  font-family: system-ui, sans-serif;
}
.combat-unit-row {
  display: flex;
  gap: var(--theme-spacing-sm);
  overflow-x: auto;
}
.combat-unit-row > * {
  flex: 1 1 220px;
  min-width: 220px;
}
.combat-flow {
  flex: 1;
  min-height: 0;
}

/* 入场过渡：fade + scale（design §6.2，禁布局属性过渡） */
.combat-overlay-enter-active,
.combat-overlay-leave-active {
  transition: opacity 0.25s ease;
}
.combat-overlay-enter-from,
.combat-overlay-leave-to {
  opacity: 0;
}
.combat-overlay-enter-active .combat-panel,
.combat-overlay-leave-active .combat-panel {
  transition: transform 0.25s ease;
}
.combat-overlay-enter-from .combat-panel,
.combat-overlay-leave-to .combat-panel {
  transform: scale(0.97);
}
@media (prefers-reduced-motion: reduce) {
  .combat-overlay-enter-active,
  .combat-overlay-leave-active,
  .combat-overlay-enter-active .combat-panel,
  .combat-overlay-leave-active .combat-panel {
    transition: none;
  }
}
</style>
