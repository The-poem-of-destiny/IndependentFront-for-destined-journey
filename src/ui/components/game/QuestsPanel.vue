<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { updateProfile } from '@engine/save-profile';

const game = useGameStore();

const activeFilter = ref('全部');
const focusQuest = ref(game.saveProfile?.focusQuest || '');
const inspectQuest = ref<string | null>(null);

// #14: 焦点任务选择回写 SaveProfile 持久化（此前仅存于本地 ref，刷新即丢）。
// 先改内存 reactive（其他面板即时可见），再 JSON 克隆落库
// （Dexie 结构化克隆吃不下 Vue Proxy，同 game-store.markOpeningPromptConsumed 的做法）。
watch(focusQuest, async (v) => {
  const profile = game.saveProfile;
  if (!profile || profile.focusQuest === v) return;
  profile.focusQuest = v;
  try {
    await updateProfile(JSON.parse(JSON.stringify(profile)));
  } catch (err) {
    console.error('[QuestsPanel] focusQuest 持久化失败:', err);
  }
});

// profile 整体被替换（loadSave / refreshFromDb）时，从档案回填选择，避免面板存活期间脱钩
watch(
  () => game.saveProfile?.focusQuest,
  (v) => {
    if (v !== undefined && v !== focusQuest.value) focusQuest.value = v;
  },
);

const inspected = computed(() => {
  if (!inspectQuest.value) return null;
  const quests = game.saveProfile?.quests;
  return quests?.[inspectQuest.value] || null;
});

const questEntries = computed(() => {
  const quests = game.saveProfile?.quests;
  if (!quests) return [];
  const priorityOrder: Record<string, number> = { 高: 0, 中: 1, 低: 2 };
  return Object.entries(quests).sort(
    ([, a], [, b]) => (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2),
  );
});

const statusFilters = computed(() => {
  const statuses = new Set(questEntries.value.map(([, q]) => q.status || '未开始'));
  return ['全部', ...Array.from(statuses)];
});

const filteredEntries = computed(() => {
  if (activeFilter.value === '全部') return questEntries.value;
  return questEntries.value.filter(([, q]) => (q.status || '未开始') === activeFilter.value);
});

const activeCount = computed(
  () => questEntries.value.filter(([, q]) => q.status !== '已完成' && q.status !== '失败').length,
);

const focusQuestData = computed(() => {
  const quests = game.saveProfile?.quests;
  if (!quests || !focusQuest.value) return null;
  return quests[focusQuest.value] || null;
});
</script>

