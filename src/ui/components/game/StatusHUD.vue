<script setup lang="ts">
import StatusOverview from './StatusOverview.vue';
</script>

<template>
  <aside class="status-hud">
    <StatusOverview />
  </aside>
</template>

<style scoped>
.status-hud {
  /* 屏宽 25% —— 与左侧（工具栏 + 场景栏）对称，正文得到中间 50%
     内容整体放大 10%；zoom 只放大内容、不改已解析宽度，故宽度无需补偿 */
  zoom: 1.1;
  width: 25%;
  min-width: 240px;
  flex-shrink: 0;
  background: var(--theme-content-bg);
  border-left: 1px solid var(--theme-card-border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
