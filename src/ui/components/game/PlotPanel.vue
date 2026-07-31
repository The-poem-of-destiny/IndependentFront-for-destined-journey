<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import type { PlotEvent } from '@engine/types';
import { useGameStore } from '../../stores/game-store';

const game = useGameStore();

const outline = computed(() => game.plotOutline);
const events = computed(() => game.activePlotEvents);

const plotMode = computed<string>(() => {
  return (game.activeSave?.metadata as any)?.plotSettings?.mode ?? 'off';
});

// ═══ 剧透模式（UI 临时态，不写库） ═══
const spoilerMode = ref(false);
const peeked = ref(new Set<string>());

watch(spoilerMode, (on) => {
  if (!on) peeked.value = new Set();
});

function isMasked(ev: PlotEvent): boolean {
  return ev.visibility !== 'revealed' && !peeked.value.has(ev.id);
}

function peekEvent(ev: PlotEvent) {
  if (!spoilerMode.value) return;
  const next = new Set(peeked.value);
  next.add(ev.id);
  peeked.value = next;
}

// ═══ 章节分组 ═══
interface ChapterGroup {
  title: string;
  summary: string;
  status: 'pending' | 'active' | 'completed';
  events: PlotEvent[];
  isOther: boolean;
}

const chapterGroups = computed<ChapterGroup[]>(() => {
  const chapters = outline.value?.chapters ?? [];
  const evs = events.value;
  const known = new Set(chapters.map((c) => c.title));
  const groups: ChapterGroup[] = chapters.map((c) => ({
    title: c.title,
    summary: c.summary,
    status: c.status,
    events: evs.filter((e) => e.chapterTitle === c.title),
    isOther: false,
  }));
  const others = evs.filter((e) => !e.chapterTitle || !known.has(e.chapterTitle));
  if (others.length > 0) {
    groups.push({ title: '其他', summary: '', status: 'pending', events: others, isOther: true });
  }
  return groups;
});

const chapterTotal = computed(() => outline.value?.chapters.length ?? 0);
const chapterDone = computed(
  () => (outline.value?.chapters ?? []).filter((c) => c.status === 'completed').length,
);

const worldLineShifts = computed(() => {
  const v = outline.value?.version ?? 1;
  return v > 1 ? v - 1 : 0;
});

// ═══ 手风琴展开态（默认展开活跃章节） ═══
const expanded = ref(new Set<string>());

watch(
  outline,
  (o) => {
    if (!o) return;
    const next = new Set(expanded.value);
    for (const c of o.chapters) {
      if (c.status === 'active') next.add(c.title);
    }
    expanded.value = next;
  },
  { immediate: true },
);

function toggleChapter(title: string) {
  const next = new Set(expanded.value);
  if (next.has(title)) next.delete(title);
  else next.add(title);
  expanded.value = next;
}

// ═══ 事件状态徽标 ═══
const STATUS_BADGE: Record<string, { icon: string; label: string; cls: string }> = {
  active: { icon: '', label: '活跃', cls: 'st-active' },
  pending: { icon: '', label: '待触发', cls: 'st-pending' },
  completed: { icon: '', label: '已完成', cls: 'st-completed' },
  failed: { icon: '', label: '失败', cls: 'st-failed' },
  skipped: { icon: '', label: '已跳过', cls: 'st-skipped' },
};

function badgeOf(ev: PlotEvent) {
  return STATUS_BADGE[ev.status] ?? STATUS_BADGE.pending;
}

const EMPTY_TEXT: Record<string, string> = {
  off: '剧情系统未启用——本档创建时选择了「关闭」模式，命运的书页由你亲手书写…',
  side: '支线模式——年度支线剧情将在游戏进行中自动生成，书页尚待落墨…',
  main: '主线模式——剧情大纲尚未生成，命运之诗即将开篇…',
};
const emptyText = computed(() => EMPTY_TEXT[plotMode.value] ?? EMPTY_TEXT.off);
</script>

