<script setup lang="ts">
import { ref } from 'vue'
import { useCreateStore } from '../../stores/create-store'

const store = useCreateStore()

/** 展开/折叠的条目 uid */
const expandedUid = ref<number | null>(null)

function toggleExpand(uid: number) {
  expandedUid.value = expandedUid.value === uid ? null : uid
}

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

    <!-- 选中条目的详情卡片 -->
    <div v-if="store.selectedSystemCoreEntry" class="selected-detail">
      <div class="sd-header">
        <span class="sd-dot" />
        <h3>{{ store.selectedSystemCoreEntry.name }}</h3>
        <button class="sd-deselect" @click="store.selectSystemCoreEntry(null as any)" title="取消选择">
          ✕
        </button>
      </div>
      <div class="sd-desc">{{ summary(store.selectedSystemCoreEntry.content, 500) }}</div>
    </div>

    <!-- 紧凑单选列表（始终显示所有条目） -->
    <div class="core-list">
      <div
        v-for="entry in store.systemCoreEntries"
        :key="entry.uid"
        class="core-row"
        :class="{ selected: store.selectedSystemCoreEntryUid === entry.uid }"
        role="radio"
        :aria-checked="store.selectedSystemCoreEntryUid === entry.uid"
        tabindex="0"
      >
        <!-- 行主体：点击即选中 -->
        <div
          class="core-row-body"
          @click="store.selectSystemCoreEntry(entry.uid)"
          @keydown.enter="store.selectSystemCoreEntry(entry.uid)"
          @keydown.space.prevent="store.selectSystemCoreEntry(entry.uid)"
        >
          <span class="core-radio" :class="{ checked: store.selectedSystemCoreEntryUid === entry.uid }" />
          <span class="core-name">{{ entry.name }}</span>
        </div>

        <!-- 展开/折叠按钮 -->
        <button
          class="core-chevron"
          :class="{ expanded: expandedUid === entry.uid }"
          @click.stop="toggleExpand(entry.uid)"
          aria-label="展开内容预览"
          type="button"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M4 2l4 4-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>

        <!-- 可展开的内容预览 -->
        <div
          class="core-preview"
          :class="{ open: expandedUid === entry.uid }"
        >
          <div class="core-preview-inner">
            {{ summary(entry.content, 400) }}
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.step-core {
  max-width: 800px;
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

.core-loading {
  text-align: center;
  padding: 2rem;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}

/* ── 详情卡片 ── */
.selected-detail {
  margin-bottom: var(--theme-spacing-lg);
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-quality-epic);
  border-radius: var(--theme-radius-md);
  border-left: 3px solid var(--theme-quality-epic);
}
.sd-header {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin-bottom: var(--theme-spacing-xs);
}
.sd-dot {
  width: var(--theme-spacing-sm);
  height: var(--theme-spacing-sm);
  border-radius: 50%;
  background: var(--theme-quality-epic);
  flex-shrink: 0;
}
.sd-header h3 {
  color: var(--theme-quality-epic);
  margin: 0;
  font-size: 0.95rem;
  flex: 1;
}
.sd-deselect {
  background: none;
  border: 1px solid var(--theme-card-border);
  color: var(--theme-text-muted);
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 0.75rem;
  transition: color var(--theme-transition-fast), border-color var(--theme-transition-fast);
}
.sd-deselect:hover {
  color: var(--theme-text-primary);
  border-color: var(--theme-text-muted);
}
.sd-desc {
  font-size: 0.8rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
  margin: var(--theme-spacing-xs) 0 0;
}

/* ── 列表容器 ── */
.core-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}

/* ── 单行 ── */
.core-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 6px);
  background: var(--theme-card-bg);
  cursor: default;
  transition: border-color 0.2s ease;
}
.core-row:hover {
  border-color: var(--theme-text-muted);
}
.core-row.selected {
  border-color: var(--theme-quality-epic);
  box-shadow: 0 0 0 1px var(--theme-quality-epic);
}

/* ── 行主体（radio + name） ── */
.core-row-body {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  flex: 1;
  min-width: 0;
  cursor: pointer;
  padding: var(--theme-spacing-xs) 0;
}

/* ── 自定义 radio 圆圈 ── */
.core-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--theme-text-muted);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.2s ease, background-color 0.2s ease;
}
.core-radio.checked {
  border-color: var(--theme-quality-epic);
  background-color: var(--theme-quality-epic);
}
.core-radio.checked::after {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--theme-card-bg);
}

.core-name {
  font-weight: 700;
  font-size: 0.95rem;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title, serif);
}

/* ── 展开/折叠按钮 ── */
.core-chevron {
  flex-shrink: 0;
  background: none;
  border: none;
  cursor: pointer;
  padding: var(--theme-spacing-xs);
  color: var(--theme-text-muted);
  transition: transform 0.2s ease, color 0.2s ease;
  margin-top: 2px;
}
.core-chevron:hover {
  color: var(--theme-text-primary);
}
.core-chevron.expanded {
  transform: rotate(90deg);
}

/* ── 可展开预览（CSS transition） ── */
.core-preview {
  width: 100%;
  max-height: 0;
  overflow: hidden;
  transition: max-height 0.25s ease, padding 0.25s ease;
}
.core-preview.open {
  max-height: 300px;        /* 撑开后的上限，由内边距限制实际高度 */
}
.core-preview-inner {
  padding-top: var(--theme-spacing-sm);
  font-size: 0.78rem;
  color: var(--theme-text-secondary);
  line-height: 1.6;
  border-top: 1px solid var(--theme-card-border);
}
</style>
