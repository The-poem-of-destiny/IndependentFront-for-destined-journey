<script setup lang="ts">
import StatusOverview from './StatusOverview.vue'
</script>

<template>
  <aside class="status-hud">
    <StatusOverview />
  </aside>
</template>

<style scoped>
.status-hud {
  width: 20rem;
  flex-shrink: 0;
  background: var(--theme-content-bg);
  border-left: 1px solid var(--theme-card-border);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
</style>
