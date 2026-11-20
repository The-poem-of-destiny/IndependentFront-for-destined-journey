<script setup lang="ts">
/**
 * `<action_info>` 行动面板 — 结果优先 · 等宽标题条 · 浓彩
 *
 * 每个分节一个原生 `<details>`（默认收起，`defaultOpen` 时初始展开）：`<summary>` 是等宽标题条，右侧 ≤3 个关键格 chip，
 * 展开体是两列等宽网格。分节色由 `--accent-s` 驱动（取自 `--theme-hue-*` / `--theme-success`）。
 * 解析全在 `lib/action-panel.ts`；本组件只按结构与 token **文本插值**渲染，不用 v-html。
 *
 * 两种喂法二选一：`raw`（面板原文，带不带 `<action_info>` 标签都行）或已解析的 `panel`。
 */
import { computed } from 'vue';
import {
  highlightValue,
  parseActionPanel,
  summaryCells,
  type ActionPanel,
  type ActionPanelHue,
  type ActionPanelTone,
  type HighlightToken,
} from '../../lib/action-panel';

const props = defineProps<{
  raw?: string;
  panel?: ActionPanel;
  /** 初始展开全部分节（缺省收起）；只决定首次渲染，之后开合归玩家 */
  defaultOpen?: boolean;
}>();

/** 空标题分节的显示名 */
const UNTITLED = '行动详情';

const HUE_VAR: Record<ActionPanelHue, string> = {
  info: 'var(--theme-hue-info)',
  strike: 'var(--theme-hue-strike)',
  check: 'var(--theme-hue-check)',
  gain: 'var(--theme-success)',
};

interface TitlePart {
  text: string;
  arrow: boolean;
}

interface ChipView {
  text: string;
  tone?: ActionPanelTone;
}

interface CellView {
  label: string;
  tone?: ActionPanelTone;
  tokens: HighlightToken[];
}

interface SectionView {
  hue: ActionPanelHue;
  accent: string;
  title: TitlePart[];
  chips: ChipView[];
  cells: CellView[];
}

function splitTitle(title: string): TitlePart[] {
  const parts: TitlePart[] = [];
  title.split('→').forEach((text, i) => {
    if (i > 0) parts.push({ text: '→', arrow: true });
    if (text) parts.push({ text, arrow: false });
  });
  return parts;
}

const sections = computed<SectionView[]>(() => {
  const panel = props.panel ?? parseActionPanel(props.raw ?? '');
  return panel.sections.map((s) => ({
    hue: s.hue,
    accent: HUE_VAR[s.hue] ?? HUE_VAR.info,
    title: splitTitle(s.title || UNTITLED),
    chips: summaryCells(s).map((c) => ({
      // 结论格只显示结论本身；其余带上标签
      text: c.tone || !c.label ? c.value : `${c.label} ${c.value}`,
      tone: c.tone,
    })),
    cells: s.rows
      .flatMap((r) => r.cells)
      .map((c) => ({
        label: c.label,
        tone: c.tone,
        // 结论格整格上色，不再逐 token 着色
        tokens: c.tone ? [{ text: c.value }] : highlightValue(c.value),
      })),
  }));
});
</script>

<template>
  <div v-if="sections.length > 0" class="action-panel-card">
    <details
      v-for="(sec, i) in sections"
      :key="i"
      class="ap-sec"
      :open="defaultOpen || undefined"
      :class="`ap-hue-${sec.hue}`"
      :style="{ '--accent-s': sec.accent }"
    >
      <summary class="ap-bar">
        <span class="ap-title">
          <span class="ap-caret" aria-hidden="true">▶</span>
          <span class="ap-title-text">
            <template v-for="(part, j) in sec.title" :key="j">
              <span v-if="part.arrow" class="ap-title-arrow">{{ part.text }}</span>
              <template v-else>{{ part.text }}</template>
            </template>
          </span>
        </span>
        <span v-if="sec.chips.length > 0" class="ap-chips">
          <span
            v-for="(chip, j) in sec.chips"
            :key="j"
            class="ap-chip"
            :class="chip.tone ? `tone-${chip.tone}` : ''"
            >{{ chip.text }}</span
          >
        </span>
      </summary>
      <div class="ap-body">
        <template v-for="(cell, j) in sec.cells" :key="j">
          <span v-if="cell.label" class="ap-k">{{ cell.label }}</span>
          <span
            class="ap-v"
            :class="[cell.tone ? `tone-${cell.tone}` : '', cell.label ? '' : 'ap-v-wide']"
            ><template v-for="(tok, k) in cell.tokens" :key="k"
              ><span v-if="tok.kind" :class="`hl-${tok.kind}`">{{ tok.text }}</span
              ><template v-else>{{ tok.text }}</template></template
            ></span
          >
        </template>
      </div>
    </details>
  </div>
