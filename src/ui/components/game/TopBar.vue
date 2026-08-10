<script setup lang="ts">
import { computed } from 'vue';
import { useUIStore } from '../../stores/ui-store';
import { useGameStore } from '../../stores/game-store';

const ui = useUIStore();
const game = useGameStore();

const turnCount = computed(() => {
  const last = [...game.messages]
    .reverse()
    .find((m) => m.role === 'user' || m.role === 'assistant');
  return last?.turn ?? 0;
});
</script>

<template>
  <div class="top-bar">
    <!-- 左: 导航 + 存档名 -->
    <div class="top-left">
      <button class="top-btn" title="回到首页" @click="ui.navigate('home')">← 首页</button>
      <span class="top-divider" aria-hidden="true" />
      <span class="top-save-name" :title="game.activeSave?.name ?? '冒险之途'">
        {{ game.activeSave?.name ?? '冒险之途' }}
      </span>
    </div>

    <!-- 中: 轮数 -->
    <span class="top-title">
      <span class="top-title-rule" aria-hidden="true" />
      <span class="top-title-text">第 {{ turnCount }} 轮对话</span>
      <span class="top-title-rule" aria-hidden="true" />
    </span>

    <!-- 右: 设置 + 全屏；Agent 活动在对话流中按回合展示 -->
    <div class="top-right">
      <button class="top-btn icon-btn" title="设置" @click="ui.navigate('settings')">
        <i class="fa-solid fa-gear" />
      </button>
      <button class="top-btn" title="全屏" @click="game.toggleFullscreen()">
        <i :class="game.fullscreenStatus ? 'fa-solid fa-compress' : 'fa-solid fa-expand'" />
        {{ game.fullscreenStatus ? '退出' : '全屏' }}
      </button>
    </div>
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
.top-left,
.top-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
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
  flex-shrink: 0;
}
.top-btn:hover {
  background: var(--theme-title-bar-btn-hover);
}
.icon-btn {
  padding: 4px 8px;
}
.top-divider {
  width: 1px;
  height: 1rem;
  background: var(--theme-card-border);
  flex-shrink: 0;
}
.top-save-name {
  font-family: var(--theme-font-title, 'Noto Serif SC', serif);
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--theme-text-secondary);
  letter-spacing: 0.08em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 14rem;
}
.top-title {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.top-title-text {
  font-size: 0.75rem;
  color: var(--theme-text-muted);
  letter-spacing: 0.12em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.top-title-rule {
  width: 2.5rem;
  height: 1px;
  flex-shrink: 0;
  background: linear-gradient(
    to right,
    transparent,
    color-mix(in srgb, var(--theme-primary) 45%, transparent),
    transparent
  );
}

@media (max-width: 720px) {
  .top-title {
    display: none;
  }
  .top-save-name {
    max-width: 8rem;
  }
}
</style>
