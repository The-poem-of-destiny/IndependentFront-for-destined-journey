<script setup lang="ts">
/**
 * CombatMessageFlow — 战斗中栏对话流（C6 · 数据源 = 沙盒 `CombatState` + 逐轮输出）
 *
 * 职责：把 pipeline 每轮追加的 AI 正文解析成「叙事 + 等宽面板」（`parseCombatNarrative`），
 * 顶部叠一份从权威状态现算的「战况总览」面板，底部在 AI 思考中时显示转圈。
 *
 * 全部数据驱动：单位名/资源/位置来自 `CombatState`，面板行来自 AI 输出文本。
 */
import { computed, nextTick, ref, watch } from 'vue';
import type { CombatState } from '@engine/combat/sandbox/types';
import type { CombatFlowEntry } from '../../../stores/game-store';
import { flowBlocksForChunk } from './combat-view';

const props = defineProps<{
  state: CombatState | null;
  flow: CombatFlowEntry[];
  /** 当前 exchange 的流式正文（未定稿的实时预览） */
  stream?: string;
  isThinking?: boolean;
}>();

/** 每轮输出 → 块序列（含所在回合号，供插入分隔）；非 assistant 条目走各自的渲染分支 */
const rounds = computed(() =>
  props.flow.map((entry) => ({
    round: entry.round,
    role: entry.role,
    text: entry.text,
    tool: entry.tool,
    durationMs: entry.durationMs,
    blocks: entry.role === 'assistant' ? flowBlocksForChunk(entry.text) : [],
  })),
);

/** 思考耗时的可读秒数 */
function seconds(ms?: number): string {
  return ((ms ?? 0) / 1000).toFixed(1);
}

/** 流式预览的块序列（边想边说；定稿后由 flow 接替） */
const streamBlocks = computed(() => (props.stream ? flowBlocksForChunk(props.stream) : []));

/** 战况总览（从权威状态现算） */
const overviewRows = computed(() => {
  if (!props.state) return [];
  const order = props.state.meta.actionOrder ?? [];
  const units = Object.values(props.state.units);
  const rank = (name: string) => {
    const i = order.indexOf(name);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...units]
    .sort((a, b) => rank(a.name) - rank(b.name) || a.pos - b.pos)
    .map((u) => ({
      name: u.name,
      value: `HP ${u.hp}/${u.maxHp} · MP ${u.mp}/${u.maxMp} · SP ${u.sp}/${u.maxSp} · 位置 ${u.pos}`,
    }));
});

const actionOrderText = computed(() => (props.state?.meta.actionOrder ?? []).join(' → '));

const container = ref<HTMLDivElement>();

/**
 * 粘性滚动：只有当用户**本来就在底部**时才自动跟到底；用户往上翻看历史时，
 * 出字不再把他强拉回底部。
 */
const atBottom = ref(true);
function onScroll() {
  const el = container.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
}

watch([() => props.flow.length, () => (props.stream ?? '').length], () => {
  if (!atBottom.value) return;
  nextTick(() => {
    if (container.value) container.value.scrollTop = container.value.scrollHeight;
  });
});
</script>

