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

function starClass(importance: number): string {
  if (importance >= 8) return 'star-high';
  if (importance >= 5) return 'star-mid';
  return 'star-low';
}

function starText(importance: number): string {
  return '★'.repeat(importance) + '☆'.repeat(Math.max(0, 10 - importance));
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
        <span class="detail-star" :class="starClass(selected.importance)">
          {{ starText(selected.importance) }}
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
      <div class="detail-content">{{ selected.content }}</div>
      <div v-if="selected.keywords?.length" class="detail-keywords">
        <span v-for="kw in selected.keywords" :key="kw" class="keyword">{{ kw }}</span>
      </div>
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
            <span class="card-star" :class="starClass(mem.importance)">{{
              '★'.repeat(mem.importance)
            }}</span>
            <span class="card-id">{{ mem.id }}</span>
          </span>
          <span class="card-content">{{ mem.content }}</span>
          <span class="card-meta">
            <span v-if="mem.keywords?.length" class="card-keywords">
              {{ mem.keywords.slice(0, 3).join(' · ') }}
            </span>
            <span v-if="mem.timeRange?.start" class="card-time">{{ mem.timeRange.start }}</span>
          </span>
        </button>
      </div>
      <div v-else class="empty">
        {{
          filtered.length === 0 && (searchQuery || importanceFilter !== 'all')
            ? '无匹配记忆'
            : '暂无记忆'
        }}
      </div>

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
  padding: 8px;
  gap: 8px;
}
/* ===== 卡片墙 ===== */
.wall-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
  margin-bottom: 4px;
}
.search-input {
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  font-size: 0.8125rem;
  font-family: inherit;
  color: var(--theme-text-primary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
}
.search-input:focus {
  outline: none;
  border-color: var(--theme-primary);
}
.sort-select {
  padding: 6px 8px;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
}
.card-grid {
  flex: 1;
  overflow-y: auto;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: 10px;
  align-content: start;
  padding-top: 2px;
}
.memory-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px;
  text-align: left;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
  font-family: inherit;
  transition:
    border-color var(--theme-transition-fast),
    transform var(--theme-transition-fast);
}
.memory-card:hover {
  border-color: var(--theme-primary);
  transform: translateY(-1px);
}
.memory-card:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.card-topline {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 6px;
}
.card-star {
  font-size: 0.6875rem;
}
.card-id {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  font-family: monospace;
  white-space: nowrap;
}
.star-high {
  color: #f59e0b;
}
.star-mid {
  color: #94a3b8;
}
.star-low {
  color: #64748b;
}
.card-content {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.card-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: auto;
}
.card-keywords {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
  gap: 12px;
  padding: 6px 0 2px;
  flex-shrink: 0;
}
.page-btn {
  padding: 4px 10px;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
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
  gap: 10px;
  height: 100%;
  padding: 4px;
}
.detail-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}
.back-btn {
  padding: 4px 10px;
  font-size: 0.75rem;
  font-family: inherit;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm, 4px);
  cursor: pointer;
}
.detail-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.detail-star {
  font-size: 0.75rem;
  margin-left: auto;
}
.detail-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.detail-content {
  flex: 1;
  overflow-y: auto;
  font-size: 0.8125rem;
  color: var(--theme-text-primary);
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-word;
  padding: 10px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm, 4px);
}
.detail-keywords {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  flex-shrink: 0;
}
.keyword {
  font-size: 0.625rem;
  padding: 1px 6px;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border-radius: 3px;
}
.detail-foot {
  display: flex;
  justify-content: space-between;
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  font-family: monospace;
}
.detail-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
}
</style>