<template>
  <div class="plot-panel">
    <template v-if="outline">
      <!-- ═══ 头部 ═══ -->
      <div class="outline-header">
        <div class="oh-title-row">
          <span class="oh-title">{{ outline.title || '未命名大纲' }}</span>
          <button
            class="spoiler-toggle"
            :class="{ on: spoilerMode }"
            :aria-pressed="spoilerMode"
            :aria-label="spoilerMode ? '关闭剧透模式' : '开启剧透模式'"
            :title="
              spoilerMode
                ? '关闭剧透模式（重新蒙回全部未揭示事件）'
                : '开启剧透模式（可逐条点击揭示）'
            "
            @click="spoilerMode = !spoilerMode"
          >
            <i :class="spoilerMode ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" />
            <span>剧透模式</span>
          </button>
        </div>
        <p v-if="outline.summary" class="oh-summary">{{ outline.summary }}</p>
        <div class="oh-meta">
          <span v-if="worldLineShifts > 0" class="oh-badge shift"
            >世界线已变动×{{ worldLineShifts }}</span
          >
          <span v-if="chapterTotal > 0" class="oh-badge progress"
            >章节进度 {{ chapterDone }}/{{ chapterTotal }}</span
          >
        </div>
      </div>

      <!-- ═══ 章节手风琴 ═══ -->
      <div class="chapter-list">
        <div
          v-for="group in chapterGroups"
          :key="group.title"
          class="chapter-item"
          :class="'ch-' + group.status"
        >
          <button
            class="chap-header"
            :aria-expanded="expanded.has(group.title)"
            @click="toggleChapter(group.title)"
          >
            <span class="chap-dot" :class="'dot-' + group.status" />
            <span class="chap-title">{{ group.title }}</span>
            <span v-if="group.events.length > 0" class="chap-count"
              >{{ group.events.length }} 事件</span
            >
            <span class="chap-chevron" :class="{ open: expanded.has(group.title) }">▸</span>
          </button>

          <div class="chap-body" :class="{ open: expanded.has(group.title) }">
            <div class="chap-inner">
              <p v-if="group.summary" class="chap-summary">{{ group.summary }}</p>

              <div v-if="group.events.length > 0" class="event-list">
                <template v-for="ev in group.events" :key="ev.id">
                  <Transition name="peek" mode="out-in">
                    <div
                      v-if="isMasked(ev)"
                      key="masked"
                      class="event-card masked"
                      :class="{ peekable: spoilerMode }"
                      :role="spoilerMode ? 'button' : undefined"
                      :tabindex="spoilerMode ? 0 : undefined"
                      :aria-label="spoilerMode ? '点击揭示隐藏事件' : '隐藏事件'"
                      @click="peekEvent(ev)"
                      @keydown.enter="peekEvent(ev)"
                    >
                      <span class="masked-text">？？？</span>
                      <span v-if="spoilerMode" class="masked-hint">点击揭示</span>
                    </div>
                    <div v-else key="revealed" class="event-card">
                      <div class="ev-header">
                        <span class="ev-title">{{ ev.title }}</span>
                        <span class="ev-badge" :class="badgeOf(ev).cls"
                          >{{ badgeOf(ev).icon }} {{ badgeOf(ev).label }}</span
                        >
                      </div>
                      <p v-if="ev.description" class="ev-desc">{{ ev.description }}</p>
                    </div>
                  </Transition>
                </template>
              </div>
              <div v-else class="event-empty">本章暂无事件</div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="empty-tab">{{ emptyText }}</div>
  </div>
</template>

<style scoped>
.plot-panel {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  min-height: 400px;
}

