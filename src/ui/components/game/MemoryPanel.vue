<script setup lang="ts">
import { ref, computed } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { deleteMemory } from '@engine/database';
import type { MemoryRecord } from '@engine/types';
import AppButton from '../shared/AppButton.vue';

const game = useGameStore();

// ===== 列表态 =====
const searchQuery = ref('');
const sortMode = ref<'time-desc' | 'time-asc' | 'importance'>('time-desc');
const importanceFilter = ref<'all' | 'high' | 'mid' | 'low'>('all');
const pageSize = 24;
const currentPage = ref(1);

// ===== 详情态 =====
const selectedId = ref<string | null>(null);

const allMemories = computed(() => [...(game.recentMemories || [])]);

const filtered = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return allMemories.value.filter((mem) => {
    if (importanceFilter.value === 'high' && mem.importance < 7) return false;
    if (importanceFilter.value === 'mid' && (mem.importance < 4 || mem.importance > 6))
      return false;
    if (importanceFilter.value === 'low' && mem.importance > 3) return false;
    if (!q) return true;
    const haystack = `${mem.content} ${(mem.keywords || []).join(' ')}`.toLowerCase();
    return haystack.includes(q);
  });
});

const sorted = computed(() => {
  const arr = [...filtered.value];
  if (sortMode.value === 'time-asc') {
    arr.sort((a, b) => a.createdAt - b.createdAt);
  } else if (sortMode.value === 'importance') {
    arr.sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt);
  } else {
    arr.sort((a, b) => b.createdAt - a.createdAt);
  }
  return arr;
});

const totalPages = computed(() => Math.max(1, Math.ceil(sorted.value.length / pageSize)));

const paged = computed(() => {
  const start = (currentPage.value - 1) * pageSize;
  return sorted.value.slice(start, start + pageSize);
});

const selected = computed<MemoryRecord | null>(() => {
  if (!selectedId.value) return null;
  return allMemories.value.find((m) => m.id === selectedId.value) ?? null;
});

const characterNames = computed(() => {
  const map = new Map<string, string>();
  for (const c of game.characters || []) map.set(c.id, c.name);
  return map;
});

/** 空态两种情形：筛出来是空 vs 本来就没有记忆 */
const emptyText = computed(() =>
  filtered.value.length === 0 && (searchQuery.value || importanceFilter.value !== 'all')
    ? '无匹配记忆'
    : '书页尚空 —— 冒险几轮后记忆会在这里沉淀',
);

function characterNameOf(id: string): string {
  return characterNames.value.get(id) ?? id;
}

