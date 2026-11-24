<script setup lang="ts">
/**
 * `<action_info>` 行动面板 — 外壳
 *
 * 一个原生 `<details>`：`<summary>` 里画当前样式（`settings.actionPanelStyle`，五选一）的收起视图，
 * 展开体是五种样式共用的算式区（`ActionPanelCalc`）。右上角齿轮（`ActionPanelStyleMenu`）是 details 的
 * **兄弟**，点它不会开合面板。解析在 `lib/action-panel.ts`，「该画什么」在 `lib/action-panel-view.ts`；
 * 本组件与各样式只按视图模型**文本插值**渲染，不用 v-html。
 *
 * 样式组件的统一入参：`{ view: ActionView; open: boolean; entering: boolean }`。
 *
 * 入场：`entrance` 只在 setup 里读一次（之后改它不重播）；过了当前样式的 `entranceMs` 用定时器撤掉
 * （不等 animationend —— 减动效下、或元素被隐藏时它可能永远不来），换样式时立即撤掉。
 * 展开体的淡入只在玩家点过 summary 之后才有 —— `defaultOpen` 的初始展开不播。
 *
 * 🔴 根类名 `.action-panel-card` 是 ChatFlow 点击推进让路清单（`STAGE_YIELD_SELECTOR`）的契约，别改名。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, type Component } from 'vue';
import { parseActionPanel, type ActionPanel } from '../../lib/action-panel';
import { buildActionView } from '../../lib/action-panel-view';
import { ACTION_PANEL_STYLES, type ActionPanelStyleId } from '../../lib/action-panel-styles';
import { useActionPanelStyle } from '../../composables/useActionPanelStyle';
import ActionPanelCalc from './action-panel/ActionPanelCalc.vue';
import ActionPanelStyleMenu from './action-panel/ActionPanelStyleMenu.vue';
import ActionStyleDuel from './action-panel/ActionStyleDuel.vue';
import ActionStyleAfterimage from './action-panel/ActionStyleAfterimage.vue';
import ActionStyleBattleLog from './action-panel/ActionStyleBattleLog.vue';
import ActionStyleFloating from './action-panel/ActionStyleFloating.vue';
import ActionStyleCard from './action-panel/ActionStyleCard.vue';

const props = defineProps<{
  raw?: string;
  panel?: ActionPanel;
  /** 初始展开（缺省收起）；只决定首次渲染，之后开合归玩家 */
  defaultOpen?: boolean;
  /** 播一次入场动画（只在挂载时读）；缺省不播 */
  entrance?: boolean;
}>();

const STYLE_COMPONENTS: Record<ActionPanelStyleId, Component> = {
  duel: ActionStyleDuel,
  afterimage: ActionStyleAfterimage,
  battlelog: ActionStyleBattleLog,
  floating: ActionStyleFloating,
  card: ActionStyleCard,
};

const parsed = computed(() => props.panel ?? parseActionPanel(props.raw ?? ''));
const view = computed(() => buildActionView(parsed.value));
const hasContent = computed(() => parsed.value.sections.length > 0);

const { style, setStyle } = useActionPanelStyle();
const styleComponent = computed(() => STYLE_COMPONENTS[style.value]);

const open = ref(Boolean(props.defaultOpen));
/** 玩家亲手点过 summary：此后展开体才带淡入 */
const userToggled = ref(false);

// ── 入场 ──
const entering = ref(Boolean(props.entrance));
let enterTimer: ReturnType<typeof setTimeout> | undefined;

function stopEntrance(): void {
  if (enterTimer !== undefined) clearTimeout(enterTimer);
  enterTimer = undefined;
  entering.value = false;
}

onMounted(() => {
  if (!entering.value) return;
  const ms = ACTION_PANEL_STYLES.find((s) => s.id === style.value)?.entranceMs ?? 0;
  enterTimer = setTimeout(stopEntrance, ms);
});
watch(style, stopEntrance);
onBeforeUnmount(stopEntrance);

function onToggle(event: Event): void {
  open.value = (event.target as HTMLDetailsElement).open;
}
</script>

<template>
  <div
    v-if="hasContent"
    class="action-panel-card"
    :class="{ 'is-entering': entering, 'is-user-toggled': userToggled }"
    :data-style="style"
    :data-kind="view.kind"
  >
    <details class="ai-details" :open="defaultOpen || undefined" @toggle="onToggle">
      <summary class="ai-summary" @click="userToggled = true">
        <component :is="styleComponent" :view="view" :open="open" :entering="entering" />
      </summary>
      <div class="ai-body">
        <ActionPanelCalc :sections="view.calc" />
      </div>
    </details>
    <ActionPanelStyleMenu :current="style" @select="setStyle" />
  </div>
</template>

<style scoped>
.action-panel-card {
  position: relative;
  container-type: inline-size;
  margin: 0.7em 0;
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  background: var(--theme-card-bg);
  box-shadow: var(--paper-stack);
  color: var(--theme-text-primary);
  font-family: var(--theme-font-body);
  font-size: 0.8125rem;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  text-indent: 0;
}

.ai-summary {
  display: block;
  padding: 10px 38px 8px 14px;
  border-radius: var(--theme-radius-md);
  cursor: pointer;
  list-style: none;
}

.ai-summary::-webkit-details-marker {
  display: none;
}

.ai-summary:focus-visible {
  outline: 2px solid var(--theme-primary);
  outline-offset: -2px;
}

.ai-body {
  padding: 8px 14px 12px;
  border-top: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
  border-radius: 0 0 var(--theme-radius-md) var(--theme-radius-md);
  background: color-mix(in srgb, var(--theme-surface-muted) 50%, transparent);
}

/* 展开体淡入：只在玩家点开时（defaultOpen 的初始展开不播），只动 opacity / transform */
@keyframes ai-in {
  from {
    opacity: 0;
    transform: translateY(-4px);
  }
}

.action-panel-card.is-user-toggled .ai-details[open] > .ai-body {
  animation: ai-in var(--motion-duration-base) var(--motion-ease-enter) backwards;
}

@media (prefers-reduced-motion: reduce) {
  .action-panel-card.is-user-toggled .ai-details[open] > .ai-body {
    animation: none;
  }
}

:root[data-reduced-motion='true'] .action-panel-card.is-user-toggled .ai-details[open] > .ai-body {
  animation: none;
}
</style>
