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

        <div v-else class="combat-panel" :class="{ 'is-ready': ready }">
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

            <main class="combat-command-table">
              <section
                v-if="enemies.length"
                class="combat-roster combat-roster-enemy"
                aria-labelledby="combat-enemy-label"
              >
                <div class="combat-side-plaque combat-side-plaque-enemy">
                  <span id="combat-enemy-label">敌方</span>
                  <span class="combat-side-emblem" aria-hidden="true">◇</span>
                </div>
                <div class="combat-unit-row">
                  <CombatUnitCard
                    v-for="p in enemies"
                    :key="p.id"
                    :unit="p"
                    :is-current-turn="game.combatCurrentUnitId === p.id"
                  />
                </div>
              </section>

              <section class="combat-ledger" aria-labelledby="combat-ledger-label">
                <div class="combat-ledger-heading">
                  <span id="combat-ledger-label">战斗记录</span>
                </div>
                <CombatMessageFlow :entries="game.combatLog" class="combat-flow" />
              </section>

              <section
                v-if="allies.length"
                class="combat-roster combat-roster-allies"
                aria-labelledby="combat-ally-label"
              >
                <div class="combat-side-plaque combat-side-plaque-allies">
                  <span id="combat-ally-label">我方</span>
                  <span class="combat-side-emblem" aria-hidden="true">◇</span>
                </div>
                <div class="combat-unit-row">
                  <CombatUnitCard
                    v-for="p in allies"
                    :key="p.id"
                    :unit="p"
                    :is-current-turn="game.combatCurrentUnitId === p.id"
                  />
                </div>
              </section>
            </main>

            <CombatActionBar />

            <!-- T16 §3.5：跳过 / 重开战斗（战斗内任何时候可用，不受敌方回合锁影响） -->
            <div class="combat-panel-actions">
              <span class="combat-panel-actions-label">战斗控制</span>
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
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--theme-spacing-md);
}
.combat-panel {
  --combat-inlay: color-mix(in srgb, var(--theme-primary) 38%, var(--theme-card-border));
  width: min(100%, 100rem);
  height: min(60rem, calc(100dvh - var(--theme-spacing-md) - var(--theme-spacing-md)));
  background:
    linear-gradient(
      135deg,
      color-mix(in srgb, var(--theme-primary) 5%, transparent),
      transparent 18%
    ),
    var(--theme-content-bg);
  border: 1px solid var(--combat-inlay);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--theme-shadow-lg);
  display: grid;
  grid-template-rows: auto minmax(0, 1fr) auto auto;
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
  min-height: min(36rem, calc(100dvh - var(--theme-spacing-md) - var(--theme-spacing-md)));
}

/* ── 折叠按钮（右上角；就绪态与开打态共用）── */
.combat-collapse-btn {
  position: absolute;
  top: var(--theme-spacing-sm);
  right: var(--theme-spacing-sm);
  z-index: 7;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--theme-card-bg) 88%, transparent);
  border: 1px solid var(--theme-card-border);
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
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: var(--theme-primary);
  color: var(--theme-primary);
}
.combat-collapse-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 2px;
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
  border-radius: var(--theme-radius-md);
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
  width: min(48rem, 100%);
  margin: auto;
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-2xl);
}
.combat-ready-title {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  padding-bottom: var(--theme-spacing-md);
  border-bottom: 1px solid var(--combat-inlay);
}
.combat-title-icon {
  color: var(--theme-primary);
  font-size: 1rem;
}
.combat-ready-meta {
  grid-column: 1 / -1;
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-sm);
}
.combat-ready-meta-item {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
}
.combat-ready-roster {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  box-shadow: var(--paper-stack);
}
.combat-ready-names {
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  line-height: 1.6;
}
.combat-ready-brief {
  grid-column: 1 / -1;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.7;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-md);
  background: color-mix(in srgb, var(--theme-primary) 4%, var(--theme-card-bg));
}
.combat-ready .combat-panel-actions {
  grid-column: 1 / -1;
}
.combat-side-label {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-weight: 600;
  font-family: var(--theme-font-body);
}

/* ── Command Table 主体：敌方 / 日志 / 我方 ── */
.combat-command-table {
  min-height: 0;
  padding: var(--theme-spacing-sm);
  display: grid;
  grid-template-rows: minmax(7.5rem, auto) minmax(9rem, 1fr) minmax(7.5rem, auto);
  gap: var(--theme-spacing-xs);
  overflow: auto;
  background: color-mix(in srgb, var(--theme-window-bg) 74%, var(--theme-content-bg));
}

