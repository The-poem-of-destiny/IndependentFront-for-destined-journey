<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useTweenedNumber } from '../../composables/useTweenedNumber';

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
watch(percent, (next, prev) => {
  draining.value = next < prev;
});

/** 读数随填充一起滚到新值（只改显示，终点恒等于 current；见 useTweenedNumber） */
const { display: shownCurrent } = useTweenedNumber(() => props.current);
</script>

<template>
  <div class="resource-bar" :style="{ height: (height || 14) + 'px' }">
    <span class="res-label">{{ label }}</span>
    <div class="res-track" :class="{ 'is-draining': draining }">
      <div
        class="res-ghost"
        :style="{ transform: fillStyle.transform, background: barColor }"
        aria-hidden="true"
      />
      <div class="res-fill" :style="fillStyle" />
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
