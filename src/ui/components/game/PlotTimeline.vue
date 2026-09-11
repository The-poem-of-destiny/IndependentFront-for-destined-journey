<script setup lang="ts">
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { getPlotThreadFlags } from '@engine/save-profile';
import { toEpochMinutes } from '@engine/time-system';
import { useGameStore } from '../../stores/game-store';
import { buildThreadDisplayView } from './plot-thread-view';
import { buildPlotTimeline, type TimelineNodeBox } from './plot-timeline';

/**
 * PlotTimeline.vue — 剧情时间线（ComfyUI 式连线图铺在可按天缩放的时间轴上）
 *
 * 布局判定全在纯函数 `plot-timeline.ts`；本组件负责画出来 + 交互：
 *   - **时间缩放**：一条标尺 + 缩放控件，横向放大/缩小时间跨度（`pxPerDay`）；
 *   - **定位到现在**：一键把「现在」游标滚到视口中央；
 *   - 剧透模式 / 逐条揭示。
 * 数据源与 PlotPanel / PlotThreadsPanel 同源（game store + saveProfile）。
 */
const game = useGameStore();

// ═══ 缩放（px / 天）═══
const MIN_PX_PER_DAY = 3;
const MAX_PX_PER_DAY = 240;
const pxPerDay = ref(26);
const scrollEl = ref<HTMLElement | null>(null);

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// ═══ 剧透模式 + 逐条临时揭示（会话内存态，不写库）═══
const spoilerMode = ref(false);
const peekedEvents = ref(new Set<string>());
const peekedThreads = ref(new Set<string>());

watch(spoilerMode, (on) => {
  if (!on) {
    peekedEvents.value = new Set();
    peekedThreads.value = new Set();
  }
});
watch(
  () => game.activeSaveId,
  () => {
    spoilerMode.value = false;
    peekedEvents.value = new Set();
    peekedThreads.value = new Set();
    nextTick(() => locateNow());
  },
);

const threadFlags = computed(() =>
  game.saveProfile ? getPlotThreadFlags(game.saveProfile) : null,
);
const threadView = computed(() =>
  threadFlags.value ? buildThreadDisplayView(threadFlags.value, peekedThreads.value) : null,
);

const nowEpochMinutes = computed(() => {
  const gt = game.saveProfile?.gameTime;
  return gt ? toEpochMinutes(gt) : null;
});

const model = computed(() =>
  buildPlotTimeline({
    events: game.activePlotEvents,
    threadView: threadView.value,
    nowEpochMinutes: nowEpochMinutes.value,
    peekedEventIds: peekedEvents.value,
    pxPerDay: pxPerDay.value,
  }),
);

function dayAtX(x: number): number {
  const a = model.value.anchor;
  return a.minDay + (x - a.startX) / a.pxPerDay;
}

/** 改缩放，并保持视口中心对应的日期不动 */
function setZoom(next: number) {
  const v = clamp(next, MIN_PX_PER_DAY, MAX_PX_PER_DAY);
  if (v === pxPerDay.value) return;
  const el = scrollEl.value;
  const centerX = el ? el.scrollLeft + el.clientWidth / 2 : null;
  const centerDay = centerX !== null ? dayAtX(centerX) : null;
  pxPerDay.value = v;
  if (el && centerDay !== null) {
    nextTick(() => {
      const a = model.value.anchor;
      el.scrollLeft = a.startX + (centerDay - a.minDay) * a.pxPerDay - el.clientWidth / 2;
    });
  }
}

function onSlider(e: Event) {
  setZoom(Number((e.target as HTMLInputElement).value));
}

function locateNow() {
  const el = scrollEl.value;
  const m = model.value;
  if (!el || m.nowX === null) return;
  el.scrollLeft = m.nowX - el.clientWidth / 2;
}

onMounted(() => nextTick(() => locateNow()));

function canPeek(masked: boolean): boolean {
  return spoilerMode.value && masked;
}

