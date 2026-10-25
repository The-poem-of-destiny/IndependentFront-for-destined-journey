<script setup lang="ts">
/**
 * Story 上下文新模式（v2）测试档的记忆面板（计划 §12.2）。
 *
 * 三栏：长期总览（有效归档的年表 + 详细记录）、未结事件、短期摘要（按回合，可回查原文）。
 * 「退出上下文」不等于删除：被归档覆盖的摘要照样列出，只标「已归档」；原文永远可展开查看。
 *
 * 🔴 判据一律复用引擎纯函数（有效归档、覆盖关系、未结事件、来源回合），面板不另写一份 ——
 *    两份判据的下场是「面板说已归档、上下文里却还在」。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useGameStore } from '../../stores/game-store';
import { getStoryArchives, getStoryTurnSummaries } from '@engine/persistence/database';
import type { ChatMessage, StoryArchiveRecord, StoryTurnSummaryRecord } from '@engine/types/types';
import {
  archivedSegmentIdsOf,
  collectCompleteStoryTurns,
  collectOpenStoryEvents,
  resolveActiveStoryArchives,
  resolveValidStorySegments,
  type StoryTurn,
} from '@engine/memory/memory-context';
import { storyArchiveOutcomeLabel } from '@engine/memory/story-archive';
import { collectArchiveSourceTurns } from '@engine/memory/story-archive-detail';
import { formatGameTime } from '@engine/time/time-system';

const game = useGameStore();

type Tab = 'overview' | 'open' | 'turns';
const tab = ref<Tab>('overview');
const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '长期总览' },
  { id: 'open', label: '未结事件' },
  { id: 'turns', label: '短期摘要' },
];

const summaries = ref<StoryTurnSummaryRecord[]>([]);
const archives = ref<StoryArchiveRecord[]>([]);
const loadError = ref(false);
const selectedArchiveId = ref<string | null>(null);
const expandedTurns = ref(new Set<string>());

async function load(): Promise<void> {
  const saveId = game.activeSaveId;
  if (!saveId) return;
  try {
    const [s, a] = await Promise.all([getStoryTurnSummaries(saveId), getStoryArchives(saveId)]);
    if (saveId !== game.activeSaveId) return;
    summaries.value = s;
    archives.value = a;
    loadError.value = false;
  } catch (err) {
    console.warn('[StoryMemoryV2Panel] 读取记忆失败:', err);
    loadError.value = true;
  }
}

onMounted(() => void load());
// 回合落库发生在正文之后、生成结束之前：两个信号都盯，才不会停在上一回合
watch(
  () => [game.messages.length, game.isGenerating] as const,
  () => void load(),
);

const messages = computed<ChatMessage[]>(() => game.messages ?? []);
const turns = computed(() => collectCompleteStoryTurns(messages.value));
const turnNumber = computed(() => new Map(turns.value.map((t, i) => [t.key, i + 1])));
const activeArchives = computed(() =>
  resolveActiveStoryArchives(messages.value, archives.value, summaries.value),
);
const coveredIds = computed(() => archivedSegmentIdsOf(activeArchives.value));
const openEvents = computed(() =>
  collectOpenStoryEvents(messages.value, summaries.value, archives.value),
);

/** 按回合（新的在前）列出当前分支上有效的摘要片段 */
const turnRows = computed(() =>
  [...turns.value].reverse().map((turn) => {
    const segs = resolveValidStorySegments(turns.value, summaries.value)
      .map(({ segment }) => segment)
      .filter((s) => s.sourceTurnKey === turn.key)
      .sort((a, b) => a.order - b.order);
    return {
      turn,
      segments: segs,
      hasInvalidSummary:
        segs.length === 0 && summaries.value.some((s) => s.sourceTurnKey === turn.key),
    };
  }),
);

const selectedArchive = computed(
  () => activeArchives.value.find((a) => a.id === selectedArchiveId.value) ?? null,
);
const selectedSourceTurns = computed<StoryTurn[]>(() =>
  selectedArchive.value
    ? collectArchiveSourceTurns(turns.value, selectedArchive.value, summaries.value)
    : [],
);

const DETAIL_FIELDS: Array<{ key: keyof StoryArchiveRecord['detail']; label: string }> = [
  { key: 'cause', label: '起因' },
  { key: 'process', label: '经过' },
  { key: 'ending', label: '结局' },
  { key: 'promises', label: '约定' },
  { key: 'impact', label: '持续影响' },
];

function summaryTime(s: StoryTurnSummaryRecord): string {
  if (!s.gameTimeRange) return '未知（未记录）';
  const { start, end } = s.gameTimeRange;
  return `${start ? formatGameTime(start) : '未知'} — ${end ? formatGameTime(end) : '未知'}`;
}

function summaryEntities(values: string[] | undefined): string {
  return values === undefined ? '未知（未记录）' : values.join('、') || '无';
}