/* ═══ 头部 ═══ */
.outline-header {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  box-shadow:
    0 1px 0 0 color-mix(in srgb, var(--theme-card-border) 40%, transparent),
    0 4px 12px rgba(0, 0, 0, 0.08);
}
.oh-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.oh-title {
  font-family: var(--theme-font-title, serif);
  font-size: 1.125rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.spoiler-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  min-height: 36px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease),
    border-color var(--theme-transition-fast, 0.15s ease);
  flex-shrink: 0;
}
.spoiler-toggle:hover {
  color: var(--theme-text-primary);
  background: var(--theme-tab-hover-bg);
}
.spoiler-toggle.on {
  background: color-mix(in srgb, var(--theme-primary) 8%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  color: var(--theme-primary);
}
.oh-summary {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.55;
}
.oh-meta {
  display: flex;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
.oh-badge {
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 2px 10px;
  border-radius: 10px;
}
.oh-badge.shift {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.oh-badge.progress {
  background: var(--theme-surface-muted);
  color: var(--theme-text-secondary);
  border: 1px solid var(--theme-card-border);
}

/* ═══ 章节手风琴 ═══ */
.chapter-list {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.chapter-item {
  background: var(--theme-card-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  overflow: hidden;
}
.chapter-item.ch-active {
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-card-bg));
  border-color: color-mix(in srgb, var(--theme-primary) 25%, var(--theme-card-border));
}
.chapter-item.ch-completed {
  border-color: color-mix(in srgb, var(--theme-success) 25%, var(--theme-card-border));
}
.chap-header {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  width: 100%;
  min-height: 40px;
  padding: 10px var(--theme-spacing-md);
  border: none;
  background: transparent;
  color: var(--theme-text-primary);
  font-family: inherit;
  font-size: 0.875rem;
  text-align: left;
  cursor: pointer;
  transition: background var(--theme-transition-fast, 0.15s ease);
}
.chap-header:hover {
  background: var(--theme-tab-hover-bg);
}
.chap-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot-pending {
  background: var(--theme-text-muted);
}
.dot-active {
  background: var(--theme-primary);
}
.dot-completed {
  background: var(--theme-success);
}
.chap-title {
  flex: 1;
  font-family: var(--theme-font-title, serif);
  font-weight: 600;
}
.ch-pending .chap-title {
  color: var(--theme-text-secondary);
}
.ch-active .chap-title {
  color: var(--theme-primary);
}
.chap-count {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.chap-chevron {
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  transition: transform 0.25s ease;
}
.chap-chevron.open {
  transform: rotate(90deg);
}

.chap-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.25s ease;
}
.chap-body.open {
  grid-template-rows: 1fr;
}
.chap-inner {
  overflow: hidden;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  padding: 0 var(--theme-spacing-md);
}
.chap-body.open .chap-inner {
  padding-bottom: var(--theme-spacing-md);
}
.chap-summary {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.55;
}

/* ═══ 事件卡片 ═══ */
.event-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.event-card {
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ev-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.ev-title {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.ev-badge {
  font-size: 0.625rem;
  font-weight: 600;
  padding: 1px 8px;
  border-radius: 10px;
  flex-shrink: 0;
}
.st-active {
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  color: var(--theme-primary);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, transparent);
}
.st-pending {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.st-completed {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 30%, transparent);
}
.st-failed {
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
  border: 1px solid color-mix(in srgb, var(--theme-error) 30%, transparent);
}
.st-skipped {
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}
.ev-desc {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.55;
}

/* ═══ 蒙层卡片 ═══ */
.event-card.masked {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  background: color-mix(in srgb, var(--theme-text-muted) 6%, var(--theme-surface-muted));
  border-style: dashed;
  user-select: none;
}
.event-card.masked.peekable {
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast, 0.15s ease),
    background var(--theme-transition-fast, 0.15s ease);
}
.event-card.masked.peekable:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
}
.masked-text {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.3em;
  color: var(--theme-text-muted);
}
.masked-hint {
  font-size: 0.625rem;
  color: color-mix(in srgb, var(--theme-primary) 70%, var(--theme-text-muted));
}

.event-empty {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--theme-text-muted);
  padding: 4px 0;
}

/* ═══ 揭示过渡 ═══ */
.peek-enter-active,
.peek-leave-active {
  transition: opacity 0.2s ease;
}
.peek-enter-from,
.peek-leave-to {
  opacity: 0;
}

/* ═══ 空态 ═══ */
.empty-tab {
  padding: var(--theme-spacing-2xl) 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: var(--theme-spacing-sm);
  font-size: 1.25rem;
  opacity: 0.3;
}

@media (prefers-reduced-motion: reduce) {
  .chap-body,
  .chap-chevron,
  .peek-enter-active,
  .peek-leave-active,
  .spoiler-toggle,
  .chap-header,
  .event-card.masked.peekable {
    transition: none;
  }
}
</style>