function peek(node: TimelineNodeBox) {
  if (!spoilerMode.value) return;
  if (node.kind === 'outline') {
    const next = new Set(peekedEvents.value);
    next.add(node.id);
    peekedEvents.value = next;
  } else {
    const next = new Set(peekedThreads.value);
    next.add(node.id);
    peekedThreads.value = next;
  }
}

/** 状态 → 语义色调 */
const TONE: Record<string, string> = {
  active: 'primary',
  pending: 'warning',
  dormant: 'warning',
  completed: 'success',
  resolved: 'success',
  failed: 'error',
  skipped: 'muted',
  dissolved: 'muted',
};
function tone(status: string): string {
  return TONE[status] ?? 'muted';
}
</script>

<template>
  <div class="plot-timeline" data-testid="plot-timeline">
    <!-- 工具条：计数 + 图例 + 缩放标尺 + 定位 + 剧透 -->
    <div class="tl-toolbar">
      <span class="tl-counts">
        大纲 {{ model.counts.outline }} · 事件线 {{ model.counts.thread }}
        <template v-if="model.counts.masked > 0">· {{ model.counts.masked }} 未揭示</template>
      </span>

      <div class="tl-legend">
        <span class="lg-item"><span class="lg-dot tone-outline" />大纲事件</span>
        <span class="lg-item"><span class="lg-dot tone-thread" />事件线节点</span>
        <span class="lg-item"><span class="lg-line" />连线</span>
      </div>

      <div class="tl-zoom" role="group" aria-label="时间缩放">
        <button
          class="tl-zbtn"
          aria-label="缩小时间轴"
          title="缩小时间轴"
          @click="setZoom(pxPerDay / 1.5)"
        >
          −
        </button>
        <input
          class="tl-range"
          type="range"
          :min="MIN_PX_PER_DAY"
          :max="MAX_PX_PER_DAY"
          step="1"
          :value="pxPerDay"
          aria-label="时间缩放标尺"
          @input="onSlider"
        />
        <button
          class="tl-zbtn"
          aria-label="放大时间轴"
          title="放大时间轴"
          @click="setZoom(pxPerDay * 1.5)"
        >
          ＋
        </button>
        <span class="tl-zoom-val">{{ Math.round(pxPerDay) }}px/天</span>
      </div>

      <button
        class="tl-btn"
        :disabled="model.nowX === null"
        title="把「现在」滚到视口中央"
        @click="locateNow"
      >
        定位到现在
      </button>

      <button
        class="spoiler-toggle"
        :class="{ on: spoilerMode }"
        :aria-pressed="spoilerMode"
        :aria-label="spoilerMode ? '关闭剧透模式' : '开启剧透模式'"
        :title="
          spoilerMode ? '关闭剧透模式（重新蒙回全部未揭示节点）' : '开启剧透模式（可逐条点击揭示）'
        "
        @click="spoilerMode = !spoilerMode"
      >
        <i :class="spoilerMode ? 'fa-solid fa-eye' : 'fa-solid fa-eye-slash'" />
        <span>剧透模式</span>
      </button>
    </div>

    <!-- 空态 -->
    <div v-if="model.isEmpty" class="empty-tab">
      尚无剧情锚点——大纲关键事件与主线明线暂时都没有落在时间轴上的足迹。
    </div>

    <!-- 时间线画布（横向滚动） -->
    <div v-else ref="scrollEl" class="tl-scroll">
      <div class="tl-canvas" :style="{ width: model.width + 'px', height: model.height + 'px' }">
        <!-- 未定时间竖条 -->
        <div
          v-if="model.unknownStripW > 0"
          class="tl-unknown"
          :style="{ width: model.unknownStripW + 'px' }"
        >
          <span class="tl-unknown-label">未定时间</span>
        </div>

        <!-- 时间标尺 -->
        <div class="tl-ruler" :style="{ height: model.rulerHeight + 'px' }">
          <div
            v-for="(t, i) in model.rulerTicks"
            :key="'tick' + i"
            class="tl-tick"
            :class="{ major: t.major }"
            :style="{ left: t.x + 'px' }"
          >
            <span class="tl-tick-label">{{ t.label }}</span>
          </div>
        </div>

        <!-- 章节跨度条 -->
        <div
          v-for="(b, i) in model.chapters"
          :key="'ch' + i"
          class="tl-chapter"
          :style="{ left: b.x + 'px', top: b.y + 'px', width: b.w + 'px' }"
          :title="b.name"
        >
          <span class="tl-chapter-name">{{ b.name }}</span>
        </div>

        <!-- 「现在」游标 -->
        <div
          v-if="model.nowX !== null"
          class="tl-now"
          :style="{ left: model.nowX + 'px', top: model.rulerHeight + 'px' }"
        >
          <span class="tl-now-label">现在</span>
        </div>

        <!-- 连线层 -->
        <svg class="tl-edges" :width="model.width" :height="model.height" aria-hidden="true">
          <path
            v-for="(e, i) in model.edges"
            :key="'edge' + i"
            :d="e.d"
            :class="'edge-' + e.kind"
          />
        </svg>

        <!-- 节点层 -->
        <div
          v-for="n in model.nodes"
          :key="n.kind + ':' + n.id"
          class="tl-node"
          :class="[
            'kind-' + n.kind,
            'tone-' + tone(n.status),
            { masked: n.masked, peekable: canPeek(n.masked) },
          ]"
          :style="{ left: n.x + 'px', top: n.y + 'px', width: n.w + 'px', height: n.h + 'px' }"
          :role="canPeek(n.masked) ? 'button' : undefined"
          :tabindex="canPeek(n.masked) ? 0 : undefined"
          :aria-label="canPeek(n.masked) ? '点击揭示隐藏的剧情节点' : undefined"
          :title="n.masked ? undefined : n.summary || n.title"
          @click="canPeek(n.masked) ? peek(n) : undefined"
          @keydown.enter="canPeek(n.masked) ? peek(n) : undefined"
        >
          <template v-if="n.masked">
            <span class="n-mask">？？？</span>
            <span v-if="spoilerMode" class="n-hint">点击揭示</span>
          </template>
          <template v-else>
            <span class="n-title">{{ n.title }}</span>
            <span v-if="n.summary" class="n-summary">{{ n.summary }}</span>
            <span class="n-badge">{{ n.statusLabel }}</span>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.plot-timeline {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}

