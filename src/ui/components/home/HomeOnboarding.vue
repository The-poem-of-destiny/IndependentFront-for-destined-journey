<script setup lang="ts">
/**
 * 首页「开始前的三步」引导面板 —— **纯呈现**。
 *
 * 步骤状态与面板态全由 `lib/onboarding.ts` 推导（`deriveOnboardingSteps` /
 * `resolveOnboardingPanel`），文案也只出自那里；本组件不碰 store、不判该不该显示，
 * 只把宿主（HomePage）给的模型画出来，并把玩家的操作 emit 回去。
 *
 * - `expanded`：紧凑卡（宽屏贴左栏右侧，窄屏并入左栏文档流）
 * - `collapsed`：一行小入口「开始前的三步 · n/3」
 * - `hidden`：什么都不渲染（加载中不闪现；三步全完成连入口一起藏）
 *
 * 🔴 宿主必须把本组件放在 `.btn-column` **之外**：那一列的事件委托会把这里的按钮
 *    也当成首页主操作，悬停 / 点击触发背景能量与脉冲。
 * 🔴 动效只有入场一下（opacity + translate，`--motion-*` token，`backwards` 填充），
 *    无辉光、无循环；减动效下不播。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import AppButton from '../shared/AppButton.vue';
import {
  onboardingEntryLabel,
  type OnboardingModel,
  type OnboardingPanelState,
  type OnboardingStepId,
  type OnboardingStepStatus,
} from '../../lib/onboarding';

const props = defineProps<{
  model: OnboardingModel;
  state: OnboardingPanelState;
  /**
   * 宽屏卡片顶边不许越过的元素（首页的内容态横幅）。取值函数：横幅可能整个不渲染，
   * 返回 null / 非元素 / 零高度时只按视口顶避让。
   */
  topGuard?: () => unknown;
}>();

const emit = defineEmits<{
  go: [step: OnboardingStepId];
  close: [];
  dismiss: [];
  open: [];
}>();

const entryLabel = computed(() => onboardingEntryLabel(props.model));

/** 状态的读屏文字（视觉上由状态标记表达） */
const STATUS_TEXT: Record<OnboardingStepStatus, string> = {
  done: '已完成',
  todo: '未完成',
  attention: '需要处理',
  unknown: '读取中',
};

const PANEL_ID = 'home-onboarding-panel';
const HEADING_ID = 'home-onboarding-heading';

const closeBtn = ref<HTMLElement | null>(null);
const entryBtn = ref<HTMLElement | null>(null);

// 手动开合时把焦点交给新出现的那一侧，键盘用户不会丢在原地
// （首屏自动展开 / 自动收起不抢焦点：只有本组件里发起的开合才移交）。
let focusPending: 'panel' | 'entry' | null = null;

function onOpen() {
  focusPending = 'panel';
  emit('open');
}

function onClose() {
  focusPending = 'entry';
  emit('close');
}

function onDismiss() {
  focusPending = 'entry';
  emit('dismiss');
}

// ═══ 宽屏卡片的高度封顶 ═══
// 宽屏下卡片贴着按钮列底部向上生长（absolute bottom:0），只按视口高封顶时，按钮列底部
// 离视口顶不够高就会顶出屏幕、或钻到内容态横幅底下。这里量出「按钮列底部 → 横幅下沿 /
// 视口顶 + 安全边距」的可用高度写成 max-height，超出部分卡内滚动（标题行 sticky）。
// 窄屏（并入文档流）不封顶，随页面滚动。
const NARROW_QUERY = '(max-aspect-ratio: 23/20), (max-width: 1099px)';
/** 卡片顶边与横幅下沿 / 视口顶之间留的安全边距（= --theme-spacing-md） */
const SAFE_MARGIN_PX = 16;
/** 再挤也至少留出标题行 + 一步的高度，免得卡片缩成一条缝 */
const MIN_HEIGHT_PX = 120;

const panel = ref<HTMLElement | null>(null);
const maxHeightPx = ref<number | null>(null);
const panelStyle = computed(() =>
  maxHeightPx.value === null ? undefined : { maxHeight: `${maxHeightPx.value}px` },
);

let resizeObserver: ResizeObserver | null = null;
const observed = new Set<Element>();
let measureFrame = 0;

function observe(el: Element) {
  if (!resizeObserver || observed.has(el)) return;
  observed.add(el);
  resizeObserver.observe(el);
}

function guardRect(): DOMRect | null {
  const guard = props.topGuard?.();
  if (!(guard instanceof Element)) return null;
  observe(guard);
  const rect = guard.getBoundingClientRect();
  return rect.height > 0 ? rect : null;
}