function toggleTurn(key: string): void {
  const next = new Set(expandedTurns.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedTurns.value = next;
}

function storyText(turn: StoryTurn): string {
  return turn.storyMessages.map((m) => m.content).join('\n\n');
}
</script>

<template>
  <div class="v2-memory">
    <!-- ========== 归档详情 ========== -->
    <div v-if="selectedArchive" class="v2-detail">
      <div class="detail-toolbar">
        <button class="back-btn" aria-label="返回长期总览" @click="selectedArchiveId = null">
          ← 返回
        </button>
        <span class="detail-title">{{ selectedArchive.eventName }}</span>
        <span class="outcome-chip" :class="`outcome-${selectedArchive.outcome}`">
          {{ storyArchiveOutcomeLabel(selectedArchive.outcome) }}
        </span>
      </div>
      <div class="detail-scroll">
        <span class="section-label">概括</span>
        <p class="detail-text">{{ selectedArchive.overview }}</p>

        <span class="section-label">详细记录</span>
        <p class="detail-source">
          {{
            selectedArchive.detailSource === 'source-text'
              ? '依据事件原文整理'
              : '原文整理未成功，以下依据摘要写成'
          }}
        </p>
        <dl class="detail-fields">
          <template v-for="field in DETAIL_FIELDS" :key="field.key">
            <template v-if="selectedArchive.detail[field.key]">
              <dt>{{ field.label }}</dt>
              <dd>{{ selectedArchive.detail[field.key] }}</dd>
            </template>
          </template>
        </dl>

        <span class="section-label">结局依据</span>
        <blockquote class="detail-quote">{{ selectedArchive.evidence }}</blockquote>

        <span class="section-label">来源原文（{{ selectedSourceTurns.length }} 个回合）</span>
        <div v-for="turn in selectedSourceTurns" :key="turn.key" class="source-turn">
          <span class="turn-tag">第 {{ turnNumber.get(turn.key) }} 回合</span>
          <p v-if="turn.userMessage" class="source-user">玩家：{{ turn.userMessage.content }}</p>
          <p class="source-story">{{ storyText(turn) }}</p>
        </div>
      </div>
    </div>

    <!-- ========== 三栏 ========== -->
    <template v-else>
      <div class="v2-tabs" role="tablist" aria-label="新模式记忆">
        <button
          v-for="t in TABS"
          :key="t.id"
          role="tab"
          class="v2-tab"
          :class="{ active: tab === t.id }"
          :aria-selected="tab === t.id"
          @click="tab = t.id"
        >
          {{ t.label }}
        </button>
      </div>

      <p v-if="loadError" class="v2-empty" role="alert">记忆读取失败，请稍后重新打开面板。</p>

      <!-- 长期总览 -->
      <div v-else-if="tab === 'overview'" class="v2-list" role="tabpanel">
        <p class="v2-hint">事件结束并归档后写入这里，按发生先后排列；回退到归档之前会自动撤回。</p>
        <button
          v-for="a in activeArchives"
          :key="a.id"
          class="v2-card archive-card"
          :aria-label="`查看归档：${a.eventName}`"
          @click="selectedArchiveId = a.id"
        >
          <span class="card-head">
            <span class="card-name">{{ a.eventName }}</span>
            <span class="outcome-chip" :class="`outcome-${a.outcome}`">
              {{ storyArchiveOutcomeLabel(a.outcome) }}
            </span>
          </span>
          <span class="card-body">{{ a.overview }}</span>
        </button>
        <p v-if="activeArchives.length === 0" class="v2-empty">还没有事件结束。</p>
      </div>

      <!-- 未结事件 -->
      <div v-else-if="tab === 'open'" class="v2-list" role="tabpanel">
        <p class="v2-hint">每回合总结前会先对照这里判断事件是否结束。</p>
        <div v-for="event in openEvents" :key="event.eventName" class="v2-card">
          <span class="card-name">{{ event.eventName }}</span>
          <ul class="seg-list">
            <li v-for="s in event.segments" :key="s.id">{{ s.content }}</li>
          </ul>
        </div>
        <p v-if="openEvents.length === 0" class="v2-empty">当前没有未结束的事件。</p>
      </div>

      <!-- 短期摘要 -->
      <div v-else class="v2-list" role="tabpanel">
        <p class="v2-hint">
          每个完成的回合都会生成摘要；标「已归档」的摘要不再常驻上下文，但仍保留可查。
        </p>
        <div v-for="row in turnRows" :key="row.turn.key" class="v2-card">
          <span class="card-head">
            <span class="turn-tag">第 {{ turnNumber.get(row.turn.key) }} 回合</span>
            <button
              class="link-btn"
              :aria-expanded="expandedTurns.has(row.turn.key)"
              @click="toggleTurn(row.turn.key)"
            >
              {{ expandedTurns.has(row.turn.key) ? '收起原文' : '查看原文' }}
            </button>
          </span>
          <ul v-if="row.segments.length > 0" class="seg-list">
            <li v-for="s in row.segments" :key="s.id">
              <span v-if="s.eventName" class="event-tag">{{ s.eventName }}</span>
              {{ s.content }}
              <span v-if="coveredIds.has(s.id)" class="archived-tag">已归档</span>
              <dl class="summary-locators" aria-label="摘要定位信息">
                <dt>时间范围</dt>
                <dd>{{ summaryTime(s) }}</dd>
                <dt>人物</dt>
                <dd>{{ summaryEntities(s.characters) }}</dd>
                <dt>地点</dt>
                <dd>{{ summaryEntities(s.locations) }}</dd>
                <dt>主题</dt>
                <dd>{{ summaryEntities(s.topics) }}</dd>
              </dl>
            </li>
          </ul>
          <p v-else class="missing">
            {{
              row.hasInvalidSummary
                ? '旧摘要来源指纹缺失或原文已修订，无法验证，需重新补建；本轮上下文以原文代替。'
                : '本回合没有摘要，上下文会以原文代替。'
            }}
          </p>
          <div v-if="expandedTurns.has(row.turn.key)" class="source-turn">
            <p v-if="row.turn.userMessage" class="source-user">
              玩家：{{ row.turn.userMessage.content }}
            </p>
            <p class="source-story">{{ storyText(row.turn) }}</p>
          </div>
        </div>
        <p v-if="turnRows.length === 0" class="v2-empty">还没有完成的回合。</p>
      </div>
    </template>
  </div>
</template>

<style scoped>
.summary-locators {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--theme-spacing-xs) var(--theme-spacing-md);
  margin: var(--theme-spacing-sm) 0;
  font-size: 0.75rem;
}
.summary-locators dt {
  color: var(--theme-text-muted);
}
.summary-locators dd {
  margin: 0;
  overflow-wrap: anywhere;
}
.v2-memory {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: var(--theme-spacing-sm);
}
/* 分段按钮式 Tab（design.md §4.3） */
.v2-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  flex-shrink: 0;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-md);
}
.v2-tab {
  flex: 1;
  min-height: 2rem;
  padding: 0 var(--theme-spacing-md);
  font-family: inherit;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  transition:
    background-color var(--theme-transition-fast),
    color var(--theme-transition-fast);
}
.v2-tab:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.v2-tab.active {
  background: var(--theme-card-bg);
  color: var(--theme-text-primary);
  font-weight: 600;
  box-shadow: var(--theme-shadow-sm);
}
.v2-tab:focus-visible,
.v2-card:focus-visible,
.back-btn:focus-visible,
.link-btn:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: 1px;
}
.v2-list,
.detail-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.v2-hint {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.v2-card {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-md);
  text-align: left;
  font-family: inherit;
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.archive-card {
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast),
    background-color var(--theme-transition-fast);
}
.archive-card:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.card-name {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.card-body,
.seg-list,
.detail-text,
.detail-fields dd {
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-primary);
}
.seg-list {
  margin: 0;
  padding-left: 1.1em;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.outcome-chip,
.event-tag,
.archived-tag,
.turn-tag {
  display: inline-block;
  flex-shrink: 0;
  padding: 0 var(--theme-spacing-xs);
  font-size: 0.6875rem;
  line-height: 1.5;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-muted);
}
.outcome-completed {
  color: var(--theme-success);
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--theme-success) 30%, var(--theme-card-border));
}
.outcome-abandoned {
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border-color: color-mix(in srgb, var(--theme-warning) 30%, var(--theme-card-border));
}
.outcome-failed {
  color: var(--theme-error);
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  border-color: color-mix(in srgb, var(--theme-error) 30%, var(--theme-card-border));
}
.event-tag {
  margin-right: var(--theme-spacing-xs);
  color: var(--theme-primary);
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.archived-tag {
  margin-left: var(--theme-spacing-xs);
}
.link-btn {
  padding: 0;
  font-family: inherit;
  font-size: 0.75rem;
  color: var(--theme-primary);
  background: none;
  border: none;
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}
.missing {
  margin: 0;
  font-size: 0.75rem;
  font-style: italic;
  color: var(--theme-text-muted);
}
.source-turn {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
  padding: var(--theme-spacing-sm);
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm);
}
.source-user,
.source-story {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}
.source-user {
  color: var(--theme-text-secondary);
}
.source-story {
  font-family: var(--theme-font-title);
  color: var(--theme-text-primary);
}
.v2-empty {
  padding: var(--theme-spacing-2xl) 0;
  text-align: center;
  font-size: 0.8125rem;
  font-style: italic;
  color: var(--theme-text-muted);
}
/* ===== 归档详情 ===== */
.v2-detail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: var(--theme-spacing-sm);
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
    border-color var(--theme-transition-fast);
}
.back-btn:hover {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 45%, var(--theme-card-border));
}
.detail-title {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
/* Section 标题装饰线（design.md §5.1） */
.section-label {
  display: flex;
  align-items: center;
  gap: 6px;
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
.detail-text {
  margin: 0;
}
.detail-source {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.detail-fields {
  margin: 0;
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: var(--theme-spacing-xs) var(--theme-spacing-md);
}
.detail-fields dt {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.detail-fields dd {
  margin: 0;
  white-space: pre-wrap;
}
.detail-quote {
  margin: 0;
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
  font-family: var(--theme-font-title);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-sm);
}
@media (prefers-reduced-motion: reduce) {
  .v2-tab,
  .archive-card,
  .back-btn {
    transition: none;
  }
}
</style>