/* ═══ 工具条 ═══ */
.tl-toolbar {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
.tl-counts {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.tl-legend {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-md);
  flex-wrap: wrap;
}
.lg-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
}
.lg-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  display: inline-block;
}
.lg-dot.tone-outline {
  background: var(--theme-primary);
}
.lg-dot.tone-thread {
  background: var(--theme-success);
}
.lg-line {
  width: 18px;
  height: 0;
  border-top: 2px solid var(--theme-text-secondary);
  display: inline-block;
}

.tl-zoom {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}
.tl-zbtn {
  width: 28px;
  height: 28px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.875rem;
  line-height: 1;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}
.tl-zbtn:hover {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.tl-range {
  width: 120px;
  accent-color: var(--theme-primary);
}
.tl-zoom-val {
  font-size: 0.625rem;
  color: var(--theme-text-muted);
  min-width: 46px;
  text-align: right;
}

.tl-btn {
  padding: 6px 12px;
  min-height: 32px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.75rem;
  font-family: inherit;
  cursor: pointer;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}
.tl-btn:hover:not(:disabled) {
  background: var(--theme-tab-hover-bg);
  color: var(--theme-text-primary);
}
.tl-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.spoiler-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  min-height: 32px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-muted);
  font-size: 0.75rem;
  font-family: inherit;
  cursor: pointer;
  flex-shrink: 0;
  transition:
    background var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease),
    border-color var(--theme-transition-fast, 0.15s ease);
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

/* ═══ 画布 ═══ */
.tl-scroll {
  overflow-x: auto;
  overflow-y: hidden;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
}
.tl-canvas {
  position: relative;
  min-width: 100%;
  min-height: 380px;
}