<template>
  <div class="combat-message-flow">
    <div ref="container" class="combat-messages" @scroll="onScroll">
      <!-- 战况总览：从权威状态现算，永远是最新事实 -->
      <div v-if="overviewRows.length" class="panel-box">
        <div class="pb-title">{战况总览}</div>
        <div v-for="row in overviewRows" :key="row.name" class="pb-row">
          <span>{{ row.name }}</span
          ><b>{{ row.value }}</b>
        </div>
      </div>

      <!-- 对话流：按时间顺序渲染（user / system / tool / reasoning / assistant），单一循环不带偏序 -->
      <template v-for="(chunk, ci) in rounds" :key="ci">
        <!-- 玩家 -->
        <div v-if="chunk.role === 'user'" class="user-msg">
          <div class="um-head">你</div>
          <div class="um-text">{{ chunk.text }}</div>
        </div>

        <!-- Code 注入的回合指令 -->
        <div v-else-if="chunk.role === 'system'" class="sys-msg">
          <span class="sys-tag">系统</span>
          <span class="sys-text">{{ chunk.text }}</span>
        </div>

        <!-- 工具调用（一行） -->
        <div v-else-if="chunk.role === 'tool'" class="tool-msg">
          <span class="tool-ico" aria-hidden="true">⚙</span>
          <span class="tool-name">{{ chunk.tool?.name ?? chunk.text }}</span>
          <span class="tool-args">{{ chunk.tool?.args }}</span>
        </div>

        <!-- 思维链（原生可折叠，默认折叠） -->
        <details v-else-if="chunk.role === 'reasoning'" class="reasoning">
          <summary>
            <template v-if="chunk.durationMs">思考 {{ seconds(chunk.durationMs) }}s</template>
            <template v-else>思考中…</template>
          </summary>
          <div class="reasoning-body">{{ chunk.text }}</div>
        </details>

        <!-- 主持人正文 -->
        <template v-else>
          <div class="evt">
            — 第 {{ chunk.round }} 回合<template v-if="actionOrderText">
              · 行动顺序：{{ actionOrderText }}</template
            >
            —
          </div>
          <template v-for="(block, bi) in chunk.blocks" :key="bi">
            <div v-if="block.kind === 'narrative'" class="narr">{{ block.text }}</div>
            <div v-else class="panel-box">
              <div v-if="block.title" class="pb-title">{{ '{' + block.title + '}' }}</div>
              <div v-for="(row, ri) in block.rows" :key="ri" class="pb-row">
                <span>{{ row.label }}</span
                ><b>{{ row.value }}</b>
              </div>
            </div>
          </template>
        </template>
      </template>

      <!-- 流式预览：当前 exchange 正在逐字输出的正文（未定稿） -->
      <template v-for="(block, bi) in streamBlocks" :key="'stream-' + bi">
        <div v-if="block.kind === 'narrative'" class="narr">{{ block.text }}</div>
        <div v-else class="panel-box">
          <div v-if="block.title" class="pb-title">{{ '{' + block.title + '}' }}</div>
          <div v-for="(row, ri) in block.rows" :key="ri" class="pb-row">
            <span>{{ row.label }}</span
            ><b>{{ row.value }}</b>
          </div>
        </div>
      </template>

      <div v-if="flow.length === 0 && !streamBlocks.length" class="empty-tab">战斗即将开始…</div>

      <div
        v-if="isThinking && !streamBlocks.length"
        class="bubble-row-thinking"
        role="status"
        aria-live="polite"
      >
        <div class="thinking-indicator">
          <span class="thinking-spinner" aria-hidden="true" />
          <span class="thinking-text">思考中…</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.combat-message-flow {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--theme-content-bg);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
}
.combat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--theme-spacing-md) var(--theme-spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-sm);
  scrollbar-width: thin;
  scrollbar-color: var(--theme-card-border) transparent;
}

.narr {
  font-family: var(--theme-font-title);
  font-size: 0.875rem;
  line-height: 1.85;
  color: var(--theme-text-primary);
  white-space: pre-wrap;
  text-indent: 2em;
}

.user-msg {
  align-self: flex-end;
  max-width: 82%;
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  border-radius: var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-primary) 10%, var(--theme-card-bg));
  padding: var(--theme-spacing-sm) var(--theme-spacing-md);
}
.um-head {
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  color: var(--theme-primary);
  margin-bottom: 2px;
}
.um-text {
  font-family: var(--theme-font-body);
  font-size: 0.8125rem;
  line-height: 1.6;
  color: var(--theme-text-primary);
  white-space: pre-wrap;
}