function measure() {
  measureFrame = 0;
  const el = panel.value;
  if (
    !el ||
    typeof window === 'undefined' ||
    typeof window.matchMedia !== 'function' ||
    window.matchMedia(NARROW_QUERY).matches
  ) {
    maxHeightPx.value = null;
    return;
  }
  const anchor = (el.offsetParent as HTMLElement | null) ?? el.parentElement;
  if (!anchor) return;
  observe(anchor);
  const bottom = anchor.getBoundingClientRect().bottom;
  const guard = guardRect();
  const top = Math.max(0, guard ? guard.bottom : 0) + SAFE_MARGIN_PX;
  const viewportCap = window.innerHeight - SAFE_MARGIN_PX * 2;
  maxHeightPx.value = Math.max(MIN_HEIGHT_PX, Math.floor(Math.min(bottom - top, viewportCap)));
}

function scheduleMeasure() {
  if (measureFrame || typeof window === 'undefined') return;
  // 先占位再排帧：回调若同步执行（measure 里清零），别让返回的句柄把「已排队」又写回去
  measureFrame = -1;
  const handle = window.requestAnimationFrame(measure);
  if (measureFrame === -1) measureFrame = handle;
}

onMounted(() => {
  if (typeof window === 'undefined') return;
  if (typeof ResizeObserver === 'function') resizeObserver = new ResizeObserver(scheduleMeasure);
  window.addEventListener('resize', scheduleMeasure, { passive: true });
  // 首页本身可滚动；宿主入场动画（translate）不触发 ResizeObserver，结束时补量一次
  window.addEventListener('scroll', scheduleMeasure, { capture: true, passive: true });
  document.addEventListener('animationend', scheduleMeasure, true);
  scheduleMeasure();
});

onBeforeUnmount(() => {
  if (typeof window === 'undefined') return;
  window.removeEventListener('resize', scheduleMeasure);
  window.removeEventListener('scroll', scheduleMeasure, { capture: true });
  document.removeEventListener('animationend', scheduleMeasure, true);
  if (measureFrame > 0) window.cancelAnimationFrame(measureFrame);
  measureFrame = 0;
  resizeObserver?.disconnect();
  resizeObserver = null;
  observed.clear();
});

watch(
  () => props.state,
  (state) => {
    if (state === 'expanded') void nextTick(scheduleMeasure);
  },
);

watch(
  () => props.state,
  async (state) => {
    const pending = focusPending;
    focusPending = null;
    if (!pending) return;
    await nextTick();
    if (pending === 'panel' && state === 'expanded') {
      closeBtn.value?.focus();
    } else if (pending === 'entry' && state === 'collapsed') {
      entryBtn.value?.focus();
    }
  },
);
</script>

<template>
  <section
    v-if="state === 'expanded'"
    :id="PANEL_ID"
    ref="panel"
    class="home-onboarding"
    :style="panelStyle"
    role="region"
    :aria-labelledby="HEADING_ID"
    @keydown.esc.stop="onClose"
  >
    <header class="ob-header">
      <h2 :id="HEADING_ID" class="ob-title">开始前的三步</h2>
      <span class="ob-progress" :aria-label="`已完成 ${model.doneCount} 步，共 ${model.total} 步`">
        {{ model.doneCount }}/{{ model.total }}
      </span>
      <button type="button" class="ob-dismiss" @click="onDismiss">不再显示</button>
      <button
        ref="closeBtn"
        type="button"
        class="ob-close"
        aria-label="收起引导"
        :aria-controls="PANEL_ID"
        aria-expanded="true"
        @click="onClose"
      >
        <i class="fa-solid fa-xmark" aria-hidden="true"></i>
      </button>
    </header>

    <ol class="ob-steps">
      <li
        v-for="step in model.steps"
        :key="step.id"
        class="ob-step"
        :class="`is-${step.status}`"
        :data-step="step.id"
        :data-status="step.status"
      >
        <span class="ob-mark" aria-hidden="true">
          <i v-if="step.status === 'done'" class="fa-solid fa-check"></i>
          <i v-else-if="step.status === 'attention'" class="fa-solid fa-exclamation"></i>
          <template v-else>{{ step.index }}</template>
        </span>
        <div class="ob-body">
          <div class="ob-line">
            <span class="ob-step-title">{{ step.title }}</span>
            <span class="ob-badge" :class="{ 'is-required': step.required }">{{ step.badge }}</span>
            <span class="ob-sr">{{ STATUS_TEXT[step.status] }}</span>
          </div>
          <!-- 已完成的步骤只留标题行；未完成的说明默认只露一行，点开看全文（与 Embedding 副项） -->
          <template v-if="step.status !== 'done'">
            <details class="ob-detail">
              <summary class="ob-hint">{{ step.hint }}</summary>
              <p v-if="step.sub" class="ob-sub" :data-status="step.sub.status">
                <span class="ob-sub-label">{{ step.sub.label }}</span>
                <span class="ob-sr">{{ STATUS_TEXT[step.sub.status] }}</span>
                <span class="ob-sub-hint">{{ step.sub.hint }}</span>
              </p>
            </details>
            <AppButton
              variant="secondary"
              size="sm"
              class="ob-go"
              :data-go="step.id"
              @click="emit('go', step.id)"
            >
              {{ step.actionLabel }}
            </AppButton>
          </template>
        </div>
      </li>
    </ol>
  </section>

  <button
    v-else-if="state === 'collapsed'"
    ref="entryBtn"
    type="button"
    class="home-onboarding-entry"
    :aria-controls="PANEL_ID"
    aria-expanded="false"
    @click="onOpen"
  >
    <i class="fa-solid fa-list-check" aria-hidden="true"></i>
    <span>{{ entryLabel }}</span>
  </button>