.tl-unknown {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  border-right: 1px solid var(--theme-card-border);
  background: color-mix(in srgb, var(--theme-text-muted) 5%, transparent);
  pointer-events: none;
}
.tl-unknown-label {
  position: absolute;
  top: 6px;
  left: 0;
  right: 0;
  text-align: center;
  font-size: 0.625rem;
  font-style: italic;
  color: var(--theme-text-muted);
}

.tl-ruler {
  position: absolute;
  left: 0;
  top: 0;
  right: 0;
}
.tl-tick {
  position: absolute;
  top: 12px;
  bottom: 0;
  border-left: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
}
.tl-tick.major {
  border-left-color: var(--theme-card-border);
}
.tl-tick-label {
  position: absolute;
  left: 4px;
  top: -10px;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  white-space: nowrap;
}

.tl-chapter {
  position: absolute;
  height: 26px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  overflow: hidden;
}
.tl-chapter-name {
  font-family: var(--theme-font-title, serif);
  font-size: 0.875rem;
  font-weight: 700;
  color: var(--theme-primary);
  letter-spacing: 0.02em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tl-now {
  position: absolute;
  bottom: 0;
  border-left: 2px dashed var(--theme-primary);
  opacity: 0.7;
  pointer-events: none;
}
.tl-now-label {
  position: absolute;
  top: -2px;
  left: 4px;
  font-size: 0.625rem;
  color: var(--theme-primary);
  white-space: nowrap;
}

.tl-edges {
  position: absolute;
  left: 0;
  top: 0;
  pointer-events: none;
}
.tl-edges path {
  fill: none;
  stroke-width: 1.6;
}
.tl-edges .edge-outline {
  stroke: color-mix(in srgb, var(--theme-primary) 45%, transparent);
}
.tl-edges .edge-thread {
  stroke: color-mix(in srgb, var(--theme-success) 70%, var(--theme-text-secondary));
}

/* ═══ 节点 ═══ */
.tl-node {
  position: absolute;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 3px;
  padding: 6px 9px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: var(--theme-surface-muted);
  overflow: hidden;
}
.tl-node.kind-thread {
  background: var(--theme-card-bg);
}
.tl-node .n-title {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl-node .n-summary {
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.35;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tl-node .n-badge {
  align-self: flex-start;
  font-size: 0.6875rem;
  font-weight: 600;
  padding: 0 7px;
  border-radius: 8px;
  white-space: nowrap;
}

/* 状态色调 */
.tl-node.tone-primary {
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
.tl-node.tone-primary .n-badge {
  background: color-mix(in srgb, var(--theme-primary) 12%, transparent);
  color: var(--theme-primary);
}
.tl-node.tone-warning .n-badge {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
}
.tl-node.tone-success .n-badge {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
}
.tl-node.tone-error .n-badge {
  background: color-mix(in srgb, var(--theme-error) 12%, transparent);
  color: var(--theme-error);
}
.tl-node.tone-muted .n-badge {
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}

/* 蒙版 */
.tl-node.masked {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  background: color-mix(in srgb, var(--theme-text-muted) 6%, var(--theme-surface-muted));
  border-style: dashed;
  user-select: none;
}
.tl-node.masked.peekable {
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast, 0.15s ease),
    background var(--theme-transition-fast, 0.15s ease);
}
.tl-node.masked.peekable:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-primary) 6%, var(--theme-surface-muted));
}
.n-mask {
  font-size: 0.8125rem;
  font-weight: 600;
  letter-spacing: 0.28em;
  color: var(--theme-text-muted);
}
.n-hint {
  font-size: 0.625rem;
  color: color-mix(in srgb, var(--theme-primary) 70%, var(--theme-text-muted));
}

/* ═══ 空态（design.md §5.2）═══ */
.empty-tab {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}

@media (prefers-reduced-motion: reduce) {
  .tl-zbtn,
  .tl-btn,
  .spoiler-toggle,
  .tl-node.masked.peekable {
    transition: none;
  }
}
</style>
