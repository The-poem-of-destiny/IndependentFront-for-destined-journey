<script setup lang="ts">
/**
 * CombatPanel.vue — 新战斗前端（C6）
 *
 * 数据源 = 沙盒权威 `CombatState`（`game.combatState`）。三种状态：
 *   ① 就绪态（`combatReady`）—— 类型/环境 chip + 我方/敌方名单 + 起因 + [跳过][开始]
 *   ② 战斗中（`combatState`）—— 顶部资源条 + 坐标轴站位 + 中栏对话流 + 左右单位卡 +
 *      行动规划区；右上角常驻「↺ 重开战斗」
 *   ③ 结算态（`combatSettlement`）—— 结果/回合/经验/命运点 + 战利品 + 状态结算 +
 *      「接下来做什么」输入 + [继续] / [重开战斗]
 *
 * 🔴 全部单位/技能/数值从 `CombatState` 读取（遍历 units、按 side 分阵营），组件不写死
 *    任何具体单位名/技能名/数值；集中映射见 combat-view.ts。
 */
import { computed, ref } from 'vue';
import { useGameStore } from '../../../stores/game-store';
import { useUIStore } from '../../../stores/ui-store';
import { currentActor, isAwaitingPlayer, orderedUnits } from './combat-view';
import CombatUnitCard from './CombatUnitCard.vue';
import CombatMessageFlow from './CombatMessageFlow.vue';
import CombatPositionAxis from './CombatPositionAxis.vue';
import CombatActionPlanner from './CombatActionPlanner.vue';
import CombatReadyPanel from './CombatReadyPanel.vue';
import CombatSettlementPanel from './CombatSettlementPanel.vue';
import ResourceBar from '../../shared/ResourceBar.vue';
import AppButton from '../../shared/AppButton.vue';
import AppModal from '../../shared/AppModal.vue';

const game = useGameStore();
const ui = useUIStore();

const state = computed(() => game.combatState);
const allies = computed(() => orderedUnits(state.value, 'ally'));
const enemies = computed(() => orderedUnits(state.value, 'enemy'));
const actor = computed(() => currentActor(state.value));
const awaiting = computed(() => isAwaitingPlayer(state.value));
const isThinking = computed(() => !!state.value && !awaiting.value);

const resourceRows = computed(() => {
  const unit = actor.value;
  if (!unit) return [];
  return [
    { label: 'HP', current: unit.hp, max: unit.maxHp, color: 'var(--theme-hp)' },
    { label: 'MP', current: unit.mp, max: unit.maxMp, color: 'var(--theme-mp)' },
    { label: 'SP', current: unit.sp, max: unit.maxSp, color: 'var(--theme-sp)' },
  ].filter((row) => row.max > 0 || row.current > 0);
});

const regionText = computed(() => (state.value?.meta.regions ?? []).join(' · '));

// ── 确认弹窗（跳过 / 重开）──
const skipOpen = ref(false);
const restartOpen = ref(false);

function confirmStart() {
  void game.startCombat();
}

function confirmSkip() {
  skipOpen.value = false;
  game.skipCombat();
}

async function confirmRestart() {
  restartOpen.value = false;
  const result = await game.restartCombat();
  if (result.status === 'projection-failed') {
    ui.toast(result.error, 'error');
    ui.navigate('home');
  } else if (result.status === 'rejected') {
    ui.toast(result.error, 'warning');
  } else if (result.warning) {
    ui.toast(result.warning, 'warning');
  }
}

function submitIntent(text: string) {
  void game.submitCombatIntent(text);
}

function continueSettlement(text: string) {
  game.continueCombatSettlement(text);
}
</script>

