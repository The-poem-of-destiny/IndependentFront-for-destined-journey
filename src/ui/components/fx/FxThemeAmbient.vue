<script setup lang="ts">
/**
 * FxThemeAmbient — 主题氛围层（T3：主题招牌微动效）。挂在 FxGameLayer，游戏页内容之后
 *
 * 特效层约定：叶子节点、`aria-hidden="true"`、`pointer-events: none`（见 styles/fx-core.css）。
 * 只在特效闸门打开时被挂载（父层 v-if），所以这里不再判闸门。
 *
 * 🔴 只住在左右侧条（视口外侧 `SIDE_STRIP_VW`vw，三分屏左右各 25%，离中间正文栏留足余量）
 *    或顶栏那一条带里，**绝不**垫在正文阅读栏背后。
 * 🔴 每主题至多一个循环（docs/design.md §6.0 第 3 条的有记录例外），其余一次性；
 *    只动 transform / opacity；alpha 一律 ≤ 0.08。
 *
 * - ocean：焦散。feTurbulence 噪声做成**静态** SVG 纹理（当遮罩，浏览器只栅格化一次，
 *   不动任何滤镜参数），左右侧条各一份，同一组关键帧一正一反慢漂。
 * - misty-lilac：顶带一条柔和极光，约 140s 往返。
 * - forest：每 50–120s 偶发一颗凝露沿侧条里的玻璃边滑下（一次性）。
 * - ivory：偶发一缕金线，细线上的高光沿织纹走过一次（一次性）。
 * - 其余主题：只留空的覆盖层根元素。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { scheduleOccasional } from '../../lib/fx-ticker';
import {
  CONDENSATION_INTERVAL,
  GOLD_THREAD_INTERVAL,
  SIDE_STRIP_VW,
  observeThemeSlug,
  pickSideStripSpot,
  readThemeSlug,
  signatureOf,
  type SideStripSpot,
} from '../../lib/fx-theme-signature';

const slug = ref<string | null>(readThemeSlug());
const kind = computed(() => signatureOf(slug.value).ambient);

/** 当前正在播的一次性效果（凝露 / 金线）；播完由 animationend 摘掉 */
interface OneShot extends SideStripSpot {
  id: number;
}
const oneShot = shallowRef<OneShot | null>(null);
let nextId = 1;

let cancelOccasional: (() => void) | null = null;

function stopOccasional(): void {
  cancelOccasional?.();
  cancelOccasional = null;
  oneShot.value = null;
}

function startOccasional(): void {
  stopOccasional();
  const interval =
    kind.value === 'condensation'
      ? CONDENSATION_INTERVAL
      : kind.value === 'gold-thread'
        ? GOLD_THREAD_INTERVAL
        : null;
  if (!interval) return;
  cancelOccasional = scheduleOccasional({
    minMs: interval.minMs,
    maxMs: interval.maxMs,
    run: () => {
      oneShot.value = { id: nextId++, ...pickSideStripSpot() };
    },
  });
}

function onOneShotEnd(id: number): void {
  if (oneShot.value?.id === id) oneShot.value = null;
}

/** 落点 → 内联定位（只写一次，不参与动画） */
function spotStyle(spot: SideStripSpot): Record<string, string> {
  return {
    [spot.side]: `${spot.edgeVw}vw`,
    top: `${spot.topVh}vh`,
  };
}

let stopObserve: (() => void) | null = null;

// 换主题即重排：旧主题的定时器与正在播的效果一并作废
watch(kind, () => startOccasional());

onMounted(() => {
  stopObserve = observeThemeSlug((next) => {
    slug.value = next;
  });
  startOccasional();
});

onBeforeUnmount(() => {
  stopObserve?.();
  stopObserve = null;
  stopOccasional();
});

/**
 * 焦散纹理：feTurbulence（turbulence 型的折痕正好是焦散的亮网）→ 颜色矩阵把「接近 0 的折痕」
 * 映射成高 alpha。`stitchTiles` 让 256px 平铺无缝。它只当遮罩用，颜色由主题强调色给。
 */
const CAUSTIC_SVG =
  "<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'>" +
  "<filter id='c' x='0' y='0' width='100%' height='100%'>" +
  "<feTurbulence type='turbulence' baseFrequency='0.014 0.02' numOctaves='2' seed='11' stitchTiles='stitch'/>" +
  "<feColorMatrix type='matrix' values='0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  -7 0 0 0 1.35'/>" +
  '</filter>' +
  "<rect width='256' height='256' filter='url(#c)'/></svg>";
const causticMask = `url("data:image/svg+xml,${encodeURIComponent(CAUSTIC_SVG)}")`;

const stripWidth = `${SIDE_STRIP_VW}vw`;
</script>

<template>
  <div
    class="fx-overlay fx-overlay--back fx-theme-ambient"
    :data-ambient="kind ?? undefined"
    :style="{ '--fx-amb-strip-w': stripWidth, '--fx-amb-caustic': causticMask }"
    aria-hidden="true"
  >
    <template v-if="kind === 'caustics'">
      <div class="fx-amb-strip fx-amb-strip--left">
        <div class="fx-amb-caustic" />
      </div>
      <div class="fx-amb-strip fx-amb-strip--right">
        <div class="fx-amb-caustic fx-amb-caustic--reverse" />
      </div>
    </template>

    <div v-else-if="kind === 'aurora'" class="fx-amb-band">
      <div class="fx-amb-aurora" />
    </div>

    <div
      v-else-if="kind === 'condensation' && oneShot"
      :key="oneShot.id"
      class="fx-amb-drop"
      :style="spotStyle(oneShot)"
      @animationend.self="onOneShotEnd(oneShot.id)"
    >
      <span class="fx-amb-drop-bead" />
    </div>

    <div
      v-else-if="kind === 'gold-thread' && oneShot"
      :key="oneShot.id"
      class="fx-amb-thread"
      :class="`fx-amb-thread--${oneShot.side}`"
      :style="spotStyle(oneShot)"
      @animationend.self="onOneShotEnd(oneShot.id)"
    >
      <span class="fx-amb-thread-glint" />
    </div>
  </div>
