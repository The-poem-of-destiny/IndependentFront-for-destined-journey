<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { getPlotThreadFlags } from '@engine/save-profile';
import { fromEpochMinutes, formatGameTime } from '@engine/time-system';
import { useGameStore } from '../../stores/game-store';
import { buildThreadDisplayView, threadStatusLabel } from './plot-thread-view';

const game = useGameStore();

/** 🔴 只派生只读视图：不建第二份持久 store（实施计划 T5：从 saveProfile 派生） */
const flags = computed(() => (game.saveProfile ? getPlotThreadFlags(game.saveProfile) : null));

// ═══ 剧透模式 + 逐条临时 peek（会话内存态，不写库；关剧透/切档即清） ═══
const spoilerMode = ref(false);
const peeked = ref(new Set<string>());

watch(spoilerMode, (on) => {
  if (!on) peeked.value = new Set();
});
watch(
  () => game.activeSaveId,
  () => {
    spoilerMode.value = false;
    peeked.value = new Set();
  },
);

function peekNode(name: string) {
  if (!spoilerMode.value) return;
  const next = new Set(peeked.value);
  next.add(name);
  peeked.value = next;
}

const view = computed(() =>
  flags.value ? buildThreadDisplayView(flags.value, peeked.value) : null,
);

const allNodes = computed(() => view.value?.groups.flatMap((g) => g.nodes) ?? []);

const visibleEdges = computed(() => view.value?.edges.filter((e) => !e.masked) ?? []);

/**
 * 🔴 引用行过滤：节点卡详情里的「埋向/回收」名单只显示**可见端点**；
 * 靶子仍在蒙版 → 整条引用不显示（不允许「A 埋向: ??」任何形式出现）。
 * 前向引用（目标尚未出现在节点表里）→ 仅剧透模式显示（不把未出现目标当既有事实）。
 */
function visibleRefs(refs: string[]): string[] {
  return refs.filter((r) => {
    const target = allNodes.value.find((n) => n.name === r);
    if (!target) return spoilerMode.value;
    return !target.masked;
  });
}

const gameTime = computed(() => game.saveProfile?.gameTime);

function nodeTimeLabel(seededAt: number): string {
  if (!gameTime.value) return '';
  return formatGameTime(fromEpochMinutes(seededAt, gameTime.value.era));
}

function jumpToNode(name: string) {
  document.querySelector(`[data-thread-node="${CSS.escape(name)}"]`)?.scrollIntoView({
    behavior: 'smooth',
    block: 'center',
  });
}
</script>

