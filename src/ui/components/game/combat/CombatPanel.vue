<script setup lang="ts">
import { computed, ref } from 'vue';
import { useGameStore } from '../../../stores/game-store';
import { projectUnitsBySide, type V3Unit } from './combat-v3-projection';
import CombatHeader from './CombatHeader.vue';
import CombatUnitCard from './CombatUnitCard.vue';
import CombatMessageFlow from './CombatMessageFlow.vue';
import CombatActionBar from './CombatActionBar.vue';
import AppModal from '../../shared/AppModal.vue';
import AppButton from '../../shared/AppButton.vue';

const game = useGameStore();

// 🆕 v3 数据源（设计 §3.1 决策 A2）：从 v3ActiveCombat.units 字典按
// initiativeOrder + side 投影成有序数组，原生吃 v3 形状，不写 v3→v2 适配层。
const enemies = computed<V3Unit[]>(() => projectUnitsBySide(game.v3ActiveCombat, 'enemy'));
const allies = computed<V3Unit[]>(() => projectUnitsBySide(game.v3ActiveCombat, 'player'));

// ── T16 §3.5 跳过/重开战斗：确认弹窗（文案照设计 §3.5 原文）──
const skipOpen = ref(false);
const restartOpen = ref(false);

function confirmSkip() {
  skipOpen.value = false;
  game.skipCombat();
}

function confirmRestart() {
  restartOpen.value = false;
  void game.restartCombat();
}
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
                :key="p.id"
                :unit="p"
                :is-current-turn="game.combatCurrentUnitId === p.id"
              />
            </div>
          </div>

          <CombatMessageFlow :entries="game.combatLog" class="combat-flow" />

          <div v-if="allies.length" class="combat-units combat-allies">
            <span class="combat-side-label">【我方】</span>
            <div class="combat-unit-row">
              <CombatUnitCard
                v-for="p in allies"
                :key="p.id"
                :unit="p"
                :is-current-turn="game.combatCurrentUnitId === p.id"
              />
            </div>
          </div>

          <CombatActionBar />

          <!-- T16 §3.5：跳过 / 重开战斗（战斗内任何时候可用，不受敌方回合锁影响） -->
          <div class="combat-panel-actions">
            <AppButton variant="ghost" size="sm" @click="skipOpen = true">跳过战斗</AppButton>
            <AppButton variant="ghost" size="sm" @click="restartOpen = true">重开战斗</AppButton>
          </div>
        </div>
      </div>
    </Transition>

    <!-- 跳过战斗确认（§3.5 原文文案） -->
    <AppModal :open="skipOpen" title="跳过战斗" size="sm" @update:open="skipOpen = $event">
      <p class="combat-confirm-text">跳过后不会获得任何经验，但玩家可以自由编写战斗过程。</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="skipOpen = false">再想想</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmSkip">跳过战斗</AppButton>
      </template>
    </AppModal>

    <!-- 重开战斗确认（§3.5 原文文案） -->
    <AppModal :open="restartOpen" title="重开战斗" size="sm" @update:open="restartOpen = $event">
      <p class="combat-confirm-text">
        重新开始本场战斗？当前战斗进度将丢弃，回到开战前状态。
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="restartOpen = false">再想想</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmRestart">重新开始</AppButton>
      </template>
    </AppModal>
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

/* T16 §3.5：面板底部操作行（跳过/重开战斗） */
.combat-panel-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-lg);
  border-top: 1px solid var(--theme-card-border);
  background: var(--theme-bg-secondary, var(--theme-card-bg));
  flex-shrink: 0;
}

.combat-confirm-text {
  margin: 0;
  color: var(--theme-text-primary);
  line-height: 1.6;
  font-size: 0.9rem;
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
