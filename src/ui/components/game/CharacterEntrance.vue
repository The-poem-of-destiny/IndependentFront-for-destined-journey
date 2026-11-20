<script setup lang="ts">
/**
 * CharacterEntrance — 逐节演出里「新角色首次登场」的那一格（交互式推进 T6）
 *
 * 立绘走立牌链（立绘 → 立绘bg → 头像，`ASSET_TYPE_FALLBACK_CHAIN`）；一张素材都没有时
 * 只浮现名字题签，不画空框、不画首字兜底。
 *
 * 动效只有一种：自上而下的遮罩扫过 + 透明度，像被一笔笔画出来 —— 不旋转、不发光、不弹跳。
 * 只在 `animate`（本格是新放出的节）且特效闸门打开时播一次；闸门关 / 减动效 / 已读过的节
 * 一律静态显示。播完撤掉类名，落定后的 DOM 与静态显示相同。
 */
import { onBeforeUnmount, ref } from 'vue';
import { ASSET_TYPE_FALLBACK_CHAIN } from '@engine/assets/asset-resolve';
import { useAssetImage } from '../../composables/useAssetImage';
import { useFxEnabled } from '../../lib/fx-gate';

const props = withDefaults(defineProps<{ name: string; animate?: boolean }>(), {
  animate: false,
});

const { url, isVideo } = useAssetImage(
  () => props.name,
  () => ASSET_TYPE_FALLBACK_CHAIN,
);

const fxEnabled = useFxEnabled();
/** 动画总长（立牌 + 题签错峰）之后撤类名；不靠 animationend（减动效下根本不触发） */
const DRAW_TOTAL_MS = 1400;
const drawing = ref(props.animate && fxEnabled.value);
let timer: ReturnType<typeof setTimeout> | null = null;
if (drawing.value) {
  timer = setTimeout(() => {
    drawing.value = false;
    timer = null;
  }, DRAW_TOTAL_MS);
}
onBeforeUnmount(() => {
  if (timer !== null) clearTimeout(timer);
});
</script>

<template>
  <figure
    class="stage-entrance"
    :class="{ 'is-drawing': drawing, 'has-portrait': url !== null }"
    :aria-label="`${name}登场`"
  >
    <span v-if="url !== null" class="entrance-portrait" aria-hidden="true">
      <video v-if="isVideo" class="entrance-media" :src="url" muted playsinline loop autoplay />
      <img v-else class="entrance-media" :src="url" alt="" />
    </span>
    <figcaption class="entrance-name">
      <span class="entrance-rule" aria-hidden="true" />
      <span class="entrance-text">{{ name }}</span>
      <span class="entrance-rule" aria-hidden="true" />
    </figcaption>
  </figure>
</template>

<style scoped>
.stage-entrance {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--theme-spacing-sm, 8px);
  margin: 1.1em 0 0.9em;
}

.entrance-portrait {
  display: block;
  width: min(11rem, 46%);
  aspect-ratio: 4 / 5;
  overflow: hidden;
  border-radius: var(--theme-radius-md, 8px);
  border: 1px solid color-mix(in srgb, var(--theme-primary) 30%, var(--theme-card-border));
  background: color-mix(in srgb, var(--theme-card-bg) 70%, transparent);
}

.entrance-media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: top center;
  display: block;
}

.entrance-name {
  display: flex;
  align-items: center;
  gap: 0.75em;
  color: var(--theme-text-secondary);
  font-family: var(--theme-font-title, serif);
  font-size: 0.9375rem;
  letter-spacing: 0.24em;
  /* 字距会在末字后多留一格，补回去才居中 */
  text-indent: 0.24em;
}

.entrance-rule {
  display: block;
  width: 2.5em;
  height: 1px;
  background: color-mix(in srgb, var(--theme-primary) 45%, transparent);
}

/*
 * 「被画出来」：遮罩是一条上实下虚的渐变带，从元素上方扫到下方 —— 先显出头部、再到衣摆。
 * 遮罩位置不是布局属性；同时只有透明度在动，没有位移、旋转与发光。
 */
.is-drawing .entrance-portrait,
.is-drawing .entrance-name {
  -webkit-mask-image: linear-gradient(to bottom, #000 40%, transparent 60%);
  mask-image: linear-gradient(to bottom, #000 40%, transparent 60%);
  -webkit-mask-size: 100% 300%;
  mask-size: 100% 300%;
  animation: entrance-draw 1000ms var(--motion-ease-enter) backwards;
}
.is-drawing .entrance-name {
  animation-duration: 700ms;
  animation-delay: 360ms;
}
/* 只有题签（没有素材）时不必等立牌 */
.is-drawing:not(.has-portrait) .entrance-name {
  animation-delay: 0ms;
}

@keyframes entrance-draw {
  from {
    opacity: 0;
    -webkit-mask-position: 0 100%;
    mask-position: 0 100%;
  }
  to {
    opacity: 1;
    -webkit-mask-position: 0 0;
    mask-position: 0 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .is-drawing .entrance-portrait,
  .is-drawing .entrance-name {
    animation: none;
    -webkit-mask-image: none;
    mask-image: none;
  }
}
</style>