<template>
  <div class="threads-panel" data-testid="plot-threads-panel">
    <div class="threads-header">
      <span class="threads-title">主线明线（事件线）</span>
      <span v-if="view && view.totalCount > 0" class="threads-count">
        {{ view.visibleCount }}/{{ view.totalCount }} 可见
      </span>
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

    <!-- 空态：缺字段/无节点 → 正常空态，不以零节点暗示功能报错 -->
    <div v-if="!flags || !view || view.totalCount === 0" class="threads-empty">
      尚未发现主线明线——世界在主线方向上暂时没有留下值得记录的足迹。
    </div>

    <template v-else>
      <!-- 按主线锚分组 -->
      <div
        v-for="group in view.groups"
        :key="group.thread"
        class="thread-group"
        :class="{ 'group-masked': !group.showLabel }"
        :data-thread-group="group.showLabel ? group.thread : 'masked'"
      >
        <div class="thread-group-label">
          {{ group.showLabel ? group.thread : '—— 未揭示 ——' }}
        </div>
        <div class="thread-cards">
          <div
            v-for="node in group.nodes"
            :key="node.name"
            class="thread-card"
            :class="{ masked: node.masked, peekable: spoilerMode && node.masked }"
            :data-thread-node="node.masked ? undefined : node.name"
            :role="spoilerMode && node.masked ? 'button' : undefined"
            :tabindex="spoilerMode && node.masked ? 0 : undefined"
            :aria-label="spoilerMode && node.masked ? '点击揭示隐藏的主线明线' : undefined"
            @click="spoilerMode && node.masked ? peekNode(node.name) : undefined"
            @keydown.enter="spoilerMode && node.masked ? peekNode(node.name) : undefined"
          >
            <!-- 蒙版：零字段进 DOM（名字/简述/分组/时间/人物都不出现） -->
            <template v-if="node.masked">
              <span class="masked-text">？？？</span>
              <span v-if="spoilerMode" class="masked-hint">点击揭示</span>
            </template>
            <template v-else>
              <div class="card-head">
                <span class="card-name">{{ node.name }}</span>
                <span class="card-badge" :class="'st-' + node.status">{{
                  threadStatusLabel(node.status)
                }}</span>
              </div>
              <p class="card-gist">{{ node.gist }}</p>
              <p v-if="node.involvedNpcs.length > 0" class="card-actors">
                涉及：{{ node.involvedNpcs.join('、') }}
              </p>
              <p class="card-time">{{ nodeTimeLabel(node.seededAt) }}</p>
              <!-- 详情：默认只给可见信息；motive 仅剧透模式 + 显式点开 -->
              <details class="card-details" :open="false">
                <summary>详情</summary>
                <p v-if="spoilerMode" class="card-motive">动机：{{ node.motive }}</p>
                <p v-if="visibleRefs(node.foreshadows).length > 0" class="card-refs">
                  埋向：{{ visibleRefs(node.foreshadows).join('、') }}
                </p>
                <p v-if="visibleRefs(node.payoffs).length > 0" class="card-refs">
                  回收：{{ visibleRefs(node.payoffs).join('、') }}
                </p>
                <p
                  v-if="
                    !spoilerMode &&
                    visibleRefs(node.foreshadows).length === 0 &&
                    visibleRefs(node.payoffs).length === 0
                  "
                  class="card-motive dim"
                >
                  （剧情细节在剧透模式下可见）
                </p>
              </details>
            </template>
          </div>
        </div>
      </div>

      <!-- 轻量方向连线：两端均可见的边；涉及隐藏端点的边整体遮蔽 -->
      <div v-if="visibleEdges.length > 0" class="thread-edges">
        <div class="edges-label">伏笔连线</div>
        <button
          v-for="(edge, i) in visibleEdges"
          :key="i"
          class="thread-edge"
          :title="`${edge.from} → ${edge.to}`"
          @click="jumpToNode(edge.from)"
        >
          {{ edge.from }} <span class="edge-arrow">→</span> {{ edge.to }}
        </button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.threads-panel {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
}
.threads-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
  flex-wrap: wrap;
}
.threads-title {
  font-family: var(--theme-font-title, serif);
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--theme-text-primary);
}
.threads-count {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  margin-right: auto;
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
.threads-empty {
  font-size: 0.75rem;
  font-style: italic;
  color: var(--theme-text-muted);
  padding: var(--theme-spacing-sm) 0;
}
.thread-group {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
}
.thread-group-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  padding-bottom: 2px;
  border-bottom: 1px solid var(--theme-card-border);
}
.group-masked .thread-group-label {
  letter-spacing: 0.2em;
  color: var(--theme-text-muted);
}
.thread-cards {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.thread-card {
  background: var(--theme-surface-muted);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.thread-card.masked {
  flex-direction: row;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  min-height: 32px;
  background: color-mix(in srgb, var(--theme-text-muted) 6%, var(--theme-surface-muted));
  border-style: dashed;
  user-select: none;
}
.thread-card.masked.peekable {
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast, 0.15s ease),
    background var(--theme-transition-fast, 0.15s ease);
}
.thread-card.masked.peekable:hover {
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
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--theme-spacing-sm);
}
.card-name {
  font-size: 0.8125rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.card-badge {
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
.st-dormant {
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  color: var(--theme-warning);
  border: 1px solid color-mix(in srgb, var(--theme-warning) 30%, transparent);
}
.st-resolved {
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  color: var(--theme-success);
  border: 1px solid color-mix(in srgb, var(--theme-success) 30%, transparent);
}
.st-dissolved {
  background: var(--theme-surface-muted);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}
.card-gist {
  margin: 0;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.55;
}
.card-actors,
.card-time {
  margin: 0;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.card-details summary {
  cursor: pointer;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  user-select: none;
}
.card-motive {
  margin: 4px 0 0;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  line-height: 1.55;
}
.card-motive.dim {
  color: var(--theme-text-muted);
  font-style: italic;
}
.card-refs {
  margin: 2px 0 0;
  font-size: 0.6875rem;
  color: var(--theme-text-secondary);
}
.thread-edges {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-top: 1px dashed var(--theme-card-border);
  padding-top: var(--theme-spacing-sm);
}
.edges-label {
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
}
.thread-edge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 2px 8px;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-secondary);
  font-size: 0.6875rem;
  font-family: inherit;
  cursor: pointer;
  transition:
    border-color var(--theme-transition-fast, 0.15s ease),
    color var(--theme-transition-fast, 0.15s ease);
}
.thread-edge:hover {
  border-color: color-mix(in srgb, var(--theme-primary) 40%, var(--theme-card-border));
  color: var(--theme-primary);
}
.edge-arrow {
  color: var(--theme-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .spoiler-toggle,
  .thread-card.masked.peekable,
  .thread-edge {
    transition: none;
  }
}
</style>
