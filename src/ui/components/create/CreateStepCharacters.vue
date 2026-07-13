<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store'

const store = useCreateStore()

/** 提取条目内容的纯文本摘要 */
function summary(content: string, maxLen = 160): string {
  const cleaned = content
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned
}
</script>

<template>
  <section class="step-characters">
    <h2 class="step-title">启用角色</h2>
    <p class="step-desc">
      勾选你希望在此存档中出现的角色。未勾选的角色不会在叙事中被激活。
    </p>

    <div v-if="store.characterEntries.length === 0" class="chars-loading">
      正在加载角色列表…
    </div>

    <div v-else class="chars-grid">
      <label
        v-for="entry in store.characterEntries"
        :key="entry.uid"
        class="char-card"
        :class="{ checked: store.enabledCharacterEntryUids.has(entry.uid) }"
      >
        <input
          type="checkbox"
          class="char-checkbox"
          :checked="store.enabledCharacterEntryUids.has(entry.uid)"
          @change="store.toggleCharacterEntry(entry.uid)"
        />
        <div class="char-info">
          <div class="char-name">{{ entry.name }}</div>
          <div class="char-summary">{{ summary(entry.content) }}</div>
        </div>
      </label>
    </div>

    <div class="chars-count">
      已选择 {{ store.enabledCharacterEntryUids.size }} / {{ store.characterEntries.length }} 个角色
    </div>
  </section>
</template>

<style scoped>
.step-characters {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.step-title {
  font-size: 1.125rem;
  font-weight: 600;
  margin: 0 0 0.25rem;
}

.step-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  margin: 0 0 1rem;
}

.chars-loading {
  text-align: center;
  padding: 2rem;
  color: var(--theme-text-muted);
}

.chars-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 8px;
  align-content: start;
}

.char-card {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition: border-color 150ms;
}

.char-card:hover {
  border-color: var(--theme-primary);
}

.char-card.checked {
  border-color: var(--theme-primary);
  background: var(--theme-primary-muted, rgba(var(--theme-primary-rgb), 0.08));
}

.char-checkbox {
  margin-top: 2px;
  flex-shrink: 0;
  accent-color: var(--theme-primary);
}

.char-info {
  min-width: 0;
}

.char-name {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: 2px;
}

.char-summary {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.chars-count {
  padding-top: 8px;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  text-align: right;
  border-top: 1px solid var(--theme-card-border);
  margin-top: 8px;
}
</style>