<template>
  <div class="quests-panel">
    <!-- ═══ 态势概览 ═══ -->
    <div class="overview-card">
      <div class="ov-header">
        <i class="fa-solid fa-list-check" />
        <span>任务概览</span>
      </div>
      <div class="ov-stats">
        <div class="ov-stat">
          <span>全部任务</span><span class="stat-num">{{ questEntries.length }}</span>
        </div>
        <div class="ov-stat">
          <span>进行中</span><span class="stat-num active">{{ activeCount }}</span>
        </div>
      </div>
      <div class="ov-focus">
        <p class="focus-hint">选择一个任务作为焦点，追踪其进展</p>
        <select v-model="focusQuest" class="focus-select">
          <option value="">未设置焦点</option>
          <option v-for="[name] in questEntries" :key="name" :value="name">{{ name }}</option>
        </select>
        <div v-if="focusQuestData" class="focus-preview">
          <div class="fp-row">
            <span>目标</span><span>{{ focusQuestData.objective || '暂无' }}</span>
          </div>
          <div class="fp-row">
            <span>进展</span
            ><span :class="{ 'has-progress': focusQuestData.progress }">{{
              focusQuestData.progress || '暂无进展'
            }}</span>
          </div>
        </div>
      </div>
    </div>

    <!-- ═══ 筛选栏 ═══ -->
    <div v-if="statusFilters.length > 2" class="filter-bar">
      <button
        v-for="s in statusFilters"
        :key="s"
        :class="{ active: activeFilter === s }"
        @click="activeFilter = s"
      >
        {{ s }}
        <span class="badge">{{
          s === '全部'
            ? questEntries.length
            : questEntries.filter(([, q]) => (q.status || '未开始') === s).length
        }}</span>
      </button>
    </div>

    <!-- ═══ 任务卡片 ═══ -->
    <div v-if="filteredEntries.length > 0" class="quest-list">
      <div
        v-for="[name, q] in filteredEntries"
        :key="name"
        class="quest-card"
        @click="inspectQuest = name"
      >
        <div class="qc-header">
          <span class="qc-name">{{ name }}</span>
          <span class="qc-prio" :class="'p-' + q.priority">{{ q.priority }}</span>
          <span class="qc-status">{{ q.status || '未开始' }}</span>
        </div>

        <div v-if="q.progress" class="qc-progress">
          {{ q.progress }}
        </div>

        <div v-if="q.detail" class="qc-detail">
          {{ q.detail }}
        </div>

        <div class="qc-meta">
          <div v-if="q.objective" class="qc-row">
            <span>目标</span><span>{{ q.objective }}</span>
          </div>
          <div v-if="q.reward" class="qc-row">
            <span>奖励</span><span>{{ q.reward }}</span>
          </div>
        </div>
      </div>
    </div>
    <div v-else class="empty">暂无符合条件的任务</div>

    <!-- ═══ 任务详情浮层 ═══ -->
    <Teleport to="body">
      <div
        v-if="inspectQuest && inspected"
        class="inspect-overlay"
        @click.self="inspectQuest = null"
      >
        <div class="inspect-modal">
          <div class="im-header">
            <div class="im-title-group">
              <span class="im-name">{{ inspectQuest }}</span>
              <div class="im-tags">
                <span class="im-prio" :class="'p-' + inspected.priority">{{
                  inspected.priority
                }}</span>
                <span class="im-status">{{ inspected.status || '未开始' }}</span>
              </div>
            </div>
            <button class="im-close" @click="inspectQuest = null">×</button>
          </div>
          <div class="im-divider" />

          <div class="im-body">
            <div class="im-block">
              <div class="im-label">状态</div>
              <div class="im-text">{{ inspected.status || '未开始' }}</div>
            </div>
            <div class="im-dash" />
            <div class="im-block">
              <div class="im-label">关注度</div>
              <div class="im-text">{{ inspected.priority }}</div>
            </div>
            <div class="im-dash" />
            <div class="im-block">
              <div class="im-label">进展</div>
              <div class="im-text" :class="{ 'has-p': inspected.progress }">
                {{ inspected.progress || '暂无进展' }}
              </div>
            </div>
            <div class="im-dash" />
            <div class="im-block">
              <div class="im-label">详情</div>
              <div class="im-text im-long">{{ inspected.detail || '暂无详情' }}</div>
            </div>
            <div class="im-dash" />
            <div class="im-block">
              <div class="im-label">目标</div>
              <div class="im-text">{{ inspected.objective || '暂无目标' }}</div>
            </div>
            <div class="im-dash" />
            <div class="im-block">
              <div class="im-label">奖励</div>
              <div class="im-text">{{ inspected.reward || '暂无奖励' }}</div>
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.quests-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 500px;
}