.combat-roster {
  min-width: 0;
  display: grid;
  grid-template-columns: 6.75rem minmax(0, 1fr);
  border: 1px solid var(--combat-inlay);
  background: color-mix(in srgb, var(--theme-card-bg) 74%, var(--theme-content-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-card-border) 50%, transparent);
}

.combat-side-plaque {
  display: grid;
  place-content: center;
  justify-items: center;
  gap: var(--theme-spacing-sm);
  border: 1px solid var(--theme-card-border);
  margin: var(--theme-spacing-xs);
  font-family: var(--theme-font-title);
  font-size: 1.125rem;
  font-weight: 700;
  letter-spacing: 0.08em;
}

.combat-side-plaque-enemy {
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 8%, var(--theme-surface-muted));
  border-color: color-mix(in srgb, var(--theme-error) 42%, var(--theme-card-border));
}

.combat-side-plaque-allies {
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 7%, var(--theme-surface-muted));
  border-color: color-mix(in srgb, var(--theme-primary) 42%, var(--theme-card-border));
}

.combat-side-emblem {
  color: currentColor;
  font-size: 1rem;
  opacity: 0.35;
}
.combat-unit-row {
  display: flex;
  align-items: stretch;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  overflow-x: auto;
  scrollbar-width: thin;
}
.combat-unit-row > * {
  flex: 0 1 21rem;
  min-width: 18rem;
}

.combat-ledger {
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  border: 1px solid var(--combat-inlay);
  background: color-mix(in srgb, var(--theme-content-bg) 88%, var(--theme-card-bg));
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-card-border) 50%, transparent);
}

.combat-ledger-heading {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-sm) var(--theme-spacing-lg);
  font-family: var(--theme-font-title);
  font-size: 0.9375rem;
  font-weight: 600;
  color: var(--theme-primary);
  letter-spacing: 0.08em;
}

.combat-ledger-heading::before,
.combat-ledger-heading::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border))
  );
}

.combat-ledger-heading::after {
  background: linear-gradient(
    to left,
    transparent,
    color-mix(in srgb, var(--theme-primary) 35%, var(--theme-card-border))
  );
}
.combat-flow {
  min-height: 0;
  border-top: 1px solid var(--theme-card-border);
}

/* T16 §3.5：面板底部操作行（跳过/重开战斗） */
.combat-panel-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-lg);
  border-top: 1px solid var(--theme-card-border);
  background: var(--theme-title-bar-bg);
  flex-shrink: 0;
}

.combat-panel-actions-label {
  margin-right: auto;
  color: var(--theme-text-muted);
  font-family: var(--theme-font-body);
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
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

@media (prefers-reduced-transparency: reduce) {
  .combat-overlay {
    backdrop-filter: none;
  }

  .combat-panel,
  .combat-collapse-btn {
    background: var(--theme-content-bg);
  }
}

@media (max-height: 720px) and (min-width: 961px) {
  .combat-command-table {
    grid-template-rows: minmax(6.5rem, auto) minmax(9rem, 1fr) minmax(6.5rem, auto);
  }

  .combat-unit-row {
    padding-block: var(--theme-spacing-xs);
  }
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

  .combat-command-table {
    padding: var(--theme-spacing-xs);
  }

  .combat-roster {
    grid-template-columns: 5rem minmax(0, 1fr);
  }

  .combat-side-plaque {
    font-size: 0.9375rem;
  }

  .combat-unit-row {
    padding: var(--theme-spacing-sm);
  }

  .combat-unit-row > * {
    flex-basis: 19rem;
    min-width: 17rem;
  }
}

@media (max-width: 640px) {
  .combat-ready {
    grid-template-columns: 1fr;
    padding: var(--theme-spacing-xl) var(--theme-spacing-lg);
  }

  .combat-ready-title,
  .combat-ready-meta,
  .combat-ready-brief {
    grid-column: 1;
  }

  .combat-command-table {
    grid-template-rows: auto minmax(12rem, 1fr) auto;
  }

  .combat-roster {
    grid-template-columns: 1fr;
  }

  .combat-side-plaque {
    min-height: 2.5rem;
    grid-auto-flow: column;
    place-content: center;
    gap: var(--theme-spacing-sm);
    margin-bottom: 0;
  }

  .combat-unit-row > * {
    min-width: 15rem;
  }

  .combat-ledger-heading {
    padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  }

  .combat-panel-actions-label {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .combat-overlay-enter-active,
  .combat-overlay-leave-active,
  .combat-overlay-enter-active .combat-panel,
  .combat-overlay-leave-active .combat-panel,
  .combat-collapse-btn {
    transition: none;
  }
}
</style>
