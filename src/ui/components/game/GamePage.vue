<script setup lang="ts">
</script>

<template>
  <div class="game-page">
    <h2>游戏页面</h2>
    <p>Phase 7e: 三栏布局 + 状态栏 HUD 将在后续实现</p>
  </div>
</template>

<style scoped>
.game-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100vh;
  gap: 1rem;
}
h2 {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  color: var(--theme-text-primary);
}
</style>