</template>

<style scoped>
/* ── 侧条（焦散用）：视口外侧一截，向正文方向渐隐 ── */
.fx-amb-strip {
  position: absolute;
  top: 0;
  bottom: 0;
  width: var(--fx-amb-strip-w);
  overflow: hidden;
}

.fx-amb-strip--left {
  left: 0;
  mask-image: linear-gradient(to right, #000 35%, transparent);
  -webkit-mask-image: linear-gradient(to right, #000 35%, transparent);
}

.fx-amb-strip--right {
  right: 0;
  mask-image: linear-gradient(to left, #000 35%, transparent);
  -webkit-mask-image: linear-gradient(to left, #000 35%, transparent);
}

/* 纹理本体比侧条大一圈，漂移时边缘不露底 */
.fx-amb-caustic {
  position: absolute;
  inset: -128px;
  background-color: var(--theme-primary);
  mask-image: var(--fx-amb-caustic);
  -webkit-mask-image: var(--fx-amb-caustic);
  mask-size: 256px 256px;
  -webkit-mask-size: 256px 256px;
  opacity: 0.07;
  will-change: transform;
  animation: fx-amb-caustic-drift 96s ease-in-out infinite alternate;
}

.fx-amb-caustic--reverse {
  animation-direction: alternate-reverse;
}

/* 本主题唯一的循环（两份纹理共用这一组关键帧） */
@keyframes fx-amb-caustic-drift {
  from {
    transform: translate3d(0, 0, 0);
  }
  to {
    transform: translate3d(48px, -112px, 0);
  }
}

/* ── 顶带（极光用）：只占顶栏那一条，向下渐隐 ── */
.fx-amb-band {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 2.75rem;
  overflow: hidden;
  mask-image: linear-gradient(to bottom, #000 30%, transparent);
  -webkit-mask-image: linear-gradient(to bottom, #000 30%, transparent);
}

.fx-amb-aurora {
  position: absolute;
  top: 0;
  bottom: 0;
  left: -50%;
  width: 200%;
  background: linear-gradient(
    100deg,
    transparent 8%,
    var(--theme-primary) 24%,
    color-mix(in srgb, var(--theme-primary) 40%, #6fd3c4) 42%,
    transparent 58%,
    color-mix(in srgb, var(--theme-primary) 60%, #9ec9f0) 76%,
    transparent 92%
  );
  opacity: 0.08;
  will-change: transform;
  animation: fx-amb-aurora-sway 140s ease-in-out infinite alternate;
}

/* 本主题唯一的循环：约 140s 往返 */
@keyframes fx-amb-aurora-sway {
  from {
    transform: translate3d(-12%, 0, 0);
  }
  to {
    transform: translate3d(12%, 0, 0);
  }
}

/* ── 凝露（一次性）：先凝出，停一拍，再沿玻璃边加速滑下、淡去 ── */
.fx-amb-drop {
  position: absolute;
  width: 4px;
  height: 6px;
  animation: fx-amb-drop-slide 7.2s cubic-bezier(0.55, 0, 0.75, 0.6) backwards;
  opacity: 0;
}

.fx-amb-drop-bead {
  position: absolute;
  inset: 0;
  border-radius: 50% 50% 50% 50% / 40% 40% 60% 60%;
  background: radial-gradient(
    circle at 40% 35%,
    var(--theme-primary) 0,
    color-mix(in srgb, var(--theme-primary) 50%, transparent) 60%,
    transparent 100%
  );
}

@keyframes fx-amb-drop-slide {
  0% {
    opacity: 0;
    transform: translate3d(0, 0, 0) scale(0.6);
  }
  18% {
    opacity: 0.08;
    transform: translate3d(0, 0, 0) scale(1);
  }
  30% {
    opacity: 0.08;
    transform: translate3d(0, 2px, 0) scale(1);
  }
  85% {
    opacity: 0.06;
  }
  100% {
    opacity: 0;
    transform: translate3d(0, 34vh, 0) scale(0.9, 1.15);
  }
}

/* ── 金线（一次性）：细线淡入，高光沿线走一遍，再淡出 ── */
.fx-amb-thread {
  position: absolute;
  width: calc(var(--fx-amb-strip-w) - 2vw);
  max-width: 12vw;
  height: 1px;
  overflow: hidden;
  opacity: 0;
  background: color-mix(in srgb, var(--theme-primary) 40%, transparent);
  animation: fx-amb-thread-show 3.8s ease-in-out backwards;
}

/* 右侧的线从外缘往里长，高光仍是从外往里走 */
.fx-amb-thread--right {
  transform: scaleX(-1);
}

.fx-amb-thread-glint {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 35%;
  background: linear-gradient(to right, transparent, var(--theme-primary), transparent);
  transform: translateX(-100%);
  animation: fx-amb-thread-glint 3.8s cubic-bezier(0.4, 0, 0.2, 1) backwards;
}

@keyframes fx-amb-thread-show {
  0% {
    opacity: 0;
  }
  20%,
  70% {
    opacity: 0.08;
  }
  100% {
    opacity: 0;
  }
}

@keyframes fx-amb-thread-glint {
  0%,
  12% {
    transform: translateX(-100%);
  }
  88%,
  100% {
    transform: translateX(290%);
  }
}
</style>
