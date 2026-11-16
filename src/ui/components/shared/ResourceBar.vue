<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useTweenedNumber } from '../../composables/useTweenedNumber';
import { useFxEnabled } from '../../lib/fx-gate';

const props = defineProps<{
  label: string;
  current: number;
  max: number;
  color?: string; // CSS variable or hex
  showValues?: boolean;
  height?: number;
}>();

const percent = computed(() => {
  if (props.max <= 0) return 0;
  return Math.min(100, Math.max(0, (props.current / props.max) * 100));
});

const barColor = computed(() => props.color || 'var(--theme-hp)');

/**
 * 条宽用 `translateX` 表达而不是 `width`（design.md §1：不过渡布局属性）：
 * 填充层恒为整条宽，向左平移 (100 - 百分比)%，被轨道的 overflow 裁掉。
 */
const fillStyle = computed(() => ({
  transform: `translateX(${percent.value - 100}%)`,
  background: barColor.value,
}));

/**
 * 损耗残影（动效 v1，2026-11-16）：数值下降时，残影停在旧位置、稍后才追上来，
 * 让「少了多少」被看见；上升时残影抢先到位，填充随后补满。只读 props，不改任何数值。
 */
const draining = ref(false);

/**
 * 治疗上涨（界面特效 T5，2026-11-16）：**只在特效闸门打开时**生效 —— 上升时轨道进入
 * `is-rising`，残影抢先到新值、填充以入场曲线更慢地跟上，前沿掠过一道一次性的浅色波峰。
 * 闸门关着时 `rising` 恒为 false、波峰不渲染，行为与 v1 逐像素一致。
 * 波峰按 `crestKey` 重挂，连续两次上涨各自重播一遍。
 * 运行中闸门关掉时，模板以 `fxEnabled && rising` 当场摘掉类名与波峰，`rising` 同时清零，
 * 免得闸门再开时把旧的上涨重播一遍。
 */
const fxEnabled = useFxEnabled();
const rising = ref(false);
const crestKey = ref(0);

watch(percent, (next, prev) => {
  draining.value = next < prev;
  rising.value = fxEnabled.value && next > prev;
  if (rising.value) crestKey.value += 1;
});

watch(fxEnabled, (on) => {
  if (!on) rising.value = false;
});

/** 读数随填充一起滚到新值（只改显示，终点恒等于 current；见 useTweenedNumber） */
const { display: shownCurrent } = useTweenedNumber(() => props.current);
</script>

<template>
  <div class="resource-bar" :style="{ height: (height || 14) + 'px' }">
    <span class="res-label">{{ label }}</span>
    <div class="res-track" :class="{ 'is-draining': draining, 'is-rising': fxEnabled && rising }">
      <div
        class="res-ghost"
        :style="{ transform: fillStyle.transform, background: barColor }"
        aria-hidden="true"
      />
      <div class="res-fill" :style="fillStyle">
        <!-- 波峰骑在填充的前沿上，随填充一起平移；只在特效下的上涨时出现 -->
        <span v-if="fxEnabled && rising" :key="crestKey" class="res-crest" aria-hidden="true" />
      </div>
      <span v-if="showValues !== false" class="res-values"> {{ shownCurrent }} / {{ max }} </span>
    </div>
  </div>
</template>

<style scoped>
.resource-bar {
  display: grid;
  grid-template-columns: 32px minmax(0, 1fr);
  gap: var(--theme-spacing-sm);
  align-items: center;
}
.res-label {
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--theme-text-muted);
  text-align: right;
  text-transform: uppercase;
}
.res-track {
  position: relative;
  height: 100%;
  min-height: 10px;
  background: var(--theme-surface-muted);
  border-radius: var(--theme-radius-full);
  overflow: hidden;
}
.res-fill,
.res-ghost {
  position: absolute;
  inset: 0;
}
.res-fill {
  border-radius: var(--theme-radius-full);
  transition: transform var(--motion-duration-base) var(--motion-ease-standard);
}
/* 残影：同色低不透明度，圆角跟轨道走（各主题给 .res-fill 的圆角不同，轨道与之最接近） */
.res-ghost {
  border-radius: inherit;
  opacity: 0.32;
  transition: transform var(--motion-duration-fast) var(--motion-ease-standard);
}
.is-draining .res-ghost {
  transition: transform 640ms var(--motion-ease-standard) 320ms;
}
/* ── 治疗上涨（仅特效闸门打开时）：残影先到，填充以入场曲线慢一拍跟上 ── */
:root[data-fx='on'] .is-rising .res-ghost {
  transition: transform var(--motion-duration-base) var(--motion-ease-standard);
}
:root[data-fx='on'] .is-rising .res-fill {
  transition: transform 720ms var(--motion-ease-enter) 60ms;
}
/* 前沿波峰：一道细软的浅色线，低透明度，一次性淡入淡出（只动 opacity） */
:root[data-fx='on'] .res-crest {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: 10px;
  pointer-events: none;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.42));
  border-radius: inherit;
  opacity: 0;
  animation: res-crest-pass 780ms var(--motion-ease-standard) 60ms;
}
@keyframes res-crest-pass {
  0% {
    opacity: 0;
  }
  30% {
    opacity: 1;
  }
  100% {
    opacity: 0;
  }
}
.res-values {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.7rem;
  font-weight: 700;
  /* 固定白字 + 双层暗影：
     无论叠在深色血条上还是浅色空轨上、无论深色主题还是亮色主题，都能看清 */
  color: #fff;
  text-shadow:
    0 0 4px rgba(0, 0, 0, 0.8),
    0 1px 2px rgba(0, 0, 0, 0.6);
  /* 等宽数字：滚动时位数不变的读数不左右抖 */
  font-variant-numeric: tabular-nums;
  z-index: 1;
}
</style>