/* Code 注入的回合指令：居中的 muted 条 */
.sys-msg {
  display: flex;
  align-items: flex-start;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  border-left: 2px solid color-mix(in srgb, var(--theme-primary) 55%, transparent);
  background: color-mix(in srgb, var(--theme-primary) 5%, transparent);
  border-radius: var(--theme-radius-sm);
  font-size: 0.8125rem;
  color: var(--theme-text-secondary);
  line-height: 1.6;
}
.sys-tag {
  flex: none;
  font-size: 0.6875rem;
  letter-spacing: 0.08em;
  color: var(--theme-primary);
  padding-top: 1px;
}
.sys-text {
  white-space: pre-wrap;
}

/* 工具调用：一行等宽 */
.tool-msg {
  display: flex;
  align-items: baseline;
  gap: var(--theme-spacing-sm);
  padding: 2px var(--theme-spacing-md);
  font-family: 'Cascadia Code', ui-monospace, Consolas, monospace;
  font-size: 0.6875rem;
  color: var(--theme-text-muted);
  overflow: hidden;
}
.tool-ico {
  color: var(--theme-primary);
}
.tool-name {
  flex: none;
  color: var(--theme-text-secondary);
}
.tool-args {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 思维链：原生可折叠 */
.reasoning {
  border: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
  border-radius: var(--theme-radius-sm);
  padding: 4px 10px;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
}
.reasoning > summary {
  cursor: pointer;
  color: var(--theme-text-secondary);
  letter-spacing: 0.05em;
  list-style: none;
}
.reasoning > summary::-webkit-details-marker {
  display: none;
}
.reasoning > summary::before {
  content: '+ ';
  color: var(--theme-primary);
}
.reasoning[open] > summary::before {
  content: '− ';
}
.reasoning-body {
  margin-top: 4px;
  padding-top: 4px;
  border-top: 1px dashed color-mix(in srgb, var(--theme-card-border) 70%, transparent);
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 0.75rem;
}

.panel-box {
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-window-bg) 70%, var(--theme-content-bg));
  font-family: 'Cascadia Code', ui-monospace, Consolas, monospace;
  font-size: 0.75rem;
}
.pb-title {
  padding: 5px 10px;
  border-bottom: 1px solid var(--theme-card-border);
  color: var(--theme-primary);
  letter-spacing: 0.08em;
  font-size: 0.6875rem;
}
.pb-row {
  display: flex;
  justify-content: space-between;
  gap: var(--theme-spacing-md);
  padding: 4px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 50%, transparent);
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}
.pb-row:last-child {
  border-bottom: 0;
}
.pb-row b {
  color: var(--theme-text-primary);
  text-align: right;
}

.evt {
  text-align: center;
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.05em;
  padding: var(--theme-spacing-xs) 0;
}

.empty-tab {
  padding: 32px 0;
  text-align: center;
  color: var(--theme-text-muted);
  font-size: 0.8125rem;
  font-style: italic;
  margin: auto 0;
}
.empty-tab::before {
  content: '—';
  display: block;
  margin-bottom: 8px;
  font-size: 1.25rem;
  opacity: 0.3;
}

.bubble-row-thinking {
  display: flex;
  justify-content: center;
  padding: var(--theme-spacing-xs) 0;
}
.thinking-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-xs) var(--theme-spacing-md);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 22%, var(--theme-card-border));
  border-radius: var(--theme-radius-sm);
  background: var(--theme-card-bg);
  color: var(--theme-text-secondary);
  font-size: 0.8125rem;
}
.thinking-spinner {
  width: 0.875rem;
  height: 0.875rem;
  flex: 0 0 auto;
  border: 2px solid color-mix(in srgb, var(--theme-primary) 25%, transparent);
  border-top-color: var(--theme-primary);
  border-radius: 50%;
  animation: combat-thinking-spin 0.8s linear infinite;
}
@keyframes combat-thinking-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .thinking-spinner {
    animation: none;
  }
}
</style>
