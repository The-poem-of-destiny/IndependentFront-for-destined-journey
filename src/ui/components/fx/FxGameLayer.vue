<script setup lang="ts">
/**
 * FxGameLayer — 游戏页特效层（GamePage 挂载为 `.game-page-layout` 的最前几个子节点，
 * 仅在特效闸门打开时 v-if 渲染）
 *
 * 多根片段：三个子层直接成为 `.game-page-layout` 的子元素。五个主题对
 * `.game-page-layout > *` 强制 `position: relative; z-index: 1`，fx-core.css 用更高特异度的
 * `:root[data-fx='on'] body .game-page-layout > .fx-overlay` 把它们拉回 fixed 覆盖层，
 * 从而永远不成为 flex 项、不挤占布局。
 *
 * 这里同时调用 `useFxGameState()` —— 全应用唯一写 `data-fx-daypart/weather/combat` 的地方。
 */
import { useFxGameState } from '../../composables/useFxGameState';
import FxPlateParallax from './FxPlateParallax.vue';
import FxThemeAmbient from './FxThemeAmbient.vue';
import FxAtmosphere from './FxAtmosphere.vue';

useFxGameState();
</script>

<template>
  <FxPlateParallax />
  <FxThemeAmbient />
  <FxAtmosphere />
</template>