</template>

<style scoped>
/* ═══ 展开态：紧凑卡（design.md §4.2 统一外壳）═══ */
/* 底边与左栏按钮列底部对齐、向上生长（宿主 .action-section 是定位祖先，展开时它的底就是
   按钮列的底）。这里的 max-height 只是脚本量出来之前的兜底：脚本按「按钮列底部 → 内容态
   横幅下沿 / 视口顶 + 安全边距」写内联 max-height，超出时卡内滚动，标题行 sticky 常驻。 */
.home-onboarding {
  position: absolute;
  bottom: 0;
  left: calc(100% + var(--theme-spacing-lg));
  z-index: 3;
  box-sizing: border-box;
  width: 280px;
  max-height: calc(100vh - var(--theme-spacing-2xl) * 2);
  max-height: calc(100dvh - var(--theme-spacing-2xl) * 2);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--theme-spacing-md) var(--theme-spacing-md);
  text-align: start;
  user-select: text;
  background: color-mix(in srgb, var(--theme-card-bg) 92%, transparent);
  border: 1px solid var(--theme-card-border);
  border-radius: var(--theme-radius-md);
  box-shadow: var(--paper-stack);
  backdrop-filter: blur(6px);
  animation: ob-enter var(--motion-duration-slow) var(--motion-ease-enter) backwards;
}

@keyframes ob-enter {
  from {
    opacity: 0;
    transform: translateX(-8px);
  }
}

.ob-header {
  /* 卡内滚动时标题行（含关闭、不再显示）始终可见可点 */
  position: sticky;
  top: 0;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
  padding: var(--theme-spacing-sm) 0 var(--theme-spacing-xs);
  background: var(--theme-card-bg);
  border-bottom: 1px solid color-mix(in srgb, var(--theme-card-border) 70%, transparent);
}
.ob-title {
  margin: 0;
  font-family: var(--theme-font-title);
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 1px;
  color: var(--theme-text-primary);
}
.ob-progress {
  font-size: 0.8rem;
  color: var(--theme-text-muted);
  font-variant-numeric: tabular-nums;
}
.ob-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  color: var(--theme-text-muted);
  cursor: pointer;
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard);
}
.ob-close:hover,
.ob-close:focus-visible {
  color: var(--theme-text-primary);
  border-color: var(--theme-card-border);
}

