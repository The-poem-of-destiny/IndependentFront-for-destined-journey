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

// ── F2 就绪态（combat_trigger 检出 → 就绪面板 → 点「开始战斗」才开打）──
const ready = computed(() => game.combatReady);
/** 就绪面板我方名单：player 本体 + allies（player 排头） */
const readyAllies = computed<string[]>(() => {
  const r = game.combatReady;
  if (!r) return [];
  const names = [...(r.allies ?? [])];
  const p = game.player?.name;
  if (p && !names.includes(p)) names.unshift(p);
  return names;
});
const readyEnemies = computed<string[]>(() => game.combatReady?.enemies ?? []);

function confirmStart() {
  void game.startCombat();
}

function confirmSkip() {
  skipOpen.value = false;
  game.skipCombat();
}

function confirmRestart() {
  restartOpen.value = false;
  void game.restartCombat();
}

// ── 面板折叠（收起时游戏仍锁定，留小条重新展开；主链路「就绪→开始」不依赖它）──
const collapsed = ref(false);
</script>

<template>
  <Teleport to="body">
    <Transition name="combat-overlay">
      <div v-if="game.isInCombat" class="combat-overlay">
        <!-- 折叠小条：面板收起时游戏仍锁定，靠它重新展开 -->
        <div v-if="collapsed" class="combat-collapsed-bar">
          <span class="combat-collapsed-text">战斗进行中…</span>
          <AppButton variant="secondary" size="sm" @click="collapsed = false"
            >展开战斗面板</AppButton
          >
        </div>

        <div v-else class="combat-panel">
          <button
            class="combat-collapse-btn"
            title="收起面板"
            aria-label="收起面板"
            @click="collapsed = true"
          >
            —
          </button>

          <!-- ═══ F2 就绪态：战斗还没开，显示参战方/类型/环境/起因 + 开始/跳过 ═══ -->
          <div v-if="ready" class="combat-ready">
            <div class="combat-ready-title">
              <i class="fa-solid fa-hand-fist combat-title-icon" />
              <span>战斗就绪</span>
            </div>

            <div v-if="ready.combatType || ready.environment" class="combat-ready-meta">
              <span v-if="ready.combatType" class="combat-ready-meta-item">
                类型：{{ ready.combatType }}
              </span>
              <span v-if="ready.environment" class="combat-ready-meta-item">
                环境：{{ ready.environment }}
              </span>
            </div>

            <div v-if="readyAllies.length" class="combat-ready-roster">
              <span class="combat-side-label">【我方】</span>
              <div class="combat-ready-names">{{ readyAllies.join('、') }}</div>
            </div>
            <div v-if="readyEnemies.length" class="combat-ready-roster">
              <span class="combat-side-label">【敌方】</span>
              <div class="combat-ready-names">{{ readyEnemies.join('、') }}</div>
            </div>

            <div v-if="ready.bodyText || ready.brief" class="combat-ready-brief">
              {{ ready.bodyText || ready.brief }}
            </div>

            <div class="combat-panel-actions">
              <AppButton variant="primary" size="sm" @click="confirmStart">开始战斗</AppButton>
              <AppButton variant="ghost" size="sm" @click="skipOpen = true">跳过战斗</AppButton>
            </div>
          </div>

          <!-- ═══ 开打态：现有战斗视图（CombatMessageFlow / CombatActionBar）═══ -->
          <template v-else>
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
          </template>
        </div>
      </div>
    </Transition>

    <!-- 跳过战斗确认（§3.5 原文文案；就绪态跳过同样走这里） -->
    <AppModal :open="skipOpen" title="跳过战斗" size="sm" @update:open="skipOpen = $event">
      <p class="combat-confirm-text">跳过后不会获得任何经验，但玩家可以自由编写战斗过程。</p>
      <template #footer>
        <AppButton variant="ghost" size="sm" @click="skipOpen = false">再想想</AppButton>
        <AppButton variant="primary" size="sm" @click="confirmSkip">跳过战斗</AppButton>
      </template>
    </AppModal>

    <!-- 重开战斗确认（§3.5 原文文案） -->
    <AppModal :open="restartOpen" title="重开战斗" size="sm" @update:open="restartOpen = $event">
      <p class="combat-confirm-text">重新开始本场战斗？当前战斗进度将丢弃，回到开战前状态。</p>
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
  position: relative;
}

/* ── 折叠按钮（右上角；就绪态与开打态共用）── */
.combat-collapse-btn {
  position: absolute;
  top: var(--theme-spacing-sm);
  right: var(--theme-spacing-sm);
  z-index: 5;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-muted);
  font-size: 0.875rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.combat-collapse-btn:hover {
  background: var(--theme-surface-hover, rgba(128, 128, 128, 0.15));
  border-color: var(--theme-card-border);
  color: var(--theme-text-primary);
}

/* ── 折叠小条（收起时游戏仍锁定，重新展开的入口）── */
.combat-collapsed-bar {
  position: fixed;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-lg);
  box-shadow: var(--theme-shadow-lg);
  z-index: 1001;
}
.combat-collapsed-text {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  color: var(--theme-text-primary);
}

/* ── F2 就绪态面板 ── */
.combat-ready {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-xl);
}
.combat-ready-title {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.combat-title-icon {
  color: var(--theme-primary);
  font-size: 1rem;
}
.combat-ready-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}
.combat-ready-meta-item {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary, var(--theme-text));
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
}
.combat-ready-roster {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
}
.combat-ready-names {
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  line-height: 1.6;
}
.combat-ready-brief {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary, var(--theme-text));
  line-height: 1.7;
  border-left: 0; /* 禁侧边条（design 绝对禁令）：用整圈边框 + 染底 */
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-primary) 4%, var(--theme-card-bg));
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
