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

    <!-- 右: Agent 状态 + 设置 + 全屏 -->
    <div class="top-right">
      <Transition name="agent-fade">
        <span v-if="game.agentStatus" class="agent-indicator">
          <i class="fa-solid fa-circle-notch agent-spin" aria-hidden="true" />
          {{ game.agentStatus.label }}…
        </span>
      </Transition>
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

/* Agent 状态指示 */
.agent-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.75rem;
  color: var(--theme-text-secondary);
  padding: 3px 10px;
  border-radius: var(--theme-radius-sm, 4px);
  background: color-mix(in srgb, var(--theme-primary) 8%, transparent);
  white-space: nowrap;
}
.agent-spin {
  animation: agent-rotate 1s linear infinite;
  color: var(--theme-primary);
  font-size: 0.6875rem;
}
@keyframes agent-rotate {
  to {
    transform: rotate(360deg);
  }
}
.agent-fade-enter-active {
  transition: opacity 0.2s ease-out;
}
.agent-fade-leave-active {
  transition: opacity 0.15s ease-in;
}
.agent-fade-enter-from,
.agent-fade-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .agent-spin {
    animation: none;
  }
  .agent-fade-enter-active,
  .agent-fade-leave-active {
    transition: none;
  }
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
