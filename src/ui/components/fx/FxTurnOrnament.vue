<script setup lang="ts">
/**
 * FxTurnOrnament — 顶栏轮数旁的回合纹饰（T3：主题招牌微动效）
 *
 * 挂在 TopBar `.top-title` 内；`settledTurn` 为已落定回合数（见 lib/fx-game-state.ts 的
 * `settledTurnOf`）。根元素绝对定位（fx-core.css），不参与 `.top-title` 的 flex 排布与 gap；
 * 约 32px 的 SVG 再相对根元素摆到尾端那条细线的右侧，不压轮数文字。
 *
 * - obsidian（星盘）：刻度环约 600s 一圈（本主题唯一的循环）+ 指针每落定一回合走 6°，一次性缓动。
 * - bronze（机巧）：擒纵轮每回合走一齿，带一点回弹（缓动曲线略过冲），其余时间静止。
 * - 其它主题什么都不渲染。
 *
 * 🔴 挂载不动画：首帧直接落在当前角度，只有之后的回合递增才过渡（判据见
 *    `shouldAnimateTurnStep`：倒退 / 大跨度跳变同样直接到位）。
 * 🔴 只动 transform；颜色取主题强调色 `--theme-primary`。强度三档集中在根元素的
 *    `--fx-orn-alpha-*` 三个变量上（见样式区）：次刻度 < 刻度环 / 主刻度 < 指针 / 齿轮。
 *    只有 obsidian / bronze 两套深色主题会渲染本组件，强度按深色底调；亮主题不渲染，无需另调。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  ESCAPEMENT_TEETH,
  escapementGearAngle,
  escapementGearPoints,
  observeThemeSlug,
  orreryPointerAngle,
  orreryRingTicks,
  readThemeSlug,
  shouldAnimateTurnStep,
  signatureOf,
} from '../../lib/fx-theme-signature';

const props = defineProps<{ settledTurn: number }>();

const slug = ref<string | null>(readThemeSlug());
const kind = computed(() => signatureOf(slug.value).ornament);

/** 本次角度变化是否走过渡；首帧恒为 false */
const animate = ref(false);

watch(
  () => props.settledTurn,
  (next, prev) => {
    animate.value = shouldAnimateTurnStep(prev, next);
  },
);

let stopObserve: (() => void) | null = null;
onMounted(() => {
  stopObserve = observeThemeSlug((next) => {
    // 换主题等于换一件纹饰：新纹饰首帧同样直接到位
    animate.value = false;
    slug.value = next;
  });
});
onBeforeUnmount(() => {
  stopObserve?.();
  stopObserve = null;
});

const C = 16;
const ringTicks = orreryRingTicks(36, 3, 13.5, 1.4, 2.8, C, C);
const gearPoints = escapementGearPoints(ESCAPEMENT_TEETH, 11.5, 8.6, C, C);
const gearSpokes = [0, 90, 180, 270];

const pointerStyle = computed(() => ({
  transform: `rotate(${orreryPointerAngle(props.settledTurn)}deg)`,
}));
const gearStyle = computed(() => ({
  transform: `rotate(${escapementGearAngle(props.settledTurn)}deg)`,
}));
</script>