</template>

<style scoped>
.action-panel-card {
  --ap-mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
  margin: 1em 0;
  overflow: hidden;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-window-bg) 55%, var(--theme-card-bg));
  font-family: var(--theme-font-body);
  font-size: 0.8125rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  text-indent: 0;
}

.ap-sec + .ap-sec {
  border-top: 1px solid color-mix(in srgb, var(--theme-card-border) 60%, transparent);
}

.ap-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--theme-spacing-xs) 10px;
  min-height: 2.25rem;
  padding: 5px 10px;
  border-bottom: 1px solid color-mix(in srgb, var(--accent-s) 35%, transparent);
  /* 对比度：浅底 + 文字向正文色收（10 主题最差 ≈4.9:1，见 CHANGELOG 2026-11-19） */
  background: color-mix(in srgb, var(--accent-s) 14%, transparent);
  cursor: pointer;
  list-style: none;
}

.ap-sec:not([open]) > .ap-bar {
  border-bottom-color: transparent;
}

.ap-bar::-webkit-details-marker {
  display: none;
}

.ap-bar:focus-visible {
  outline: 2px solid var(--accent-s);
  outline-offset: -2px;
}

.ap-title {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  color: color-mix(in srgb, var(--accent-s) 50%, var(--theme-text-primary));
  font-family: var(--ap-mono);
  font-size: 0.75rem;
  letter-spacing: 0.12em;
}

.ap-title-text {
  overflow-wrap: anywhere;
}

.ap-title-arrow {
  margin: 0 0.25em;
  color: var(--theme-text-muted);
}

.ap-caret {
  display: inline-block;
  font-size: 0.625rem;
  opacity: 0.75;
  transition: transform var(--motion-duration-fast) var(--motion-ease-standard);
}

.ap-sec[open] .ap-caret {
  transform: rotate(90deg);
}

.ap-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  min-width: 0;
  margin-left: auto;
}

.ap-chip {
  --chip-c: var(--accent-s);
  max-width: 100%;
  padding: 0 7px;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--chip-c) 50%, transparent);
  border-radius: 2px;
  background: color-mix(in srgb, var(--chip-c) 10%, transparent);
  color: color-mix(in srgb, var(--chip-c) 40%, var(--theme-text-primary));
  font-family: var(--theme-font-body);
  font-size: 0.75rem;
  line-height: 1.6;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ap-chip.tone-success {
  --chip-c: var(--theme-success);
  font-weight: 600;
}

.ap-chip.tone-error {
  --chip-c: var(--theme-error);
  font-weight: 600;
}

.ap-body {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 1px 14px;
  padding: 5px 10px 7px;
  font-family: var(--ap-mono);
  font-size: 0.75rem;
  line-height: 1.65;
}

.ap-k {
  color: var(--theme-text-muted);
}

.ap-v {
  min-width: 0;
  color: var(--theme-text-primary);
  overflow-wrap: anywhere;
}

.ap-v-wide {
  grid-column: 1 / -1;
  color: var(--theme-text-secondary);
}

.ap-v.tone-success {
  color: var(--theme-success);
  font-weight: 600;
}

.ap-v.tone-error {
  color: var(--theme-error);
  font-weight: 600;
}

.hl-dice {
  color: var(--theme-hue-check);
  font-weight: 600;
}

.hl-up {
  color: var(--theme-success);
  font-weight: 600;
}

.hl-down {
  color: var(--theme-error);
  font-weight: 600;
}

.hl-arrow {
  color: var(--theme-text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .ap-caret {
    transition: none;
  }
}
</style>