/* ═══ 态势概览 ═══ */
.overview-card {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: 8px;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.ov-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.ov-header i {
  color: var(--theme-text-muted);
  font-size: 0.9375rem;
}
.ov-stats {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.ov-stat {
  background: var(--theme-surface-muted);
  border-radius: 6px;
  padding: 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ov-stat span:first-child {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.stat-num {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.stat-num.active {
  color: var(--theme-success);
}

.ov-focus {
  margin-top: 2px;
}
.focus-hint {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  margin: 0 0 6px;
}
.focus-select {
  width: 100%;
  padding: 8px 10px;
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: 6px;
  color: var(--theme-text-primary);
  font-size: 0.8125rem;
  font-family: inherit;
}
.focus-preview {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.fp-row {
  display: flex;
  justify-content: space-between;
  font-size: 0.75rem;
}
.fp-row span:first-child {
  color: var(--theme-text-muted);
}
.fp-row span:last-child {
  color: var(--theme-text-secondary);
}
.has-progress {
  color: var(--theme-success) !important;
}

/* ═══ 筛选栏 ═══ */
.filter-bar {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.filter-bar button {
  padding: 6px 14px;
  border: 1px solid var(--theme-card-border);
  background: none;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  cursor: pointer;
  font-family: inherit;
  border-radius: 16px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.filter-bar button.active {
  background: var(--theme-primary-bg);
  color: var(--theme-primary-text);
  border-color: var(--theme-primary);
}
.filter-bar .badge {
  font-size: 0.625rem;
  background: rgba(255, 255, 255, 0.15);
  padding: 1px 6px;
  border-radius: 8px;
}

/* ═══ 任务卡片 ═══ */
.quest-list {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.quest-card {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: 8px;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  cursor: pointer;
  transition: border-color 120ms;
}
.quest-card:hover {
  border-color: var(--theme-primary);
}
.qc-header {
  display: flex;
  align-items: center;
  gap: 8px;
}
.qc-name {
  font-weight: 700;
  font-size: 0.9375rem;
  color: var(--theme-text-primary);
  flex: 1;
}
.qc-prio {
  font-size: 0.625rem;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 700;
}
.qc-status {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.p-高 {
  background: color-mix(in srgb, var(--theme-error) 18%, transparent);
  color: var(--theme-error);
}
.p-中 {
  background: color-mix(in srgb, var(--theme-warning) 18%, transparent);
  color: var(--theme-warning);
}
.p-低 {
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
}

.qc-progress {
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  padding: 8px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.5;
}
.qc-detail {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.6;
}
.qc-meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-top: 4px;
  border-top: 1px solid var(--theme-card-border);
}
.qc-row {
  display: flex;
  gap: 12px;
  font-size: 0.75rem;
}
.qc-row span:first-child {
  color: var(--theme-text-muted);
  min-width: 40px;
}
.qc-row span:last-child {
  color: var(--theme-text-primary);
}

.empty {
  padding: 40px;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.875rem;
}

/* ═══ 任务详情浮层 ═══ */
.inspect-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--theme-overlay-bg);
  backdrop-filter: blur(4px);
}
.inspect-modal {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: 12px;
  box-shadow: var(--theme-shadow-lg);
  width: min(90vw, 560px);
  max-height: 80vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.im-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 20px 12px;
}
.im-title-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.im-name {
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  font-family: var(--theme-font-title, 'Cinzel', serif);
}
.im-tags {
  display: flex;
  gap: 6px;
}
.im-prio {
  font-size: 0.625rem;
  padding: 2px 8px;
  border-radius: 10px;
  font-weight: 700;
}
.im-status {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.im-close {
  width: 28px;
  height: 28px;
  border: none;
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  font-size: 1rem;
  border-radius: 50%;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.im-close:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}
.im-divider {
  border-top: 1px solid var(--theme-card-border);
  margin: 0 20px;
}

.im-body {
  padding: 12px 20px 20px;
  display: flex;
  flex-direction: column;
}
.im-block {
  padding: 8px 0;
}
.im-label {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 4px;
}
.im-text {
  font-size: 0.875rem;
  color: var(--theme-text-primary);
  line-height: 1.5;
}
.im-text.has-p {
  color: var(--theme-success);
}
.im-long {
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
}
.im-dash {
  border-top: 1px dashed var(--theme-card-border);
  margin: 0;
}
</style>
