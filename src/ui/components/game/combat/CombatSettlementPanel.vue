<script setup lang="ts">
/**
 * CombatSettlementPanel.vue — 战斗结算态（C6）
 *
 * 终局落库后展示：结果标题 + 战斗回合/经验/命运点 + 战利品 + 状态结算（我方存留单位
 * 的最终资源与状态）。玩家在「接下来做什么」输入框写下一回合行动，点 [继续] 落定并
 * 续写正文；或点 [重开战斗] 撤销本场、回到开战前重开。
 *
 * 数据 = 结算载荷（pipeline 传）+ 权威 `CombatState`（结算那一刻的最终态）。
 */
import { computed, ref } from 'vue';
import type { CombatState } from '@engine/combat/sandbox/types';
import type { CombatSettlementPayload } from '../../../stores/game-store';
import { COMBAT_OUTCOME_LABELS, orderedUnits, statusViewsOf } from './combat-view';
import { qualityVar } from '../../../lib/quality-colors';
import AppButton from '../../shared/AppButton.vue';

const props = defineProps<{
  settlement: CombatSettlementPayload;
  state: CombatState | null;
}>();

const emit = defineEmits<{ continue: [text: string]; restart: [] }>();

const draft = ref('');

const outcomeLabel = computed(
  () => COMBAT_OUTCOME_LABELS[props.settlement.outcome] ?? props.settlement.outcome,
);
const isWin = computed(() => props.settlement.outcome === 'ally_win');

/** 我方存留单位的最终资源（状态结算） */
const survivors = computed(() => {
  if (!props.state) return [];
  return orderedUnits(props.state, 'ally').map((u) => ({
    name: u.name,
    alive: u.alive,
    hp: u.hp,
    maxHp: u.maxHp,
    mp: u.mp,
    maxMp: u.maxMp,
    sp: u.sp,
    maxSp: u.maxSp,
    statuses: statusViewsOf(u).map((s) => s.name),
  }));
});

function submit() {
  const text = draft.value.trim();
  if (!text) return;
  emit('continue', text);
}
</script>

<template>
  <div class="combat-settlement">
    <div class="settle-head">
      <span class="settle-title" :class="{ win: isWin }">
        <i class="fa-solid fa-flag-checkered" /> 战斗结算 — {{ outcomeLabel }}
      </span>
      <span class="settle-chips">
        <span class="combat-chip"
          >回合 <b>{{ settlement.rounds }}</b></span
        >
        <span class="combat-chip"
          >经验 <b>+{{ settlement.totalExp }}</b></span
        >
      </span>
    </div>

    <div class="stat-grid">
      <div class="stat-cell">
        <div class="sc-label">战斗回合</div>
        <div class="sc-value">{{ settlement.rounds }}</div>
      </div>
      <div class="stat-cell">
        <div class="sc-label">获得经验</div>
        <div class="sc-value exp">+{{ settlement.totalExp }}</div>
      </div>
      <div class="stat-cell">
        <div class="sc-label">命运点数</div>
        <div class="sc-value fp">{{ settlement.totalFp }}</div>
      </div>
    </div>

    <div class="loot-box">
      <div class="lb-title">战利品</div>
      <template v-if="settlement.loot.length">
        <div v-for="(item, i) in settlement.loot" :key="i" class="loot-line">
          <span v-if="item.quality" class="q" :style="{ color: qualityVar(item.quality) }"
            >◆{{ item.quality }}</span
          >
          {{ item.name }} ×{{ item.quantity }}
        </div>
      </template>
      <div v-else class="loot-empty">（无记录）</div>
    </div>

    <div v-if="survivors.length" class="status-change">
      <div class="sc-title">状态结算</div>
      <div v-for="s in survivors" :key="s.name" class="sc-line">
        <span class="sc-name">{{ s.name }}</span>
        <span v-if="s.alive" class="sc-body">
          生命 {{ s.hp }}/{{ s.maxHp }} · 法力 {{ s.mp }}/{{ s.maxMp }} · 体力 {{ s.sp }}/{{
            s.maxSp
          }}
          <template v-if="s.statuses.length"> · {{ s.statuses.join('、') }}</template>
        </span>
        <span v-else class="sc-body is-down">已倒下</span>
      </div>
    </div>

    <div class="next-row">
      <textarea
        v-model="draft"
        class="next-input"
        rows="2"
        placeholder="战斗结束了。接下来你打算做什么？（例如：搜刮一下尸体，然后继续赶路）"
      />
      <AppButton variant="primary" size="md" :disabled="!draft.trim()" @click="submit">
        继续
      </AppButton>
    </div>

    <div class="settle-actions">
      <AppButton variant="danger" size="sm" @click="emit('restart')">重开战斗</AppButton>
    </div>
  </div>
</template>

<style scoped>
.combat-settlement {
  width: min(48rem, 100%);
  margin: auto;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  padding: var(--theme-spacing-2xl);
}
.settle-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
.settle-title {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  font-family: var(--theme-font-title);
  font-size: 1.35rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.settle-title.win {
  color: var(--theme-success);
}
.settle-chips {
  display: flex;
  gap: var(--theme-spacing-sm);
}
.combat-chip {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
}
.combat-chip b {
  color: var(--theme-text-primary);
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--theme-spacing-sm);
}
.stat-cell {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  padding: var(--theme-spacing-md);
  box-shadow: var(--paper-stack);
}
.sc-label {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.sc-value {
  font-family: var(--theme-font-title);
  font-size: 1.25rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  margin-top: 2px;
  font-variant-numeric: tabular-nums;
}
.sc-value.exp {
  color: var(--theme-success);
}
.sc-value.fp {
  color: var(--theme-primary);
}

.loot-box {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.lb-title {
  font-size: 0.75rem;
  color: var(--theme-primary);
  margin-bottom: var(--theme-spacing-xs);
}
.loot-line {
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  padding: 2px 0;
}
.loot-line .q {
  font-size: 0.625rem;
  margin-right: var(--theme-spacing-xs);
}
.loot-empty {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-style: italic;
}

.status-change {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.sc-title {
  color: var(--theme-text-secondary);
  font-weight: 600;
}
.sc-line {
  display: flex;
  gap: var(--theme-spacing-sm);
}
.sc-name {
  color: var(--theme-text-primary);
  font-weight: 600;
  min-width: 5em;
}
.sc-body.is-down {
  color: var(--theme-error);
}

.next-row {
  display: flex;
  align-items: stretch;
  gap: var(--theme-spacing-sm);
}
.next-input {
  flex: 1;
  resize: vertical;
  min-height: 48px;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-body);
  font-size: 0.875rem;
  line-height: 1.6;
}
.next-input:focus-visible {
  outline: none;
  border-color: var(--theme-primary);
}
.next-input::placeholder {
  color: var(--theme-text-muted);
  opacity: 0.7;
}

.settle-actions {
  display: flex;
  justify-content: flex-end;
}

@media (max-width: 640px) {
  .combat-settlement {
    padding: var(--theme-spacing-xl) var(--theme-spacing-lg);
  }
  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