<template>
  <Teleport to="body">
    <Transition name="combat-overlay">
      <div v-if="game.isInCombat" class="combat-overlay">
        <div class="combat-panel" :class="{ 'is-ready': game.combatReady }">
          <!-- ═══ ① 就绪态 ═══ -->
          <CombatReadyPanel
            v-if="game.combatReady"
            :ready="game.combatReady"
            @start="confirmStart"
            @skip="skipOpen = true"
          />

          <!-- ═══ ③ 结算态 ═══ -->
          <CombatSettlementPanel
            v-else-if="game.combatSettlement"
            :settlement="game.combatSettlement"
            :state="state"
            @continue="continueSettlement"
            @restart="restartOpen = true"
          />

          <!-- ═══ ② 战斗中 ═══ -->
          <template v-else-if="state">
            <header class="combat-head">
              <div class="combat-title">
                <span aria-hidden="true">⚔</span>
                战斗行动 · 第 {{ state.meta.round }} 回合
              </div>
              <div class="combat-chips">
                <span class="combat-chip"
                  >类型 <b>{{ state.meta.combatType }}</b></span
                >
                <span v-if="state.meta.environment" class="combat-chip">
                  环境 <b>{{ state.meta.environment }}</b>
                </span>
                <span class="combat-chip"
                  >坐标 <b>0 ~ {{ state.meta.coordinateRange }}</b></span
                >
                <span v-if="regionText" class="combat-chip"
                  >区域 <b>{{ regionText }}</b></span
                >
              </div>
              <div class="head-spacer" />
              <button class="restart-btn" @click="restartOpen = true">↺ 重开战斗</button>
            </header>

            <!-- 顶部资源条（当前行动单位） -->
            <div v-if="resourceRows.length" class="resbar">
              <span class="resbar-name">{{ actor?.name }}</span>
              <ResourceBar
                v-for="row in resourceRows"
                :key="row.label"
                :label="row.label"
                :current="row.current"
                :max="row.max"
                :color="row.color"
                show-values
              />
            </div>

            <CombatPositionAxis :state="state" />

            <main class="combat-grid">
              <section class="combat-col" aria-label="我方">
                <div class="side-title">我方</div>
                <CombatUnitCard
                  v-for="unit in allies"
                  :key="unit.name"
                  :unit="unit"
                  :is-current="unit.name === actor?.name"
                />
              </section>

              <CombatMessageFlow
                class="combat-flow"
                :state="state"
                :flow="game.combatFlow"
                :is-thinking="isThinking"
              />

              <section class="combat-col" aria-label="敌方">
                <div class="side-title">敌方</div>
                <CombatUnitCard
                  v-for="unit in enemies"
                  :key="unit.name"
                  :unit="unit"
                  :is-current="unit.name === actor?.name"
                />
              </section>
            </main>

            <CombatActionPlanner v-if="awaiting" :state="state" @submit="submitIntent" />
            <div v-else class="combat-waiting">敌方行动中…</div>
          </template>
        </div>
      </div>
    </Transition>

    <!-- 跳过战斗确认 -->
    <AppModal :open="skipOpen" title="跳过战斗" size="sm" @update:open="skipOpen = $event">
      <p class="combat-confirm-text">跳过后不会获得任何经验，但玩家可以自由编写战斗过程。</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="skipOpen = false">再想想</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmSkip">跳过战斗</AppButton>
      </template>
    </AppModal>

    <!-- 重开战斗确认 -->
    <AppModal :open="restartOpen" title="重开战斗" size="sm" @update:open="restartOpen = $event">
      <p class="combat-confirm-text">
        将回到<b>开战前</b>的状态并重新开始本场战斗。本场战斗中已发生的所有变化（HP/MP/SP、状态、战利品、经验）都会被撤销。
      </p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="restartOpen = false">取消</AppButton>
        <AppButton variant="danger" size="sm" @click="confirmRestart">确认重开</AppButton>
      </template>
    </AppModal>
  </Teleport>
</template>