/* ═══ 步骤 ═══ */
.ob-steps {
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-md);
  margin: 0;
  padding: var(--theme-spacing-sm) 0 0;
  list-style: none;
}
.ob-step {
  display: flex;
  gap: var(--theme-spacing-sm);
  align-items: flex-start;
}
.ob-mark {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-top: 1px;
  border-radius: var(--theme-radius-full);
  border: 1px solid var(--theme-card-border);
  font-size: 0.7rem;
  color: var(--theme-text-muted);
}
.ob-step.is-done .ob-mark {
  color: var(--theme-success);
  background: color-mix(in srgb, var(--theme-success) 12%, transparent);
  border-color: color-mix(in srgb, var(--theme-success) 35%, transparent);
}
.ob-step.is-attention .ob-mark {
  color: var(--theme-warning);
  background: color-mix(in srgb, var(--theme-warning) 12%, transparent);
  border-color: color-mix(in srgb, var(--theme-warning) 35%, transparent);
}
.ob-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--theme-spacing-xs);
}
.ob-line {
  display: flex;
  align-items: center;
  gap: var(--theme-spacing-sm);
}
.ob-step-title {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--theme-text-primary);
}
.ob-step.is-done .ob-step-title {
  color: var(--theme-text-secondary);
}
.ob-badge {
  padding: 0 6px;
  font-size: 0.7rem;
  line-height: 1.6;
  border-radius: var(--theme-radius-sm);
  color: var(--theme-text-muted);
  border: 1px solid var(--theme-card-border);
}
.ob-badge.is-required {
  color: var(--theme-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}
/* 说明默认只露一行（省略号截断），点开 <details> 看全文；展开不过渡高度（§1 禁令） */
.ob-detail {
  min-width: 0;
}
.ob-hint,
.ob-sub {
  margin: 0;
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--theme-text-secondary);
}
.ob-hint {
  display: block;
  /* 点击区补足 36px（design.md 触摸目标 ≥ 36px），负外边距抵掉，视觉位置与行高不变 */
  padding-block: 8px;
  margin-block: -8px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  border-radius: var(--theme-radius-sm);
  cursor: pointer;
  list-style: none;
  transition: color var(--motion-duration-fast) var(--motion-ease-standard);
}
.ob-hint::-webkit-details-marker {
  display: none;
}
.ob-hint:hover,
.ob-hint:focus-visible {
  color: var(--theme-text-primary);
}
.ob-detail[open] > .ob-hint {
  white-space: normal;
}
.ob-sub {
  margin-top: var(--theme-spacing-xs);
  display: flex;
  flex-direction: column;
  padding: var(--theme-spacing-xs) var(--theme-spacing-sm);
  border-radius: var(--theme-radius-sm);
  background: color-mix(in srgb, var(--theme-text-muted) 6%, transparent);
  color: var(--theme-text-muted);
}
.ob-sub-label {
  color: var(--theme-text-secondary);
}
.ob-go {
  position: relative;
  align-self: flex-start;
}
/* sm 按钮视觉高 28px：用透明伪元素把命中区撑到 36px 高（上下居中），不放大按钮本身 */
.ob-go::after {
  content: '';
  position: absolute;
  top: 50%;
  right: 0;
  left: 0;
  height: 36px;
  transform: translateY(-50%);
}

/* 「不再显示」挨着关闭按钮放在标题行右端（省掉一整行页脚） */
.ob-dismiss {
  margin-left: auto;
  min-height: 36px;
  padding: 0 var(--theme-spacing-sm);
  border: none;
  background: transparent;
  font-size: 0.78rem;
  color: var(--theme-text-muted);
  cursor: pointer;
  transition: color var(--motion-duration-fast) var(--motion-ease-standard);
}
.ob-dismiss:hover,
.ob-dismiss:focus-visible {
  color: var(--theme-text-primary);
}

/* 读屏专用文字 */
.ob-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

/* ═══ 收起态：按钮列下方一行小入口 ═══ */
.home-onboarding-entry {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--theme-spacing-sm);
  min-height: 36px;
  margin-top: var(--theme-spacing-md);
  padding: 0 var(--theme-spacing-md);
  border: 1px solid transparent;
  border-radius: var(--theme-radius-sm);
  background: transparent;
  font-size: 0.8rem;
  letter-spacing: 1px;
  color: var(--theme-text-muted);
  cursor: pointer;
  animation: ob-entry-enter var(--motion-duration-base) var(--motion-ease-enter) backwards;
  transition:
    color var(--motion-duration-fast) var(--motion-ease-standard),
    border-color var(--motion-duration-fast) var(--motion-ease-standard);
}
.home-onboarding-entry:hover,
.home-onboarding-entry:focus-visible {
  color: var(--theme-text-primary);
  border-color: color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
}

@keyframes ob-entry-enter {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
}

/* 窄屏（与 HomePage 同一断点），以及视口太窄、贴右放会压住首页主视觉中央时：
   卡片并入左栏文档流，排在按钮列下方，随页面滚动 */
@media (max-aspect-ratio: 23/20), (max-width: 1099px) {
  .home-onboarding {
    position: static;
    width: 100%;
    padding-top: var(--theme-spacing-sm);
    max-height: none;
    margin: var(--theme-spacing-lg) 0 calc(var(--theme-spacing-2xl) + var(--theme-spacing-lg));
    animation-name: ob-enter-narrow;
  }
  /* 窄屏卡片不在自己里面滚动，标题行跟着页面走 */
  .ob-header {
    position: static;
    padding-top: 0;
    background: none;
  }
  @keyframes ob-enter-narrow {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }
}

@media (prefers-reduced-motion: reduce) {
  .home-onboarding,
  .home-onboarding-entry {
    animation: none;
  }
  .ob-close,
  .ob-dismiss,
  .ob-hint,
  .home-onboarding-entry {
    transition: none;
  }
}
</style>
