<script setup lang="ts">
import { useCreateStore } from '../../stores/create-store';

const store = useCreateStore();

/** 提取条目内容的纯文本摘要 */
function summary(content: string, maxLen = 160): string {
  const cleaned = content
    .replace(/<[^>]+>/g, '')
    .replace(/\{\{[^}]+\}\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…' : cleaned;
}
</script>

<template>
  <section class="step-characters">
    <h2 class="step-title">启用角色</h2>
    <p class="step-desc">勾选你希望在此存档中出现的角色。未勾选的角色不会在叙事中被激活。</p>

    <div v-if="store.characterEntries.length === 0" class="chars-loading">正在加载角色列表…</div>

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
  font-family: var(--theme-font-title, serif);
  color: var(--theme-text-primary);
  font-size: 1.3rem;
  margin: 0 0 var(--theme-spacing-xs);
}

.step-desc {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  margin: 0 0 var(--theme-spacing-md);
}

.chars-loading {
  text-align: center;
  padding: var(--theme-spacing-xl);
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}

.chars-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--theme-spacing-sm);
  align-content: start;
}

.char-card {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  cursor: pointer;
  transition: border-color var(--theme-transition-fast);
}

.char-card:hover {
  border-color: var(--theme-primary);
}

.char-card.checked {
  border-color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
}

.char-checkbox {
  margin-top: var(--theme-spacing-xs);
  flex-shrink: 0;
  accent-color: var(--theme-primary);
}

.char-info {
  min-width: 0;
}

.char-name {
  font-size: 0.875rem;
  font-weight: 600;
  margin-bottom: var(--theme-spacing-xs);
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
  padding-top: var(--theme-spacing-sm);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  text-align: right;
  border-top: 1px solid var(--theme-card-border);
  margin-top: var(--theme-spacing-sm);
}
</style>