<style scoped>
.combat-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--theme-spacing-md);
}
.combat-panel {
  --combat-inlay: color-mix(in srgb, var(--theme-primary) 38%, var(--theme-card-border));
  width: min(100%, 92rem);
  height: min(60rem, calc(100dvh - var(--theme-spacing-md) * 2));
  background: var(--theme-content-bg);
  border: 1px solid var(--combat-inlay);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--theme-shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  isolation: isolate;
}
.combat-panel::before,
.combat-panel::after {
  content: '';
  position: absolute;
  z-index: 6;
  width: var(--theme-spacing-xl);
  height: var(--theme-spacing-xl);
  pointer-events: none;
}
.combat-panel::before {
  top: var(--theme-spacing-xs);
  left: var(--theme-spacing-xs);
  border-top: 1px solid var(--theme-primary);
  border-left: 1px solid var(--theme-primary);
}
.combat-panel::after {
  right: var(--theme-spacing-xs);
  bottom: var(--theme-spacing-xs);
  border-right: 1px solid var(--theme-primary);
  border-bottom: 1px solid var(--theme-primary);
}
.combat-panel.is-ready {
  display: flex;
  height: auto;
  min-height: min(36rem, calc(100dvh - var(--theme-spacing-md) * 2));
}

/* ── 头部 ── */
.combat-head {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-md) var(--theme-spacing-xl);
  border-bottom: 1px solid var(--theme-card-border);
  background: var(--theme-title-bar-bg);
  flex-shrink: 0;
}
.combat-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  letter-spacing: 0.06em;
  color: var(--theme-primary);
  white-space: nowrap;
}
.combat-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}
.combat-chip {
  font-size: 0.75rem;
  padding: 2px 10px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
  color: var(--theme-text-muted);
  background: color-mix(in srgb, var(--theme-card-bg) 60%, transparent);
}
.combat-chip b {
  color: var(--theme-text-primary);
  font-weight: 600;
}
.head-spacer {
  flex: 1;
}
.restart-btn {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.75rem;
  padding: 4px 12px;
  border: 1px solid color-mix(in srgb, var(--theme-error) 55%, var(--theme-card-border));
  color: var(--theme-error);
  border-radius: var(--theme-radius-full);
  background: color-mix(in srgb, var(--theme-error) 10%, transparent);
  cursor: pointer;
  font-family: inherit;
  transition: background var(--theme-transition-fast);
}
.restart-btn:hover {
  background: color-mix(in srgb, var(--theme-error) 18%, transparent);
}

/* ── 顶部资源条 ── */
.resbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-xl);
  border-bottom: 1px solid var(--theme-card-border);
  background: color-mix(in srgb, var(--theme-window-bg) 50%, transparent);
  flex-shrink: 0;
}
.resbar-name {
  flex: none;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-primary);
  min-width: 5em;
}
.resbar :deep(.resource-bar) {
  flex: 1;
}

/* ── 三栏 ── */
.combat-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 20rem minmax(0, 1fr) 20rem;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
}
.combat-col {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  overflow-y: auto;
  padding-right: 2px;
  scrollbar-width: thin;
}
.side-title {
  position: sticky;
  top: 0;
  z-index: 1;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.08em;
  background: var(--theme-content-bg);
  padding: 2px 0 6px;
}
.combat-flow {
  min-height: 0;
}

.combat-waiting {
  flex-shrink: 0;
  padding: var(--theme-spacing-md);
  text-align: center;
  font-size: 0.8125rem;
  color: var(--theme-text-muted);
  font-style: italic;
  border-top: 1px solid var(--theme-card-border);
}

.combat-confirm-text {
  margin: 0;
  color: var(--theme-text-primary);
  line-height: 1.7;
  font-size: 0.9rem;
}
.combat-confirm-text b {
  color: var(--theme-warning);
}

/* 入场过渡 */
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

@media (max-width: 960px) {
  .combat-overlay {
    padding: 0;
  }
  .combat-panel,
  .combat-panel.is-ready {
    width: 100%;
    height: 100dvh;
    max-height: none;
    border-radius: 0;
    border-top: 0;
    border-bottom: 0;
  }
  .combat-grid {
    grid-template-columns: minmax(0, 1fr);
    overflow-y: auto;
  }
  .combat-col {
    overflow: visible;
  }
}

@media (prefers-reduced-motion: reduce) {
  .combat-overlay-enter-active,
  .combat-overlay-leave-active,
  .combat-overlay-enter-active .combat-panel,
  .combat-overlay-leave-active .combat-panel,
  .restart-btn {
    transition: none;
  }
}
</style>
