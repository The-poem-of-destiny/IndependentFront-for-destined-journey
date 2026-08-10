<script setup lang="ts">
import { useGameStore } from '../../../stores/game-store';

const game = useGameStore();
</script>

<template>
  <div class="combat-header">
    <div class="combat-title">
      <i class="fa-solid fa-hand-fist combat-title-icon" />
      <!-- v3 CombatView 无 combatType / environment 字段（开战 bundle 不投影），
           类型固定显示「战斗」，回合读 v3ActiveCombat.round -->
      <span class="combat-type">战斗</span>
      <span class="combat-round">第 {{ game.v3ActiveCombat?.round ?? 1 }} 回合</span>
    </div>
    <div class="combat-status">
      <span v-if="game.combatAwaitingInput" class="combat-your-turn">轮到你了</span>
      <span v-else class="combat-thinking">敌方行动中…</span>
    </div>
  </div>
</template>

<style scoped>
.combat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  border-bottom: 1px solid var(--theme-card-border);
  background: var(--theme-card-bg);
}
.combat-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  color: var(--theme-text-primary);
}
.combat-title-icon {
  color: var(--theme-primary);
  font-size: 0.875rem;
}
.combat-round {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-family: system-ui, sans-serif;
}
.combat-status {
  font-size: 0.75rem;
  font-family: system-ui, sans-serif;
}
.combat-your-turn {
  color: var(--theme-primary);
  font-weight: 600;
  padding: 3px var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
}
.combat-thinking {
  color: var(--theme-text-muted);
  font-style: italic;
}
</style>
