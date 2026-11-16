<script setup lang="ts">
/**
 * FxPlateParallax — 底盘视差层。挂在 FxGameLayer，是 `.game-page-layout` 的直接子元素
 *
 * 做法：本层根元素本就是 `.game-page-layout` 的子元素（fx-core.css 把它钉成 fixed、z -1），
 * 于是根元素 `background: inherit` 就拿到了底盘的同一份背景 —— 不必往别人的组件里插节点、
 * 也不改任何主题样式表。根元素原地静止地重画一遍底盘（与底盘逐像素重合），里面的 `.fx-plate`
 * 再继承一次、随指针平移至多 2px（`registerParallax(el, -2)`）；平移露出的边缘下面正是那份
 * 静止副本，看不出缝。底盘的内描边（layout 的 inset box-shadow）会被盖住，所以 `.fx-plate-frame`
 * 以 `box-shadow: inherit` 静止地把它画回来。文字与面板全在本层之上，永远不动。
 *
 * 只给「底盘是一整张图」的主题开（`PLATE_THEMES`）：
 * - obsidian（星盘场）/ misty-lilac（极光场景）：layout 上是 cover 铺的整张栅格，且没有
 *   与底盘对齐的伪元素叠层，视差看得见也不会重影。
 * - bronze 不开：面板上的 `::before`（scene/status/side/chat）按底盘对位，底盘一动就双影。
 * - forest 不开：scene-panel / status-hud / chat-flow 的 `::after` 同理。
 * - parchment / ivory / ocean：最终生效的 layout 背景只有纯色或渐变（ivory.css 末尾清掉了
 *   底盘图，ocean 被后段的渐变覆盖），平移 2px 不可见，白白排帧，不开。
 * - crimson / indigo / sakura：底盘不是整张栅格；crimson 另禁环境动效。
 *
 * 特效层约定：叶子节点、`aria-hidden="true"`、`pointer-events: none`（见 styles/fx-core.css）。
 * 只在特效闸门打开时被挂载（父层 v-if），所以这里不再判闸门。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useThemeStore } from '../../stores/theme-store';
import { registerParallax } from '../../lib/fx-pointer';

/** 开视差的主题 */
const PLATE_THEMES: ReadonlySet<string> = new Set(['obsidian', 'misty-lilac']);
/** 景深：负值 = 与指针同向，至多 2px */
const PLATE_DEPTH_PX = -2;

const theme = useThemeStore();
const active = computed(() => PLATE_THEMES.has(theme.current));
const plateEl = ref<HTMLElement | null>(null);
let unregister: (() => void) | null = null;

function release(): void {
  unregister?.();
  unregister = null;
}

watch(
  plateEl,
  (el) => {
    release();
    if (el) unregister = registerParallax(el, PLATE_DEPTH_PX);
  },
  { flush: 'post' },
);

onBeforeUnmount(release);
</script>

<template>
  <div
    class="fx-overlay fx-overlay--back fx-plate-parallax"
    :class="{ 'fx-plate-parallax--active': active }"
    aria-hidden="true"
  >
    <template v-if="active">
      <div ref="plateEl" class="fx-plate" />
      <div class="fx-plate-frame" />
    </template>
  </div>
</template>

<style scoped>
/*
 * 特异度 0,5,1 压过 fx-core.css 的 `body .game-page-layout > .fx-overlay`（0,4,1）与主题的
 * `.game-page-layout > *`（0,3,1）。根元素继承底盘背景与内描边，作为平移时的静止垫底。
 */
:root[data-fx='on'] body .game-page-layout > .fx-overlay.fx-plate-parallax--active {
  background: inherit;
  box-shadow: inherit;
}

/*
 * 与根元素同盒（inset 0）而不是向外 overscan：cover 尺寸按盒子算，盒子一大底盘就会被放大一点、
 * 挂载那一拍整张图跳一下。平移露出的至多 2px 边缘下面是根元素那份静止副本（同一张图），看不出缝。
 */
.fx-plate {
  position: absolute;
  inset: 0;
  z-index: -1;
  background: inherit;
  will-change: transform;
}

.fx-plate-frame {
  position: absolute;
  inset: 0;
  box-shadow: inherit;
}
</style>
