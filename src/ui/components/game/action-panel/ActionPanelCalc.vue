<script setup lang="ts">
/**
 * 行动面板展开体：算式分节（五种样式共用）。
 *
 * 数据是 `buildActionView` 给的 `calc`：值已切成高亮 token，结论行打 `result`、跨两列打 `wide`。
 * 分节标题前一枚色点取分节色相（`--theme-hue-*` / `--theme-success`），尾随 §5.1 渐变装饰线；
 * 空标题显示「行动详情」。全程文本插值，不走 v-html（面板是模型原文）。
 */
import type { ActionCalcSection } from '../../../lib/action-panel-view';
import type { ActionPanelHue } from '../../../lib/action-panel';

defineProps<{ sections: ActionCalcSection[] }>();

/** 空标题分节的显示名 */
const UNTITLED = '行动详情';

const HUE_VAR: Record<ActionPanelHue, string> = {
  info: 'var(--theme-hue-info)',
  strike: 'var(--theme-hue-strike)',
  check: 'var(--theme-hue-check)',
  gain: 'var(--theme-success)',
};
</script>

<template>
  <div class="calc">
    <section
      v-for="(sec, i) in sections"
      :key="i"
      class="calc-sec"
      :class="`hue-${sec.hue}`"
      :style="{ '--calc-hue': HUE_VAR[sec.hue] ?? HUE_VAR.info }"
    >
      <h4 class="calc-title">
        <span class="calc-dot" aria-hidden="true" />
        <span class="calc-title-text">{{ sec.title || UNTITLED }}</span>
      </h4>
      <dl class="calc-dl">
        <div
          v-for="(row, j) in sec.rows"
          :key="j"
          class="calc-row"
          :class="{
            'is-result': row.result,
            'is-wide': row.wide,
            [`tone-${row.tone}`]: Boolean(row.tone),
          }"
        >
          <dt v-if="row.label" class="calc-k">{{ row.label }}</dt>
          <dd class="calc-v">
            <template v-for="(tok, k) in row.tokens" :key="k"
              ><span v-if="tok.kind" :class="`hl-${tok.kind}`">{{ tok.text }}</span
              ><template v-else>{{ tok.text }}</template></template
            >
          </dd>
        </div>
      </dl>
    </section>
  </div>
</template>

<style scoped>
.calc {
  --calc-mono: 'Cascadia Code', ui-monospace, 'SFMono-Regular', Consolas, monospace;
}

.calc-sec + .calc-sec {
  margin-top: 8px;
}

.calc-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 3px;
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-title);
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.08em;
}

.calc-title::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(to right, var(--theme-card-border), transparent);
}

.calc-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--calc-hue);
}

.calc-title-text {
  min-width: 0;
  overflow-wrap: anywhere;
}

.calc-dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 1px 14px;
  margin: 0;
  font-family: var(--calc-mono);
  font-size: 0.75rem;
  line-height: 1.7;
}

.calc-row {
  display: contents;
}

.calc-k {
  color: var(--theme-text-muted);
}

.calc-v {
  min-width: 0;
  margin: 0;
  color: var(--theme-text-secondary);
  overflow-wrap: anywhere;
}

/* 无标签的散行备注 / 太长的值：跨两列 */
.calc-row.is-wide .calc-v {
  grid-column: 1 / -1;
}

.calc-row.is-result .calc-k {
  color: var(--theme-text-secondary);
}

.calc-row.is-result .calc-v {
  color: var(--theme-text-primary);
  font-weight: 600;
}

.calc-row.tone-success .calc-v {
  color: var(--theme-success);
}

.calc-row.tone-error .calc-v {
  color: var(--theme-error);
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
  margin: 0 1px;
  color: var(--theme-text-muted);
}
</style>
