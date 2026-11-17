<script setup lang="ts">
/**
 * FxLayer — 应用级特效层（App.vue 挂载，仅在特效闸门打开时 v-if 渲染）
 *
 * 多根片段：每个子层自己是 fixed 覆盖层（fx-core.css 的 `.fx-overlay`），
 * 不包一层容器 —— 容器会多出一个层叠上下文，子层的 z-index 就够不到页面之上。
 */
import FxSheen from './FxSheen.vue';
import FxGlint from './FxGlint.vue';
import FxItemFlight from './FxItemFlight.vue';
</script>

<template>
  <FxSheen />
  <FxGlint />
  <FxItemFlight />
</template>
