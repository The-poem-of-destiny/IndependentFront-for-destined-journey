<script setup lang="ts">
import { useUIStore } from '../../stores/ui-store'
import { useGameStore } from '../../stores/game-store'

const ui = useUIStore()
const game = useGameStore()
</script>

<template>
  <div class="top-bar">
    <button class="top-btn" @click="ui.navigate('home')" title="回到首页">
      ← 首页
    </button>

    <!-- 时间展示职责已下沉到左侧 ScenePanel，顶栏只保留窗口级控制 -->
    <span class="top-title">{{ game.activeSave?.name ?? '冒险之途' }}</span>

    <button class="top-btn" @click="game.toggleFullscreen()" title="全屏">
      <i :class="game.fullscreenStatus ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" />
      {{ game.fullscreenStatus ? '退出' : '全屏' }}
    </button>
  </div>
</template>

<style scoped>
.top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 2.75rem;
  padding: 0 12px;
  background: var(--theme-title-bar-bg);
  border-bottom: 1px solid var(--theme-card-border);
  flex-shrink: 0;
}
.top-btn {
  background: none;
  border: none;
  color: var(--theme-title-bar-icon);
  font-size: 0.8125rem;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  transition: background 150ms;
  font-family: inherit;
}
.top-btn:hover {
  background: var(--theme-title-bar-btn-hover);
}
.top-title {
  font-family: var(--theme-font-title, 'Cinzel', serif);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  letter-spacing: 0.04em;
  opacity: 0.7;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 50vw;
}
</style>