function timeText(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

/** 重要度三档（阈值与原 starClass 一致）：≥8 高 / ≥5 中 / 其余 低 */
function importanceClass(importance: number): string {
  if (importance >= 8) return 'imp-high';
  if (importance >= 5) return 'imp-mid';
  return 'imp-low';
}

function onFilterChange() {
  currentPage.value = 1;
}

function openDetail(id: string) {
  selectedId.value = id;
}

function backToList() {
  selectedId.value = null;
}

async function copyContent() {
  if (!selected.value) return;
  try {
    await navigator.clipboard.writeText(selected.value.content);
  } catch (e) {
    console.warn('[MemoryPanel] 复制失败:', e);
  }
}

async function removeSelected() {
  const mem = selected.value;
  if (!mem) return;
  const ok = window.confirm(`删除记忆「${mem.id}」？删除后不可恢复。`);
  if (!ok) return;
  try {
    await deleteMemory(mem.id);
    const idx = game.recentMemories?.findIndex((m) => m.id === mem.id) ?? -1;
    if (idx >= 0 && game.recentMemories) {
      game.recentMemories.splice(idx, 1);
    }
    selectedId.value = null;
  } catch (e) {
    console.warn('[MemoryPanel] 删除记忆失败:', e);
  }
}
</script>

<template>
  <div class="memory-panel">
    <!-- ========== 详情视图 ========== -->
    <div v-if="selected" class="memory-detail">
      <div class="detail-toolbar">
        <button class="back-btn" aria-label="返回列表" @click="backToList">← 返回</button>
        <span class="detail-title">记忆详情</span>
        <span class="detail-importance">
          <span class="imp-chip" :class="importanceClass(selected.importance)">
            <span class="imp-star" aria-hidden="true">★</span>{{ selected.importance }}
          </span>
          <span class="imp-text">重要度 {{ selected.importance }}/10</span>
        </span>
      </div>
      <div class="detail-meta">
        <span v-if="selected.timeRange" class="detail-time">
          {{ selected.timeRange.start }} → {{ selected.timeRange.end }}
        </span>
        <span v-if="selected.relatedCharacterIds?.length" class="detail-chars">
          {{ selected.relatedCharacterIds.map(characterNameOf).join(' · ') }}
        </span>
      </div>
      <span class="section-label">内容</span>
      <div class="detail-content">{{ selected.content }}</div>
      <template v-if="selected.keywords?.length">
        <span class="section-label">关键词</span>
        <div class="detail-keywords">
          <span v-for="kw in selected.keywords" :key="kw" class="keyword">{{ kw }}</span>
        </div>
      </template>
      <div class="detail-foot">
        <span class="detail-id">ID: {{ selected.id }}</span>
        <span class="detail-real">存档于 {{ timeText(selected.realTimestamp) }}</span>
      </div>
      <div class="detail-actions">
        <AppButton variant="secondary" size="sm" @click="copyContent">复制内容</AppButton>
        <AppButton variant="danger" size="sm" @click="removeSelected">删除这条</AppButton>
      </div>
    </div>

    <!-- ========== 卡片墙视图 ========== -->
    <div v-else class="memory-wall">
      <div class="wall-toolbar">
        <input
          v-model="searchQuery"
          class="search-input"
          type="text"
          placeholder="搜索记忆内容 / 关键词…"
          @input="onFilterChange"
        />
        <select v-model="sortMode" class="sort-select" @change="onFilterChange">
          <option value="time-desc">最新在前</option>
          <option value="time-asc">最早在前</option>
          <option value="importance">按重要度</option>
        </select>
        <select v-model="importanceFilter" class="sort-select" @change="onFilterChange">
          <option value="all">全部重要度</option>
          <option value="high">重要度 ≥7</option>
          <option value="mid">重要度 4-6</option>
          <option value="low">重要度 ≤3</option>
        </select>
      </div>

      <div v-if="paged.length > 0" class="card-grid">
        <button
          v-for="mem in paged"
          :key="mem.id"
          class="memory-card"
          :aria-label="`查看记忆 ${mem.id}`"
          @click="openDetail(mem.id)"
        >
          <span class="card-topline">
            <span class="imp-chip" :class="importanceClass(mem.importance)">
              <span class="imp-star" aria-hidden="true">★</span>{{ mem.importance }}
            </span>
            <span class="card-id">{{ mem.id }}</span>
          </span>
          <span class="card-content">{{ mem.content }}</span>
          <span class="card-meta">
            <span v-if="mem.keywords?.length" class="card-keywords">
              <span v-for="kw in mem.keywords.slice(0, 3)" :key="kw" class="card-keyword">{{
                kw
              }}</span>
            </span>
            <span v-if="mem.timeRange?.start" class="card-time">{{ mem.timeRange.start }}</span>
          </span>
        </button>
      </div>
      <div v-else class="empty">{{ emptyText }}</div>

      <div v-if="totalPages > 1" class="pagination">
        <button
          class="page-btn"
          :disabled="currentPage <= 1"
          aria-label="上一页"
          @click="currentPage--"
        >
          ‹ 上一页
        </button>
        <span class="page-info"
          >第 {{ currentPage }} / {{ totalPages }} 页 · 共 {{ sorted.length }} 条</span
        >
        <button
          class="page-btn"
          :disabled="currentPage >= totalPages"
          aria-label="下一页"
          @click="currentPage++"
        >
          下一页 ›
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.memory-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 37.5rem;
  padding: var(--theme-spacing-sm);
  gap: var(--theme-spacing-sm);
}
.memory-wall {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: var(--theme-spacing-sm);
}
/* ===== 卡片墙 ===== */
.wall-toolbar {
  display: flex;
  gap: var(--theme-spacing-sm);
  align-items: center;
  flex-shrink: 0;
}
.search-input {
  flex: 1;
  min-width: 0;
  height: 2rem;
  padding: 0 var(--theme-spacing-sm);
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--theme-text-primary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  transition:
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}
.search-input:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.search-input:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.search-input:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.sort-select {
  height: 2rem;
  padding: 0 var(--theme-spacing-xs);
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.sort-select:hover {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
}
.sort-select:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.card-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: var(--theme-spacing-md);
  align-content: start;
  padding-top: 2px;
}
.memory-card {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-md);
  text-align: left;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  cursor: pointer;
  font-family: inherit;
  transition:
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast),
    transform var(--theme-transition-fast);
}
.memory-card:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  transform: translateY(-1px);
}
.memory-card:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.card-topline {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--theme-spacing-xs);
}
.card-id {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  font-family: monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
/* 重要度徽章（★ + 数值，三档全部走 token 着色） */
.imp-chip {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 1px var(--theme-spacing-xs);
  font-size: 0.6875rem;
  font-weight: 600;
  line-height: 1.4;
  border-radius: var(--theme-radius-sm);
}
.imp-star {
  font-size: 0.625rem;
}
.imp-high {
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
.imp-mid {
  color: var(--theme-text-secondary);
  background: color-mix(in srgb, var(--theme-text-secondary) 8%, transparent);
  border: 1px solid var(--theme-card-border);
}
.imp-low {
  color: var(--theme-text-muted);
  background: transparent;
  border: 1px solid var(--theme-card-border);
}
.card-content {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  line-height: 1.55;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  margin-top: auto;
}
.card-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  overflow: hidden;
}
.card-time {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  font-family: monospace;
}
/* ===== 分页 ===== */
.pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-md);
  padding-top: var(--theme-spacing-xs);
  flex-shrink: 0;
}
.page-btn {
  min-height: 2rem;
  padding: 0 var(--theme-spacing-md);
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}
.page-btn:hover:not(:disabled) {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-surface-muted));
}
.page-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.page-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.page-info {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
/* ===== 详情视图 ===== */
.memory-detail {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  height: 100%;
  padding: var(--theme-spacing-xs);
}
.detail-toolbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  flex-shrink: 0;
}
.back-btn {
  min-height: 2rem;
  padding: 0 var(--theme-spacing-md);
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    color var(--theme-transition-fast),
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}
.back-btn:hover {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-surface-muted));
}
.back-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.detail-title {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--theme-text-primary);
}
.detail-importance {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  margin-left: auto;
}
.imp-text {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.detail-meta {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
/* Section 标题装饰线（design.md §5.1） */
.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  font-family: var(--theme-font-title);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: var(--theme-text-secondary);
}
.section-label::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}
.detail-content {
  flex: 1;
  overflow-y: auto;
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  padding: var(--theme-spacing-md);
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
}
.detail-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: var(--theme-spacing-xs);
  flex-shrink: 0;
}
.keyword,
.card-keyword {
  font-size: 0.625rem;
  line-height: 1.5;
  padding: 1px var(--theme-spacing-xs);
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  white-space: nowrap;
}
.detail-foot {
  display: flex;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  font-family: monospace;
}
.detail-actions {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-shrink: 0;
}
.empty {
  flex: 1;
  padding: var(--theme-spacing-2xl) 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}
</style>
