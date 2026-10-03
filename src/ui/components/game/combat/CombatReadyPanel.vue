<script setup lang="ts">
/**
 * CombatReadyPanel.vue — 战斗就绪态（C6）
 *
 * combat_trigger 检出后、玩家点「开始战斗」前的面板：类型/环境 chip + 我方/敌方名单 +
 * 起因简报 + [跳过战斗][开始战斗]。数据 = marker 快照（战斗尚未开始，无 CombatState）。
 */
import AppButton from '../../shared/AppButton.vue';

defineProps<{
  ready: {
    combatType?: string;
    environment?: string;
    allies?: string[];
    enemies?: string[];
    bodyText?: string;
    brief?: string;
  };
}>();

const emit = defineEmits<{ start: []; skip: [] }>();
</script>

<template>
  <div class="combat-ready">
    <div class="combat-ready-title">
      <i class="fa-solid fa-hand-fist combat-title-icon" />
      <span>战斗就绪</span>
    </div>

    <div v-if="ready.combatType || ready.environment" class="combat-ready-meta">
      <span v-if="ready.combatType" class="combat-chip"
        >类型 <b>{{ ready.combatType }}</b></span
      >
      <span v-if="ready.environment" class="combat-chip"
        >环境 <b>{{ ready.environment }}</b></span
      >
    </div>

    <div v-if="ready.allies?.length" class="combat-ready-roster">
      <span class="combat-side-label">【我方】</span>
      <div class="combat-ready-names">{{ ready.allies.join('、') }}</div>
    </div>
    <div v-if="ready.enemies?.length" class="combat-ready-roster is-enemy">
      <span class="combat-side-label">【敌方】</span>
      <div class="combat-ready-names">{{ ready.enemies.join('、') }}</div>
    </div>

    <div v-if="ready.bodyText || ready.brief" class="combat-ready-brief">
      {{ ready.bodyText || ready.brief }}
    </div>

    <div class="combat-ready-actions">
      <AppButton variant="primary" size="sm" @click="emit('start')">开始战斗</AppButton>
      <AppButton variant="ghost" size="sm" @click="emit('skip')">跳过战斗</AppButton>
    </div>
  </div>
</template>

<style scoped>
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
  border-bottom: 1px solid var(--theme-card-border);
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
.combat-chip {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-full);
}
.combat-chip b {
  color: var(--theme-text-primary);
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
.combat-ready-roster.is-enemy {
  border-color: color-mix(in srgb, var(--theme-error) 35%, var(--theme-card-border));
}
.combat-side-label {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  font-weight: 600;
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
.combat-ready-actions {
  grid-column: 1 / -1;
  display: flex;
  justify-content: flex-end;
  gap: var(--theme-spacing-sm);
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
}
</style>
