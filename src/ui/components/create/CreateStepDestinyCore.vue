<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'

const store = useCreateStore()

/** 提取条目内容的纯文本摘要（去掉 HTML/EJS 标签） */
function summary(content: string, maxLen = 200): string {
  const cleaned = content
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned
}
</script>

<template>
  <section class="step-core">
    <h2 class="step-title">命定核心 — 选择你的命定之灵</h2>
    <p class="step-desc">
      命定之灵是寄宿于你灵魂中的存在，它将伴随整个命运之旅，影响叙事风格和特殊机制。请慎重选择。
    </p>

    <div v-if="store.systemCoreEntries.length === 0" class="core-loading">
      正在加载命定核心列表…
    </div>

    <div v-else class="core-grid">
      <div
        v-for="entry in store.systemCoreEntries"
        :key="entry.uid"
        class="core-card"
        :class="{ selected: store.selectedSystemCoreEntryUid === entry.uid }"
        role="radio"
        :aria-checked="store.selectedSystemCoreEntryUid === entry.uid"
        tabindex="0"
        @click="store.selectSystemCoreEntry(entry.uid)"
        @keydown.enter="store.selectSystemCoreEntry(entry.uid)"
        @keydown.space.prevent="store.selectSystemCoreEntry(entry.uid)"
      >
        <div class="core-name">{{ entry.name }}</div>
        <div class="core-summary">{{ summary(entry.content) }}</div>
      </div>
    </div>

    <div v-if="store.selectedSystemCoreEntry" class="selected-detail">
      <div class="sd-header">
        <span class="sd-dot" />
        <h3>{{ store.selectedSystemCoreEntry.name }}</h3>
      </div>
      <div class="sd-desc">{{ summary(store.selectedSystemCoreEntry.content, 500) }}</div>
    </div>
  </section>
</template>

<style scoped>
.step-core { max-width: 800px; margin: 0 auto; }
.step-title { font-family: var(--theme-font-title, serif); color: var(--theme-text-primary); font-size: 1.3rem; margin-bottom: var(--theme-spacing-xs); }
.step-desc { color: var(--theme-text-secondary); font-size: 0.85rem; margin-bottom: var(--theme-spacing-lg); }
.core-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--theme-spacing-sm); }
@media (max-width: 640px) { .core-grid { grid-template-columns: repeat(2, 1fr); } }

.core-loading {
  text-align: center;
  padding: 2rem;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}

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
.sd-desc { font-size: 0.8rem; color: var(--theme-text-secondary); line-height: 1.5; margin: var(--theme-spacing-xs) 0 0; }
</style>
