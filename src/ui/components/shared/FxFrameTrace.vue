<script setup lang="ts">
/**
 * FxFrameTrace — 弹窗入场时的四角描线（只在特效闸门打开时由 AppModal 渲染）
 *
 * 四个 L 形角饰从各自角点沿两条边「画出来」（scaleX / scaleY，原点钉在角点），
 * 随后整体淡去并通知宿主移除。描线落在面板外侧 6px：既避开面板的圆角，
 * 又读作「先描出轮廓、再落下实体」。
 *
 * 时间表在 `fx-frame-trace-timing.ts`（与 AppModal 共用）。
 *
 * 只动 transform / opacity；叶子节点、aria-hidden、不吃指针。
 * 结束靠定时器而不是 animationend：jsdom 与后台标签页都不保证派发后者，
 * 漏一次就会留下一个永远不走的框。
 */
import { computed, onMounted, onUnmounted } from 'vue';
import {
  FX_TRACE_FADE_DELAY_MS,
  FX_TRACE_FADE_MS,
  FX_TRACE_GROW_MS,
  FX_TRACE_TOTAL_MS,
  type FxFrameRect,
} from './fx-frame-trace-timing';

const props = defineProps<{ rect: FxFrameRect }>();
const emit = defineEmits<{ done: [] }>();

/** 描线与面板边缘的间距（px） */
const OUTSET = 6;

/** 角饰臂长：取边长的 18%，夹在 20–96px —— 小弹窗不至于满框，大弹窗不至于只剩两个点 */
function armLength(side: number): number {
  return Math.round(Math.min(96, Math.max(20, side * 0.18)));
}

const style = computed(() => ({
  left: `${props.rect.left - OUTSET}px`,
  top: `${props.rect.top - OUTSET}px`,
  width: `${props.rect.width + OUTSET * 2}px`,
  height: `${props.rect.height + OUTSET * 2}px`,
  '--fx-trace-arm-x': `${armLength(props.rect.width)}px`,
  '--fx-trace-arm-y': `${armLength(props.rect.height)}px`,
  '--fx-trace-grow': `${FX_TRACE_GROW_MS}ms`,
  '--fx-trace-fade-delay': `${FX_TRACE_FADE_DELAY_MS}ms`,
  '--fx-trace-fade': `${FX_TRACE_FADE_MS}ms`,
}));

const CORNERS = ['tl', 'tr', 'bl', 'br'] as const;

let timer: ReturnType<typeof setTimeout> | undefined;
onMounted(() => {
  timer = setTimeout(() => emit('done'), FX_TRACE_TOTAL_MS);
});
onUnmounted(() => {
  if (timer !== undefined) clearTimeout(timer);
});
</script>

<template>
  <div class="fx-frame-trace" aria-hidden="true" :style="style">
    <span
      v-for="c in CORNERS"
      :key="c"
      class="fx-frame-trace__corner"
      :class="`fx-frame-trace__corner--${c}`"
    >
      <span class="fx-frame-trace__arm fx-frame-trace__arm--h" />
      <span class="fx-frame-trace__arm fx-frame-trace__arm--v" />
    </span>
  </div>
</template>

<style scoped>
.fx-frame-trace {
  position: absolute;
  pointer-events: none;
  animation: fx-trace-fade var(--fx-trace-fade) var(--motion-ease-exit) var(--fx-trace-fade-delay)
    forwards;
}

.fx-frame-trace__corner {
  position: absolute;
  width: var(--fx-trace-arm-x);
  height: var(--fx-trace-arm-y);
}
.fx-frame-trace__corner--tl {
  top: 0;
  left: 0;
}
.fx-frame-trace__corner--tr {
  top: 0;
  right: 0;
}
.fx-frame-trace__corner--bl {
  bottom: 0;
  left: 0;
}
.fx-frame-trace__corner--br {
  bottom: 0;
  right: 0;
}

/* 主题强调色的低透明度描线，1px */
.fx-frame-trace__arm {
  position: absolute;
  background: color-mix(in srgb, var(--theme-primary) 42%, transparent);
  animation-duration: var(--fx-trace-grow);
  animation-timing-function: var(--motion-ease-enter);
  animation-fill-mode: backwards;
}
.fx-frame-trace__arm--h {
  left: 0;
  right: 0;
  height: 1px;
  animation-name: fx-trace-grow-x;
}
.fx-frame-trace__arm--v {
  top: 0;
  bottom: 0;
  width: 1px;
  animation-name: fx-trace-grow-y;
}

/* 每个角：横臂贴在外侧那条水平边、竖臂贴在外侧那条垂直边，生长原点钉在角点 */
.fx-frame-trace__corner--tl .fx-frame-trace__arm--h,
.fx-frame-trace__corner--tr .fx-frame-trace__arm--h {
  top: 0;
}
.fx-frame-trace__corner--bl .fx-frame-trace__arm--h,
.fx-frame-trace__corner--br .fx-frame-trace__arm--h {
  bottom: 0;
}
.fx-frame-trace__corner--tl .fx-frame-trace__arm--v,
.fx-frame-trace__corner--bl .fx-frame-trace__arm--v {
  left: 0;
}
.fx-frame-trace__corner--tr .fx-frame-trace__arm--v,
.fx-frame-trace__corner--br .fx-frame-trace__arm--v {
  right: 0;
}
.fx-frame-trace__corner--tl .fx-frame-trace__arm--h,
.fx-frame-trace__corner--bl .fx-frame-trace__arm--h {
  transform-origin: left center;
}
.fx-frame-trace__corner--tr .fx-frame-trace__arm--h,
.fx-frame-trace__corner--br .fx-frame-trace__arm--h {
  transform-origin: right center;
}
.fx-frame-trace__corner--tl .fx-frame-trace__arm--v,
.fx-frame-trace__corner--tr .fx-frame-trace__arm--v {
  transform-origin: center top;
}
.fx-frame-trace__corner--bl .fx-frame-trace__arm--v,
.fx-frame-trace__corner--br .fx-frame-trace__arm--v {
  transform-origin: center bottom;
}

@keyframes fx-trace-grow-x {
  from {
    transform: scaleX(0);
  }
}
@keyframes fx-trace-grow-y {
  from {
    transform: scaleY(0);
  }
}
@keyframes fx-trace-fade {
  to {
    opacity: 0;
  }
}
</style>
