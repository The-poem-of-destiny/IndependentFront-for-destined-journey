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
      <div class="sd-header">
        <span class="sd-dot" />
        <h3>{{ store.destinyCore.name }}</h3>
      </div>
      <div class="sd-meta">
        <span><strong>作者</strong> {{ store.destinyCore.author }}</span>
        <span class="sd-sep">|</span>
        <span><strong>主题</strong> {{ store.destinyCore.theme }}</span>
      </div>
      <p v-if="store.destinyCore.description" class="sd-desc">{{ store.destinyCore.description }}</p>
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
  border: 1px solid var(--theme-quality-epic);
  border-radius: var(--theme-radius-md);
  border-left: 3px solid var(--theme-quality-epic);
}
.sd-header { display: flex; align-items: center; gap: 8px; margin-bottom: var(--theme-spacing-xs); }
.sd-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--theme-quality-epic); flex-shrink: 0; }
.sd-header h3 { color: var(--theme-quality-epic); margin: 0; font-size: 0.95rem; }
.sd-meta { display: flex; gap: 8px; font-size: 0.75rem; color: var(--theme-text-secondary); flex-wrap: wrap; }
.sd-sep { color: var(--theme-card-border); }
.sd-desc { font-size: 0.8rem; color: var(--theme-text-secondary); line-height: 1.5; margin: var(--theme-spacing-xs) 0 0; }
</style>
