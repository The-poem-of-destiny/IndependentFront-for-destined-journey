<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'
import { DIFFICULTY_PRESETS } from '@engine/start-catalog'
import AppCard from '../shared/AppCard.vue'

const store = useCreateStore()
</script>

<template>
  <section class="step-difficulty">
    <h2 class="step-title">选择游戏难度</h2>
    <p class="step-desc">难度决定初始转生点数，转生点数用于购买属性、装备、技能、道具和伙伴。</p>

    <div class="difficulty-list">
      <AppCard
        v-for="d in DIFFICULTY_PRESETS"
        :key="d.id"
        clickable
        :selected="store.difficulty?.id === d.id"
        class="difficulty-card"
        @click="store.selectDifficulty(d.id)"
      >
        <div class="card-inner">
          <span class="diff-name">{{ d.label }}</span>
          <span class="diff-points">{{ d.points.toLocaleString() }} 转生点</span>
          <span class="diff-desc">{{ d.desc }}</span>
        </div>
      </AppCard>
    </div>

    <p v-if="store.difficulty" class="selected-hint">
      已选择「{{ store.difficulty.label }}」，获得 {{ store.difficulty.points.toLocaleString() }} 转生点数
    </p>
  </section>
</template>

<style scoped>
.step-difficulty {
  max-width: 520px;
  margin: 0 auto;
}
.step-title {
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.3rem;
  margin-bottom: var(--theme-spacing-xs);
}
.step-desc {
  color: var(--theme-text-secondary);
  font-size: 0.85rem;
  margin-bottom: var(--theme-spacing-lg);
}
.difficulty-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.difficulty-card {
  padding: var(--theme-spacing-md);
}
.card-inner {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.diff-name {
  font-weight: 700;
  font-size: 1rem;
  color: var(--theme-text-primary);
}
.diff-points {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--theme-color-primary);
}
.diff-desc {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.selected-hint {
  margin-top: var(--theme-spacing-md);
  text-align: center;
  font-size: 0.85rem;
  color: var(--theme-color-primary);
}
</style>
