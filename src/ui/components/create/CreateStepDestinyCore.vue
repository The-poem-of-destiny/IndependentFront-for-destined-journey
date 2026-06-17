<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'
import DestinyCoreCard from './DestinyCoreCard.vue'

const store = useCreateStore()
</script>

<template>
  <section class="step-core">
    <h2 class="step-title">命定核心 — 选择你的命定之灵</h2>
    <p class="step-desc">
      命定之灵是寄宿于你灵魂中的存在，它将伴随整个命运之旅，影响叙事风格和特殊机制。请慎重选择。
    </p>

    <div class="core-grid">
      <DestinyCoreCard
        v-for="core in store.destinyCorePool"
        :key="core.id"
        :core="core"
        :selected="store.destinyCore?.id === core.id"
        @select="store.selectDestinyCore"
      />
    </div>

    <div v-if="store.destinyCore" class="selected-detail">
      <h3>已选: {{ store.destinyCore.name }}</h3>
      <p><strong>作者:</strong> {{ store.destinyCore.author }}</p>
      <p><strong>主题:</strong> {{ store.destinyCore.theme }}</p>
      <p v-if="store.destinyCore.description">{{ store.destinyCore.description }}</p>
    </div>
  </section>
</template>

<style scoped>
.step-core { max-width: 800px; margin: 0 auto; }
.step-title { font-family: var(--theme-font-title, serif); color: var(--theme-text-primary); font-size: 1.3rem; margin-bottom: var(--theme-spacing-xs); }
.step-desc { color: var(--theme-text-secondary); font-size: 0.85rem; margin-bottom: var(--theme-spacing-lg); }
.core-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--theme-spacing-sm); }
@media (max-width: 640px) { .core-grid { grid-template-columns: repeat(2, 1fr); } }
.selected-detail {
  margin-top: var(--theme-spacing-lg);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.selected-detail h3 { color: var(--theme-color-primary); margin-bottom: var(--theme-spacing-xs); }
.selected-detail p { font-size: 0.8rem; color: var(--theme-text-secondary); }
</style>
