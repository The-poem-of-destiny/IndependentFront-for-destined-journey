<script setup lang="ts">
import { ref } from 'vue'
import AppButton from '../shared/AppButton.vue'

const props = defineProps<{ outline: any; chapters: any[]; isGenerating: boolean; revealed: boolean }>()
defineEmits<{ reveal: []; regenerate: [] }>()

const expandedChapters = ref<Set<number>>(new Set())

function toggleChapter(idx: number) {
  const ns = new Set(expandedChapters.value)
  ns.has(idx) ? ns.delete(idx) : ns.add(idx)
  expandedChapters.value = ns
}

function formatTimeRange(tr: { start?: string; end?: string } | undefined): string {
  if (!tr?.start) return ''
  if (!tr.end || tr.end === tr.start) return tr.start
  return `${tr.start} ~ ${tr.end}`
}
</script>

<template>
  <div class="outline-preview">
    <!-- 未生成 -->
    <div v-if="!outline && !isGenerating" class="outline-empty">
      ─ 尚未生成剧情大纲 ─
    </div>

    <!-- 生成中 -->
    <div v-if="isGenerating" class="outline-loading">
      <div class="shimmer" />
      <p>AI 正在生成剧情大纲，请耐心等待…</p>
    </div>

    <!-- 已生成：模糊遮罩 -->
    <template v-if="outline && !isGenerating">
      <div v-if="!revealed" class="outline-blur-layer">
        <p class="outline-blur-hint">大纲已生成 — 点击下方按钮查看</p>
        <AppButton size="sm" @click="$emit('reveal')">点击查看大纲</AppButton>
      </div>

      <!-- 已揭示 -->
      <div v-else class="outline-body">
        <!-- 头部 -->
        <div class="outline-header">
          <h4 class="outline-title">{{ outline.title || '（无标题）' }}</h4>
          <p v-if="outline.summary" class="outline-summary">{{ outline.summary }}</p>
          <p v-if="outline.timeRange?.start" class="outline-time">
            {{ formatTimeRange(outline.timeRange) }}
          </p>
          <p v-if="outline.version && outline.version > 1" class="outline-version">
            （第 {{ outline.version }} 版）
          </p>
        </div>

        <!-- 叙事正文 -->
        <div v-if="outline.content" class="outline-content">
          <h5 class="sec-title">叙事大纲</h5>
          <pre class="content-text">{{ outline.content }}</pre>
        </div>

        <!-- 章节列表 -->
        <div v-if="props.chapters?.length" class="outline-chapters">
          <h5 class="sec-title">章节总览（{{ props.chapters.length }} 章）</h5>
          <div v-for="(ch, idx) in props.chapters" :key="idx" class="chapter-item">
            <div
              class="chapter-header"
              :class="{ expanded: expandedChapters.has(idx) }"
              @click="toggleChapter(idx)"
            >
              <span class="chapter-toggle">{{ expandedChapters.has(idx) ? '▾' : '▸' }}</span>
              <span class="chapter-title">{{ ch.title || '第 ' + (idx + 1) + ' 章' }}</span>
              <span v-if="ch.status" class="chapter-badge" :class="'badge-' + ch.status">{{ ch.status }}</span>
            </div>
            <div v-if="expandedChapters.has(idx)" class="chapter-body">
              <p v-if="ch.summary" class="chapter-summary">{{ ch.summary }}</p>
              <!-- keyEvents -->
              <ul v-if="ch.keyEvents?.length" class="event-list">
                <li v-for="(ev, j) in ch.keyEvents" :key="j" class="event-item">
                  <div class="event-title-row">
                    <span class="event-bullet" />
                    <strong>{{ ev.title }}</strong>
                    <span v-if="ev.timeWindow?.start" class="event-time">
                      {{ ev.timeWindow.end && ev.timeWindow.end !== ev.timeWindow.start ? ev.timeWindow.start + ' ~ ' + ev.timeWindow.end : ev.timeWindow.start }}
                    </span>
                  </div>
                  <p v-if="ev.description" class="event-desc">{{ ev.description }}</p>
                  <div class="event-conditions">
                    <span v-if="ev.triggerHint" class="cond">{{ ev.triggerHint }}</span>
                    <span v-if="ev.completeHint" class="cond">{{ ev.completeHint }}</span>
                    <span v-if="ev.failHint" class="cond">{{ ev.failHint }}</span>
                  </div>
                </li>
              </ul>
            </div>
          </div>
        </div>

        <!-- 自检 -->
        <div v-if="outline.selfCritique" class="outline-critique">
          <h5 class="sec-title">—— 自检</h5>
          <pre class="critique-text">{{ outline.selfCritique }}</pre>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.outline-preview {
  border: 1px dashed var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  padding: var(--theme-spacing-md);
  min-height: 80px;
  max-height: 500px;
  overflow-y: auto;
}