<template>
  <span
    v-if="kind"
    class="fx-turn-ornament"
    :class="`fx-turn-ornament--${kind}`"
    :data-ornament="kind"
    aria-hidden="true"
  >
    <svg class="fx-orn-svg" viewBox="0 0 32 32" width="32" height="32" focusable="false">
      <template v-if="kind === 'orrery'">
        <g class="fx-orn-ring">
          <circle class="fx-orn-line" :cx="C" :cy="C" r="13.5" />
          <line
            v-for="(t, i) in ringTicks"
            :key="i"
            class="fx-orn-line"
            :class="t.major ? 'fx-orn-major' : 'fx-orn-minor'"
            :x1="t.x1"
            :y1="t.y1"
            :x2="t.x2"
            :y2="t.y2"
          />
          <!-- 一枚菱形游标：让超慢自转看得出方向 -->
          <path class="fx-orn-fill" d="M16 0.6 L17.1 2 L16 3.4 L14.9 2 Z" />
        </g>
        <circle class="fx-orn-line" :cx="C" :cy="C" r="8" />
        <g
          class="fx-orn-pointer"
          :class="{ 'is-stepping': animate }"
          :style="pointerStyle"
          data-part="pointer"
        >
          <line class="fx-orn-line fx-orn-accent" :x1="C" :y1="C + 2.5" :x2="C" :y2="4.5" />
          <circle class="fx-orn-fill" :cx="C" :cy="C" r="1.4" />
        </g>
      </template>

      <template v-else-if="kind === 'escapement'">
        <g
          class="fx-orn-gear"
          :class="{ 'is-stepping': animate }"
          :style="gearStyle"
          data-part="gear"
        >
          <polygon class="fx-orn-line fx-orn-accent" :points="gearPoints" />
          <circle class="fx-orn-line" :cx="C" :cy="C" r="5.2" />
          <line
            v-for="a in gearSpokes"
            :key="a"
            class="fx-orn-line"
            :x1="C"
            :y1="C"
            :x2="C"
            :y2="C - 5.2"
            :transform="`rotate(${a} ${C} ${C})`"
          />
          <circle class="fx-orn-fill" :cx="C" :cy="C" r="1.3" />
        </g>
        <!-- 静止的擒纵叉：一段压在轮缘上方的短弧，交代「是谁在拨它」 -->
        <path class="fx-orn-line fx-orn-major" d="M10.5 1.8 Q16 -0.6 21.5 1.8" />
      </template>
    </svg>
  </span>
</template>

<style scoped>
/*
 * fx-core.css 把根元素铺满 `.top-title`（inset: 0）；SVG 相对它摆到右侧外缘，
 * 与尾端细线隔 8px。`.top-title` 在 ≤720px 整个 display:none，纹饰随之隐藏。
 */
.fx-orn-svg {
  position: absolute;
  top: 50%;
  left: calc(100% + 8px);
  width: 32px;
  height: 32px;
  margin-top: -16px;
  overflow: visible;
}

/*
 * 强度唯一调节处（2026-11-16 由 6–8% 上调：深色主题下原值完全看不见）。
 * 次刻度 < 刻度环 / 主刻度 / 擒纵叉 < 指针 / 齿轮齿 / 实心点，层次靠这三档拉开。
 */
.fx-turn-ornament {
  --fx-orn-alpha-minor: 18%;
  --fx-orn-alpha-ring: 28%;
  --fx-orn-alpha-accent: 45%;
}

.fx-orn-line {
  fill: none;
  stroke: color-mix(in srgb, var(--theme-primary) var(--fx-orn-alpha-ring), transparent);
  stroke-width: 0.75;
}

.fx-orn-minor {
  stroke: color-mix(in srgb, var(--theme-primary) var(--fx-orn-alpha-minor), transparent);
}

.fx-orn-major {
  stroke-width: 1;
}

.fx-orn-accent {
  stroke: color-mix(in srgb, var(--theme-primary) var(--fx-orn-alpha-accent), transparent);
  stroke-width: 1;
}

.fx-orn-fill {
  fill: color-mix(in srgb, var(--theme-primary) var(--fx-orn-alpha-accent), transparent);
  stroke: none;
}

.fx-orn-ring,
.fx-orn-pointer,
.fx-orn-gear {
  transform-box: view-box;
  transform-origin: 16px 16px;
}

/* 本主题唯一的循环：刻度环约 600s 一圈 */
:root[data-fx='on'] .fx-orn-ring {
  animation: fx-orn-ring-turn 600s linear infinite;
}

.fx-orn-pointer.is-stepping {
  transition: transform 900ms var(--motion-ease-enter, cubic-bezier(0.16, 1, 0.3, 1));
}

/* 回弹：曲线轻微过冲（约 1/10 齿）再落回齿位，像擒纵叉把轮子推回去一点 */
.fx-orn-gear.is-stepping {
  transition: transform 520ms cubic-bezier(0.3, 1.32, 0.55, 1);
}

@keyframes fx-orn-ring-turn {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .fx-orn-ring,
  .fx-orn-pointer,
  .fx-orn-gear {
    animation: none !important;
    transition: none !important;
  }
}
</style>