/* Empty & Loading */
.outline-empty { color: var(--theme-text-muted); font-size: 0.8rem; text-align: center; }
.outline-loading { text-align: center; color: var(--theme-text-muted); font-size: 0.8rem; }
.shimmer {
  width: 100%; height: 40px;
  background: linear-gradient(90deg, var(--theme-card-border) 25%, var(--theme-card-bg) 50%, var(--theme-card-border) 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
  border-radius: var(--theme-radius-sm);
  margin-bottom: var(--theme-spacing-sm);
}
@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .shimmer { animation: none; }
}

/* Blur layer */
.outline-blur-layer {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.outline-blur-hint {
  color: var(--theme-text-muted);
  font-size: 0.9rem;
}

/* Body */
.outline-body {
  text-align: left;
}
.sec-title {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  margin: var(--theme-spacing-sm) 0 var(--theme-spacing-xs);
  text-transform: none;
  letter-spacing: 0;
}

/* Header */
.outline-header {
  margin-bottom: var(--theme-spacing-sm);
}
.outline-title {
  font-size: 1rem;
  font-weight: 700;
  color: var(--theme-text-primary);
  margin: 0 0 4px;
}
.outline-summary {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  margin: 0 0 4px;
}
.outline-time {
  font-size: 0.7rem;
  color: var(--theme-text-secondary);
  margin: 0;
}
.outline-version {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  margin: 2px 0 0;
}

/* Content */
.outline-content { margin-bottom: var(--theme-spacing-sm); }
.content-text {
  font-size: 0.7rem;
  color: var(--theme-text-secondary);
  white-space: pre-wrap;
  word-break: break-word;
  font-family: inherit;
  margin: 0;
  line-height: 1.5;
}

/* Chapters */
.outline-chapters { margin-bottom: var(--theme-spacing-sm); }
.chapter-item {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  margin-bottom: 4px;
  overflow: hidden;
}
.chapter-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  cursor: pointer;
  font-size: 0.75rem;
  color: var(--theme-text-primary);
  transition: background-color 0.2s;
}
.chapter-header:hover { background-color: var(--theme-card-bg); }
.chapter-toggle { font-size: 0.65rem; color: var(--theme-text-muted); min-width: 12px; }
.chapter-title { flex: 1; font-weight: 600; }
.chapter-badge { font-size: 0.55rem; padding: 1px 6px; border-radius: 10px; }
.badge-pending { background: var(--theme-badge-bg, #333); color: var(--theme-text-muted); }
.badge-active { background: var(--theme-accent); color: #fff; }
.badge-completed { background: var(--theme-success, #4a4); color: #fff; }
.chapter-body { padding: 6px 8px 8px 24px; }
.chapter-summary { font-size: 0.7rem; color: var(--theme-text-secondary); margin: 0 0 6px; }

/* Events */
.event-list { list-style: none; padding: 0; margin: 0; }
.event-item { padding: 4px 0; border-bottom: 1px solid var(--theme-card-border); }
.event-item:last-child { border-bottom: none; }
.event-title-row { display: flex; align-items: center; gap: 6px; font-size: 0.7rem; }
.event-bullet { width: 4px; height: 4px; background: var(--theme-accent); border-radius: 50%; flex-shrink: 0; }
.event-time { font-size: 0.6rem; color: var(--theme-text-muted); margin-left: auto; }
.event-desc { font-size: 0.65rem; color: var(--theme-text-secondary); margin: 2px 0 2px 10px; }
.event-conditions { display: flex; flex-wrap: wrap; gap: 4px; margin-left: 10px; }
.cond {
  font-size: 0.6rem;
  color: var(--theme-text-muted);
  background: var(--theme-card-bg);
  padding: 1px 5px;
  border-radius: 3px;
}

/* Critique */
.outline-critique { }
.critique-text {
  font-size: 0.65rem;
  color: var(--theme-text-muted);
  white-space: pre-wrap;
  font-family: inherit;
  margin: 0;
}
</style>
